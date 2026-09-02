#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
	path.join(__dirname, "..", "script", "main.index.js"),
	"utf8",
);

function extractFunction(name) {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing function: ${name}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	let quote = "";
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
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

const context = { Map, Set, Int16Array, Math };
vm.runInNewContext(
	[
		extractFunction("engShapeOffsets"),
		extractFunction("engPrepare"),
		extractFunction("engAdjIds"),
		extractFunction("engContrib"),
		extractFunction("engScoreLayout"),
	].join("\n") + "\nthis.engScoreLayout = engScoreLayout;",
	context,
);

const target = {
	name: "测试目标",
	type: "金",
	quality: 3,
	bonus: [0, 0],
	attrs: [100, 0, 0, 0],
	shape: [[1]],
	max: 1,
};
const provider = {
	name: "蕴金戒",
	type: "金",
	quality: 3,
	bonus: [0, 2],
	previewAdjacent: true,
	attrs: [0, 0, 0, 10],
	shape: [[1]],
	max: 2,
};

function score(useAdjacentBonus, items, layout, cols = 3, rows = 2) {
	return context.engScoreLayout(
		{
			cols,
		rows,
			disabled: [],
			items,
			weights: [1, 0, 0],
			attrsMax: [1000, 1, 1],
			useAdjacentBonus,
			adjacentPctBound: { 金: [0.2, 0, 0] },
		},
		layout,
	);
}

function assertAttack(expected, result) {
	assert.ok(Math.abs(result.totals[0] - expected) < 1e-9, result.totals[0]);
}

assertAttack(100, score(false, [target, provider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 1 }]));
assertAttack(110, score(true, [target, provider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 1 }]));
assertAttack(120, score(true, [target, provider], [{ item: 0, r: 0, c: 1 }, { item: 1, r: 0, c: 0 }, { item: 1, r: 0, c: 2 }]));

const multiProvider = {
	...provider,
	name: "拜火焚星笙",
	previewAdjacent: false,
	attrs: [0, 0, 0, 2],
	shape: [[0, 1], [0, 1], [1, 1]],
	max: 1,
};
assertAttack(100, score(false, [target, multiProvider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 0 }], 2, 3));
assertAttack(102, score(true, [target, multiProvider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 0 }], 2, 3));

const unmarkedSingleProvider = { ...provider, previewAdjacent: false };
assertAttack(100, score(true, [target, unmarkedSingleProvider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 1 }]));

const woodProvider = { ...provider, type: "木" };
assertAttack(100, score(true, [target, woodProvider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 0, c: 1 }]));

const wideTarget = { ...target, shape: [[1, 1]] };
assertAttack(110, score(true, [wideTarget, provider], [{ item: 0, r: 0, c: 0 }, { item: 1, r: 1, c: 0 }]));

const contribSnap = {
	cols: 3,
	rows: 1,
	disabled: [],
	items: [target, provider],
	weights: [1, 0, 0],
	attrsMax: [1000, 1, 1],
	useAdjacentBonus: true,
	adjacentPctBound: { 金: [0.1, 0, 0] },
};
const contribCtx = context.engPrepare(contribSnap);
const occ = new Int16Array([0, 1, -1]);
const insts = [{ item: 0, cells: [0] }, { item: 1, cells: [1] }];
assert.ok(Math.abs(context.engContrib(contribCtx, occ, insts, 0) - 0.11) < 1e-9);

console.log("adjacent-bonus: passed");
