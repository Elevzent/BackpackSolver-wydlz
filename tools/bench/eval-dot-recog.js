/**
 * scanCellFeat dot 判定全库 A/B 评估（识别端改动回归用）：
 * 对 tools/bench/out/pixel-dump 全部格跑 scanCellFeat（含模型，与生产同口径）：
 *   node tools/bench/eval-dot-recog.js --save out/recog-dump-base.json   # 存基线
 *   node tools/bench/eval-dot-recog.js --diff out/recog-dump-base.json   # 对比
 * --diff 时按 role 分类报告变化方向：
 *   anchor:X —— dot true→false 或 dotType 偏离 X 为回退；反之为改善
 *   cell:X / empty —— dot false→true 为新增误检；true→false 为改善
 * 先决：node tools/bench/dump-pixels.js（生成 pixel-dump）
 */
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { loadScanCore } = require("./lib/core.js");

const DUMP_DIR = path.join(__dirname, "out", "pixel-dump");

function runAll() {
	loadScanCore();
	const index = JSON.parse(
		fs.readFileSync(path.join(DUMP_DIR, "index.json"), "utf8"),
	);
	const t0 = Date.now();
	const rows = index.map((cell) => {
		const png = PNG.sync.read(fs.readFileSync(path.join(DUMP_DIR, cell.patch)));
		const feat = globalThis.scanCellFeat(png.data);
		return {
			file: cell.file,
			r: cell.r,
			c: cell.c,
			role: cell.role,
			dot: feat.dot,
			dotType: feat.dotType,
		};
	});
	console.error(
		`scanCellFeat 全库 ${rows.length} 格（${((Date.now() - t0) / 1000).toFixed(0)}s）`,
	);
	return rows;
}

/** 单格口径：truth dot / dotType（anchor:X → true/X；cell:X、empty → false/null） */
function truthOf(role) {
	const m = role.match(/^anchor:(.+)$/);
	return m ? { dot: true, dotType: m[1] } : { dot: false, dotType: null };
}

function summarize(rows, tag) {
	const anchors = rows.filter((x) => x.role.startsWith("anchor:"));
	const neg = rows.filter((x) => !x.role.startsWith("anchor:"));
	const aHit = anchors.filter((x) => {
		const t = truthOf(x.role);
		return x.dot && x.dotType === t.dotType;
	});
	const nFp = neg.filter((x) => x.dot);
	console.log(
		`${tag}：锚点正确 ${aHit.length}/${anchors.length}（${((100 * aHit.length) / anchors.length).toFixed(1)}%），` +
			`非锚点误检 ${nFp.length}/${neg.length}（${((100 * nFp.length) / neg.length).toFixed(2)}%）`,
	);
	const types = [...new Set(anchors.map((x) => x.role.split(":")[1]))].sort();
	for (const t of types) {
		const a = anchors.filter((x) => x.role === `anchor:${t}`);
		const ok = a.filter((x) => x.dot && x.dotType === t);
		const nn = neg.filter((x) => x.role === `cell:${t}`);
		console.log(
			`  ${t}：锚点 ${ok.length}/${a.length}，占用格误检 ${nn.filter((x) => x.dot).length}/${nn.length}`,
		);
	}
	const empt = neg.filter((x) => x.role === "empty");
	console.log(`  空格误检 ${empt.filter((x) => x.dot).length}/${empt.length}`);
}

function main() {
	const args = process.argv.slice(2);
	const saveAt = args.indexOf("--save");
	const diffAt = args.indexOf("--diff");
	const rows = runAll();
	if (saveAt >= 0) {
		const p = path.resolve(__dirname, args[saveAt + 1]);
		fs.writeFileSync(p, JSON.stringify(rows, null, 1));
		console.log(`已存 ${p}`);
		summarize(rows, "当前");
		return;
	}
	if (diffAt >= 0) {
		const base = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, args[diffAt + 1]), "utf8"),
		);
		const key = (x) => `${x.file}|${x.r}|${x.c}`;
		const bMap = new Map(base.map((x) => [key(x), x]));
		const improved = [];
		const regressed = [];
		const neutral = [];
		for (const cur of rows) {
			const b = bMap.get(key(cur));
			if (!b || (b.dot === cur.dot && b.dotType === cur.dotType)) continue;
			const t = truthOf(cur.role);
			const score = (x) =>
				x.dot && x.dotType === t.dotType ? 2 : x.dot ? (t.dot ? 1 : -1) : t.dot ? 0 : 2;
			// anchor：dot×type 全对=2，dot 对 type 错=1，漏=0；非锚点：不误检=2，误检=-1
			const s = score(cur) - score(b);
			const line = `  ${cur.file} (${cur.r},${cur.c}) ${cur.role}：${b.dot ? b.dotType || "?" : "×"} → ${cur.dot ? cur.dotType || "?" : "×"}`;
			if (s > 0) improved.push(line);
			else if (s < 0) regressed.push(line);
			else neutral.push(line);
		}
		console.log(`变化 ${improved.length + regressed.length + neutral.length} 格`);
		console.log(`改善 ${improved.length}：`);
		improved.forEach((s) => console.log(s));
		console.log(`回退 ${regressed.length}：`);
		regressed.forEach((s) => console.log(s));
		console.log(`平移（对错不变） ${neutral.length}：`);
		neutral.forEach((s) => console.log(s));
		summarize(base, "基线");
		summarize(rows, "当前");
		return;
	}
	summarize(rows, "当前");
}

main();
