"use strict";
/**
 * 批量流程 Web Worker 业务脚本：由 fp-pool.js 的 Blob bootstrap 以 importScripts
 * 最后载入（依赖已平铺在前：data/shapes.data.js、data/blocks.data.js、
 * data/scan-fp-refs.js、scan-core.js、scan-bench.js、lib/opencv.js）。本脚本自身
 * 不得再 importScripts——相对路径会解析到 blob: base 而失败。
 *
 * 协议：主 -> worker：{ id, op, payload }（payload.file 为 File，worker 内自行
 * createImageBitmap 解码，主线程零解码）；worker -> 主：{ type: "ready" } 就绪握手、
 * { type: "bootError", message }（初始化失败，池据此回退串行）、{ id, ok, result/error }
 * （result 内像素缓冲走 transfer；定位失败不算错误，按 result.detectOk=false 返回，
 * 与串行语义一致）。
 *
 * op：
 *   replay    —— 回放验证单图：定位 + 切格 + 整盘识别（与 main.fp.js replayRecognize
 *                同管线），棋子缩略图按 scanPieceThumb 包围盒口径拼像素，transfer 回主线程；
 *   locate    —— 棋盘定位（元素校准素材确认阶段并行用）回 full 棋盘框；payload.anchors
 *                存在时顺带逐锚点格 scanLocateDot（免主线程逐格定位卡顿），locs 与
 *                anchors 下标对齐（主线程只送 truth 未存 dotOff 的锚点）；
 *   dotSample —— 元素校准单图：定位 + 切格，truth 锚点格 scanDiskHues（圆盘全像素采样；
 *                _drop / 无类型锚点跳过，dotOff 圆心偏移透传）；
 *   gxSample  —— 组级提取单图：定位 + 切格，组内法宝占用格 sig / sigLegacy / 自动预标记
 *                （与 gxAddSample 同口径），占用格像素 transfer 回主线程拼样本卡片缩略图。
 *
 * 像素路径与浏览器串行 / node bench 逐字节一致：检测图与切格均 1:1 取像素后走
 * scan-core.js scanResampleBilinear（同 tools/bench/bench.js run 的拼法）。
 */

const N = SCAN_CELL_SIZE;

/** OpenCV：emscripten UMD 在 bootstrap 里随 importScripts 载入（self.window=self 已前置） */
let cv = null;
const cvReady = Promise.resolve(self.cv)
	.then((v) => {
		cv = v;
		if (!cv || !cv.Mat) throw new Error("OpenCV 初始化失败");
		self.postMessage({ type: "ready" });
	})
	.catch((e) => {
		self.postMessage({
			type: "bootError",
			message: String((e && e.message) || e),
		});
	});

/** File 解码 1:1 取像素（OffscreenCanvas，等价浏览器端 scanImagePixels）。
 *  colorSpaceConversion:"none" 禁用 ICC 色彩管理（2026-08-11）：Display P3 截图
 *  默认会被浏览器转成 sRGB，饱和色 hue 系统性偏移（实测 P3 JPEG 的水11 品质票
 *  红→金翻转、锚点丢失，错拆 8 件）；node bench（pngjs/sips）一直吃原值，
 *  全部阈值/模型都校准在原值口径上，浏览器必须对齐。不支持的浏览器忽略该
 *  选项，退回旧行为（无回归） */
async function fpwDecode(file) {
	const bmp = await createImageBitmap(file, { colorSpaceConversion: "none" });
	try {
		const cvs = new OffscreenCanvas(bmp.width, bmp.height);
		const ctx = cvs.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(bmp, 0, 0);
		return ctx.getImageData(0, 0, cvs.width, cvs.height);
	} finally {
		if (bmp.close) bmp.close();
	}
}

/** 检测图：同 scanMakeDetectImage（scanResampleBilinear 共享实现） */
function fpwMakeDetectImage(src) {
	const scale = SCAN_DETECT_WIDTH / src.width;
	const dw = SCAN_DETECT_WIDTH;
	const dh = Math.round(src.height * scale);
	const data = scanResampleBilinear(
		src.data,
		src.width,
		src.height,
		0,
		0,
		src.width,
		src.height,
		dw,
		dh,
	);
	return { imgData: { data, width: dw, height: dh }, scale };
}

