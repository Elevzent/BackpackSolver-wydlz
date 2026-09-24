#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../script/main.index.js"), "utf8");

function extractFunction(name) {
	const start = source.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`Missing function: ${name}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error(`Unclosed function: ${name}`);
}

const context = { JSON, Math, Number };
vm.runInNewContext(
	[
		extractFunction("positiveInteger"),
		extractFunction("bestProblemKey"),
		extractFunction("betterHistoricalBest"),
	].join("\n"),
	context,
);

const best = (score, filled) => ({
	score,
	result: { insts: [{ cells: Array(filled).fill(0) }] },
});
const current = best(0.8, 40);
const fewer = best(0.9, 39);
const fuller = best(0.7, 41);
assert.strictEqual(context.betterHistoricalBest(fewer, current, true), false);
assert.strictEqual(context.betterHistoricalBest(fuller, current, true), true);
assert.strictEqual(context.betterHistoricalBest(fewer, current, false), true);
assert.strictEqual(context.betterHistoricalBest(fuller, current, false), false);
assert.strictEqual(context.betterHistoricalBest(best(0.8, 41), current, false), true);

const snap = {
	cols: 7,
	rows: 6,
	disabled: [5, 2],
	items: [{ name: "test", max: 2, attrs: [1, 2, 3] }],
	weights: [1, 0, 0],
	attrsMax: [42, 0, 0],
	useAdjacentBonus: false,
	fillFirst: true,
};
const key = context.bestProblemKey(snap);
assert.strictEqual(context.bestProblemKey({ ...snap, disabled: [2, 5] }), key);
assert.notStrictEqual(context.bestProblemKey({ ...snap, cols: 8 }), key);
assert.notStrictEqual(context.bestProblemKey({ ...snap, items: [{ ...snap.items[0], max: 3 }] }), key);
assert.notStrictEqual(context.bestProblemKey({ ...snap, attrsMax: [43, 0, 0] }), key);

assert.strictEqual(context.positiveInteger("2.9"), 2);
assert.strictEqual(context.positiveInteger("0"), 1);
assert.strictEqual(context.positiveInteger("Infinity"), 1);

console.log("best-history: passed");
