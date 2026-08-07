/**
 * 全库指纹重提（CONTEXT.md 线二收尾）：从 test_images/truth/*.json + 截图批量
 * 提取全部冲突组法宝的图标指纹，按 名称+品质 逐块中位数聚合 sig（同步出
 * sigLegacy 兼容字段与 sigVar/samples），组级建议 maxDiff（组内最小类间 diff
 * 的一半，下限 5，无可比项 25）落到同组每条目，段级替换 data/scan-fp-refs.js
 * 的 SCAN_FP_REFS 段（其余段一字节不动）。
 *
 * 聚合/差分逻辑复用工具页主逻辑 script/main.fp.js 的纯函数（DOM 桩 +
 * new Function 独立作用域加载，同 tools/test-fp-group.js 口径），图像管线
 * 复用 bench.js 基建（与 bench run 逐字节一致的 定位→切格），保证提取端/
 * 识别端/bench 三处口径统一。采样阶段按图并行（image-worker.js 进程池，
 * 图间独立、按图序重组，产物与串行逐字节一致）；并发数默认 os.cpus()-2，
 * 环境变量 BENCH_JOBS 覆盖（BENCH_JOBS=1 退化为单 worker）。
 *
 * 运行：node tools/bench/refingerprint.js [--no-write]
 *   --no-write  只出报告不改数据文件
 * 报告：控制台摘要 + tools/bench/out/refingerprint-report.json（逐组两两 diff、
 *   建议 maxDiff、跨品质合并建议、样本级 margin 明细——margin 为 in-sample
 *   口径，偏乐观，仅供健康度评估）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bench = require("./lib/core.js");
const { ROOT, IMG_DIR, TRUTH_DIR, OUT_DIR } = bench;
const { resolveJobs, runPool } = require("./lib/parallel.js");
const { ProgressBar } = require("./lib/progress.js");
const { replaceSectionText, writeFileAtomic, verifyRefsVar } = require("./lib/refs-section-io.js");
const WRITE = !process.argv.includes("--no-write");

/* ------------------------------ DOM 桩（同 test-fp-group.js） ------------------------------ */
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
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
	bench.loadScanCore(); // data/* + scan-core + scan-bench → globalThis
	// scan-fp-io.js（序列化，var/function 声明）：runInThisContext 挂到 globalThis
	vm.runInThisContext(
		fs.readFileSync(path.join(ROOT, "script/scan-fp-io.js"), "utf8"),
		{ filename: "script/scan-fp-io.js" },
	);
	// 工具页主逻辑 script/main.fp.js（聚合纯函数）：new Function 构造独立函数
	// 作用域执行（不使用 eval），其 const/function 声明不外泄，全局引用（SHAPES /
	// scan-core 函数 / DOM 桩）经 globalThis 解析；返回需要的纯函数集合
	const inline = fs.readFileSync(path.join(ROOT, "script/main.fp.js"), "utf8");
	const tool = new Function(
		`${inline}\n;return { fpGroupKeys, fpTruthIndex, fpGroupSamples, fpAggregateGroups, fpPairDiffs, fpSuggestMaxDiff, fpMergeSuggestions, fpAnalyzeGroup, fpAggSigs };`,
	)();
	fs.mkdirSync(OUT_DIR, { recursive: true });

	// 目标：全部冲突组（目录中 类型|形状|red 多名的组）成员
	const groups = tool.fpGroupKeys(); // [[key, names[]]]

	// truth 清单（有人工标注且有对应截图）
	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.filter((f) => fs.existsSync(path.join(IMG_DIR, f)))
		.sort();

	// ① 采样：逐图定位 + 切格，冲突组成员占用格提签名（与 bench run 同管线）
	// 按图并行（image-worker.js mode=refp，逻辑与串行逐行一致，groups 经 init
	// 传入 worker 重建索引），结果按图序合并，samples/excluded/warnings
	// 的内容与顺序同串行
	const samples = []; // [{ key, name, quality, file, sig, sigLegacy }]
	const excluded = []; // 自动剔除（同工具页预标记口径）
	const warnings = [];
	let detectFail = 0;
	const jobs = resolveJobs(2048); // 每 worker 一个 opencv wasm 实例，按 2GB/个压内存上限
	console.log(`并行采样：${files.length} 图 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const t0 = Date.now();
	const bar = new ProgressBar({ total: files.length, label: "refp" });
	const perImage = await runPool(
		path.join(__dirname, "workers", "image-worker.js"),
		files.map((file) => ({ file })),
		{
			jobs,
			init: { mode: "refp", groups },
			onTaskDone: (i, r) => bar.tick(r.file + (r.detectFail ? "（定位失败）" : "")),
		},
	);
	bar.done();
	perImage.forEach((r) => {
		detectFail += r.detectFail;
		samples.push(...r.samples);
		excluded.push(...r.excluded);
		warnings.push(...r.warnings);
	});
	console.log(`采样完成（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

	// ② 按组聚合 + 组级差分（复用工具纯函数）
	const report = {
		generated: new Date().toISOString(),
		images: files.length,
		detectFail,
		samplesKept: samples.length,
		samplesExcluded: excluded.map((r) => `${r.file} ${r.name} q${r.quality + 1}：${r.flags.join("；")}`),
		warnings,
		groups: {},
		zeroSample: [],
	};
	const fpRefs = {}; // 新 SCAN_FP_REFS
	let entryCnt = 0;
	let pieceCovered = 0;
	groups.forEach(([key, names]) => {
		const gSamples = samples.filter((s) => s.key === key);
		const zero = names.filter((n) => !gSamples.some((s) => s.name === n));
		zero.forEach((n) => report.zeroSample.push(`${key} ${n}`));
		if (!gSamples.length) return;
		const templates = tool.fpAggregateGroups(tool.fpGroupSamples(gSamples), false);
		// 差分分析（maxDiff / 合并建议）走双端共用配方 fpAnalyzeGroup，
		// 与工具页 gx 流程同一入口，禁止就地拼装（口径漂移教训见函数注释）
		const ana = tool.fpAnalyzeGroup(templates, gSamples);
		const pairs = ana.pairs;
		const maxDiff = ana.maxDiff;
		const merges = ana.merges;
		const tplOf = {};
		templates.forEach((t) => {
			tplOf[t.label] = t;
		});
		// 样本级 margin（in-sample，偏乐观）：样本到本名模板 diff vs 到他名模板最小 diff
		const margins = gSamples.map((s) => {
			const own = templates.filter(
				(t) => t.name === s.name && t.quality === s.quality,
			)[0];
			const dOwn = own ? scanFpDiff(s.sig, own.sig) : Infinity;
			const dOther = Math.min(
				...templates
					.filter((t) => t.name !== s.name)
					.map((t) => scanFpDiff(s.sig, t.sig)),
			);
			return { file: s.file, name: s.name, quality: s.quality, dOwn: +dOwn.toFixed(1), dOther: +dOther.toFixed(1), margin: +(dOther - dOwn).toFixed(1) };
		});
		report.groups[key] = {
			maxDiff,
			templates: templates.map((t) => ({
				name: t.name,
				quality: t.quality,
				samples: t.samples,
				avgSigVar: (() => {
					const vs = t.sigVar.filter((v) => v != null);
					return vs.length
						? +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1)
						: null;
				})(),
			})),
			pairs: pairs.map((p) => ({
				a: p.a, b: p.b,
				crossName: tplOf[p.a].name !== tplOf[p.b].name,
				diff: Number.isFinite(p.diff) ? +p.diff.toFixed(1) : null,
			})),
			merges: merges.map((m) => ({
				name: m.name,
				qualities: m.qualities,
				avgDiff: Number.isFinite(m.avgDiff) ? +m.avgDiff.toFixed(1) : null,
				maxDOwn: m.maxDOwn != null ? +m.maxDOwn.toFixed(1) : null,
				postMaxDiff: m.postMaxDiff,
				effMaxDiff: m.effMaxDiff,
				minMargin: m.minMargin != null ? +m.minMargin.toFixed(1) : null,
				suggest: m.suggest,
			})),
			marginMin: margins.length ? Math.min(...margins.map((m) => m.margin)) : null,
			margins,
		};
		// 组内条目：目录成员序 → 品质升序；组级 maxDiff 落到每条目
		const order = new Map(names.map((n, i) => [n, i]));
		const entries = templates
			.slice()
			.sort(
				(a, b) =>
					(order.get(a.name) ?? 99) - (order.get(b.name) ?? 99) ||
					a.quality - b.quality,
			)
			.map((t) => ({
				name: t.name,
				quality: t.quality,
				maxDiff,
				sig: t.sig,
				sigLegacy: t.sigLegacy,
				sigVar: t.sigVar,
				samples: t.samples,
			}));
		fpRefs[key] = entries;
		entryCnt += entries.length;
		pieceCovered += new Set(entries.map((e) => e.name)).size;
	});

	/* ------------------------------ 写回 SCAN_FP_REFS 段 ------------------------------ */
	const refsPath = path.join(ROOT, "data/scan-fp-refs.js");
	const header = [
		"// SCAN_FP_REFS：同 类型+形状+红/普通 存在多个法宝时的图标指纹参考。",
		"// 2026-08-05 由 node tools/bench/refingerprint.js 全库重提：样本来自 test_images/truth",
		"// 标注截图（自动剔除定位失败 / 类型不符 / 图标块过少的样本），按 名称+品质 逐块",
		"// 中位数聚合成模板；samples 为聚合样本数，sigVar 为逐块类内离散度（MAD，单样本模板无）。",
		"// 0 样本法宝（通幽震魄/青阳唤春/蕴剑葫芦/青枝栖日/玄水护心/晴水华盖/燃欲燎魂/煫火传薪/佛门宝杵）",
		"// 无指纹，需工具页组级提取手动补图。",
		"// 键 `类型|形状|red|normal`；sig 为每格 4×4 块图标像素均值（不足记 null），",
		"// 匹配端（scanNamePiece）2026-08-05 起用 sig；sigLegacy 为每格 2×2 象限全像素均值，",
		"// 仅供无 sig 的旧条目回退。maxDiff 为组级建议值（组内最小类间 diff 的一半，下限 5，",
		"// 无可比项 25），同组条目同一值；匹配差值超过 maxDiff 时不猜名，低置信交人工选择。",
		"// quality: 0~4 对应 一~五阶；图标跨品质一致的条目可改为 null 作为该组通用模板。",
	];
	const lines = [...header, "var SCAN_FP_REFS = {"];
	Object.entries(fpRefs).forEach(([key, list]) => {
		lines.push(`\t"${key}": [`);
		list.forEach((en) => lines.push(...scanFpRefEntryLines(en)));
		lines.push("\t],");
	});
	lines.push("};");
	const newBlock = lines.join("\n");

	if (WRITE) {
		const text = fs.readFileSync(refsPath, "utf8");
		const next = replaceSectionText(text, {
			startMarker: "// SCAN_FP_REFS：",
			varMarker: "var SCAN_FP_REFS = {",
			endMarker: "\n};",
			newBlock,
		});
		writeFileAtomic(refsPath, next);
		verifyRefsVar(refsPath, "SCAN_FP_REFS");
	}

	/* ------------------------------ 报告 ------------------------------ */
	fs.writeFileSync(
		path.join(OUT_DIR, "refingerprint-report.json"),
		JSON.stringify(report, null, 1),
	);
	console.log(`冲突组 ${groups.length} 个；覆盖法宝 ${pieceCovered} 件（0 样本 ${report.zeroSample.length} 件保持缺指纹）；条目 ${entryCnt} 条；保留样本 ${samples.length} / 剔除 ${excluded.length}`);
	if (report.zeroSample.length) {
		console.log(`0 样本：${report.zeroSample.map((s) => s.split(" ").pop()).join("、")}`);
	}
	console.log("\n========== 逐组摘要 ==========");
	Object.entries(report.groups).forEach(([key, g]) => {
		const cross = g.pairs.filter((p) => p.crossName && p.diff != null);
		const minCross = cross.length ? Math.min(...cross.map((p) => p.diff)) : null;
		console.log(
			`[${key}] 模板 ${g.templates.length} 条，组 maxDiff=${g.maxDiff}，` +
				`最小类间 diff=${minCross ?? "—"}，样本 margin min=${g.marginMin ?? "—"}` +
				(g.merges.length
					? `，合并建议：${g.merges.map((m) => `${m.name}${m.suggest ? "建议合并" : m.avgDiff != null && m.avgDiff < 15 ? "仿真未通过保留分品质" : "≥15 保留分品质"}(avg ${m.avgDiff ?? "∞"}${m.maxDOwn != null ? `，仿真 maxDOwn ${m.maxDOwn}/阈值 ${m.effMaxDiff}` : ""})`).join("；")}`
					: ""),
		);
	});
	if (excluded.length) {
		console.log("\n========== 自动剔除样本 ==========");
		report.samplesExcluded.forEach((s) => console.log(`  -- ${s}`));
	}
	if (warnings.length) {
		console.log("\n========== 警告 ==========");
		warnings.forEach((w) => console.log(`  !! ${w}`));
	}
	console.log(`\n报告 → ${path.join(OUT_DIR, "refingerprint-report.json")}`);
	console.log(WRITE ? `已段级替换 ${refsPath} 的 SCAN_FP_REFS 段` : "--no-write：未改数据文件");
}

main().catch((e) => {
	console.error("重提失败：", e);
	process.exit(1);
});
