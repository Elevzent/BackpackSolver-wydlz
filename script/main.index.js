/** 数据检查 */
let errHtml = "";
const shapesErrMsg = (detail) => `SHAPES 数据有误: ${detail}`;
const blocksErrMsg = (detail) => `BLOCKS 数据有误: ${detail}`;
const doWhenInitErr = (err) => {
	console.error(err);
	errHtml += `<div style="padding: 0 2em; color: var(--color-red); font-size: 1.2em;">${err}</div>`;
};

if (!window.SHAPES || Object.keys(SHAPES).length === 0) {
	doWhenInitErr(shapesErrMsg("数据为空"));
}
if (!window.BLOCKS || Object.keys(BLOCKS).length === 0) {
	doWhenInitErr(blocksErrMsg("数据为空"));
}
if (errHtml) {
	doWhenInitErr('请按 "./README.md" 中的步骤重新生成数据文件');
	document.body.innerHTML = errHtml;
	throw new Error("数据初始化失败");
}

/** 共享常量 */
const els = {
	typeSelect: document.querySelector(".type-select"),
	blockTable: document.querySelector(".block-table tbody"),
	selectedTable: document.querySelector(".selected-block-table tbody"),
	clearBtn: document.querySelector(".selected-block .clear-btn"),
	leftPanel: document.querySelector(".left-panel"),
	selectedPanel: document.querySelector(".selected-block"),
	boardCols: document.querySelector(".board-cols"),
	boardRows: document.querySelector(".board-rows"),
	boardGrid: document.querySelector(".board-grid"),
	layoutGrid: document.querySelector(".layout-grid"),
	layoutPanel: document.querySelector(".layout-panel"),
	applyBoardBtn: document.querySelector(".apply-board-btn"),
	calcBtn: document.querySelector(".calc-btn"),
	modeSelect: document.querySelector(".mode-select"),
	modeHint: document.querySelector(".mode-hint"),
	fillFirst: document.querySelector(".fill-first"),
	fillFirstText: document.querySelector(".fill-first-text"),
	workerCount: document.querySelector(".worker-count"),
	workerMaxHint: document.querySelector(".worker-max-hint"),
	timeLimit: document.querySelector(".calc-time-limit"),
	timeLimitField: document.querySelector(".time-limit-field"),
	timeLimitHint: document.querySelector(".time-limit-hint"),
	recallBtn: document.querySelector(".recall-btn"),
	layoutLegend: document.querySelector(".layout-legend"),
	logScroll: document.querySelector(".log-scroll"),
	logStatus: document.querySelector(".log-status"),
	presetSelect: document.querySelector(".preset-select"),
	presetSaveBtn: document.querySelector(".preset-save-btn"),
	presetDelBtn: document.querySelector(".preset-del-btn"),
	weightAtk: document.querySelector(".weight-atk"),
	weightDef: document.querySelector(".weight-def"),
	weightHp: document.querySelector(".weight-hp"),
	statsCount: document.querySelector(".stats-count"),
	statsCells: document.querySelector(".stats-cells"),
};

// 品质：一阶(绿) -> 二阶(蓝) -> 三阶(紫) -> 四阶(金) -> 五阶(红)
const QUALITY_COLORS = ["green", "blue", "purple", "gold", "red"];
const QUALITY_NAMES = ["一", "二", "三", "四", "五"];

const utils = {
	getQualityColor: (quality) => `c-${QUALITY_COLORS[quality]}`,
	getQualityText: (quality) => `${QUALITY_NAMES[quality]}阶`,
	shape2Html: (shape, quality) => {
		const wrapper = document.createElement("div");
		const box = document.createElement("div");
		const qttColor = utils.getQualityColor(quality);

		wrapper.className = "shape-wrapper";
		box.className = "shape-box";
		wrapper.appendChild(box);

		let colMax = 0;
		shape.forEach((row) => {
			row.forEach((col, idx) => {
				const cell = document.createElement("div");
				cell.className = `shape-item ${col ? qttColor : "empty"}`;
				box.appendChild(cell);
				colMax = Math.max(colMax, idx);
			});
		});
		box.style.gridTemplateColumns = `repeat(${colMax + 1}, 1fr)`;
		return wrapper;
	},
	changeShapeColor: (wrapper, quality) => {
		const qttColor = utils.getQualityColor(quality);
		wrapper.querySelectorAll(".shape-item").forEach((item) => {
			if (item.classList.contains("empty")) return;
			item.className = `shape-item ${qttColor}`;
		});
	},
	formatAttr: (ar) => {
		const wrapper = document.createElement("div");
		[
			["攻", "c-gold", ar[0]],
			["防", "c-blue", ar[1]],
			["血", "c-red", ar[2]],
		].forEach(([label, cls, val]) => {
			const p = document.createElement("p");
			p.className = cls;
			p.textContent = `${label}: ${val}`;
			wrapper.appendChild(p);
		});
		return wrapper;
	},
	formatBonus: (bonus, val) => {
		const [type, scope] = bonus;
		const wrapper = document.createElement("div");
		if (!scope) {
			wrapper.textContent = "无";
			wrapper.className = "c-gray";
		} else {
			const typeVals = ["攻击", "防御", "血量"];
			const scopeVals = ["无", "自身", "相邻"];
			wrapper.textContent = `${scopeVals[scope]}${typeVals[type]}: ${val ?? "?"}%`;
			wrapper.className = ["c-gold", "c-blue", "c-red"][type];
		}

		return wrapper;
	},
	// 品质选择器：fixed 为 true 渲染不可调的固定品质文本（红色法宝）；
	// 否则渲染下拉框，变化时经 onChange(quality) 通知调用方自行更新
	formatQuality: (quality, values, fixed, onChange) => {
		const getClass = (qtt) =>
			`${utils.getQualityColor(qtt)} block-quantity-select`;

		if (fixed || !onChange) {
			const wrapper = document.createElement("div");
			wrapper.textContent = utils.getQualityText(quality);
			wrapper.className = `${getClass(quality)} disabled`;
			return wrapper;
		}

		const select = document.createElement("select");
		values.forEach((_, idx) => {
			const option = document.createElement("option");
			option.value = idx;
			option.text = utils.getQualityText(idx);
			select.appendChild(option);
		});
		select.value = quality;
		select.className = getClass(quality);
		select.addEventListener("change", (e) => {
			const qtt = Number(e.target.value);
			select.className = getClass(qtt);
			onChange(qtt);
		});
		return select;
	},
};

/** 初始化 */
const buildEmptyRow = (colspan, text) => {
	const line = document.createElement("tr");
	const cell = document.createElement("td");
	cell.colSpan = colspan;
	cell.className = "table-empty";
	cell.textContent = text;
	line.appendChild(cell);
	return line;
};

// 数量步进器：原生 number 增减按钮各浏览器表现不一（有的没有），统一换成自定义 − / + 按钮
// （原生 spinner 由 CSS 隐藏）；按住可连续增减；派发 input / change 事件与手动输入等价，既有监听无需改动
function numStepper(ipt) {
	if (ipt.dataset.stepped) return ipt;
	ipt.dataset.stepped = "1";
	const wrap = document.createElement("span");
	wrap.className = "num-stepper";
	ipt.parentNode.insertBefore(wrap, ipt);
	const mkBtn = (cls, text) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `step-btn ${cls}`;
		b.textContent = text;
		// 不抢输入框焦点（移动端避免反复弹键盘）
		b.tabIndex = -1;
		return b;
	};
	const dec = mkBtn("step-dec", "−");
	const inc = mkBtn("step-inc", "+");
	wrap.append(dec, ipt, inc);
	const apply = (dir) => {
		const min = ipt.min === "" ? -Infinity : Number(ipt.min);
		const max = ipt.max === "" ? Infinity : Number(ipt.max);
		const st = Number(ipt.step) || 1;
		let v = Number(ipt.value);
		if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
		v = Math.min(max, Math.max(min, v + dir * st));
		if (String(v) === ipt.value) return;
		ipt.value = v;
		ipt.dispatchEvent(new Event("input", { bubbles: true }));
		ipt.dispatchEvent(new Event("change", { bubbles: true }));
	};
	[
		[dec, -1],
		[inc, 1],
	].forEach(([btn, dir]) => {
		let delay = 0;
		let timer = 0;
		const stop = () => {
			clearTimeout(delay);
			clearInterval(timer);
			delay = timer = 0;
		};
		btn.addEventListener("pointerdown", (e) => {
			// 阻止按钮抢焦点 / 触发页面滚动
			e.preventDefault();
			stop();
			apply(dir);
			delay = setTimeout(() => {
				timer = setInterval(() => apply(dir), 90);
			}, 400);
		});
		["pointerup", "pointerleave", "pointercancel"].forEach((t) =>
			btn.addEventListener(t, stop),
		);
	});
	return ipt;
}

function typeSelectInit() {
	const df = document.createDocumentFragment();
	const types = Object.keys(BLOCKS);
	types.forEach((type) => {
		const option = document.createElement("option");
		option.value = type;
		option.text = type;
		df.appendChild(option);
	});
	els.typeSelect.appendChild(df);

	els.typeSelect.addEventListener("change", (e) => {
		blockTableInit(e.target.value);
	});

	els.typeSelect.value = types[0];
	blockTableInit(types[0]);
}

function blockTableInit(type) {
	const blockObj = BLOCKS[type];
	const df = document.createDocumentFragment();

	// 构建一行法宝数据：values 统一为二维数组（按品质索引），红色法宝只有一档数据，fixed 为 true
	const buildLine = (name, shape, values, bonus, fixed) => {
		const line = document.createElement("tr");
		const cells = Array.from({ length: 7 }, () => {
			const cell = document.createElement("td");
			line.appendChild(cell);
			return cell;
		});
		// 移动端卡片布局的字段名（样式见 style.main.css 卡片媒体查询）；
		// 名称作卡片标题、操作按钮作操作行，无需字段标签
		const labels = ["", "形状", "基础属性", "加成", "品质", "数量", ""];
		cells.forEach((cell, i) => {
			if (labels[i]) cell.dataset.label = labels[i];
		});

		let quality = fixed ? 4 : 3;
		const getAttrs = () => (fixed ? values[0] : values[quality]);

		cells[0].textContent = name;
		cells[1].appendChild(utils.shape2Html(shape, quality));
		cells[2].appendChild(utils.formatAttr(getAttrs()));
		cells[3].appendChild(utils.formatBonus(bonus, getAttrs()[3]));
		cells[4].appendChild(
			utils.formatQuality(quality, values, fixed, (qtt) => {
				quality = qtt;
				utils.changeShapeColor(cells[1], qtt);
				cells[2].replaceChildren(utils.formatAttr(getAttrs()));
				cells[3].replaceChildren(utils.formatBonus(bonus, getAttrs()[3]));
				ipt.value = 1;
			}),
		);

		const ipt = document.createElement("input");
		const btn = document.createElement("button");

		ipt.className = "num-input";
		ipt.type = "number";
		ipt.min = 1;
		ipt.value = 1;
		ipt.addEventListener("change", () => {
			ipt.value = Math.max(1, Number(ipt.value) || 1);
		});
		btn.className = "btn-primary";
		btn.textContent = "添加";

		cells[5].appendChild(ipt);
		numStepper(ipt);
		cells[6].appendChild(btn);

		btn.addEventListener("click", () => {
			addSelectedBlock({
				name,
				type,
				shape,
				bonus,
				values,
				fixed,
				quality,
				nums: Math.max(1, Number(ipt.value) || 1),
			});
		});

		return line;
	};

	Object.entries(blockObj.normal || {}).forEach(([name, detail]) => {
		df.appendChild(
			buildLine(name, detail.shape, detail.value, detail.bonus, false),
		);
	});

	Object.entries(blockObj.red || {}).forEach(([name, detail]) => {
		df.appendChild(
			buildLine(name, detail.shape, [detail.value], detail.bonus, true),
		);
	});

	els.blockTable.innerHTML = "";
	if (!df.childNodes.length) {
		df.appendChild(buildEmptyRow(7, "该属性暂无法宝数据"));
	}
	els.blockTable.appendChild(df);
}

/** 已选列表 */
const selectedBlocks = [];

// 条目的当前属性值：红色法宝固定取唯一一档，普通法宝按品质取
const getItemAttrs = (item) =>
	item.fixed ? item.values[0] : item.values[item.quality];

function addSelectedBlock(item) {
	invalidateBest();
	// 同名同品质的视为相同选项，直接合并数量
	const exist = selectedBlocks.find(
		(it) => it.name === item.name && it.quality === item.quality,
	);
	if (exist) {
		exist.nums += item.nums;
	} else {
		selectedBlocks.push(item);
	}
	renderSelectedBlocks();
}

// 修改品质后可能与已有条目变成相同选项，此时合并并移除自身
function mergeSelectedBlock(item) {
	invalidateBest();
	const idx = selectedBlocks.indexOf(item);
	const dupIdx = selectedBlocks.findIndex(
		(it, i) =>
			i !== idx && it.name === item.name && it.quality === item.quality,
	);
	if (dupIdx !== -1) {
		selectedBlocks[dupIdx].nums += item.nums;
		selectedBlocks.splice(idx, 1);
	}
}

function renderSelectedBlocks() {
	els.selectedTable.innerHTML = "";
	const df = document.createDocumentFragment();

	if (!selectedBlocks.length) {
		df.appendChild(buildEmptyRow(8, "暂无数据，请从法宝列表添加"));
	}

	selectedBlocks.forEach((item, idx) => {
		const line = document.createElement("tr");
		const cells = Array.from({ length: 8 }, () => {
			const cell = document.createElement("td");
			line.appendChild(cell);
			return cell;
		});
		// 同 buildLine：移动端卡片字段名；编号 / 名称 / 操作按钮不加标签
		const labels = ["", "", "形状", "基础属性", "加成", "品质", "数量", ""];
		cells.forEach((cell, i) => {
			if (labels[i]) cell.dataset.label = labels[i];
		});

		cells[0].textContent = idx + 1;
		cells[1].textContent = item.name;
		cells[2].appendChild(utils.shape2Html(item.shape, item.quality));
		cells[3].appendChild(utils.formatAttr(getItemAttrs(item)));
		cells[4].appendChild(utils.formatBonus(item.bonus, getItemAttrs(item)[3]));

		// 品质：普通法宝可调整，红色法宝固定五阶
		cells[5].appendChild(
			utils.formatQuality(item.quality, item.values, item.fixed, (qtt) => {
				item.quality = qtt;
				mergeSelectedBlock(item);
				renderSelectedBlocks();
			}),
		);

		const ipt = document.createElement("input");
		ipt.className = "num-input";
		ipt.type = "number";
		ipt.min = 1;
		ipt.value = item.nums;
		ipt.addEventListener("change", () => {
			item.nums = Math.max(1, Number(ipt.value) || 1);
			ipt.value = item.nums;
			invalidateBest();
			updateSelStats();
		});
		cells[6].appendChild(ipt);
		numStepper(ipt);

		const btn = document.createElement("button");
		btn.className = "btn-primary btn-danger";
		btn.textContent = "删除";
		btn.addEventListener("click", () => {
			selectedBlocks.splice(idx, 1);
			invalidateBest();
			renderSelectedBlocks();
		});
		cells[7].appendChild(btn);

		df.appendChild(line);
	});

	els.selectedTable.appendChild(df);
	updateSelStats();
}

// 格数不满蓝色、刚好绿色、超出黄色
function updateSelStats() {
	const count = selectedBlocks.reduce((s, it) => s + it.nums, 0);
	const used = selectedBlocks.reduce(
		(s, it) => s + it.nums * engShapeOffsets(it.shape).area,
		0,
	);
	const total = boardState.cols * boardState.rows - boardState.disabled.size;
	els.statsCount.textContent = count;
	els.statsCells.textContent = `${used}/${total}`;
	els.statsCells.classList.remove("stats-low", "stats-full", "stats-over");
	const cls =
		used < total ? "stats-low" : used === total ? "stats-full" : "stats-over";
	els.statsCells.classList.add(cls);
}

/** 已选列表：本地方案缓存 */
// 存储结构：索引 key 存元信息列表 [{ key, name, updatedAt }]，具体数据按索引 key 单独存取，可存多组
const PRESET_INDEX_KEY = "fabao-presets:index";
const PRESET_DATA_PREFIX = "fabao-presets:data:";
const PRESET_MAX = 40;

/** 历史最优：回溯 */
// 当前已选列表下的历史最优结果（含日志与棋盘快照）：多次计算只保留最高分。
// 已选列表未入缓存时在内存中维护，随方案保存一并写入本地缓存；
// 已选列表增删改 / 清空、棋盘变更即失效；权重改到与历史最优不一致时也失效
let memBest = null;
// 当前已选列表来源 / 已保存的方案 key：计算出新最优时回写该方案的缓存数据
let activePresetKey = null;

// 当前设置的归一化权重（全 0 按等权 1:1:1，与快照规则一致）
const currentWeights = () => {
	const w = [calcWeights.atk, calcWeights.def, calcWeights.hp];
	return w.every((x) => x === 0) ? [1, 1, 1] : w;
};

// 历史最优的计算权重或目标模式与当前设置不一致（结果对应的是另一个问题）
// 旧缓存没有 fillFirst 字段，按属性优先对待（旧结果本就是在属性优先下算的）
const bestIsStale = () =>
	!!memBest &&
	(String(currentWeights()) !== String(memBest.weights) ||
		!!memBest.fillFirst !== els.fillFirst.checked);

// 无历史最优或计算进行中时禁用（防止回溯内容被实时推送的新最优覆盖）
function updateRecallBtn() {
	els.recallBtn.disabled = !memBest || calcState.running;
}

// 历史最优作废（棋盘 / 权重变更）：已选列表本身没变，
// 与已存方案的关联保留，重新计算后仍回写该方案
function dropBest() {
	memBest = null;
	updateRecallBtn();
}

// 已选列表本身变动（增删改 / 清空）：历史最优作废，
// 同时断开与已存方案的关联（列表已与缓存内容不一致，不再回写）
function invalidateBest() {
	dropBest();
	activePresetKey = null;
}

// 结算时捕获最优结果：result 剔除不可序列化的 ctx，连同日志与棋盘快照一起保存
function captureBest() {
	const logs = [...els.logScroll.querySelectorAll(".log-line")].map((n) => ({
		t: n.textContent,
		c: n.className.replace("log-line", "").trim(),
	}));
	const { ctx, ...result } = engine.best.result;
	return {
		v: 4, // 评分口径版本：4 = 归一化分（min(求和, 密度×7×6参考) 极值）；旧缓存口径不同，分数不可比
		score: engine.best.score,
		weights: engine.snap.weights.slice(), // 判定多次计算的分数是否可比
		fillFirst: !!engine.snap.fillFirst, // 判定目标模式（填满/属性优先）是否一致
		result,
		logs,
		status: els.logStatus.textContent,
		board: {
			cols: boardState.cols,
			rows: boardState.rows,
			disabled: [...boardState.disabled],
		},
	};
}

// 回溯：把历史最优的布局、图例与日志重新展示出来
function recallBest() {
	if (!memBest || calcState.running) return;
	const b = memBest.board;
	renderLayoutSolution(memBest.result, {
		cols: b.cols,
		rows: b.rows,
		disabled: new Set(b.disabled),
	});
	els.logScroll.querySelectorAll(".log-line").forEach((n) => n.remove());
	memBest.logs.forEach((l) => logLine(l.t, l.c));
	// 方案「档案」的计算权重可能与当前设置不一致（权重变更本会让内存最优失效，
	// 但缓存档案不受此限），此时在状态行标注当时的权重，避免误读
	const stale = bestIsStale();
	const wTxt = stale
		? `（计算时权重 攻${fmtNum(memBest.weights[0])}/防${fmtNum(memBest.weights[1])}/血${fmtNum(memBest.weights[2])}）`
		: "";
	logStatus(
		`已回溯历史最优${wTxt}${memBest.status ? `｜${memBest.status}` : ""}`,
	);
	logLine(`已回溯历史最优结果${wTxt}`, "log-sys");
	// 布局面板闪烁一下，让回溯生效有明确反馈
	els.layoutPanel.classList.remove("recall-flash");
	void els.layoutPanel.offsetWidth; // 强制重排，重复点击也能重新触发动画
	els.layoutPanel.classList.add("recall-flash");
}

