/**
 * dump-feats.js / dump-pixels.js 的 worker（由 parallel.js fork，不直接运行）：
 * init 加载识别核心 + OpenCV（每 worker 一份），之后每条任务处理一张图——
 * 棋盘定位 + 全格切格 + scanCellTypeFeats，流程与串行版逐行一致。
 * mode="feats"：返回格特征记录；mode="pixels"：直写 64×64 patch PNG 到
 * out/pixel-dump/<图名>/（每图一个目录，worker 间无写冲突）并返回索引记录。
 * 结果由父进程按图序重组，输出与串行逐字节一致。
 */
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { workerLoop } = require("../lib/parallel.js");
const {
	IMG_DIR,
	TRUTH_DIR,
	OUT_DIR,
	loadScanCore,
	loadCv,
	readPng,
	resizeBilinear,
	sliceCell,
} = require("../lib/core.js");

workerLoop(
	async (init) => {
		loadScanCore();
		const cv = await loadCv();
		return {
			mode: init.mode,
			cv,
			N: globalThis.SCAN_CELL_SIZE,
			DW: globalThis.SCAN_DETECT_WIDTH,
			pixelDir: path.join(OUT_DIR, "pixel-dump"),
		};
	},
	(ctx, task) => {
		const { file } = task;
		const truth = JSON.parse(
			fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
		);
		const { cols, rows, pieces } = truth;
		const png = readPng(path.join(IMG_DIR, file));
		const img = { data: png.data, width: png.width, height: png.height };
		const scale = ctx.DW / img.width;
		const dh = Math.round(img.height * scale);
		const small = resizeBilinear(img.data, img.width, img.height, ctx.DW, dh);
		const rect = globalThis.scanDetectBoard(
			ctx.cv,
			{ data: small, width: ctx.DW, height: dh },
			cols,
			rows,
		);
		if (!rect) return { file, rows, cols, skipped: true, entries: [] };
		const full = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};
		const cw = (full.R - full.L) / cols;
		const ch = (full.B - full.T) / rows;
		// 格 -> truth 角色索引
		const roleOf = {};
		pieces.forEach((p) => {
			p.cells.forEach(([r, c]) => {
				roleOf[`${r},${c}`] =
					p.anchor[0] === r && p.anchor[1] === c
						? `anchor:${p.type}`
						: `cell:${p.type}`;
			});
		});
		if (ctx.mode === "pixels") {
			fs.mkdirSync(path.join(ctx.pixelDir, file), { recursive: true });
		}
		const entries = [];
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const cell = sliceCell(
					img,
					full.L + cw * c,
					full.T + ch * r,
					cw,
					ch,
					ctx.N,
				);
				const res = globalThis.scanCellTypeFeats(cell);
				const role = roleOf[`${r},${c}`] || "empty";
				if (ctx.mode === "pixels") {
					const rel = `${file}/${r}-${c}.png`;
					fs.writeFileSync(
						path.join(ctx.pixelDir, rel),
						PNG.sync.write({ width: ctx.N, height: ctx.N, data: Buffer.from(cell) }),
					);
					entries.push({ file, r, c, role, dot: res.dot, dotType: res.dotType, patch: rel });
				} else {
					entries.push({ file, r, c, role, dot: res.dot, dotType: res.dotType, feats: res.feats });
				}
			}
		}
		return { file, rows, cols, skipped: false, entries };
	},
);
