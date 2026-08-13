#!/usr/bin/env node
"use strict";

// Reuse the production worker functions so benchmark and UI search stay aligned.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = fs.readFileSync(path.join(ROOT, "script/main.index.js"), "utf8");
const BLOCKS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/blocks.json"), "utf8"));
const RUN_MS = 5000;
const WARMUP_MS = 1000;
const RUNS = 3;

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing function: ${name}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	let quote = "";
	let lineComment = false;
	let blockComment = false;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error(`Unclosed function: ${name}`);
}

function area(shape) {
	return shape.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

function exposedEdges(shape) {
	const cells = new Set();
	shape.forEach((row, r) => row.forEach((v, c) => v && cells.add(`${r},${c}`)));
	let count = 0;
	for (const cell of cells) {
		const [r, c] = cell.split(",").map(Number);
		for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			if (!cells.has(`${r + dr},${c + dc}`)) count++;
		}
	}
	return count;
}

function fixtureItem(name, max) {
	const raw = BLOCKS["金"].normal[name];
	return {
		name,
		type: "金",
		quality: 3,
		bonus: raw.bonus,
		previewAdjacent: !!raw.previewAdjacent,
		attrs: raw.value[3],
		shape: raw.shape,
		max,
	};
}

function buildSnapshot() {
	// Exactly 42 cells: seven vertical 4-cell pieces plus fourteen 1-cell pieces.
	// Each of the seven columns can be filled independently, so a full board is feasible.
	const items = [fixtureItem("重金破阵矛", 7), fixtureItem("蕴金戒", 14)];
	const sumMax = [0, 0, 0];
	const densityMax = [0, 0, 0];
	for (const item of items) {
		const self = [0, 0, 0];
		if (item.bonus[1] === 1) self[item.bonus[0]] = item.attrs[3] || 0;
		const edgeCount = exposedEdges(item.shape);
		const itemArea = area(item.shape);
		for (let i = 0; i < 3; i++) {
			const value = item.attrs[i] * (1 + (edgeCount * self[i]) / 100);
			sumMax[i] += value * item.max;
			densityMax[i] = Math.max(densityMax[i], value / itemArea);
		}
	}
	return {
		cols: 7,
		rows: 6,
		disabled: [],
		items,
		weights: [1, 1, 1],
		attrsMax: [0, 1, 2].map((i) => Math.ceil(Math.min(sumMax[i], densityMax[i] * 42))),
		mode: "heuristic",
		fillFirst: true,
		timeLimitSec: 0,
	};
}

const workerSource = [
	extractFunction(SOURCE, "engShapeOffsets"),
	extractFunction(SOURCE, "engPrepare"),
	extractFunction(SOURCE, "engAdjIds"),
	extractFunction(SOURCE, "engContrib"),
	`(${extractFunction(SOURCE, "engWorkerMain")})();`,
].join("\n");

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

async function runOnce(seed) {
	const messages = [];
	const context = {
		Date,
		Math,
		Map,
		Set,
		Int16Array,
		Uint8Array,
		Float64Array,
		setTimeout,
		clearTimeout,
		postMessage(message) {
			messages.push({ at: Date.now(), message });
		},
	};
	context.self = context;
	vm.runInNewContext(workerSource, context, { filename: "solver-worker-bench.js" });
	const started = Date.now();
	context.self.onmessage({ data: { type: "start", wid: 0, seed, snap: buildSnapshot() } });
	await new Promise((resolve) => setTimeout(resolve, RUN_MS));
	context.self.onmessage({ data: { type: "stop" } });
	await new Promise((resolve) => setTimeout(resolve, 100));
	const statuses = messages.filter(
		(entry) => entry.message.type === "status" && entry.at - started >= WARMUP_MS,
	);
	const best = messages.filter((entry) => entry.message.type === "best").at(-1)?.message;
	const snap = buildSnapshot();
	const filled = (best?.layout || []).reduce((sum, placement) => {
		return sum + snap.items[placement.item].shape.flat().filter(Boolean).length;
	}, 0);
	if (statuses.length < 2) throw new Error("Not enough status samples collected");
	const first = statuses[0];
	const last = statuses.at(-1);
	const tps = ((last.message.iter - first.message.iter) * 1000) / (last.at - first.at);
	return { tps: Math.round(tps), samples: statuses.length, filled };
}

(async () => {
	const runs = [];
	for (let i = 0; i < RUNS; i++) runs.push(await runOnce(0x1a2b3c4d + i));
	const result = {
		fixture: "7x6 full grid, 7x 重金破阵矛 + 14x 蕴金戒",
		runMs: RUN_MS,
		warmupMs: WARMUP_MS,
		runs,
		medianTps: median(runs.map((run) => run.tps)),
	};
	console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
	console.error(error.stack || error);
	process.exitCode = 1;
});