/** 切格：同 scanSliceCells 的重采样口径（棋盘区域均分后逐格 scanResampleBilinear 为 N×N） */
function fpwSliceCells(src, rect, rows, cols) {
	const cw = (rect.R - rect.L) / cols;
	const ch = (rect.B - rect.T) / rows;
	const cells = [];
	for (let r = 0; r < rows; r++) {
		const rowArr = [];
		for (let c = 0; c < cols; c++) {
			rowArr.push(
				scanResampleBilinear(
					src.data,
					src.width,
					src.height,
					rect.L + cw * c,
					rect.T + ch * r,
					cw,
					ch,
					N,
					N,
				),
			);
		}
		cells.push(rowArr);
	}
	return cells;
}

/** 解码 + 定位：返回 { src, full }（full 为原图坐标棋盘区域），定位失败返回 null */
async function fpwLocate(file, cols, rows) {
	const src = await fpwDecode(file);
	const { imgData, scale } = fpwMakeDetectImage(src);
	const rect = scanDetectBoard(cv, imgData, cols, rows);
	if (!rect) return null;
	return {
		src,
		full: {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		},
	};
}

/** N×N 格图像素按偏移写入包围盒缓冲（等价 drawImage / putImageData 的 1:1 拷贝） */
function fpwBlitCell(dst, dstW, src, dx, dy) {
	for (let y = 0; y < N; y++) {
		dst.set(src.subarray(y * N * 4, (y + 1) * N * 4), ((dy + y) * dstW + dx) * 4);
	}
}

/** op=replay：单图完整识别（同 replayRecognize 管线），缩略图像素随结果 transfer */
async function fpwReplay(p) {
	const loc = await fpwLocate(p.file, p.cols, p.rows);
	if (!loc) return { result: { detectOk: false } };
	const cells = fpwSliceCells(loc.src, loc.full, p.rows, p.cols);
	const feat = cells.map((row) => row.map((d) => scanCellFeat(d, p.dotTypes)));
	const { anchors, candMap } = scanGenCandidates(feat, p.rows, p.cols);
	const packed = scanPack(anchors, candMap, feat, p.rows, p.cols);
	const pieces = [];
	const transfer = [];
	packed.assign.forEach((cand) => {
		if (!cand) return;
		const named = scanNamePiece(cand, feat, p.fpRefs);
		// 缩略图：按形状包围盒拼接占用格（同 scanPieceThumb 口径）
		const w = cand.shape.mat[0].length * N;
		const h = cand.shape.mat.length * N;
		const buf = new Uint8ClampedArray(w * h * 4);
		cand.cells.forEach(([r, c]) => {
			fpwBlitCell(buf, w, cells[r][c], (c - cand.origin[1]) * N, (r - cand.origin[0]) * N);
		});
		transfer.push(buf.buffer);
		pieces.push({
			...named,
			quality: cand.quality,
			shape: cand.shape.key,
			shapeMat: cand.shape.mat,
			cells: cand.cells,
			anchor: cand.anchor,
			origin: cand.origin,
			thumbW: w,
			thumbH: h,
			thumbBuf: buf.buffer,
		});
	});
	return { result: { detectOk: true, full: loc.full, pieces }, transfer };
}

/** op=locate：单图棋盘定位（元素校准素材确认并行用），回 full 棋盘框；
 *  payload.anchors 存在时顺带逐锚点格 scanLocateDot（locs 与 anchors 下标对齐） */
async function fpwLocateOnly(p) {
	const loc = await fpwLocate(p.file, p.cols, p.rows);
	if (!loc) return { result: { detectOk: false } };
	const out = { detectOk: true, full: loc.full };
	if (p.anchors && p.anchors.length) {
		const cells = fpwSliceCells(loc.src, loc.full, p.rows, p.cols);
		out.locs = p.anchors.map(([r, c]) => scanLocateDot(cells[r][c]));
	}
	return { result: out };
}

