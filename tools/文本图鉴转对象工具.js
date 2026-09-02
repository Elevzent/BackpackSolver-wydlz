/**
 * 纯文本格式化的法宝数据示例
 * "===" 用于分割大类
 * "---" 用于分割普通法宝和红法宝，请按顺序书写
 * 普通法宝示例：
 * 法宝名称，[形状：1，2一，2i，3一，3i，3j，3fj，4o，4i，4j，4fj，5z](数字代表格数，一代表横排，i 代表竖排，o 为正方形，f 代表反转 180 度，)，[作用域：z/l](自身/邻接对象，为空代表没有加成)，[加成类型：a/d/h](攻击/防御/血量，为空默认取a)，[布局预估：p](仅 1x1 相邻加成，实时布局可选展示)
 * 攻击，防御，血量，加成值（没有的可以留空）(共四行，对应绿-蓝-紫-金四个品质)
 * 红法宝示例：
 * 同上，只是属性值只有一行了
 */
const str = `金
---
蕴金戒，1，l，a，p
6，，113，1
9，，285，2
13，，585，3
20，，1135，5
分金刀，2一
12，，225
19，，520
28，，1070
44，，2070
重金短矛，3j
18，3，188
28，4，605
42，7，1255
66，11，2555
重金破阵矛，4i
25，4，200
40，6，640
60，10，1440
95，15，3040
玄金重剑，3i
16，2，338
25，4，755
37，6，1555
58，9，3055
玄金碎甲剑，4j
22，3，400
35，5，940
52，8，1940
82，13，3790
曜金寸刀，3fj
21，，188
33，，555
49，，1255
77，，2555
曜金战身刀，4fj，z，a
28，，250，20
44，，740，20
66，，1640，20
104，，3340，40
蕴金枪，2i
14，，125
22，，370
33，，820
52，，1670
---
金锋无影，5fp，z，a
147，，5900，40
龙渊七星，5p
116，19，6500
三尖两刃，5fj
135，22，5400
如意金箍棒，5j
140，20，5250
金辉裂穹，4i
93，15，5200
朔气飞星，4fj
109，，5150
残虹断影，4j
82，13，5850
北斗天罡枪，4i
98，14，5000
金翎荡云，3j，z，a
79，13，3350，20
亢金贯甲，3i，z，a
70，11，3900，20
===
木
---
枯荣种，1，l，h
，，412，20
，，735，30
，，1235，40
，，2135，50
老山参，2i
12，，225
19，，520
28，，1070
44，，2070
木灵短剑，3fj
18，3，188
28，4，555
42，8，1205
66，13，2455
木灵大宝剑，4j
25，5，150
40，8，540
60，12，1340
95，19，2840
噬元蘑菇，3fj
12，2，538
19，3，1105
28，5，2055
44，8，3805
千瘴断魂琴，4fj，z，a
21，4，400，20
33，6，990，20
49，9，2040，20
77，15，3940，40
千瘴短笛，3j
15，3，338
24，4，805
36，7，1555
57，11，3005
噬元大丽花，4o，z，h
17，3，650，20
27，5，1340，20
40，8，2540，20
63，12，4790，40
木灵匕首，2一
14，，125
22，，370
33，，820
52，，1670
---
五毒俱全，5p，z，h
109，21，6750，50
青阳唤春，5fp
135，27，5150
通幽震魄，5p，z，a
89，17，7950，40
太昊司春，5fp，z，a
148，21，4800，40
掌天奇韵，4o
62，12，6900
蕴剑葫芦，4o
93，18，5050
灵泽衔瑞，4fj
81，16，5750
青枝栖日，4o
103，14，4750
唤声吴钩，3fj，z，h
79，15，3250，60
引仙破道，3j，z，a
68，13，3900，20
===
水
---
流水散，1，l，d
，5，163，40
，8，335，60
，12，635，80
，20，1135，100
净魂刃，2i
11，3，125
17，5，370
25，8，820
39，13，1670
霜华轻剑，3i
16，4，238
25，6，655
37，9，1405
58，14，2805
霜华千影剑，4j，z，a
22，5，300，20
35，8，790，20
52，13，1690，20
82，20，3440，40
冰魄护肩，3fj
14，4，338
22，7，755
33，11，1505
52，17，2955
冰魄凝神甲，4o
18，6，450
28，9，1090
42，14，2140
66，22，4140
急冻瓜锤，3j
14，5，288
22，8，705
33，13，1405
52，20，2805
急冻流星锤，4fj，z，d
19，7，350，50
30，12，840，50
45，18，1790，50
71，28，3590，100
净魂锤，2一
10，4，125
16，6，370
24，9，820
38，15，1620
---
玄冥坠星，5p，z，d
100，40，6250，100
月华清影，5p，z，a
116，29，6000，40
封神奇卷，5fp
93，31，7050
弱水涓扇，5fp
122，17，6300
玄水护心，4o
73，24，5750
凌波惊鸿，4j
82，20，5500
沧溟凝冰，4fj
73，29，5500
晴水华盖，4o
77，11，6200
断流绝响，3i，z，a
70，17，3600，20
逆流河珠，3fj，z，h
62，20，3850，80
===
火
---
炎脉髓，1，l，a，p
6，，113，1
9，，285，2
13，，585，3
20，，1135，4
炼魂唢呐，2i
12，，225
19，，520
28，，1070
44，，2070
至阳火鉴，3fj
18，2，238
28，4，605
42，6，1305
66，9，2655
至阳风火轮，4o，z，a
25，3，250，20
40，5，690，20
60，8，1540，20
95，13，3140，40
炽影长刀，3i
21，3，38
33，4，355
49，7，905
77，11，2005
炽影破锋刀，4fj
27，3，150
43，6，490
64，9，1290
101，14，2790
拜火金锣，3j
21，2，88
33，4，355
49，6，955
77，9，2105
拜火焚星笙，4j，l，a
28，3，100，1
44，5，490，1
66，8，1240，1
104，13，2690，2
燎魂刀，2一
13，，175
20，，470
30，，970
47，，1920
---
乾坤浑天，5j，z，a
135，19，5550，50
南明离炎，5p
147，18，5000
烈阳灼心，5fp
143，20，5100
燃欲燎魂，5j，z，a
139，19，5550，40
食为天鼎，4o
93，13，5300
煫火传薪，4o
93，13，5300
祭火律令，4j
109，13，4500
日巡灼恶，4fj
109，15，4400
炎驹驰天，3fj，z，a
112，16，1550，20
赤霄斩浪，3i，z，a
93，13，2650，20
===
土
---
玄黄令，1，l，a，p
2，，313，1
3，，585，2
4，，1035，3
6，，1835，4
破岩锤，2一
5，，575
8，，1070
12，，1870
19，，3320
撼地重锤，3fj
7，7，538
11，11，1105
16，16，2105
25，25，3905
撼地震魄锤，4fj
10，10，650
16，16，1340
24，24，2540
38，38，4740
坤元大钟，3j
6，1，888
9，2，1655
13，3，2905
20，5，5155
坤元生息铠，4o
9，2，1100
14，3，2090
21，5，3640
33，8，6490
崩山短幡，3fj
5，2，888
8，4，1605
12，6，2805
19，9，5005
崩山裂魂幡，4j
8，4，1050
14，7，1890
21，10，3390
33，16，6090
破岩护臂，2i
5，，575
8，，1070
12，，1870
19，，3320
---
五色炼天，5p
46，11，10400
十方大山，5z
54，54，7850
泰山压顶，5fp
46，23，9800
逐日镇岳，4j
27，13，8600
遁地奇行，4o
28，7，8850
灵獐啸岩，4fj
35，35，7100
萱花裂地，3fj
18，18，6150
石钟灵佑，3j
24，6，6450
===
雷
---
雷灵珠，1
6，，113
9，，285
13，，585
20，，1135
雷灵幡，2i
13，，175
20，，470
30，，970
47，，1920
鸣雷长枪，3fj
19，3，138
30，5，455
45，7，1105
71，11，2305
鸣雷诛邪枪，4j
26，4，150
41，6，590
61，10，1390
96，16，2940
玄阴古筝，3一
17，2，288
27，4，655
40，6，1450
60，10，2755
玄阴霹雳鼓，4o
23，3，350
36，6，840
54，9，1790
85，14，3590
雷元短幡，3j
15，2，388
24，4，805
36，6，1605
57，9，3105
雷元乌龙旗，4fj，z，h
20，3，500，50
32，5，1090，50
48，8，2140，50
76，12，4140，100
鸣雷鼓，2一
11，，275
17，，620
25，，1220
39，，2320
---
阴雷回响，5fp
120，20，6250
五雷号令，5p，z，h
108，18，6950，100
阳雷裂空，5p
136，22，5350
惊雷兽吼，4j
100，16，4800
截雷断运，4o
89，14，5450
九霄镇魔，4fj
81，13，5900
神谕裁罪，3fj，z，a
85，14，3000，20
妙音止戈，3一，z，a
76，12，3550，20
===
邪
---
邪源珠，1
6，，113
9，，285
13，，585
20，，1235
玄阴枪，2i
13,,175
20,,470
30,,970
47,,1920
血灵短矛，3i
20，2，138
32，3，455
48，4，1105
76，7，2255
血灵钻魂枪，4i，z，a
27，2，200，20
43，4，590，20
64，6，1440，20
101，10，2990，40
欢愉短匕，3j
22，2，38
35，3，305
52，5，855
82，8，1905
欢愉蚀骨刃，4fj，z，a
29，2，100，20
46，4，440，20
69，6，1190，20
109，10，2590，20
炼魂小幡，3fj
19，1，238
30，3，555
45，4，1255
71，7，2505
炼魂万千幡，4j
26，2，250
41，4，690
61，6，1590
96，9，3290
玄阴旗，2一
14，，125
22，，370
33，，820
52，，1670
---
合欢极乐，5fp，z，a
154，15，4800，20
凶神戮世，5fj，z，a
143，14，5400，40
酆都帝律，5p
136，13，5800
勾魂索命，4j
100，10，5100
剖心夺爱，4fj
116，11，4250
煞魔血叉，4i
108，10，4700
恶鬼喋血，3i，z，a
91，9，2950，20
花妖魅匕，3j，z，a
99，9，2550，20
===
体
---
大力丸，1，l，d
，5，163，40
，8，335，60
，12，635，80
，20，1135，100
灵兽肉，2一
10，3，175
16，5，420
24，8，87
38，12，1770
罡体腰带，3一
15，3，338
24，6，705
36，9，1455
57，14，2855
罡体不破甲，4o，z，h
20，5，400，30
32，8，940，30
48，12，1940，30
76，19，3790，60
百炼短锤，3j
12，6，338
19，9，805
28，14，1605
44，22，3105
百炼成金锤，4fj，z，d
16，8，450，50
25，12，1090，50
37，18，2190，50
58，29，4190，50
无相念珠，3fj
16，4，238
25，6，655
37，9，1405
58，14，2805
无相渡敌钵，4j
22，5，300
35，8，790
52，13，1690
82，20，3440
九宫牌，2i
8，3，275
12，4，670
18，7，1220
28，11，2320
---
巨灵擎天，5fp，z，d
82，41，7100，50
佛门宝杵，5p
116，29，6000
真武神镯，5p，z，h
108，27，6500，60
天骄伟冠，4o
81，20，5550
酒祖酿厄，4j
82，20，5500
丑匠破阵，4fj
62，31，5950
叱咤玉锤，3j，z，d
53，26，4000，100
叱咤玉革，3一，z，h
68，17，3700，60
`.trim();

