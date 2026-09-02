#!/usr/bin/env node
"use strict";
// 求解引擎无头 bench：不经浏览器，直接用 worker_threads 跑 main.index.js 里的求解引擎，
// 用于对比引擎改动前后的解质量（同一快照、同样时长、多 seed 的最优分分布）。
//
// 用法：
//   node tools/bench/solve-bench.js                      # 全部用例，默认参数
//   node tools/bench/solve-bench.js --case 金系满编 --sec 30 --trials 5 --workers 4
//   node tools/bench/solve-bench.js --src HEAD           # 用 git HEAD 版引擎（改动前基线）
//   node tools/bench/solve-bench.js --src /path/old-main.index.js
//
// 输出：每个用例每次试验的最终最优分与时间点分段分，以及 min/median/max 汇总。
// 迁移（adopt 广播）逻辑与页面主线程一致；旧版引擎收到 adopt 消息会忽略，天然即"无迁移"基线。

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "../..");

/** 测试用例 */
// spec 条目：{ type, name, nums, quality?（默认 3=金）, red? }
const CASES = [
	{
		name: "金系满编",
		cols: 7,
		rows: 6,
		weights: [1, 0, 0],
		fillFirst: false,
		spec: [
			{ type: "金", name: "金锋无影", nums: 1, red: true },
			{ type: "金", name: "龙渊七星", nums: 1, red: true },
			{ type: "金", name: "三尖两刃", nums: 1, red: true },
			{ type: "金", name: "金辉裂穹", nums: 1, red: true },
			{ type: "金", name: "朔气飞星", nums: 1, red: true },
			{ type: "金", name: "残虹断影", nums: 1, red: true },
			{ type: "金", name: "金翎荡云", nums: 1, red: true },
			{ type: "金", name: "亢金贯甲", nums: 1, red: true },
			{ type: "金", name: "玄金重剑", nums: 2 },
			{ type: "金", name: "玄金碎甲剑", nums: 2 },
			{ type: "金", name: "重金破阵矛", nums: 2 },
			{ type: "金", name: "曜金战身刀", nums: 2 },
			{ type: "金", name: "蕴金枪", nums: 2 },
			{ type: "金", name: "分金刀", nums: 2 },
		],
	},
	{
		name: "水火混编",
		cols: 7,
		rows: 6,
		weights: [1, 1, 1],
		fillFirst: false,
		spec: [
			{ type: "水", name: "玄冥坠星", nums: 1, red: true },
			{ type: "水", name: "弱水涓扇", nums: 1, red: true },
			{ type: "水", name: "玄水护心", nums: 1, red: true },
			{ type: "水", name: "凌波惊鸿", nums: 1, red: true },
			{ type: "水", name: "霜华千影剑", nums: 2 },
			{ type: "水", name: "冰魄凝神甲", nums: 2 },
			{ type: "水", name: "急冻流星锤", nums: 2 },
			{ type: "水", name: "净魂刃", nums: 2 },
			{ type: "火", name: "乾坤浑天", nums: 1, red: true },
			{ type: "火", name: "南明离炎", nums: 1, red: true },
			{ type: "火", name: "赤霄斩浪", nums: 1, red: true },
			{ type: "火", name: "炽影破锋刀", nums: 2 },
			{ type: "火", name: "拜火焚星笙", nums: 2 },
		],
	},
	{
		name: "雷系小盘",
		cols: 7,
		rows: 6,
		weights: [1, 0, 0],
		fillFirst: false,
		spec: [
			{ type: "雷", name: "五雷号令", nums: 1, red: true },
			{ type: "雷", name: "九霄镇魔", nums: 1, red: true },
			{ type: "雷", name: "鸣雷诛邪枪", nums: 2 },
			{ type: "雷", name: "玄阴霹雳鼓", nums: 2 },
			{ type: "雷", name: "雷元乌龙旗", nums: 2 },
			{ type: "雷", name: "雷灵珠", nums: 2 },
		],
	},
];

