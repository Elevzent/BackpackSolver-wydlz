/**
 * 所有的形状
 *
 * "#" 表示占位，"\n" 表示换行，"_" 表示空格，行末的空格可以不写
 */
const shapesObj = {
	1: [["点", "#"]],
	2: [
		["一", "##"],
		["I", "#\n#"],
	],
	3: [
		["一", "###"],
		["I", "#\n#\n#"],
		["J", "_#\n##"],
		["反J", "##\n#"],
	],
	4: [
		["田", "##\n##"],
		["I", "#\n#\n#\n#"],
		["J", "_#\n_#\n##"],
		["反J", "##\n#\n#"],
	],
	5: [
		["P", "##\n##\n#"],
		["反P", "_#\n##\n##"],
		["J", "_#\n_#\n_#\n##"],
		["反J", "##\n#\n#\n#"],
		["折线", "_##\n_#\n##"],
	],
};

const shapes = (() => {
	const strZhAr = "零一两三四五六七八九十";
	const output = {};
	Object.entries(shapesObj).forEach(([count, ar]) => {
		const strZh = strZhAr[count];
		ar.forEach(([name, str]) => {
			const lineMax = str
				.split("\n")
				.reduce((a, b) => Math.max(a, b.length), 0);
			const key = `${strZh}格/${name}`;
			const dimAr = str.split("\n").map((lineStr) =>
				lineStr
					.padEnd(lineMax, "_")
					.split("")
					.map((char) => (char === "#" ? 1 : 0)),
			);

			output[key] = dimAr;
			output[JSON.stringify(dimAr)] = key;
		});
	});
	return output;
})();

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const outPath = path.join(dataDir, "shapes.json");
fs.writeFileSync(outPath, JSON.stringify(shapes, null, "\t") + "\n", "utf8");
console.log(`已写入 ${outPath}`);

// 同步产出 JS 包装版，供 HTML 页面通过 <script src> 直接引入（file:// 下 fetch 受限）
const jsPath = path.join(dataDir, "shapes.data.js");
fs.writeFileSync(
	jsPath,
	`// 由 形状生成工具.js 自动生成，请勿手改\nvar SHAPES = ${JSON.stringify(shapes)};\n`,
	"utf8",
);
console.log(`已写入 ${jsPath}`);