function presetReadIndex() {
	try {
		const arr = JSON.parse(localStorage.getItem(PRESET_INDEX_KEY) || "[]");
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

function presetRefreshSelect() {
	const list = presetReadIndex();
	const df = document.createDocumentFragment();
	const ph = document.createElement("option");
	ph.value = "";
	ph.textContent = list.length ? "选择已存方案…" : "暂无已存方案";
	df.appendChild(ph);
	list.forEach((p) => {
		const opt = document.createElement("option");
		opt.value = p.key;
		opt.textContent = `${p.name}（${new Date(p.updatedAt).toLocaleString()}）`;
		df.appendChild(opt);
	});
	els.presetSelect.replaceChildren(df);
}

function presetSave() {
	if (!selectedBlocks.length) {
		logLine("已选列表为空，没有可保存的数据", "log-sys");
		return;
	}
	const name = (prompt("为当前已选列表起一个名称：") || "").trim();
	if (!name) return;
	try {
		const list = presetReadIndex();
		const exist = list.find((p) => p.name === name);
		if (exist && !confirm(`已存在同名方案「${name}」，要覆盖吗？`)) {
			return;
		}
		if (!exist && list.length >= PRESET_MAX) {
			logLine(
				`方案数量已达上限 ${PRESET_MAX} 组，请先删除一些方案再保存`,
				"log-sys",
			);
			return;
		}
		const key = exist
			? exist.key
			: Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		// 历史最优（若有）随方案一并缓存，载入后可回溯
		localStorage.setItem(
			PRESET_DATA_PREFIX + key,
			JSON.stringify({ blocks: selectedBlocks, best: memBest }),
		);
		activePresetKey = key;
		if (exist) {
			exist.updatedAt = Date.now();
		} else {
			list.unshift({ key, name, updatedAt: Date.now() });
		}
		localStorage.setItem(PRESET_INDEX_KEY, JSON.stringify(list));
		presetRefreshSelect();
		els.presetSelect.value = key;
		logLine(
			`已保存方案「${name}」，共 ${selectedBlocks.length} 项${memBest ? "（含历史最优结果）" : ""}`,
			"log-sys",
		);
	} catch {
		logLine("保存失败：浏览器本地存储不可用", "log-sys");
	}
}

function presetLoad() {
	const key = els.presetSelect.value;
	if (!key) return;
	try {
		const raw = JSON.parse(
			localStorage.getItem(PRESET_DATA_PREFIX + key) || "null",
		);
		// 兼容旧格式（纯数组，无历史最优）与新格式（{ blocks, best }）
		const data = Array.isArray(raw) ? raw : raw && raw.blocks;
		if (!Array.isArray(data)) throw new Error("bad data");
		data.forEach((it) => {
			if (
				!it ||
				typeof it.name !== "string" ||
				!Array.isArray(it.shape) ||
				typeof it.nums !== "number"
			) {
				throw new Error("bad item");
			}
		});
		selectedBlocks.length = 0;
		data.forEach((it) => selectedBlocks.push(it));
		renderSelectedBlocks();
		// 方案已入缓存：恢复其携带的历史最优，允许直接回溯
		activePresetKey = key;
		memBest =
			!Array.isArray(raw) && raw && raw.best && raw.best.result
				? raw.best
				: null;
		updateRecallBtn();
		logLine(
			`已载入方案，共 ${data.length} 项${memBest ? "，可回溯历史最优" : ""}`,
			"log-sys",
		);
	} catch {
		// 数据解析失败（损坏或版本不兼容）：提示用户并清除该方案，避免残留脏数据导致后续操作异常
		const list = presetReadIndex();
		const target = list.find((p) => p.key === key);
		logLine("载入失败：方案数据不存在或已损坏", "log-sys");
		if (
			confirm(
				`方案「${target ? target.name : key}」的数据解析失败，可能已损坏或与当前版本不兼容。\n是否删除该方案？`,
			)
		) {
			localStorage.removeItem(PRESET_DATA_PREFIX + key);
			localStorage.setItem(
				PRESET_INDEX_KEY,
				JSON.stringify(list.filter((p) => p.key !== key)),
			);
			presetRefreshSelect();
			logLine("已删除损坏的方案数据", "log-sys");
		}
	}
}

function presetDelete() {
	const key = els.presetSelect.value;
	if (!key) return;
	const list = presetReadIndex();
	const target = list.find((p) => p.key === key);
	if (target && !confirm(`确定删除方案「${target.name}」吗？`)) return;
	localStorage.removeItem(PRESET_DATA_PREFIX + key);
	localStorage.setItem(
		PRESET_INDEX_KEY,
		JSON.stringify(list.filter((p) => p.key !== key)),
	);
	presetRefreshSelect();
}

function presetInit() {
	els.presetSaveBtn.addEventListener("click", presetSave);
	els.presetDelBtn.addEventListener("click", presetDelete);
	els.presetSelect.addEventListener("change", () => {
		if (!els.presetSelect.value) return;
		if (
			selectedBlocks.length &&
			!confirm("载入将替换当前已选列表中的数据，是否继续？")
		) {
			els.presetSelect.value = "";
			return;
		}
		presetLoad();
	});
	presetRefreshSelect();
}

/** 棋盘 */
// 已应用的棋盘配置：长(cols) * 宽(rows)，disabled 存放禁用点（"行,列"）
const boardState = {
	cols: 7,
	rows: 6,
	disabled: new Set(),
};

// 编辑草稿：棋盘设置面板的改动实时作用于草稿，点击「应用到布局」才同步到 boardState
const boardDraft = {
	cols: 7,
	rows: 6,
	disabled: new Set(),
};

const BOARD_SIZE_LIMIT = { min: 1, max: 20 };

function renderBoard() {
	const { cols, rows, disabled } = boardDraft;
	const df = document.createDocumentFragment();

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const key = `${r},${c}`;
			const cell = document.createElement("div");
			cell.className = disabled.has(key) ? "board-cell disabled" : "board-cell";
			cell.addEventListener("click", () => {
				if (disabled.has(key)) {
					disabled.delete(key);
				} else {
					disabled.add(key);
				}
				cell.classList.toggle("disabled");
			});
			df.appendChild(cell);
		}
	}

	els.boardGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	els.boardGrid.replaceChildren(df);
}

// 实时布局的棋盘：只读展示已应用配置，渲染 boardState
function renderLayoutBoard() {
	const { cols, rows, disabled } = boardState;
	const df = document.createDocumentFragment();

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cell = document.createElement("div");
			cell.className = disabled.has(`${r},${c}`)
				? "board-cell disabled"
				: "board-cell";
			df.appendChild(cell);
		}
	}

	els.layoutGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	els.layoutGrid.replaceChildren(df);
}

function applyBoardDraft() {
	boardState.cols = boardDraft.cols;
	boardState.rows = boardDraft.rows;
	boardState.disabled = new Set(boardDraft.disabled);
	renderLayoutBoard();
	updateSelStats();
	els.layoutLegend.replaceChildren();
	dropBest();
}

function boardInit() {
	const bindSizeInput = (ipt, key) => {
		ipt.addEventListener("change", () => {
			const { min, max } = BOARD_SIZE_LIMIT;
			const val = Math.min(max, Math.max(min, Number(ipt.value) || min));
			ipt.value = val;
			boardDraft[key] = val;
			renderBoard();
		});
	};
	bindSizeInput(els.boardCols, "cols");
	bindSizeInput(els.boardRows, "rows");
	els.applyBoardBtn.addEventListener("click", applyBoardDraft);
	renderBoard();
	renderLayoutBoard();
}

/** 计算：状态 */
// 计算状态：运行期间锁定「应用到布局」、权重输入、模式 / 线程数 / 耗时上限以及
// 法宝列表 / 已选列表的全部编辑控件（仅可查看），
// 直到用户主动停止、达到耗时上限或计算完成才恢复
const calcState = { running: false };

// 计算目标权重：0 表示不关心该属性
const calcWeights = { atk: 0, def: 0, hp: 0 };

// 快速求解模式固定的耗时上限（秒），不可调整
const QUICK_SOLVE_SEC = 3;
// 混合最优模式下用户自设的耗时上限
let lnsTimeLimitSec = 30;

function setCalcRunning(running) {
	calcState.running = running;
	els.calcBtn.textContent = running ? "停止计算" : "开始计算";
	els.applyBoardBtn.disabled = running;
	els.modeSelect.disabled = running;
	els.fillFirst.disabled = running;
	els.workerCount.disabled = running;
	els.timeLimit.disabled = running;

	[els.weightAtk, els.weightDef, els.weightHp].forEach((ipt) => {
		ipt.disabled = running;
	});

	// 法宝列表与已选列表：禁用所有编辑控件，仅保留查看与滚动
	[els.leftPanel, els.selectedPanel].forEach((panel) => {
		panel.querySelectorAll("select, input, button").forEach((ctrl) => {
			ctrl.disabled = running;
		});
	});

	updateRecallBtn();
}

/** 计算：共享纯函数 */
// 以下函数会被序列化注入 Web Worker，只能依赖参数与彼此，不能引用外层变量
//
// 评分规则（与需求对齐）：
//   相邻 = 两件法宝任意格子上下左右接触（对角不算，同件内部不算）
//   最终属性 = 基础值 × (1 + 自身加成% × 相邻同五行件数 + 收到的相邻加成%之和)
//   Min-Max 标准化 = 最终属性 ÷ 该属性理论极值（buildSnapshot 的 attrsMax：
//     求和上界与密度×7×6 参考上界取较紧者，拍平攻/防/血量级差）
//   总分 = Σ 已摆法宝 Σ属性 (标准化完成度 × 用户权重)，先标准化再加权，两层不合并；
//     满分 = 各属性权重之和（极值为 0 的属性不计），总分 ÷ 满分 = 0~1 完成度

// 形状 -> 格子偏移列表与包围盒
function engShapeOffsets(shape) {
	const offs = [];
	let w = 0;
	shape.forEach((row, r) =>
		row.forEach((v, c) => {
			if (v) {
				offs.push([r, c]);
				w = Math.max(w, c + 1);
			}
		}),
	);
	return { offs, h: shape.length, w, area: offs.length };
}

// 快照 -> 预计算上下文：法宝偏移、周长、合法摆放、按最小格索引等
function engPrepare(snap) {
	const cols = snap.cols;
	const rows = snap.rows;
	const weights = snap.weights;
	const cellCount = rows * cols;
	const disabledSet = new Set(snap.disabled);
	// 各属性归一化系数：1 / 该属性棋盘上限（上限为 0 表示没有法宝提供该属性，不参与计分）
	const invMax = snap.attrsMax.map((v) => (v > 0 ? 1 / v : 0));

	const items = snap.items.map((it, idx) => {
		const s = engShapeOffsets(it.shape);
		// 周长：形状外接边数，等于最多可相邻的法宝件数（上界用）
		const cellSet = new Set(s.offs.map(([r, c]) => r * 1000 + c));
		let per = 0;
		s.offs.forEach(([r, c]) => {
			[
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			].forEach(([dr, dc]) => {
				if (!cellSet.has((r + dr) * 1000 + (c + dc))) per++;
			});
		});
		const base = [it.attrs[0] || 0, it.attrs[1] || 0, it.attrs[2] || 0];
		const pct = it.attrs[3] || 0;
		const selfPct = [0, 0, 0];
		const adjPct = [0, 0, 0];
		if (it.bonus[1] === 1) selfPct[it.bonus[0]] = pct / 100;
		if (it.bonus[1] === 2) adjPct[it.bonus[0]] = pct / 100;
		return {
			idx,
			name: it.name,
			ftype: it.type,
			quality: it.quality,
			offs: s.offs,
			h: s.h,
			w: s.w,
			area: s.area,
			per,
			base,
			// 加权基础分（贪心排序用）：base × invMax 是 Min-Max 标准化，× weights 是加权，两层不合并
			wbase:
				base[0] * invMax[0] * weights[0] +
				base[1] * invMax[1] * weights[1] +
				base[2] * invMax[2] * weights[2],
			selfPct,
			adjPct,
			max: it.max,
		};
	});

	// 各五行的相邻加成比例总和（LNS 修复上界用）
	const typeAdjSum = {};
	items.forEach((p) => {
		const s = typeAdjSum[p.ftype] || (typeAdjSum[p.ftype] = [0, 0, 0]);
		s[0] += p.adjPct[0];
		s[1] += p.adjPct[1];
		s[2] += p.adjPct[2];
	});

	// 全部合法摆放（不考虑占用），byMin 按摆放的最小格子编号索引
	const placements = [];
	const byMin = [];
	items.forEach((p) => {
		const list = [];
		const bm = new Map();
		for (let r = 0; r <= rows - p.h; r++) {
			for (let c = 0; c <= cols - p.w; c++) {
				const cells = p.offs.map(([dr, dc]) => (r + dr) * cols + (c + dc));
				if (cells.some((ci) => disabledSet.has(ci))) continue;
				const minCell = Math.min.apply(null, cells);
				if (!bm.has(minCell)) bm.set(minCell, []);
				bm.get(minCell).push(list.length);
				list.push({ r, c, cells, minCell });
			}
		}
		placements.push(list);
		byMin.push(bm);
	});

	return {
		cols,
		rows,
		cellCount,
		freeCells: cellCount - snap.disabled.length,
		items,
		placements,
		byMin,
		weights,
		invMax,
		typeAdjSum,
		minArea: Math.min.apply(
			null,
			items.map((p) => p.area),
		),
	};
}

// 与实例 self 相邻（格子上下左右接触）的其他实例编号集合
function engAdjIds(ctx, occ, cells, self) {
	const adj = new Set();
	const tryAdd = (ni) => {
		const v = occ[ni];
		if (v >= 0 && v !== self) adj.add(v);
	};
	cells.forEach((ci) => {
		const r = Math.floor(ci / ctx.cols);
		const c = ci % ctx.cols;
		if (r > 0) tryAdd(ci - ctx.cols);
		if (r < ctx.rows - 1) tryAdd(ci + ctx.cols);
		if (c > 0) tryAdd(ci - 1);
		if (c < ctx.cols - 1) tryAdd(ci + 1);
	});
	return adj;
}

// 实例 i 的加权贡献（occ 中 >=0 的值为实例编号）
function engContrib(ctx, occ, insts, i) {
	const p = ctx.items[insts[i].item];
	const adj = engAdjIds(ctx, occ, insts[i].cells, i);
	let same = 0;
	const recv = [0, 0, 0];
	adj.forEach((j) => {
		const q = ctx.items[insts[j].item];
		if (q.ftype !== p.ftype) return;
		same++;
		recv[0] += q.adjPct[0];
		recv[1] += q.adjPct[1];
		recv[2] += q.adjPct[2];
	});
	// 先算各属性原始最终值，再 Min-Max 标准化（× invMax 即 ÷ 理论极值），最后乘用户权重：
	// 保持「先标准化（除法消除量纲）→ 再加权（表达设计意图）」两层结构，不合并成单层权重。
	// 注意：这是退火最内层热函数（每次移动对每个受影响法宝调用），
	// 必须零分配——用三个标量而不是数组，否则 GC 压力会拖垮迭代速度
	const r0 = p.base[0] * (1 + p.selfPct[0] * same + recv[0]);
	const r1 = p.base[1] * (1 + p.selfPct[1] * same + recv[1]);
	const r2 = p.base[2] * (1 + p.selfPct[2] * same + recv[2]);
	return (
		r0 * ctx.invMax[0] * ctx.weights[0] +
		r1 * ctx.invMax[1] * ctx.weights[1] +
		r2 * ctx.invMax[2] * ctx.weights[2]
	);
}

/** 计算：主线程全量评分（含结算明细） */
// layout: [{ item, r, c }]，r/c 为包围盒左上角
function engScoreLayout(snap, layout) {
	const ctx = engPrepare(snap);
	const occ = new Int16Array(ctx.cellCount).fill(-1);
	snap.disabled.forEach((ci) => {
		occ[ci] = -2;
	});
	const insts = layout.map((pl, i) => {
		const p = ctx.items[pl.item];
		const cells = p.offs.map(([dr, dc]) => (pl.r + dr) * ctx.cols + pl.c + dc);
		cells.forEach((ci) => {
			occ[ci] = i;
		});
		return { item: pl.item, cells, r: pl.r, c: pl.c };
	});

	const details = insts.map((inst, i) => {
		const p = ctx.items[inst.item];
		const adj = engAdjIds(ctx, occ, inst.cells, i);
		let same = 0;
		const recv = [0, 0, 0];
		const recvDetail = [[], [], []];
		adj.forEach((j) => {
			const q = ctx.items[insts[j].item];
			if (q.ftype !== p.ftype) return;
			same++;
			for (let a = 0; a < 3; a++) {
				if (q.adjPct[a] > 0) {
					recv[a] += q.adjPct[a];
					recvDetail[a].push({ name: q.name, pct: q.adjPct[a] * 100 });
				}
			}
		});
		const finals = [0, 1, 2].map(
			(j) => p.base[j] * (1 + p.selfPct[j] * same + recv[j]),
		);
		return { inst, p, same, recv, recvDetail, finals };
	});

	const totals = [0, 0, 0];
	details.forEach((d) => {
		totals[0] += d.finals[0];
		totals[1] += d.finals[1];
		totals[2] += d.finals[2];
	});
	// Min-Max 标准化：各属性完成度 = 实际总值 ÷ 理论极值（× invMax 即 ÷ attrsMax）
	const invMax = snap.attrsMax.map((v) => (v > 0 ? 1 / v : 0));
	const norms = [
		totals[0] * invMax[0],
		totals[1] * invMax[1],
		totals[2] * invMax[2],
	];
	// 再乘用户权重：保持「先标准化（除法消除量纲）→ 再加权（表达设计意图）」两层结构
	const score =
		norms[0] * snap.weights[0] +
		norms[1] * snap.weights[1] +
		norms[2] * snap.weights[2];
	const maxScore = snap.weights.reduce(
		(s, w, j) => s + (invMax[j] > 0 ? w : 0),
		0,
	);
	return { score, maxScore, totals, details, insts, ctx };
}

