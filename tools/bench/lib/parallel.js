/**
 * bench 并行调度公共模块（dump-feats / dump-pixels / calib-types / calib-pixel 共用）：
 * - resolveJobs：并发数自动调度。默认 os.cpus()-2（M1 Pro 10 核 → 8，留 2 核余量；
 *   Apple Silicon 不区分性能/效率核，cpu 数减余量即可），BENCH_JOBS 覆盖；
 *   传 memPerWorkerMB 时按总内存再压一道上限。
 * - runPool（父进程侧）：fork jobs 个 worker，任务按完成顺序派发、结果按任务下标
 *   回收——折/图之间天然独立，调度只改执行顺序不改数学，按下标重组即与串行逐字节一致。
 * - workerLoop（worker 侧）：init 一次（加载 scan-core / cv / 数据集），随后逐任务处理。
 * 选 child_process 而非 worker_threads：进程隔离彻底（opencv wasm 实例、
 * vm.runInThisContext 挂 globalThis 的识别核心各占一份互不干扰），单 worker
 * 崩溃/内存膨胀不影响兄弟。
 */
const os = require("os");
const { fork } = require("child_process");

/**
 * child_process IPC 走 JSON 序列化：Infinity / -Infinity / NaN 会被压成 null，
 * 与合法 null 混淆（ovr 模型仅单一正类时 margin=Infinity，回传即变 null，
 * 下游闸门寻优 null.toFixed 崩溃）。消息收发两侧统一编码/解码为标记对象，
 * 保证并行结果与串行逐项一致。
 */
const NONFINITE_TAG = "__benchNonfinite__";

function encodeNonfinite(v) {
	if (typeof v === "number" && !Number.isFinite(v)) {
		return { [NONFINITE_TAG]: v > 0 ? "Inf" : v < 0 ? "-Inf" : "NaN" };
	}
	if (Array.isArray(v)) return v.map(encodeNonfinite);
	if (v && typeof v === "object") {
		const o = {};
		Object.keys(v).forEach((k) => (o[k] = encodeNonfinite(v[k])));
		return o;
	}
	return v;
}

function decodeNonfinite(v) {
	if (Array.isArray(v)) return v.map(decodeNonfinite);
	if (v && typeof v === "object") {
		const tag = v[NONFINITE_TAG];
		if (tag !== undefined) {
			return tag === "Inf" ? Infinity : tag === "-Inf" ? -Infinity : NaN;
		}
		const o = {};
		Object.keys(v).forEach((k) => (o[k] = decodeNonfinite(v[k])));
		return o;
	}
	return v;
}

/**
 * 并发数决策。参数 memPerWorkerMB —— 单 worker 预估内存（MB），用于内存上限压并发。
 * 返回 ≥1 的并发数。
 */
function resolveJobs(memPerWorkerMB) {
	const env = parseInt(process.env.BENCH_JOBS || "", 10);
	let jobs =
		Number.isInteger(env) && env > 0
			? env
			: Math.max(1, os.cpus().length - 2);
	if (memPerWorkerMB) {
		const memCap = Math.max(1, Math.floor(os.totalmem() / 1048576 / memPerWorkerMB));
		jobs = Math.min(jobs, memCap);
	}
	return jobs;
}

/**
 * 父进程侧：worker 池跑一批任务。
 * 参数：workerScript —— worker 脚本绝对路径；tasks —— 任务 payload 数组（按下标派发）；
 *   opts —— { jobs, init（worker 启动时发一次，如数据集）, onTaskDone(idx, result) }。
 * 返回 Promise<results[]>，results[i] 对应 tasks[i]，顺序与派发一致（与串行等价）。
 */
function runPool(workerScript, tasks, opts) {
	const o = opts || {};
	const jobs = Math.max(1, Math.min(o.jobs || 1, tasks.length || 1));
	return new Promise((resolve, reject) => {
		const results = new Array(tasks.length);
		let next = 0;
		let doneCnt = 0;
		let settled = false;
		const workers = [];
		const fail = (err) => {
			if (settled) return;
			settled = true;
			workers.forEach((w) => w.kill());
			reject(err);
		};
		const pump = (w) => {
			if (next >= tasks.length) return;
			const idx = next++;
			w.send({ type: "task", idx, payload: encodeNonfinite(tasks[idx]) });
		};
		for (let i = 0; i < jobs; i++) {
			const w = fork(workerScript, [], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
			workers.push(w);
			w.on("message", (msg) => {
				if (settled) return;
				if (msg.type === "inited") {
					pump(w);
				} else if (msg.type === "done") {
					results[msg.idx] = decodeNonfinite(msg.result);
					doneCnt++;
					if (o.onTaskDone) o.onTaskDone(msg.idx, results[msg.idx]);
					if (doneCnt === tasks.length) {
						settled = true;
						workers.forEach((x) => x.kill());
						resolve(results);
					} else pump(w);
				} else if (msg.type === "error") {
					const e = new Error(`worker 任务 #${msg.idx} 失败：${msg.error.message}`);
					e.stack = msg.error.stack;
					fail(e);
				}
			});
			w.on("exit", (code) => {
				if (!settled) fail(new Error(`worker 异常退出（code=${code}）`));
			});
			w.on("error", fail);
			w.send({ type: "init", payload: encodeNonfinite(o.init) });
		}
	});
}

/**
 * worker 侧：注册 init/task 消息循环。
 * 参数：onInit(payload) → ctx（可异步，如加载 cv）；onTask(ctx, payload) → result（可异步）。
 */
function workerLoop(onInit, onTask) {
	let ctx;
	process.on("message", async (msg) => {
		try {
			if (msg.type === "init") {
				ctx = await onInit(decodeNonfinite(msg.payload));
				process.send({ type: "inited" });
			} else if (msg.type === "task") {
				const result = await onTask(ctx, decodeNonfinite(msg.payload));
				process.send({ type: "done", idx: msg.idx, result: encodeNonfinite(result) });
			}
		} catch (e) {
			process.send({
				type: "error",
				idx: msg.idx,
				error: { message: e.message, stack: e.stack },
			});
		}
	});
}

module.exports = { resolveJobs, runPool, workerLoop };
