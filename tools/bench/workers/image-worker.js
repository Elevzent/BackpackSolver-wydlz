/**
 * bench run / calib-dots / refingerprint 的按图 worker（由 parallel.js fork，不直接运行）：
 * init 加载识别核心 + OpenCV（每 worker 一份），之后每条任务处理一张图，
 * 流程与各命令原串行版逐行一致；结果由父进程按图序重组，产物与串行逐字节一致。
 * mode="run"        ：bench run 单图识别，返回 { result（写出 JSON）, msg（控制台行） }，
 *                     图内异常捕获后落入 msg（同串行 catch 口径），文件写出在父进程。
 * mode="calib-dots" ：元素圆点采样，返回 { skipped, bucketHues（分桶增量）, cellScan }，
 *                     父进程按图序合并（合并顺序 = 串行顺序）。
 * mode="refp"       ：指纹采样，init 附 groups（冲突组名录），返回 { detectFail, samples,
 *                     excluded, warnings }；无逐图 try/catch（同串行：异常即整体失败）。
 */
const fs = require("fs");
const path = require("path");
const { workerLoop } = require("../lib/parallel.js");
const {
	IMG_DIR,
	TRUTH_DIR,
	loadScanCore,
	loadCv,
	readPng,
	resizeBilinear,
	sliceCell,
} = require("../lib/core.js");

/* ---- mode=run ---- */
function taskRun(ctx, file) {
	const truth = JSON.parse(
		fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
	);
	const { cols, rows } = truth;
	const result = { file, cols, rows, detectOk: false, pieces: [] };
	let msg;
	try {
		// a. 解码 PNG 并缩放到检测宽度
		const png = readPng(path.join(IMG_DIR, file));
		const img = { data: png.data, width: png.width, height: png.height };
		const scale = ctx.DW / img.width;
		const dh = Math.round(img.height * scale);
		const small = resizeBilinear(img.data, img.width, img.height, ctx.DW, dh);

		// b. 棋盘定位（检测图坐标），成功则换算回原图坐标
		const rect = globalThis.scanDetectBoard(
			ctx.cv,
			{ data: small, width: ctx.DW, height: dh },
			cols,
			rows,
		);
		if (!rect) {
			return { result, msg: `${file}\t定位失败` };
		}
		result.detectOk = true;
		const full = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};

		// c. 切格：按原图坐标均分棋盘，每格重采样为 N×N
		const cw = (full.R - full.L) / cols;
		const ch = (full.B - full.T) / rows;
		const cells = [];
		for (let r = 0; r < rows; r++) {
			const rowArr = [];
			for (let c = 0; c < cols; c++) {
				rowArr.push(sliceCell(img, full.L + cw * c, full.T + ch * r, cw, ch, ctx.N));
			}
			cells.push(rowArr);
		}

		// d. 特征 → 候选 → packing → 命名（全部复用 scan-core.js）
		const feat = cells.map((row) => row.map((d) => globalThis.scanCellFeat(d)));
		const { anchors, candMap } = globalThis.scanGenCandidates(feat, rows, cols);
		const packed = globalThis.scanPack(anchors, candMap, feat, rows, cols);
		packed.assign.forEach((cand) => {
			if (!cand) return;
			const named = globalThis.scanNamePiece(cand, feat);
			result.pieces.push({
				cells: cand.cells,
				anchor: cand.anchor,
				type: named.type || "",
				quality: cand.quality + 1, // 内部 0-4 → 输出 1-5
				name: named.name,
				confidence: Math.max(
					5,
					Math.min(99, Math.round(100 * cand.score * named.nameFactor)),
				),
			});
		});
		msg = `${file}\t定位成功，识别 ${result.pieces.length} 件（锚点 ${anchors.length}）`;
	} catch (e) {
		msg = `${file}\t异常：${e.message}`;
	}
	return { result, msg };
}

