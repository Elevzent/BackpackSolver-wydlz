/* 组级提取（冲突组指纹）纯逻辑 Node harness：
 * 用 DOM 桩加载 script/main.fp.js（页面全部交互逻辑），直接断言其中的纯函数：
 * truth 索引（fpTruthIndex）、按名+品质分组（fpGroupSamples）、中位数聚合（fpAggSigs/
 * fpAggregateGroups/fpMedian/fpJitterSig）、两两 diff（fpPairDiffs/fpBlockDiffs）、
 * 判别块（fpDiscBlocks）、建议 maxDiff（fpSuggestMaxDiff）、跨品质合并建议
 * （fpMergeSuggestions）、冲突组枚举（fpGroupKeys）与写回序列化（scanFpRefsSerialize
 * 的 sigVar/samples 字段 + fpParseRefs 往返）、SCAN_DOT_TYPES 入库硬校验
 * （scanDotRangesOverlap / scanDotTypesValidate / scanCalibDots 簇分析零重叠产出）。
 * 运行：node tools/test-fp-group.js（项目根目录；无第三方依赖）
 *
 * 注意：脚本加载用 vm.runInThisContext（当前全局上下文执行，等同浏览器多
 * <script> 标签共享全局），不使用 eval。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* DOM 桩 */
// 2d 上下文桩：已知方法显式给空实现，其余经 Proxy 吸收
function makeCtx() {
	const base = {
		measureText: () => ({ width: 0 }),
		getImageData: () => ({ data: new Uint8ClampedArray(0) }),
		createLinearGradient: () => ({ addColorStop() {} }),
	};
	return new Proxy(base, {
		get: (t, k) => (k in t ? t[k] : () => {}),
		set: (t, k, v) => ((t[k] = v), true),
	});
}

