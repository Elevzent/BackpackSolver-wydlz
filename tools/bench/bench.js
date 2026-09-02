/**
 * 批量回归跑分工具（node）：
 *   node tools/bench/bench.js run     —— 对 test_images/*.PNG 跑真实识别流水线，
 *                                       结果写入 tools/bench/out/<文件名>.json
 *   node tools/bench/bench.js compare —— 对照 test_images/truth/ 评分，
 *                                       报告打印到控制台并写入 tools/bench/out/report.json
 *   node tools/bench/bench.js calib-dots —— 按 truth anchor 格统计元素圆点 hue 分布，
 *                                       簇分析产出 SCAN_DOT_TYPES 校准建议，经交叠
 *                                       硬校验后可 --yes 段级写回 data/scan-fp-refs.js；
 *                                       v2 附加边际案例归因报告，--skip-marginal 只采样
 *
 * run / calib-dots 按图并行（workers/image-worker.js 进程池），calib-types /
 * calib-pixel 折并行（workers/calib-worker.js 进程池），产物与串行逐字节一致；
 * 并发默认 os.cpus()-2，BENCH_JOBS 覆盖（BENCH_JOBS=1 退化为单 worker）；
 * 并行阶段带终端进度条。
 * 识别逻辑复用 script/scan-core.js 全局函数（vm.runInThisContext 挂 globalThis，
 * 模拟浏览器 <script src>）；PNG 解码（pngjs）/ 核心加载 / 重采样包装等共享
 * 基建在 lib/core.js，本文件只实现各子命令流程。
 */

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { resolveJobs, runPool } = require("./lib/parallel.js");
const { ProgressBar } = require("./lib/progress.js");
const { writeRefsSectionInteractive, resolveWriteMode } = require("./lib/refs-section-io.js");
const {
	ROOT,
	IMG_DIR,
	TRUTH_DIR,
	OUT_DIR,
	loadScanCore,
} = require("./lib/core.js");

const REPORT_PATH = path.join(OUT_DIR, "report.json");

/** run */
const IMAGE_WORKER = path.join(__dirname, "workers", "image-worker.js");

