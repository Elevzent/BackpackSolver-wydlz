/**
 * 像素转储（像素级小模型计划 阶段 0）：遍历 truth 有对应图片的全部图 × 全格子，
 * 棋盘定位+切格流程与 dump-feats.js 一致；每格 64×64 RGBA patch 存
 * tools/bench/out/pixel-dump/<图名>/<r>-<c>.png，索引写 out/pixel-dump/index.json
 * （file/r/c/role/dot/dotType；role 从 truth 直推，dot/dotType 取
 * scanCellTypeFeats 规则链判定，口径均与 dump-feats.js 一致）。
 * 按图并行（dump-worker.js fork 池，patch 由各 worker 直写各自图目录），索引按
 * 图序重组与串行逐字节一致；并发数默认 os.cpus()-2，BENCH_JOBS 覆盖。
 * 用法：node tools/bench/dump-pixels.js
 */
const fs = require("fs");
const path = require("path");
const { resolveJobs, runPool } = require("./lib/parallel.js");
const { ProgressBar } = require("./lib/progress.js");
const { IMG_DIR, TRUTH_DIR } = require("./lib/core.js");

const OUT_DIR = path.join(__dirname, "out", "pixel-dump");

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
	const bar = new ProgressBar({ total: files.length, label: "dump-pixels" });
	const results = await runPool(
		path.join(__dirname, "workers", "dump-worker.js"),
		files.map((file) => ({ file })),
		{
			jobs,
			init: { mode: "pixels" },
			onTaskDone: (i, r) =>
				bar.tick(`${r.file} ${r.rows}×${r.cols}${r.skipped ? "（定位失败，跳过）" : ""}`),
		},
	);
	bar.done();
	// 按图序重组（格序 = 文件序 × 行主序，与串行一致）
	const index = [];
	const skipped = [];
	results.forEach((r) => {
		if (r.skipped) skipped.push(r.file);
		else index.push(...r.entries);
	});
	fs.writeFileSync(
		path.join(OUT_DIR, "index.json"),
		JSON.stringify(index),
	);
	const roles = {};
	index.forEach((s) => {
		roles[s.role] = (roles[s.role] || 0) + 1;
	});
	console.log(`\n${index.length} 格写入 ${OUT_DIR}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
	console.log(`role 分布：${JSON.stringify(roles)}`);
	console.log(`dot=true 格：${index.filter((s) => s.dot).length}`);
	if (skipped.length) console.log(`跳过（定位失败）：${skipped.join("、")}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
