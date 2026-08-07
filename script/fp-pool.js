"use strict";
/**
 * 批量流程 Web Worker 池（回放验证 / 元素校准批量采样 / 组级提取批量采样共用）。
 *
 * file:// 下 Chrome 禁止 new Worker("file://...")（origin null），故用 Blob 引导：
 * bootstrap 内 self.window=self 前置 shim（opencv.js 是 emscripten UMD，读 window）后，
 * 以绝对 file:// URL 一次性平铺 importScripts 全部依赖（被引入脚本内不得再相对
 * importScripts，会解析到 blob: base 而失败），业务脚本 fp-worker.js 最后载入。OpenCV
 * 每个 worker 各载一份（预期开销），实例就绪后回 "ready" 握手，握手完成才派发任务。
 *
 * 懒创建、常驻复用；setSize(n) 动态调整（缩容优雅退出空闲 worker，忙 worker 完成当前
 * 任务后退出）；并发数默认 CPU 核数-2（下限 2），上限锁死为该默认值，localStorage 持久化。
 * ensure() 在全部 worker 启动失败（如 OpenCV 载入失败）时 reject，调用方据此回退串行路径。
 */
var FPPool = (() => {
	const LS_KEY = "fp-extract:parallel"; // 并行线程数持久化（键名风格同 fp-extract:*）
	const MIN = 2; // 并发下限
	// 并发上限锁死为默认值（CPU 核数-2，下限 2）：每 worker 各载一份 OpenCV，
	// 超过核数-2 只会抢占主线程、适得其反，故不允许调高
	const MAX = Math.max(
		MIN,
		(((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4) -
			2),
	);

	// 依赖脚本 URL：相对本脚本自身位置解析（与 opencv-loader.js 同一手法），
	// 引用页面在不同目录深度也能正确推算
	const SELF_SRC =
		(typeof document !== "undefined" &&
			document.currentScript &&
			document.currentScript.src) ||
		(typeof location !== "undefined" ? location.href : "");

	function defaultSize() {
		return MAX;
	}

	function clampSize(n) {
		n = Math.floor(Number(n));
		if (!(n >= MIN)) return defaultSize();
		return Math.min(MAX, n);
	}

	/** 当前并发数：持久化值优先，否则默认（核数-2，下限 2） */
	function loadSize() {
		let n = 0;
		try {
			n = Number(localStorage.getItem(LS_KEY)) || 0;
		} catch {
			// file:// 禁用存储时忽略，用默认值
		}
		return n >= MIN ? clampSize(n) : defaultSize();
	}

	function supported() {
		return (
			typeof Worker !== "undefined" &&
			typeof Blob !== "undefined" &&
			typeof URL !== "undefined" &&
			!!URL.createObjectURL
		);
	}

	/** Blob 引导源码：前置 window shim 后平铺 importScripts（绝对 URL） */
	function bootstrapSrc() {
		const urls = [
			"../data/shapes.data.js",
			"../data/blocks.data.js",
			"../data/scan-fp-refs.js",
			"scan-core.js",
			"scan-bench.js",
			"../lib/opencv.js",
			"fp-worker.js",
		].map((rel) => new URL(rel, SELF_SRC).href);
		return `self.window = self;\nimportScripts(${urls
			.map((u) => JSON.stringify(u))
			.join(",")});\n`;
	}

	let size = loadSize();
	let workers = []; // [{ w, ready, busy, dying, task, onBootFail }]
	let queue = []; // [{ msg, transfer, resolve, reject }]
	let seq = 0;
	let ensurePromise = null;
	let ensured = false;

	function retire(rec) {
		const i = workers.indexOf(rec);
		if (i >= 0) workers.splice(i, 1);
		try {
			rec.w.terminate();
		} catch {
			// 忽略
		}
	}

	/** worker 失败回收：在途任务 reject；池全灭时排队任务全部失败并重置 ensure（下次重建） */
	function fail(rec, err) {
		const wasReady = rec.ready;
		retire(rec);
		if (rec.task) {
			const t = rec.task;
			rec.task = null;
			t.reject(err);
		}
		if (!wasReady && rec.onBootFail) rec.onBootFail();
		if (!workers.length) {
			ensured = false;
			ensurePromise = null;
			const q = queue;
			queue = [];
			q.forEach((t) => t.reject(err));
		} else if (wasReady) {
			spawn(null, null); // 运行期掉线补齐（不影响其他在途 worker）
		}
	}

	function spawn(onFirstReady, onBootFail) {
		let w;
		try {
			const url = URL.createObjectURL(
				new Blob([bootstrapSrc()], { type: "text/javascript" }),
			);
			w = new Worker(url);
			URL.revokeObjectURL(url);
		} catch {
			if (onBootFail) onBootFail();
			return;
		}
		const rec = { w, ready: false, busy: false, dying: false, task: null, onBootFail };
		w.onmessage = (e) => {
			const msg = e.data || {};
			if (msg.type === "ready") {
				rec.ready = true;
				if (onFirstReady) onFirstReady();
				pump();
				return;
			}
			if (msg.type === "bootError") {
				fail(rec, new Error(msg.message || "worker 初始化失败"));
				return;
			}
			const task = rec.task;
			rec.task = null;
			rec.busy = false;
			if (task) {
				if (msg.ok) task.resolve(msg.result);
				else task.reject(new Error(msg.error || "worker 处理失败"));
			}
			if (rec.dying) retire(rec);
			else pump();
		};
		w.onerror = () => fail(rec, new Error("worker 脚本错误"));
		workers.push(rec);
	}

	/** 排队任务派发给空闲就绪 worker（每 worker 同时只跑一个任务） */
	function pump() {
		while (queue.length) {
			const rec = workers.find((r) => r.ready && !r.busy && !r.dying);
			if (!rec) return;
			const task = queue.shift();
			rec.busy = true;
			rec.task = task;
			try {
				rec.w.postMessage(task.msg, task.transfer);
			} catch (e) {
				rec.busy = false;
				rec.task = null;
				task.reject(e);
			}
		}
	}

	/** 池就绪：首个 worker 握手成功即 resolve；全部启动失败 reject（调用方回退串行） */
	function ensure() {
		if (!supported())
			return Promise.reject(new Error("当前环境不支持 Web Worker"));
		if (ensured) return Promise.resolve(api);
		if (ensurePromise) return ensurePromise;
		const target = size;
		let settled = false;
		let fails = 0;
		ensurePromise = new Promise((resolve, reject) => {
			for (let i = 0; i < target; i++) {
				spawn(
					() => {
						if (!settled) {
							settled = true;
							ensured = true;
							resolve(api);
						}
					},
					() => {
						fails++;
						if (!settled && fails >= target) {
							settled = true;
							ensurePromise = null;
							reject(new Error("worker 全部启动失败"));
						}
					},
				);
			}
		});
		return ensurePromise;
	}

	/** 单任务：payload 需可结构化克隆，transfer 为可选转移缓冲数组 */
	async function run(op, payload, transfer) {
		await ensure();
		return new Promise((resolve, reject) => {
			queue.push({
				msg: { id: ++seq, op, payload },
				transfer: transfer || [],
				resolve,
				reject,
			});
			pump();
		});
	}

	/**
	 * 批量：payloads 逐项派发，保序返回；单任务失败（解码失败 / worker 异常）
	 * 记 { ok:false, error } 不拖死整批，池级启动失败才 reject（回退串行）。
	 * onProgress(done, total, index) 按完成逐个回调（乱序完成、计数递增）。
	 */
	async function map(op, payloads, onProgress) {
		await ensure();
		let done = 0;
		return Promise.all(
			payloads.map((payload, i) =>
				run(op, payload)
					.then((result) => ({ ok: true, result }))
					.catch((e) => ({
						ok: false,
						error: String((e && e.message) || e),
					}))
					.then((res) => {
						done++;
						if (onProgress) onProgress(done, payloads.length, i);
						return res;
					}),
			),
		);
	}

	/**
	 * 调整并发数（写 localStorage 持久化）：池未创建时下次 ensure 生效；
	 * 已创建则扩容补建 worker（异步就绪），缩容优雅退出空闲 worker
	 * （忙 worker 完成当前任务后退出）。返回生效值。
	 */
	function setSize(n) {
		size = clampSize(n);
		try {
			localStorage.setItem(LS_KEY, String(size));
		} catch {
			// file:// 禁用存储时忽略
		}
		if (!workers.length) return size;
		const alive = workers.slice();
		for (let i = alive.length; i < size; i++) spawn(null, null);
		alive.slice(size).forEach((rec) => {
			rec.dying = true;
			if (!rec.busy) retire(rec);
		});
		return size;
	}

	const api = {
		supported,
		ensure,
		run,
		map,
		setSize,
		getSize: () => size,
		MIN,
		MAX,
	};
	return api;
})();