/**
 * 解析逻辑：将上面的纯文本图鉴转换为 index.html 中 blocks 的对象格式，
 * 结果保存为项目根目录 data/ 下的 blocks.json。
 * 其中 shape 会直接写入 shapes 的二维数组，数组来自 data/ 的 shapes.json，
 * 因此需要先运行 形状生成工具.js 生成 shapes.json，再运行本脚本。
 *
 * 运行方式：node tools/文本图鉴转对象工具.js
 */
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

// 加载 形状生成工具.js 生成的 shapes.json（键名 -> 二维数组，另含反向映射）
const shapesPath = path.join(dataDir, "shapes.json");
if (!fs.existsSync(shapesPath)) {
	console.error(`缺少 ${shapesPath}\n请先运行：node tools/形状生成工具.js`);
	process.exit(1);
}
const shapes = JSON.parse(fs.readFileSync(shapesPath, "utf8"));

// 文本形状代号 -> shapes 键后缀
const SHAPE_SUFFIX = {
	一: "一",
	i: "I",
	j: "J",
	fj: "反J",
	o: "田",
	p: "P",
	fp: "反P",
	z: "折线",
};
// 作用域代号 -> blocks 中的值（0 无、1 自身、2 相邻）
const SCOPE_MAP = { z: 1, l: 2 };
// 加成类型代号 -> blocks 中的值（0 攻击、1 防御、2 血量）
const BONUS_TYPE_MAP = { a: 0, d: 1, h: 2 };
const TYPE_NAMES = ["金", "木", "水", "火", "土", "雷", "邪", "体"];

