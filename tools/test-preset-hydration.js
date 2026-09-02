#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "script", "main.index.js"), "utf8");
const blocksSource = fs.readFileSync(path.join(root, "data", "blocks.data.js"), "utf8");
const BLOCKS = new Function(`${blocksSource}; return BLOCKS;`)();

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

const context = { BLOCKS, Math, Number };
vm.runInNewContext(
	`${extractFunction("hydratePresetBlocks")}; this.hydratePresetBlocks = hydratePresetBlocks;`,
	context,
);

const legacy = [
	{
		name: "炎脉髓",
		type: "火",
		quality: 3,
		nums: 2,
		shape: [[1]],
		bonus: [0, 0],
		values: [[6, 0, 113], [9, 0, 285], [13, 0, 585], [20, 0, 1135]],
	},
	{
		name: "拜火焚星笙",
		type: "火",
		quality: 3,
		nums: 1,
		shape: [[0, 1], [0, 1], [1, 1]],
		bonus: [0, 0],
		values: [[28, 3, 100], [44, 5, 490], [66, 8, 1240], [104, 13, 2690]],
	},
];

const hydrated = context.hydratePresetBlocks(legacy);
assert.deepStrictEqual(JSON.parse(JSON.stringify(hydrated[0].bonus)), [0, 2]);
assert.strictEqual(hydrated[0].previewAdjacent, true);
assert.strictEqual(hydrated[0].values[3][3], 4);
assert.deepStrictEqual(JSON.parse(JSON.stringify(hydrated[1].bonus)), [0, 2]);
assert.strictEqual(hydrated[1].values[3][3], 2);

assert.throws(
	() => context.hydratePresetBlocks([{ ...legacy[0], name: "不存在" }]),
	/missing catalog item/,
);

console.log("preset-hydration: passed");
