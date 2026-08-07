/**
 * 灰区统计分类器训练数据转储（阶段一）：遍历 truth 有对应图片的全部图 × 全格子，
 * 棋盘定位+切格流程与 bench.js run 一致；每格调 scanCellTypeFeats 取灰区特征向量，
 * 同时记录快路径 dot/dotType（训练只取 dot=false 格）与 truth 推出的 role
 * （anchor:类型 / cell:类型 / empty）。输出 tools/bench/out/feat-dump.json。
 * 按图并行（dump-worker.js fork 池），结果按图序重组与串行逐字节一致；
 * 并发数默认 os.cpus()-2，BENCH_JOBS 覆盖（=1 退化为串行）。
 * 用法：node tools/bench/dump-feats.js
 */
const fs = require("fs");
const path = require("path");
const { resolveJobs, runPool } = require("./lib/parallel.js");
const { ProgressBar } = require("./lib/progress.js");
const { IMG_DIR, TRUTH_DIR } = require("./lib/core.js");

async function main() {
	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.filter((f) => fs.existsSync(path.join(IMG_DIR, f)))
		.sort();
	const jobs = resolveJobs(2048); // 每 worker 一个 opencv wasm 实例，按 2GB/个压内存上限
	console.log(`并行转储：${files.length} 图 / ${jobs} 并发（BENCH_JOBS 覆盖）`);
	const t0 = Date.now();
	const bar = new ProgressBar({ total: files.length, label: "dump-feats" });
	const results = await runPool(
		path.join(__dirname, "workers", "dump-worker.js"),
		files.map((file) => ({ file })),
		{
			jobs,
			init: { mode: "feats" },
			onTaskDone: (i, r) =>
				bar.tick(`${r.file} ${r.rows}×${r.cols}${r.skipped ? "（定位失败，跳过）" : ""}`),
		},
	);
	bar.done();
	// 按图序重组（格序 = 文件序 × 行主序，与串行一致）
	const out = [];
	const skipped = [];
	results.forEach((r) => {
		if (r.skipped) skipped.push(r.file);
		else out.push(...r.entries);
	});
	const outPath = path.join(__dirname, "out", "feat-dump.json");
	fs.writeFileSync(outPath, JSON.stringify(out));
	const roles = {};
	out.forEach((s) => {
		roles[s.role] = (roles[s.role] || 0) + 1;
	});
	console.log(`\n${out.length} 格写入 ${outPath}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
	console.log(`role 分布：${JSON.stringify(roles)}`);
	console.log(`灰区格（dot=false）：${out.filter((s) => !s.dot).length}`);
	if (skipped.length) console.log(`跳过（定位失败）：${skipped.join("、")}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