const warnings = [];
const blocks = Object.fromEntries(TYPE_NAMES.map((name) => [name, {}]));

let curType = null;
let curSection = null; // "normal" | "red"
let curEntry = null;

const toInt = (s) => {
	const n = parseInt(s, 10);
	return Number.isNaN(n) ? 0 : n;
};

str.split("\n").forEach((rawLine, lineIdx) => {
	const line = rawLine.trim();
	const lineNo = lineIdx + 1;
	if (!line) return;

	if (line === "===") {
		curType = null;
		curSection = null;
		curEntry = null;
		return;
	}
	if (line === "---") {
		if (!curType) {
			warnings.push(`第 ${lineNo} 行：'---' 之前没有大类`);
			return;
		}
		curSection = curSection === null ? "normal" : "red";
		blocks[curType][curSection] = blocks[curType][curSection] || {};
		curEntry = null;
		return;
	}
	if (TYPE_NAMES.includes(line) && !curType) {
		curType = line;
		return;
	}
	if (!curType || !curSection) {
		warnings.push(
			`第 ${lineNo} 行：内容出现在大类或 '---' 之前，已忽略 -> ${line}`,
		);
		return;
	}

	const parts = line.split("，").map((s) => s.trim());

	// 法宝头行：首段是名称（非数字），第二段是形状代号（纯数字代表"点"）
	const shapeMatch = parts[1] && parts[1].match(/^(\d)(一|fj|fp|i|j|o|p|z)?$/);
	const isHeader =
		shapeMatch && parts[0] !== "" && Number.isNaN(Number(parts[0]));
	if (isHeader) {
		const [name, , scopeCode, bonusCode, previewCode] = parts;
		const suffixName = shapeMatch[2] ? SHAPE_SUFFIX[shapeMatch[2]] : "点";
		const shapeKey = `${"零一两三四五六七八九十"[toInt(shapeMatch[1])]}格/${suffixName}`;
		const shape = shapes[shapeKey];
		if (!shape) {
			warnings.push(`第 ${lineNo} 行：未知形状 ${parts[1]}（${name}）`);
			return;
		}
		const bonus =
			scopeCode || bonusCode
				? [BONUS_TYPE_MAP[bonusCode] ?? 0, SCOPE_MAP[scopeCode] ?? 0]
				: [0, 0];
		if (
			(scopeCode && !SCOPE_MAP[scopeCode]) ||
			(bonusCode && !(bonusCode in BONUS_TYPE_MAP)) ||
			(previewCode && previewCode !== "p")
		) {
			warnings.push(
				`第 ${lineNo} 行：未知的作用域/加成代号（${name}）-> ${line}`,
			);
		}
		curEntry = {
			bonus,
			...(previewCode === "p" ? { previewAdjacent: true } : {}),
			value: curSection === "normal" ? [] : null,
			shape,
		};
		if (blocks[curType][curSection][name]) {
			warnings.push(`第 ${lineNo} 行：法宝重名，后者覆盖前者 -> ${name}`);
		}
		blocks[curType][curSection][name] = curEntry;
		return;
	}

	// 数值行：攻击，防御，血量[，加成值]
	if (!curEntry) {
		warnings.push(`第 ${lineNo} 行：数值行之前没有法宝头，已忽略 -> ${line}`);
		return;
	}
	const hasBonus = curEntry.bonus[1] !== 0;
	const values = parts.slice(0, 3).map(toInt);
	if (hasBonus) {
		// 规则：填写了作用域的法宝，每一行属性都必须填写加成值
		if (parts[3] === undefined || parts[3] === "") {
			warnings.push(`第 ${lineNo} 行：有作用域的法宝必须填写加成值 -> ${line}`);
		}
		values.push(
			parts[3] === undefined || parts[3] === "" ? 0 : toInt(parts[3]),
		);
	}

	if (curSection === "normal") {
		curEntry.value.push(values);
	} else {
		if (curEntry.value !== null) {
			warnings.push(
				`第 ${lineNo} 行：红法宝应只有一行属性，后者覆盖前者 -> ${line}`,
			);
		}
		curEntry.value = values;
	}
});

