/**
 * bench 共享基建（bench.js / workers/* / 各评估转储工具共用）：
 * - 路径常量：ROOT（仓库根）/ IMG_DIR / TRUTH_DIR / OUT_DIR（产物目录 tools/bench/out）
 * - loadScanCore：加载识别核心（data/*.js + script/scan-core.js + scan-bench.js）
 * - loadCv：加载 OpenCV（emscripten UMD）
 * - readPng / resizeBilinear / sliceCell：PNG 解码与重采样包装
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { PNG } = require("pngjs");

const ROOT = path.resolve(__dirname, "../../..");
const IMG_DIR = path.join(ROOT, "test_images");
const TRUTH_DIR = path.join(IMG_DIR, "truth");
const OUT_DIR = path.join(__dirname, "..", "out");

/** 公共：加载识别核心 */
// data/*.js 与 scan-core.js 全部为 var / function 全局声明，
// vm.runInThisContext 在当前全局上下文执行（等同浏览器 <script src>，
// 声明挂到 globalThis；window 也指向它，模拟浏览器全局）：
// 不用 eval——避免作用域安全隐患，且堆栈带真实文件名
function loadScanCore() {
	globalThis.window = globalThis;
	[
		"data/shapes.data.js",
		"data/blocks.data.js",
		"data/scan-fp-refs.js",
		"script/scan-core.js",
		"script/scan-bench.js",
	].forEach((rel) => {
		const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
		vm.runInThisContext(code, { filename: rel });
	});
	if (!globalThis.SHAPES || !globalThis.BLOCKS) {
		throw new Error("SHAPES / BLOCKS 数据加载失败");
	}
}

/** OpenCV：emscripten UMD 构建，require 后直接可用（含 Promise 形态，统一 await） */
async function loadCv() {
	const cv = await Promise.resolve(
		require(path.join(ROOT, "lib/opencv.js")),
	);
	if (!cv || !cv.Mat) throw new Error("OpenCV 初始化失败");
	return cv;
}

/** 公共：像素工具 */
/**
 * PNG 解码：部分截图 IEND 之后带尾部脏数据，pngjs 严格模式会报
 *  "unrecognised content at end of stream"，先截到 IEND 块末尾再解析；
 * 另有两张 .PNG 实为 JPEG（魔数 FFD8），用 macOS 自带 sips 转成临时 PNG 再解码
 * （临时文件名带 pid：dump-* 并行 worker 并发转换时互不覆盖）
 */
function readPng(filePath) {
	let buf = fs.readFileSync(filePath);
	if (buf[0] === 0xff && buf[1] === 0xd8) {
		const tmp = path.join(OUT_DIR, `.tmp-jpeg-convert-${process.pid}.png`);
		fs.mkdirSync(OUT_DIR, { recursive: true });
		require("child_process").execSync(
			`sips -s format png ${JSON.stringify(filePath)} --out ${JSON.stringify(tmp)}`,
			{ stdio: "pipe" },
		);
		buf = fs.readFileSync(tmp);
		fs.unlinkSync(tmp);
		return PNG.sync.read(buf);
	}
	const iend = buf.indexOf(
		Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
	);
	if (iend >= 0 && iend + 8 < buf.length) buf = buf.subarray(0, iend + 8);
	return PNG.sync.read(buf);
}


/** 双线性缩放 RGBA：转发到 scan-core.js 的共享实现（全图缩放是其子区域特例） */
function resizeBilinear(src, sw, sh, dw, dh) {
	return globalThis.scanResampleBilinear(src, sw, sh, 0, 0, sw, sh, dw, dh);
}

/** 切格重采样：转发到 scan-core.js 的共享实现（供 debug-* / trace-* 复用） */
function sliceCell(img, sx, sy, cw, ch, N) {
	return globalThis.scanResampleBilinear(
		img.data,
		img.width,
		img.height,
		sx,
		sy,
		cw,
		ch,
		N,
		N,
	);
}

module.exports = {
	ROOT,
	IMG_DIR,
	TRUTH_DIR,
	OUT_DIR,
	loadScanCore,
	loadCv,
	readPng,
	resizeBilinear,
	sliceCell,
};