async function cmdRun() {
	fs.mkdirSync(OUT_DIR, { recursive: true });

	// 测试图清单：取 truth 目录中有人工标注的文件（行列数也从 truth 取）
	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.filter((f) => fs.existsSync(path.join(IMG_DIR, f)))
		.sort();

	// 按图并行（image-worker.js：解码→定位→切格→特征→packing→命名，与串行逐行一致），
	// 结果按图序重组，父进程统一写出，产物与串行逐字节一致
	const jobs = resolveJobs(2048); // 每 worker 一个 opencv wasm 实例，按 2GB/个压内存上限
	console.log(`并行识别：${files.length} 图 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const t0 = Date.now();
	const bar = new ProgressBar({ total: files.length, label: "run" });
	const results = await runPool(
		IMAGE_WORKER,
		files.map((file) => ({ file })),
		{
			jobs,
			init: { mode: "run" },
			onTaskDone: (i, r) => bar.tick(r.msg),
		},
	);
	bar.done();

	let okCnt = 0;
	results.forEach((r) => {
		if (r.result.detectOk) okCnt++;
		fs.writeFileSync(
			path.join(OUT_DIR, `${r.result.file}.json`),
			JSON.stringify(r.result, null, 2),
		);
	});
	// 逐图明细保留在终端滚动区之上：只汇总失败/异常，正常图不再逐行刷屏
	const msgs = results
		.map((r) => r.msg)
		.filter((m) => m.includes("定位失败") || m.includes("异常"));
	if (msgs.length) {
		console.log("\n========== 定位失败 / 异常 ==========");
		msgs.forEach((m) => console.log(`  ${m}`));
	}
	console.log(
		`\n完成：${files.length} 张图，棋盘定位成功 ${okCnt} 张（${((Date.now() - t0) / 1000).toFixed(0)}s）`,
	);
}

/** calib-dots：元素圆点 hue 校准 */
/**
 * 遍历 truth 棋子 anchor 格（定位/切格逻辑与 run 一致），用 scanDiskHues 圆盘
 * 全像素采样提取有效票 hue，按类型分桶；hue 直方图分水岭簇分析（主峰连续归属段
 * 成区间，scan-bench.js scanHueWatershed）按构造产出零重叠的建议 SCAN_DOT_TYPES
 * 区间，替代旧 p1~p99±2（互相重叠、依赖人工收窄）口径。棋盘定位失败的图跳过并在报告中注明。
 * 入库硬校验：写回前经 scanDotTypesValidate 两两交叠检查，重叠即拒绝
 * （--yes 直写 / 交互确认 / 非 TTY 默认只出报告）。
 *
 * v2 附加全格判定（同 run 管线 scanCellFeat）与「判错/判无/假 dot」边际案例逐案
 * 闸门归因（scanDotGateDetail + scanDotMarginalCause），只出报告
 * （out/calib-dots-v2-report.json 与 -summary.txt）；--skip-marginal 跳过全格判定只采样。
 * （2026-08-07 Step 5：原「按格票量分布/雷火策略仿真/类型体检」三节为环 16 点口径
 * 历史评估报告，区间与策略均已拍板，随 scan-bench.js 对应函数一并删除。）
 */
async function cmdCalibDots() {
	const skipMarginal = process.argv.includes("--skip-marginal");
	loadScanCore(); // 父进程仍需统计/报告函数（scanCalibDots 等）；定位切格在 worker
	fs.mkdirSync(OUT_DIR, { recursive: true });

	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.filter((f) => fs.existsSync(path.join(IMG_DIR, f)))
		.sort();

	const buckets = {}; // type -> { cells, empty, hues[] }
	const cellScan = []; // 全格判定快照（含失败格诊断字段）
	const skipped = [];
	const truthByFile = {}; // file -> truth（已知清单复核解析锚点用）
	files.forEach((file) => {
		truthByFile[file] = JSON.parse(
			fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
		);
	});

	// 按图并行采样（image-worker.js：定位/切格/逐格判定与串行逐行一致），
	// 结果按图序合并——分桶 hues、cellScan 的内容与顺序同串行
	const jobs = resolveJobs(2048); // 每 worker 一个 opencv wasm 实例，按 2GB/个压内存上限
	console.log(`并行采样：${files.length} 图 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const t0 = Date.now();
	const bar = new ProgressBar({ total: files.length, label: "calib-dots" });
	const perImage = await runPool(
		IMAGE_WORKER,
		files.map((file) => ({ file })),
		{
			jobs,
			init: { mode: "calib-dots", skipMarginal },
			onTaskDone: (i, r) => bar.tick(r.file + (r.skipped ? "（跳过）" : "")),
		},
	);
	bar.done();
	perImage.forEach((r) => {
		if (r.skipped) {
			skipped.push(r.skipped);
			return;
		}
		Object.entries(r.bucketHues).forEach(([t, pb]) => {
			const b = (buckets[t] = buckets[t] || { cells: 0, empty: 0, hues: [] });
			b.cells += pb.cells;
			b.empty += pb.empty;
			b.hues.push(...pb.hues);
		});
		cellScan.push(...r.cellScan);
	});
	console.log(`采样完成（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

	// 分桶统计（分位数 / 回绕检测 / 簇分析建议区间 / 交叠复核 / 建议配置文本）
	// 抽到 script/scan-bench.js 的 scanCalibDots，与工具页「元素校准」tab 共用；
	// 下方只做控制台打印与报告写盘
	const calib = globalThis.scanCalibDots(buckets);
	const rangesNow0 = globalThis.SCAN_DOT_TYPES;
	const cmpRow = (t) => {
		const now = rangesNow0.find((r) => r[2] === t);
		const rec = calib.types[t];
		if (!rec || !rec.range) return null;
		const same = now && now[0] === rec.range[0] && now[1] === rec.range[1];
		return { t, now: now ? [now[0], now[1]] : null, suggest: rec.range, same };
	};
	const compare = Object.keys(calib.types).map(cmpRow).filter(Boolean);
	const report = {
		skipped,
		types: calib.types,
		ranges: calib.ranges,
		compare, // 簇分析建议区间 vs 现行 SCAN_DOT_TYPES
		warnings: calib.warnings,
	};

	console.log("\n========== 元素圆点 hue 分布（圆盘采样） ==========");
	Object.entries(calib.types).forEach(([t, rec]) => {
		console.log(
			`\n[${t}] 样本格 ${rec.cells}（无有效票 ${rec.emptyCells}），hue 样本 ${rec.samples}`,
		);
		if (!rec.samples) {
			console.log("  !! 无样本，无法校准");
			return;
		}
		console.log(
			`  min=${rec.min} p1=${rec.p1} p5=${rec.p5} p50=${rec.p50} p95=${rec.p95} p99=${rec.p99} max=${rec.max}${rec.wrap ? "（跨 0/179，已旋转统计）" : ""}`,
		);
		if (!rec.range) return; // 体等不出区间类型
		console.log(
			`  簇（分水岭）：主峰 h=${rec.cluster.peak}，主峰连续归属段 bin ${rec.cluster.loBin}~${rec.cluster.hiBin}`,
		);
		console.log(`  建议区间：[${rec.range[0]}, ${rec.range[1]}, "${t}"]`);
	});

	console.log("\n========== 建议区间 vs 现行 SCAN_DOT_TYPES ==========");
	compare.forEach((c) => {
		console.log(
			`  [${c.t}] 现行 ${c.now ? `[${c.now[0]},${c.now[1]}]` : "（无）"} → 建议 [${c.suggest[0]},${c.suggest[1]}]${c.same ? "（一致）" : "（变化）"}`,
		);
	});

	// 区间两两交叠复核（scanCalibDots 分水岭产出异常才进 warnings，正常为空）
	console.log("\n========== 区间交叠检查 ==========");
	const overlapWarnings = calib.warnings.filter((w) => w.includes("区间交叠"));
	overlapWarnings.forEach((w) => console.log(`  !! ${w}`));
	if (!overlapWarnings.length) console.log("  （无交叠）");

	console.log("\n========== 建议 SCAN_DOT_TYPES ==========");
	console.log(calib.suggest);
	if (skipped.length) {
		console.log("\n========== 跳过（棋盘定位失败） ==========");
		skipped.forEach((s) => console.log(`  -- ${s}`));
	}
	fs.writeFileSync(
		path.join(OUT_DIR, "calib-dots-report.json"),
		JSON.stringify(report, null, 2),
	);
	console.log(`\n校准报告已写入 ${path.join(OUT_DIR, "calib-dots-report.json")}`);

	/* 入库硬校验 + 写回（2026-08-07 Step 4） */
	// 簇分析产出自动零重叠；此处为兜底硬校验——交叠即拒绝入库（历史事故：
	// p1~p99±2 原始建议互相重叠直接入库，土有效 hue 带被挤到 2.5 单位）。
	// 校验口径与判定语义一致（开区间；火/雷交叠为策略 B 设计豁免），现行
	// v2 区间的端点相邻（8/9、16/17、25/26）属边界互补，可通过。
	const validation = globalThis.scanDotTypesValidate(calib.ranges);
	if (!validation.ok) {
		console.log("\n========== 入库硬校验：拒绝写回 ==========");
		validation.problems.forEach((p) => console.log(`  !! ${p}`));
	} else if (JSON.stringify(calib.ranges) !== JSON.stringify(rangesNow0.map(([lo, hi, t]) => [lo, hi, t]))) {
		const dotLine = `var SCAN_DOT_TYPES = ${JSON.stringify(calib.ranges.map(([lo, hi, t]) => [lo, hi, t]))};`;
		await writeRefsSectionInteractive({
			refsPath: path.join(ROOT, "data/scan-fp-refs.js"),
			varName: "SCAN_DOT_TYPES",
			startMarker: "// SCAN_DOT_TYPES：",
			varMarker: "var SCAN_DOT_TYPES = ",
			endMarker: "\n",
			inclusiveEnd: false,
			summaryLines: [
				`建议区间（簇分析）：${JSON.stringify(calib.ranges)}`,
				`交叠硬校验通过（开区间口径；火/雷策略 B 豁免）`,
				`注意：区间变更入库后必须按重训链重训双模型（dump-feats → calib-types → dump-pixels → calib-pixel）`,
			],
			newBlock:
				`// SCAN_DOT_TYPES：元素圆点 hue(0-179) 区间 -> 法宝类型；lo > hi 表示跨 180 回绕（如红色 [174, 9]）\n` +
				`// 区间端点为开区间（匹配判定 h>lo && h<hi）；由 test_images 全量样本簇分析校准\n` +
				`//（2026-08-07，node tools/bench/bench.js calib-dots：圆盘采样 hue 直方图分水岭簇分析，\n` +
				`// 按构造产出零重叠区间，入库前经 scanDotTypesValidate 交叠硬校验）。\n` +
				`// 体为低饱和灰徽标（hue 不可分）不出区间，走独立判定路径。\n` +
				`// 雷/火如存在交叠为策略 B 设计：重叠段对雷/火各记一票、多数决（scan-core.js scanDotHueTypes）。\n` +
				dotLine,
		});
	} else {
		console.log("\n建议区间与现行 SCAN_DOT_TYPES 完全一致，无需写回（交叠硬校验通过）。");
	}

	/* v2：边际案例归因（判错/判无/假 dot 逐案）+ 已知清单复核 */
	const SR = globalThis.SCAN_REC;
	const rangesNow = globalThis.SCAN_DOT_TYPES;
	const summary = []; // 可读摘要行（控制台 + out/calib-dots-v2-summary.txt）

	let marginalReport = null;
	if (!skipMarginal) {
		const failing = cellScan.filter((s) => s.failing);
		const anchorsScanned = cellScan.filter((s) => s.role.startsWith("anchor:")).length;
		// 已知失败清单（CONTEXT.md 一.二 bench 证据），复核本次扫描复现情况
		const KNOWN = [
			{ file: "雷+木1", cells: [[1, 0]], kind: "dot=false" },
			{ file: "雷+木3", cells: [[4, 4]], kind: "dot=false" },
			{ file: "雷1", cells: [[4, 3]], kind: "dot=false" },
			{ file: "雷1", cells: [[1, 2]], kind: "dot=false" },
			{ file: "雷3", cells: [[1, 0]], kind: "dot=false" },
			{ file: "雷4", cells: [[4, 1]], kind: "dot=false" },
			{ file: "雷5", cells: [[1, 3]], kind: "dot=false" },
			{ file: "雷6", cells: [[2, 1]], kind: "dot=false" },
			{ file: "火5", cells: [[0, 3]], kind: "dot=false（反例）" },
			{ file: "雷+木1", cells: [[1, 5], [1, 6]], kind: "type错" },
			{ file: "雷+木3", cells: [[1, 5], [1, 6]], kind: "type错" },
			{ file: "雷2", cells: [[1, 5]], kind: "type错" },
			{ file: "雷6", cells: [[1, 5]], kind: "type错" },
			{ file: "雷7", cells: [[1, 5], [2, 5]], kind: "type错" },
			{ file: "雷8", cells: [[4, 3], [4, 4], [5, 3], [5, 4]], kind: "type错" },
			{ file: "雷8", cells: [[4, 5], [4, 6], [5, 5], [5, 6]], kind: "type错" },
			{ file: "雷9", cells: [[4, 5]], kind: "type错" },
			{ file: "火6", cells: [[1, 4]], kind: "假dot" },
			{ file: "火6", cells: [[2, 3]], kind: "假dot" },
			{ file: "土+体", cells: [[5, 1]], kind: "假dot" },
			{ file: "火3", cells: [[2, 2]], kind: "假dot" },
		];
		const baseName = (f) => f.replace(/（[^）]*）/g, "").replace(/\.PNG$/i, "");
		const cellsKey = (cells) =>
			JSON.stringify(cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]));
		const knownCheck = KNOWN.map((k) => {
			const file = files.find((f) => baseName(f) === k.file);
			const out = { ...k };
			if (!file) return { ...out, status: "缺图" };
			out.file = file;
			let [r, c] = k.cells[0];
			let expectType = null;
			if (k.kind === "type错") {
				const piece = truthByFile[file].pieces.find(
					(p) => cellsKey(p.cells) === cellsKey(k.cells),
				);
				if (!piece) return { ...out, status: "truth 无此件" };
				[r, c] = piece.anchor;
				expectType = piece.type;
			} else {
				expectType = truthByFile[file].pieces.find(
					(p) => p.anchor[0] === r && p.anchor[1] === c,
				)?.type;
			}
			out.anchor = [r, c];
			out.expectType = expectType || null;
			const rec = cellScan.find((s) => s.file === file && s.r === r && s.c === c);
			if (!rec) return { ...out, status: "未扫描（棋盘定位失败？）" };
			out.actual = `dot=${rec.dot} dotType=${rec.dotType}`;
			const reproduced =
				k.kind === "假dot"
					? rec.dot
					: k.kind === "type错"
						? rec.dot && rec.dotType !== expectType
						: !rec.dot;
			out.status = reproduced ? "复现" : "未复现";
			return out;
		});
		marginalReport = {
			anchorsScanned,
			cellsScanned: cellScan.length,
			failingCount: failing.length,
			failing,
			knownCheck,
		};
		const reproduced = knownCheck.filter((k) => k.status === "复现").length;
		summary.push("\n========== v2 边际案例（判错/判无/假 dot）逐案归因 ==========");
		summary.push(
			`扫描格 ${cellScan.length}（锚点 ${anchorsScanned}），失败格 ${failing.length}；已知清单 ${KNOWN.length} 例复现 ${reproduced} 例`,
		);
		failing.forEach((s) => {
			summary.push(
				`-- ${s.file} (${s.r},${s.c}) ${s.role} → dot=${s.dot} dotType=${s.dotType} qual=${s.qual}` +
					`${s.hues ? ` hues=${JSON.stringify(s.hues)}` : ""}`,
			);
			(s.causes || []).forEach((c2) => summary.push(`   * ${c2}`));
		});
		summary.push("-- 已知清单复核 --");
		knownCheck.forEach((k) =>
			summary.push(
				`   ${k.status} ${k.file} ${JSON.stringify(k.cells)} ${k.kind}${k.actual ? `（实际 ${k.actual}）` : ""}`,
			),
		);
		// 闸门归因聚合（类别 × 闸门计数，报告驱动区间/阈值微调用）
		const catCount = {};
		const gateTally = {};
		failing.forEach((s) => {
			const cat = !s.role.startsWith("anchor:")
				? "假dot"
				: !s.dot
					? "锚点dot=false"
					: "锚点type错";
			catCount[cat] = (catCount[cat] || 0) + 1;
			(s.causes || []).forEach((c2) => {
				const key = c2.split(/：|（/)[0];
				gateTally[key] = (gateTally[key] || 0) + 1;
			});
		});
		marginalReport.catCount = catCount;
		marginalReport.gateTally = gateTally;
		summary.push("-- 闸门归因聚合 --");
		summary.push(`   类别：${JSON.stringify(catCount)}`);
		Object.entries(gateTally)
			.sort((a, b) => b[1] - a[1])
			.forEach(([k2, n2]) => summary.push(`   ${k2} × ${n2}`));
	}

	const v2Report = {
		params: {
			dotHits: SR.dotHits,
			dotMinS: SR.dotMinS,
			ranges: rangesNow,
			skipMarginal,
		},
		marginal: marginalReport,
	};
	fs.writeFileSync(
		path.join(OUT_DIR, "calib-dots-v2-report.json"),
		JSON.stringify(v2Report, null, 2),
	);
	fs.writeFileSync(
		path.join(OUT_DIR, "calib-dots-v2-summary.txt"),
		summary.join("\n") + "\n",
	);
	summary.forEach((l) => console.log(l));
	console.log(
		`\nv2 报告已写入 ${path.join(OUT_DIR, "calib-dots-v2-report.json")} 与 calib-dots-v2-summary.txt`,
	);
}