/** 计算：Worker 驱动 */
// 该函数整体经 toString() 序列化后与上面的 eng* 纯函数拼接，
// 经 Blob URL 创建 Worker 执行，保持单文件。
// 函数体内只能依赖参数、Worker 全局对象与 eng* 纯函数，不能引用外层变量
function engWorkerMain() {
	"use strict";
	let ctx = null;
	let snap = null;
	let stopped = false;
	let rand = Math.random;
	let WID = 0;

	function rng32(seed) {
		return function () {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	self.onmessage = (e) => {
		const m = e.data;
		if (m.type === "start") {
			snap = m.snap;
			ctx = engPrepare(snap);
			stopped = false;
			WID = m.wid;
			rand = rng32(m.seed >>> 0 || 1);
			annealRun();
		} else if (m.type === "stop") {
			stopped = true;
		}
	};

	// 启发式：贪心构造初始解 + 模拟退火
	function annealRun() {
		const items = ctx.items;
		const placements = ctx.placements;
		const units = [];
		items.forEach((p) => {
			for (let k = 0; k < p.max; k++) {
				units.push({ item: p.idx, cells: null, pr: null, contrib: 0 });
			}
		});
		const n = units.length;
		const occ = new Int16Array(ctx.cellCount).fill(-1);
		snap.disabled.forEach((ci) => {
			occ[ci] = -2;
		});
		let score = 0;
		let iter = 0;
		let bestScore = 0;
		let bestLayout = [];
		let lastBestSent = -1;
		let repairs = 0; // LNS 修复成功次数（混合模式）
		let lnsAttempts = 0; // LNS 实际执行的修复次数（缓存命中跳过不计）
		let lastRepair = 0;
		let lastImproveAt = 0; // 全局最优最近一次刷新的时刻，LNS 只在平台期触发
		const repairFailCache = new Set(); // 无改进的摧毁组合缓存（键含 bestScore，best 一变自动失效）

		// 混合模式：LNS（周期性摧毁 + 小规模精确修复）
		// 每 LNS_PERIOD 毫秒从历史最优布局摧毁 k 件，保留件固定（参与相邻加成），
		// 被毁件在空格内做带剪枝的精确修复搜索；预算 LNS_REPAIR_MS / LNS_REPAIR_NODES，
		// anytime：超时保留已找到的更优解。修复解采纳为退火新起点。
		// 修复搜索内部：DFS 只分支多格件（min-cell 顺序强制，同种副本无排列重复），
		// 单格件在叶子贪心补位；LP 面积帽 + 连通空区两级上界剪枝；
		// 无改进的摧毁组合进失败缓存，避免同 best 下重复空跑。
		const LNS_PERIOD = 3000;
		const LNS_REPAIR_MS = 300;
		const LNS_REPAIR_NODES = 300000;
		// 每件法宝的贡献上界：基础 × (1 + (自身加成 + 同五行相邻加成总和) × 周长)，
		// 再按「先标准化 → 再加权」折算（两种模式的 fillW 都由此推导，因此都算）
		const maxC = items.map((p) => {
			const tas = ctx.typeAdjSum[p.ftype];
			let s = 0;
			for (let j = 0; j < 3; j++) {
				const raw = p.base[j] * (1 + (p.selfPct[j] + tas[j]) * p.per);
				s += raw * ctx.invMax[j] * ctx.weights[j];
			}
			return s;
		});
		// 两种目标模式都用「复合分 = 属性分 + 已占格数 × fillW」实现字典序：
		// 填满优先：fillW = BIG（属性分理论上界 + 1），任何一格的占满都优先于属性分差异；
		// 属性优先：fillW = EPS（足够小），任何有实际意义的属性分差异都优先于整盘格数，
		//   空格填充只作次级目标——属性分打满后剩余棋子仍会尽量补进空位，而不是直接留空。
		// EPS 下限 1e-6：要高于 Worker 内 1e-9 的判优阈值，仅多占一格也能触发最优刷新
		const attrScoreCap =
			Math.ceil(items.reduce((s, p) => s + maxC[p.idx] * p.max, 0)) + 1;
		const fillW = snap.fillFirst
			? attrScoreCap
			: Math.max(attrScoreCap * 1e-9, 1e-6);
		// LNS 剪枝上界同步：每件上界补上空占的 area × fillW 部分（两种模式 fillW 均大于 0），
		// eOrder / densOrder / lpBound / tightBound 由此全部自动落在复合分尺度上
		items.forEach((p) => {
			maxC[p.idx] += p.area * fillW;
		});
		// 修复搜索按贡献上界降序尝试法宝，anytime 表现更好
		const eOrder =
			snap.mode === "lns"
				? items.map((p) => p.idx).sort((a, b) => maxC[b] - maxC[a])
				: null;
		// 单格件延后分配：DFS 只分支多格件，单格件在叶子贪心补位
		const multiOrder =
			snap.mode === "lns" ? eOrder.filter((e) => items[e].area > 1) : null;
		const singleOrder =
			snap.mode === "lns" ? eOrder.filter((e) => items[e].area === 1) : null;
		// LP 上界用：按贡献密度 maxC/area 降序做分数背包
		const densOrder =
			snap.mode === "lns"
				? items
						.map((p) => p.idx)
						.sort((a, b) => maxC[b] / items[b].area - maxC[a] / items[a].area)
				: null;

		// 尝试摆放：占用合法则临时放上并返回增量信息，否则返回 null
		function tryPlace(u, ui, pr) {
			const cells = pr.cells;
			for (let i = 0; i < cells.length; i++) {
				if (occ[cells[i]] !== -1) return null;
			}
			const aff = engAdjIds(ctx, occ, cells, ui);
			aff.add(ui);
			let oldSum = 0;
			aff.forEach((a) => {
				oldSum += units[a].contrib;
			});
			cells.forEach((ci) => {
				occ[ci] = ui;
			});
			u.cells = cells;
			u.pr = pr;
			let newSum = 0;
			const newC = [];
			aff.forEach((a) => {
				const c = engContrib(ctx, occ, units, a);
				newC.push([a, c]);
				newSum += c;
			});
			return {
				delta: newSum - oldSum + cells.length * fillW,
				cells,
				newC,
			};
		}
		function applyPlace(u, res) {
			res.newC.forEach(([a, c]) => {
				units[a].contrib = c;
			});
			score += res.delta;
		}
		function undoPlace(u, res) {
			res.cells.forEach((ci) => {
				occ[ci] = -1;
			});
			u.cells = null;
			u.pr = null;
		}
		function tryRemove(u, ui) {
			const aff = engAdjIds(ctx, occ, u.cells, ui);
			aff.add(ui);
			let oldSum = 0;
			aff.forEach((a) => {
				oldSum += units[a].contrib;
			});
			const cells = u.cells;
			const pr = u.pr;
			cells.forEach((ci) => {
				occ[ci] = -1;
			});
			u.cells = null;
			u.pr = null;
			let newSum = 0;
			const newC = [];
			aff.forEach((a) => {
				const c = a === ui ? 0 : engContrib(ctx, occ, units, a);
				newC.push([a, c]);
				newSum += c;
			});
			return {
				delta: newSum - oldSum - cells.length * fillW,
				cells,
				pr,
				newC,
			};
		}
		function applyRemove(res) {
			res.newC.forEach(([a, c]) => {
				units[a].contrib = c;
			});
			score += res.delta;
		}
		function undoRemove(u, ui, res) {
			res.cells.forEach((ci) => {
				occ[ci] = ui;
			});
			u.cells = res.cells;
			u.pr = res.pr;
		}
		function tryMove(u, ui, pr) {
			const oldCells = u.cells;
			const prOld = u.pr;
			for (let i = 0; i < pr.cells.length; i++) {
				const ci = pr.cells[i];
				if (occ[ci] !== -1 && occ[ci] !== ui) return null;
			}
			const aff = engAdjIds(ctx, occ, oldCells, ui);
			oldCells.forEach((ci) => {
				occ[ci] = -1;
			});
			engAdjIds(ctx, occ, pr.cells, ui).forEach((a) => aff.add(a));
			aff.add(ui);
			let oldSum = 0;
			aff.forEach((a) => {
				oldSum += units[a].contrib;
			});
			pr.cells.forEach((ci) => {
				occ[ci] = ui;
			});
			u.cells = pr.cells;
			u.pr = pr;
			let newSum = 0;
			const newC = [];
			aff.forEach((a) => {
				const c = engContrib(ctx, occ, units, a);
				newC.push([a, c]);
				newSum += c;
			});
			return {
				delta: newSum - oldSum,
				oldCells,
				newCells: pr.cells,
				prOld,
				newC,
			};
		}
		function applyMove(res) {
			res.newC.forEach(([a, c]) => {
				units[a].contrib = c;
			});
			score += res.delta;
		}
		function undoMove(u, ui, res) {
			res.newCells.forEach((ci) => {
				occ[ci] = -1;
			});
			res.oldCells.forEach((ci) => {
				occ[ci] = ui;
			});
			u.cells = res.oldCells;
			u.pr = res.prOld;
		}
		function snapshotLayout() {
			const out = [];
			units.forEach((u) => {
				if (u.cells) out.push({ item: u.item, r: u.pr.r, c: u.pr.c });
			});
			return out;
		}

		// LNS：把修复后的布局采纳为退火当前状态（逐件重新摆放，增量重算贡献）
		function adoptLayout(lay) {
			units.forEach((u) => {
				u.cells = null;
				u.pr = null;
				u.contrib = 0;
			});
			occ.fill(-1);
			snap.disabled.forEach((ci) => {
				occ[ci] = -2;
			});
			score = 0;
			const used = new Set();
			lay.forEach((pl) => {
				let ui = -1;
				for (let i = 0; i < units.length; i++) {
					if (!used.has(i) && units[i].item === pl.item) {
						ui = i;
						break;
					}
				}
				if (ui < 0) return;
				used.add(ui);
				const pr = placements[pl.item].find(
					(p) => p.r === pl.r && p.c === pl.c,
				);
				if (!pr) return;
				const res = tryPlace(units[ui], ui, pr);
				if (res) applyPlace(units[ui], res);
			});
		}

		// LNS 修复：从历史最优布局移除 removed（下标集合）后，
		// 保留件固定，被毁件在空格内做分支限界搜索。
		// 三个从精确求解器借鉴的强化：
		// 1) 单格件延后分配：DFS 只分支多格件，叶子处按真实贡献贪心补单格
		//    （放单格总是正收益，部分解必被其补全支配，因此只在叶子评估候选）；
		// 2) LP 上界：剩余件按密度 maxC/area 降序做分数背包，面积帽收紧；
		// 3) 连通空区剪枝：存活节点算最大连通空区，放不下的大件从上界剔除。
		// 返回严格更优解（improved: true）或同分替代解（improved: false），都没有则 null
		function lnsRepair(removed) {
			const baseScore = bestScore;
			const insts = [];
			const occ2 = new Int16Array(ctx.cellCount).fill(-1);
			snap.disabled.forEach((ci) => {
				occ2[ci] = -3;
			});
			const rem = items.map(() => 0); // 多格件剩余副本数
			const remS = items.map(() => 0); // 单格件剩余副本数
			const kept = [];
			bestLayout.forEach((pl, i) => {
				if (removed.has(i)) {
					if (items[pl.item].area === 1) remS[pl.item]++;
					else rem[pl.item]++;
					return;
				}
				const p = items[pl.item];
				const cells = p.offs.map(
					([dr, dc]) => (pl.r + dr) * ctx.cols + (pl.c + dc),
				);
				cells.forEach((ci) => {
					occ2[ci] = insts.length;
				});
				insts.push({ item: pl.item, cells, contrib: 0 });
				kept.push(pl);
			});
			let cur = 0;
			insts.forEach((ins, i) => {
				ins.contrib = engContrib(ctx, occ2, insts, i);
				cur += ins.contrib;
			});
			const freeList = [];
			for (let ci = 0; ci < ctx.cellCount; ci++) {
				if (occ2[ci] === -1) freeList.push(ci);
			}
			let freeCnt = freeList.length;
			// 填满优先：保留件的占格部分（面积 × BIG）先计入复合分当前值
			cur += (ctx.freeCells - freeCnt) * fillW;
			let remMultiTotal = rem.reduce((a, b) => a + b, 0);
			let remSTotal = remS.reduce((a, b) => a + b, 0);
			const added = []; // 已补放实例 { item, r, c }
			let best = baseScore;
			let bestAdds = null;
			let bestAny = -1; // 子问题最优（不高于全局最优时作为同分替代候选）
			let bestAnyAdds = null;
			let nodes = 0;
			let aborted = false;
			const tEnd = Date.now() + LNS_REPAIR_MS;

			function placeInst2(e, pr) {
				const id = insts.length;
				const aff = engAdjIds(ctx, occ2, pr.cells, id);
				aff.add(id);
				let oldSum = 0;
				aff.forEach((a) => {
					if (a < insts.length) oldSum += insts[a].contrib;
				});
				pr.cells.forEach((ci) => {
					occ2[ci] = id;
				});
				insts.push({ item: e, cells: pr.cells, contrib: 0 });
				if (items[e].area === 1) {
					remS[e]--;
					remSTotal--;
				} else {
					rem[e]--;
					remMultiTotal--;
				}
				freeCnt -= pr.cells.length;
				let newSum = 0;
				aff.forEach((a) => {
					const c = engContrib(ctx, occ2, insts, a);
					insts[a].contrib = c;
					newSum += c;
				});
				cur += newSum - oldSum + pr.cells.length * fillW;
				added.push({ item: e, r: pr.r, c: pr.c });
			}
			function undoInst2(e, pr) {
				const id = insts.length - 1;
				const aff = engAdjIds(ctx, occ2, pr.cells, id);
				aff.add(id);
				let oldSum = 0;
				aff.forEach((a) => {
					oldSum += insts[a].contrib;
				});
				pr.cells.forEach((ci) => {
					occ2[ci] = -1;
				});
				insts.pop();
				if (items[e].area === 1) {
					remS[e]++;
					remSTotal++;
				} else {
					rem[e]++;
					remMultiTotal++;
				}
				freeCnt += pr.cells.length;
				let newSum = 0;
				aff.forEach((a) => {
					if (a === id) return;
					const c = engContrib(ctx, occ2, insts, a);
					insts[a].contrib = c;
					newSum += c;
				});
				cur += newSum - oldSum - pr.cells.length * fillW;
				added.pop();
			}
			// LP 上界：当前分 + 剩余件按密度降序的分数背包（面积帽为剩余空格数）
			function lpBound() {
				let b = cur,
					f = freeCnt;
				for (let oi = 0; oi < densOrder.length && f > 0; oi++) {
					const e = densOrder[oi];
					const a = items[e].area;
					const r = a === 1 ? remS[e] : rem[e];
					if (r <= 0) continue;
					const take = Math.min(r, f / a);
					b += take * maxC[e];
					f -= take * a;
				}
				return b;
			}
			const vis = new Uint8Array(ctx.cellCount);
			// 收紧上界：最大连通空区放不下的多格件不可能再摆，从 LP 中剔除
			function tightBound() {
				vis.fill(0);
				let compMax = 0;
				for (let i = 0; i < freeList.length; i++) {
					const s = freeList[i];
					if (occ2[s] !== -1 || vis[s]) continue;
					let size = 0;
					const stack = [s];
					vis[s] = 1;
					while (stack.length) {
						const ci = stack.pop();
						size++;
						const r = (ci / ctx.cols) | 0,
							c = ci % ctx.cols;
						if (r > 0 && occ2[ci - ctx.cols] === -1 && !vis[ci - ctx.cols]) {
							vis[ci - ctx.cols] = 1;
							stack.push(ci - ctx.cols);
						}
						if (
							r + 1 < ctx.rows &&
							occ2[ci + ctx.cols] === -1 &&
							!vis[ci + ctx.cols]
						) {
							vis[ci + ctx.cols] = 1;
							stack.push(ci + ctx.cols);
						}
						if (c > 0 && occ2[ci - 1] === -1 && !vis[ci - 1]) {
							vis[ci - 1] = 1;
							stack.push(ci - 1);
						}
						if (c + 1 < ctx.cols && occ2[ci + 1] === -1 && !vis[ci + 1]) {
							vis[ci + 1] = 1;
							stack.push(ci + 1);
						}
					}
					if (size > compMax) compMax = size;
				}
				let b = cur,
					f = freeCnt;
				for (let oi = 0; oi < densOrder.length && f > 0; oi++) {
					const e = densOrder[oi];
					const a = items[e].area;
					const r = a === 1 ? remS[e] : rem[e];
					if (r <= 0 || a > compMax) continue;
					const take = Math.min(r, f / a);
					b += take * maxC[e];
					f -= take * a;
				}
				return b;
			}
			// 单格件贪心补位：每件逐格试放，取真实贡献增量最大的空格
			const compPrs = [];
			function completeSingles() {
				for (let oi = 0; oi < singleOrder.length; oi++) {
					const e = singleOrder[oi];
					while (remS[e] > 0) {
						let bestCi = -1,
							bestDelta = -Infinity;
						for (let fi = 0; fi < freeList.length; fi++) {
							const ci = freeList[fi];
							if (occ2[ci] !== -1) continue;
							const pr = {
								cells: [ci],
								r: (ci / ctx.cols) | 0,
								c: ci % ctx.cols,
							};
							const before = cur;
							placeInst2(e, pr);
							const d = cur - before;
							undoInst2(e, pr);
							if (d > bestDelta) {
								bestDelta = d;
								bestCi = ci;
							}
						}
						if (bestCi < 0) break;
						const pr = {
							cells: [bestCi],
							r: (bestCi / ctx.cols) | 0,
							c: bestCi % ctx.cols,
						};
						placeInst2(e, pr);
						compPrs.push({ e, pr });
					}
				}
			}
			function undoCompletion() {
				while (compPrs.length) {
					const x = compPrs.pop();
					undoInst2(x.e, x.pr);
				}
			}
			function recordCandidate() {
				if (cur > best + 1e-9) {
					best = cur;
					bestAdds = added.slice();
				}
				if (cur > bestAny + 1e-9) {
					bestAny = cur;
					bestAnyAdds = added.slice();
				}
			}
			let ptr = 0;
			function dfs() {
				nodes++;
				if (
					(nodes & 1023) === 0 &&
					(nodes > LNS_REPAIR_NODES || Date.now() > tEnd)
				) {
					aborted = true;
					return;
				}
				while (ptr < freeList.length && occ2[freeList[ptr]] !== -1) ptr++;
				if (ptr >= freeList.length || remMultiTotal === 0) {
					// 叶子：多格件已定（或无空格），补上单格件即为完整候选
					completeSingles();
					recordCandidate();
					undoCompletion();
					return;
				}
				if (lpBound() < best - 1e-9) return;
				if (tightBound() < best - 1e-9) return;
				const cell = freeList[ptr];
				for (let oi = 0; oi < multiOrder.length; oi++) {
					const e = multiOrder[oi];
					if (rem[e] <= 0) continue;
					const pis = ctx.byMin[e].get(cell);
					if (!pis) continue;
					for (let x = 0; x < pis.length; x++) {
						const pr = placements[e][pis[x]];
						let ok = true;
						for (let y = 0; y < pr.cells.length; y++) {
							if (occ2[pr.cells[y]] !== -1) {
								ok = false;
								break;
							}
						}
						if (!ok) continue;
						placeInst2(e, pr);
						const sp = ptr;
						dfs();
						ptr = sp;
						undoInst2(e, pr);
						if (aborted) return;
					}
				}
				// 跳过分支：该格不作为任何多格件的最小格（仍可供单格件使用或留空）
				const sp = ptr;
				ptr++;
				dfs();
				ptr = sp;
			}
			dfs();
			if (bestAdds) {
				return {
					improved: true,
					score: best,
					layout: kept.concat(bestAdds),
				};
			}
			if (bestAnyAdds && bestAny >= baseScore - 1e-9) {
				return {
					improved: false,
					score: bestAny,
					layout: kept.concat(bestAnyAdds),
				};
			}
			return null;
		}

		// LNS：平台期触发（全局最优 LNS_PERIOD 毫秒未刷新），每周期 1 次摧毁-修复。
		// 摧毁：50% 随机选 k 件（2~6），50% 选一个连通区域（BFS 扩到 k 件）。
		// 有严格改进则更新最优并采纳为退火新起点；
		// 无改进时 30% 概率采纳同分替代布局（中性移动，换盆跳出平台期）。
		function lnsCycle() {
			const placed = bestLayout.length;
			if (placed < 2) return;
			const k = Math.min(2 + ((rand() * 5) | 0), placed);
			const removed = new Set();
			if (rand() < 0.5) {
				while (removed.size < k) removed.add((rand() * placed) | 0);
			} else {
				const occTmp = new Int16Array(ctx.cellCount).fill(-1);
				const cellsOf = [];
				bestLayout.forEach((pl, i) => {
					const p = items[pl.item];
					const cells = p.offs.map(
						([dr, dc]) => (pl.r + dr) * ctx.cols + (pl.c + dc),
					);
					cellsOf.push(cells);
					cells.forEach((ci) => {
						occTmp[ci] = i;
					});
				});
				const queue = [(rand() * placed) | 0];
				removed.add(queue[0]);
				while (queue.length && removed.size < k) {
					const c2 = queue.shift();
					engAdjIds(ctx, occTmp, cellsOf[c2], c2).forEach((j) => {
						if (!removed.has(j) && removed.size < k) {
							removed.add(j);
							queue.push(j);
						}
					});
				}
			}
			const cacheKey =
				bestScore.toFixed(6) +
				"|" +
				[...removed].sort((a, b) => a - b).join(",");
			if (repairFailCache.has(cacheKey)) return;
			lnsAttempts++;
			const res = lnsRepair(removed);
			if (!res || !res.improved) {
				// 失败缓存：同一 best（同分即同布局）下同一摧毁组合无改进，
				// 短期内重跑结果相同，跳过；FIFO 封顶，旧失败最终会被重试
				if (repairFailCache.size >= 500)
					repairFailCache.delete(repairFailCache.keys().next().value);
				repairFailCache.add(cacheKey);
			}
			if (!res) return;
			if (res.improved) {
				repairs++;
				bestScore = res.score;
				bestLayout = res.layout;
				lastImproveAt = Date.now();
				adoptLayout(res.layout);
				return;
			}
			if (rand() < 0.3) adoptLayout(res.layout);
		}

		// 贪心初始解：按加权价值密度（带随机扰动）降序，各取采样到的最优位置
		function greedyInit() {
			const order = units.map((u, i) => ({
				u,
				i,
				key: (items[u.item].wbase / items[u.item].area) * (0.6 + 0.8 * rand()),
			}));
			order.sort((a, b) => b.key - a.key);
			order.forEach((o) => {
				const pl = placements[o.u.item];
				if (!pl.length) return;
				let best = null;
				for (let k = 0; k < 50; k++) {
					const pr = pl[(rand() * pl.length) | 0];
					const res = tryPlace(o.u, o.i, pr);
					if (res) {
						if (!best || res.delta > best.res.delta) {
							best = { pr, res };
						}
						undoPlace(o.u, res);
					}
				}
				if (best && best.res.delta > 0) {
					const r2 = tryPlace(o.u, o.i, best.pr);
					if (r2) applyPlace(o.u, r2);
				}
			});
			bestScore = score;
			bestLayout = snapshotLayout();
			lastImproveAt = Date.now();
		}

		function step(T) {
			iter++;
			const ui = (rand() * n) | 0;
			const u = units[ui];
			const pl = placements[u.item];
			if (!pl.length) return;
			let res = null;
			let kind = 0;
			if (u.cells) {
				if (rand() < 0.65) {
					res = tryMove(u, ui, pl[(rand() * pl.length) | 0]);
					kind = 1;
				} else {
					res = tryRemove(u, ui);
					kind = 2;
				}
			} else {
				res = tryPlace(u, ui, pl[(rand() * pl.length) | 0]);
				kind = 3;
			}
			if (!res) return;
			if (res.delta >= 0 || rand() < Math.exp(res.delta / T)) {
				if (kind === 1) applyMove(res);
				else if (kind === 2) applyRemove(res);
				else applyPlace(u, res);
				if (score > bestScore + 1e-9) {
					bestScore = score;
					bestLayout = snapshotLayout();
					lastImproveAt = Date.now();
				}
			} else {
				if (kind === 1) undoMove(u, ui, res);
				else if (kind === 2) undoRemove(u, ui, res);
				else undoPlace(u, res);
			}
		}

		greedyInit();
		lastBestSent = bestScore;
		postMessage({
			type: "best",
			wid: WID,
			score: bestScore,
			layout: bestLayout,
		});
		const t0 = Date.now();
		// 初始温度随初始分尺度自适应（归一化后分数量级远小于 1，不再用绝对下限）
		const T0 = Math.max(1e-6, score * 0.03);
		// 退火周期与耗时上限联动：有限时长内安排 4 个周期（重热 3 次），周期间按 0.6 衰减重热；不限时按 30 秒一周期
		const CYCLE =
			snap.timeLimitSec > 0
				? Math.max(2000, (snap.timeLimitSec * 1000) / 4)
				: 30000;
		function chunk() {
			if (stopped) return;
			const el = Date.now() - t0;
			const cyc = Math.floor(el / CYCLE);
			const T = Math.max(
				T0 * 1e-4,
				T0 * Math.pow(0.02, (el % CYCLE) / CYCLE) * Math.pow(0.6, cyc),
			);
			const tStart = Date.now();
			for (let k = 0; k < 20000; k++) step(T);
			// 混合模式：全局最优 LNS_PERIOD 毫秒未刷新（平台期）才做摧毁-修复
			if (
				snap.mode === "lns" &&
				Date.now() - lastRepair >= LNS_PERIOD &&
				Date.now() - lastImproveAt >= LNS_PERIOD
			) {
				lastRepair = Date.now();
				lnsCycle();
			}
			const dt = (Date.now() - tStart) / 1000;
			postMessage({
				type: "status",
				wid: WID,
				iter,
				tps: dt > 0 ? Math.round(20000 / dt) : 0,
				temp: T,
				repairs,
				attempts: lnsAttempts,
			});
			if (bestScore > lastBestSent + 1e-9) {
				lastBestSent = bestScore;
				postMessage({
					type: "best",
					wid: WID,
					score: bestScore,
					layout: bestLayout,
				});
			}
			setTimeout(chunk, 0);
		}
		chunk();
	}
}

const WORKER_SOURCE = [
	engShapeOffsets.toString(),
	engPrepare.toString(),
	engAdjIds.toString(),
	engContrib.toString(),
	`(${engWorkerMain.toString()})();`,
].join("\n");

/** 计算：引擎管理 */
const engine = {
	workers: [],
	stats: {},
	best: null, // { score, wscore, layout, result }
	snap: null,
	mode: "heuristic",
	workerCount: 2,
	timeLimitSec: 30, // 耗时上限（秒），0 表示不限
	startTime: 0,
	statusTimer: null,
	limitTimer: null,
	blobUrl: null,
};

const fmtNum = (v) => {
	const r = Math.round(v * 10) / 10;
	return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

// 归一化评分展示：得分/满分（达上限的百分比），满分即各属性权重之和
const fmtScore = (score, maxScore) =>
	maxScore > 0 ? `${(score / maxScore).toFixed(4)}` : score.toFixed(4);

function logLine(text, cls) {
	const line = document.createElement("div");
	line.className = `log-line ${cls || ""}`;
	line.textContent = text;
	els.logScroll.appendChild(line);
	els.logScroll.scrollTop = els.logScroll.scrollHeight;
}

function logStatus(text) {
	els.logStatus.textContent = text;
}

function countAdjacentCells(grid) {
	const rows = grid.length;
	const cols = rows > 0 ? grid[0].length : 0;

	const blocks = new Set();
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (grid[r][c] === 1) {
				blocks.add(`${r},${c}`);
			}
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
					const nr = r + dr,
						nc = c + dc;
					const key = `${nr},${nc}`;
					if (!blocks.has(key)) {
						adjacent.add(key);
					}
				}
			}
		}
	}

	return adjacent.size;
}