/** op=dotSample：单图按 truth 锚点格 scanDiskHues（同 dcRunBatch 循环体；
 *  2026-08-07 Step 4 起分桶采样从 16 点环切圆盘全像素，~100 有效票/格）。
 *  tp._drop（确认页舍弃此格）/ 无类型的锚点跳过；tp.dotOff / tp.dotR 为锚点圆盘
 *  中心偏移与半径（truth 持久化值 / 确认页预置 / 手动拖环，采样后写回 truth），原样透传 */
async function fpwDotSample(p) {
	const t = p.truth;
	const loc = await fpwLocate(p.file, t.cols, t.rows);
	if (!loc) return { result: { detectOk: false } };
	const cells = fpwSliceCells(loc.src, loc.full, t.rows, t.cols);
	const samples = [];
	(t.pieces || []).forEach((tp) => {
		if (tp._drop || !tp.type) return;
		const [r, c] = tp.anchor;
		const off = tp.dotOff || [0, 0];
		samples.push({
			type: tp.type,
			hues: scanDiskHues(cells[r][c], off[0], off[1], tp.dotR || 0),
		});
	});
	return { result: { detectOk: true, samples } };
}

/** op=gxSample：单图组内法宝占用格采样（同 gxRunBatch + gxAddSample 的 sig / 自动预标记口径），
 *  占用格像素 transfer 回主线程拼缩略图 */
async function fpwGxSample(p) {
	const t = p.truth;
	const loc = await fpwLocate(p.file, t.cols, t.rows);
	if (!loc) return { result: { detectOk: false } };
	const cells = fpwSliceCells(loc.src, loc.full, t.rows, t.cols);
	const pieces = [];
	const transfer = [];
	(t.pieces || []).forEach((tp) => {
		if (!tp.name || !p.names.includes(tp.name)) return;
		const sorted = [...tp.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		// 逐格签名（行优先，与 gxAddSample / extractFingerprint 同口径）
		const sig = [];
		const sigLegacy = [];
		const cellPix = [];
		sorted.forEach(([r, c]) => {
			const data = cells[r][c];
			sig.push(...scanCellSig(data, scanCellBg(data)));
			sigLegacy.push(...scanCellSigLegacy(data));
			cellPix.push(data);
		});
		// 自动预标记（同 gxAddSample 口径）
		const flags = [];
		const iconBlocks = sig.filter(Boolean).length;
		if (iconBlocks < sorted.length * 4)
			flags.push(`有效图标块少（${iconBlocks}/${sig.length}）`);
		if (tp.anchor && tp.type) {
			const feat = scanCellFeat(cells[tp.anchor[0]][tp.anchor[1]], p.dotTypes);
			if (!feat.dotType) flags.push("锚点格未识别出元素圆点");
			else if (feat.dotType !== tp.type)
				flags.push(`类型识别不符：识别 ${feat.dotType} / 标注 ${tp.type}`);
		}
		cellPix.forEach((d) => transfer.push(d.buffer));
		pieces.push({
			name: tp.name,
			quality: tp.quality - 1, // truth 1-5 -> 内部 0-4
			cells: sorted,
			sig,
			sigLegacy,
			flags,
			cellPix: cellPix.map((d) => d.buffer),
		});
	});
	return { result: { detectOk: true, pieces }, transfer };
}

const FPW_OPS = {
	replay: fpwReplay,
	locate: fpwLocateOnly,
	dotSample: fpwDotSample,
	gxSample: fpwGxSample,
};

self.onmessage = async (e) => {
	const { id, op, payload } = e.data || {};
	const fn = FPW_OPS[op];
	if (!fn) {
		self.postMessage({ id, ok: false, error: `未知 op：${op}` });
		return;
	}
	try {
		await cvReady; // OpenCV 就绪前不处理任务（握手失败时池已回收本 worker）
		const { result, transfer } = await fn(payload);
		self.postMessage({ id, ok: true, result }, transfer || []);
	} catch (err) {
		self.postMessage({
			id,
			ok: false,
			error: String((err && err.message) || err),
		});
	}
};