/** calib-types：灰区类型分类器训练/评估 */
const CALIB_WORKER = path.join(__dirname, "workers", "calib-worker.js");

/**
 * 折并行 CV（calib-types / calib-pixel 共用）：每折一个任务进 worker 池，
 * 折间天然独立（树模型无随机状态；MLP 每次训练内部自建种子 RNG），结果按
 * 折序重组，preds 与串行 scanCvTypeModel / scanCvPixelModel 逐项一致。
 * 参数：mode —— "types"|"pixel"；foldTasks —— [{ group, opts }（每折）× N 配置]
 *   按配置分组连续排列；返回各段 preds 按折序 flat 后的二维数组。
 */
async function cvParallel(mode, samples, foldTasks, jobs, onFold) {
	const G = [...new Set(samples.map((s) => s.group))].length;
	const foldPreds = await runPool(
		CALIB_WORKER,
		foldTasks.map((t) => ({ mode, group: t.group, opts: t.opts })),
		{ jobs, init: { samples }, onTaskDone: onFold },
	);
	const segments = [];
	for (let s = 0; s < foldTasks.length / G; s++) {
		segments.push(foldPreds.slice(s * G, (s + 1) * G).flat());
	}
	return segments;
}

/**
 * 读 out/feat-dump.json（先跑 node tools/bench/dump-feats.js），调 scan-bench.js
 * 纯函数完成：按图留一 CV 对比四种模型（高斯 NB / 最近质心 / 多分类 CART /
 * 一对其余树集）→ 闸门（scoreTh/marginMin）按 FP 预算制寻优（预算内 TP 最大，
 * 预算默认 5，CLI 第三参数覆盖：calib-types 3）→ 端到端等效指标 → 全量训练。
 * 写 out/calib-types-report.json 与 out/scan-type-model.js；末尾确认是否段级写回
 * data/scan-fp-refs.js 的 SCAN_TYPE_MODEL 段（--yes 直写 / --no-write / 非 TTY 只出产物）。
 */
/** SCAN_TYPE_MODEL 段文本（段头注释 + var 行）：正常重训与「零正样本仅刷新
 *  水印」两条写回路径共用同一模板，防两处漂移 */
const typeModelSection = (modelJson) =>
	"// SCAN_TYPE_MODEL：灰区元素类型统计分类器模型（生成物，请勿手改）——由\n" +
	"// node tools/bench/bench.js calib-types 生成，训练数据 tools/bench/out/feat-dump.json，\n" +
	"// 按图留一 CV 指标与闸门寻优依据见 tools/bench/out/calib-types-report.json。\n" +
	"// dotTypes 为区间水印（训练所对齐的 SCAN_DOT_TYPES），与文件当前区间\n" +
	"// 不一致即待重训，提取工具据此判定。\n" +
	"// 段级写回 data/scan-fp-refs.js：训练结束确认后整段替换（段头注释随本次运行\n" +
	"// 重生成，人工补充需写回后重加）；--yes 直写 / --no-write 只出产物。\n" +
	"// 用途：scanCellFeat 规则链全路径判负后的类型兜底（软守卫：模型缺失时跳过）。\n" +
	`var SCAN_TYPE_MODEL = ${JSON.stringify(modelJson)};\n`;