// 计算输入快照：权重全 0 按等权 1:1:1
function buildSnapshot() {
	let weights = [calcWeights.atk, calcWeights.def, calcWeights.hp];
	if (weights.every((w) => w === 0)) {
		weights = [1, 1, 1];
		logLine("三项权重全为 0，按等权 1:1:1 计算", "log-sys");
	}
	const { cols, rows } = boardState;
	const disabled = [...boardState.disabled].map((key) => {
		const [r, c] = key.split(",").map(Number);
		return r * cols + c;
	});
	const bonusMax = [0, 0, 0];
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
			attrs: attrs,
			shape: it.shape,
			max: it.nums,
		};
	});
	// 各属性理论极值（Min-Max 标准化的分母，仅用于拍平不同属性间的量级差）。
	// 单件乐观上界：相邻同五行件数 ≤ 形状周边空格数 gridCount，故自身加成与邻接加成都最多吃
	// gridCount 次：base × (1 + (自身加成 + 邻接加成上限) × gridCount / 100)
	const sumMax = [0, 0, 0]; // 求和上界：候选池（含数量）全部摆出的各属性总值
	const densMax = [0, 0, 0]; // 密度上界：各属性单格密度上限
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

	// 密度上界 × 参考格数转成棋盘总值。固定 7×6 参考棋盘：归一化基准稳定，
	// 得分可跨棋盘配置比较；棋盘比参考大时取当前可用格兜底，保证上界不被击穿
	const REF_CELLS = 7 * 6;
	const refCells = Math.max(REF_CELLS, cols * rows - disabled.length);
	// 两个上界取较紧者；某属性全池无来源时两者同为 0，该属性不计分
	const attrsMax = [0, 1, 2].map((j) =>
		Math.ceil(Math.min(sumMax[j], densMax[j] * refCells)),
	);
	return { cols, rows, disabled, items, weights, attrsMax };
}

/** 计算：布局结果与日志渲染 */
// 品质色直接引用 :root 中的 CSS 变量，保证 JS 与样式共用同一颜色来源
const QUALITY_COLOR = ["green", "blue", "purple", "gold", "red"].map(
	(name) => `var(--color-${name})`,
);

// 把最优布局画到实时布局棋盘：品质着色 + 编号 + 法宝外边界加粗
// board 默认取当前已应用棋盘，回溯时传入历史棋盘快照
function renderLayoutSolution(result, board = boardState) {
	layoutShown = result; // 悬浮提示数据源
	hideCellTip();
	const { cols, rows, disabled } = board;
	const owner = new Array(cols * rows).fill(-1);
	result.insts.forEach((inst, i) =>
		inst.cells.forEach((ci) => {
			owner[ci] = i;
		}),
	);

	const df = document.createDocumentFragment();
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const ci = r * cols + c;
			const cell = document.createElement("div");
			cell.className = "board-cell";
			if (disabled.has(`${r},${c}`)) {
				cell.classList.add("disabled");
			} else if (owner[ci] >= 0) {
				const i = owner[ci];
				const p = result.details[i].p;
				cell.style.background = QUALITY_COLOR[p.quality];
				// 悬浮提示据此索引查法宝信息
				cell.dataset.inst = i;
				const num = document.createElement("span");
				num.className = "cell-num";
				num.textContent = i + 1;
				cell.appendChild(num);
				// 与异件/空格/边界相邻的边加粗，同件内部格子间细线
				[
					[r > 0 ? ci - cols : -1, "Top"],
					[r < rows - 1 ? ci + cols : -1, "Bottom"],
					[c > 0 ? ci - 1 : -1, "Left"],
					[c < cols - 1 ? ci + 1 : -1, "Right"],
				].forEach(([ni, side]) => {
					cell.style[`border${side}`] =
						ni >= 0 && owner[ni] === i
							? "1px solid var(--cell-inner-line)"
							: "2px solid var(--cell-outline)";
				});
			}
			df.appendChild(cell);
		}
	}
	els.layoutGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	els.layoutGrid.replaceChildren(df);
	renderLegend(result);
}

// 棋盘下方图例：编号 -> 法宝全名、五行（品质由色块颜色区分，自动换行平铺）
function renderLegend(result) {
	const df = document.createDocumentFragment();
	result.details.forEach((d, i) => {
		const p = d.p;
		const item = document.createElement("div");
		item.className = "legend-item";
		const chip = document.createElement("span");
		chip.className = "legend-chip";
		chip.style.background = QUALITY_COLOR[p.quality];
		const text = document.createElement("span");
		const name = document.createElement("span");
		name.className = "legend-name";
		name.textContent = `#${i + 1} ${p.name}`;
		const meta = document.createElement("span");
		meta.className = "legend-meta";
		meta.textContent = ` ${p.ftype}`;
		text.appendChild(name);
		text.appendChild(meta);
		item.appendChild(chip);
		item.appendChild(text);
		df.appendChild(item);
	});
	els.layoutLegend.replaceChildren(df);
}

/** 实时布局：格子悬浮提示 */
// 当前棋盘上展示的计算结果，鼠标 hover / 手指 touch 格子时显示法宝信息
let layoutShown = null;

const cellTip = document.createElement("div");
cellTip.className = "cell-tip";
cellTip.hidden = true;

function hideCellTip() {
	cellTip.hidden = true;
}

function showCellTip(cell) {
	if (!layoutShown) return;
	const d = layoutShown.details[Number(cell.dataset.inst)];
	if (!d) return;
	const p = d.p;
	const labels = ["攻击", "防御", "血量"];
	const fmt3 = (arr) => arr.map((v, j) => `${labels[j]}${fmtNum(v)}`).join("/");
	const bonusParts = [];
	for (let j = 0; j < 3; j++) {
		if (p.selfPct[j] > 0 && d.same > 0) {
			bonusParts.push(
				`自身${labels[j]}+${Math.round(p.selfPct[j] * 100 * d.same)}%`,
			);
		}
		const adjPct = d.recvDetail[j].reduce((s, rd) => s + rd.pct, 0);
		if (adjPct > 0) {
			bonusParts.push(`邻接${labels[j]}+${Math.round(adjPct)}%`);
		}
	}
	cellTip.textContent = [
		`${p.name}（${p.ftype}·${utils.getQualityText(p.quality)}）`,
		`基础: ${fmt3(p.base)}`,
		`加成: ${bonusParts.length ? bonusParts.join("，") : "无"}`,
		`最终: ${fmt3(d.finals)}`,
	].join("\n");
	// 先显示再测量：优先放格子上方，空间不足放下方，横向不超出视口
	cellTip.hidden = false;
	const rect = cell.getBoundingClientRect();
	const tw = cellTip.offsetWidth;
	const th = cellTip.offsetHeight;
	let left = rect.left + rect.width / 2 - tw / 2;
	left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
	let top = rect.top - th - 6;
	if (top < 4) top = rect.bottom + 6;
	cellTip.style.left = `${left}px`;
	cellTip.style.top = `${top}px`;
}

function cellTipInit() {
	document.body.appendChild(cellTip);
	els.layoutGrid.addEventListener("mouseover", (e) => {
		const cell = e.target.closest(".board-cell");
		if (cell && cell.dataset.inst !== undefined) showCellTip(cell);
	});
	els.layoutGrid.addEventListener("mouseout", (e) => {
		const cell = e.target.closest(".board-cell");
		// 在格子与其内部编号之间移动时保持显示
		if (cell && !cell.contains(e.relatedTarget)) hideCellTip();
	});
	// 触屏：点按格子显示，点按棋盘外任意处隐藏
	els.layoutGrid.addEventListener(
		"touchstart",
		(e) => {
			const cell = e.target.closest(".board-cell");
			if (cell && cell.dataset.inst !== undefined) {
				e.preventDefault();
				showCellTip(cell);
			}
		},
		{ passive: false },
	);
	document.addEventListener("touchstart", (e) => {
		if (!e.target.closest(".layout-grid")) hideCellTip();
	});
}

/** 计算：启停与 Worker 消息 */
function startCalc() {
	const totalUnits = selectedBlocks.reduce((s, it) => s + it.nums, 0);
	const freeCells =
		boardState.cols * boardState.rows - boardState.disabled.size;
	if (!totalUnits) {
		logLine("已选列表为空，请先从法宝列表添加法宝", "log-sys");
		return;
	}
	if (freeCells <= 0) {
		logLine("棋盘没有可用格子，请调整棋盘设置", "log-sys");
		return;
	}

	els.logScroll.querySelectorAll(".log-line").forEach((n) => n.remove());

	const snap = buildSnapshot();
	snap.mode = els.modeSelect.value;
	snap.fillFirst = els.fillFirst.checked; // 填满优先：先最大化已占格数，其次属性分
	snap.timeLimitSec = engine.timeLimitSec; // 退火周期按此调度
	const workerCount = engine.workerCount;

	if (snap.mode === "lns") {
		logLine(
			`混合最优模式：${workerCount} 个线程独立退火，周期性摧毁-精确修复（LNS），取全局最优`,
			"log-sys",
		);
	} else {
		logLine(
			`快速求解模式：${workerCount} 个线程独立退火，${QUICK_SOLVE_SEC} 秒限时，取全局最优`,
			"log-sys",
		);
	}

	if (!engine.blobUrl) {
		engine.blobUrl = URL.createObjectURL(
			new Blob([WORKER_SOURCE], { type: "application/javascript" }),
		);
	}
	engine.snap = snap;
	engine.mode = snap.mode;
	engine.best = null;
	engine.stats = {};
	engine.startTime = Date.now();
	engine.workers = [];

	for (let w = 0; w < workerCount; w++) {
		const worker = new Worker(engine.blobUrl);
		worker.onmessage = onWorkerMessage;
		worker.onerror = (err) =>
			logLine(`线程 ${w + 1} 出错：${err.message}`, "log-sys");
		engine.workers.push(worker);
		worker.postMessage({
			type: "start",
			wid: w,
			seed: (Date.now() ^ ((w + 1) * 2654435761)) >>> 0,
			snap,
		});
	}

	setCalcRunning(true);
	renderLayoutBoard();
	els.layoutLegend.replaceChildren();
	logStatus("计算中…");
	engine.statusTimer = setInterval(updateStatusLine, 1000);
	// 耗时上限：到点自动停止并结算（0 表示不限）
	if (engine.timeLimitSec > 0) {
		engine.limitTimer = setTimeout(
			() =>
				stopCalc(
					`已达到耗时上限 ${engine.timeLimitSec} 秒，自动停止`,
					`已达耗时上限（${engine.timeLimitSec} 秒）`,
				),
			engine.timeLimitSec * 1000,
		);
	}
	logLine(
		`开始计算：${snap.mode === "lns" ? "混合最优" : "快速求解"}模式，目标 ${snap.fillFirst ? "填满优先" : "属性优先"}，${workerCount} 线程，已选 ${totalUnits} 件，可用格 ${freeCells}，权重 攻${fmtNum(snap.weights[0])}/防${fmtNum(snap.weights[1])}/血${fmtNum(snap.weights[2])}，耗时上限 ${engine.timeLimitSec > 0 ? engine.timeLimitSec + " 秒" : "不限"}`,
		"log-sys",
	);
}

function stopCalc(reason, statusText) {
	engine.workers.forEach((w) => w.terminate());
	engine.workers = [];
	clearInterval(engine.statusTimer);
	clearTimeout(engine.limitTimer);
	engine.limitTimer = null;
	setCalcRunning(false);
	const t = ((Date.now() - engine.startTime) / 1000).toFixed(1);
	logStatus(statusText || `已停止（用时 ${t}s）`);
	if (reason) logLine(reason, "log-sys");
	if (engine.best) {
		const r = engine.best.result;
		const filled = r.insts.reduce((s, ins) => s + ins.cells.length, 0);
		const freeCells =
			engine.snap.cols * engine.snap.rows - engine.snap.disabled.length;
		logLine(
			`最终解：总分 ${fmtScore(r.score, r.maxScore)}（攻 ${fmtNum(r.totals[0])} / 防 ${fmtNum(r.totals[1])} / 血 ${fmtNum(r.totals[2])}），共 ${r.details.length} 件，占格 ${filled}/${freeCells}`,
			"log-sys",
		);
		// 历史最优只在被刷新时替换（v 不一致 = 旧口径的原始分，与归一化分不可比，直接替换）。
		// 同一问题（权重与目标模式一致）下属性分打平时，按占格数裁决：填得更满的结果更优
		const sameProblem =
			!!memBest &&
			memBest.v === 4 &&
			String(engine.snap.weights) === String(memBest.weights) &&
			!!memBest.fillFirst === !!engine.snap.fillFirst;
		const oldFilled = sameProblem
			? memBest.result.insts.reduce((s, ins) => s + ins.cells.length, 0)
			: -1;
		if (
			!sameProblem ||
			engine.best.score > memBest.score + 1e-9 ||
			(engine.best.score > memBest.score - 1e-9 && filled > oldFilled)
		) {
			memBest = captureBest();
		}
		updateRecallBtn();
		// 已选列表已入缓存时，把历史最优同步回写该方案的本地缓存
		if (activePresetKey) {
			try {
				localStorage.setItem(
					PRESET_DATA_PREFIX + activePresetKey,
					JSON.stringify({ blocks: selectedBlocks, best: memBest }),
				);
			} catch {
				// 本地存储不可用 / 超容量：仅保留内存中的历史最优
			}
		}
	} else {
		logLine("未找到可行布局", "log-sys");
	}
}