function makeEl(tag = "div") {
	return {
		tagName: tag,
		children: [],
		style: { setProperty() {} },
		dataset: {},
		classList: {
			add() {},
			remove() {},
			toggle() {},
			contains: () => false,
		},
		textContent: "",
		className: "",
		hidden: false,
		disabled: false,
		value: "",
		innerHTML: "",
		src: "",
		alt: "",
		title: "",
		colSpan: 0,
		width: 0,
		height: 0,
		id: "",
		files: [],
		appendChild(c) {
			this.children.push(c);
			return c;
		},
		replaceChildren(...c) {
			this.children = c;
		},
		addEventListener() {},
		removeEventListener() {},
		querySelectorAll: () => [],
		querySelector: () => null,
		getContext: () => makeCtx(),
		setAttribute() {},
		getAttribute: () => null,
		click() {},
		focus() {},
		select() {},
		scrollIntoView() {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
		toDataURL: () => "data:,",
	};
}

const elCache = new Map();
const elById = (id) => {
	if (!elCache.has(id)) {
		const el = makeEl();
		el.id = id;
		elCache.set(id, el);
	}
	return elCache.get(id);
};

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.scrollTo = () => {};
globalThis.document = {
	getElementById: elById,
	createElement: (t) => makeEl(t),
	createTextNode: (t) => ({ nodeType: 3, textContent: t }),
	querySelectorAll: () => [],
	addEventListener() {},
	body: makeEl("body"),
};
const lsStore = new Map();
globalThis.localStorage = {
	getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
	setItem: (k, v) => lsStore.set(k, String(v)),
	removeItem: (k) => lsStore.delete(k),
};
Object.defineProperty(globalThis, "navigator", {
	value: { clipboard: { writeText: async () => {} } },
	configurable: true,
});
globalThis.confirm = () => true;

/* 加载脚本 */
// 顺序与 HTML 的 <script src> 一致；opencv-loader 跳过（init 路径不触达）。
// vm.runInThisContext 在当前全局上下文逐文件执行（等同浏览器 <script src>：
// var/function 挂 globalThis，const/let 进全局词法环境，跨文件与下方断言均可见），
// 不使用 eval——避免作用域安全隐患，且堆栈带真实文件名
const files = [
	"data/shapes.data.js",
	"data/blocks.data.js",
	"data/scan-fp-refs.js",
	"script/scan-core.js",
	"script/scan-bench.js",
	"script/scan-fp-io.js",
	"script/main.fp.js",
];
files.forEach((f) => vm.runInThisContext(read(f), { filename: f }));

/* 断言 */
let pass = 0;
let fail = 0;
function ok(cond, msg) {
	if (cond) {
		pass++;
	} else {
		fail++;
		console.error(`FAIL: ${msg}`);
	}
}
function eq(a, b, msg) {
	ok(
		JSON.stringify(a) === JSON.stringify(b),
		`${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`,
	);
}

/* ---- 冲突组枚举：12 组 25 件（CONTEXT.md 线二·三的事实） ---- */
const groups = fpGroupKeys();
eq(groups.length, 12, "冲突组数量");
eq(
	groups.reduce((n, [, names]) => n + names.length, 0),
	25,
	"冲突组法宝件数",
);

/* ---- fpTruthIndex：真实 truth 文件建索引 ---- */
const truthDir = path.join(ROOT, "test_images/truth");
const truths = fs
	.readdirSync(truthDir)
	.filter((f) => f.endsWith(".json"))
	.slice(0, 10)
	.map((f) => JSON.parse(fs.readFileSync(path.join(truthDir, f), "utf8")));
const idx = fpTruthIndex(truths);
const expectCnt = new Map();
truths.forEach((t) =>
	(t.pieces || []).forEach((p) => {
		if (p.name) expectCnt.set(p.name, (expectCnt.get(p.name) || 0) + 1);
	}),
);
eq(idx.size, expectCnt.size, "truth 索引名称数");
let idxTotal = 0;
idx.forEach((list, name) => {
	idxTotal += list.length;
	ok(list.length === expectCnt.get(name), `truth 索引计数：${name}`);
	ok(
		list.every((s) => s.piece && typeof s.rows === "number" && s.file),
		`truth 索引条目结构：${name}`,
	);
});
ok(idxTotal > 0, "truth 索引非空");

/* ---- fpMedian / fpAggSigs：中位数与类内离散度 ---- */
eq(fpMedian([1, 5, 9]), 5, "奇数中位数");
eq(fpMedian([1, 5, 9, 13]), 7, "偶数中位数");
const sigA = [
	[100, 100, 100],
	null,
	[50, 60, 70],
];
const sigB = [
	[110, 120, 130],
	[1, 2, 3],
	[54, 64, 74],
];
const sigC = [
	[130, 140, 150],
	null,
	[46, 56, 66],
];
const agg = fpAggSigs([sigA, sigB, sigC]);
eq(agg.sig[0], [110, 120, 130], "逐块中位数块0");
eq(agg.sig[1], [1, 2, 3], "单有效样本块直接取该值");
eq(agg.sig[1] && agg.sigVar[1], null, "单有效样本块无方差");
eq(agg.sigVar[0], 13.3, "MAD 离散度（三通道均值）");
eq(fpAggSigs([sigA]).sigVar, [null, null, null], "单样本无方差");
eq(fpAggSigs([]).sig.length, 0, "空聚合");

/* ---- fpJitterSig：确定性、幅度有界、null 保留 ---- */
const j1 = fpJitterSig(sigA, 2, 42);
const j2 = fpJitterSig(sigA, 2, 42);
eq(j1, j2, "抖动确定性（同种子同结果）");
ok(j1[1] === null, "抖动保留 null 块");
ok(
	j1[0].every((v, ch) => Math.abs(v - sigA[0][ch]) <= 2),
	"抖动幅度 ≤ amp",
);

/* ---- fpGroupSamples / fpAggregateGroups ---- */
const mk = (name, quality, sig) => ({
	name,
	quality,
	sig,
	sigLegacy: sig,
	thumb: null,
});
const samples = [
	mk("甲", 3, sigA),
	mk("甲", 3, sigB),
	mk("甲", 2, sigC),
	mk("乙", 4, sigB),
];
const gs = fpGroupSamples(samples);
eq(
	gs.map((g) => `${g.name}|${g.quality}:${g.samples.length}`),
	["甲|3:2", "甲|2:1", "乙|4:1"],
	"按 名称+品质 分组",
);
const tpl = fpAggregateGroups(gs, false);
eq(tpl[0].sig, fpAggSigs([sigA, sigB]).sig, "多样本聚合中位数");
eq(tpl[0].samples, 2, "模板样本数");
ok(!tpl[0].augmented, "多样本不标记增强");
const tplJ = fpAggregateGroups(gs, true);
ok(tplJ[1].augmented && !tplJ[0].augmented, "仅单样本组抖动增强");
ok(
	tplJ[1].sigVar.some((v) => v != null),
	"抖动增强后可算出合成方差",
);
eq(tpl[1].sig, sigC, "单样本无增强时模板即原签名");

/* ---- 两两 diff / 判别块 / 建议 maxDiff ---- */
const T = [
	{ label: "A", sig: sigA },
	{ label: "B", sig: sigB },
	{ label: "C", sig: sigC },
];
const pairs = fpPairDiffs(T);
eq(pairs.length, 3, "两两组合数");
eq(pairs[0].diff, scanFpDiff(sigA, sigB), "diff 口径与 scanFpDiff 一致");
const heat = fpDiscBlocks(T);
eq(heat[1], null, "无可比块热值 null");
// 块2：A-B |50-54|均值4、A-C 4、B-C 8 → 最大 8
eq(heat[2], 8, "判别块取两两差最大值");
// 两两 diff：A-B 12、A-C 22、B-C 14 → 最小 12，建议 12/2=6
eq(fpSuggestMaxDiff(pairs), 6, "建议 maxDiff=最小类间 diff/2");
eq(fpSuggestMaxDiff([{ a: "x", b: "y", diff: Infinity }]), 25, "无可比项退回 25");
eq(
	fpSuggestMaxDiff([{ a: "x", b: "y", diff: 60 }]),
	30,
	"大间隔时建议值跟随一半",
);

/* ---- 跨品质合并建议（<15 规则） ---- */
const near = sigA.map((p) => p && p.map((v) => v + 3));
const far = sigA.map((p) => p && p.map((v) => Math.min(255, v + 40)));
const merges = fpMergeSuggestions([
	{ name: "甲", quality: 2, sig: sigA },
	{ name: "甲", quality: 3, sig: near },
	{ name: "乙", quality: 2, sig: sigA },
	{ name: "乙", quality: 3, sig: far },
	{ name: "丙", quality: 4, sig: sigB },
]);
eq(merges.length, 2, "只有多品质名称出建议");
eq(merges[0].suggest, true, "diff<15 建议合并");
eq(merges[1].suggest, false, "diff≥15 不建议合并");

/* ---- 合并仿真校验：平均规则达标但合并后有样本超 maxDiff / 贴近他名时不建议 ---- */
const sh = (sig, k) => sig.map((p) => p && p.map((v) => v + k));
const mkTpl = (name, quality, sig) => ({ name, quality, sig, sigLegacy: sig });
// 甲两品质模板 diff 10（<15），乙在 +20 处；合并模板为 +5
const tplSim = [
	mkTpl("甲", 2, sigA),
	mkTpl("甲", 3, sh(sigA, 10)),
	mkTpl("乙", 4, sh(sigA, 20)),
];
// 样本含 +14 离群件：到合并模板 dOwn=9 > effMaxDiff 5 → 仿真未通过
const mergesSimBad = fpMergeSuggestions(tplSim, [
	{ name: "甲", sig: sigA },
	{ name: "甲", sig: sh(sigA, 10) },
	{ name: "甲", sig: sh(sigA, 14) },
]);
eq(mergesSimBad.length, 1, "仿真：只有甲出建议");
eq(mergesSimBad[0].suggest, false, "离群样本超 maxDiff 不建议合并");
eq(mergesSimBad[0].maxDOwn, 9, "仿真 maxDOwn 检出离群样本");
eq(mergesSimBad[0].postMaxDiff, 8, "仿真重算合并后 maxDiff");
eq(mergesSimBad[0].effMaxDiff, 5, "有效阈值取合并前后较小者");
// 样本贴模板（最大 dOwn=5 ≤ effMaxDiff 5，余量 >0）→ 建议合并
const mergesSimOk = fpMergeSuggestions(tplSim, [
	{ name: "甲", sig: sigA },
	{ name: "甲", sig: sh(sigA, 10) },
]);
eq(mergesSimOk[0].suggest, true, "样本贴模板时建议合并");
eq(mergesSimOk[0].minMargin, 5, "仿真最小余量");
// 乙挪到 +8：样本 +10 离乙比离合并模板更近（余量 -3）→ 不建议合并
const mergesSimMargin = fpMergeSuggestions(
	[tplSim[0], tplSim[1], mkTpl("乙", 4, sh(sigA, 8))],
	[
		{ name: "甲", sig: sigA },
		{ name: "甲", sig: sh(sigA, 10) },
	],
);
eq(mergesSimMargin[0].suggest, false, "样本贴近他名（余量<0）不建议合并");
eq(mergesSimMargin[0].minMargin, -3, "仿真负余量检出混淆风险");

/* ---- fpAnalyzeGroup：双端共用配方（maxDiff 仅跨名对、合并建议带仿真） ---- */
const tplAna = [
	mkTpl("甲", 2, sigA),
	mkTpl("甲", 3, sh(sigA, 10)),
	mkTpl("乙", 4, sh(sigA, 30)),
];
const ana = fpAnalyzeGroup(tplAna, [
	{ name: "甲", sig: sigA },
	{ name: "甲", sig: sh(sigA, 10) },
]);
eq(ana.pairs.length, 3, "配方输出全量两两 diff");
eq(ana.crossPairs.length, 2, "跨名对剔除同名类内对");
eq(ana.maxDiff, 10, "maxDiff 只由跨名对推导（不混入类内 10）");
eq(ana.merges.length, 1, "配方输出合并建议");
eq(ana.merges[0].suggest, true, "配方内合并建议含样本仿真");

/* ---- 存储格式：sigVar/samples 序列化 + fpParseRefs 往返 ---- */
const text = scanFpRefsSerialize({
	dotTypes: SCAN_DOT_TYPES,
	scanRec: SCAN_REC,
	fpGroups: new Map([
		[
			"木|四格/田|red",
			[
				{
					name: "测",
					quality: 4,
					maxDiff: 18,
					sig: sigA,
					sigLegacy: sigA,
					sigVar: [1.5, null, 2.5],
					samples: 3,
				},
				{ name: "旧", quality: null, maxDiff: 25, sig: sigB, sigLegacy: sigB },
			],
		],
	]),
	typeModel: null,
	pixelModel: null,
});
ok(text.includes("sigVar") && text.includes("samples: 3"), "序列化含 sigVar/samples");
ok(!/旧[\s\S]*?sigVar/.test(text.split('name: "旧"')[1] || ""), "旧条目不带统计字段");
const parsed = fpParseRefs(text);
eq(
	parsed.fpRefs["木|四格/田|red"][0].sigVar,
	[1.5, null, 2.5],
	"fpParseRefs 往返保留 sigVar",
);
eq(
	parsed.fpRefs["木|四格/田|red"][0].samples,
	3,
	"fpParseRefs 往返保留 samples",
);
eq(parsed.fpRefs["木|四格/田|red"][1].sigVar, undefined, "旧条目往返无 sigVar");

/* ---- 歧义格识别预填：annRecMap / annRecPrefill ---- */
const recPieces = [
	{ name: "甲", cells: [[0, 0], [0, 1]] },
	{ name: "", cells: [[1, 0]] }, // 未识别出确定名称
	{ cells: [[2, 0]] }, // 无 name 字段
];
const recMap = annRecMap(recPieces);
eq(recMap.get("0,0"), "甲", "识别映射：首格");
eq(recMap.get("0,1"), "甲", "识别映射：同棋子其余格");
ok(!recMap.has("1,0") && !recMap.has("2,0"), "无确定名称的棋子不入映射");
eq(annRecMap(null).size, 0, "空识别结果建空映射");
eq(annRecPrefill(recMap, [[0, 0]], ["甲", "乙"]), "甲", "识别名在候选内预填");
eq(annRecPrefill(recMap, [[0, 1], [1, 0]], ["甲", "乙"]), "甲", "选区任一格命中即预填");
eq(annRecPrefill(recMap, [[0, 0]], ["乙", "丙"]), null, "识别名不在候选（矛盾）留空");
eq(annRecPrefill(recMap, [[1, 0]], ["甲", "乙"]), null, "识别不出留空");
eq(annRecPrefill(recMap, [[0, 0]], ["甲"]), null, "候选唯一不走预填通道");
eq(annRecPrefill(recMap, [[0, 0]], []), null, "无候选留空");
eq(annRecPrefill(null, [[0, 0]], ["甲", "乙"]), null, "无识别缓存留空");

/* ---- SCAN_DOT_TYPES 入库硬校验（scanDotRangesOverlap / scanDotTypesValidate，
 *      bench calib-dots 与元素校准 tab 采用 / 保存共用，2026-08-07 Step 4） ---- */
const V2_RANGES = [[16, 26, "金"], [25, 50, "木"], [93, 103, "水"], [174, 9, "火"], [8, 17, "土"], [144, 180, "雷"]];
ok(scanDotTypesValidate(V2_RANGES).ok, "硬校验：现行 v2 区间通过（端点相邻=边界互补，非交叠）");
ok(
	scanDotTypesValidate([[174, 9, "火"], [144, 180, "雷"]]).ok,
	"硬校验：火/雷交叠为策略 B 设计，豁免",
);
{
	const dv = scanDotTypesValidate([[10, 20, "金"], [15, 25, "木"]]);
	ok(!dv.ok && dv.overlaps.length === 1, "硬校验：普通重叠拒绝");
	ok(
		dv.overlaps[0].hues.join(",") === "16,17,18,19",
		"硬校验：交叠 hue 明细正确（开区间口径）",
	);
}
{
	// 回绕区间交叠：[174,10] 火 覆盖 175-179/0-9，与土 [8,17] 在 hue 9 交叠
	const dv = scanDotTypesValidate([[174, 10, "火"], [8, 17, "土"]]);
	ok(!dv.ok && dv.overlaps[0].hues.join(",") === "9", "硬校验：回绕区间交叠拒绝（[174,10]×[8,17] 交于 hue 9）");
}
ok(
	scanDotTypesValidate([[174, 9, "火"], [8, 17, "土"]]).ok,
	"硬校验：回绕边界互补通过（[174,9]×[8,17] 零交叠）",
);
{
	// 簇分析端到端：相邻簇自动解交叠、回绕簇产 lo>hi、体不出区间
	const mkHues = (a, b, n) => {
		const out = [];
		for (let i = 0; i < n; i++)
			out.push(Math.round(((a + ((b - a + 180) % 180) * (i / (n - 1))) % 180) + 180) % 180);
		return out;
	};
	const rep = scanCalibDots({
		金: { cells: 10, empty: 0, hues: mkHues(17, 25, 200) },
		木: { cells: 10, empty: 0, hues: mkHues(26, 49, 200) },
		火: { cells: 10, empty: 0, hues: [...mkHues(175, 179, 60), ...mkHues(0, 8, 140)] },
		土: { cells: 10, empty: 0, hues: mkHues(9, 16, 200) },
		体: { cells: 10, empty: 0, hues: mkHues(100, 120, 200) },
	});
	ok(scanDotTypesValidate(rep.ranges).ok, "簇分析：产出两两零重叠（开区间口径）");
	ok(!rep.ranges.some((r) => r[2] === "体"), "簇分析：体不出建议区间");
	const huo = rep.ranges.find((r) => r[2] === "火");
	ok(huo && huo[0] > huo[1], "簇分析：火跨 0/179 产回绕区间（lo>hi）");
	ok(rep.ranges.every(([lo, hi]) => lo >= 0 && lo <= 179 && hi >= 0 && hi <= 180), "簇分析：区间端点合法（lo 0-179 / hi 0-180）");
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