async function cmdCalibTypes() {
	loadScanCore();
	const dumpPath = path.join(OUT_DIR, "feat-dump.json");
	if (!fs.existsSync(dumpPath)) {
		console.error("缺少 out/feat-dump.json，请先执行 node tools/bench/dump-feats.js");
		process.exit(1);
	}
	const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
	const { samples, excluded, stats } = scanTypeSamples(dump);
	console.log(`转储 ${dump.length} 格；灰区 ${stats.gray} 格；训练样本 ${samples.length}（${JSON.stringify(stats.labelDist)}）；排除 anchor:雷 ${excluded.length} 格`);
	// 灰区无正样本（规则链已覆盖全部真锚点）：模型无补救职责，CV/闸门寻优在
	// 零正类下无意义且会崩溃（出折模型无可评类），保留现有模型权重——但区间
	// 水印必须跟随当前 SCAN_DOT_TYPES 刷新写回，否则提取工具的水印一致性判定
	// （main.fp.js fpModelsWatermark）会永久亮「待重训」，重训多少遍都解不了。
	// 水印只作对齐标记，scan-core 推理不读模型 dotTypes，重盖章不改变识别行为。
	const posTotal = Object.entries(stats.labelDist)
		.filter(([k]) => k !== "neg")
		.reduce((s, [, n]) => s + n, 0);
	if (!posTotal) {
		const cur = globalThis.SCAN_TYPE_MODEL;
		const want = globalThis.SCAN_DOT_TYPES || null;
		if (cur && JSON.stringify(cur.dotTypes || null) !== JSON.stringify(want)) {
			console.log("灰区无正样本：规则链已覆盖全部真锚点，模型无补救职责——保留现有 SCAN_TYPE_MODEL 权重，仅刷新区间水印");
			await writeRefsSectionInteractive({
				refsPath: path.join(ROOT, "data", "scan-fp-refs.js"),
				varName: "SCAN_TYPE_MODEL",
				startMarker: "// SCAN_TYPE_MODEL：",
				varMarker: "var SCAN_TYPE_MODEL = ",
				endMarker: "\n",
				inclusiveEnd: false,
				appendIfMissing: true,
				newBlock: typeModelSection({ ...cur, dotTypes: want }).trimEnd(),
				summaryLines: [
					"灰区无正样本：保留现有模型权重（未重训），仅将区间水印刷新为当前 SCAN_DOT_TYPES",
					`水印：${JSON.stringify(cur.dotTypes || null)} → ${JSON.stringify(want)}`,
				],
			});
		} else {
			console.log("灰区无正样本：规则链已覆盖全部真锚点，模型无补救职责——保留现有 SCAN_TYPE_MODEL，不写回");
		}
		return;
	}

	// 闸门寻优的 FP 预算（灰区正样本仅 ~27 个，FP=0 会退化到 TP=0）；
	// 可用 CLI 第三个非 flag 参数覆盖：node tools/bench/bench.js calib-types 3
	const posArgs = process.argv.slice(3).filter((a) => !a.startsWith("--"));
	const FP_BUDGET = posArgs[0] !== undefined ? parseInt(posArgs[0], 10) : 5;
	if (!Number.isInteger(FP_BUDGET) || FP_BUDGET < 0) {
		console.error(`fpBudget 参数非法：${posArgs[0]}`);
		process.exit(1);
	}
	console.log(`FP 预算：${FP_BUDGET}`);
	resolveWriteMode(process.argv); // --yes/--no-write 冲突在训练前失败
	// 模型对比：树类用 posWeight=30 对冲 1:60 类失衡；ovr2 为 minLeaf=2 对照
	const configs = [
		{ name: "nb", opts: { kind: "nb" } },
		{ name: "centroid", opts: { kind: "centroid" } },
		{ name: "tree", opts: { kind: "tree", posWeight: 30, maxDepth: 8, minLeaf: 2 } },
		{ name: "ovr", opts: { kind: "ovr", posWeight: 30, maxDepth: 8, minLeaf: 1 } },
		{ name: "ovr2", opts: { kind: "ovr", posWeight: 30, maxDepth: 8, minLeaf: 2 } },
	];
	// 折并行 CV：63 折 × 配置数 个任务进 worker 池，折序重组（与串行逐项一致）
	const jobs = resolveJobs(512);
	const groups = [...new Set(samples.map((s) => s.group))];
	console.log(`按图留一 CV：${groups.length} 折 × ${configs.length} 配置 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const tCv = Date.now();
	const foldTasks = configs.flatMap((cfg) => groups.map((group) => ({ group, opts: cfg.opts })));
	const cvBar = new ProgressBar({ total: foldTasks.length, label: "CV" });
	const cvPreds = await cvParallel("types", samples, foldTasks, jobs, (i) =>
		cvBar.tick(`${foldTasks[i].opts.kind || "?"} 折 ${foldTasks[i].group}`),
	);
	cvBar.done();
	console.log(`  CV 完成（${((Date.now() - tCv) / 1000).toFixed(0)}s）`);
	// 逐配置闸门寻优（出折预测上按 FP 预算扫描阈值前沿，样本量大时单配置需数分钟）
	const results = [];
	for (let ci = 0; ci < configs.length; ci++) {
		const cfg = configs[ci];
		const tGate = Date.now();
		console.log(`  闸门寻优 [${cfg.name}]（${ci + 1}/${configs.length}）...`);
		const cv = { preds: cvPreds[ci], folds: groups.length };
		const gate = scanTuneTypeGate(cv.preds, { fpBudget: FP_BUDGET });
		console.log(`  [CV] ${cfg.name}: TP=${gate.tp}/${gate.posTotal} FP=${gate.fp} 判错=${gate.wrongType} 闸门 scoreTh=${gate.scoreTh.toFixed(2)} marginMin=${gate.marginMin.toFixed(2)}（${((Date.now() - tGate) / 1000).toFixed(0)}s）`);
		results.push({ name: cfg.name, opts: cfg.opts, cv, gate });
	}
	// 采用模型：FP 预算内 TP 最高 → FP 最少 → 判错类型最少
	let adopted = results[0];
	results.forEach((r) => {
		const better =
			r.gate.tp > adopted.gate.tp ||
			(r.gate.tp === adopted.gate.tp && r.gate.fp < adopted.gate.fp) ||
			(r.gate.tp === adopted.gate.tp && r.gate.fp === adopted.gate.fp && r.gate.wrongType < adopted.gate.wrongType);
		if (better) adopted = r;
	});
	console.log(`  采用 ${adopted.name}；逐类指标 / 端到端等效评估（${dump.length} 格）...`);
	const tEval = Date.now();
	const evalAd = scanEvalTypeModel(adopted.cv.preds, adopted.gate);
	const e2e = scanEndToEndTypeMetrics(dump, adopted.cv.preds, adopted.gate);
	console.log(`  评估完成（${((Date.now() - tEval) / 1000).toFixed(0)}s）；全量训练最终模型...`);

	// 全量训练最终模型并挂上闸门（闸门按出折预测寻优，乐观偏差可忽略——
	// 63 折模型与全量模型仅差一图样本）
	const tTrain = Date.now();
	const finalModel = scanTrainTypeModel(samples, adopted.opts);
	finalModel.gate = { scoreTh: adopted.gate.scoreTh, marginMin: adopted.gate.marginMin };
	console.log(`  全量训练完成（${((Date.now() - tTrain) / 1000).toFixed(0)}s）；in-sample 参考口径 / 规则评分卡对照...`);

	// in-sample 参考口径（全量训练全量评估，偏乐观，仅供对照，不作验收依据）
	const inSamplePreds = samples.map((s) => {
		const sc = scanTypeModelScore(finalModel, s.feats);
		return { file: s.file, r: s.r, c: s.c, role: s.role, label: s.label, best: sc.best, bestScore: sc.bestScore, second: sc.second, margin: sc.margin };
	});
	const inSampleEval = scanEvalTypeModel(inSamplePreds, finalModel.gate);
	const inSampleTally = { tp: 0, fp: 0, wrongType: 0, unsure: 0 };
	inSamplePreds.forEach((p) => {
		const decided = p.bestScore >= finalModel.gate.scoreTh && p.margin >= finalModel.gate.marginMin;
		const pred = decided ? p.best : null;
		if (p.label === "neg") { if (pred) inSampleTally.fp++; else inSampleTally.unsure++; }
		else if (!pred) inSampleTally.unsure++;
		else if (pred === p.label) inSampleTally.tp++;
		else inSampleTally.wrongType++;
	});

	// 规则式评分卡对照（人工规则，非学习器；在同批灰区样本上评估，特征区域
	// 确实存在但学习器在留一 CV 下学不稳定的证据，供阶段二/三决策参考）
	const ruleScore = (f) =>
		f.inDark >= 0.45 && f.inVStd >= 50 && f["v土"] >= 6 && f.mv !== null && f.mv <= 200 && f.iconPx >= 2400 ? "土" : null;
	const ruleTally = { tp: 0, fp: 0, wrongType: 0, posTotal: 0, fpCases: [] };
	samples.forEach((s) => {
		const pred = ruleScore(s.feats);
		if (s.label !== "neg") ruleTally.posTotal++;
		if (!pred) return;
		if (pred === s.label) ruleTally.tp++;
		else if (s.label === "neg") {
			ruleTally.fp++;
			ruleTally.fpCases.push({ file: s.file, r: s.r, c: s.c, role: s.role, pred });
		} else ruleTally.wrongType++;
	});

	// 被排除的 anchor:雷 灰区格观察：最终模型会把它们判成什么（阶段二集成
	// 时雷锚点若被判为其他类型会产生错类型锚点，需额外处理）
	const leiObs = excluded.map((s) => {
		const sc = scanTypeModelScore(finalModel, s.feats);
		const decided =
			sc.bestScore >= finalModel.gate.scoreTh && sc.margin >= finalModel.gate.marginMin;
		return {
			file: s.file,
			r: s.r,
			c: s.c,
			best: sc.best,
			decided: decided ? sc.best : null,
			bestScore: +sc.bestScore.toFixed(2),
			margin: +sc.margin.toFixed(2),
		};
	});

	// 模型序列化（阈值/统计量保留 4 位小数控制体积；支持 nb/centroid/tree/ovr）
	const roundArr = (a) => a.map((v) => (v === null ? null : +v.toFixed(4)));
	const serTree = (nodes) =>
		nodes.map((n) => (n.d === undefined ? { dist: n.dist } : { d: n.d, th: +n.th.toFixed(4), ml: n.ml, l: n.l, r: n.r }));
	const buildModelJson = (m) => {
		const mj = {
			version: m.version,
			kind: m.kind,
			dims: m.dims,
			classes: m.classes,
			gate: m.gate, // 闸门不取整：临界样本对 scoreTh 1e-3 级舍入敏感
			// 区间水印：本模型训练所对齐的 SCAN_DOT_TYPES；提取工具据此判待重训
			// （与文件当前区间不一致即模型陈旧），替代旧 mtime / 段差异启发式
			dotTypes: globalThis.SCAN_DOT_TYPES || null,
		};
		if (m.kind === "tree") {
			mj.posWeight = m.posWeight;
			mj.tree = serTree(m.tree);
		} else if (m.kind === "ovr") {
			mj.posWeight = m.posWeight;
			mj.ovr = Object.fromEntries(Object.entries(m.ovr).map(([t, o]) => [t, { tree: serTree(o.tree) }]));
		} else {
			mj.varK = m.varK;
			mj.stats = Object.fromEntries(
				Object.entries(m.stats).map(([cl, st]) => [
					cl,
					{ n: st.n, prior: +st.prior.toFixed(6), mean: roundArr(st.mean), var: roundArr(st.var) },
				]),
			);
		}
		return mj;
	};
	const MODEL_SIZE_LIMIT = 20000;
	let sizeNote = null;
	let modelJson = buildModelJson(finalModel);
	let modelJs = typeModelSection(modelJson);
	if (Buffer.byteLength(modelJs) > MODEL_SIZE_LIMIT) {
		// 超体积：收敛树参数重训（minLeaf=2/maxDepth=7），指标以 CV 对比中对应配置为准
		const smallOpts = { ...adopted.opts, minLeaf: 2, maxDepth: 7 };
		const small = scanTrainTypeModel(samples, smallOpts);
		small.gate = finalModel.gate;
		const smallJs = modelJs.replace(/var SCAN_TYPE_MODEL = .*;\n$/, `var SCAN_TYPE_MODEL = ${JSON.stringify(buildModelJson(small))};\n`);
		sizeNote = `模型 ${Buffer.byteLength(modelJs)}B 超 ${MODEL_SIZE_LIMIT}B，已改用 minLeaf=2/maxDepth=7 重训（${Buffer.byteLength(smallJs)}B）`;
		modelJs = smallJs;
		console.log(`  [体积] ${sizeNote}`);
	}
	const modelPath = path.join(OUT_DIR, "scan-type-model.js");
	fs.writeFileSync(modelPath, modelJs);

	const report = {
		generated: new Date().toISOString(),
		samples: {
			dumpCells: dump.length,
			grayCells: stats.gray,
			roleDist: stats.roles,
			labelDist: stats.labelDist,
			trainSamples: samples.length,
			excludedLeiAnchors: excluded.length,
		},
		cv: { folds: results[0].cv.folds, method: "按图留一" },
		modelCompare: Object.fromEntries(
			results.map((r) => [
				r.name,
				{
					opts: r.opts,
					gate: { scoreTh: r.gate.scoreTh, marginMin: r.gate.marginMin },
					grayTP: r.gate.tp,
					grayFP: r.gate.fp,
					wrongType: r.gate.wrongType,
					unsure: r.gate.unsure,
					posTotal: r.gate.posTotal,
					negTotal: r.gate.negTotal,
				},
			]),
		),
		adopted: adopted.name,
		gateSearch: {
			objective: `FP 预算制：fp<=${FP_BUDGET} 内 TP 最多 → FP 最少 → 判错类型最少 → 不确定少`,
			fpTpCurve: adopted.gate.trace, // 采用模型的 FP/TP 前沿（fp 升序）
		},
		perClass: evalAd.perClass,
		confusion: evalAd.confusion,
		grayZone: {
			fpCases: evalAd.fpCases,
			wrongTypeCases: evalAd.wrongCases,
			unsure: evalAd.unsure,
			total: evalAd.total,
		},
		endToEnd: e2e,
		inSampleReference: { note: "全量训练全量评估（偏乐观，仅供对照）", ...inSampleTally, posTotal: adopted.gate.posTotal, negTotal: adopted.gate.negTotal },
		ruleScorecardReference: {
			note: "人工规则（非学习器，同批样本评估）：inDark>=0.45 & inVStd>=50 & v土>=6 & mv<=200 & iconPx>=2400 → 土",
			...ruleTally,
		},
		leiAnchorObservation: leiObs,
		modelSizeBytes: Buffer.byteLength(modelJs),
		modelSizeNote: sizeNote,
		modelPath,
	};
	const reportPath = path.join(OUT_DIR, "calib-types-report.json");
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));

	const pct = (v) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);
	console.log(`\n========== 模型对比（按图留一 CV，FP 预算 ${FP_BUDGET}） ==========`);
	results.forEach((r) => {
		console.log(`  ${r.name.padEnd(8)}：灰区 TP=${r.gate.tp}/${r.gate.posTotal} FP=${r.gate.fp} 判错类型=${r.gate.wrongType} 闸门 scoreTh=${r.gate.scoreTh.toFixed(2)} marginMin=${r.gate.marginMin.toFixed(2)}${r === adopted ? "  ← 采用" : ""}`);
	});
	console.log(`\n========== 灰区每类指标（${adopted.name}） ==========`);
	Object.entries(evalAd.perClass).forEach(([t, pc]) => {
		console.log(`  ${t}\tsupport=${pc.support}\tprecision=${pct(pc.precision)}\trecall=${pct(pc.recall)}`);
	});
	console.log("\n========== 端到端等效（锚点级） ==========");
	console.log(`  锚点总数 ${e2e.anchors.total}；基线召回 ${pct(e2e.anchors.baselineRecall)}（fastTP=${e2e.anchors.fastTP}）→ 模型合成 ${pct(e2e.anchors.modelRecall)}（+灰区TP=${e2e.anchors.grayTP}，灰区判错=${e2e.anchors.grayWrongType}）`);
	console.log(`  锚点误检：基线 ${e2e.fp.baseline} → 模型新增 ${e2e.fp.model}`);
	Object.entries(e2e.byType).forEach(([t, bt]) => {
		console.log(`  ${t}\t锚点 ${bt.total}，灰区 ${bt.grayTotal}，灰区回收 ${bt.grayTP}（${pct(bt.grayTotal ? bt.grayTP / bt.grayTotal : null)}）`);
	});
	console.log("\n========== 参考口径 ==========");
	console.log(`  in-sample（偏乐观）：TP=${inSampleTally.tp} FP=${inSampleTally.fp} 判错=${inSampleTally.wrongType}`);
	console.log(`  规则评分卡：土 TP=${ruleTally.tp} FP=${ruleTally.fp} 判错=${ruleTally.wrongType}`);
	if (evalAd.fpCases.length) {
		console.log("\n========== 灰区 FP 逐案 ==========");
		evalAd.fpCases.forEach((c) => console.log(`  ${c.file} (${c.r},${c.c}) ${c.role} → 判为 ${c.pred} score=${c.bestScore} margin=${c.margin}`));
	}
	console.log(`\n模型 ${report.modelSizeBytes}B → ${modelPath}`);
	console.log(`报告 → ${reportPath}`);

	// 写回决策摘要 + 确认（--yes 直写 / --no-write 跳过；非 TTY 默认跳过）
	await writeRefsSectionInteractive({
		refsPath: path.join(ROOT, "data", "scan-fp-refs.js"),
		varName: "SCAN_TYPE_MODEL",
		startMarker: "// SCAN_TYPE_MODEL：",
		varMarker: "var SCAN_TYPE_MODEL = ",
		endMarker: "\n",
		inclusiveEnd: false,
		appendIfMissing: true,
		newBlock: modelJs.trimEnd(),
		summaryLines: [
			`采用 ${adopted.name}：灰区 TP=${adopted.gate.tp}/${adopted.gate.posTotal} FP=${adopted.gate.fp} 判错类型=${adopted.gate.wrongType}`,
			`端到端锚点召回：基线 ${pct(e2e.anchors.baselineRecall)} → 模型合成 ${pct(e2e.anchors.modelRecall)}；误检 基线 ${e2e.fp.baseline} → 模型新增 ${e2e.fp.model}`,
			`模型体积 ${report.modelSizeBytes}B`,
		],
	});
}

/** calib-pixel：像素验证器训练/评估 */
/**
 * 读 out/pixel-dump/index.json + patch PNG + out/feat-dump.json（dot/dotType 口径
 * 对齐校验；先跑 dump-pixels.js 与 dump-feats.js）。样本 = 规则链判 dot=true 的格
 * （real=truth 锚点（含雷）/ fake=假 dot），架构固定 SCAN_PIXEL_ARCH（16²×3 HSV、
 * hidden=32、tanh，种子 20260804）。流程：63 折按图留一 → scanTunePixelGate 严格档
 * 阈值（出折真锚点 min vScore - 折间抖动余量，零真锚点误伤）→ 全量重训 → 写
 * out/scan-pixel-model.js 与 out/calib-pixel-report.json；末尾确认是否段级写回
 * data/scan-fp-refs.js 的 SCAN_PIXEL_MODEL 段（--yes 直写 / --no-write / 非 TTY 只出产物）。
 */
async function cmdCalibPixel() {
	loadScanCore();
	resolveWriteMode(process.argv); // --yes/--no-write 冲突在训练前失败
	const PIXEL_DIR = path.join(OUT_DIR, "pixel-dump");
	const indexPath = path.join(PIXEL_DIR, "index.json");
	const dumpPath = path.join(OUT_DIR, "feat-dump.json");
	if (!fs.existsSync(indexPath) || !fs.existsSync(dumpPath)) {
		console.error("缺少 out/pixel-dump/index.json 或 out/feat-dump.json，请先执行 node tools/bench/dump-pixels.js 与 dump-feats.js");
		process.exit(1);
	}
	const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
	const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
	// dot/dotType 口径对齐校验（两转储同源于 scanCellTypeFeats，应零偏差）
	const dotOf = {};
	dump.forEach((s) => {
		dotOf[`${s.file}|${s.r},${s.c}`] = s;
	});
	let mismatch = 0;
	index.forEach((s) => {
		const d = dotOf[`${s.file}|${s.r},${s.c}`];
		if (!d || d.dot !== s.dot || d.dotType !== s.dotType || d.role !== s.role) mismatch++;
	});
	if (mismatch) {
		console.error(`pixel-dump 与 feat-dump 口径不一致 ${mismatch} 格，请重跑两个转储`);
		process.exit(1);
	}
	console.log(`转储对齐校验通过：${index.length} 格`);

	// 样本 = dot=true 格；另备 dot=false 的锚点格（验证器作用域外观测用）
	const patchOf = (s) =>
		PNG.sync.read(fs.readFileSync(path.join(PIXEL_DIR, s.file, `${s.r}-${s.c}.png`))).data;
	const t0 = Date.now();
	console.log(`patch 解码 + 特征提取（${index.length} 格）...`);
	const samples = [];
	const grayAnchors = [];
	index.forEach((s) => {
		const isAnchor = s.role.startsWith("anchor:");
		if (!s.dot && !isAnchor) return;
		const x = scanPixelFeats(patchOf(s));
		const rec = {
			group: s.file,
			label: isAnchor ? "real" : "fake",
			meta: { file: s.file, r: s.r, c: s.c, role: s.role, dotType: s.dotType },
			x,
		};
		if (s.dot) samples.push(rec);
		else grayAnchors.push(rec);
	});
	const labelDist = {};
	samples.forEach((s) => {
		labelDist[s.label] = (labelDist[s.label] || 0) + 1;
	});
	console.log(`训练样本 ${samples.length}（${JSON.stringify(labelDist)}），作用域外锚点 ${grayAnchors.length}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

	const trainOpts = {
		hidden: SCAN_PIXEL_ARCH.hidden,
		activation: SCAN_PIXEL_ARCH.activation,
		classes: SCAN_PIXEL_CLASSES,
		epochs: +(process.env.PIXEL_EPOCHS || 600), // 容量校准（2026-08-10）：30/120/300/600 对照——在样杀假 96/114/115/116、出折杀假 107/107/111/112、误伤均 0/1528；600 两轴皆优（多杀的土13(4,5) 假水锚点贴 300 阈值存活），环境变量供后续实验
		seed: 20260804,
	};

	// 63 折按图留一 + 严格档阈值寻优（折并行 worker 池，折序重组，与串行逐项一致）
	const tl = Date.now();
	const jobs = resolveJobs(512);
	const looGroups = [...new Set(samples.map((s) => s.group))];
	console.log(`按图留一 CV：${looGroups.length} 折 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const pixelFoldTasks = looGroups.map((group) => ({ group, opts: trainOpts }));
	const looBar = new ProgressBar({ total: pixelFoldTasks.length, label: "留一 CV" });
	const [looPreds] = await cvParallel(
		"pixel",
		samples,
		pixelFoldTasks,
		jobs,
		(i) => looBar.tick(`折 ${pixelFoldTasks[i].group}`),
	);
	looBar.done();
	const loo = { preds: looPreds, folds: looGroups.length };
	const looMs = Date.now() - tl;
	console.log(`  留一 CV 完成（${(looMs / 1000).toFixed(0)}s）；严格档阈值寻优...`);
	const gate = scanTunePixelGate(loo.preds);
	console.log(
		`[63折留一] 阈值=${gate.vScoreTh.toFixed(4)}（出折真锚点 min=${gate.globalMin.toFixed(4)} - 余量=${gate.margin}，折间min std=${gate.foldMinStats.std.toFixed(3)}）杀假=${gate.kills}/${gate.fakeTotal} 误伤=${gate.harms}/${gate.realTotal}`,
	);
	console.log(
		`[分类型阈值] ${Object.entries(gate.vScoreThByType).map(([t, v]) => `${t}=${v.toFixed(2)}`).join(" ")} → 杀假=${gate.killsByType}/${gate.fakeTotal} 误伤=${gate.harmsByType}/${gate.realTotal}`,
	);

	// 全量重训最终模型
	const tf = Date.now();
	console.log(`全量重训 MLP（${trainOpts.epochs} epochs，${samples.length} 样本）...`);
	const finalModel = scanTrainPixelMlp(samples, trainOpts);
	finalModel.gate = { vScoreTh: gate.vScoreTh, vScoreThByType: gate.vScoreThByType };
	console.log(`全量重训 ${((Date.now() - tf) / 1000).toFixed(1)}s，loss=${finalModel.loss.toFixed(4)}`);

	// 最终模型全量 in-sample 判定（对照 truth）
	const vScoreOf = (x) => {
		const sc = scanMlpScore(finalModel, x);
		return Math.log(sc.probs.real + 1e-12) - Math.log(sc.probs.fake + 1e-12);
	};
	const judge = (rec) => {
		const v = vScoreOf(rec.x);
		return { ...rec.meta, vScore: +v.toFixed(4), killed: v < gate.vScoreTh };
	};
	const fakeJudged = samples.filter((s) => s.label === "fake").map(judge);
	const realJudged = samples.filter((s) => s.label === "real").map(judge);
	const grayJudged = grayAnchors.map(judge);
	const killedFakes = fakeJudged.filter((j) => j.killed);
	const harmedReals = realJudged.filter((j) => j.killed);
	console.log(`[全量 in-sample] 杀假=${killedFakes.length}/${fakeJudged.length} 误伤真锚点=${harmedReals.length}/${realJudged.length}（作用域外锚点被杀 ${grayJudged.filter((j) => j.killed).length}/${grayJudged.length}，仅观测）`);

	// 分类型阈值的成品模型在样收紧（2026-08-10）：出折 min 推导的阈值作用于全量
	// 重训模型时，真锚点在样分可能低于出折 min（训练集含与真锚点近似的硬假样本，
	// 决策边界压过真锚点簇——实测邪在样 min -2.39 < 出折 min 1.24，22/163 邪锚点
	// 被 0.74 阈值误伤）。逐类型取 min(出折阈值, 在样 min - margin) 收紧后零误伤
	// 在样可证；只降不升，杀假能力不优于出折阈值属已知代价
	const realMinByType = {};
	realJudged.forEach((j) => {
		const t = j.dotType || "?";
		if (!(t in realMinByType) || j.vScore < realMinByType[t]) realMinByType[t] = j.vScore;
	});
	Object.keys(finalModel.gate.vScoreThByType).forEach((t) => {
		const inMin = realMinByType[t];
		if (inMin !== undefined) {
			finalModel.gate.vScoreThByType[t] = Math.min(
				finalModel.gate.vScoreThByType[t],
				inMin - gate.margin,
			);
		}
	});
	const judgeByType = (rec) => {
		const v = vScoreOf(rec.x);
		const th = finalModel.gate.vScoreThByType[rec.meta.dotType];
		return { ...rec.meta, vScore: +v.toFixed(4), killed: v < (th === undefined ? finalModel.gate.vScoreTh : th) };
	};
	const killedFakesByType = samples.filter((s) => s.label === "fake").map(judgeByType).filter((j) => j.killed);
	const harmedRealsByType = samples.filter((s) => s.label === "real").map(judgeByType).filter((j) => j.killed);
	console.log(
		`[分类型阈值·收紧后] ${Object.entries(finalModel.gate.vScoreThByType).map(([t, v]) => `${t}=${v.toFixed(2)}`).join(" ")}\n` +
		`  在样：杀假=${killedFakesByType.length}/${fakeJudged.length} 误伤=${harmedRealsByType.length}/${realJudged.length}（目标 0）`,
	);

	// 模型序列化（权重 4 位小数控体积；预算 ≤200KB）
	const r4 = (a) => a.map((v) => +v.toFixed(4));
	const modelJson = {
		version: 1,
		kind: "mlp",
		arch: {
			input: `${SCAN_PIXEL_ARCH.size}x${SCAN_PIXEL_ARCH.size}x3-${SCAN_PIXEL_ARCH.space}`,
			dims: finalModel.dims,
			hidden: finalModel.hidden,
			activation: finalModel.activation,
		},
		classes: finalModel.classes,
		gate: finalModel.gate, // 阈值不取整：临界样本对 1e-3 级舍入敏感
		// 区间水印：本模型训练所对齐的 SCAN_DOT_TYPES；提取工具据此判待重训
		// （与文件当前区间不一致即模型陈旧），替代旧 mtime / 段差异启发式
		dotTypes: globalThis.SCAN_DOT_TYPES || null,
		xMean: r4(finalModel.xMean),
		xStd: r4(finalModel.xStd),
		W1: r4(finalModel.W1),
		b1: r4(finalModel.b1),
		W2: r4(finalModel.W2),
		b2: r4(finalModel.b2),
	};
	const PIXEL_MODEL_SIZE_LIMIT = 200 * 1024;
	const modelJs =
		"// SCAN_PIXEL_MODEL：全量 dot 像素验证器模型（生成物，请勿手改）——由\n" +
		"// node tools/bench/bench.js calib-pixel 生成，训练数据 tools/bench/out/pixel-dump/\n" +
		`// （${samples.length} 格：real ${labelDist.real}/fake ${labelDist.fake}，架构 16²×3 HSV + hidden 32 tanh，\n` +
		`// 种子 20260804）。63 折按图留一：阈值=${gate.vScoreTh.toFixed(4)}（出折真锚点 min vScore\n` +
		`// ${gate.globalMin.toFixed(4)} - 安全余量 ${gate.margin}；折 min p5=${gate.foldMinStats.p5.toFixed(2)} 远高于阈值，\n` +
		`// 抖动证据见报告），杀假=${gate.kills}/${gate.fakeTotal}、真锚点误伤=${gate.harms}/${gate.realTotal}；\n` +
		`// gate.vScoreThByType 为分类型阈值（各类出折真锚点 min - 余量，再按成品模型在样\n` +
		`// 真锚点 min 收紧——在样分可低于出折 min，收紧后杀假=${killedFakesByType.length}/\n` +
		`// ${fakeJudged.length}、误伤=${harmedRealsByType.length}/${realJudged.length}）：全局阈值被最差类型的泛化\n` +
		`// 落差拖低时其余类型不至于漏杀假 dot，类型未覆盖时回退 vScoreTh；\n` +
		"// 校准依据详见 tools/bench/out/calib-pixel-report.json 与 pixel-model-report.md。\n" +
		"// dotTypes 为区间水印（训练所对齐的 SCAN_DOT_TYPES），与文件当前区间\n" +
		"// 不一致即待重训，提取工具据此判定。\n" +
		"// 体积说明：树模型的 MODEL_SIZE_LIMIT=20000 不适用本模型（768×32+32×2≈25K 参数，\n" +
		"// 4 位小数约 195KB）——浏览器侧已加载 13MB opencv，200KB 预算内经实算可接受\n" +
		"// （int8 量化备选 83KB 实测未启用）；量化口径若启用须同步 scanMlpScore 反量化。\n" +
		"// 段级写回 data/scan-fp-refs.js：训练结束确认后整段替换（段头注释随本次运行\n" +
		"// 重生成，人工补充需写回后重加）；--yes 直写 / --no-write 只出产物。\n" +
		"// 用途：规则链判 dot=true 后的验证层（vScore < gate.vScoreTh 直接否决 dot，\n" +
		"// 软守卫：本段缺失时自动跳过验证）。\n" +
		`var SCAN_PIXEL_MODEL = ${JSON.stringify(modelJson)};\n`;
	const modelBytes = Buffer.byteLength(modelJs);
	if (modelBytes > PIXEL_MODEL_SIZE_LIMIT) {
		// 实算超预算：应改 int8 量化（备选实测 83KB，反量化口径须同步 scanMlpScore）
		console.error(`模型 ${modelBytes}B 超 200KB 预算，请改用 int8 量化路径`);
		process.exit(1);
	}
	const modelPath = path.join(OUT_DIR, "scan-pixel-model.js");
	fs.writeFileSync(modelPath, modelJs);

	const report = {
		generated: new Date().toISOString(),
		说明: "T2 像素验证器（直接否决式）：样本=规则链 dot=true 格，real=truth锚点(含雷)/fake=假dot；vScore=log p(real)-log p(fake)，杀假 iff vScore<阈值",
		data: { indexCells: index.length, trainSamples: samples.length, labelDist, grayAnchorsOutOfScope: grayAnchors.length },
		arch: { ...SCAN_PIXEL_ARCH, epochs: trainOpts.epochs, seed: trainOpts.seed },
		cv: { folds: loo.folds, method: "按图留一", trainMs: looMs },
		gate: {
			vScoreTh: gate.vScoreTh,
			vScoreThByType: finalModel.gate.vScoreThByType, // 在样收紧后的生效值
			vScoreThByTypeOof: gate.vScoreThByType, // 出折 min - margin（收紧前）
			typeMin: gate.typeMin,
			realMinByType, // 成品模型在样真锚点分类型 min（收紧依据）
			globalMinRealVScore: gate.globalMin,
			margin: gate.margin,
			margin依据: "固定 0.5：阈值起点已是 63 折最差出折分（极值含泛化落差），折 min 的 p5 远高于阈值即有天然缓冲；不取折 min std（右偏分布被强锚点折抬高，实测会过度保守压杀假）",
			foldMinStats: gate.foldMinStats,
			marginTrace: gate.trace,
		},
		loo: {
			kills: gate.kills,
			harms: gate.harms,
			killsByType: gate.killsByType,
			harmsByType: gate.harmsByType,
			fakeTotal: gate.fakeTotal,
			realTotal: gate.realTotal,
			killedCases: gate.killedCases,
			harmedCases: gate.harmedCases,
			killedCasesByType: gate.killedCasesByType,
			harmedCasesByType: gate.harmedCasesByType,
		},
		finalInSample: {
			note: "全量重训模型 + 留一阈值，作用域（dot=true）内判定；灰区锚点仅观测",
			killedFakes,
			survivingFakes: fakeJudged.filter((j) => !j.killed),
			harmedReals,
			killedFakesByType, // 分类型阈值（在样收紧后）判定
			harmedRealsByType,
			realTotal: realJudged.length,
			fakeTotal: fakeJudged.length,
			grayAnchorKilled: grayJudged.filter((j) => j.killed),
			grayAnchorTotal: grayJudged.length,
		},
		stage0对照: {
			loo杀假: "阶段 0 零误伤阈值 11/21（无余量）；本报告阈值含余量，允许 ±1 抖动",
			余量敏感性: gate.trace,
		},
		modelSizeBytes: modelBytes,
		modelSizeLimit: PIXEL_MODEL_SIZE_LIMIT,
		modelPath,
		totalMs: Date.now() - t0,
	};
	const reportPath = path.join(OUT_DIR, "calib-pixel-report.json");
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));

	console.log("\n========== 余量敏感性（出折，阈值=globalMin-余量） ==========");
	gate.trace.forEach((t) => console.log(`  余量 ${t.margin}：阈值 ${t.th} 杀假 ${t.kills}/${gate.fakeTotal} 误伤 ${t.harms}/${gate.realTotal}`));
	if (killedFakes.length) {
		console.log("\n========== 全量模型杀掉的假 dot ==========");
		killedFakes.forEach((j) => console.log(`  ${j.file} (${j.r},${j.c}) ${j.role} dotType=${j.dotType} vScore=${j.vScore}`));
	}
	if (harmedReals.length) {
		console.log("\n========== !! 被误伤的真锚点（目标 0） ==========");
		harmedReals.forEach((j) => console.log(`  ${j.file} (${j.r},${j.c}) ${j.role} vScore=${j.vScore}`));
	}
	console.log(`\n模型 ${modelBytes}B → ${modelPath}`);
	console.log(`报告 → ${reportPath}`);
	if (harmedRealsByType.length) {
		// 在样收紧按构造应零误伤；出现即阈值实现有 bug，禁止带伤写回
		console.error(`!! 分类型阈值在样误伤 ${harmedRealsByType.length} 个真锚点（应恒 0），中止写回`);
		harmedRealsByType.forEach((j) => console.error(`  ${j.file} (${j.r},${j.c}) ${j.role} vScore=${j.vScore}`));
		process.exit(1);
	}

	// 写回决策摘要 + 确认（--yes 直写 / --no-write 跳过；非 TTY 默认跳过）
	await writeRefsSectionInteractive({
		refsPath: path.join(ROOT, "data", "scan-fp-refs.js"),
		varName: "SCAN_PIXEL_MODEL",
		startMarker: "// SCAN_PIXEL_MODEL：",
		varMarker: "var SCAN_PIXEL_MODEL = ",
		endMarker: "\n",
		inclusiveEnd: false,
		appendIfMissing: true,
		newBlock: modelJs.trimEnd(),
		summaryLines: [
			`阈值 vScoreTh=${gate.vScoreTh.toFixed(4)}（出折真锚点 min ${gate.globalMin.toFixed(4)} - 余量 ${gate.margin}）`,
			`分类型阈值（在样收紧后）vScoreThByType=${JSON.stringify(Object.fromEntries(Object.entries(finalModel.gate.vScoreThByType).map(([t, v]) => [t, +v.toFixed(2)])))}（在样杀假 ${killedFakesByType.length}/${fakeJudged.length}，误伤 ${harmedRealsByType.length}/${realJudged.length}）`,
			`出折：杀假 ${gate.kills}/${gate.fakeTotal}，真锚点误伤 ${gate.harms}/${gate.realTotal}`,
			`全量 in-sample 参考：杀假 ${killedFakes.length}，误伤 ${harmedReals.length}（目标 0）`,
			`模型体积 ${modelBytes}B`,
		],
	});
}