/* ---- mode=calib-dots ---- */
function taskCalibDots(ctx, file) {
	const truth = JSON.parse(
		fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
	);
	const { cols, rows, pieces } = truth;
	const out = { file, skipped: null, bucketHues: {}, cellScan: [] };
	try {
		// 与 run 相同：解码 → 缩放 → 棋盘定位 → 换算原图坐标
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
		if (!rect) {
			out.skipped = file;
			return out;
		}
		const full = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};
		const cw = (full.R - full.L) / cols;
		const ch = (full.B - full.T) / rows;
		const anchors = {}; // "r,c" -> type
		const occupied = {}; // "r,c" -> type（含非锚点占用格）
		const anchorOff = {}; // "r,c" -> { off, dotR }（truth 持久化的锚点环心偏移/半径，提取工具确认页写回；无则规范位缺省）
		pieces.forEach((p) => {
			p.cells.forEach(([r, c]) => {
				occupied[r + "," + c] = p.type;
			});
			const akey = p.anchor[0] + "," + p.anchor[1];
			anchors[akey] = p.type;
			if (p.dotOff || p.dotR)
				anchorOff[akey] = { off: p.dotOff || [0, 0], dotR: p.dotR || 0 };
		});
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const key = r + "," + c;
				const truthType = anchors[key] || null;
				const isAnchor = truthType !== null;
				if (ctx.skipMarginal && !isAnchor) continue;
				const cell = sliceCell(img, full.L + cw * c, full.T + ch * r, cw, ch, ctx.N);
				if (isAnchor) {
					// truth dotOff/dotR 透传（与提取工具确认页/批量采样同口径；
					// 无持久化偏移时全 0 = 规范位，scanDiskHues 缺省值）
					// 2026-08-07 Step 4：分桶采样从 16 点环（scanDotHues）切圆盘全像素
					// （scanDiskHues，~100 有效票/格，点级背景剔除口径同判定链 sampleDisk）
					const ao = anchorOff[key];
					const hues = globalThis.scanDiskHues(
						cell,
						ao ? ao.off[0] : 0,
						ao ? ao.off[1] : 0,
						ao ? ao.dotR : 0,
					);
					const b = (out.bucketHues[truthType] = out.bucketHues[truthType] || {
						cells: 0,
						empty: 0,
						hues: [],
					});
					b.cells++;
					if (!hues.length) b.empty++;
					b.hues.push(...hues);
				}
				if (ctx.skipMarginal) continue;
				// 全格判定（与 run 同管线，含像素验证层与灰区模型兜底）
				globalThis.SCAN_DOT_TRACE = [];
				const feat = globalThis.scanCellFeat(cell);
				const trace = globalThis.SCAN_DOT_TRACE;
				delete globalThis.SCAN_DOT_TRACE;
				const failing = isAnchor
					? !feat.dot || feat.dotType !== truthType
					: feat.dot;
				const rec = {
					file,
					r,
					c,
					role: isAnchor
						? `anchor:${truthType}`
						: occupied[key]
							? `cell:${occupied[key]}`
							: "empty",
					dot: feat.dot,
					dotType: feat.dotType,
					qual: feat.qual,
					iconPx: feat.iconPx,
					pixelVeto: feat.pixelVeto,
					failing,
				};
				out.cellScan.push(rec);
				if (!failing) continue;
				// 失败格逐案诊断：规则链单独结果 / hue 明细 / 闸门逐项 /
				// 邻域命中 / 灰区模型打分（只对失败格补算，避免全量重复扫图）
				const tf = globalThis.scanCellTypeFeats(cell); // skipModel 规则链口径
				rec.ruleDot = tf.dot;
				rec.ruleDotType = tf.dotType;
				rec.hues = globalThis.scanDotHues(cell);
				rec.ring = globalThis.scanDotRingRaw(cell);
				rec.gate = globalThis.scanDotGateDetail(cell);
				// trace 契约：origin 条目在 = 进了邻域搜索（slice 偏移命中）；
				// locate 条目 = 几何定位引导记录（scan-core.js scanCellFeat 定位段）
				const locTrace = trace.find((e) => e.locate);
				if (locTrace) rec.locate = locTrace;
				rec.neighborHits = trace.some((e) => e.origin)
					? trace.filter((e) => e.ox !== undefined)
					: null;
				let model = null;
				if (globalThis.SCAN_TYPE_MODEL && globalThis.SCAN_TYPE_MODEL.gate) {
					const sc = globalThis.scanTypeModelScore(
						globalThis.SCAN_TYPE_MODEL,
						tf.feats,
					);
					model = {
						best: sc.best,
						bestScore: +sc.bestScore.toFixed(3),
						margin: +sc.margin.toFixed(3),
						gate: globalThis.SCAN_TYPE_MODEL.gate,
					};
				}
				rec.model = model;
				rec.causes = globalThis.scanDotMarginalCause({
					isAnchor,
					truthType,
					...rec,
				}).causes;
			}
		}
	} catch (e) {
		out.skipped = `${file}（异常：${e.message}）`;
	}
	return out;
}