// 完整性校验
Object.entries(blocks).forEach(([type, sections]) => {
	Object.entries(sections.normal || {}).forEach(([name, entry]) => {
		if (entry.value.length !== 4) {
			warnings.push(
				`${type}/${name}：普通法宝应有 4 行属性（绿蓝紫金），实际 ${entry.value.length} 行`,
			);
		}
	});
	Object.entries(sections.red || {}).forEach(([name, entry]) => {
		if (!entry.value) {
			warnings.push(`${type}/${name}：红法宝缺少属性行`);
		}
	});
});

const outPath = path.join(dataDir, "blocks.json");
const jsPath = path.join(dataDir, "blocks.data.js");

// 有任何警告都视为数据有误：不写入新文件，并删除旧文件，避免下游误用过期数据
if (warnings.length) {
	let deleted = 0;
	[outPath, jsPath].forEach((p) => {
		if (fs.existsSync(p)) {
			fs.unlinkSync(p);
			deleted++;
		}
	});
	console.error(
		`发现 ${warnings.length} 条问题，未写入文件${deleted ? `，已删除旧文件 ${deleted} 个` : ""}：`,
	);
	warnings.forEach((w) => console.error(`  - ${w}`));
	process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(blocks, null, "\t") + "\n", "utf8");

// 同步产出 JS 包装版，供 HTML 页面通过 <script src> 直接引入（file:// 下 fetch 受限）
fs.writeFileSync(
	jsPath,
	`// 由 文本图鉴转对象工具.js 自动生成，请勿手改\nvar BLOCKS = ${JSON.stringify(blocks)};\n`,
	"utf8",
);

const count = (obj) => Object.keys(obj || {}).length;
const summary = Object.entries(blocks)
	.map(([type, s]) => `${type}: 普通 ${count(s.normal)} / 红 ${count(s.red)}`)
	.join("\n");
console.log(`已写入 ${outPath} 和 ${jsPath}\n${summary}`);