/** compare */
// 配对 / 判错 / 汇总逻辑在 script/scan-bench.js（scanScoreImage / scanScoreSummary），
// 本函数只做 IO（读 truth 与 run 输出、写 report.json）与控制台打印
function cmdCompare() {
	loadScanCore();

	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();

	const truthIssues = [];
	const nameNotes = [];
	const images = [];
	const results = [];

	files.forEach((file) => {
		const truthPath = path.join(TRUTH_DIR, `${file}.json`);
		let truth;
		try {
			truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
		} catch (e) {
			truthIssues.push(`${file}: truth JSON 解析失败（${e.message}）`);
			return;
		}
		truthIssues.push(...scanValidateTruth(truth, file));

		const outPath = path.join(OUT_DIR, `${file}.json`);
		if (!fs.existsSync(outPath)) {
			truthIssues.push(`${file}: 缺少 run 输出，请先执行 run`);
			return;
		}
		const det = JSON.parse(fs.readFileSync(outPath, "utf8"));

		const result = scanScoreImage(truth, det, file);
		nameNotes.push(...result.nameNotes);
		images.push(result.rec);
		results.push(result);
	});

	const { summary, sum } = scanScoreSummary(results);

	const report = { truthIssues, nameNotes, summary, images };
	fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

	/** 控制台报告 */
	const pct = (v) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);
	console.log("\n========== truth 校验问题 ==========");
	if (truthIssues.length) truthIssues.forEach((s) => console.log(`  !! ${s}`));
	else console.log("  （无）");
	if (nameNotes.length) {
		console.log("\n========== 名称期望推导 notes ==========");
		nameNotes.forEach((s) => console.log(`  ?? ${s}`));
	}

	console.log("\n========== 每图指标 ==========");
	const head = [
		"文件",
		"定位",
		"配对/真实",
		"识别",
		"格召回",
		"type",
		"quality",
		"name判定",
		"name歧义",
	];
	console.log(head.join("\t"));
	images.forEach((r) => {
		console.log(
			[
				r.file,
				r.detectOk ? "√" : "×",
				`${r.matched}/${r.truthPieces}`,
				r.detPieces,
				pct(r.cellRecall),
				pct(r.typeAcc),
				pct(r.qualAcc),
				pct(r.nameJudAcc),
				pct(r.nameAmbAcc),
			].join("\t"),
		);
	});

	console.log("\n========== 汇总 ==========");
	console.log(`  棋盘定位成功：${summary.detectOk}/${summary.images}`);
	console.log(
		`  格子召回率：${pct(summary.cellRecall)}（${sum.coveredCells}/${sum.truthCells}）`,
	);
	console.log(
		`  棋子配对率：${pct(summary.pieceMatch)}（${summary.matchedPieces}/${summary.truthPieces}），识别总件数 ${summary.detPieces}`,
	);
	console.log(
		`  配对棋子 type 正确率：${pct(summary.typeAcc)}（${sum.typeOk}/${sum.matched}）`,
	);
	console.log(
		`  配对棋子 quality 正确率：${pct(summary.qualAcc)}（${sum.qualOk}/${sum.matched}）`,
	);
	console.log(
		`  配对棋子 name 正确率（可判定）：${pct(summary.nameJudAcc)}（${sum.nameJudOk}/${sum.nameJud}）`,
	);
	console.log(
		`  配对棋子 name 正确率（歧义组）：${pct(summary.nameAmbAcc)}（${sum.nameAmbOk}/${sum.nameAmb}）`,
	);

	console.log("\n========== 失败明细 ==========");
	images.forEach((r) => {
		if (
			!r.missed.length &&
			!r.falsePos.length &&
			!r.wrongType.length &&
			!r.wrongQual.length &&
			!r.wrongName.length
		) {
			return;
		}
		console.log(`\n  [${r.file}]`);
		r.missed.forEach((p) =>
			console.log(`    漏检 ${p.type} q${p.quality} ${JSON.stringify(p.cells)}`),
		);
		r.falsePos.forEach((p) =>
			console.log(
				`    误检 ${p.type || "?"} q${p.quality} 「${p.name || ""}」 ${JSON.stringify(p.cells)}`,
			),
		);
		r.wrongType.forEach((s) => console.log(`    type 错：${s}`));
		r.wrongQual.forEach((s) => console.log(`    quality 错：${s}`));
		r.wrongName.forEach((s) => console.log(`    name 错：${s}`));
	});
	console.log(`\n报告已写入 ${REPORT_PATH}`);
}