function onWorkerMessage(e) {
	const m = e.data;
	if (m.type === "best") {
		// m.score 是 Worker 内部复合分（属性分 + 占格数 × fillW，两种模式含义不同），
		// 只用于线程间比较；展示与存档的分数由主线程 engScoreLayout 重算，始终是归一化属性分
		if (!engine.best || m.score > engine.best.wscore + 1e-9) {
			const result = engScoreLayout(engine.snap, m.layout);
			engine.best = {
				score: result.score,
				wscore: m.score,
				layout: m.layout,
				result,
			};
			renderLayoutSolution(result);
			const filled = result.insts.reduce((s, ins) => s + ins.cells.length, 0);
			const freeCells =
				engine.snap.cols * engine.snap.rows - engine.snap.disabled.length;
			const t = ((Date.now() - engine.startTime) / 1000).toFixed(1);
			logLine(
				`[${t}s] 新最优（线程 ${m.wid + 1}）：总分 ${fmtScore(result.score, result.maxScore)}（攻 ${fmtNum(result.totals[0])} / 防 ${fmtNum(result.totals[1])} / 血 ${fmtNum(result.totals[2])}），占格 ${filled}/${freeCells}`,
				"log-best",
			);
		}
	} else if (m.type === "status") {
		engine.stats[m.wid] = m;
	}
}

function updateStatusLine() {
	const t = ((Date.now() - engine.startTime) / 1000).toFixed(0);
	const stats = Object.values(engine.stats);
	const bestTxt = engine.best
		? `｜当前最优 ${fmtScore(engine.best.score, engine.best.result.maxScore)}`
		: "";
	const tps = stats.reduce((s, m) => s + (m.tps || 0), 0);
	const iter = stats.reduce((s, m) => s + (m.iter || 0), 0);
	if (engine.mode === "lns") {
		const rep = stats.reduce((s, m) => s + (m.repairs || 0), 0);
		logStatus(
			`退火+LNS中 ${t}s｜迭代 ${iter.toLocaleString()}（${tps.toLocaleString()}/s）｜修复 ${rep} 次${bestTxt}`,
		);
	} else {
		logStatus(
			`退火中 ${t}s｜迭代 ${iter.toLocaleString()}（${tps.toLocaleString()}/s）${bestTxt}`,
		);
	}
}

function calcInit() {
	const bindWeightInput = (ipt, key) => {
		ipt.addEventListener("change", () => {
			const val = Math.min(99, Math.max(0, Number(ipt.value) || 0));
			ipt.value = val;
			calcWeights[key] = val;
			// 权重改到与历史最优不一致时，旧结果对应的是另一个问题，作废；
			// 若改为与历史最优一致（如调回存档权重），历史最优仍有效，保留
			// （已选列表没变，与已存方案的关联保留，重算后会回写）
			if (bestIsStale()) dropBest();
		});
	};
	bindWeightInput(els.weightAtk, "atk");
	bindWeightInput(els.weightDef, "def");
	bindWeightInput(els.weightHp, "hp");

	// 填满/属性优先切换：与权重变更同理，目标变了旧结果对应的是另一个问题，作废
	els.fillFirst.addEventListener("change", () => {
		els.fillFirstText.textContent = els.fillFirst.checked
			? "填满优先"
			: "属性优先";
		if (bestIsStale()) dropBest();
	});

	// 模式切换：快速求解固定 3 秒限时且隐藏耗时上限设置；
	// 混合最优恢复用户自设的耗时上限
	const applyModeUI = () => {
		const isLns = els.modeSelect.value === "lns";
		els.timeLimitField.hidden = !isLns;
		els.timeLimitHint.hidden = !isLns;
		els.modeHint.innerHTML = `<p class="${isLns ? "" : "active"}">快速求解：${QUICK_SOLVE_SEC} 秒内给出较优布局</p><p class="${isLns ? "active" : ""}">混合最优：多算法结合，耗时越长越接近最优</p>`;
		engine.timeLimitSec = isLns ? lnsTimeLimitSec : QUICK_SOLVE_SEC;
	};
	els.modeSelect.addEventListener("change", applyModeUI);
	applyModeUI();

	els.recallBtn.addEventListener("click", recallBest);

	// 线程数：下限 2、默认 2、上限 max(4, 逻辑核数-1)，运行中锁定
	const maxWorkers = Math.max(4, (navigator.hardwareConcurrency || 4) - 1);
	els.workerCount.max = maxWorkers;
	els.workerMaxHint.textContent = `最大支持 ${maxWorkers} 线程（根据设备性能自动设定）`;
	els.workerCount.addEventListener("change", () => {
		const val = Math.min(
			maxWorkers,
			Math.max(2, Number(els.workerCount.value) || 2),
		);
		els.workerCount.value = val;
		engine.workerCount = val;
	});

	// 耗时上限（秒）：0 表示不限，运行中锁定；仅混合最优模式可调
	els.timeLimit.addEventListener("change", () => {
		const val = Math.min(99999, Math.max(0, Number(els.timeLimit.value) || 0));
		els.timeLimit.value = val;
		lnsTimeLimitSec = val;
		engine.timeLimitSec = val;
	});

	els.calcBtn.addEventListener("click", () => {
		if (calcState.running) {
			stopCalc("用户手动停止");
		} else {
			startCalc();
		}
	});
}

/** 截图导入：棋盘定位 + 归一化切格 */
/**
 * 流程：截图 → 定位棋盘（OpenCV 自动定位，失败可手动框选）→ 按行列切格。
 * 产出 scanner.result 供「品质识别 / 图标模板匹配」直接消费：
 *   { img(ImageBitmap), rect: {L,T,R,B}(原图坐标), cols, rows, cellSize(归一化边长 px),
 *     cells: canvas[][]（cells[行][列]，每格重采样为 cellSize²，与截图分辨率无关，模板只需一份）,
 *     grid: 整盘归一化预览图 }
 */
const scanner = {
	result: null,
	// 检测在缩放到该宽度的副本上进行，平衡精度与速度
	detectWidth: SCAN_DETECT_WIDTH,
	cv: null, // OpenCV.js 运行时（加载失败保持 null，退化为手动框选）
	img: null, // 当前截图
	rect: null, // 当前棋盘区域（原图坐标）
	picking: false, // 手动框选模式（自动定位失败时自动进入）
	pickStart: null,
	editing: false, // 边界调整模式
	drag: null, // 边界拖拽状态 { zone, x0, y0, k, rect0 }
	// 识别结果（法宝列表）：{ thumb, name, type, quality, count, confidence }
	// 自动识别行另带 cells/anchor/pieces；manual 为 true 的行为手动录入（新增 / 选格补录），
	// 重新识别 / 换图 / 重新切格时整表重建，一并清除
	items: [],
	// 识别出的棋子：{ name, names, type, quality, shape, cells, anchor, confidence, thumb }
	pieces: [],
	// 结果表 hover / 触摸的行号：预览图据此高亮对应棋子覆盖格，-1 表示无
	hoverIdx: -1,
	// 预览图 tooltip 指向的行号与具体棋子（mouse hover / touch 点按），仅高亮该棋子本身
	tipIdx: -1,
	tipPiece: null,
	// 选格补录模式：点选未被识别覆盖的格子组成法宝，实时识别后手动填入结果表
	cellPick: false,
	pickSel: new Set(), // 已选格子 "r,c"
	pickHadSel: false, // 上一次表单刷新时是否有选中格（类型/品质推荐只在新一次点选时填入）
	pickNameAuto: "", // 名称栏上一次自动填入值（用户手改后不再覆盖）
	statusTimer: 0, // 状态条自动隐藏计时器
};

/* SCAN_CELL_SIZE / SCAN_REC / scanDetectBoard / scanSliceCells / 特征与签名 /
 * 候选生成 / packing / 命名 等识别核心已抽到 script/scan-core.js，
 * 与 tools/法宝图标指纹提取工具.html 共用，改动只需维护该文件 */
const scanEls = {
	openBtn: document.querySelector(".scan-open-btn"),
	modal: document.querySelector(".scan-modal"),
	panel: document.querySelector(".scan-panel"),
	closeBtn: document.querySelector(".scan-close-btn"),
	body: document.querySelector(".scan-body"),
	media: document.querySelector(".scan-media"),
	drop: document.querySelector(".scan-drop"),
	file: document.querySelector(".scan-file"),
	stage: document.querySelector(".scan-stage"),
	canvas: document.querySelector(".scan-canvas"),
	reuploadBtn: document.querySelector(".scan-reupload-btn"),
	resultBody: document.querySelector(".scan-result-body"),
	tbody: document.querySelector(".scan-tbody"),
	addBtn: document.querySelector(".scan-add-btn"),
	status: document.querySelector(".scan-status"),
	tip: document.querySelector(".scan-tip"),
	autoBtn: document.querySelector(".scan-auto-btn"),
	manualBtn: document.querySelector(".scan-manual-btn"),
	editBtn: document.querySelector(".scan-edit-btn"),
	recognizeBtn: document.querySelector(".scan-recognize-btn"),
	pickBtn: document.querySelector(".scan-pick-btn"),
	pickBar: document.querySelector(".scan-pick-bar"),
	pickNote: document.querySelector(".scan-pick-note"),
	pickShape: document.querySelector(".scan-pick-shape"),
	pickType: document.querySelector(".scan-pick-type"),
	pickQuality: document.querySelector(".scan-pick-quality"),
	pickName: document.querySelector(".scan-pick-name"),
	pickNameList: document.querySelector(".scan-pick-name-list"),
	pickClearBtn: document.querySelector(".scan-pick-clear-btn"),
	pickConfirmBtn: document.querySelector(".scan-pick-confirm-btn"),
	importBtn: document.querySelector(".scan-import-btn"),
	fsBtn: document.querySelector(".scan-fs-btn"),
	fsToolbar: document.querySelector(".scan-fs-toolbar"),
	fsAuto: document.querySelector(".scan-fs-auto"),
	fsManual: document.querySelector(".scan-fs-manual"),
	fsEdit: document.querySelector(".scan-fs-edit"),
	fsRecognize: document.querySelector(".scan-fs-recognize"),
	fsPick: document.querySelector(".scan-fs-pick"),
	fsUpload: document.querySelector(".scan-fs-upload"),
	fsExit: document.querySelector(".scan-fs-exit"),
	statsCells: document.querySelector(".scan-stats-cells"),
	statsCount: document.querySelector(".scan-stats-count"),
};

/** 状态条：悬浮在预览图底部；ok 类消息 3 秒后自动隐藏 */
function scanStatus(text, cls) {
	clearTimeout(scanner.statusTimer);
	if (!text) {
		scanEls.status.hidden = true;
		return;
	}
	scanEls.status.textContent = text;
	scanEls.status.className = `scan-status${cls ? ` ${cls}` : ""}`;
	scanEls.status.hidden = false;
	if (cls === "ok") {
		scanner.statusTimer = setTimeout(() => {
			scanEls.status.hidden = true;
		}, 3000);
	}
}

/** OpenCV 下载 / 初始化进度提示：首次识别卡在组件加载时让用户知道进度 */
function scanCvProgress({ loaded, total, phase }) {
	if (scanEls.modal.hidden) return;
	if (phase === "init") {
		scanStatus("识别组件初始化中…");
		return;
	}
	const mb = (loaded / 1048576).toFixed(1);
	const pct = Math.min(100, Math.round((loaded / total) * 100));
	scanStatus(`识别组件下载中 ${pct}%（${mb}MB）…`);
}

/** 网格行列数跟随主页棋盘配置 */
function scanGridDims() {
	return {
		cols: Number(els.boardCols.value) || 1,
		rows: Number(els.boardRows.value) || 1,
	};
}

/** 法宝目录下拉选项：名称 -> 是否红色法宝（品质固定五阶） */
const SCAN_BLOCK_NAMES = (() => {
	const map = new Map();
	Object.values(BLOCKS).forEach((blockObj) => {
		Object.keys(blockObj.normal || {}).forEach((name) => map.set(name, false));
		Object.keys(blockObj.red || {}).forEach((name) => map.set(name, true));
	});
	return map;
})();

/** 法宝名称 -> 形状，用于统计占用格数 */
const SCAN_BLOCK_SHAPES = (() => {
	const map = new Map();
	Object.values(BLOCKS).forEach((blockObj) => {
		Object.entries(blockObj.normal || {}).forEach(([name, d]) =>
			map.set(name, d.shape),
		);
		Object.entries(blockObj.red || {}).forEach(([name, d]) =>
			map.set(name, d.shape),
		);
	});
	return map;
})();

/** 法宝名称 -> 导入已选列表所需的完整数据（values 结构与主表 buildLine / addSelectedBlock 完全一致） */
const SCAN_BLOCK_DETAILS = (() => {
	const map = new Map();
	Object.entries(BLOCKS).forEach(([type, blockObj]) => {
		Object.entries(blockObj.normal || {}).forEach(([name, d]) =>
			map.set(name, {
				type,
				shape: d.shape,
				values: d.value,
				bonus: d.bonus,
				fixed: false,
			}),
		);
		Object.entries(blockObj.red || {}).forEach(([name, d]) =>
			map.set(name, {
				type,
				shape: d.shape,
				values: [d.value],
				bonus: d.bonus,
				fixed: true,
			}),
		);
	});
	return map;
})();

// 名称候选推导：按 类型 + 品质（五阶=红法宝组）+ 形状（识别出行带 shapeMat 时）筛选法宝目录；
// 类型未选遍历全类型，形状未知只按类型 + 品质过滤；结果表名称下拉与选格补录的名称推荐共用
function scanNameCandidates(item) {
	const shapeJson = item.pieces?.length
		? JSON.stringify(item.pieces[0].shapeMat)
		: null;
	const red = item.quality === 4;
	const types = item.type ? [item.type] : Object.keys(BLOCKS);
	const seen = new Set();
	types.forEach((t) => {
		const grp = (BLOCKS[t] || {})[red ? "red" : "normal"] || {};
		Object.entries(grp).forEach(([name, d]) => {
			if (shapeJson && JSON.stringify(d.shape) !== shapeJson) return;
			seen.add(name);
		});
	});
	return [...seen];
}

/** cells（[[r,c],...]）平移归一化到原点后展开为 0/1 矩阵（形状比较用，同 scan-bench 口径） */
function scanCellsToMat(cells) {
	const mr = Math.min(...cells.map(([r]) => r));
	const mc = Math.min(...cells.map(([, c]) => c));
	const hr = Math.max(...cells.map(([r]) => r)) - mr + 1;
	const hc = Math.max(...cells.map(([, c]) => c)) - mc + 1;
	const mat = Array.from({ length: hr }, () => new Array(hc).fill(0));
	cells.forEach(([r, c]) => {
		mat[r - mr][c - mc] = 1;
	});
	return mat;
}

/** 矩阵顺时针旋转 90° */
function scanRotMat(mat) {
	const h = mat.length;
	const w = mat[0].length;
	const out = Array.from({ length: w }, () => new Array(h).fill(0));
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) out[c][h - 1 - r] = mat[r][c];
	}
	return out;
}

// 期望名称推导（选格补录用，同 scan-bench scanExpectNames 口径）：BLOCKS[type][红/普通] 中
// shape 与选中格形状一致的条目，含旋转匹配；quality 0-4（4 为红），返回 { names, rotated }
function scanExpectNames(type, quality, cells) {
	const grp = (BLOCKS[type] || {})[quality === 4 ? "red" : "normal"] || {};
	let mat = scanCellsToMat(cells);
	for (let i = 0; i < 4; i++) {
		const json = JSON.stringify(mat);
		const names = Object.entries(grp)
			.filter(([, d]) => JSON.stringify(d.shape) === json)
			.map(([name]) => name);
		if (names.length || i === 3)
			return { names, rotated: i > 0 && names.length > 0 };
		mat = scanRotMat(mat);
	}
	return { names: [], rotated: false };
}

/** 选中格四邻连通性校验（选格补录确认前兜底） */
function scanCellsConnected(cells) {
	const set = new Set(cells.map(([r, c]) => `${r},${c}`));
	const seen = new Set([cells[0].join(",")]);
	const queue = [cells[0]];
	while (queue.length) {
		const [r, c] = queue.pop();
		[
			[r - 1, c],
			[r + 1, c],
			[r, c - 1],
			[r, c + 1],
		].forEach(([nr, nc]) => {
			const k = `${nr},${nc}`;
			if (set.has(k) && !seen.has(k)) {
				seen.add(k);
				queue.push([nr, nc]);
			}
		});
	}
	return seen.size === set.size;
}

/** 件数 + 格数统计：占用格数/总格数，与已选列表同一套配色规则 */
function scanUpdateStats() {
	const count = scanner.items.reduce((s, it) => s + it.count, 0);
	const used = scanner.items.reduce((s, it) => {
		const shape = SCAN_BLOCK_SHAPES.get(it.name);
		if (shape) return s + it.count * engShapeOffsets(shape).area;
		// 名称未匹配但识别出形状的行：按 pieces 的 shapeMat 占位面积估算
		// （取各次出现面积的均值再乘数量，与命名行的 count 口径一致），避免按 0 格统计
		if (it.pieces?.length) {
			const perUnit =
				it.pieces.reduce((a, p) => a + engShapeOffsets(p.shapeMat).area, 0) /
				it.pieces.length;
			return s + it.count * perUnit;
		}
		return s;
	}, 0);
	scanEls.statsCount.textContent = count;
	const { cols, rows } = scanGridDims();
	const total = cols * rows - boardState.disabled.size;
	scanEls.statsCells.textContent = `${used}/${total}`;
	scanEls.statsCells.classList.remove("stats-low", "stats-full", "stats-over");
	const cls =
		used < total ? "stats-low" : used === total ? "stats-full" : "stats-over";
	scanEls.statsCells.classList.add(cls);
}

/** 渲染识别结果表（法宝列表）：编号 / 缩略图 / 名称 / 品质 / 数量可改，置信度只读，行可删；
 * hover / 触摸某行时，左侧预览图高亮该行对应的棋子覆盖格 */