/** 参数解析 */
function parseArgs() {
	const opt = {
		sec: 30,
		trials: 5,
		workers: 4,
		seed: 12345,
		src: null, // 默认 script/main.index.js；HEAD 表示 git HEAD 版本
		case: null,
		mode: "lns",
	};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = argv[i + 1];
		if (k === "--sec") opt.sec = Number(v);
		else if (k === "--trials") opt.trials = Number(v);
		else if (k === "--workers") opt.workers = Number(v);
		else if (k === "--seed") opt.seed = Number(v);
		else if (k === "--src") opt.src = v;
		else if (k === "--case") opt.case = v;
		else if (k === "--mode") opt.mode = v;
		if (k.startsWith("--")) i++;
	}
	return opt;
}

/** 数据与快照（复刻 main.index.js 的 buildSnapshot / countAdjacentCells / getItemAttrs） */
function loadBlocks() {
	const src = fs.readFileSync(path.join(ROOT, "data/blocks.data.js"), "utf8");
	return new Function(`${src}; return BLOCKS;`)();
}

function countAdjacentCells(grid) {
	const rows = grid.length;
	const cols = rows > 0 ? grid[0].length : 0;
	const blocks = new Set();
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (grid[r][c] === 1) blocks.add(`${r},${c}`);
		}
	}
	const directions = [
		[-1, 0],
		[1, 0],
		[0, -1],
		[0, 1],
	];
	const adjacent = new Set();
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (grid[r][c] === 1) {
				for (const [dr, dc] of directions) {
					const key = `${r + dr},${c + dc}`;
					if (!blocks.has(key)) adjacent.add(key);
				}
			}
		}
	}
	return adjacent.size;
}

function buildSelected(BLOCKS, spec) {
	return spec.map((s) => {
		const detail = s.red
			? BLOCKS[s.type].red[s.name]
			: BLOCKS[s.type].normal[s.name];
		if (!detail) throw new Error(`法宝不存在：${s.type}/${s.name}`);
		return {
			name: s.name,
			type: s.type,
			shape: detail.shape,
			bonus: detail.bonus,
			values: s.red ? [detail.value] : detail.value,
			fixed: !!s.red,
			quality: s.red ? 4 : s.quality != null ? s.quality : 3,
			nums: s.nums,
		};
	});
}

function buildSnapshot(selectedBlocks, board, weights) {
	const { cols, rows } = board;
	const disabled = [];
	const bonusMax = [0, 0, 0];
	const getItemAttrs = (item) =>
		item.fixed ? item.values[0] : item.values[item.quality];
	const items = selectedBlocks.map((it) => {
		const attrs = getItemAttrs(it);
		if (it.bonus[1] === 2) {
			bonusMax[it.bonus[0]] = Math.max(bonusMax[it.bonus[0]], attrs[3]);
		}
		return {
			name: it.name,
			type: it.type,
			quality: it.quality,
			bonus: it.bonus,
			attrs,
			shape: it.shape,
			max: it.nums,
		};
	});
	const sumMax = [0, 0, 0];
	const densMax = [0, 0, 0];
	selectedBlocks.forEach((it) => {
		const attrs = getItemAttrs(it);
		const bounsSelf = [0, 0, 0];
		if (it.bonus[1] === 1) {
			bounsSelf[it.bonus[0]] = attrs[3];
		}
		const gridCount = countAdjacentCells(it.shape);
		const area = it.shape.reduce(
			(s, row) => s + row.filter((v) => v).length,
			0,
		);
		for (let j = 0; j < 3; j++) {
			const val =
				attrs[j] * (1 + (gridCount * (bounsSelf[j] + bonusMax[j])) / 100);
			sumMax[j] += val * it.nums;
			densMax[j] = Math.max(densMax[j], val / area);
		}
	});
	const REF_CELLS = 7 * 6;
	const refCells = Math.max(REF_CELLS, cols * rows - disabled.length);
	const attrsMax = [0, 1, 2].map((j) =>
		Math.ceil(Math.min(sumMax[j], densMax[j] * refCells)),
	);
	return { cols, rows, disabled, items, weights, attrsMax };
}