/* ---- mode=refp ---- */
function taskRefp(ctx, file) {
	const out = { file, detectFail: 0, samples: [], excluded: [], warnings: [] };
	const truth = JSON.parse(
		fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
	);
	const targets = (truth.pieces || []).filter(
		(p) => p.name && ctx.nameToGroup.has(p.name),
	);
	if (!targets.length) return out;
	const { cols, rows } = truth;
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
	if (!rect) {
		out.detectFail = 1;
		out.warnings.push(`${file}：棋盘定位失败，${targets.length} 件目标跳过`);
		return out;
	}
	const full = { L: rect.L / scale, T: rect.T / scale, R: rect.R / scale, B: rect.B / scale };
	const cw = (full.R - full.L) / cols;
	const ch = (full.B - full.T) / rows;
	const cellData = [];
	for (let r = 0; r < rows; r++) {
		const rowArr = [];
		for (let c = 0; c < cols; c++) {
			rowArr.push(sliceCell(img, full.L + cw * c, full.T + ch * r, cw, ch, ctx.N));
		}
		cellData.push(rowArr);
	}
	targets.forEach((p) => {
		const { key } = ctx.nameToGroup.get(p.name);
		const [, shapeKey, cat] = key.split("|");
		const red = p.quality === 5;
		const tag = `${file} ${p.name} q${p.quality}`;
		if (red !== (cat === "red")) {
			out.warnings.push(`${tag}：品质红/普通与目录组 ${key} 不符，跳过`);
			return;
		}
		const matKey = ctx.SHAPES_REV[JSON.stringify(globalThis.scanCellsToMat(p.cells))] || null;
		if (matKey !== shapeKey) {
			out.warnings.push(
				`${tag}：cells 形状 ${matKey || "未知"} 与组形状 ${shapeKey} 不符（旋转标注？），跳过`,
			);
			return;
		}
		const sorted = [...p.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const sig = [];
		const sigLegacy = [];
		sorted.forEach(([r, c]) => {
			const data = cellData[r][c];
			sig.push(...globalThis.scanCellSig(data, globalThis.scanCellBg(data)));
			sigLegacy.push(...globalThis.scanCellSigLegacy(data));
		});
		// 自动预标记（同工具页 gxAddSample 口径，默认剔除）：
		// ① 有效图标块过少；② 锚点格识别类型与标注不符 / 未识别出圆点
		const flags = [];
		const iconBlocks = sig.filter(Boolean).length;
		if (iconBlocks < sorted.length * 4) {
			flags.push(`有效图标块少（${iconBlocks}/${sig.length}）`);
		}
		if (p.anchor) {
			const feat = globalThis.scanCellFeat(cellData[p.anchor[0]][p.anchor[1]]);
			if (!feat.dotType) flags.push("锚点格未识别出元素圆点");
			else if (feat.dotType !== p.type) {
				flags.push(`类型识别不符：识别 ${feat.dotType} / 标注 ${p.type}`);
			}
		}
		const rec = {
			key, name: p.name, quality: p.quality - 1, file,
			sig, sigLegacy, flags,
		};
		if (flags.length) out.excluded.push(rec);
		else out.samples.push(rec);
	});
	return out;
}

/* ---- 注册 ---- */
workerLoop(
	async (init) => {
		loadScanCore();
		const cv = await loadCv();
		const ctx = {
			mode: init.mode,
			cv,
			N: globalThis.SCAN_CELL_SIZE,
			DW: globalThis.SCAN_DETECT_WIDTH,
			skipMarginal: !!init.skipMarginal,
		};
		if (init.mode === "refp") {
			// 冲突组名录（父进程从工具页纯函数取得，经 init 传入）
			ctx.nameToGroup = new Map();
			init.groups.forEach(([key, names]) =>
				names.forEach((n) => ctx.nameToGroup.set(n, { key, names })),
			);
			ctx.SHAPES_REV = {};
			Object.entries(globalThis.SHAPES).forEach(([k, mat]) => {
				ctx.SHAPES_REV[JSON.stringify(mat)] = k;
			});
		}
		return ctx;
	},
	(ctx, task) => {
		if (ctx.mode === "run") return taskRun(ctx, task.file);
		if (ctx.mode === "calib-dots") return taskCalibDots(ctx, task.file);
		if (ctx.mode === "refp") return taskRefp(ctx, task.file);
		throw new Error(`未知 mode：${ctx.mode}`);
	},
);