function scanRenderItems() {
	// 结果表重建后 tooltip 引用的行号可能失效，一并清除（重绘由本函数末尾统一触发）
	scanHideTip(false);
	// 空态与主表一致：无数据时渲染表内占位行
	if (!scanner.items.length) {
		scanEls.tbody.replaceChildren(
			buildEmptyRow(8, "识别结果将在此展示；也可点击右上角「新增」手动录入"),
		);
		scanUpdateStats();
		// 条目清空后同步预览叠加层（无截图时 scanRedraw 内部直接返回）
		scanRedraw();
		return;
	}
	scanEls.tbody.replaceChildren(
		...scanner.items.map((item, idx) => {
			const tr = document.createElement("tr");

			const tdIdx = document.createElement("td");
			tdIdx.textContent = idx + 1;
			tr.appendChild(tdIdx);

			// 缩略图：识别出的格子图；手动新增行为空占位
			const tdThumb = document.createElement("td");
			const thumb = document.createElement("div");
			thumb.className = "scan-thumb";
			if (item.thumb) thumb.appendChild(item.thumb);
			tdThumb.appendChild(thumb);
			tr.appendChild(tdThumb);

			// 类型：识别填入（金木水火土等），可修改；变化联动名称候选筛选
			const tdType = document.createElement("td");
			tdType.dataset.label = "类型"; // 移动端卡片字段名
			const tSel = document.createElement("select");
			tSel.className = "scan-type-select";
			tSel.replaceChildren(
				...["", ...Object.keys(BLOCKS)].map((t) => {
					const opt = document.createElement("option");
					opt.value = t;
					opt.text = t || "未知";
					return opt;
				}),
			);
			tSel.value = item.type || "";
			tSel.addEventListener("change", () => {
				item.type = tSel.value;
				// 类型变化后重筛名称候选：清掉不再匹配的名称，唯一候选直接填入
				refreshNameFilter();
				scanRedraw();
			});
			tdType.appendChild(tSel);
			tr.appendChild(tdType);

			// 名称：可搜索下拉，输入过滤法宝目录；红色法宝品质固定五阶
			const tdName = document.createElement("td");
			const combo = document.createElement("div");
			combo.className = "scan-name-combo";
			const nameIn = document.createElement("input");
			nameIn.className = "scan-name-input";
			nameIn.type = "text";
			nameIn.placeholder = "搜索 / 选择法宝";
			nameIn.autocomplete = "off";
			nameIn.value = item.name || "";
			const nameList = document.createElement("div");
			nameList.className = "scan-name-list";
			nameList.hidden = true;
			combo.append(nameIn, nameList);
			tdName.appendChild(combo);
			tr.appendChild(tdName);

			// 品质：复用品质色样式；普通法宝按 values 档位数裁剪选项（无五阶），
			// 红色法宝品质固定五阶，与已选列表一致显示为彩色文本而非禁用下拉
			const tdQuality = document.createElement("td");
			tdQuality.dataset.label = "品质"; // 移动端卡片字段名
			const qSel = document.createElement("select");
			const qFixed = document.createElement("div");
			const syncQuality = () => {
				const detail = SCAN_BLOCK_DETAILS.get(item.name);
				const fixed = detail?.fixed === true;
				// 品质档位数跟随名称：普通法宝只有 values.length 档（无五阶），
				// 红色法宝固定五阶；名称未知时保留全部档位
				const maxQ = fixed
					? 4
					: detail
						? detail.values.length - 1
						: QUALITY_NAMES.length - 1;
				item.quality = fixed ? 4 : Math.min(item.quality, maxQ);
				// 名称变化时动态裁剪选项（档位数变化才重建，保留选中态）
				if (qSel.options.length !== maxQ + 1) {
					qSel.replaceChildren(
						...QUALITY_NAMES.slice(0, maxQ + 1).map((n, q) => {
							const option = document.createElement("option");
							option.value = q;
							option.text = `${n}阶`;
							return option;
						}),
					);
				}
				qSel.hidden = fixed;
				qFixed.hidden = !fixed;
				qSel.value = item.quality;
				qSel.className = `${utils.getQualityColor(item.quality)} block-quantity-select`;
				qFixed.textContent = utils.getQualityText(item.quality);
				qFixed.className = `${utils.getQualityColor(item.quality)} block-quantity-select disabled`;
			};
			qSel.addEventListener("change", () => {
				item.quality = Number(qSel.value);
				syncQuality();
				// 品质切换影响红 / 普通分组，名称候选随之重筛
				refreshNameFilter();
				// 叠加层按品质着色，品质变化后同步重绘
				scanRedraw();
			});
			tdQuality.append(qSel, qFixed);
			tr.appendChild(tdQuality);

			// 数量：该法宝在棋盘出现的次数（识别填入，可手改）
			const tdCount = document.createElement("td");
			tdCount.dataset.label = "数量"; // 移动端卡片字段名
			const cIn = document.createElement("input");
			cIn.type = "number";
			cIn.className = "num-input";
			cIn.min = 1;
			cIn.value = item.count;
			cIn.addEventListener("change", () => {
				item.count = Math.max(1, Number(cIn.value) || 1);
				cIn.value = item.count;
				scanUpdateStats();
			});
			tdCount.appendChild(cIn);
			numStepper(cIn);
			tr.appendChild(tdCount);

			// 置信度：模板匹配置信度（0~100），只读展示，按分数高低着色（高绿 / 中黄 / 低红）；
			// 手动新增无置信度显示占位
			const tdConf = document.createElement("td");
			tdConf.dataset.label = "置信度"; // 移动端卡片字段名
			if (item.confidence == null) {
				tdConf.textContent = "—";
			} else {
				const conf = document.createElement("span");
				conf.textContent = item.confidence;
				conf.className =
					item.confidence >= 85
						? "scan-conf-high"
						: item.confidence >= 60
							? "scan-conf-mid"
							: "scan-conf-low";
				tdConf.appendChild(conf);
			}
			tr.appendChild(tdConf);

			// 行 hover / 触摸：预览图高亮该行棋子的覆盖格（touch 点按切换，再点取消）；
			// 与预览图 tooltip 高亮互斥，激活时清掉 tooltip
			tr.addEventListener("mouseenter", () => {
				scanHideTip(false);
				scanner.hoverIdx = idx;
				scanRedraw();
			});
			tr.addEventListener("mouseleave", () => {
				if (scanner.hoverIdx === idx) {
					scanner.hoverIdx = -1;
					scanRedraw();
				}
			});
			tr.addEventListener(
				"touchstart",
				() => {
					scanner.hoverIdx = scanner.hoverIdx === idx ? -1 : idx;
					if (scanner.hoverIdx !== -1) scanHideTip(false);
					scanRedraw();
				},
				{ passive: true },
			);

			const tdDel = document.createElement("td");
			const delBtn = document.createElement("button");
			delBtn.className = "btn-primary btn-danger";
			delBtn.textContent = "删除";
			delBtn.addEventListener("click", () => {
				scanner.items.splice(idx, 1);
				scanRenderItems();
			});
			tdDel.appendChild(delBtn);
			tr.appendChild(tdDel);

			// 名称搜索下拉：focus / 输入时按 类型 + 品质 + 形状 过滤候选，点选或失焦时提交，
			// 名称变化联动品质（红色法宝固定五阶）与类型（选中名称即确定类型）
			const commitName = (name) => {
				item.name = name;
				nameIn.value = name;
				const detail = SCAN_BLOCK_DETAILS.get(name);
				if (detail && item.type !== detail.type) {
					item.type = detail.type;
					tSel.value = detail.type;
				}
				syncQuality();
				scanUpdateStats();
				// 名称变化可能钳制品质，叠加层同步重绘
				scanRedraw();
			};
			// 类型 / 品质变化后重筛候选：清掉不再匹配的名称；唯一候选时直接填入
			const refreshNameFilter = () => {
				const cands = scanNameCandidates(item);
				if (item.name && cands.length && !cands.includes(item.name)) {
					item.name = "";
					nameIn.value = "";
				}
				if (!item.name && cands.length === 1) {
					commitName(cands[0]);
					return;
				}
				scanUpdateStats();
			};
			const closeNameList = () => {
				nameList.hidden = true;
			};
			const openNameList = () => {
				const kw = nameIn.value.trim();
				const frag = document.createDocumentFragment();
				let count = 0;
				// 严格候选（类型 + 品质 + 形状）为空时逐级放宽：
				// 先去掉形状约束（识别形状在名录中无匹配时仍可人工选名），再退回全目录
				let cands = scanNameCandidates(item);
				if (!cands.length && item.pieces?.length)
					cands = scanNameCandidates({ type: item.type, quality: item.quality });
				if (!cands.length) cands = [...SCAN_BLOCK_NAMES.keys()];
				cands.forEach((name) => {
					if (kw && !name.includes(kw)) return;
					count++;
					const opt = document.createElement("div");
					opt.className = "scan-name-opt";
					opt.textContent = name;
					// mousedown 先于 blur 触发，阻止输入框失焦导致列表提前收起
					opt.addEventListener("mousedown", (e) => {
						e.preventDefault();
						commitName(name);
						closeNameList();
						// 选择完成后主动失焦（移动端收起键盘），
						// 避免焦点挂在输入框上、点下一个 select 第一次不响应
						nameIn.blur();
					});
					frag.appendChild(opt);
				});
				if (!count) {
					const none = document.createElement("div");
					none.className = "scan-name-opt none";
					none.textContent = "无匹配法宝";
					frag.appendChild(none);
				}
				nameList.replaceChildren(frag);
				// fixed 定位到输入框下方，避免被表格滚动区裁剪
				const r = nameIn.getBoundingClientRect();
				nameList.style.left = `${r.left}px`;
				nameList.style.top = `${r.bottom + 2}px`;
				nameList.style.width = `${Math.max(r.width, 120)}px`;
				nameList.hidden = false;
			};
			nameIn.addEventListener("focus", openNameList);
			nameIn.addEventListener("input", openNameList);
			nameIn.addEventListener("blur", () => {
				closeNameList();
				// 只接受目录中的名称，其余输入回退为原值
				if (SCAN_BLOCK_NAMES.has(nameIn.value)) {
					if (nameIn.value !== item.name) commitName(nameIn.value);
				} else {
					nameIn.value = item.name || "";
				}
			});
			syncQuality();
			return tr;
		}),
	);
	scanUpdateStats();
	// 删除 / 改名 / 改品质后同步预览叠加层（无截图时 scanRedraw 内部直接返回）
	scanRedraw();
}

function scanStopEditing() {
	scanner.editing = false;
	scanner.drag = null;
	scanEls.editBtn.classList.remove("active");
	scanEls.canvas.style.cursor = "";
}

/** OpenCV.js 加载由 script/opencv-loader.js 提供（全局 loadOpenCV，与指纹提取工具共用） */

/** 展示用缩放比：画布宽固定，坐标换算回图像像素 */
function scanDisplayScale() {
	return scanEls.canvas.width / scanner.img.width;
}

// 画布无法用 CSS 变量，统一从 :root 解析一次（新增颜色须先在 root 定义）
const SCAN_CSS = (() => {
	const s = getComputedStyle(document.documentElement);
	const v = (name) => s.getPropertyValue(name).trim();
	return {
		badgeBg: v("--tooltip-bg"), // 编号角标黑底
		badgeText: v("--white"), // 编号角标白字
		hover: v("--white"), // 结果表 hover / 触摸行的棋子高亮色
		accent: v("--accent"), // 选格补录的已选格子高亮色
	};
})();