/** 引擎源码提取：从 main.index.js 截取自包含的 eng* 函数段 */
function readMainSource(srcOpt) {
	if (srcOpt === "HEAD") {
		return execSync("git show HEAD:script/main.index.js", {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
	}
	return fs.readFileSync(
		srcOpt || path.join(ROOT, "script/main.index.js"),
		"utf8",
	);
}

function extractEngineSource(mainSrc) {
	const start = mainSrc.indexOf("function engShapeOffsets");
	const end = mainSrc.indexOf("const WORKER_SOURCE");
	if (start < 0 || end < 0 || end <= start) {
		throw new Error("无法从 main.index.js 截取引擎源码（标记未找到）");
	}
	return mainSrc.slice(start, end);
}

// node worker_threads 没有浏览器的 self/postMessage，补一层兼容
const NODE_SHIM = `const { parentPort } = require("worker_threads");
const self = {};
Object.defineProperty(self, "onmessage", {
	set(fn) { parentPort.on("message", (data) => fn({ data })); },
});
const postMessage = (msg) => parentPort.postMessage(msg);
`;

/** 单次试验：workers 个线程跑 sec 秒，主线程角色复刻页面（取最优 + 迁移广播） */
function runTrial(workerCode, snap, opt, trialSeed) {
	return new Promise((resolve, reject) => {
		const workers = [];
		const wBest = new Array(opt.workers).fill(null); // 各线程最近上报 best
		let global = null; // { score, layout, t }
		const timeline = []; // 最优刷新历史 { t(ms), score }
		const t0 = Date.now();
		for (let w = 0; w < opt.workers; w++) {
			const worker = new Worker(workerCode, { eval: true });
			worker.on("error", reject);
			worker.on("message", (m) => {
				if (m.type === "best") {
					wBest[m.wid] = m.score;
					if (!global || m.score > global.score + 1e-9) {
						global = { score: m.score, layout: m.layout, t: Date.now() - t0 };
						timeline.push(global);
					}
				}
			});
			worker.postMessage({
				type: "start",
				wid: w,
				seed: (trialSeed ^ ((w + 1) * 2654435761)) >>> 0,
				snap,
			});
			workers.push(worker);
		}
		// 迁移：与页面主线程一致，每 2s 把全局最优广播给落后 0.1% 以上的线程；
		// 旧版引擎没有 adopt 分支，消息被忽略，天然保持"无迁移"行为
		const migrateTimer = setInterval(() => {
			if (!global) return;
			const margin = Math.max(1e-9, global.score * 0.001);
			workers.forEach((wk, w) => {
				if (wBest[w] != null && wBest[w] < global.score - margin) {
					wk.postMessage({
						type: "adopt",
						score: global.score,
						layout: global.layout,
					});
				}
			});
		}, 2000);
		setTimeout(() => {
			clearInterval(migrateTimer);
			workers.forEach((w) => w.postMessage({ type: "stop" }));
			setTimeout(() => {
				Promise.all(workers.map((w) => w.terminate())).then(() =>
					resolve({ best: global, timeline }),
				);
			}, 300);
		}, opt.sec * 1000);
	});
}

/** 汇总输出 */
function median(arr) {
	const s = [...arr].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function scoreAt(timeline, ms) {
	let v = 0;
	for (const p of timeline) {
		if (p.t <= ms) v = p.score;
		else break;
	}
	return v;
}

async function main() {
	const opt = parseArgs();
	const BLOCKS = loadBlocks();
	const mainSrc = readMainSource(opt.src);
	const engineSrc = extractEngineSource(mainSrc);
	// 浏览器 Worker 载荷完整性校验：页面 WORKER_SOURCE 只注入列出的函数，
	// 引擎段内调用到的 eng* 函数若不在清单中，浏览器端必炸
	const payloadFns = [...mainSrc.matchAll(/(\w+)\.toString\(\)/g)].map(
		(m) => m[1],
	);
	const missing = [
		...new Set([...engineSrc.matchAll(/(?<!function )eng\w+(?=\()/g)].map((m) => m[0])),
	].filter(
		(name) =>
			!payloadFns.includes(name) &&
			new RegExp(`function ${name}\\s*\\(`).test(engineSrc),
	);
	if (missing.length) {
		throw new Error(
			`WORKER_SOURCE 缺少注入：${missing.join("、")}（浏览器 Worker 内会是 undefined）`,
		);
	}
	// 与浏览器 WORKER_SOURCE 完全一致的装配：除最后一个（engWorkerMain，页面以 IIFE
	// 注入并执行）外逐函数截取拼合——bench 跑的就是浏览器真实载荷
	function fnSource(name) {
		const start = engineSrc.indexOf(`function ${name}(`);
		if (start < 0) throw new Error(`引擎段中找不到函数 ${name}`);
		let depth = 0;
		for (let i = engineSrc.indexOf("{", start); i < engineSrc.length; i++) {
			if (engineSrc[i] === "{") depth++;
			else if (engineSrc[i] === "}") {
				depth--;
				if (!depth) return engineSrc.slice(start, i + 1);
			}
		}
		throw new Error(`函数 ${name} 括号不匹配`);
	}
	const workerCode =
		NODE_SHIM +
		payloadFns
			.slice(0, -1)
			.map(fnSource)
			.join("\n") +
		`\n(${fnSource(payloadFns[payloadFns.length - 1])})();\n`;
	// 主进程内加载纯函数，用于对 Worker 上报的最优布局做全量重评校验
	// （增量计分正确性对拍：复合分 = 属性分 + 占格 × fillW，属性优先下 fillW 部分 ≤ 4.2e-5）
	const engFuncs = new Function(
		`${engineSrc}; return { engPrepare, engScoreLayout };`,
	)();
	const cases = opt.case ? CASES.filter((c) => c.name === opt.case) : CASES;
	if (!cases.length) throw new Error(`用例不存在：${opt.case}`);
	const marks = [];
	for (let t = 5; t <= opt.sec; t += 5) marks.push(t * 1000);

	console.log(
		`引擎：${opt.src || "工作区 script/main.index.js"}｜模式 ${opt.mode}｜${opt.workers} 线程 × ${opt.sec}s × ${opt.trials} 次`,
	);
	for (const c of cases) {
		const selected = buildSelected(BLOCKS, c.spec);
		const snap = buildSnapshot(selected, c, c.weights);
		snap.mode = opt.mode;
		snap.fillFirst = c.fillFirst;
		snap.timeLimitSec = opt.sec;
		const totalUnits = selected.reduce((s, it) => s + it.nums, 0);
		const totalArea = selected.reduce(
			(s, it) =>
				s +
				it.shape.reduce((a, row) => a + row.filter((v) => v).length, 0) *
					it.nums,
			0,
		);
		console.log(
			`\n== ${c.name}：${c.cols}×${c.rows}，${totalUnits} 件 / 总面积 ${totalArea}，权重 ${c.weights}，${c.fillFirst ? "填满优先" : "属性优先"} ==`,
		);
		const finals = [];
		const markScores = marks.map(() => []);
		for (let t = 0; t < opt.trials; t++) {
			const { best, timeline } = await runTrial(
				workerCode,
				snap,
				opt,
				(opt.seed + t * 7919) >>> 0,
			);
			const finalScore = best ? best.score : 0;
			finals.push(finalScore);
			marks.forEach((ms, i) => markScores[i].push(scoreAt(timeline, ms)));
			// 增量计分对拍：全量重评属性分应 ≤ 复合分，且差值仅为占格 × fillW 部分
			let verify = "无布局";
			if (best) {
				const full = engFuncs.engScoreLayout(snap, best.layout);
				const diff = finalScore - full.score;
				verify =
					diff >= -1e-9 && diff <= 1e-3
						? "对拍OK"
						: `对拍FAIL(复合 ${finalScore.toFixed(6)} vs 全量 ${full.score.toFixed(6)})`;
			}
			console.log(
				`  试验 ${t + 1}：最终 ${finalScore.toFixed(6)}（${marks.map((ms, i) => `${ms / 1000}s=${markScores[i][t].toFixed(4)}`).join(" ")}）${verify}`,
			);
		}
		console.log(
			`  汇总：min ${Math.min(...finals).toFixed(6)}｜median ${median(finals).toFixed(6)}｜max ${Math.max(...finals).toFixed(6)}`,
		);
		console.log(
			`  时间点 median：${marks.map((ms, i) => `${ms / 1000}s=${median(markScores[i]).toFixed(4)}`).join(" ")}`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
