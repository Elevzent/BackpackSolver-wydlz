/**
 * scanLocateDot（script/scan-core.js，边缘域同心双圆定位）全库评估：
 * 对 tools/bench/out/pixel-dump 全部格跑 scanLocateDot，按 role 统计——
 * anchor:* 格应 ok，cell:类型 / empty 格应 !ok；同时报告锚点格 fromLocate 率
 * （定位圆心显著偏离规范位、确认页会覆盖 dotOff 的比例）。
 * 原型对照组：tools/dotproto/harness.js（同算法独立实现，两处数字应一致）。
 * 用法：node tools/bench/eval-dot-locate.js（先决：node tools/bench/dump-pixels.js）
 */
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { loadScanCore } = require("./lib/core.js");

const DUMP_DIR = path.join(__dirname, "out", "pixel-dump");

function main() {
	loadScanCore();
	const N = globalThis.SCAN_CELL_SIZE;
	const index = JSON.parse(
		fs.readFileSync(path.join(DUMP_DIR, "index.json"), "utf8"),
	);
	const t0 = Date.now();
	const rows = [];
	for (const cell of index) {
		const png = PNG.sync.read(fs.readFileSync(path.join(DUMP_DIR, cell.patch)));
		const loc = globalThis.scanLocateDot(png.data);
		rows.push({
			role: cell.role,
			ok: loc.ok,
			fromLocate: loc.fromLocate,
			rEdge: loc.rEdge,
		});
	}
	const anchors = rows.filter((x) => x.role.startsWith("anchor:"));
	const neg = rows.filter((x) => !x.role.startsWith("anchor:"));
	const aOk = anchors.filter((x) => x.ok);
	const nOk = neg.filter((x) => x.ok);
	console.log(
		`scanLocateDot 全库 ${rows.length} 格（${((Date.now() - t0) / 1000).toFixed(0)}s）`,
	);
	console.log(
		`锚点格 ${anchors.length}：ok ${aOk.length}（${((100 * aOk.length) / anchors.length).toFixed(1)}%），` +
			`fromLocate ${anchors.filter((x) => x.fromLocate).length}`,
	);
	console.log(
		`非锚点格 ${neg.length}：误 ok ${nOk.length}（${((100 * nOk.length) / neg.length).toFixed(1)}%）`,
	);
	const types = [...new Set(rows.map((x) => x.role.split(":")[1] || x.role))].sort();
	for (const t of types) {
		const a = anchors.filter((x) => x.role === `anchor:${t}`);
		if (!a.length) continue;
		const nn = neg.filter((x) => x.role === `cell:${t}`);
		console.log(
			`  ${t}：锚点 ${a.filter((x) => x.ok).length}/${a.length}，` +
				`占用格误检 ${nn.filter((x) => x.ok).length}/${nn.length}`,
		);
	}
	const empt = neg.filter((x) => x.role === "empty");
	console.log(
		`  空格误检 ${empt.filter((x) => x.ok).length}/${empt.length}`,
	);
	// 漏检 / 误检清单（便于逐格复查）
	const idx2 = index;
	const fn = [];
	const fp = [];
	rows.forEach((x, i) => {
		const e = idx2[i];
		if (x.role.startsWith("anchor:") && !x.ok)
			fn.push(`${e.file} ${e.r}-${e.c} ${e.role}`);
		else if (!x.role.startsWith("anchor:") && x.ok)
			fp.push(`${e.file} ${e.r}-${e.c} ${e.role}`);
	});
	console.log(`\n漏检锚点 ${fn.length}：`);
	fn.forEach((s) => console.log(`  ${s}`));
	console.log(`误检非锚点 ${fp.length}：`);
	fp.forEach((s) => console.log(`  ${s}`));
}

main();