/** 重绘截图与定位框 / 网格叠加层 */
function scanRedraw() {
	const { img, rect } = scanner;
	if (!img) return;
	const ctx = scanEls.canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, scanEls.canvas.width, scanEls.canvas.height);
	if (!rect) return;
	const s = scanDisplayScale();
	const { cols, rows } = scanGridDims();
	const cw = ((rect.R - rect.L) / cols) * s;
	const ch = ((rect.B - rect.T) / rows) * s;
	// 线宽随画布分辨率取比例，保证不同尺寸截图下都清晰可见
	const L = rect.L * s;
	const T = rect.T * s;
	const R = rect.R * s;
	const B = rect.B * s;
	// 先画网格切分线，再压上外边界，交界处边界色不被盖住
	ctx.lineWidth = Math.max(2, scanEls.canvas.width * 0.005);
	ctx.strokeStyle = "#3fae5a";
	ctx.beginPath();
	for (let i = 1; i < cols; i++) {
		const x = L + cw * i;
		ctx.moveTo(x, T);
		ctx.lineTo(x, B);
	}
	for (let i = 1; i < rows; i++) {
		const y = T + ch * i;
		ctx.moveTo(L, y);
		ctx.lineTo(R, y);
	}
	ctx.stroke();
	ctx.lineWidth = Math.max(3, scanEls.canvas.width * 0.009);
	ctx.strokeStyle = "#e03c31";
	ctx.strokeRect(L, T, R - L, B - T);
	// 自动识别棋子叠加层：位置高亮 + 编号（与结果表行号一致，同一合并行同一编号）；
	// 颜色按品质区分，半透明填充不遮挡截图细节，描边清晰；手动录入行不画
	const SCAN_QUAL_STROKE = [
		"#3fae5a",
		"#3a8fd9",
		"#9b5fd0",
		"#d89a2b",
		"#e03c31",
	];
	scanner.items.forEach((item, idx) => {
		if (!item.pieces) return;
		const color = SCAN_QUAL_STROKE[item.quality] || "#3fae5a";
		item.pieces.forEach((p) => {
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.22;
			p.cells.forEach(([r, c]) => {
				ctx.fillRect(L + cw * c, T + ch * r, cw, ch);
			});
			ctx.globalAlpha = 1;
			// 描边逐格勾勒，形状内部边界也可见
			ctx.strokeStyle = color;
			ctx.lineWidth = Math.max(1.5, scanEls.canvas.width * 0.003);
			p.cells.forEach(([r, c]) => {
				ctx.strokeRect(L + cw * c, T + ch * r, cw, ch);
			});
			// 编号圆点：画在锚点格左上角，黑底白字，数字与结果表行号一致
			const ax = L + cw * p.anchor[1];
			const ay = T + ch * p.anchor[0];
			const rad = Math.max(8, Math.min(cw, ch) * 0.22);
			ctx.beginPath();
			ctx.arc(ax + rad, ay + rad, rad, 0, Math.PI * 2);
			ctx.fillStyle = SCAN_CSS.badgeBg;
			ctx.fill();
			ctx.fillStyle = SCAN_CSS.badgeText;
			ctx.font = `bold ${Math.round(rad * 1.1)}px sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(String(idx + 1), ax + rad, ay + rad);
		});
	});
	// 高亮绘制：加粗描边 + 更强填充压在最上层，与品质色叠加区分开；
	// 结果表 hover / 触摸高亮该行全部棋子，预览图 tooltip 只高亮当前指向的棋子本身
	const drawPieceHi = (p) => {
		ctx.fillStyle = SCAN_CSS.hover;
		ctx.globalAlpha = 0.4;
		p.cells.forEach(([r, c]) => {
			ctx.fillRect(L + cw * c, T + ch * r, cw, ch);
		});
		ctx.globalAlpha = 1;
		ctx.strokeStyle = SCAN_CSS.hover;
		ctx.lineWidth = Math.max(3, scanEls.canvas.width * 0.008);
		p.cells.forEach(([r, c]) => {
			ctx.strokeRect(L + cw * c, T + ch * r, cw, ch);
		});
	};
	const hItem = scanner.items[scanner.hoverIdx];
	if (hItem?.pieces) hItem.pieces.forEach(drawPieceHi);
	if (scanner.tipPiece) drawPieceHi(scanner.tipPiece);
	// 选格补录：已选格子高亮（accent 半透明填充 + 描边），压在普通叠加层之上
	if (scanner.pickSel.size) {
		ctx.fillStyle = SCAN_CSS.accent;
		ctx.globalAlpha = 0.35;
		scanner.pickSel.forEach((key) => {
			const [r, c] = key.split(",").map(Number);
			ctx.fillRect(L + cw * c, T + ch * r, cw, ch);
		});
		ctx.globalAlpha = 1;
		ctx.strokeStyle = SCAN_CSS.accent;
		ctx.lineWidth = Math.max(3, scanEls.canvas.width * 0.008);
		scanner.pickSel.forEach((key) => {
			const [r, c] = key.split(",").map(Number);
			ctx.strokeRect(L + cw * c, T + ch * r, cw, ch);
		});
	}
	// 边界调整模式：画出 8 个拖拽手柄（保持在叠加层之上）
	if (scanner.editing) {
		const hs = Math.max(7, scanEls.canvas.width * 0.014);
		const midX = (L + R) / 2;
		const midY = (T + B) / 2;
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = "#e03c31";
		ctx.lineWidth = Math.max(1.5, scanEls.canvas.width * 0.003);
		for (const [hx, hy] of [
			[L, T],
			[midX, T],
			[R, T],
			[L, midY],
			[R, midY],
			[L, B],
			[midX, B],
			[R, B],
		]) {
			ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
			ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
		}
	}
	// 状态变化大多会触发重绘，顺带同步全屏操作栏按钮状态
	scanSyncFs();
}

/** 自动定位：缩放到检测宽度后跑检测，成功则换算回原图坐标并自动切分 */
async function scanAutoDetect() {
	if (!scanner.img) return;
	scanStatus("自动定位中…");
	try {
		// OpenCV 未就绪时等待下载，进度经 scanCvProgress 实时显示
		scanner.cv = await loadOpenCV(scanCvProgress);
		scanStatus("自动定位中…");
	} catch {
		scanEnterPicking("自动定位组件加载失败，请在截图上拖出棋盘区域");
		return;
	}
	const { cols, rows } = scanGridDims();
	// 检测图：1:1 取像素后走共享双线性重采样（与 node bench 逐字节一致）
	const { imgData, scale } = scanMakeDetectImage(scanner.img, scanner.detectWidth);
	const rect = scanDetectBoard(scanner.cv, imgData, cols, rows);
	if (!rect) {
		scanEnterPicking("自动定位失败，请在截图上拖出棋盘区域");
		return;
	}
	scanner.rect = {
		L: rect.L / scale,
		T: rect.T / scale,
		R: rect.R / scale,
		B: rect.B / scale,
	};
	scanRedraw();
	scanSlice();
}

/** 进入手动框选模式：十字光标，在图上拖出棋盘区域后自动切分 */
function scanEnterPicking(hint) {
	scanSetPick(false);
	scanHideTip(false);
	scanner.picking = true;
	scanner.pickStart = null;
	scanEls.recognizeBtn.disabled = true;
	scanEls.canvas.classList.add("picking");
	scanStatus(hint, "err");
}

/** 归一化切格：每格重采样为 SCAN_CELL_SIZE²，产出 scanner.result；
 * 切格完成即拿到棋盘位置信息，自动执行一次棋子识别（等同点击「开始识别」） */
function scanSlice() {
	const { img, rect } = scanner;
	if (!img || !rect) return;
	const { cols, rows } = scanGridDims();
	const { cells, grid } = scanSliceCells(img, rect, rows, cols);
	scanner.result = {
		img,
		rect: { ...rect },
		cols,
		rows,
		cellSize: SCAN_CELL_SIZE,
		cells,
		grid,
	};
	// 切格变化后旧识别坐标失效：清空棋子与结果表（手动录入行随后由自动识别整表重建）
	scanner.pieces = [];
	scanner.items = [];
	scanClearPickSel();
	scanRenderItems();
	scanEls.recognizeBtn.disabled = false;
	scanEls.pickBtn.disabled = false;
	// 拿到棋盘位置信息后自动识别一次棋子；识别结束的状态会覆盖此提示
	scanStatus(`定位完成：${rows}×${cols} 网格，正在自动识别棋子…`, "ok");
	scanRecognize();
}

/** 棋子识别核心 */
// 流程：scanner.result.cells(64×64) 逐格提取特征（品质底色 / 左上锚点 / 右下数字徽标）
// → 每个锚点枚举候选形状 → 回溯 + MRV + 位掩码全局 packing → 按 类型+形状+品质 查目录命名；
// 采样阈值与各步实现见 script/scan-core.js（与指纹提取工具共用）
/** 开始识别：特征 → 候选 → packing → 命名，结果填入 scanner.pieces 与 scanner.items */
function scanRecognize() {
	const res = scanner.result;
	if (!res) return;
	const { cells, rows, cols } = res;
	const feat = cells.map((row) =>
		row.map((cv) =>
			scanCellFeat(
				cv.getContext("2d").getImageData(0, 0, SCAN_CELL_SIZE, SCAN_CELL_SIZE)
					.data,
			),
		),
	);
	const { anchors, candMap } = scanGenCandidates(feat, rows, cols);
	const packed = scanPack(anchors, candMap, feat, rows, cols);
	// 组装棋子（scanner.pieces 供预览叠加层高亮 / 确认导入使用）
	scanner.pieces = [];
	packed.assign.forEach((cand) => {
		if (!cand) return;
		const named = scanNamePiece(cand, feat);
		const piece = {
			...named,
			quality: cand.quality,
			shape: cand.shape.key,
			shapeMat: cand.shape.mat,
			cells: cand.cells,
			anchor: cand.anchor,
			origin: cand.origin,
			score: cand.score,
			confidence: Math.max(
				5,
				Math.min(99, Math.round(100 * cand.score * named.nameFactor)),
			),
		};
		piece.thumb = scanPieceThumb(piece, cells);
		scanner.pieces.push(piece);
	});
	console.debug(
		"棋子识别",
		scanner.pieces.map(
			(p) =>
				`${p.anchor} ${p.name || p.names.join("/") || "?"} ${p.shape} q${p.quality}`,
		),
	);
	// 填入结果表：整表重建（手动录入行一并清除，由用户重新补录）；同名同品质合并数量
	scanner.items = [];
	const merged = new Map();
	scanner.pieces.forEach((p) => {
		const key = p.name ? `${p.name}|${p.quality}` : `?|${p.anchor}`;
		const old = merged.get(key);
		if (old) {
			old.count++;
			old.confidence = Math.min(old.confidence, p.confidence);
			old.pieces.push(p);
			return;
		}
		merged.set(key, {
			thumb: p.thumb,
			name: p.name,
			type: p.type || "",
			quality: p.quality,
			count: 1,
			confidence: p.confidence,
			cells: p.cells,
			anchor: p.anchor,
			pieces: [p],
			manual: false,
		});
	});
	merged.forEach((it) => scanner.items.push(it));
	scanRenderItems();
	const unnamed = scanner.pieces.filter((p) => !p.name).length;
	// 搜索超预算截断时结果不可靠，前缀提示人工核对
	const truncTip = packed.truncated
		? "搜索超预算，结果被截断，需人工核对；"
		: "";
	if (packed.cov < packed.total) {
		scanStatus(
			`${truncTip}部分识别：${scanner.pieces.length} 件，覆盖 ${packed.cov}/${packed.total} 格，有格子未能匹配，请人工核对`,
			"err",
		);
	} else if (packed.ambiguous || unnamed || packed.truncated) {
		scanStatus(
			`${truncTip}识别完成：${scanner.pieces.length} 件，覆盖 ${packed.cov}/${packed.total} 格；` +
				`${packed.ambiguous ? "存在近似歧义布局" : ""}${unnamed ? `${unnamed} 件名称待人工确认` : ""}`,
			"err",
		);
	} else {
		scanStatus(
			`识别完成：${scanner.pieces.length} 件法宝，覆盖 ${packed.cov}/${packed.total} 格`,
			"ok",
		);
	}
}

/** 格子是否已被某行结果（自动识别 / 选格补录）的棋子覆盖 */
function scanCellOccupied(r, c) {
	return scanner.items.some((it) =>
		it.pieces?.some((p) => p.cells.some(([pr, pc]) => pr === r && pc === c)),
	);
}

/** 格子 -> 覆盖该格的 { 行号, 棋子 }（无则 null），预览图 tooltip 命中检测用 */
function scanCellPieceHit(r, c) {
	for (let idx = 0; idx < scanner.items.length; idx++) {
		const piece = scanner.items[idx].pieces?.find((p) =>
			p.cells.some(([pr, pc]) => pr === r && pc === c),
		);
		if (piece) return { idx, piece };
	}
	return null;
}

/** 隐藏预览图法宝 tooltip 并清除对应高亮（redraw 为 false 时只隐浮层，由调用方负责重绘） */
function scanHideTip(redraw = true) {
	scanEls.tip.hidden = true;
	if (!scanner.tipPiece) return;
	scanner.tipIdx = -1;
	scanner.tipPiece = null;
	if (redraw) scanRedraw();
}

// 显示预览图法宝 tooltip：内容为 名称（类型）-品质（品质带颜色），同时高亮标注当前指向的棋子本身
// （同一合并行的其他同名棋子不高亮）；x / y 为指针 client 坐标，浮层跟随并做视口边缘收拢
function scanShowTip(idx, piece, x, y) {
	const item = scanner.items[idx];
	if (!item) {
		scanHideTip();
		return;
	}
	const tip = scanEls.tip;
	tip.replaceChildren();
	const name = document.createElement("span");
	name.textContent = item.name || "未命名";
	tip.appendChild(name);
	if (item.type) {
		const type = document.createElement("span");
		type.textContent = `（${item.type}）`;
		tip.appendChild(type);
	}
	const sep = document.createElement("span");
	sep.textContent = "-";
	tip.appendChild(sep);
	const quality = document.createElement("span");
	quality.textContent = utils.getQualityText(item.quality);
	quality.className = utils.getQualityColor(item.quality);
	tip.appendChild(quality);
	tip.hidden = false;
	// 浮层跟随指针右下方，超出视口右 / 下边缘时翻转到另一侧
	const m = 12;
	const tw = tip.offsetWidth;
	const th = tip.offsetHeight;
	tip.style.left = `${Math.max(4, x + m + tw > innerWidth ? x - m - tw : x + m)}px`;
	tip.style.top = `${Math.max(4, y + m + th > innerHeight ? y - m - th : y + m)}px`;
	if (scanner.tipPiece !== piece) {
		// 与结果表行高亮互斥：预览 tooltip 出现时清掉表格侧高亮
		scanner.hoverIdx = -1;
		scanner.tipIdx = idx;
		scanner.tipPiece = piece;
		scanRedraw();
	}
}

/** 选格补录模式开关：与框选 / 边界调整互斥，开启时显示补录条 */
function scanSetPick(on) {
	scanner.cellPick = on;
	if (on) scanHideTip(false);
	scanEls.pickBtn.classList.toggle("active", on);
	scanEls.pickBar.hidden = !on;
	if (!on) scanClearPickSel();
	else scanPickUpdate();
	scanEls.canvas.style.cursor = on ? "pointer" : "";
	// picking 类：移动端隐藏结果表放大预览、全屏时让补录条浮到预览层底部
	scanEls.panel.classList.toggle("picking", on);
	scanSyncFsPick();
	scanSyncFs();
	scanRedraw();
}

// 全屏 + 补录模式：把预览层底边抬到补录条上方，避免表单遮挡格子；
// ResizeObserver 跟随补录条高度变化（表单换行 / 下拉展开收起）
const scanFsPickRO = new ResizeObserver(() => scanSyncFsPickOffset());

function scanSyncFsPickOffset() {
	const inFsPick =
		scanEls.media.classList.contains("fs-mode") && scanner.cellPick;
	scanEls.media.style.bottom = inFsPick
		? `${scanEls.pickBar.offsetHeight}px`
		: "";
}

function scanSyncFsPick() {
	scanFsPickRO.disconnect();
	if (scanEls.media.classList.contains("fs-mode") && scanner.cellPick) {
		scanFsPickRO.observe(scanEls.pickBar);
	}
	scanSyncFsPickOffset();
}

/** 清空已选格子并刷新补录表单（不改变模式开关） */
function scanClearPickSel() {
	scanner.pickSel.clear();
	scanner.pickHadSel = false;
	scanner.pickNameAuto = "";
	scanEls.pickName.value = "";
	scanPickUpdate();
}

/** 选格补录：点选 / 取消一个格子（已被识别覆盖的格子不可选） */
function scanPickToggle(r, c) {
	const key = `${r},${c}`;
	if (scanCellOccupied(r, c)) {
		scanStatus("该格已被识别棋子占用，不可选", "err");
		return;
	}
	if (scanner.pickSel.has(key)) scanner.pickSel.delete(key);
	else scanner.pickSel.add(key);
	scanPickUpdate();
	scanRedraw();
}

// 补录表单联动（同指纹提取工具做法）：形状匹配 / 类型识别（元素徽标）/ 品质推荐（多数投票）/
// 名称候选推导；识别结果均可手动修改
function scanPickUpdate() {
	const sel = [...scanner.pickSel].map((k) => k.split(",").map(Number));
	const has = sel.length > 0;
	const notes = [];
	// 形状：先算出矩阵与规范名，图形化网格延后到品质投票之后渲染（颜色取最终品质值）
	let mat = null;
	let shapeKey = null;
	if (has) {
		mat = scanCellsToMat(sel);
		shapeKey = SHAPES[JSON.stringify(mat)] || null;
	}
	// 逐格特征：品质投票 + 元素徽标类型 + 空格预警
	if (has && scanner.result) {
		const tally = [0, 0, 0, 0, 0];
		let emptyCnt = 0;
		const dotTypes = [];
		sel.forEach(([r, c]) => {
			const data = scanner.result.cells[r][c]
				.getContext("2d")
				.getImageData(0, 0, SCAN_CELL_SIZE, SCAN_CELL_SIZE).data;
			const q = scanCellQualityVote(data);
			if (q < 0) emptyCnt++;
			else tally[q]++;
			const feat = scanCellFeat(data);
			if (feat.dot && feat.dotType) dotTypes.push(feat.dotType);
		});
		// 类型 / 品质推荐只在新一次点选（从空到非空）时填入，之后不覆盖用户手改
		if (!scanner.pickHadSel) {
			let mq = 0;
			tally.forEach((n, q) => {
				if (n > tally[mq]) mq = q;
			});
			if (tally[mq]) scanEls.pickQuality.value = mq;
			const uniq = [...new Set(dotTypes)];
			if (uniq.length === 1) scanEls.pickType.value = uniq[0];
			else if (uniq.length > 1) notes.push(`徽标识别冲突：${uniq.join(" / ")}，请手动确认类型`);
		}
		if (emptyCnt) notes.push(`注意：${emptyCnt} 个选中格像空格，请检查是否点错`);
	}
	scanner.pickHadSel = has;
	// 形状：图形化网格（复用主表 utils.shape2Html，颜色跟随最终品质值）+ 规范名文本，
	// SHAPES 双映射查不到规范名时文本标红提示
	scanEls.pickShape.className = `scan-pick-shape${has && !shapeKey ? " unknown" : ""}`;
	scanEls.pickShape.replaceChildren();
	if (has && mat) {
		scanEls.pickShape.appendChild(
			utils.shape2Html(mat, Number(scanEls.pickQuality.value) || 0),
		);
		const label = document.createElement("span");
		label.textContent = shapeKey || `未知形状（${sel.length} 格）`;
		scanEls.pickShape.appendChild(label);
	} else {
		scanEls.pickShape.textContent = "—";
	}
	// 名称候选：类型 + 品质 + 形状推导（含旋转匹配）；唯一候选自动填入，
	// 用户手改过（与上次自动值不同）则不覆盖；候选变为歧义 / 无匹配时清掉此前的自动填入值
	const type = scanEls.pickType.value;
	const quality = Number(scanEls.pickQuality.value);
	let expect = { names: [], rotated: false };
	if (has && type) expect = scanExpectNames(type, quality, sel);
	if (has && type) {
		notes.push(
			expect.names.length
				? `候选名称：${expect.names.join(" / ")}${expect.rotated ? "（旋转后匹配）" : ""}`
				: "名录无匹配，请检查类型 / 品质 / 选格",
		);
	}
	if (expect.names.length === 1) {
		if (
			!scanEls.pickName.value ||
			scanEls.pickName.value === scanner.pickNameAuto
		) {
			scanEls.pickName.value = expect.names[0];
			scanner.pickNameAuto = expect.names[0];
		}
	} else if (
		scanner.pickNameAuto &&
		scanEls.pickName.value === scanner.pickNameAuto
	) {
		scanEls.pickName.value = "";
		scanner.pickNameAuto = "";
	}
	scanEls.pickNote.textContent = has
		? notes.join("；")
		: "点选预览图中未被识别的格子组成法宝，识别结果会实时显示在下方";
	scanEls.pickConfirmBtn.disabled = !has;
}

/** 预览全屏开关（纯 CSS 全视口层，iPhone Safari 无 Fullscreen API） */
function scanSetFs(on) {
	scanEls.media.classList.toggle("fs-mode", on);
	// fs 类：配合 picking 类让补录条浮到全屏预览层底部
	scanEls.panel.classList.toggle("fs", on);
	scanEls.fsToolbar.hidden = !on;
	// 进入全屏时结果表不可见、浮层坐标也随布局变化失效：
	// 清掉表格点选残留的棋子高亮与预览 tooltip，避免高亮卡死无法取消
	if (on) {
		scanner.hoverIdx = -1;
		scanHideTip(false);
		scanRedraw();
	}
	scanSyncFsPick();
	scanSyncFs();
}

/** 全屏操作栏按钮状态与底部控制栏保持同步（禁用态 / 模式高亮） */
function scanSyncFs() {
	if (scanEls.fsToolbar.hidden) return;
	[
		[scanEls.fsAuto, scanEls.autoBtn],
		[scanEls.fsManual, scanEls.manualBtn],
		[scanEls.fsEdit, scanEls.editBtn],
		[scanEls.fsRecognize, scanEls.recognizeBtn],
		[scanEls.fsPick, scanEls.pickBtn],
	].forEach(([f, s]) => {
		f.disabled = s.disabled;
		f.classList.toggle("active", s.classList.contains("active"));
	});
}

function scanSetImage(bitmap) {
	scanner.img = bitmap;
	scanner.rect = null;
	scanner.result = null;
	scanner.picking = false;
	scanner.pickStart = null;
	// 换图后旧识别坐标失效：清空棋子与结果表（含手动录入行）
	scanner.pieces = [];
	scanner.items = [];
	scanSetPick(false);
	scanRenderItems();
	scanStopEditing();
	scanEls.canvas.classList.remove("picking");
	scanEls.drop.hidden = true;
	scanEls.stage.hidden = false;
	scanEls.reuploadBtn.hidden = false;
	scanEls.fsBtn.hidden = false;
	scanEls.autoBtn.disabled = false;
	scanEls.manualBtn.disabled = false;
	scanEls.editBtn.disabled = false;
	scanEls.recognizeBtn.disabled = true;
	scanEls.pickBtn.disabled = true;
	// 展示宽度上限 860px，超大图按比例缩小；显示尺寸由 CSS 按容器 contain
	const w = Math.min(860, bitmap.width);
	scanEls.canvas.width = w;
	scanEls.canvas.height = Math.round((bitmap.height * w) / bitmap.width);
	// 画面框宽高比（纯 CSS contain 用），随图片更新一次即可
	scanEls.media.style.setProperty(
		"--scan-ar",
		String(bitmap.width / bitmap.height),
	);
	scanRedraw();
	scanAutoDetect();
}

function scanLoadFile(file) {
	if (!file || !file.type.startsWith("image/")) return;
	createImageBitmap(file).then(scanSetImage, () => {
		scanStatus("图片读取失败", "err");
	});
}

// 用 requestAnimationFrame 节流高频事件（resize / scroll / pointermove）：同一帧内多次触发只保留最后一次，下一帧统一执行
const rafThrottle = (fn) => {
	let queued = false;
	let lastArgs = null;
	return (...args) => {
		lastArgs = args;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			fn(...lastArgs);
		});
	};
};

/** 弹窗开关：打开期间锁定底层页面滚动（html + body），关闭时恢复并还原滚动位置 */
let scanSavedScrollY = 0;
/** 弹窗打开时（及每次重切格后）记录的棋盘行列，用于用户取消重切格时恢复输入框原值 */
let scanModalDims = null;

function scanOpenModal() {
	scanSavedScrollY = window.scrollY;
	scanEls.modal.hidden = false;
	document.documentElement.style.overflow = "hidden";
	document.body.style.overflow = "hidden";
	scanModalDims = scanGridDims();
	// 首次打开即渲染空态占位行，与主表空态表现一致
	scanRenderItems();
}

function scanCloseModal() {
	scanSetFs(false);
	scanHideTip(false);
	scanEls.modal.hidden = true;
	document.documentElement.style.overflow = "";
	document.body.style.overflow = "";
	window.scrollTo(0, scanSavedScrollY);
}

function scanInit() {
	scanEls.openBtn.addEventListener("click", () => {
		scanOpenModal();
		// 提前加载 OpenCV，缩短首次定位等待；下载进度显示在预览区状态条
		loadOpenCV(scanCvProgress)
			.then((cv) => {
				scanner.cv = cv;
				// 尚未上传截图时给一句就绪反馈（自动隐藏），有图时由定位流程覆盖状态
				if (!scanner.img) scanStatus("识别组件已就绪", "ok");
			})
			.catch(() => {
				if (!scanner.img)
					scanStatus("识别组件加载失败，上传截图后可手动框选", "err");
			});
	});
	scanEls.closeBtn.addEventListener("click", scanCloseModal);

	scanEls.drop.addEventListener("click", () => scanEls.file.click());
	scanEls.file.addEventListener("change", () => {
		scanLoadFile(scanEls.file.files[0]);
		scanEls.file.value = "";
	});
	// 拖拽在整个预览区生效，已有预览图时也可以直接拖入新截图
	["dragover", "dragleave", "drop"].forEach((type) =>
		scanEls.media.addEventListener(type, (e) => {
			e.preventDefault();
			scanEls.media.classList.toggle("dragover", type === "dragover");
			if (type === "drop") scanLoadFile(e.dataTransfer.files[0]);
		}),
	);
	scanEls.reuploadBtn.addEventListener("click", () => scanEls.file.click());
	// 弹窗打开期间支持直接粘贴剪贴板截图
	document.addEventListener("paste", (e) => {
		if (scanEls.modal.hidden) return;
		const item = [...(e.clipboardData?.items || [])].find((it) =>
			it.type.startsWith("image/"),
		);
		if (item) scanLoadFile(item.getAsFile());
	});

	scanEls.autoBtn.addEventListener("click", scanAutoDetect);
	scanEls.manualBtn.addEventListener("click", () => {
		if (!scanner.img) return;
		scanStopEditing();
		scanSetPick(false);
		scanEnterPicking("手动框选：在截图上拖出棋盘区域");
	});
	// 调整边界：拖动边缘 / 角点缩放识别外边界，按住中间整体移动
	scanEls.editBtn.addEventListener("click", () => {
		if (!scanner.img) return;
		if (scanner.editing) {
			scanStopEditing();
			scanRedraw();
			return;
		}
		if (!scanner.rect) {
			scanStatus("请先自动定位或手动框选棋盘，再调整边界", "err");
			return;
		}
		scanSetPick(false);
		scanner.editing = true;
		scanner.picking = false;
		scanner.pickStart = null;
		scanHideTip(false);
		scanEls.canvas.classList.remove("picking");
		scanEls.editBtn.classList.add("active");
		scanStatus("调整边界：拖动边缘 / 角点缩放，按住中间移动；再次点击按钮退出");
		scanRedraw();
	});
	// 选格补录：与框选 / 边界调整互斥；开启后在预览图上点选未识别的格子
	scanEls.pickBtn.addEventListener("click", () => {
		if (scanner.cellPick) {
			scanSetPick(false);
			return;
		}
		if (!scanner.result) return;
		scanStopEditing();
		scanner.picking = false;
		scanner.pickStart = null;
		scanEls.canvas.classList.remove("picking");
		scanSetPick(true);
		scanStatus("选格补录：点选未被识别的格子组成法宝，确认后填入结果表");
	});
	// 补录条：类型 / 品质修改后重推名称候选；清除选择；确认填入结果表
	scanEls.pickType.replaceChildren(
		...["", ...Object.keys(BLOCKS)].map((t) => {
			const opt = document.createElement("option");
			opt.value = t;
			opt.text = t || "未知";
			return opt;
		}),
	);
	scanEls.pickQuality.replaceChildren(
		...QUALITY_NAMES.map((n, q) => {
			const opt = document.createElement("option");
			opt.value = q;
			opt.text = `${n}阶`;
			return opt;
		}),
	);
	scanEls.pickQuality.value = 3;
	scanEls.pickType.addEventListener("change", scanPickUpdate);
	scanEls.pickQuality.addEventListener("change", scanPickUpdate);
	scanEls.pickClearBtn.addEventListener("click", () => {
		scanClearPickSel();
		scanRedraw();
	});
	// 名称可搜索下拉：候选跟随 类型 + 品质 + 形状（同结果表筛选口径）
	const pickCommitName = (name) => {
		scanEls.pickName.value = name;
		scanner.pickNameAuto = "";
	};
	const pickOpenList = () => {
		const kw = scanEls.pickName.value.trim();
		const sel = [...scanner.pickSel].map((k) => k.split(",").map(Number));
		let cands = sel.length
			? scanNameCandidates({
					type: scanEls.pickType.value,
					quality: Number(scanEls.pickQuality.value),
					pieces: [{ shapeMat: scanCellsToMat(sel) }],
				})
			: [];
		// 严格候选为空时放宽形状约束（形状未匹配名录时仍可人工选名）
		if (sel.length && !cands.length)
			cands = scanNameCandidates({
				type: scanEls.pickType.value,
				quality: Number(scanEls.pickQuality.value),
			});
		const frag = document.createDocumentFragment();
		let count = 0;
		cands.forEach((name) => {
			if (kw && !name.includes(kw)) return;
			count++;
			const opt = document.createElement("div");
			opt.className = "scan-name-opt";
			opt.textContent = name;
			opt.addEventListener("mousedown", (e) => {
				e.preventDefault();
				pickCommitName(name);
				scanEls.pickNameList.hidden = true;
				// 选择完成后主动失焦（同结果表名称框），避免焦点残留影响下一个控件
				scanEls.pickName.blur();
			});
			frag.appendChild(opt);
		});
		if (!count) {
			const none = document.createElement("div");
			none.className = "scan-name-opt none";
			none.textContent = sel.length ? "无匹配法宝" : "请先点选格子";
			frag.appendChild(none);
		}
		scanEls.pickNameList.replaceChildren(frag);
		const r = scanEls.pickName.getBoundingClientRect();
		scanEls.pickNameList.style.left = `${r.left}px`;
		scanEls.pickNameList.style.top = `${r.bottom + 2}px`;
		scanEls.pickNameList.style.width = `${Math.max(r.width, 120)}px`;
		scanEls.pickNameList.hidden = false;
	};
	scanEls.pickName.addEventListener("focus", pickOpenList);
	scanEls.pickName.addEventListener("input", pickOpenList);
	scanEls.pickName.addEventListener("blur", () => {
		scanEls.pickNameList.hidden = true;
		if (!SCAN_BLOCK_NAMES.has(scanEls.pickName.value)) {
			scanEls.pickName.value =
				scanner.pickNameAuto || "";
		}
	});
	// 确认填入：校验连通 / 类型 / 名称后作为手动录入行加入结果表（重新识别时整表重建）
	scanEls.pickConfirmBtn.addEventListener("click", () => {
		const sel = [...scanner.pickSel].map((k) => k.split(",").map(Number));
		if (!sel.length) {
			scanStatus("请先点选棋子占用的格子", "err");
			return;
		}
		if (!scanCellsConnected(sel)) {
			scanStatus("选中格不连通，请检查选格", "err");
			return;
		}
		const type = scanEls.pickType.value;
		const quality = Number(scanEls.pickQuality.value);
		const name = scanEls.pickName.value.trim();
		if (!type) {
			scanStatus("请选择法宝类型", "err");
			return;
		}
		// 名称歧义（候选两个及以上）时必须先选择其一
		const expect = scanExpectNames(type, quality, sel);
		if (expect.names.length > 1 && !expect.names.includes(name)) {
			scanStatus(
				`名称有歧义：${expect.names.join(" / ")}，请选择其一`,
				"err",
			);
			return;
		}
		if (!name || !SCAN_BLOCK_NAMES.has(name)) {
			scanStatus("请从候选中选择法宝名称", "err");
			return;
		}
		const mat = scanCellsToMat(sel);
		const anchor = [...sel].sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
		const piece = {
			cells: sel,
			anchor,
			// 缩略图按形状包围盒拼接，origin 取包围盒左上角（锚点是其首格，未必最左）
			origin: [
				Math.min(...sel.map(([r]) => r)),
				Math.min(...sel.map(([, c]) => c)),
			],
			shapeMat: mat,
			shape: SHAPES[JSON.stringify(mat)] || "",
		};
		piece.thumb = scanPieceThumb(piece, scanner.result.cells);
		scanner.items.push({
			thumb: piece.thumb,
			name,
			type,
			quality,
			count: 1,
			confidence: null,
			manual: true,
			cells: sel,
			anchor,
			pieces: [piece],
		});
		scanClearPickSel();
		scanRenderItems();
		scanStatus(`已填入「${name}」到识别结果`, "ok");
	});
	// 预览全屏：操作栏按钮统一代理底部控制栏，逻辑单一出处
	scanEls.fsBtn.addEventListener("click", () => scanSetFs(true));
	scanEls.fsExit.addEventListener("click", () => scanSetFs(false));
	scanEls.fsAuto.addEventListener("click", () => scanEls.autoBtn.click());
	scanEls.fsManual.addEventListener("click", () => scanEls.manualBtn.click());
	scanEls.fsEdit.addEventListener("click", () => scanEls.editBtn.click());
	scanEls.fsRecognize.addEventListener("click", () =>
		scanEls.recognizeBtn.click(),
	);
	scanEls.fsPick.addEventListener("click", () => scanEls.pickBtn.click());
	scanEls.fsUpload.addEventListener("click", () => scanEls.file.click());
	// 开始识别：对已定位的棋盘运行识别核心（特征 → 候选 → packing → 命名）；
	// 已有结果（含手动录入行）时先确认，整表重建会丢弃用户对名称 / 品质 / 数量的修改与补录行
	scanEls.recognizeBtn.addEventListener("click", () => {
		if (!scanner.result) return;
		if (
			scanner.items.length &&
			!confirm("重新识别将清空当前识别结果及手动录入行，是否继续？")
		)
			return;
		scanRecognize();
	});
	// 新增一行识别结果（手动录入，重新识别 / 换图时清除）
	scanEls.addBtn.addEventListener("click", () => {
		scanner.items.push({
			thumb: null,
			name: "",
			type: "",
			quality: 3,
			count: 1,
			confidence: null,
			manual: true,
		});
		scanRenderItems();
	});
	// 确认导入：先清空当前已选列表（与「清空」按钮同一行为），再将有效行导入
	// （复用 addSelectedBlock 的同名同品质合并逻辑）；有未识别完整的行（无效 / 空名称）
	// 时先弹确认框，取消可返回修改，确定才丢弃这些行并导入其余行
	scanEls.importBtn.addEventListener("click", () => {
		const valid = [];
		let skipped = 0;
		scanner.items.forEach((item) => {
			const detail = SCAN_BLOCK_DETAILS.get(item.name);
			if (!detail || item.count < 1) {
				skipped++;
				return;
			}
			valid.push({ item, detail });
		});
		if (!valid.length) {
			scanStatus(
				skipped
					? `已丢弃 ${skipped} 行未识别完整的数据，没有可导入的数据`
					: "没有可导入的数据",
				"err",
			);
			return;
		}
		// 有未填写完整的行时先确认：取消可返回修改，确定才丢弃并导入其余行
		if (
			skipped &&
			!confirm(
				`有 ${skipped} 行法宝信息未填写完整（无效 / 空名称），导入时将被丢弃。\n` +
					`「确定」导入其余 ${valid.length} 行，「取消」返回修改。`,
			)
		) {
			scanStatus("已取消导入，可修正未填写完整的行后重新导入", "err");
			return;
		}
		clearSelectedBlocks();
		let imported = 0;
		valid.forEach(({ item, detail }) => {
			// 品质 clamp 兜底：普通法宝 values 只有 4 档，红色法宝固定五阶
			const quality = detail.fixed
				? 4
				: Math.min(item.quality, detail.values.length - 1);
			addSelectedBlock({
				name: item.name,
				type: detail.type,
				shape: detail.shape,
				bonus: detail.bonus,
				values: detail.values,
				fixed: detail.fixed,
				quality,
				nums: item.count,
			});
			imported += item.count;
		});
		scanner.items = [];
		scanRenderItems();
		scanStatus(`已导入 ${imported} 件到已选列表`, "ok");
		scanCloseModal();
	});

	// 画布坐标换算：返回相对画布的显示像素坐标及 图像px/显示px 比例
	const viewPos = (e) => {
		const b = scanEls.canvas.getBoundingClientRect();
		return {
			x: e.clientX - b.left,
			y: e.clientY - b.top,
			k: scanner.img.width / b.width,
		};
	};
	const pickPos = (e) => {
		const p = viewPos(e);
		return { x: p.x * p.k, y: p.y * p.k };
	};
	// 边界调整：命中检测（显示像素坐标），返回拖拽区域
	const SCAN_HIT_T = 12;
	const SCAN_CURSORS = {
		nw: "nwse-resize",
		se: "nwse-resize",
		ne: "nesw-resize",
		sw: "nesw-resize",
		n: "ns-resize",
		s: "ns-resize",
		e: "ew-resize",
		w: "ew-resize",
		move: "move",
	};
	const scanHitZone = (x, y) => {
		const r = scanner.rect;
		if (!r) return null;
		const b = scanEls.canvas.getBoundingClientRect();
		const k = scanner.img.width / b.width;
		const L = r.L / k;
		const T = r.T / k;
		const R = r.R / k;
		const B = r.B / k;
		const t = SCAN_HIT_T;
		const onL = Math.abs(x - L) <= t;
		const onR = Math.abs(x - R) <= t;
		const onT = Math.abs(y - T) <= t;
		const onB = Math.abs(y - B) <= t;
		const inX = x >= L - t && x <= R + t;
		const inY = y >= T - t && y <= B + t;
		if (onL && onT) return "nw";
		if (onR && onT) return "ne";
		if (onL && onB) return "sw";
		if (onR && onB) return "se";
		if (onL && inY) return "w";
		if (onR && inY) return "e";
		if (onT && inX) return "n";
		if (onB && inX) return "s";
		if (x > L + t && x < R - t && y > T + t && y < B - t) return "move";
		return null;
	};

	scanEls.canvas.addEventListener("pointerdown", (e) => {
		// 触摸点按棋子：切换 tooltip 显示（再点同一棋子或空白处取消）；各编辑模式下不启用
		if (
			e.pointerType === "touch" &&
			!scanner.cellPick &&
			!scanner.picking &&
			!scanner.editing &&
			scanner.img &&
			scanner.rect
		) {
			const p = pickPos(e);
			const { cols, rows } = scanGridDims();
			const cw = (scanner.rect.R - scanner.rect.L) / cols;
			const ch = (scanner.rect.B - scanner.rect.T) / rows;
			const c = Math.floor((p.x - scanner.rect.L) / cw);
			const r = Math.floor((p.y - scanner.rect.T) / ch);
			const hit =
				r < 0 || c < 0 || r >= rows || c >= cols
					? null
					: scanCellPieceHit(r, c);
			if (!hit || scanner.tipPiece === hit.piece) scanHideTip();
			else scanShowTip(hit.idx, hit.piece, e.clientX, e.clientY);
			return;
		}
		// 选格补录：点击切换格子选中态（仅棋盘区域内、未被识别覆盖的格子）
		if (scanner.cellPick) {
			if (!scanner.rect) return;
			const p = pickPos(e);
			const { cols, rows } = scanGridDims();
			const cw = (scanner.rect.R - scanner.rect.L) / cols;
			const ch = (scanner.rect.B - scanner.rect.T) / rows;
			const c = Math.floor((p.x - scanner.rect.L) / cw);
			const r = Math.floor((p.y - scanner.rect.T) / ch);
			if (r < 0 || c < 0 || r >= rows || c >= cols) return;
			scanPickToggle(r, c);
			return;
		}
		if (scanner.picking) {
			scanner.pickStart = pickPos(e);
			scanEls.canvas.setPointerCapture(e.pointerId);
			return;
		}
		// 调整边界模式：命中边缘 / 角点缩放，中间整体移动
		if (!scanner.editing || !scanner.rect) return;
		const p = viewPos(e);
		const zone = scanHitZone(p.x, p.y);
		if (!zone) return;
		scanner.drag = {
			zone,
			x0: p.x,
			y0: p.y,
			k: p.k,
			rect0: { ...scanner.rect },
		};
		scanEls.canvas.setPointerCapture(e.pointerId);
	});
	scanEls.canvas.addEventListener(
		"pointermove",
		rafThrottle((e) => {
			if (scanner.picking && scanner.pickStart) {
				const p = pickPos(e);
				scanner.rect = {
					L: Math.min(scanner.pickStart.x, p.x),
					T: Math.min(scanner.pickStart.y, p.y),
					R: Math.max(scanner.pickStart.x, p.x),
					B: Math.max(scanner.pickStart.y, p.y),
				};
				scanRedraw();
				return;
			}
			if (!scanner.editing || !scanner.rect) return;
			const p = viewPos(e);
			if (!scanner.drag) {
				const zone = scanHitZone(p.x, p.y);
				scanEls.canvas.style.cursor = zone ? SCAN_CURSORS[zone] : "default";
				return;
			}
			const d = scanner.drag;
			const dx = (p.x - d.x0) * d.k;
			const dy = (p.y - d.y0) * d.k;
			const r0 = d.rect0;
			const { width: iw, height: ih } = scanner.img;
			const MIN = 20; // 最小棋盘边长（原图像素）
			let { L, T, R, B } = r0;
			if (d.zone === "move") {
				const rw = r0.R - r0.L;
				const rh = r0.B - r0.T;
				L = Math.min(Math.max(r0.L + dx, 0), iw - rw);
				T = Math.min(Math.max(r0.T + dy, 0), ih - rh);
				R = L + rw;
				B = T + rh;
			} else {
				if (d.zone.includes("w")) L = Math.min(Math.max(r0.L + dx, 0), R - MIN);
				if (d.zone.includes("e"))
					R = Math.max(Math.min(r0.R + dx, iw), L + MIN);
				if (d.zone.includes("n")) T = Math.min(Math.max(r0.T + dy, 0), B - MIN);
				if (d.zone.includes("s"))
					B = Math.max(Math.min(r0.B + dy, ih), T + MIN);
			}
			scanner.rect = { L, T, R, B };
			scanRedraw();
		}),
	);
	scanEls.canvas.addEventListener("pointerup", () => {
		if (scanner.picking) {
			scanner.picking = false;
			scanner.pickStart = null;
			scanEls.canvas.classList.remove("picking");
			if (scanner.rect && scanner.rect.R - scanner.rect.L > 20) {
				scanSlice();
			} else {
				scanner.rect = null;
				scanRedraw();
				scanEnterPicking("框选区域过小，请重新拖出棋盘区域");
			}
			return;
		}
		if (scanner.drag) {
			scanner.drag = null;
			scanSlice();
		}
	});

	// 预览图法宝 tooltip：mouse hover 实时跟随；框选 / 边界调整 / 选格补录模式下不启用
	scanEls.canvas.addEventListener(
		"pointermove",
		rafThrottle((e) => {
			if (e.pointerType !== "mouse") return;
			if (scanner.picking || scanner.editing || scanner.cellPick) {
				scanHideTip();
				return;
			}
			if (!scanner.img || !scanner.rect) return;
			const p = pickPos(e);
			const { cols, rows } = scanGridDims();
			const cw = (scanner.rect.R - scanner.rect.L) / cols;
			const ch = (scanner.rect.B - scanner.rect.T) / rows;
			const c = Math.floor((p.x - scanner.rect.L) / cw);
			const r = Math.floor((p.y - scanner.rect.T) / ch);
			const hit =
				r < 0 || c < 0 || r >= rows || c >= cols
					? null
					: scanCellPieceHit(r, c);
			if (!hit) scanHideTip();
			else scanShowTip(hit.idx, hit.piece, e.clientX, e.clientY);
		}),
	);
	// 触摸松手后浏览器也会补发 pointerleave，只有鼠标真正离开画布才隐藏 tooltip
	scanEls.canvas.addEventListener("pointerleave", (e) => {
		if (e.pointerType === "mouse") scanHideTip();
	});

	// 棋盘行列配置变化时重绘网格叠加层并重新切分；
	// 已有自动识别行时先确认，取消则恢复输入框原行列值，不触发重切格
	[els.boardCols, els.boardRows].forEach((ipt) =>
		ipt.addEventListener("change", () => {
			if (scanEls.modal.hidden || !scanner.img) return;
			const dims = scanGridDims();
			const prev = scanModalDims || dims;
			if (
				scanner.rect &&
				(dims.cols !== prev.cols || dims.rows !== prev.rows) &&
				scanner.items.some((it) => !it.manual) &&
				!confirm("行列变化将重新切格并覆盖当前自动识别结果及修改，是否继续？")
			) {
				els.boardCols.value = prev.cols;
				els.boardRows.value = prev.rows;
				scanRedraw();
				return;
			}
			scanModalDims = dims;
			scanRedraw();
			if (scanner.rect) scanSlice();
		}),
	);
	// 窗口尺寸变化时收起名称下拉，避免 fixed 定位与输入框错位（布局本身由纯 CSS 自适应）
	window.addEventListener(
		"resize",
		rafThrottle(() => {
			document
				.querySelectorAll(".scan-name-list")
				.forEach((l) => (l.hidden = true));
		}),
	);
	// 表格滚动时收起所有名称下拉，避免 fixed 定位与输入框错位
	scanEls.resultBody.addEventListener(
		"scroll",
		rafThrottle(() => {
			document
				.querySelectorAll(".scan-name-list")
				.forEach((l) => (l.hidden = true));
		}),
	);
	/*
	 * 移动端修复：名称下拉开着时是 fixed 浮层，会盖住下方的类型 / 品质等控件；
	 * 若等输入框 blur 才收起，这次点按先被浮层吞掉，select 要点第二次才能展开。
	 * 在 pointerdown 捕获阶段（click 派发与命中测试之前）就收起浮层，让这次点按直达目标控件
	 */
	document.addEventListener(
		"pointerdown",
		(e) => {
			document
				.querySelectorAll(".scan-name-list:not([hidden])")
				.forEach((l) => {
					// 点在下拉自身组合框内（输入框 / 选项）时保持打开
					if (!l.parentElement.contains(e.target)) l.hidden = true;
				});
		},
		true,
	);
}

/** 初始化 */
/** 清空已选列表：与已选列表「清空」按钮完全一致的行为（识别导入前复用） */
function clearSelectedBlocks() {
	selectedBlocks.length = 0;
	invalidateBest();
	renderSelectedBlocks();
	// 实时布局与计算日志一并清空
	layoutShown = null;
	hideCellTip();
	renderLayoutBoard();
	els.layoutLegend.replaceChildren();
	els.logScroll.querySelectorAll(".log-line").forEach((n) => n.remove());
	logStatus("未在计算");
}

function init() {
	// 静态数量输入框统一换自定义步进器（动态创建的由各处自行包装）
	document.querySelectorAll(".num-input").forEach(numStepper);
	typeSelectInit();
	renderSelectedBlocks();
	presetInit();
	boardInit();
	calcInit();
	cellTipInit();
	scanInit();

	els.clearBtn.addEventListener("click", clearSelectedBlocks);
}

init();