/** 入口（纯 CLI 入口，不作为库被 require；共享基建在 lib/core.js） */
const cmd = process.argv[2];
if (cmd === "run") {
	cmdRun().catch((e) => {
		console.error("run 失败：", e);
		process.exit(1);
	});
} else if (cmd === "compare") {
	cmdCompare();
} else if (cmd === "calib-dots") {
	cmdCalibDots().catch((e) => {
		console.error("calib-dots 失败：", e);
		process.exit(1);
	});
} else if (cmd === "calib-types") {
	cmdCalibTypes().catch((e) => {
		console.error("calib-types 失败：", e);
		process.exit(1);
	});
} else if (cmd === "calib-pixel") {
	cmdCalibPixel().catch((e) => {
		console.error("calib-pixel 失败：", e);
		process.exit(1);
	});
} else {
	console.log("用法：node tools/bench/bench.js run | compare | calib-dots [--skip-marginal] [--yes|--no-write] | calib-types [fpBudget=5] [--yes|--no-write] | calib-pixel [--yes|--no-write]（run/calib-dots 按图并行，calib-types/calib-pixel 折并行，BENCH_JOBS 覆盖并发数；calib-dots/calib-types/calib-pixel 经交叠硬校验/训练确认后段级写回 data/scan-fp-refs.js，非 TTY 默认只出产物）");
	process.exit(1);
}
