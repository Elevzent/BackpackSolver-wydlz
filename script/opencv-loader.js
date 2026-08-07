/**
 * OpenCV.js 懒加载器：优先本地 lib/opencv.js，失败按序尝试 CDN；失败时 reject，
 * 调用方降级为手动框选。index.html 与 tools/法宝图标指纹提取工具.html 共用，
 * 本地路径相对本脚本自身位置解析，两页面引用深度不同也能正常工作。
 * 下载用 fetch 流式读取以汇报进度（onProgress({ loaded, total, phase })）；fetch 走
 * 浏览器 HTTP 缓存，不会每次进页面都重新下载；fetch 不可用 / 跨域失败时回退
 * <script src>（无进度）。
 */
var loadOpenCV = (() => {
	"use strict";

	const OPENCV_URLS = [
		new URL("../lib/opencv.js", document.currentScript.src).href,
		"https://fastly.jsdelivr.net/npm/@techstark/opencv-js/dist/opencv.js",
		"https://cdn.jsdelivr.net/npm/@techstark/opencv-js/dist/opencv.js",
		"https://unpkg.com/@techstark/opencv-js/dist/opencv.js",
	];

	let cv = null;
	let cvPromise = null;
	// 多个调用方（弹窗预加载 / 自动定位）共享同一次加载，进度回调全部通知
	const progressFns = new Set();
	const notify = (info) => progressFns.forEach((fn) => fn(info));

	/** fetch 流式下载整个脚本，边下边汇报进度，完成后打包为 Blob */
	async function fetchScript(url) {
		const resp = await fetch(url);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const total = Number(resp.headers.get("content-length")) || 0;
		if (!resp.body?.getReader) {
			const buf = await resp.arrayBuffer();
			notify({ loaded: buf.byteLength, total: total || buf.byteLength, phase: "download" });
			return new Blob([buf], { type: "text/javascript" });
		}
		const reader = resp.body.getReader();
		const chunks = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.byteLength;
			notify({ loaded, total, phase: "download" });
		}
		return new Blob(chunks, { type: "text/javascript" });
	}

	/** Blob URL 注入执行（内容已在内存，HTTP 缓存由上面的 fetch 负责） */
	function injectBlob(blob) {
		return new Promise((resolve, reject) => {
			const blobUrl = URL.createObjectURL(blob);
			const script = document.createElement("script");
			script.src = blobUrl;
			script.onload = () => {
				URL.revokeObjectURL(blobUrl);
				resolve(window.cv);
			};
			script.onerror = () => {
				URL.revokeObjectURL(blobUrl);
				reject(new Error("OpenCV.js 执行失败"));
			};
			document.head.appendChild(script);
		});
	}

	/** <script src> 兜底（无进度，file:// 或 fetch 被拦截时用） */
	function injectSrc(url) {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = url;
			script.onload = () => resolve(window.cv);
			script.onerror = () => reject(new Error("OpenCV.js 加载失败"));
			document.head.appendChild(script);
		});
	}

	/** cv 可能是 Promise（@techstark/opencv-js）或需等运行时初始化 */
	function settle(cvObj, resolve, reject) {
		if (cvObj && typeof cvObj.then === "function") {
			cvObj.then((v) => resolve((cv = v)), reject);
		} else if (cvObj && cvObj.Mat) {
			resolve((cv = cvObj));
		} else if (cvObj) {
			cvObj.onRuntimeInitialized = () => resolve((cv = cvObj));
		} else {
			reject(new Error("OpenCV.js 未定义"));
		}
	}

	async function tryUrl(idx) {
		if (idx >= OPENCV_URLS.length) throw new Error("OpenCV.js 加载失败");
		try {
			try {
				const blob = await fetchScript(OPENCV_URLS[idx]);
				// 下载完成，进入脚本编译 / WASM 运行时初始化阶段
				notify({ loaded: 1, total: 1, phase: "init" });
				return await injectBlob(blob);
			} catch {
				return await injectSrc(OPENCV_URLS[idx]);
			}
		} catch {
			return tryUrl(idx + 1);
		}
	}

	return function loadOpenCV(onProgress) {
		if (typeof onProgress === "function") progressFns.add(onProgress);
		if (cv) {
			progressFns.delete(onProgress);
			return Promise.resolve(cv);
		}
		if (!cvPromise) {
			cvPromise = new Promise((resolve, reject) => {
				tryUrl(0).then(
					(cvObj) => settle(cvObj, resolve, reject),
					reject,
				);
			});
			const done = () => {
				progressFns.clear();
				cvPromise = null; // 成功时 cv 已缓存；失败允许下次重试
			};
			cvPromise.then(done, done);
		}
		return cvPromise;
	};
})();
