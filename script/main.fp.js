"use strict";
/**
 * 法宝图标指纹提取工具
 *
 * 签名算法（sig / sigLegacy）、单格特征、棋盘定位、切格与棋子识别流水线
 * 均由 ../script/scan-core.js 提供（与 index.html 识别端共用，保证两端一致）；
 * 下方常量为共享函数的本工具别名，保留原有短名以减少调用点改动。
 */

const N = SCAN_CELL_SIZE;
const DETECT_WIDTH = SCAN_DETECT_WIDTH;
const BAND_IDX = SCAN_BAND_IDX;
const rgb2hsv = scanRgb2Hsv;
const qualClass = scanQualClass;
const cellQualityVote = scanCellQualityVote;
const cellBg = scanCellBg;
const cellSig = scanCellSig;
const cellSigLegacy = scanCellSigLegacy;
const fpDiff = scanFpDiff;
const sampleDotHues = scanDotHues;
const sampleDiskHues = scanDiskHues; // 元素校准分桶采样（圆盘全像素，2026-08-07 Step 4 起）
const detectBoard = scanDetectBoard;
const QUALITY_NAMES = ["一", "二", "三", "四", "五"];
// 品质配色（同主界面 main.js：一阶绿 -> 五阶红），用于 hover 浮层品阶文字着色
const QUALITY_TIP_COLORS = [
	"#4ade80",
	"#60a5fa",
	"#c084fc",
	"#f0c040",
	"#f87171",
];

/**
 * 形状表与法宝名录：来自 <script src> 引入的 shapes.data.js / blocks.data.js
 * （由 tools/形状生成工具.js 和 tools/文本图鉴转对象工具.js 生成）。
 * SHAPES_CACHE 含 键名->矩阵 与 矩阵->键名 双向映射；
 * CATALOG 由 blocks 派生：名称 -> [类型, 形状键, 是否红色法宝]。
 */
let SHAPES_CACHE = {};
let CATALOG = {};

function applyData(shapesData, blocksData) {
	SHAPES_CACHE = shapesData;
	CATALOG = {};
	Object.entries(blocksData).forEach(([type, sections]) => {
		["normal", "red"].forEach((sec) => {
			Object.entries(sections[sec] || {}).forEach(([name, entry]) => {
				CATALOG[name] = [
					type,
					SHAPES_CACHE[JSON.stringify(entry.shape)] || null,
					sec === "red",
				];
			});
		});
	});
	// 类型下拉从名录收集
	els.type.replaceChildren();
	[...new Set(Object.values(CATALOG).map((v) => v[0]))].forEach((t) => {
		const opt = document.createElement("option");
		opt.value = t;
		opt.textContent = t;
		els.type.appendChild(opt);
	});
	// 校准类型下拉：全类型（含名录暂无法宝的类型）
	els.calType.replaceChildren(
		...Object.keys(blocksData).map((t) => {
			const opt = document.createElement("option");
			opt.value = t;
			opt.textContent = t;
			return opt;
		}),
	);
	// 真值标注类型下拉：全类型（truth 的 type 即 BLOCKS 的键）
	annEls.type.replaceChildren(
		...Object.keys(blocksData).map((t) => {
			const opt = document.createElement("option");
			opt.value = t;
			opt.textContent = t;
			return opt;
		}),
	);
	els.dataStatus.textContent = `名录已加载：${Object.keys(CATALOG).length} 个法宝，已存指纹 ${Object.keys(LOADED_FP_REFS).length} 组（shapes.data.js + blocks.data.js + scan-fp-refs.js）`;
	els.dataStatus.className = "status ok";
	buildTableRows();
	renderTable();
	renderCalRanges();
	updateForm();
	updateAnnForm();
}

function loadData() {
	if (window.SHAPES && window.BLOCKS) {
		applyData(window.SHAPES, window.BLOCKS);
		return;
	}
	els.dataStatus.textContent =
		"无法加载 shapes.data.js / blocks.data.js，请先运行 tools 下的 形状生成工具.js 和 文本图鉴转对象工具.js";
	els.dataStatus.className = "status err";
}

const els = {
	dataStatus: document.getElementById("dataStatus"),
	parallel: document.getElementById("parallelInput"),
	file: document.getElementById("fileInput"),
	rows: document.getElementById("rowsInput"),
	cols: document.getElementById("colsInput"),
	auto: document.getElementById("autoBtn"),
	edit: document.getElementById("editBtn"),
	slice: document.getElementById("sliceBtn"),
	loadStatus: document.getElementById("loadStatus"),
	wrap: document.getElementById("canvasWrap"),
	canvas: document.getElementById("boardCanvas"),
	cellGrid: document.getElementById("cellGrid"),
	cellWarn: document.getElementById("cellWarn"),
	clearSel: document.getElementById("clearSelBtn"),
	shapeInfo: document.getElementById("shapeInfo"),
	thumb: document.getElementById("pieceThumb"),
	type: document.getElementById("typeSelect"),
	quality: document.getElementById("qualitySelect"),
	qualityGuess: document.getElementById("qualityGuess"),
	name: document.getElementById("nameInput"),
	nameList: document.getElementById("nameList"),
	extract: document.getElementById("extractBtn"),
	entryList: document.getElementById("entryList"),
	clear: document.getElementById("clearBtn"),
	output: document.getElementById("output"),
	copy: document.getElementById("copyBtn"),
	save: document.getElementById("saveBtn"),
	fpOpen: document.getElementById("fpOpenBtn"),
	fpPerm: document.getElementById("fpPermBtn"),
	fpRefresh: document.getElementById("fpRefreshBtn"),
	fpFileStatus: document.getElementById("fpFileStatus"),
	retrainBar: document.getElementById("retrainBar"),
	retrainMsg: document.getElementById("retrainMsg"),
	retrainCmd: document.getElementById("retrainCmd"),
	retrainCopy: document.getElementById("retrainCopyBtn"),
	filterToggle: document.getElementById("filterToggle"),
	tableStats: document.getElementById("tableStats"),
	blockTbody: document.getElementById("blockTbody"),
	modal: document.getElementById("extractModal"),
	modalTitle: document.getElementById("modalTitle"),
	modalTarget: document.getElementById("modalTarget"),
	modalClose: document.getElementById("modalClose"),
	modeExtract: document.getElementById("modeExtractBtn"),
	modeCal: document.getElementById("modeCalBtn"),
	form: document.getElementById("extractForm"),
	calPanel: document.getElementById("calPanel"),
	calSampleInfo: document.getElementById("calSampleInfo"),
	calType: document.getElementById("calType"),
	calAdd: document.getElementById("calAddBtn"),
	calRanges: document.getElementById("calRanges"),
	replayFile: document.getElementById("replayFile"),
	replayRows: document.getElementById("replayRows"),
	replayCols: document.getElementById("replayCols"),
	replayClear: document.getElementById("replayClearBtn"),
	replayStatus: document.getElementById("replayStatus"),
	replayWrap: document.getElementById("replayWrap"),
	replayTbody: document.getElementById("replayTbody"),
	btTruth: document.getElementById("btTruthFile"),
	btReport: document.getElementById("btReportFile"),
	btTruthStatus: document.getElementById("btTruthStatus"),
	btSummary: document.getElementById("btSummary"),
	btCompare: document.getElementById("btCompare"),
	btFailures: document.getElementById("btFailures"),
	btCards: document.getElementById("btCards"),
	dcTruth: document.getElementById("dcTruthFile"),
	dcImg: document.getElementById("dcImgFile"),
	dcSample: document.getElementById("dcSampleBtn"),
	dcStatus: document.getElementById("dcStatus"),
	dcHist: document.getElementById("dcHist"),
	dcLegend: document.getElementById("dcLegend"),
	dcWarn: document.getElementById("dcWarn"),
	dcTbody: document.getElementById("dcTbody"),
	dcAdoptAll: document.getElementById("dcAdoptAllBtn"),
	dcAdoptStatus: document.getElementById("dcAdoptStatus"),
	dcConfirm: document.getElementById("dcConfirm"),
	dcConfirmGo: document.getElementById("dcConfirmGo"),
	dcConfirmCancel: document.getElementById("dcConfirmCancel"),
	dcConfirmList: document.getElementById("dcConfirmList"),
	dcConfirmStatus: document.getElementById("dcConfirmStatus"),
	galPick: document.getElementById("galPickBtn"),
	galPerm: document.getElementById("galPermBtn"),
	galRefresh: document.getElementById("galRefreshBtn"),
	galFilter: document.getElementById("galFilterToggle"),
	galStats: document.getElementById("galStats"),
	galGuide: document.getElementById("galGuide"),
	galWrap: document.getElementById("galWrap"),
	galTbody: document.getElementById("galTbody"),
	galPreview: document.getElementById("galPreview"),
	galPreviewImg: document.getElementById("galPreviewImg"),
	galPreviewName: document.getElementById("galPreviewName"),
	btGalleryLoad: document.getElementById("btGalleryLoadBtn"),
	dcGalleryLoad: document.getElementById("dcGalleryLoadBtn"),
	grpStats: document.getElementById("grpStats"),
	grpTbody: document.getElementById("grpTbody"),
	gxBack: document.getElementById("gxBackBtn"),
	gxTitle: document.getElementById("gxTitle"),
	gxShapeSlot: document.getElementById("gxShapeSlot"),
	gxMembers: document.getElementById("gxMembers"),
	gxTruth: document.getElementById("gxTruthFile"),
	gxImg: document.getElementById("gxImgFile"),
	gxGalleryLoad: document.getElementById("gxGalleryLoadBtn"),
	gxSample: document.getElementById("gxSampleBtn"),
	gxSampleStatus: document.getElementById("gxSampleStatus"),
	gxCullStatus: document.getElementById("gxCullStatus"),
	gxSkipped: document.getElementById("gxSkipped"),
	gxCards: document.getElementById("gxCards"),
	gxJitter: document.getElementById("gxJitter"),
	gxAgg: document.getElementById("gxAggBtn"),
	gxAggStatus: document.getElementById("gxAggStatus"),
	gxReport: document.getElementById("gxReport"),
	gxCommitBar: document.getElementById("gxCommitBar"),
	gxMaxDiff: document.getElementById("gxMaxDiff"),
	gxCommit: document.getElementById("gxCommitBtn"),
	gxCommitStatus: document.getElementById("gxCommitStatus"),
	gxManualName: document.getElementById("gxManualName"),
	gxManualQuality: document.getElementById("gxManualQuality"),
	gxManualAdd: document.getElementById("gxManualAddBtn"),
};

/** 真值标注 tab 的元素引用 */
const annEls = {
	file: document.getElementById("annFileInput"),
	rows: document.getElementById("annRowsInput"),
	cols: document.getElementById("annColsInput"),
	auto: document.getElementById("annAutoBtn"),
	edit: document.getElementById("annEditBtn"),
	slice: document.getElementById("annSliceBtn"),
	loadStatus: document.getElementById("annLoadStatus"),
	wrap: document.getElementById("annCanvasWrap"),
	canvas: document.getElementById("annBoardCanvas"),
	cellGrid: document.getElementById("annCellGrid"),
	cellWarn: document.getElementById("annCellWarn"),
	clearSel: document.getElementById("annClearSelBtn"),
	coverage: document.getElementById("annCoverage"),
	shapeInfo: document.getElementById("annShapeInfo"),
	type: document.getElementById("annTypeSelect"),
	typeGuess: document.getElementById("annTypeGuess"),
	quality: document.getElementById("annQualitySelect"),
	qualityGuess: document.getElementById("annQualityGuess"),
	expectNames: document.getElementById("annExpectNames"),
	recStatus: document.getElementById("annRecStatus"),
	anchorInfo: document.getElementById("annAnchorInfo"),
	anchorPick: document.getElementById("annAnchorPickBtn"),
	name: document.getElementById("annNameInput"),
	nameList: document.getElementById("annNameList"),
	addPiece: document.getElementById("annAddPieceBtn"),
	formStatus: document.getElementById("annFormStatus"),
	pieceStats: document.getElementById("annPieceStats"),
	pieceList: document.getElementById("annPieceList"),
	truthFile: document.getElementById("annTruthFile"),
	saveTruth: document.getElementById("annSaveTruthBtn"),
	clearDraft: document.getElementById("annClearDraftBtn"),
	truthStatus: document.getElementById("annTruthStatus"),
	output: document.getElementById("annOutput"),
	outputBar: document.getElementById("annOutputBar"),
	copy: document.getElementById("annCopyBtn"),
};

const state = {
	entries: [], // 已提取条目
	hadSelection: false, // 上一次表单刷新时是否有选中格（用于品质推荐只填一次）
	target: null, // 表格行预填目标 { name, type, shapeKey, red, key }；null 为自由提取
	mode: "extract", // extract=指纹提取 / calibrate=元素色校准
	calSample: null, // 当前采样的有效 hue 列表
	dotSamples: {}, // 类型 -> hue[]（手动校准累积，localStorage 持久化）
	adoptedRanges: {}, // 类型 -> [lo, hi]（元素校准 tab 采用的建议区间，localStorage 持久化）
	showAll: false, // 名录表格：true 显示全部法宝，false 只显示歧义组
};
// 弹窗的截图工作区状态（img / rect / cells / selected / editing）移入
// createBoardWorkspace 实例 ws，见下方「截图工作区（内部组件）」

/** 识别配置与已保存指纹：初值来自 <script src> 引入的 scan-fp-refs.js（缺失时用默认值）；
 *  「打开数据文件」直读 data/scan-fp-refs.js 后由 fpApplyFile 刷新为磁盘最新值 */
let LOADED_DOT_TYPES = window.SCAN_DOT_TYPES || [[40, 85, "木"]];
let LOADED_FP_REFS = window.SCAN_FP_REFS || {};

const LS_KEY = "fp-extract:entries";
const LS_DIMS_KEY = "fp-extract:dims";
const LS_DOTS_KEY = "fp-extract:dotsamples";
const LS_ADOPT_KEY = "fp-extract:dotranges"; // 元素校准 tab 采用的建议区间
const LS_ANN_PREFIX = "fp-annotate:draft:"; // 真值标注草稿：按图片文件名存
const LS_RETRAIN_KEY = "fp-extract:retrain"; // 模型待重训标记（SCAN_DOT_TYPES 变更入库后）

/* tab 切换 */
let currentTab = "gallery"; // gallery=原始图库 / catalog=法宝名录 / annotate=真值标注 / replay=回放验证 / dotcalib=元素校准
document.querySelectorAll(".tab-bar button").forEach((btn) => {
	btn.addEventListener("click", () => {
		currentTab = btn.dataset.tab;
		gxOpen = false; // 离开组级提取下钻页（手动补图工作区停止接收拖拽 / 粘贴）
		document
			.querySelectorAll(".tab-bar button")
			.forEach((b) => b.classList.toggle("active", b === btn));
		document.querySelectorAll(".tab-page").forEach((page) => {
			page.hidden = page.id !== `tab-${currentTab}`;
		});
	});
});

/* 法宝名录表格 */
/** 名录行：{ name, type, shapeKey, red, key, groupSize }；key 与 SCAN_FP_REFS 键一致 */
let tableRows = [];
/** 歧义分组：key(类型|形状|红/普通) -> 名称数组，真值标注判断「提取指纹」按钮复用 */
let catalogGroups = new Map();

function buildTableRows() {
	const groups = new Map();
	Object.entries(CATALOG).forEach(([name, [type, shapeKey, red]]) => {
		const key = `${type}|${shapeKey || "未知形状"}|${red ? "red" : "normal"}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(name);
	});
	tableRows = Object.entries(CATALOG).map(([name, [type, shapeKey, red]]) => {
		const key = `${type}|${shapeKey || "未知形状"}|${red ? "red" : "normal"}`;
		return {
			name,
			type,
			shapeKey,
			red,
			key,
			groupSize: groups.get(key).length,
		};
	});
	// 歧义组在前、同组相邻；其余按 key / 名称排
	tableRows.sort(
		(a, b) =>
			(b.groupSize > 1) - (a.groupSize > 1) ||
			a.key.localeCompare(b.key, "zh") ||
			a.name.localeCompare(b.name, "zh"),
	);
	catalogGroups = groups;
}

/** 某行的指纹状态：已存配置（scan-fp-refs.js）+ 本次新提取（localStorage） */
function fpStatusFor(row) {
	const parts = [];
	(LOADED_FP_REFS[row.key] || [])
		.filter((e) => e.name === row.name)
		.forEach((e) =>
			parts.push(e.quality == null ? "通用" : `${QUALITY_NAMES[e.quality]}阶`),
		);
	const fresh = state.entries.filter(
		(e) => e.key === row.key && e.name === row.name,
	).length;
	if (fresh) parts.push(`${fresh} 条待保存`);
	return parts.join("、");
}

/** 形状矩阵迷你图示：网格小块风格同 index.html shape2Html，红法宝红色 / 普通绿色 */
function matMiniHtml(mat, red) {
	const wrap = document.createElement("span");
	wrap.className = "shape-mini";
	const cols = Math.max(...mat.map((r) => r.length));
	wrap.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	mat.forEach((rowArr) => {
		for (let c = 0; c < cols; c++) {
			const i = document.createElement("i");
			if (rowArr[c]) i.className = red ? "on-r" : "on-n";
			wrap.appendChild(i);
		}
	});
	return wrap;
}

/** 按形状键查 SHAPES_CACHE 后渲染迷你图示；键未知时返回空 span */
function shapeMiniHtml(shapeKey, red) {
	const mat = SHAPES_CACHE[shapeKey];
	if (!mat) return document.createElement("span");
	const wrap = matMiniHtml(mat, red);
	wrap.title = shapeKey;
	return wrap;
}

function renderTable() {
	els.blockTbody.replaceChildren();
	const ambCount = tableRows.filter((r) => r.groupSize > 1).length;
	els.tableStats.textContent = `共 ${tableRows.length} 件，歧义 ${ambCount} 件`;
	let prevAmbKey = null;
	let grpAlt = false;
	tableRows.forEach((row) => {
		const amb = row.groupSize > 1;
		if (!state.showAll && !amb) return;
		if (amb && row.key !== prevAmbKey) {
			grpAlt = !grpAlt;
			prevAmbKey = row.key;
		}
		const tr = document.createElement("tr");
		if (amb && grpAlt) tr.className = "grp-alt";
		[row.name, row.type].forEach((txt) => {
			const td = document.createElement("td");
			td.textContent = txt;
			tr.appendChild(td);
		});
		// 形状列：迷你图示 + 名称
		const tdShape = document.createElement("td");
		tdShape.appendChild(shapeMiniHtml(row.shapeKey, row.red));
		const shapeTxt = document.createElement("span");
		shapeTxt.textContent = row.shapeKey || "未知形状";
		tdShape.appendChild(shapeTxt);
		tr.appendChild(tdShape);
		const tdCat = document.createElement("td");
		tdCat.textContent = row.red ? "红法宝" : "普通";
		tr.appendChild(tdCat);
		// 歧义列
		const tdAmb = document.createElement("td");
		if (amb) {
			const tag = document.createElement("span");
			tag.className = "tag tag-amb";
			tag.textContent = `${row.groupSize} 件撞形状`;
			tdAmb.appendChild(tag);
		}
		tr.appendChild(tdAmb);
		// 指纹状态列
		const tdFp = document.createElement("td");
		const fp = fpStatusFor(row);
		if (fp) {
			const tag = document.createElement("span");
			tag.className = "tag tag-ok";
			tag.textContent = fp;
			tdFp.appendChild(tag);
		} else {
			tdFp.textContent = amb ? "未校准" : "—";
			if (amb) tdFp.style.color = "var(--color-red)";
		}
		tr.appendChild(tdFp);
		// 操作列
		const tdOp = document.createElement("td");
		const btn = document.createElement("button");
		btn.textContent = "提取指纹";
		btn.addEventListener("click", () => openModal(row));
		tdOp.appendChild(btn);
		tr.appendChild(tdOp);
		els.blockTbody.appendChild(tr);
	});
	renderGroupView();
}

els.filterToggle.addEventListener("click", () => {
	state.showAll = !state.showAll;
	els.filterToggle.textContent = state.showAll ? "只看歧义" : "显示全部";
	els.filterToggle.classList.toggle("active", !state.showAll);
	renderTable();
});

/* 冲突组视图（名录 tab 改造） */
/**
 * 行 = `类型|形状|red|normal` 冲突组（撞形状歧义组）：成员、库内样本数
 * （truth 索引）、指纹状态（复用 fpStatusFor）与最近回放 margin 健康度；
 * 「进入提取」下钻组级提取页。非冲突组不需要指纹，不进该视图。
 */
let gxOpen = false; // 组级提取页（下钻视图）是否打开
// 回放 margin 健康度：appendReplayRow 按识别名记录最差间隔 / 判定
const replayFpStats = new Map(); // name -> { verdict, margin }

/** 冲突组 key -> 名称数组（catalogGroups 中 size>1 的组） */
function fpGroupKeys() {
	return [...catalogGroups.entries()].filter(([, names]) => names.length > 1);
}

/** truth 来源合并：组级提取页上传的 + 原始图库已扫描的（去重按 truth.file） */
function fpTruthList() {
	const list = [];
	const seen = new Set();
	gx.truths.forEach((t, k) => {
		list.push(t);
		seen.add(k);
	});
	gal.records.forEach((rec) => {
		const k = rec.truth && (rec.truth.file || rec.name);
		if (rec.truth && !seen.has(k)) {
			list.push(rec.truth);
			seen.add(k);
		}
	});
	return list;
}

/** 「名称 → 库内样本（图+格子）」索引：扫描全部 truth 的 pieces 建表（纯函数，harness 可测） */
function fpTruthIndex(truths) {
	const idx = new Map(); // name -> [{ file, piece, rows, cols }]
	truths.forEach((t) => {
		(t.pieces || []).forEach((p) => {
			if (!p.name) return;
			if (!idx.has(p.name)) idx.set(p.name, []);
			idx.get(p.name).push({
				file: t.file || "",
				piece: p,
				rows: t.rows,
				cols: t.cols,
			});
		});
	});
	return idx;
}

function renderGroupView() {
	const groups = fpGroupKeys();
	const idx = fpTruthIndex(fpTruthList());
	const total = groups.reduce((n, [, names]) => n + names.length, 0);
	els.grpStats.textContent =
		`共 ${groups.length} 组 ${total} 件` +
		(idx.size ? "" : "（truth 未载入，样本数显示 —）");
	els.grpTbody.replaceChildren();
	groups.forEach(([key, names], gi) => {
		const [type, shapeKey, cat] = key.split("|");
		const tr = document.createElement("tr");
		if (gi % 2) tr.className = "grp-alt";
		// 组列：形状迷你图示 + key
		const tdKey = document.createElement("td");
		tdKey.appendChild(
			shapeMiniHtml(shapeKey === "未知形状" ? null : shapeKey, cat === "red"),
		);
		const keyTxt = document.createElement("span");
		keyTxt.textContent = key;
		tdKey.appendChild(keyTxt);
		tr.appendChild(tdKey);
		// 成员列：名称（库内样本数），0 样本标红
		const tdNames = document.createElement("td");
		names.forEach((name, ni) => {
			if (ni) tdNames.appendChild(document.createTextNode("、"));
			const span = document.createElement("span");
			const cnt = idx.has(name) ? idx.get(name).length : "—";
			span.textContent = `${name}(${cnt})`;
			if (cnt === 0) span.style.color = "var(--color-red)";
			tdNames.appendChild(span);
		});
		tr.appendChild(tdNames);
		// 指纹状态列：逐成员复用 fpStatusFor
		const tdFp = document.createElement("td");
		names.forEach((name, ni) => {
			if (ni) tdFp.appendChild(document.createTextNode("；"));
			const fp = fpStatusFor({ key, name });
			const span = document.createElement("span");
			span.textContent = `${name}:${fp || "未校准"}`;
			if (!fp) span.style.color = "var(--color-red)";
			tdFp.appendChild(span);
		});
		tr.appendChild(tdFp);
		// 回放 margin 列：最近一次回放的最差判定
		const tdMargin = document.createElement("td");
		names.forEach((name, ni) => {
			if (ni) tdMargin.appendChild(document.createTextNode("；"));
			const st = replayFpStats.get(name);
			const span = document.createElement("span");
			if (!st) {
				span.textContent = `${name}:—`;
				span.className = "tag tag-muted";
			} else {
				span.textContent =
					`${name}:${st.verdict}` +
					(st.margin != null ? ` ${st.margin.toFixed(1)}` : "");
				span.className =
					"tag " +
					(st.verdict === "可靠"
						? "tag-ok"
						: st.verdict === "勉强"
							? "tag-warn"
							: "tag-amb");
			}
			tdMargin.appendChild(span);
		});
		tr.appendChild(tdMargin);
		// 操作列：进入组级提取页
		const tdOp = document.createElement("td");
		const btn = document.createElement("button");
		btn.className = "btn-primary";
		btn.textContent = "进入提取";
		btn.addEventListener("click", () => openGroupExtract(key));
		tdOp.appendChild(btn);
		tr.appendChild(tdOp);
		els.grpTbody.appendChild(tr);
	});
}

/* 组级提取：纯逻辑（Node harness 直接测） */
/** 中位数（偶数取中间两值均值） */
function fpMedian(nums) {
	if (!nums.length) return 0;
	const s = [...nums].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 多条等长签名的逐块聚合：三通道各自取中位数；
 * 类内离散度 = 各样本到块中位数的通道绝对差均值（MAD，三通道平均），
 * <2 个有效样本记 null（单样本法宝算不出方差，报告标注谨慎）。
 */
function fpAggSigs(sigList) {
	const len = sigList.length ? sigList[0].length : 0;
	const sig = [];
	const sigVar = [];
	for (let i = 0; i < len; i++) {
		const vals = sigList.map((s) => s[i]).filter(Boolean);
		if (!vals.length) {
			sig.push(null);
			sigVar.push(null);
			continue;
		}
		const med = [0, 1, 2].map((ch) => fpMedian(vals.map((v) => v[ch])));
		sig.push(med.map((v) => Math.round(v)));
		if (vals.length < 2) {
			sigVar.push(null);
			continue;
		}
		let acc = 0;
		vals.forEach((v) => {
			acc +=
				(Math.abs(v[0] - med[0]) +
					Math.abs(v[1] - med[1]) +
					Math.abs(v[2] - med[2])) /
				3;
		});
		sigVar.push(Math.round((acc / vals.length) * 10) / 10);
	}
	return { sig, sigVar };
}

/** 确定性 ±amp 抖动（LCG 伪随机）：单样本法宝的可选增强，方差为合成值 */
function fpJitterSig(sig, amp, seed) {
	let s = seed >>> 0 || 1;
	const rnd = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
	return sig.map((p) =>
		p
			? p.map((ch) =>
					Math.min(255, Math.max(0, Math.round(ch + (rnd() * 2 - 1) * amp))),
				)
			: null,
	);
}

/** 逐块均值绝对差（scanFpDiff 的逐块版；任一侧 null 记 null） */
function fpBlockDiffs(a, b) {
	return a.map((p, i) => {
		const q = b[i];
		if (!p || !q) return null;
		return (
			(Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])) /
			3
		);
	});
}

/** 组内两两 diff（sig 口径）；templates: [{ label, sig }] */
function fpPairDiffs(templates) {
	const pairs = [];
	for (let i = 0; i < templates.length; i++) {
		for (let j = i + 1; j < templates.length; j++) {
			pairs.push({
				a: templates[i].label,
				b: templates[j].label,
				diff: scanFpDiff(templates[i].sig, templates[j].sig),
			});
		}
	}
	return pairs;
}

/**
 * 组内跨名（类间）两两 diff：同名跨品质对属类内差异，不参与 maxDiff 阈值
 * 推导（否则同名色移会把阈值压到类内 diff 的一半，真样本反而超阈值判空，
 * refingerprint.js 的 CLI 口径历来如此，本页此前误用全量 pairs）。
 */
function fpCrossPairs(templates) {
	const pairs = [];
	for (let i = 0; i < templates.length; i++) {
		for (let j = i + 1; j < templates.length; j++) {
			if (templates[i].name === templates[j].name) continue;
			pairs.push({
				a: templates[i].label,
				b: templates[j].label,
				diff: scanFpDiff(templates[i].sig, templates[j].sig),
			});
		}
	}
	return pairs;
}

/** 判别块热值：逐块取两两逐块差的最大值（类间差异大的块） */
function fpDiscBlocks(templates) {
	const len = templates.length ? templates[0].sig.length : 0;
	const heat = new Array(len).fill(null);
	for (let i = 0; i < templates.length; i++) {
		for (let j = i + 1; j < templates.length; j++) {
			fpBlockDiffs(templates[i].sig, templates[j].sig).forEach((d, k) => {
				if (d == null) return;
				if (heat[k] == null || d > heat[k]) heat[k] = d;
			});
		}
	}
	return heat;
}

/** 建议 maxDiff：组内最小类间 diff 的一半（下限 5，替代写死的 25；无可比项退回 25） */
function fpSuggestMaxDiff(pairs) {
	const finite = pairs.map((p) => p.diff).filter(Number.isFinite);
	if (!finite.length) return 25;
	return Math.max(5, Math.round(Math.min(...finite) / 2));
}

/** 样本按 名称+品质 分组（纯函数）；samples: [{ name, quality, sig, sigLegacy, thumb }] */
function fpGroupSamples(samples) {
	const map = new Map();
	samples.forEach((s) => {
		const k = `${s.name}|${s.quality}`;
		if (!map.has(k))
			map.set(k, { name: s.name, quality: s.quality, samples: [] });
		map.get(k).samples.push(s);
	});
	return [...map.values()];
}

/**
 * 按组聚合出模板：sig/sigLegacy 逐块中位数 + sigVar 类内离散度；
 * 单样本且 jitter 开启时 ±2px 抖动复制一份再聚合（方差为合成值，报告标注谨慎）。
 */
function fpAggregateGroups(groups, jitter) {
	return groups.map((g) => {
		let sigList = g.samples.map((s) => s.sig);
		let legacyList = g.samples.map((s) => s.sigLegacy);
		let augmented = false;
		if (g.samples.length === 1 && jitter) {
			sigList = [sigList[0], fpJitterSig(sigList[0], 2, 20260805)];
			legacyList = [legacyList[0], fpJitterSig(legacyList[0], 2, 20260805)];
			augmented = true;
		}
		const { sig, sigVar } = fpAggSigs(sigList);
		const { sig: sigLegacy } = fpAggSigs(legacyList);
		return {
			name: g.name,
			quality: g.quality,
			label:
				g.quality == null
					? `${g.name}（通用）`
					: `${g.name}（${QUALITY_NAMES[g.quality]}阶）`,
			sig,
			sigLegacy,
			sigVar,
			samples: g.samples.length,
			augmented,
			thumb: g.samples.length ? g.samples[0].thumb : null,
		};
	});
}

/**
 * 同名跨品质合并建议：平均 diff < 15 才考虑合成通用模板（人工确认）。
 * 提供 samples（原始样本 [{ name, sig }]）时做合并仿真校验：按入库口径
 * （各品质模板逐块中位数，与 gxCommit 一致）先合成通用模板，重算合并后的
 * 组级 maxDiff（跨名两两 diff 一半），再逐样本检查 dOwn（样本到通用模板）
 * ≤ 合并后 maxDiff 且 dOther（到他名最近模板）> dOwn；任一样本不满足即
 * 不建议合并——平均 diff 会掩盖色移大的边缘样本（木灵短剑 avgDiff 11.9
 * 建议合并，实际合并后样本 diff 达 13+ 超阈值全判空，2026-08 踩坑）。
 * 校验明细挂在 maxDOwn/postMaxDiff/minMargin；无 samples 时三者 null，
 * 退化为仅 <15 规则（兼容旧调用）。
 */
function fpMergeSuggestions(templates, samples) {
	const byName = new Map();
	templates.forEach((t) => {
		if (!byName.has(t.name)) byName.set(t.name, []);
		byName.get(t.name).push(t);
	});
	const out = [];
	byName.forEach((list, name) => {
		if (list.length < 2) return;
		const ds = [];
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				ds.push(scanFpDiff(list[i].sig, list[j].sig));
			}
		}
		const finite = ds.filter(Number.isFinite);
		const avg = finite.length
			? finite.reduce((a, b) => a + b, 0) / finite.length
			: Infinity;
		let maxDOwn = null;
		let postMaxDiff = null;
		let effMaxDiff = null;
		let minMargin = null;
		let safe = null; // null=未仿真；true/false=仿真结论
		if (samples) {
			const [merged] = fpAggregateGroups(
				[{ name, quality: null, samples: list }],
				false,
			);
			const others = templates.filter((t) => t.name !== name);
			postMaxDiff = fpSuggestMaxDiff(fpCrossPairs([...others, merged]));
			// 入库写的是合并前建议值（gxMaxDiff 默认），取两者较小者校验才稳妥
			const preMaxDiff = fpSuggestMaxDiff(fpCrossPairs(templates));
			effMaxDiff = Math.min(preMaxDiff, postMaxDiff);
			const own = samples.filter((s) => s.name === name);
			if (own.length) {
				maxDOwn = -Infinity;
				minMargin = Infinity;
				own.forEach((s) => {
					const dOwn = scanFpDiff(s.sig, merged.sig);
					const dOther = Math.min(
						...others.map((t) => scanFpDiff(s.sig, t.sig)),
					);
					if (dOwn > maxDOwn) maxDOwn = dOwn;
					if (dOther - dOwn < minMargin) minMargin = dOther - dOwn;
				});
				safe = maxDOwn <= effMaxDiff && minMargin > 0;
			}
		}
		out.push({
			name,
			qualities: list.map((t) => t.quality),
			avgDiff: avg,
			maxDOwn,
			postMaxDiff,
			effMaxDiff,
			minMargin,
			suggest: avg < 15 && safe !== false,
		});
	});
	return out;
}

/**
 * 组级差分分析配方（双端共用唯一入口）：两两 diff + 建议 maxDiff（仅跨名对）
 * + 跨品质合并建议（含样本仿真校验）。工具页 gx 流程与 Node 端
 * refingerprint.js 都必须走这里，禁止各自拼装 fpPairDiffs/fpSuggestMaxDiff/
 * fpMergeSuggestions——2026-08 的教训：gx 把同名类内对喂给 maxDiff 推导、
 * 合并建议未传样本仿真，函数虽共享但调用配方漂移，线上数据被写坏。
 */
function fpAnalyzeGroup(templates, samples) {
	const crossPairs = fpCrossPairs(templates);
	return {
		pairs: fpPairDiffs(templates),
		crossPairs,
		maxDiff: fpSuggestMaxDiff(crossPairs),
		merges: fpMergeSuggestions(templates, samples),
	};
}

/* 组级提取页（下钻视图） */
/**
 * 四步流程：采样（批量定位切格出样本卡片）→ 剔除（自动预标记可疑项，
 * 人只做确认）→ 一键提取（按 名称+品质 逐块中位数聚合，顺带类内离散度
 * sigVar）→ 组级差分报告（两两 diff / 判别块热图 / 建议 maxDiff / 跨品质
 * 合并建议），确认后入 state.entries。
 * 存储格式：sig 聚合模板 + sigVar + sigLegacy（无 sig 旧条目的回退口径）；
 * 匹配端 scanNamePiece 2026-08-05 起用 sig，sigVar/samples 匹配端不消费。
 */
const gx = {
	key: null,
	names: [],
	shapeKey: null,
	red: false,
	truths: new Map(), // 截图文件名 -> truth 对象
	imgs: [], // 已选测试截图 File[]
	samples: [], // 样本卡片 [{ id, name, quality, file, cells, sig, sigLegacy, thumb(canvas), flags, excluded }]
	skipped: [], // 定位失败 / 无配对 truth 的图（兜底：跳过或手动补图）
	templates: null, // 聚合结果（fpAggregateGroups 返回）
	pairs: null,
	merges: [],
	mergeChecks: new Map(), // 跨品质合并人工确认：name -> 是否合并
	manualFile: "", // 手动补图的来源文件名
};
let gxSampleSeq = 0;

function gxStatus(text, cls) {
	els.gxSampleStatus.textContent = text;
	els.gxSampleStatus.className = `status${cls ? ` ${cls}` : ""}`;
}

/** 打开组级提取页：下钻视图（非独立 tab），隐藏全部 tab-page 后显示本页 */
function openGroupExtract(key) {
	const names = catalogGroups.get(key) || [];
	const [, shapeKey, cat] = key.split("|");
	gx.key = key;
	gx.names = names;
	gx.shapeKey = shapeKey;
	gx.red = cat === "red";
	gx.samples = [];
	gx.skipped = [];
	gx.templates = null;
	gx.mergeChecks = new Map();
	els.gxTitle.textContent = `组级提取：${key}`;
	els.gxShapeSlot.replaceChildren(
		shapeMiniHtml(shapeKey === "未知形状" ? null : shapeKey, gx.red),
	);
	els.gxMembers.textContent = `成员：${names.join("、")}`;
	els.gxManualName.replaceChildren(
		...names.map((n) => {
			const opt = document.createElement("option");
			opt.value = n;
			opt.textContent = n;
			return opt;
		}),
	);
	els.gxManualQuality.value = gx.red ? "4" : "3";
	els.gxManualQuality.disabled = gx.red; // 红法宝组固定五阶
	renderGxSamples();
	gxRefreshSampleBtn();
	gxOpen = true;
	document.querySelectorAll(".tab-page").forEach((p) => (p.hidden = true));
	document.getElementById("tab-gxpage").hidden = false;
	document
		.querySelectorAll(".tab-bar button")
		.forEach((b) => b.classList.remove("active"));
	window.scrollTo(0, 0);
}

els.gxBack.addEventListener("click", () => {
	gxOpen = false;
	document.querySelector('.tab-bar button[data-tab="catalog"]').click();
});

function gxRefreshSampleBtn() {
	els.gxSample.disabled = !(gx.truths.size && gx.imgs.length);
}

// truth JSON（多选）：按 truth.file / 文件名（去 .json）与截图配对（同回放验证口径）
els.gxTruth.addEventListener("change", () => {
	const files = [...els.gxTruth.files];
	els.gxTruth.value = "";
	if (!files.length) return;
	let failed = 0;
	files.forEach((f) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const truth = JSON.parse(reader.result);
				gx.truths.set(truth.file || f.name.replace(/\.json$/i, ""), truth);
			} catch {
				failed++;
			}
			gxStatus(
				`已载入 truth ${gx.truths.size} 份、截图 ${gx.imgs.length} 张` +
					(failed ? `，${failed} 份 truth 解析失败` : "") +
					"；点「批量采样」",
				failed ? "err" : "",
			);
			gxRefreshSampleBtn();
			renderGroupView(); // 样本数索引更新
		};
		reader.readAsText(f);
	});
});

els.gxImg.addEventListener("change", () => {
	const files = [...els.gxImg.files].filter((f) => f.type.startsWith("image/"));
	els.gxImg.value = "";
	if (!files.length) return;
	gx.imgs.push(...files);
	gxStatus(
		`已载入 truth ${gx.truths.size} 份、截图 ${gx.imgs.length} 张；点「批量采样」`,
	);
	gxRefreshSampleBtn();
});

/** ① 采样：逐图定位 + 切格，组内法宝占用格裁成样本卡片 */
async function gxRunBatch() {
	if (!gx.key) return;
	const pool = await fpPoolEnsure(() =>
		gxStatus("并行 worker 启动失败，回退串行采样"),
	);
	if (pool) return gxRunBatchParallel();
	let cv;
	try {
		cv = await loadOpenCV();
	} catch {
		gxStatus("OpenCV 加载失败，无法自动定位棋盘", "err");
		return;
	}
	gx.skipped = [];
	let done = 0;
	let added = 0;
	for (const f of gx.imgs) {
		gxStatus(`采样中… ${done}/${gx.imgs.length}（${f.name}）`);
		const truth = gx.truths.get(f.name) || null;
		if (!truth) {
			gx.skipped.push(`${f.name}：无配对 truth，跳过`);
			done++;
			continue;
		}
		const { rows, cols } = truth;
		const img = await createImageBitmap(f);
		// 检测图：1:1 取像素后走共享双线性重采样（与回放验证 / node bench 逐字节一致）
		const { imgData, scale } = scanMakeDetectImage(img, DETECT_WIDTH);
		const rect = scanDetectBoard(cv, imgData, cols, rows);
		if (!rect) {
			gx.skipped.push(
				`${f.name}：棋盘定位失败（跳过；也可在下方手动补图兜底）`,
			);
			done++;
			continue;
		}
		const full = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};
		const { cells } = scanSliceCells(img, full, rows, cols);
		(truth.pieces || []).forEach((p) => {
			if (!p.name || !gx.names.includes(p.name)) return;
			const sorted = [...p.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
			gxAddSample({
				name: p.name,
				quality: p.quality - 1, // truth 1-5 -> 内部 0-4
				file: f.name,
				cells: sorted,
				anchor: p.anchor,
				cellCanvases: cells,
				truthType: p.type,
			});
			added++;
		});
		done++;
	}
	renderGxSamples();
	gxStatus(
		`采样完成：新增 ${added} 张样本卡片` +
			(gx.skipped.length ? `；${gx.skipped.length} 张图被跳过` : "") +
			`，请逐卡片确认剔除`,
		added ? "ok" : "err",
	);
}

els.gxSample.addEventListener("click", gxRunBatch);

/**
 * 组级提取批量采样并行路径：定位 / 切格 / 逐格 sig / 自动预标记在 worker
 * （fp-worker.js op=gxSample，与 gxAddSample 同口径），主线程保序重建缩略图
 * 并入样本卡片（跳过名单口径同串行逐图循环）。
 */
async function gxRunBatchParallel() {
	gx.skipped = [];
	let added = 0;
	const dotTypes = computeDotRanges(); // 预标记的锚点格识别口径（同 gxAddSample）
	const items = gx.imgs.map((f) => ({ f, truth: gx.truths.get(f.name) || null }));
	const todo = items.filter((it) => it.truth);
	const instant = items.length - todo.length; // 无配对 truth 的图即时计入进度
	const results = await FPPool.map(
		"gxSample",
		todo.map((it) => ({
			file: it.f,
			truth: it.truth,
			names: gx.names,
			dotTypes,
		})),
		(done) =>
			gxStatus(
				`采样中… ${done + instant}/${gx.imgs.length}（并行 ${FPPool.getSize()} 线程）`,
			),
	);
	// 保序入卡（顺序同串行逐图循环；按条目对象配对，同名文件不串）
	const resOf = new Map(todo.map((it, i) => [it, results[i]]));
	items.forEach((it) => {
		if (!it.truth) {
			gx.skipped.push(`${it.f.name}：无配对 truth，跳过`);
			return;
		}
		const res = resOf.get(it);
		if (!res.ok) {
			gx.skipped.push(`${it.f.name}：异常（${res.error}）`);
			return;
		}
		if (!res.result.detectOk) {
			gx.skipped.push(
				`${it.f.name}：棋盘定位失败（跳过；也可在下方手动补图兜底）`,
			);
			return;
		}
		res.result.pieces.forEach((sp) => {
			gxAddSampleData({
				name: sp.name,
				quality: sp.quality,
				file: it.f.name,
				cells: sp.cells,
				sig: sp.sig,
				sigLegacy: sp.sigLegacy,
				flags: sp.flags,
				thumb: fpMosaicThumb(sp.cells, sp.cellPix),
			});
			added++;
		});
	});
	renderGxSamples();
	gxStatus(
		`采样完成：新增 ${added} 张样本卡片` +
			(gx.skipped.length ? `；${gx.skipped.length} 张图被跳过` : "") +
			`，请逐卡片确认剔除`,
		added ? "ok" : "err",
	);
}

/**
 * 样本卡片构建：逐格签名（行优先，与 extractFingerprint 同口径）+ 缩略图 +
 * 自动预标记可疑项（默认排除，人只做确认）：
 * ① 有效图标块过少（图标与底色过于接近，签名不可靠）；
 * ② 锚点格 scanCellFeat 识别类型与标注不符（或未识别出元素圆点）。
 */
function gxAddSample({
	name,
	quality,
	file,
	cells,
	anchor,
	cellCanvases,
	truthType,
}) {
	const sig = [];
	const sigLegacy = [];
	cells.forEach(([r, c]) => {
		const data = cellCanvases[r][c]
			.getContext("2d")
			.getImageData(0, 0, N, N).data;
		sig.push(...cellSig(data, cellBg(data)));
		sigLegacy.push(...cellSigLegacy(data));
	});
	// 缩略图：按包围盒拼接占用格（同 annPieceThumb 口径）
	const mat = scanCellsToMat(cells);
	const minR = Math.min(...cells.map((p) => p[0]));
	const minC = Math.min(...cells.map((p) => p[1]));
	const thumb = document.createElement("canvas");
	thumb.width = mat[0].length * N;
	thumb.height = mat.length * N;
	const tctx = thumb.getContext("2d");
	cells.forEach(([r, c]) => {
		tctx.drawImage(cellCanvases[r][c], (c - minC) * N, (r - minR) * N);
	});
	// 自动预标记
	const flags = [];
	const iconBlocks = sig.filter(Boolean).length;
	if (iconBlocks < cells.length * 4)
		flags.push(`有效图标块少（${iconBlocks}/${sig.length}）`);
	if (anchor && truthType) {
		const data = cellCanvases[anchor[0]][anchor[1]]
			.getContext("2d")
			.getImageData(0, 0, N, N).data;
		const feat = scanCellFeat(data, computeDotRanges());
		if (!feat.dotType) flags.push("锚点格未识别出元素圆点");
		else if (feat.dotType !== truthType)
			flags.push(`类型识别不符：识别 ${feat.dotType} / 标注 ${truthType}`);
	}
	gx.samples.push({
		id: ++gxSampleSeq,
		name,
		quality,
		file,
		cells,
		sig,
		sigLegacy,
		thumb,
		flags,
		excluded: flags.length > 0,
	});
}

/**
 * 并行采样的样本卡片入口：sig / sigLegacy / 自动预标记已在 worker 算好
 * （与 gxAddSample 同口径），缩略图由 fpMosaicThumb 在主线程重建后传入。
 */
function gxAddSampleData({
	name,
	quality,
	file,
	cells,
	sig,
	sigLegacy,
	flags,
	thumb,
}) {
	gx.samples.push({
		id: ++gxSampleSeq,
		name,
		quality,
		file,
		cells,
		sig,
		sigLegacy,
		thumb,
		flags,
		excluded: flags.length > 0,
	});
}

/** ② 剔除：样本卡片按 名称(+品质) 分组陈列，点击卡片切换排除 / 保留 */
function renderGxSamples() {
	els.gxCards.replaceChildren();
	const groups = fpGroupSamples(gx.samples);
	groups.sort(
		(a, b) =>
			gx.names.indexOf(a.name) - gx.names.indexOf(b.name) ||
			a.quality - b.quality,
	);
	groups.forEach((g) => {
		const head = document.createElement("div");
		head.className = "gx-grp-head";
		head.textContent = `${g.name}（${QUALITY_NAMES[g.quality]}阶） ${g.samples.length} 样本`;
		els.gxCards.appendChild(head);
		g.samples.forEach((s) => els.gxCards.appendChild(gxSampleCard(s)));
	});
	// 0 样本成员提示（手动补图入口）
	gx.names
		.filter((n) => !groups.some((g) => g.name === n))
		.forEach((n) => {
			const head = document.createElement("div");
			head.className = "gx-grp-head";
			head.textContent = `${n}：0 样本（用下方「手动补图」补样本）`;
			head.style.color = "var(--color-red)";
			els.gxCards.appendChild(head);
		});
	const excl = gx.samples.filter((s) => s.excluded).length;
	els.gxCullStatus.textContent = gx.samples.length
		? `共 ${gx.samples.length} 张卡片，已排除 ${excl} 张（预标记可疑项默认排除，点击卡片切换保留 / 排除）`
		: "";
	els.gxSkipped.textContent = gx.skipped.join("；");
	els.gxSkipped.className = gx.skipped.length ? "status err" : "status";
	els.gxAgg.disabled = !gx.samples.some((s) => !s.excluded);
	// 样本集变化后旧报告作废
	gx.templates = null;
	renderGxReport();
}

function gxSampleCard(s) {
	const div = document.createElement("div");
	div.className = "gx-card" + (s.excluded ? " excluded" : "");
	const cv = document.createElement("canvas");
	cv.width = s.thumb.width;
	cv.height = s.thumb.height;
	cv.getContext("2d").drawImage(s.thumb, 0, 0);
	div.appendChild(cv);
	const src = document.createElement("div");
	src.className = "gx-src";
	src.textContent = `${s.file} · ${QUALITY_NAMES[s.quality]}阶`;
	div.appendChild(src);
	const stateLine = document.createElement("div");
	stateLine.textContent = s.excluded
		? "已排除（点击保留）"
		: "保留（点击排除）";
	div.appendChild(stateLine);
	s.flags.forEach((f) => {
		const tag = document.createElement("div");
		tag.className = "tag tag-warn";
		tag.textContent = f;
		div.appendChild(tag);
	});
	div.addEventListener("click", () => {
		s.excluded = !s.excluded;
		renderGxSamples();
	});
	return div;
}

/* 手动补图（0 样本法宝 / 定位失败兜底）：点选占用格加入同款样本卡片 */
const gws = createBoardWorkspace(
	{
		file: document.getElementById("gxwFile"),
		rows: document.getElementById("gxwRows"),
		cols: document.getElementById("gxwCols"),
		auto: document.getElementById("gxwAuto"),
		edit: document.getElementById("gxwEdit"),
		slice: document.getElementById("gxwSlice"),
		loadStatus: document.getElementById("gxwStatus"),
		wrap: document.getElementById("gxwWrap"),
		canvas: document.getElementById("gxwCanvas"),
		cellGrid: document.getElementById("gxwCellGrid"),
		cellWarn: document.getElementById("gxwCellWarn"),
	},
	{
		isActive: () => gxOpen,
		onLoad: (fileName) => {
			gx.manualFile = fileName || "手动上传";
		},
		onCellClick: (r, c, wrap) => {
			const k = `${r},${c}`;
			if (gws.selected.has(k)) gws.selected.delete(k);
			else gws.selected.add(k);
			wrap.classList.toggle("selected");
			els.gxManualAdd.disabled = !gws.selected.size;
		},
		onSliced: (rows, cols) =>
			gws.setStatus(
				`切格完成：${rows}×${cols}，点选「${els.gxManualName.value}」占用的格子后「加入样本」`,
				"ok",
			),
	},
);

els.gxManualAdd.addEventListener("click", () => {
	const sel = gws.selectionMatrix();
	if (!sel) return;
	const name = els.gxManualName.value;
	const quality = Number(els.gxManualQuality.value);
	const shapeKey = SHAPES_CACHE[JSON.stringify(sel.mat)] || null;
	if (
		gx.shapeKey !== "未知形状" &&
		shapeKey !== gx.shapeKey &&
		!confirm(
			`选中形状（${shapeKey || "未知形状"}）与组形状 ${gx.shapeKey} 不符，仍要加入吗？`,
		)
	)
		return;
	gxAddSample({
		name,
		quality,
		file: gx.manualFile || "手动上传",
		cells: sel.cells,
		anchor: null, // 手动点选无锚点信息：跳过类型不符预标记
		cellCanvases: gws.cells,
		truthType: null,
	});
	gws.selected.clear();
	gws.renderCellGrid();
	els.gxManualAdd.disabled = true;
	renderGxSamples();
	gws.setStatus(`已加入「${name}」样本卡片，见上方样本区`, "ok");
});

/* ③ 一键提取 + ④ 组级差分报告 */
els.gxAgg.addEventListener("click", () => {
	const rest = gx.samples.filter((s) => !s.excluded);
	if (!rest.length) return;
	gx.templates = fpAggregateGroups(fpGroupSamples(rest), els.gxJitter.checked);
	// 差分分析走双端共用配方（fpAnalyzeGroup），勿就地拼装
	const ana = fpAnalyzeGroup(gx.templates, rest);
	gx.pairs = ana.pairs;
	gx.merges = ana.merges;
	gx.mergeChecks = new Map(gx.merges.map((m) => [m.name, m.suggest]));
	els.gxMaxDiff.value = ana.maxDiff;
	renderGxReport();
	els.gxAggStatus.textContent = `已聚合 ${gx.templates.length} 个模板（按 名称+品质），请核对下方报告`;
	els.gxAggStatus.className = "status ok";
});

function renderGxReport() {
	els.gxReport.replaceChildren();
	els.gxCommitBar.hidden = !gx.templates;
	if (!gx.templates) return;

	// 模板清单：样本数与类内离散度摘要（单样本 / 抖动增强标注谨慎）
	const head = document.createElement("div");
	head.className = "gx-grp-head";
	head.textContent = "组级差分报告（确认后入库）";
	els.gxReport.appendChild(head);
	gx.templates.forEach((t) => {
		const line = document.createElement("div");
		const vars = t.sigVar.filter((v) => v != null);
		const avgVar = vars.length
			? (vars.reduce((a, b) => a + b, 0) / vars.length).toFixed(1)
			: null;
		line.className = "status";
		line.textContent =
			`${t.label}：${t.samples} 样本` +
			(avgVar != null
				? `，平均类内离散度 ${avgVar}${t.augmented ? "（抖动增强合成值，谨慎）" : ""}`
				: "，单样本无类内方差（差分结论谨慎，可勾选抖动增强重跑）");
		els.gxReport.appendChild(line);
	});

	const pt = document.createElement("table");
	pt.className = "bt-metrics";
	const ph = document.createElement("tr");
	["模板 A", "模板 B", "sig diff"].forEach((h) => {
		const th = document.createElement("th");
		th.textContent = h;
		ph.appendChild(th);
	});
	pt.appendChild(ph);
	gx.pairs.forEach((p) => {
		const tr = document.createElement("tr");
		[p.a, p.b, Number.isFinite(p.diff) ? p.diff.toFixed(1) : "∞"].forEach(
			(txt, ci) => {
				const td = document.createElement("td");
				td.textContent = txt;
				if (ci === 2 && Number.isFinite(p.diff) && p.diff < 30)
					td.className = "bt-regress"; // 类间间隔不足 30 提示区分度风险
				tr.appendChild(td);
			},
		);
		pt.appendChild(tr);
	});
	const pHead = document.createElement("div");
	pHead.className = "gx-grp-head";
	pHead.textContent = "两两 diff（sig 口径）";
	els.gxReport.appendChild(pHead);
	els.gxReport.appendChild(pt);

	// 判别块热图：形状占用格 × 4×4 块，红色强度 = 组内两两逐块差最大值
	const heat = fpDiscBlocks(gx.templates);
	const mat = SHAPES_CACHE[gx.shapeKey] || null;
	if (mat && heat.length) {
		const hHead = document.createElement("div");
		hHead.className = "gx-grp-head";
		hHead.textContent =
			"判别块热图（越红 = 类间差异越大，匹配迁移后重点比较的块）";
		els.gxReport.appendChild(hHead);
		els.gxReport.appendChild(gxHeatCanvas(mat, heat));
	}

	// 同名跨品质合并建议（<15 规则 + 合并仿真校验，人工确认）
	gx.merges.forEach((m) => {
		const line = document.createElement("div");
		line.className = "status";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = gx.mergeChecks.get(m.name);
		cb.addEventListener("change", () => gx.mergeChecks.set(m.name, cb.checked));
		line.appendChild(cb);
		let verdict;
		if (m.suggest) {
			verdict = "图标基本一致，建议合并为通用模板（quality=null）";
		} else if (m.avgDiff < 15) {
			// 平均规则达标但仿真未通过：合并后会有样本超 maxDiff 判空
			verdict = "平均 diff <15 但合并仿真未通过，不建议合并";
			line.className = "status err";
		} else {
			verdict = "图标随品质变化，建议按品质分别保留";
		}
		const sim =
			m.maxDOwn != null
				? `（仿真：合并后样本最大 diff ${m.maxDOwn.toFixed(1)} vs 阈值 ${m.effMaxDiff}，最小余量 ${m.minMargin.toFixed(1)}）`
				: "";
		line.appendChild(
			document.createTextNode(
				` ${m.name} 跨品质平均 diff ${Number.isFinite(m.avgDiff) ? m.avgDiff.toFixed(1) : "∞"}：` +
					verdict +
					sim,
			),
		);
		els.gxReport.appendChild(line);
	});
}

/** 判别块热图画布：mat 占位格按 sig 布局（格行优先 × 16 块）着色 */
function gxHeatCanvas(mat, heat) {
	const BS = 7; // 块像素
	const GAP = 3;
	const cw = 4 * BS + GAP;
	const ch = 4 * BS + GAP;
	const cv = document.createElement("canvas");
	cv.className = "gx-heat";
	cv.width = mat[0].length * cw + GAP;
	cv.height = mat.length * ch + GAP;
	const ctx = cv.getContext("2d");
	let ci = 0; // 占用格序号（与 sig 布局一致：行优先）
	mat.forEach((row, r) => {
		row.forEach((v, c) => {
			const x0 = GAP + c * cw;
			const y0 = GAP + r * ch;
			if (!v) return;
			for (let bi = 0; bi < 4; bi++) {
				for (let bj = 0; bj < 4; bj++) {
					const h = heat[ci * 16 + bi * 4 + bj];
					ctx.fillStyle =
						h == null
							? "#eee"
							: `rgba(224, 60, 49, ${Math.min(1, h / 60).toFixed(2)})`;
					ctx.fillRect(x0 + bj * BS, y0 + bi * BS, BS - 1, BS - 1);
				}
			}
			ci++;
		});
	});
	return cv;
}

/** ④ 确认入库：合并输出到 state.entries（写回走底部输出 / 数据文件直写） */
els.gxCommit.addEventListener("click", () => {
	if (!gx.templates) return;
	const maxDiff = Number(els.gxMaxDiff.value) || 25;
	// 跨品质合并：勾选合并的名称把各品质模板再聚合成一条通用模板（quality=null）
	const finalT = [];
	const byName = new Map();
	gx.templates.forEach((t) => {
		if (!byName.has(t.name)) byName.set(t.name, []);
		byName.get(t.name).push(t);
	});
	byName.forEach((list, name) => {
		if (list.length > 1 && gx.mergeChecks.get(name)) {
			const [m] = fpAggregateGroups(
				[{ name, quality: null, samples: list }],
				false,
			);
			m.samples = list.reduce((n, t) => n + t.samples, 0);
			m.augmented = list.some((t) => t.augmented);
			m.thumb = list[0].thumb;
			finalT.push(m);
		} else {
			finalT.push(...list);
		}
	});
	const summary = finalT
		.map(
			(t) =>
				`${t.name}（${t.quality == null ? "通用" : `${QUALITY_NAMES[t.quality]}阶`}，${t.samples} 样本）`,
		)
		.join("\n- ");
	// 勾选了合并但未通过建议（仿真未通过 / 图标随品质变化）时醒目告警：
	// 强行合并可能让边缘样本超 maxDiff 判空（木灵短剑 2026-08 踩坑）
	const risky = gx.merges
		.filter((m) => gx.mergeChecks.get(m.name) && !m.suggest)
		.map((m) => m.name);
	const riskTxt = risky.length
		? `\n⚠ 以下合并未通过仿真校验，样本可能超 maxDiff 判空：${risky.join("、")}\n`
		: "";
	if (
		!confirm(
			`确认入库 ${finalT.length} 条指纹（组 maxDiff=${maxDiff}）：\n- ${summary}\n${riskTxt}\n` +
				`入库后请到底部输出保存 / 直写数据文件，写回前建议先跑「回放验证」。`,
		)
	)
		return;
	finalT.forEach((t) => {
		state.entries.push({
			key: gx.key,
			name: t.name,
			quality: t.quality,
			maxDiff,
			sig: t.sig,
			sigLegacy: t.sigLegacy,
			sigVar: t.sigVar, // 类内离散度（模板质量信息，匹配端不消费）
			samples: t.samples,
			thumb: t.thumb ? t.thumb.toDataURL() : "",
		});
	});
	saveEntries();
	renderEntries();
	els.gxCommitStatus.textContent = `已入库 ${finalT.length} 条（见下方「已提取条目」与输出）`;
	els.gxCommitStatus.className = "status ok";
});

/* 提取弹窗 */
function openModal(target) {
	state.target = target || null;
	setMode("extract");
	if (state.target) {
		els.modalTitle.textContent = `提取指纹：${state.target.name}`;
		els.modalTarget.textContent =
			`${state.target.type} | ${state.target.shapeKey || "未知形状"} | ` +
			(state.target.red ? "红法宝（五阶）" : "普通");
	} else {
		els.modalTitle.textContent = "手动提取指纹";
		els.modalTarget.textContent = "未指定法宝，名称 / 类型 / 品质手工选择";
	}
	applyTargetToForm();
	els.modal.hidden = false;
	if (!ws.img) ws.setStatus("尚未载入截图");
}

function closeModal() {
	els.modal.hidden = true;
	ws.stopEditing();
}

/** 目标行预填并锁定表单；自由提取时全部解锁 */
function applyTargetToForm() {
	const t = state.target;
	els.type.disabled = !!t;
	els.name.disabled = !!t;
	els.quality.disabled = !!(t && t.red);
	if (t) {
		els.type.value = t.type;
		els.name.value = t.name;
		if (t.red) els.quality.value = 4;
	}
	updateForm();
}

/** 弹窗工作模式：extract=点选多格提取指纹 / calibrate=点选单格采样元素圆点色 */
function setMode(mode) {
	state.mode = mode;
	els.modeExtract.classList.toggle("active", mode === "extract");
	els.modeCal.classList.toggle("active", mode === "calibrate");
	els.form.hidden = mode !== "extract";
	els.calPanel.hidden = mode !== "calibrate";
	ws.selected.clear();
	if (ws.cells) ws.renderCellGrid();
	if (mode === "calibrate") renderCalRanges();
	updateForm();
}

els.modalClose.addEventListener("click", closeModal);
els.modeExtract.addEventListener("click", () => setMode("extract"));
els.modeCal.addEventListener("click", () => setMode("calibrate"));
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !els.modal.hidden) closeModal();
});
els.clearSel.addEventListener("click", () => {
	ws.selected.clear();
	ws.renderCellGrid();
});

/* 元素色校准 */
/* 圆点几何与饱和度阈值见 scan-core.js SCAN_REC（规范位圆盘采样 scanDiskHues） */
const DOT_MARGIN = 5; // 由样本生成 hue 区间时的边界余量

/** hue 是否在 (lo, hi) 区间内；lo > hi 表示跨 180 回绕（同 index.html 判定逻辑） */
function hInRange(h, lo, hi) {
	return lo <= hi ? h > lo && h < hi : h > lo || h < hi;
}

/** 校准模式下点选格子：采样该格元素圆点 */
function calibrateCell(r, c) {
	const data = ws.cells[r][c].getContext("2d").getImageData(0, 0, N, N).data;
	const hues = sampleDiskHues(data); // 圆盘全像素有效票（同判定链/分桶口径，2026-08-07 Step 5）
	state.calSample = hues.length ? hues : null;
	els.calAdd.disabled = !state.calSample;
	if (!state.calSample) {
		els.calSampleInfo.textContent = "未采到有色圆点（饱和度不足），换一格试试";
		return;
	}
	const mn = Math.min(...hues);
	const mx = Math.max(...hues);
	const hit = computeDotRanges().find(([lo, hi]) =>
		hues.every((h) => hInRange(h, lo, hi)),
	);
	els.calSampleInfo.textContent =
		`有效 ${hues.length} 票（圆盘采样），hue ${mn}~${mx}` +
		(hit ? `，当前配置判为「${hit[2]}」` : "，当前配置无匹配类型");
}

/** 由样本 hues 生成 hue 区间（含余量）；样本跨 0/179 两端时产出 lo > hi 的回绕区间 */
function rangeFromHues(hues) {
	const mn = Math.min(...hues);
	const mx = Math.max(...hues);
	if (mx - mn <= 90) {
		return [Math.max(0, mn - DOT_MARGIN), Math.min(179, mx + DOT_MARGIN)];
	}
	const hiSide = hues.filter((h) => h > 90);
	const loSide = hues.filter((h) => h <= 90);
	return [Math.min(...hiSide) - DOT_MARGIN, Math.max(...loSide) + DOT_MARGIN];
}

/** 最终输出的色值配置：已加载配置为基础，元素校准 tab 采用的区间覆盖之，
 *  有手动校准样本的类型再用样本重算覆盖（弹窗校准的原有行为不变） */
function computeDotRanges() {
	const map = new Map(LOADED_DOT_TYPES.map(([lo, hi, t]) => [t, [lo, hi]]));
	Object.entries(state.adoptedRanges).forEach(([t, range]) => {
		map.set(t, [...range]);
	});
	Object.entries(state.dotSamples).forEach(([t, hues]) => {
		if (hues.length) map.set(t, rangeFromHues(hues));
	});
	return [...map.entries()].map(([t, [lo, hi]]) => [lo, hi, t]);
}

/** 渲染当前色值区间列表，标注样本来源与区间重叠冲突；校准 / 采用过的类型可重置。
 *  交叠判定走 scanDotRangesOverlap（开区间口径、火/雷策略 B 豁免，与入库硬校验一致） */
function renderCalRanges() {
	const ranges = computeDotRanges();
	const overlapPairs = scanDotRangesOverlap(ranges);
	const conflictTypes = new Set();
	overlapPairs.forEach((o) => {
		conflictTypes.add(o.a[2]);
		conflictTypes.add(o.b[2]);
	});
	els.calRanges.replaceChildren();
	ranges.forEach(([lo, hi, t]) => {
		const conflict = conflictTypes.has(t);
		const div = document.createElement("div");
		div.className = "range-row" + (conflict ? " conflict" : "");
		const sampled = (state.dotSamples[t] || []).length;
		const adopted = state.adoptedRanges[t];
		div.textContent =
			`${t}：hue (${lo}, ${hi})${lo > hi ? "（回绕）" : ""} — ` +
			(sampled
				? `本次校准 ${sampled} 个样本点`
				: adopted
					? "元素校准 tab 采用的区间"
					: "已存配置") +
			(conflict ? "，与其他类型区间重叠！" : "");
		if (sampled || adopted) {
			const reset = document.createElement("button");
			reset.textContent = sampled ? "重置样本" : "重置采用";
			reset.addEventListener("click", () => {
				delete state.dotSamples[t];
				delete state.adoptedRanges[t];
				saveEntries();
				renderCalRanges();
				renderOutput();
				renderDcHist();
			});
			div.appendChild(reset);
		}
		els.calRanges.appendChild(div);
	});
}

els.calAdd.addEventListener("click", () => {
	if (!state.calSample) return;
	const t = els.calType.value;
	if (!state.dotSamples[t]) state.dotSamples[t] = [];
	state.dotSamples[t].push(...state.calSample);
	saveEntries();
	renderCalRanges();
	renderOutput();
	renderDcHist();
	els.calSampleInfo.textContent += `；已并入「${t}」样本`;
	els.calAdd.disabled = true;
});

/* 截图工作区（内部组件） */
/**
 * 截图工作区：截图载入（选择文件 / 拖拽 / 粘贴）、自动定位、手动拖框、
 * 调整边界、切格与格子板渲染。提取弹窗（ws）与真值标注（aws）两个调用点
 * 共享本实现；点选行为、格子附加样式与表单联动等差异通过 hooks 注入：
 *   hooks.isActive()              —— 全局拖拽 / 粘贴是否路由到本工作区
 *   hooks.onLoad(fileName)        —— 截图载入完成（自动定位之前调用）
 *   hooks.cellClass(r, c)         —— 格子附加 class（返回字符串，可空）
 *   hooks.cellData(r, c)          —— 格子附加 data-* 属性（返回对象，可空）
 *   hooks.onCellClick(r, c, wrap) —— 格子点击行为
 *   hooks.onGridRendered()        —— 格子板渲染完成（表单联动入口）
 *   hooks.onDimsChange()          —— 行列数变化
 *   hooks.onSliced(rows, cols)    —— 手动切格完成（缺省给通用状态提示）
 */
function createBoardWorkspace(els, hooks) {
	const ws = {
		els,
		img: null, // ImageBitmap 原图
		rect: null, // 棋盘区域（原图坐标）{ L, T, R, B }
		cells: null, // canvas[][] 归一化格
		selected: new Set(), // "r,c"
		editing: false, // 边界调整模式
	};

	/* 状态提示 */
	function setStatus(text, cls) {
		els.loadStatus.textContent = text;
		els.loadStatus.className = `status${cls ? ` ${cls}` : ""}`;
	}

	/* 截图载入 */
	async function loadImageBlob(blob, fileName) {
		if (!blob || !blob.type.startsWith("image/")) return;
		stopEditing();
		ws.img = await createImageBitmap(blob);
		ws.rect = null;
		ws.cells = null;
		ws.selected.clear();
		renderCellGrid();
		els.canvas.width = ws.img.width;
		els.canvas.height = ws.img.height;
		els.wrap.classList.remove("empty");
		redraw();
		els.auto.disabled = false;
		els.edit.disabled = true;
		els.slice.disabled = false;
		if (hooks.onLoad) hooks.onLoad(fileName || "");
		// 载入即自动定位一次；失败时 autoDetect 自行提示手动拖框
		autoDetect();
	}

	els.file.addEventListener("change", () => {
		const f = els.file.files[0];
		loadImageBlob(f, f && f.name);
		els.file.value = "";
	});

	window.addEventListener("dragover", (e) => e.preventDefault());
	window.addEventListener("drop", (e) => {
		e.preventDefault();
		if (hooks.isActive && !hooks.isActive()) return;
		const f = e.dataTransfer.files[0];
		loadImageBlob(f, f && f.name);
	});

	window.addEventListener("paste", (e) => {
		if (hooks.isActive && !hooks.isActive()) return;
		const item = [...(e.clipboardData?.items || [])].find((it) =>
			it.type.startsWith("image/"),
		);
		if (item) loadImageBlob(item.getAsFile(), "");
	});

	/* OpenCV 加载 */
	/* 由 ../script/opencv-loader.js 提供全局 loadOpenCV（与 index.html 共用），失败 reject 时降级为手动框选 */

	/** 自动定位：缩放到检测宽度后跑检测，成功则换算回原图坐标并自动切格 */
	async function autoDetect() {
		if (!ws.img) return;
		els.auto.disabled = true;
		setStatus("自动定位中…");
		let cv;
		try {
			cv = await loadOpenCV();
		} catch {
			els.auto.disabled = false;
			setStatus("自动定位组件加载失败，请在截图上拖出棋盘区域", "err");
			return;
		}
		// 检测图：1:1 取像素后走共享双线性重采样（与 node bench 逐字节一致）
		const { imgData, scale } = scanMakeDetectImage(ws.img, DETECT_WIDTH);
		const rect = detectBoard(
			cv,
			imgData,
			Number(els.cols.value) || 1,
			Number(els.rows.value) || 1,
		);
		els.auto.disabled = false;
		if (!rect) {
			setStatus("自动定位失败，请在截图上拖出棋盘区域", "err");
			return;
		}
		stopEditing();
		ws.rect = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};
		els.edit.disabled = false;
		redraw();
		doSlice();
		scrollBoardIntoView();
		setStatus("定位完成，已自动切格；不准可点「调整边界」微调", "ok");
	}

	/** 定位完成后把棋盘区域滚动到可视区中央（画布可能高于容器出现纵向滚动） */
	function scrollBoardIntoView() {
		if (!ws.rect || !ws.img) return;
		els.wrap.scrollIntoView({ block: "nearest" });
		const cw = els.canvas.getBoundingClientRect();
		const wr = els.wrap.getBoundingClientRect();
		const s = cw.width / els.canvas.width; // 显示 / 原图
		const cx = cw.left + ((ws.rect.L + ws.rect.R) / 2) * s;
		const cy = cw.top + ((ws.rect.T + ws.rect.B) / 2) * s;
		els.wrap.scrollLeft += cx - (wr.left + wr.width / 2);
		els.wrap.scrollTop += cy - (wr.top + wr.height / 2);
	}

	els.auto.addEventListener("click", autoDetect);

	/* 棋盘框选与边界调整 */
	/** 退出边界调整模式并复位相关状态 */
	function stopEditing() {
		ws.editing = false;
		adjDrag = null;
		els.edit.classList.remove("active");
		els.canvas.style.cursor = "crosshair";
	}

	els.edit.addEventListener("click", () => {
		if (!ws.img) return;
		if (ws.editing) {
			stopEditing();
			redraw();
			return;
		}
		if (!ws.rect) {
			setStatus("请先自动定位或手动框选棋盘，再调整边界", "err");
			return;
		}
		ws.editing = true;
		els.edit.classList.add("active");
		setStatus(
			"调整边界：拖动边缘 / 角点缩放，按住中间移动；再次点击按钮退出",
			"ok",
		);
		redraw();
	});

	/** 画布坐标 -> 原图坐标（画布按 CSS 缩放展示，内部分辨率即原图） */
	function canvasToImg(e) {
		const r = els.canvas.getBoundingClientRect();
		const k = els.canvas.width / r.width;
		return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
	}

	/** 边界调整：命中检测（显示像素坐标），返回拖拽区域（同 index.html scanHitZone） */
	const HIT_T = 12;
	const CURSORS = {
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

	function hitZone(e) {
		const r = ws.rect;
		if (!r) return null;
		const b = els.canvas.getBoundingClientRect();
		const s = b.width / els.canvas.width; // 显示 / 原图
		const x = e.clientX - b.left;
		const y = e.clientY - b.top;
		const L = r.L * s;
		const T = r.T * s;
		const R = r.R * s;
		const B = r.B * s;
		const t = HIT_T;
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
	}

	let dragStart = null; // 框选新区域：起点（原图坐标）
	let adjDrag = null; // 调整边界拖拽状态 { zone, x0, y0, rect0 }（原图坐标）

	els.canvas.addEventListener("pointerdown", (e) => {
		if (!ws.img) return;
		// 调整边界模式：命中边缘 / 角点缩放，中间整体移动
		if (ws.editing && ws.rect) {
			const zone = hitZone(e);
			if (!zone) return;
			const [x, y] = canvasToImg(e);
			adjDrag = { zone, x0: x, y0: y, rect0: { ...ws.rect } };
			els.canvas.setPointerCapture(e.pointerId);
			return;
		}
		dragStart = canvasToImg(e);
		els.canvas.setPointerCapture(e.pointerId);
	});

	els.canvas.addEventListener("pointermove", (e) => {
		if (adjDrag) {
			const [x, y] = canvasToImg(e);
			const dx = x - adjDrag.x0;
			const dy = y - adjDrag.y0;
			const r0 = adjDrag.rect0;
			const iw = ws.img.width;
			const ih = ws.img.height;
			const MIN = 20; // 最小棋盘边长（原图像素）
			let { L, T, R, B } = r0;
			if (adjDrag.zone === "move") {
				const rw = r0.R - r0.L;
				const rh = r0.B - r0.T;
				L = Math.min(Math.max(r0.L + dx, 0), iw - rw);
				T = Math.min(Math.max(r0.T + dy, 0), ih - rh);
				R = L + rw;
				B = T + rh;
			} else {
				if (adjDrag.zone.includes("w"))
					L = Math.min(Math.max(r0.L + dx, 0), R - MIN);
				if (adjDrag.zone.includes("e"))
					R = Math.max(Math.min(r0.R + dx, iw), L + MIN);
				if (adjDrag.zone.includes("n"))
					T = Math.min(Math.max(r0.T + dy, 0), B - MIN);
				if (adjDrag.zone.includes("s"))
					B = Math.max(Math.min(r0.B + dy, ih), T + MIN);
			}
			ws.rect = { L, T, R, B };
			redraw();
			return;
		}
		if (dragStart) {
			const [x, y] = canvasToImg(e);
			ws.rect = {
				L: Math.min(dragStart[0], x),
				T: Math.min(dragStart[1], y),
				R: Math.max(dragStart[0], x),
				B: Math.max(dragStart[1], y),
			};
			redraw();
			return;
		}
		// 调整模式悬停：按命中区域切换光标
		if (ws.editing && ws.rect) {
			const zone = hitZone(e);
			els.canvas.style.cursor = zone ? CURSORS[zone] : "crosshair";
		}
	});

	els.canvas.addEventListener("pointerup", () => {
		// 调整拖拽结束：自动重新切格
		if (adjDrag) {
			adjDrag = null;
			if (ws.cells) doSlice();
			return;
		}
		if (!dragStart) return;
		dragStart = null;
		if (ws.rect && ws.rect.R - ws.rect.L > 8) {
			els.edit.disabled = false;
			setStatus("框选完成，点击「切格」", "ok");
		}
	});

	function redraw() {
		const ctx = els.canvas.getContext("2d");
		if (!ws.img) {
			ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
			return;
		}
		ctx.drawImage(ws.img, 0, 0);
		if (!ws.rect) return;
		const { L, T, R, B } = ws.rect;
		const rows = Number(els.rows.value) || 1;
		const cols = Number(els.cols.value) || 1;
		const cw = (R - L) / cols;
		const ch = (B - T) / rows;
		ctx.lineWidth = Math.max(2, els.canvas.width * 0.004);
		ctx.strokeStyle = "#3fae5a";
		ctx.beginPath();
		for (let i = 1; i < cols; i++) {
			ctx.moveTo(L + cw * i, T);
			ctx.lineTo(L + cw * i, B);
		}
		for (let i = 1; i < rows; i++) {
			ctx.moveTo(L, T + ch * i);
			ctx.lineTo(R, T + ch * i);
		}
		ctx.stroke();
		ctx.lineWidth = Math.max(3, els.canvas.width * 0.007);
		ctx.strokeStyle = "#e03c31";
		ctx.strokeRect(L, T, R - L, B - T);
		// 边界调整模式：画出 8 个拖拽手柄（同 index.html scanRedraw）
		if (ws.editing) {
			const hs = Math.max(7, els.canvas.width * 0.012);
			const midX = (L + R) / 2;
			const midY = (T + B) / 2;
			ctx.fillStyle = "#fff";
			ctx.strokeStyle = "#e03c31";
			ctx.lineWidth = Math.max(1.5, els.canvas.width * 0.003);
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
	}

	els.rows.addEventListener("input", () => {
		redraw();
		// 行列变化时已切格的即时重切，保持格子板与网格一致
		if (ws.cells && ws.rect) doSlice();
		if (hooks.onDimsChange) hooks.onDimsChange();
	});
	els.cols.addEventListener("input", () => {
		redraw();
		if (ws.cells && ws.rect) doSlice();
		if (hooks.onDimsChange) hooks.onDimsChange();
	});

	/* 切格与点选 */
	function doSlice() {
		if (!ws.img || !ws.rect) {
			setStatus("请先自动定位或手动框选棋盘", "err");
			return;
		}
		const rows = Number(els.rows.value) || 1;
		const cols = Number(els.cols.value) || 1;
		// 切格走 scan-core.js 共享实现（内部 scanResampleBilinear，与 node bench 一致）
		ws.cells = scanSliceCells(ws.img, ws.rect, rows, cols).cells;
		ws.selected.clear();
		renderCellGrid();
	}

	els.slice.addEventListener("click", () => {
		doSlice();
		if (ws.cells) {
			const rows = Number(els.rows.value) || 1;
			const cols = Number(els.cols.value) || 1;
			if (hooks.onSliced) hooks.onSliced(rows, cols);
			else setStatus(`切格完成：${rows}×${cols}`, "ok");
		}
	});

	function renderCellGrid() {
		els.cellGrid.replaceChildren();
		els.cellWarn.textContent = "";
		if (!ws.cells) {
			if (hooks.onGridRendered) hooks.onGridRendered();
			return;
		}
		const rows = ws.cells.length;
		const cols = ws.cells[0].length;
		els.cellGrid.style.setProperty("--cols", cols);
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const wrap = document.createElement("div");
				wrap.className =
					"cell" +
					(ws.selected.has(`${r},${c}`) ? " selected" : "") +
					(hooks.cellClass ? hooks.cellClass(r, c) : "");
				if (hooks.cellData) Object.assign(wrap.dataset, hooks.cellData(r, c));
				const cv = document.createElement("canvas");
				cv.width = N;
				cv.height = N;
				cv.getContext("2d").drawImage(ws.cells[r][c], 0, 0);
				wrap.appendChild(cv);
				wrap.addEventListener("click", () => {
					if (hooks.onCellClick) hooks.onCellClick(r, c, wrap);
				});
				els.cellGrid.appendChild(wrap);
			}
		}
		if (hooks.onGridRendered) hooks.onGridRendered();
	}

	/** 选中格集合 -> 形状矩阵（对齐左上角）与占用格行优先列表 */
	function selectionMatrix() {
		const pts = [...ws.selected].map((s) => s.split(",").map(Number));
		if (!pts.length) return null;
		const minR = Math.min(...pts.map((p) => p[0]));
		const minC = Math.min(...pts.map((p) => p[1]));
		const maxR = Math.max(...pts.map((p) => p[0]));
		const maxC = Math.max(...pts.map((p) => p[1]));
		const mat = [];
		for (let r = minR; r <= maxR; r++) {
			const row = [];
			for (let c = minC; c <= maxC; c++)
				row.push(ws.selected.has(`${r},${c}`) ? 1 : 0);
			mat.push(row);
		}
		return { mat, cells: pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
	}

	Object.assign(ws, {
		setStatus,
		stopEditing,
		doSlice,
		renderCellGrid,
		selectionMatrix,
		loadImageBlob, // 暴露给原始图库：File 对象直接喂入工作区
	});
	return ws;
}

/** 弹窗格子板点选：校准模式单选采样圆点，提取模式多选切换（原弹窗内联逻辑） */
function onModalCellClick(r, c, wrap) {
	// 元素色校准模式：单选一格并采样其圆点
	if (state.mode === "calibrate") {
		ws.selected.clear();
		ws.selected.add(`${r},${c}`);
		els.cellGrid
			.querySelectorAll(".cell.selected")
			.forEach((el) => el.classList.remove("selected"));
		wrap.classList.add("selected");
		calibrateCell(r, c);
		return;
	}
	const key = `${r},${c}`;
	if (ws.selected.has(key)) ws.selected.delete(key);
	else ws.selected.add(key);
	wrap.classList.toggle("selected");
	updateForm();
}

/** 提取弹窗的截图工作区实例 */
const ws = createBoardWorkspace(
	{
		file: els.file,
		rows: els.rows,
		cols: els.cols,
		auto: els.auto,
		edit: els.edit,
		slice: els.slice,
		loadStatus: els.loadStatus,
		wrap: els.wrap,
		canvas: els.canvas,
		cellGrid: els.cellGrid,
		cellWarn: els.cellWarn,
	},
	{
		isActive: () => !els.modal.hidden,
		onCellClick: onModalCellClick,
		onGridRendered: updateForm,
		onSliced: (rows, cols) =>
			ws.setStatus(`切格完成：${rows}×${cols}，点选一件法宝占用的格子`, "ok"),
	},
);

/* 表单联动 */

function updateForm() {
	// 元素色校准模式：不跑指纹表单逻辑
	if (state.mode === "calibrate") {
		els.extract.disabled = true;
		return;
	}
	const sel = ws.selectionMatrix();
	const has = !!(sel && sel.cells.length);
	let shapeKey = null;
	if (has) shapeKey = SHAPES_CACHE[JSON.stringify(sel.mat)] || null;
	els.shapeInfo.textContent = !has
		? "未选择格子"
		: shapeKey ||
			`未知形状（${sel.cells.length} 格），仍可提取但需手工核对键名`;
	els.shapeInfo.className = has && !shapeKey ? "unknown" : "";
	// 目标法宝形状核对：点选形状与表格行不一致时醒目提示
	if (
		has &&
		state.target &&
		state.target.shapeKey &&
		shapeKey !== state.target.shapeKey
	) {
		els.shapeInfo.textContent = `${
			shapeKey || `未知形状（${sel.cells.length} 格）`
		} — 与目标形状 ${state.target.shapeKey} 不符`;
		els.shapeInfo.className = "unknown";
	}

	if (has) {
		const mat = sel.mat;
		els.thumb.width = mat[0].length * N;
		els.thumb.height = mat.length * N;
		const tctx = els.thumb.getContext("2d");
		const minR = Math.min(...sel.cells.map((p) => p[0]));
		const minC = Math.min(...sel.cells.map((p) => p[1]));
		tctx.clearRect(0, 0, els.thumb.width, els.thumb.height);
		sel.cells.forEach(([r, c]) => {
			tctx.drawImage(ws.cells[r][c], (c - minC) * N, (r - minR) * N);
		});
		els.thumb.hidden = false;
		els.thumb.style.width = `${mat[0].length * 40}px`;
		els.thumb.style.height = `${mat.length * 40}px`;

		// 品质自动猜测：选中格多数投票
		const tally = [0, 0, 0, 0, 0];
		let emptyCnt = 0;
		sel.cells.forEach(([r, c]) => {
			const data = ws.cells[r][c]
				.getContext("2d")
				.getImageData(0, 0, N, N).data;
			const q = cellQualityVote(data);
			if (q < 0) emptyCnt++;
			else tally[q]++;
		});
		let mq = 0;
		tally.forEach((n, q) => {
			if (n > tally[mq]) mq = q;
		});
		if (tally[mq]) {
			// 品质推荐：仅在新一次点选（从空到非空）时填入，之后不覆盖用户手改；
			// 推荐与当前选择不一致时仅文字提示；品质被目标锁定（红法宝）时不覆盖
			if (!state.hadSelection && !els.quality.disabled) els.quality.value = mq;
			els.qualityGuess.textContent =
				Number(els.quality.value) === mq
					? `推荐：${QUALITY_NAMES[mq]}阶`
					: `推荐：${QUALITY_NAMES[mq]}阶（未采用，可手动切换）`;
		} else {
			els.qualityGuess.textContent = "";
		}
		els.cellWarn.textContent = emptyCnt
			? `注意：${emptyCnt} 个选中格像空格（暗底居多），请检查是否点错`
			: "";
	} else {
		els.thumb.hidden = true;
		els.qualityGuess.textContent = "";
		els.cellWarn.textContent = "";
	}

	// 名称候选：按 类型 + 形状 + 红/普通 过滤；形状未知时只按类型过滤
	const red = Number(els.quality.value) === 4;
	const type = els.type.value;
	const matches = Object.entries(CATALOG)
		.filter(([, [t, s, isRed]]) => {
			if (t !== type || isRed !== red) return false;
			return shapeKey ? s === shapeKey : true;
		})
		.map(([name]) => name);
	els.nameList.replaceChildren(
		...matches.map((name) => {
			const opt = document.createElement("option");
			opt.value = name;
			return opt;
		}),
	);
	els.name.placeholder = matches.length
		? `候选 ${matches.length} 个：${matches.join(" / ")}`
		: "名录无匹配，可手工输入";
	els.extract.disabled = !has;
	state.hadSelection = has;
	// 目标锁定模式下名称固定，不做候选回填
	if (!state.target) {
		if (matches.length === 1) {
			els.name.value = matches[0];
		} else {
			els.name.value = "";
		}
	}
}

els.type.addEventListener("change", updateForm);
els.quality.addEventListener("change", updateForm);

/* 提取与输出 */
/**
 * 指纹提取核心：逐格签名 + 数据质量自检 + 入库，提取弹窗与真值标注共用。
 * 参数：name / type / quality(0-4) / cells([[r,c]..] 行优先) /
 *       cellCanvases(canvas[][] 归一化格) / thumb(dataURL)
 * 返回入库存条目；用户在自检确认框中取消时返回 null。
 */
function extractFingerprint({
	name,
	type,
	quality,
	cells,
	cellCanvases,
	thumb,
}) {
	const red = quality === 4;
	const shapeKey = SHAPES_CACHE[JSON.stringify(scanCellsToMat(cells))] || null;
	// 逐格计算签名（行优先）
	const sig = [];
	const sigLegacy = [];
	cells.forEach(([r, c]) => {
		const data = cellCanvases[r][c]
			.getContext("2d")
			.getImageData(0, 0, N, N).data;
		const bg = cellBg(data);
		sig.push(...cellSig(data, bg));
		sigLegacy.push(...cellSigLegacy(data));
	});
	// 图标像素过少提示（图标与底色过于接近时签名不可靠）
	const iconBlocks = sig.filter(Boolean).length;
	if (iconBlocks < cells.length * 4) {
		if (
			!confirm(
				`有效图标块很少（${iconBlocks}/${sig.length}），图标可能与底色过于接近，签名可能不可靠。仍要保存吗？`,
			)
		)
			return null;
	}

	// 数据质量自检（异常仅提示，不阻止保存）：
	// ① 每格图标块纹理：块均值亮度的平均离散度过低，说明可能抓到纯色背景而非图标；
	// ② 与同组已存指纹的区分度：diff 过小的两个法宝在识别端无法可靠区分
	const key = `${type}|${shapeKey || "未知形状"}|${red ? "red" : "normal"}`;
	const issues = [];
	cells.forEach((_, ci) => {
		const blocks = sig.slice(ci * 16, ci * 16 + 16).filter(Boolean);
		if (blocks.length < 4) return; // 覆盖过少已由上面的提示兜底
		const lums = blocks.map((p) => p[0] + p[1] + p[2]);
		const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
		const spread =
			lums.reduce((a, b) => a + Math.abs(b - mean), 0) / lums.length;
		if (spread < 24)
			issues.push(
				`第 ${ci + 1} 格图标纹理平淡（离散度 ${spread.toFixed(0)}），可能抓到底色而非图标`,
			);
	});
	let nearest = null;
	(mergedFpRefs().get(key) || [])
		.filter((e) => e.name !== name)
		.forEach((e) => {
			const d = fpDiff(sigLegacy, e.sigLegacy || e.sig);
			if (Number.isFinite(d) && (!nearest || d < nearest.d))
				nearest = { d, name: e.name };
		});
	if (nearest && nearest.d < 30)
		issues.push(
			`与同组「${nearest.name}」的指纹 diff 仅 ${nearest.d.toFixed(1)}，两个图标可能难以区分，建议换更清晰的截图重新提取`,
		);
	if (
		issues.length &&
		!confirm(`数据质量自检发现问题：\n- ${issues.join("\n- ")}\n\n仍要保存吗？`)
	)
		return null;

	const entry = {
		key,
		name,
		quality,
		maxDiff: 25,
		sig,
		sigLegacy,
		thumb,
	};
	state.entries.push(entry);
	saveEntries();
	renderEntries();
	return entry;
}

els.extract.addEventListener("click", () => {
	const sel = ws.selectionMatrix();
	if (!sel) return;
	const name = els.name.value.trim();
	if (!name) {
		els.name.focus();
		return;
	}
	const quality = Number(els.quality.value);
	const red = quality === 4;
	const type = els.type.value;
	const shapeKey = SHAPES_CACHE[JSON.stringify(sel.mat)] || null;
	// 目标法宝类别核对：红/普通与所选品质不一致需确认
	if (
		state.target &&
		red !== state.target.red &&
		!confirm(
			`目标「${state.target.name}」是${state.target.red ? "红法宝（五阶）" : "普通法宝"}，与所选品质不一致，仍要提取吗？`,
		)
	)
		return;
	if (
		!shapeKey &&
		!confirm("选中格子未匹配到已知形状，仍要提取吗？（键名将标记为未知）")
	)
		return;
	// 目标法宝形状核对：与表格行不一致需确认
	if (
		state.target &&
		state.target.shapeKey &&
		shapeKey !== state.target.shapeKey &&
		!confirm(
			`选中形状（${shapeKey || "未知形状"}）与目标「${state.target.name}」的形状 ${state.target.shapeKey} 不符，仍要提取吗？`,
		)
	)
		return;
	if (CATALOG[name] && CATALOG[name][0] !== type) {
		if (
			!confirm(
				`名录中「${name}」属于「${CATALOG[name][0]}」系，与所选类型不一致，仍要提取吗？`,
			)
		)
			return;
	}

	const entry = extractFingerprint({
		name,
		type,
		quality,
		cells: sel.cells,
		cellCanvases: ws.cells,
		thumb: els.thumb.toDataURL(),
	});
	if (!entry) return;
	// 提取完成后清空本次点选与表单数据，便于直接点选下一件法宝
	ws.selected.clear();
	ws.renderCellGrid();
	// renderCellGrid 内 updateForm 可能按唯一候选回填名称；目标模式下恢复锁定名
	els.name.value = state.target ? state.target.name : "";
	ws.setStatus(`已提取「${name}」（${QUALITY_NAMES[quality]}阶）`, "ok");
});

function saveEntries() {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(state.entries));
		localStorage.setItem(LS_DOTS_KEY, JSON.stringify(state.dotSamples));
		localStorage.setItem(LS_ADOPT_KEY, JSON.stringify(state.adoptedRanges));
		localStorage.setItem(
			LS_DIMS_KEY,
			JSON.stringify({
				rows: Number(els.rows.value),
				cols: Number(els.cols.value),
			}),
		);
	} catch (e) {
		console.warn("localStorage 保存失败", e);
	}
}

function loadEntries() {
	try {
		state.entries = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
		state.dotSamples = JSON.parse(localStorage.getItem(LS_DOTS_KEY) || "{}");
		state.adoptedRanges = JSON.parse(
			localStorage.getItem(LS_ADOPT_KEY) || "{}",
		);
		const dims = JSON.parse(localStorage.getItem(LS_DIMS_KEY) || "null");
		if (dims) {
			els.rows.value = dims.rows;
			els.cols.value = dims.cols;
			els.replayRows.value = dims.rows;
			els.replayCols.value = dims.cols;
		}
	} catch {
		state.entries = [];
		state.dotSamples = {};
		state.adoptedRanges = {};
	}
}

els.clear.addEventListener("click", () => {
	if (!state.entries.length) return;
	if (!confirm(`清空全部 ${state.entries.length} 条已提取指纹？`)) return;
	state.entries = [];
	saveEntries();
	renderEntries();
});

function renderEntries() {
	els.entryList.replaceChildren();
	state.entries.forEach((en, idx) => {
		const div = document.createElement("div");
		div.className = "entry";
		const img = document.createElement("img");
		img.src = en.thumb;
		div.appendChild(img);
		const meta = document.createElement("div");
		meta.className = "meta";
		const title = document.createElement("div");
		title.textContent = `${idx + 1}. ${en.name}（${QUALITY_NAMES[en.quality]}阶）`;
		meta.appendChild(title);
		const sub = document.createElement("div");
		sub.className = "sub";
		sub.textContent = en.key;
		meta.appendChild(sub);
		// 同名跨品质一致性：两两 diff，辅助判断「通用模板 / 按品质分开」
		const siblings = state.entries.filter(
			(o, oi) => oi !== idx && o.name === en.name && o.key === en.key,
		);
		if (siblings.length) {
			const diffs = siblings
				.map((o) => fpDiff(en.sig, o.sig))
				.filter((d) => Number.isFinite(d));
			if (diffs.length) {
				const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
				const note = document.createElement("div");
				const generic = avg < 15;
				note.className = `sub ${generic ? "merge-note" : "split-note"}`;
				note.textContent = generic
					? `与同名其他品质平均 diff ${avg.toFixed(1)}：图标基本一致，可只保留一条并把 quality 改为 null 作通用模板`
					: `与同名其他品质平均 diff ${avg.toFixed(1)}：图标随品质变化，需按品质分别保留`;
				meta.appendChild(note);
			}
		}
		// 同组区分度：与库内（已存 + 待保存）其他法宝指纹的最近 diff，过小提示难以区分
		let rival = null;
		(mergedFpRefs().get(en.key) || [])
			.filter((o) => o.name !== en.name)
			.forEach((o) => {
				const d = fpDiff(en.sigLegacy, o.sigLegacy || o.sig);
				if (Number.isFinite(d) && (!rival || d < rival.d))
					rival = { d, name: o.name };
			});
		if (rival) {
			const rnote = document.createElement("div");
			const weak = rival.d < 30;
			rnote.className = `sub ${weak ? "split-note" : "merge-note"}`;
			rnote.textContent = weak
				? `与同组最近「${rival.name}」diff ${rival.d.toFixed(1)}：区分度不足，识别端可能消歧失败`
				: `与同组最近「${rival.name}」diff ${rival.d.toFixed(1)}：区分度正常`;
			meta.appendChild(rnote);
		}
		// 与数据文件现有条目冲突（同名同品质但指纹不同）：视觉标记，保存将以本地覆盖文件条目
		if (fpIsConflict(en)) {
			const cnote = document.createElement("div");
			cnote.className = "sub split-note";
			cnote.textContent =
				"与数据文件现有条目冲突（同名同品质但指纹内容不同），保存 / 直写将以本地条目覆盖文件条目";
			meta.appendChild(cnote);
		}
		div.appendChild(meta);
		const del = document.createElement("button");
		del.textContent = "删除";
		del.addEventListener("click", () => {
			state.entries.splice(idx, 1);
			saveEntries();
			renderEntries();
		});
		div.appendChild(del);
		els.entryList.appendChild(div);
	});
	renderTable();
	renderOutput();
}

/** 当前输出配置对应的指纹库：已存（scan-fp-refs.js）+ 本次新提取合并
 * （同 key 追加，同 name+quality 以新条目覆盖），提取自检与回放验证均以此为准 */
function mergedFpRefs() {
	const groups = new Map();
	Object.entries(LOADED_FP_REFS).forEach(([key, list]) => {
		groups.set(
			key,
			list.map((e) => ({ ...e })),
		);
	});
	state.entries.forEach((en) => {
		if (!groups.has(en.key)) groups.set(en.key, []);
		const list = groups.get(en.key);
		const old = list.findIndex(
			(e) => e.name === en.name && e.quality === en.quality,
		);
		const entry = {
			name: en.name,
			quality: en.quality,
			maxDiff: en.maxDiff,
			sig: en.sig,
			sigLegacy: en.sigLegacy,
			// 组级提取的统计字段（模板质量信息，见组级提取段头注释）
			...(en.sigVar ? { sigVar: en.sigVar } : {}),
			...(en.samples != null ? { samples: en.samples } : {}),
		};
		if (old >= 0) list[old] = entry;
		else list.push(entry);
	});
	return groups;
}

function renderOutput() {
	fpRetrainCheck(); // 区间相对入库值有差异时联动顶部重训提醒条
	// 已打开数据文件：段级无损写回（未改动的段含注释逐字节保留原文）
	const lossless = fpBuildOutput();
	if (lossless != null) {
		els.output.value = lossless;
		return;
	}
	const hasDots = Object.values(state.dotSamples).some((a) => a.length);
	if (!state.entries.length && !hasDots) {
		els.output.value = "";
		return;
	}
	// 全文组装统一走 scan-fp-io.js（唯一写回口径）；非本工具职责段
	// （SCAN_REC / 两个模型）传加载原值轮转，防丢段
	els.output.value = scanFpRefsSerialize({
		dotTypes: computeDotRanges(),
		scanRec: SCAN_REC,
		fpGroups: mergedFpRefs(),
		typeModel: window.SCAN_TYPE_MODEL,
		pixelModel: window.SCAN_PIXEL_MODEL,
	});
}

els.copy.addEventListener("click", async () => {
	if (!els.output.value) return;
	try {
		await navigator.clipboard.writeText(els.output.value);
		ws.setStatus("已复制到剪贴板", "ok");
	} catch {
		els.output.select();
		document.execCommand("copy");
		ws.setStatus("已复制到剪贴板", "ok");
	}
	fpAfterExport();
});

/** 输出保存：已打开数据文件（File System Access）时 createWritable 直接写盘；
 *  否则优先 showSaveFilePicker 另存（同 truth 保存路径），API 不可用
 *  （如 file:// / 非 Chromium）时降级为选中文本提示复制 */
els.save.addEventListener("click", async () => {
	renderOutput(); // 保底：保存前重建输出，防用过期的旧渲染文本
	if (!els.output.value) return;
	// 入库硬校验（2026-08-07 Step 4）：SCAN_DOT_TYPES 两两交叠即拒绝写出
	// （开区间口径，火/雷策略 B 豁免；弹窗手动样本 rangeFromHues 可能产出
	// 交叠区间，历史事故为重叠建议直接入库，此处兜底拦截）
	const dv = scanDotTypesValidate(computeDotRanges());
	if (!dv.ok) {
		els.fpFileStatus.textContent = `SCAN_DOT_TYPES 未写出：${dv.problems.join("；")}`;
		els.fpFileStatus.className = "status err";
		return;
	}
	if (fpf.mode === "ready") {
		if (!(await fpEnsurePerm())) {
			fpfSetState("needPerm");
			return;
		}
		try {
			const w = await fpf.handle.createWritable();
			await w.write(els.output.value);
			await w.close();
			fpf.rawText = els.output.value; // 写盘原文推进，后续保存继续以它为底
			await fpAfterSave();
			fpSettleSavedEntries();
			els.save.textContent = "已保存 ✓";
			setTimeout(() => (els.save.textContent = fpSaveLabel()), 2000);
		} catch (e) {
			els.fpFileStatus.textContent = `写入数据文件失败：${e.message}`;
			els.fpFileStatus.className = "status err";
		}
		return;
	}
	if (window.showSaveFilePicker) {
		try {
			const handle = await showSaveFilePicker({
				suggestedName: "scan-fp-refs.js",
				types: [
					{
						description: "识别配置",
						accept: { "text/javascript": [".js"] },
					},
				],
			});
			const w = await handle.createWritable();
			await w.write(els.output.value);
			await w.close();
			fpAfterExport();
			fpSettleSavedEntries();
			els.save.textContent = "已保存 ✓";
			setTimeout(() => (els.save.textContent = fpSaveLabel()), 2000);
			return;
		} catch (e) {
			if (e.name === "AbortError") return;
			// 其他异常落到降级路径
		}
	}
	els.output.focus();
	els.output.select();
	els.save.textContent = "不支持直存，请复制";
	setTimeout(() => (els.save.textContent = fpSaveLabel()), 2500);
});

/* 数据文件直读写（File System Access）与模型重训提醒 */
/**
 * 「打开数据文件」授权 data/scan-fp-refs.js 句柄（IndexedDB 缓存，键 fpRefsFile，
 * 与原始图库同库）：读——解析各段刷新库基线（取磁盘最新值，防 bench 重训入库的
 * 新模型在保存时被覆盖回页面加载旧值）；写——createWritable 直写，已打开文件时
 * 走段级无损替换 fpBuildOutput（只重新生成变化的段，其余含注释逐字节保留），
 * 未打开时维持 scanFpRefsSerialize 全量序列化；API 不可用（非 Chromium）降级复制。
 *
 * 模型重训提醒：模型特征与标签依赖 SCAN_DOT_TYPES，区间变更入库后须在 Node bench
 * 管线重训。判定优先模型内嵌 dotTypes 区间水印（只看数据文件，不依赖 localStorage）；
 * 无水印旧格式回退 localStorage fp-extract:retrain 标记 + models-diff / mtime 启发式。
 */
const fpf = {
	handle: null, // data/scan-fp-refs.js 文件句柄
	mode: "none", // none=未打开 / needPerm=句柄在但需重授权 / ready=可读写
	base: null, // 入库基线 { dotTypes, fpRefs, models, mtime }：数据文件最近读到的值
	rawText: null, // 数据文件原文（段级无损写回的底本；写盘后推进为写入文本）
	notice: null, // 基线结算产生的一次性提示（由 fpfSetState 消费展示）
};
// 基线初值即 <script src> 加载值（页面加载即读到文件当前内容）；直读文件后推进
fpf.base = fpBaseFromLoaded();
const FPF_IDB_KEY = "fpRefsFile"; // IndexedDB 句柄键（库 / 存储同原始图库 GAL_IDB）

/** 重训命令序列（tools/bench 管线，项目根目录执行；
 *  子命令与 bench.js / dump-feats.js / dump-pixels.js 头部用法注释一致） */
const RETRAIN_CMD =
	"node tools/bench/dump-feats.js && node tools/bench/bench.js calib-types && " +
	"node tools/bench/dump-pixels.js && node tools/bench/bench.js calib-pixel";

function fpBaseFromLoaded() {
	return {
		dotTypes: LOADED_DOT_TYPES,
		fpRefs: LOADED_FP_REFS,
		models: fpModelsKey(window.SCAN_TYPE_MODEL, window.SCAN_PIXEL_MODEL),
		mtime: 0, // 无句柄时无 mtime 口径
	};
}

function fpModelsKey(typeModel, pixelModel) {
	return JSON.stringify([typeModel || null, pixelModel || null]);
}

/** 模型与区间的对齐判定（优先口径）：模型内嵌 dotTypes 区间水印与文件当前区间
 *  逐字节一致才算对齐——只看数据文件，不依赖 localStorage。返回 true=对齐 /
 *  false=待重训 / null=判不了（无水印旧格式，回退 localStorage 标记 + 启发式） */
function fpModelsWatermark() {
	const dotTypes = fpf.base && fpf.base.dotTypes;
	if (!dotTypes) return null;
	const ms = [window.SCAN_TYPE_MODEL, window.SCAN_PIXEL_MODEL].filter(Boolean);
	if (!ms.length || ms.some((m) => !Array.isArray(m.dotTypes))) return null;
	const want = JSON.stringify(dotTypes);
	return ms.every((m) => JSON.stringify(m.dotTypes) === want);
}

/** 解析 scan-fp-refs.js 文本（文件即本工具写回的数据文件，与 <script src> 同源可信） */
function fpParseRefs(text) {
	return new Function(`${text}
				return {
					dotTypes: typeof SCAN_DOT_TYPES === "undefined" ? null : SCAN_DOT_TYPES,
					fpRefs: typeof SCAN_FP_REFS === "undefined" ? {} : SCAN_FP_REFS,
					scanRec: typeof SCAN_REC === "undefined" ? null : SCAN_REC,
					typeModel: typeof SCAN_TYPE_MODEL === "undefined" ? null : SCAN_TYPE_MODEL,
					pixelModel: typeof SCAN_PIXEL_MODEL === "undefined" ? null : SCAN_PIXEL_MODEL,
				};`)();
}

/** 把数据文件原文切成「普通文本（注释等）」与「顶层 var 语句」片段序列
 * （段级无损写回的定位基础，思路同 tools/bench/refingerprint.js 的段级替换）；
 *  单行语句以行尾 ; 收尾，多行语句（SCAN_REC / SCAN_FP_REFS）以列 0 的 }; 行收尾 */
function fpSplitSections(text) {
	const lines = text.split("\n");
	const pieces = [];
	let buf = [];
	const flush = () => {
		if (buf.length) {
			pieces.push({ text: buf.join("\n") });
			buf = [];
		}
	};
	let i = 0;
	while (i < lines.length) {
		const m = /^var (SCAN_\w+) =/.exec(lines[i]);
		if (!m) {
			buf.push(lines[i]);
			i++;
			continue;
		}
		flush();
		const stmt = [lines[i]];
		i++;
		if (!/;\s*$/.test(stmt[0])) {
			while (i < lines.length && !/^\};?$/.test(lines[i])) {
				stmt.push(lines[i]);
				i++;
			}
			if (i < lines.length) {
				stmt.push(lines[i]); // 收尾的 }; 行
				i++;
			}
		}
		pieces.push({ name: m[1], text: stmt.join("\n") });
	}
	flush();
	return pieces;
}

/** 段级无损写回：以打开的文件原文为底，只重新生成实际变化的段
 * （SCAN_DOT_TYPES var 行 / SCAN_FP_REFS var 语句，序列化口径同 scan-fp-io.js），
 *  其余段落（含全部注释）逐字节保留；未打开数据文件时返回 null，
 *  调用方退化为 scanFpRefsSerialize 全量序列化 */
function fpBuildOutput() {
	if (!fpf.rawText) return null;
	const pieces = fpSplitSections(fpf.rawText);
	const dotTypes = computeDotRanges();
	const dotChanged =
		JSON.stringify(dotTypes) !== JSON.stringify(fpf.base.dotTypes);
	const fpGroups = mergedFpRefs();
	const fpChanged =
		JSON.stringify(Object.fromEntries(fpGroups)) !==
		JSON.stringify(fpf.base.fpRefs);
	let dotSeen = false;
	let fpSeen = false;
	const out = pieces.map((p) => {
		if (p.name === "SCAN_DOT_TYPES") {
			dotSeen = true;
			return dotChanged
				? `var SCAN_DOT_TYPES = ${JSON.stringify(dotTypes)};`
				: p.text;
		}
		if (p.name === "SCAN_FP_REFS") {
			fpSeen = true;
			return fpChanged ? scanFpRefsSectionLines(fpGroups).join("\n") : p.text;
		}
		return p.text;
	});
	// 数据文件缺段（旧格式）且该段有变化：补在文末
	if (dotChanged && !dotSeen)
		out.push(`var SCAN_DOT_TYPES = ${JSON.stringify(dotTypes)};`);
	if (fpChanged && !fpSeen)
		out.push(scanFpRefsSectionLines(fpGroups).join("\n"));
	return out.join("\n");
}

/** 文件条目与本地待保存条目的冲突：同 键+名称+品质 但指纹内容（sig/sigLegacy）不同 */
function fpFindConflicts(fpRefs) {
	const conflicts = [];
	state.entries.forEach((en) => {
		const fe = (fpRefs[en.key] || []).find(
			(o) => o.name === en.name && o.quality === en.quality,
		);
		if (!fe) return;
		if (
			JSON.stringify(en.sig) !== JSON.stringify(fe.sig) ||
			JSON.stringify(en.sigLegacy) !== JSON.stringify(fe.sigLegacy)
		)
			conflicts.push({ local: en, file: fe });
	});
	return conflicts;
}

/** 单条本地条目是否与当前基线（数据文件）冲突：列表视觉标记用 */
function fpIsConflict(en) {
	const fpRefs = (fpf.base && fpf.base.fpRefs) || {};
	return fpFindConflicts(fpRefs).some((c) => c.local === en);
}

/** 文件内容应用为当前库基线：刷新已存指纹 / 色值与轮转段，联动表格、区间列表与输出；
 *  文件条目与本地待保存条目冲突时显式提示选择（不静默覆盖） */
function fpApplyFile(parsed, mtime, rawText) {
	if (parsed.dotTypes) LOADED_DOT_TYPES = parsed.dotTypes;
	LOADED_FP_REFS = parsed.fpRefs || {};
	// 轮转段同步为文件值：防保存时把 bench 重训的新模型覆盖回旧值（scan-fp-io.js 轮转口径）
	if (parsed.scanRec) window.SCAN_REC = parsed.scanRec;
	window.SCAN_TYPE_MODEL = parsed.typeModel || null;
	window.SCAN_PIXEL_MODEL = parsed.pixelModel || null;
	const conflicts = fpFindConflicts(LOADED_FP_REFS);
	if (conflicts.length) {
		const names = conflicts
			.map(
				(c) =>
					`${c.local.name}（${c.local.quality != null ? `${QUALITY_NAMES[c.local.quality]}阶` : "通用模板"}）`,
			)
			.join("、");
		const keepLocal = confirm(
			`数据文件中有 ${conflicts.length} 条指纹与本地待保存条目冲突（同名同品质但指纹内容不同）：\n${names}\n\n` +
				"「确定」= 保留本地待保存条目（保存时覆盖文件条目）；\n" +
				"「取消」= 以数据文件为准，丢弃本地冲突条目",
		);
		if (!keepLocal) {
			const drop = new Set(conflicts.map((c) => c.local));
			state.entries = state.entries.filter((en) => !drop.has(en));
			saveEntries();
		}
	}
	fpf.base = {
		dotTypes: LOADED_DOT_TYPES,
		fpRefs: LOADED_FP_REFS,
		models: fpModelsKey(parsed.typeModel, parsed.pixelModel),
		mtime,
	};
	fpf.rawText = rawText || null;
	fpRetrainSettle();
	renderEntries();
	renderCalRanges();
	renderDcAll();
}

function fpRetrainLoad() {
	try {
		return JSON.parse(localStorage.getItem(LS_RETRAIN_KEY) || "null");
	} catch {
		return null;
	}
}

function fpRetrainSave(pend) {
	try {
		if (pend) localStorage.setItem(LS_RETRAIN_KEY, JSON.stringify(pend));
		else localStorage.removeItem(LS_RETRAIN_KEY);
	} catch (e) {
		console.warn("localStorage 保存失败", e);
	}
}

/** 入库时维护「待重训」标记：仅区间相对基线有变化才标记（纯指纹入库不打扰）；
 *  改回标记前区间（撤销变更）则直接解除。mtime 记写入后文件时间，之后
 *  「重新读取」只有文件被外部（bench 重训）再改过才按 mtime 解除 */
function fpRetrainMark(written, prevBase, mtime) {
	const old = fpRetrainLoad();
	if (old && JSON.stringify(written) === JSON.stringify(old.prevDotTypes)) {
		fpRetrainSave(null);
		return;
	}
	fpRetrainSave({
		dotTypes: written, // 本次入库的区间（重训应对齐它）
		prevDotTypes: old ? old.prevDotTypes : prevBase.dotTypes, // 标记前区间（模型当前对齐的值）
		models: prevBase.models, // 入库时文件里的模型段（重训后会变）
		mtime,
	});
}

/** 基线刷新（读文件 / 页面加载）时结算标记：水印可判时以水印为准（一致=重训完成，
 *  解除标记并提示；不一致=模型陈旧，fpRetrainCheck 直接亮条）；水印判不了回退旧
 *  启发式：改回标记前区间、或区间一致且模型段已更新 / 文件被外部改过则解除 */
function fpRetrainSettle() {
	const wm = fpModelsWatermark();
	const pend = fpRetrainLoad();
	if (wm === true) {
		if (pend) {
			fpRetrainSave(null); // 重训完成：模型水印与区间一致
			fpf.notice = "检测到模型已重训入库，「待重训」状态解除";
		}
	} else if (wm === null && pend) {
		const baseDots = JSON.stringify(fpf.base.dotTypes);
		if (baseDots === JSON.stringify(pend.prevDotTypes)) {
			fpRetrainSave(null); // 已改回标记前区间，模型与区间恢复一致
		} else if (
			baseDots === JSON.stringify(pend.dotTypes) &&
			(fpf.base.models !== pend.models ||
				(pend.mtime && fpf.base.mtime > pend.mtime))
		) {
			fpRetrainSave(null); // 重训完成：模型段更新或文件有外部修改
			fpf.notice = "检测到模型已重训入库，「待重训」状态解除";
		} else if (baseDots !== JSON.stringify(pend.dotTypes)) {
			pend.dotTypes = fpf.base.dotTypes; // 区间再次变更：标记跟随最新入库值
			fpRetrainSave(pend);
		}
	}
	fpRetrainCheck();
}

/** 提醒条渲染：生效区间相对入库值有差异（未入库）、模型区间水印与当前区间
 *  不一致、或存在待重训标记（无水印旧模型的回退口径）时常驻 */
function fpRetrainCheck() {
	const wm = fpModelsWatermark();
	const pend = wm === null ? fpRetrainLoad() : null; // 水印可判时以水印为准
	const diff =
		JSON.stringify(computeDotRanges()) !== JSON.stringify(fpf.base.dotTypes);
	const msgs = [];
	if (diff) msgs.push("SCAN_DOT_TYPES 相对数据文件入库值有变更（尚未入库）");
	if (wm === false)
		msgs.push(
			"文件内模型与当前 SCAN_DOT_TYPES 不一致（模型区间水印陈旧），SCAN_TYPE_MODEL / SCAN_PIXEL_MODEL 待重训",
		);
	else if (pend)
		msgs.push(
			"SCAN_DOT_TYPES 已变更入库，SCAN_TYPE_MODEL / SCAN_PIXEL_MODEL 待重训",
		);
	els.retrainBar.hidden = !msgs.length;
	if (msgs.length)
		els.retrainMsg.textContent = `${msgs.join("；")}——重训在 Node bench 管线（项目根目录执行）：`;
}

/** 文件句柄 UI 三态（同原始图库 galSetState 口径）；不支持 API 时整组隐藏走降级 */
function fpfSetState(mode) {
	fpf.mode = mode;
	const supported = !!window.showOpenFilePicker;
	els.fpOpen.hidden = !supported || mode === "needPerm";
	els.fpOpen.textContent = mode === "ready" ? "更换数据文件" : "打开数据文件";
	els.fpPerm.hidden = !supported || mode !== "needPerm";
	els.fpRefresh.hidden = !supported || mode !== "ready";
	els.save.textContent = fpSaveLabel();
	const notice = fpf.notice;
	fpf.notice = null;
	if (notice) {
		els.fpFileStatus.textContent = notice;
		els.fpFileStatus.className = "status ok";
	} else if (!supported) {
		els.fpFileStatus.textContent =
			"当前浏览器不支持 File System Access（需 Chrome / Edge）：走「复制」输出文本手动整体替换 data/scan-fp-refs.js";
		els.fpFileStatus.className = "status";
	} else if (mode === "none") {
		els.fpFileStatus.textContent =
			"未打开数据文件：保存走复制 / 另存后手动替换；打开 data/scan-fp-refs.js 后可直接写盘";
		els.fpFileStatus.className = "status";
	} else if (mode === "needPerm") {
		els.fpFileStatus.textContent =
			"数据文件句柄已缓存，需要重新授权后恢复直读写（点左侧按钮，系统弹窗中允许）";
		els.fpFileStatus.className = "status";
	} else {
		els.fpFileStatus.textContent = `已打开 ${fpf.handle.name}：「保存到文件」直接写盘；bench 重训或外部改动后点「重新读取」刷新基线`;
		els.fpFileStatus.className = "status ok";
	}
}

function fpSaveLabel() {
	return fpf.mode === "ready" ? "保存到数据文件" : "保存到文件";
}

/** 读写权限确认（同图库 galEnsurePerm 口径；requestPermission 需用户手势） */
async function fpEnsurePerm() {
	if (!fpf.handle) return false;
	try {
		const opts = { mode: "readwrite" };
		if ((await fpf.handle.queryPermission(opts)) === "granted") return true;
		return (await fpf.handle.requestPermission(opts)) === "granted";
	} catch {
		return false;
	}
}

/** 经句柄读取文件内容并应用为当前库基线（原文留作段级无损写回底本） */
async function fpReadFile() {
	const file = await fpf.handle.getFile();
	const text = await file.text();
	const parsed = fpParseRefs(text);
	if (!parsed.dotTypes)
		throw new Error(
			"文件中没有 SCAN_DOT_TYPES，请确认打开的是 data/scan-fp-refs.js",
		);
	fpApplyFile(parsed, file.lastModified, text);
}

els.fpOpen.addEventListener("click", async () => {
	if (!window.showOpenFilePicker) return;
	try {
		const [handle] = await showOpenFilePicker({
			id: "fp-refs-file",
			types: [
				{
					description: "识别配置 data/scan-fp-refs.js",
					accept: { "text/javascript": [".js"] },
				},
			],
		});
		fpf.handle = handle;
		try {
			await galIdbPut(handle, FPF_IDB_KEY);
		} catch (e) {
			console.warn("IndexedDB 缓存文件句柄失败", e);
		}
		await fpReadFile();
		fpfSetState("ready");
	} catch (e) {
		if (e.name !== "AbortError") {
			els.fpFileStatus.textContent = `打开数据文件失败：${e.message}`;
			els.fpFileStatus.className = "status err";
		}
	}
});

els.fpPerm.addEventListener("click", async () => {
	if (!(await fpEnsurePerm())) {
		els.fpFileStatus.textContent = "授权被拒绝，数据文件直读写不可用";
		els.fpFileStatus.className = "status err";
		return;
	}
	try {
		await fpReadFile();
		fpfSetState("ready");
	} catch (e) {
		els.fpFileStatus.textContent = `读取数据文件失败：${e.message}`;
		els.fpFileStatus.className = "status err";
	}
});

els.fpRefresh.addEventListener("click", async () => {
	if (!(await fpEnsurePerm())) {
		fpfSetState("needPerm");
		return;
	}
	try {
		await fpReadFile();
		fpfSetState("ready");
	} catch (e) {
		els.fpFileStatus.textContent = `读取数据文件失败：${e.message}`;
		els.fpFileStatus.className = "status err";
	}
});

els.retrainCopy.addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(RETRAIN_CMD);
		els.retrainCopy.textContent = "已复制 ✓";
	} catch {
		els.retrainCopy.textContent = "复制失败，请手动选中命令复制";
	}
	setTimeout(() => (els.retrainCopy.textContent = "复制重训命令"), 2000);
});

/** FS 直写成功后：区间有变化打待重训标记，基线推进到刚写入的值
 * （区间未变也要推进 mtime / 模型水印，防本次写盘被误判成外部重训） */
async function fpAfterSave() {
	const prev = fpf.base;
	const written = computeDotRanges();
	let mtime = 0;
	try {
		mtime = (await fpf.handle.getFile()).lastModified;
	} catch {
		// 仅影响按 mtime 判重训的口径
	}
	if (JSON.stringify(written) !== JSON.stringify(prev.dotTypes)) {
		fpRetrainMark(written, prev, mtime);
	} else {
		const pend = fpRetrainLoad();
		if (pend) {
			pend.mtime = mtime;
			pend.models = prev.models;
			fpRetrainSave(pend);
		}
	}
	fpf.base = {
		dotTypes: written,
		fpRefs: Object.fromEntries(mergedFpRefs()),
		models: prev.models,
		mtime,
	};
	fpRetrainCheck();
}

/** 降级导出（复制 / 另存文本）后：视本次输出为入库值（「上次输出快照」近似口径），
 *  区间有变化打待重训标记；FS 直写（ready）不走这里 */
function fpAfterExport() {
	if (fpf.mode === "ready") return;
	const prev = fpf.base;
	const written = computeDotRanges();
	const fpRefs = Object.fromEntries(mergedFpRefs());
	if (
		JSON.stringify(written) === JSON.stringify(prev.dotTypes) &&
		JSON.stringify(fpRefs) === JSON.stringify(prev.fpRefs)
	)
		return;
	if (JSON.stringify(written) !== JSON.stringify(prev.dotTypes))
		fpRetrainMark(written, prev, 0);
	fpf.base = { ...prev, dotTypes: written, fpRefs };
	fpRetrainCheck();
}

/** 保存（直写 / 另存）成功后：把本次写入值提升为「已存」基线（防输出与名录状态
 *  回退到页面加载旧库），并清空本地已提取条目（留着只会与文件内容重复）；
 *  renderEntries 连带重渲染表格。「复制」不算落盘，不触发本结算 */
function fpSettleSavedEntries() {
	LOADED_DOT_TYPES = fpf.base.dotTypes;
	LOADED_FP_REFS = fpf.base.fpRefs;
	if (!state.entries.length) return;
	state.entries = [];
	saveEntries();
	renderEntries(); // 连带 renderTable / renderGroupView / renderOutput
}

/** 初始化：从 IndexedDB 恢复文件句柄；权限仍在则直接读文件刷新基线，
 *  否则等用户手势重授（降级 / 未打开时基线即 <script src> 加载值） */
async function initFpFile() {
	els.retrainCmd.textContent = RETRAIN_CMD;
	if (!window.showOpenFilePicker) {
		fpRetrainSettle();
		fpfSetState("none");
		return;
	}
	let handle = null;
	try {
		handle = await galIdbGet(FPF_IDB_KEY);
	} catch (e) {
		console.warn("IndexedDB 读取文件句柄失败", e);
	}
	if (!handle) {
		fpRetrainSettle();
		fpfSetState("none");
		return;
	}
	fpf.handle = handle;
	try {
		if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") {
			await fpReadFile(); // fpApplyFile 内已结算标记
			fpfSetState("ready");
		} else {
			fpRetrainSettle();
			fpfSetState("needPerm");
		}
	} catch {
		fpRetrainSettle();
		fpfSetState("needPerm");
	}
}

/* 批量并行（Web Worker 池） */
/**
 * 三个批量流程（回放验证 / 元素校准批量采样 / 组级提取批量采样）的并行入口：
 * 解码 / 定位 / 切格 / 识别或采样全部在 worker（script/fp-worker.js，纯像素路径
 * 与串行 / node bench 逐字节一致），主线程只负责保序渲染与汇总；worker 池不可用时
 * 回退串行路径，不硬失败。
 */

/** worker 池就绪则返回 FPPool，不可用 / 启动失败返回 null（调用方回退串行，note 给状态提示） */
async function fpPoolEnsure(note) {
	if (typeof FPPool === "undefined" || !FPPool.supported()) return null;
	try {
		return await FPPool.ensure();
	} catch (e) {
		console.warn("并行 worker 启动失败，回退串行处理", e);
		if (note) note();
		return null;
	}
}

/** worker 回传的棋子缩略图像素重建 canvas（putImageData 1:1，与串行 drawImage 像素一致） */
function fpThumbCanvas(w, h, buf) {
	const cv = document.createElement("canvas");
	cv.width = w;
	cv.height = h;
	cv.getContext("2d").putImageData(
		new ImageData(new Uint8ClampedArray(buf), w, h),
		0,
		0,
	);
	return cv;
}

/** 并行采样缩略图重建：按包围盒拼接占用格（同 gxAddSample / annPieceThumb 口径） */
function fpMosaicThumb(cells, cellPix) {
	const minR = Math.min(...cells.map((p) => p[0]));
	const minC = Math.min(...cells.map((p) => p[1]));
	const maxR = Math.max(...cells.map((p) => p[0]));
	const maxC = Math.max(...cells.map((p) => p[1]));
	const cv = document.createElement("canvas");
	cv.width = (maxC - minC + 1) * N;
	cv.height = (maxR - minR + 1) * N;
	const ctx = cv.getContext("2d");
	cells.forEach(([r, c], i) => {
		ctx.putImageData(
			new ImageData(new Uint8ClampedArray(cellPix[i]), N, N),
			(c - minC) * N,
			(r - minR) * N,
		);
	});
	return cv;
}

/* 回放验证 */
/**
 * 与 index.html 截图导入同一套识别流水线（scan-core.js 共享），
 * 配置取当前输出（含待保存指纹 mergedFpRefs 与校准色值 computeDotRanges），
 * 用于在写回 data/scan-fp-refs.js 前验证指纹的消歧质量。
 */
const REPLAY_MARGIN_OK = 12; // 命中与次低 diff 的间隔达到该值判「可靠」
const replayStats = []; // 每件棋子的判定结果，用于汇总

/** 回测状态：truth 配对表、本次评分结果（scanScoreImage 返回对象）、历史报告 */
const bt = {
	truths: new Map(), // 截图文件名 -> truth 对象
	results: [], // 本次回测已评分图（scanScoreImage 返回对象）
	report: null, // 历史 report.json（bench compare 产物）
};

/** 回测格子着色（叠加在卡片缩略图上）：绿=配对且全对 / 黄=配对但有错 / 红=漏检 / 蓝=误检 */
const BT_COLORS = {
	ok: "rgba(77, 138, 82, 0.35)",
	wrong: "rgba(184, 117, 20, 0.42)",
	miss: "rgba(200, 99, 99, 0.45)",
	false: "rgba(79, 124, 255, 0.40)",
};

/** 完整识别一盘切格后的棋盘，返回棋子列表（含指纹匹配排名 rank） */
function replayRecognize(cells, rows, cols) {
	const dotTypes = computeDotRanges();
	const fpRefs = Object.fromEntries(mergedFpRefs());
	const feat = cells.map((row) =>
		row.map((cv) =>
			scanCellFeat(cv.getContext("2d").getImageData(0, 0, N, N).data, dotTypes),
		),
	);
	const { anchors, candMap } = scanGenCandidates(feat, rows, cols);
	const packed = scanPack(anchors, candMap, feat, rows, cols);
	const pieces = [];
	packed.assign.forEach((cand) => {
		if (!cand) return;
		const named = scanNamePiece(cand, feat, fpRefs);
		const piece = {
			...named,
			quality: cand.quality,
			shape: cand.shape.key,
			shapeMat: cand.shape.mat,
			cells: cand.cells,
			anchor: cand.anchor,
			origin: cand.origin,
		};
		piece.thumb = scanPieceThumb(piece, cells);
		pieces.push(piece);
	});
	return pieces;
}

/** 判定：无歧义（唯一候选）/ 缺指纹 / 未命中 / 勉强（间隔不足）/ 可靠 */
function replayVerdict(p) {
	if (p.names.length <= 1) return { cls: "tag-muted", text: "无歧义" };
	if (!p.rank) return { cls: "tag-amb", text: "缺指纹" };
	const hit = p.rank[0];
	const second = p.rank[1];
	if (!hit || hit.diff > hit.maxDiff) return { cls: "tag-amb", text: "未命中" };
	const margin = second ? second.diff - hit.diff : Infinity;
	if (margin < REPLAY_MARGIN_OK) return { cls: "tag-warn", text: "勉强" };
	return { cls: "tag-ok", text: "可靠" };
}

function appendReplayRow(fileName, p) {
	const v = replayVerdict(p);
	replayStats.push(v.text);
	const hit = p.rank && p.rank[0];
	const second = p.rank && p.rank[1];
	const margin = hit && second ? second.diff - hit.diff : null;
	// 名录冲突组视图的 margin 健康度：按识别名记最差判定（间隔最小者优先）
	if (p.name && p.names.length > 1) {
		const prev = replayFpStats.get(p.name);
		const worse =
			!prev ||
			(margin == null ? -1 : margin) < (prev.margin == null ? -1 : prev.margin);
		if (worse) replayFpStats.set(p.name, { verdict: v.text, margin });
	}
	const tr = document.createElement("tr");
	const cells = [
		fileName,
		null, // 缩略图
		`(${p.anchor[0]},${p.anchor[1]})`,
		`${p.type || "?"} / ${p.shape} / ${QUALITY_NAMES[p.quality]}阶`,
		p.name || p.names.join("/") || "?",
		hit ? hit.diff.toFixed(1) : "—",
		second ? second.diff.toFixed(1) : "—",
		margin != null ? margin.toFixed(1) : "—",
	];
	cells.forEach((txt, ci) => {
		const td = document.createElement("td");
		if (ci === 1) {
			const img = document.createElement("img");
			img.src = p.thumb.toDataURL();
			td.appendChild(img);
		} else {
			td.textContent = txt;
		}
		tr.appendChild(td);
	});
	const tdV = document.createElement("td");
	const tag = document.createElement("span");
	tag.className = `tag ${v.cls}`;
	tag.textContent = v.text;
	tdV.appendChild(tag);
	tr.appendChild(tdV);
	els.replayTbody.appendChild(tr);
	els.replayWrap.hidden = false;
}

function appendReplayError(fileName, msg) {
	replayStats.push("失败");
	const tr = document.createElement("tr");
	const td = document.createElement("td");
	td.colSpan = 9;
	td.textContent = `${fileName}：${msg}`;
	td.style.color = "var(--color-red)";
	tr.appendChild(td);
	els.replayTbody.appendChild(tr);
	els.replayWrap.hidden = false;
}

function updateReplaySummary() {
	const cnt = (t) => replayStats.filter((s) => s === t).length;
	const pieces = replayStats.length - cnt("失败");
	const amb = cnt("可靠") + cnt("勉强") + cnt("未命中") + cnt("缺指纹");
	els.replayStatus.textContent =
		`回放完成：共 ${pieces} 件棋子；需指纹消歧 ${amb} 件 — ` +
		`可靠 ${cnt("可靠")} / 勉强 ${cnt("勉强")} / 未命中 ${cnt("未命中")} / 缺指纹 ${cnt("缺指纹")}` +
		(cnt("失败") ? `；${cnt("失败")} 张截图处理失败` : "");
	els.replayStatus.className =
		cnt("未命中") || cnt("缺指纹") || cnt("失败")
			? "status err"
			: cnt("勉强")
				? "status"
				: "status ok";
	renderGroupView(); // 冲突组视图的 margin 健康度联动
}

async function replayFiles(files) {
	const imgs = [...files].filter((f) => f.type.startsWith("image/"));
	if (!imgs.length) return;
	const pool = await fpPoolEnsure(() => {
		els.replayStatus.textContent = "并行 worker 启动失败，回退串行回放";
		els.replayStatus.className = "status";
	});
	if (pool) return replayFilesParallel(imgs);
	let cv;
	try {
		cv = await loadOpenCV();
	} catch {
		els.replayStatus.textContent = "OpenCV 加载失败，无法自动定位棋盘";
		els.replayStatus.className = "status err";
		return;
	}
	let done = 0;
	for (const f of imgs) {
		els.replayStatus.textContent = `回放中… ${done}/${imgs.length}（${f.name}）`;
		els.replayStatus.className = "status";
		// truth 配对：配对的图按其行列数切格并对照评分，未配对走纯识别回放
		const truth = bt.truths.get(f.name) || null;
		const rows = truth ? truth.rows : Number(els.replayRows.value) || 1;
		const cols = truth ? truth.cols : Number(els.replayCols.value) || 1;
		const img = await createImageBitmap(f);
		// 检测图：1:1 取像素后走共享双线性重采样（与 node bench 逐字节一致）
		const { imgData, scale } = scanMakeDetectImage(img, DETECT_WIDTH);
		const rect = scanDetectBoard(cv, imgData, cols, rows);
		let full = null; // 棋盘区域（原图坐标）
		let det; // bench run 同格式检测结果，供 scanScoreImage 评分
		if (!rect) {
			appendReplayError(f.name, "棋盘定位失败");
			det = { detectOk: false, pieces: [] };
		} else {
			full = {
				L: rect.L / scale,
				T: rect.T / scale,
				R: rect.R / scale,
				B: rect.B / scale,
			};
			const { cells } = scanSliceCells(img, full, rows, cols);
			const pieces = replayRecognize(cells, rows, cols);
			pieces.forEach((p) => appendReplayRow(f.name, p));
			det = {
				detectOk: true,
				pieces: pieces.map((p) => ({
					cells: p.cells,
					anchor: p.anchor,
					type: p.type || "",
					quality: p.quality + 1, // 内部 0-4 → truth 1-5
					name: p.name,
				})),
			};
		}
		if (truth) {
			const result = scanScoreImage(truth, det, f.name);
			bt.results.push(result);
			appendBtCard(f.name, img, full, rows, cols, result);
		}
		done++;
	}
	updateReplaySummary();
	renderBtPanels();
}

/**
 * 回放验证并行路径：识别全部在 worker（fp-worker.js op=replay，配置取当前输出
 * 快照），主线程保序后走与串行完全相同的渲染（appendReplayRow / appendReplayError）
 * 与评分（scanScoreImage / appendBtCard）代码，逐图结果与串行逐项一致。
 */
async function replayFilesParallel(imgs) {
	// 配置快照：识别口径同串行 replayRecognize（computeDotRanges / mergedFpRefs）
	const dotTypes = computeDotRanges();
	const fpRefs = Object.fromEntries(mergedFpRefs());
	const items = imgs.map((f) => {
		const truth = bt.truths.get(f.name) || null;
		return {
			f,
			truth,
			rows: truth ? truth.rows : Number(els.replayRows.value) || 1,
			cols: truth ? truth.cols : Number(els.replayCols.value) || 1,
		};
	});
	els.replayStatus.textContent = `回放中… 0/${imgs.length}（并行 ${FPPool.getSize()} 线程）`;
	els.replayStatus.className = "status";
	const results = await FPPool.map(
		"replay",
		items.map((it) => ({
			file: it.f,
			rows: it.rows,
			cols: it.cols,
			dotTypes,
			fpRefs,
		})),
		(done) => {
			els.replayStatus.textContent = `回放中… ${done}/${imgs.length}（并行 ${FPPool.getSize()} 线程）`;
		},
	);
	// 保序渲染与评分（顺序同串行逐图循环）
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		const res = results[i];
		let full = null; // 棋盘区域（原图坐标）
		let det; // bench run 同格式检测结果，供 scanScoreImage 评分
		if (!res.ok) {
			appendReplayError(it.f.name, res.error || "处理失败");
			det = { detectOk: false, pieces: [] };
		} else if (!res.result.detectOk) {
			appendReplayError(it.f.name, "棋盘定位失败");
			det = { detectOk: false, pieces: [] };
		} else {
			full = res.result.full;
			const pieces = res.result.pieces.map((p) => ({
				...p,
				thumb: fpThumbCanvas(p.thumbW, p.thumbH, p.thumbBuf),
			}));
			pieces.forEach((p) => appendReplayRow(it.f.name, p));
			det = {
				detectOk: true,
				pieces: pieces.map((p) => ({
					cells: p.cells,
					anchor: p.anchor,
					type: p.type || "",
					quality: p.quality + 1, // 内部 0-4 → truth 1-5
					name: p.name,
				})),
			};
		}
		if (it.truth) {
			const result = scanScoreImage(it.truth, det, it.f.name);
			bt.results.push(result);
			// 卡片缩略图需整图位图：仅配对 truth 的图在主线程补解码
			appendBtCard(
				it.f.name,
				await createImageBitmap(it.f),
				full,
				it.rows,
				it.cols,
				result,
			);
		}
	}
	updateReplaySummary();
	renderBtPanels();
}

/* 回测：评分可视化 */
/** 单图卡片：缩略图叠加棋盘网格与对错着色 + 指标行 + 格子钻取明细 */
function appendBtCard(fileName, img, full, rows, cols, result) {
	const rec = result.rec;
	// 格子分类与钻取明细："r,c" -> { cls, lines[] }
	const cellInfo = new Map();
	const put = (cells, cls, lines) => {
		cells.forEach(([r, c]) => {
			cellInfo.set(`${r},${c}`, { cls, lines });
		});
	};
	result.pairs.forEach(({ tp, dp, typeOk, qualOk, nameOk }) => {
		const ok = typeOk && qualOk && nameOk;
		put(tp.cells, ok ? "ok" : "wrong", [
			`${ok ? "配对正确" : "配对但有错"}（${tp.cells.length} 格棋子）`,
			`期望：${tp.type} q${tp.quality}「${tp.expNames.join("/") || "名录无匹配"}」`,
			`实际：${dp.type || "?"} q${dp.quality}「${dp.name || "(空)"}」`,
		]);
	});
	rec.missed.forEach((p) =>
		put(p.cells, "miss", [
			`漏检（${p.cells.length} 格棋子）`,
			`期望：${p.type} q${p.quality}`,
			"实际：未识别",
		]),
	);
	rec.falsePos.forEach((p) =>
		put(p.cells, "false", [
			`误检（${p.cells.length} 格棋子）`,
			"期望：无棋子",
			`实际：${p.type || "?"} q${p.quality}「${p.name || "(空)"}」`,
		]),
	);

	const card = document.createElement("div");
	card.className = "bt-card";
	// 缩略图：整图缩到 360px 宽内，叠加网格与着色
	const k = Math.min(1, 360 / img.width);
	const cvEl = document.createElement("canvas");
	cvEl.width = Math.round(img.width * k);
	cvEl.height = Math.round(img.height * k);
	const ctx = cvEl.getContext("2d");
	ctx.drawImage(img, 0, 0, cvEl.width, cvEl.height);
	const detail = document.createElement("div");
	detail.className = "bt-cell-detail";
	if (full) {
		const cw = ((full.R - full.L) / cols) * k;
		const ch = ((full.B - full.T) / rows) * k;
		// 先着色再画网格线，保证线不被盖住
		cellInfo.forEach((info, key) => {
			const [r, c] = key.split(",").map(Number);
			ctx.fillStyle = BT_COLORS[info.cls];
			ctx.fillRect(full.L * k + cw * c, full.T * k + ch * r, cw, ch);
		});
		ctx.lineWidth = 1;
		ctx.strokeStyle = "rgba(63, 174, 90, 0.8)";
		ctx.beginPath();
		for (let i = 0; i <= cols; i++) {
			ctx.moveTo(full.L * k + cw * i, full.T * k);
			ctx.lineTo(full.L * k + cw * i, full.B * k);
		}
		for (let i = 0; i <= rows; i++) {
			ctx.moveTo(full.L * k, full.T * k + ch * i);
			ctx.lineTo(full.R * k, full.T * k + ch * i);
		}
		ctx.stroke();
		// 点击格子钻取：显示期望 vs 实际明细
		cvEl.addEventListener("click", (e) => {
			const b = cvEl.getBoundingClientRect();
			const x = ((e.clientX - b.left) / b.width) * cvEl.width;
			const y = ((e.clientY - b.top) / b.height) * cvEl.height;
			const c = Math.floor((x - full.L * k) / cw);
			const r = Math.floor((y - full.T * k) / ch);
			if (r < 0 || r >= rows || c < 0 || c >= cols) return;
			const info = cellInfo.get(`${r},${c}`);
			detail.textContent = info
				? `(${r},${c}) ${info.lines.join("\n")}`
				: `(${r},${c}) 空格（truth 与识别均无棋子）`;
		});
	} else {
		detail.textContent = "棋盘定位失败，全图棋子计为漏检";
	}
	card.appendChild(cvEl);

	const meta = document.createElement("div");
	meta.className = "bt-meta";
	const title = document.createElement("div");
	title.innerHTML = `<b>${fileName}</b>`;
	meta.appendChild(title);
	// 指标行：列对齐 bench 控制台「每图指标」
	const pct = (v) =>
		v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
	const mt = document.createElement("table");
	mt.className = "bt-metrics";
	const head = [
		"定位",
		"配对/真实",
		"识别",
		"格召回",
		"type",
		"quality",
		"name判定",
		"name歧义",
	];
	const vals = [
		rec.detectOk ? "√" : "×",
		`${rec.matched}/${rec.truthPieces}`,
		rec.detPieces,
		pct(rec.cellRecall),
		pct(rec.typeAcc),
		pct(rec.qualAcc),
		pct(rec.nameJudAcc),
		pct(rec.nameAmbAcc),
	];
	const trh = document.createElement("tr");
	head.forEach((h) => {
		const th = document.createElement("th");
		th.textContent = h;
		trh.appendChild(th);
	});
	const trv = document.createElement("tr");
	vals.forEach((v) => {
		const td = document.createElement("td");
		td.textContent = v;
		trv.appendChild(td);
	});
	mt.appendChild(trh);
	mt.appendChild(trv);
	meta.appendChild(mt);
	const legend = document.createElement("div");
	legend.className = "bt-legend";
	[
		[BT_COLORS.ok, "配对且全对"],
		[BT_COLORS.wrong, "配对但有错"],
		[BT_COLORS.miss, "漏检"],
		[BT_COLORS.false, "误检"],
	].forEach(([color, label]) => {
		const s = document.createElement("span");
		s.innerHTML = `<i style="background:${color}"></i>${label}`;
		legend.appendChild(s);
	});
	meta.appendChild(legend);
	detail.textContent = detail.textContent || "点击格子查看期望 vs 实际明细";
	meta.appendChild(detail);
	card.appendChild(meta);
	els.btCards.appendChild(card);
}

/** 汇总 / 失败明细 / 回归对比三个区块的重渲染（每次回测结束后调用） */
function renderBtPanels() {
	if (!bt.results.length) return;
	const pct = (v) =>
		v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
	const { summary, sum } = scanScoreSummary(bt.results);

	// 顶部汇总：字段与 bench summary 一致（文案对齐 bench 控制台「汇总」）
	els.btSummary.innerHTML =
		`<b>汇总（${summary.images} 张图）</b><pre>` +
		`棋盘定位成功：${summary.detectOk}/${summary.images}\n` +
		`格子召回率：${pct(summary.cellRecall)}（${sum.coveredCells}/${sum.truthCells}）\n` +
		`棋子配对率：${pct(summary.pieceMatch)}（${summary.matchedPieces}/${summary.truthPieces}），识别总件数 ${summary.detPieces}\n` +
		`配对棋子 type 正确率：${pct(summary.typeAcc)}（${sum.typeOk}/${sum.matched}）\n` +
		`配对棋子 quality 正确率：${pct(summary.qualAcc)}（${sum.qualOk}/${sum.matched}）\n` +
		`配对棋子 name 正确率（可判定）：${pct(summary.nameJudAcc)}（${sum.nameJudOk}/${sum.nameJud}）\n` +
		`配对棋子 name 正确率（歧义组）：${pct(summary.nameAmbAcc)}（${sum.nameAmbOk}/${sum.nameAmb}）` +
		`</pre>`;
	els.btSummary.hidden = false;

	// 失败明细：对齐 bench 控制台「失败明细」格式
	const lines = [];
	bt.results.forEach(({ rec: r }) => {
		if (
			!r.missed.length &&
			!r.falsePos.length &&
			!r.wrongType.length &&
			!r.wrongQual.length &&
			!r.wrongName.length
		) {
			return;
		}
		lines.push(`\n[${r.file}]`);
		r.missed.forEach((p) =>
			lines.push(`  漏检 ${p.type} q${p.quality} ${JSON.stringify(p.cells)}`),
		);
		r.falsePos.forEach((p) =>
			lines.push(
				`  误检 ${p.type || "?"} q${p.quality} 「${p.name || ""}」 ${JSON.stringify(p.cells)}`,
			),
		);
		r.wrongType.forEach((s) => lines.push(`  type 错：${s}`));
		r.wrongQual.forEach((s) => lines.push(`  quality 错：${s}`));
		r.wrongName.forEach((s) => lines.push(`  name 错：${s}`));
	});
	els.btFailures.innerHTML = `<b>失败明细</b><pre>${lines.length ? lines.join("\n") : "（无）"}</pre>`;
	els.btFailures.hidden = false;

	renderBtCompare(summary);
}

/** 回归对比：历史 report.json 汇总 vs 本次汇总，指标下降的项标红 */
function renderBtCompare(summary) {
	if (!bt.report || !bt.report.summary) return;
	const old = bt.report.summary;
	const pct = (v) =>
		v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
	// [指标名, 历史值(0-1 比率或计数), 本次值, 是否比率]
	const rowsDef = [
		[
			"棋盘定位",
			old.images ? old.detectOk / old.images : null,
			summary.images ? summary.detectOk / summary.images : null,
			true,
			`${old.detectOk}/${old.images}`,
			`${summary.detectOk}/${summary.images}`,
		],
		["格子召回率", old.cellRecall, summary.cellRecall, true],
		["棋子配对率", old.pieceMatch, summary.pieceMatch, true],
		["type 正确率", old.typeAcc, summary.typeAcc, true],
		["quality 正确率", old.qualAcc, summary.qualAcc, true],
		["name 正确率（可判定）", old.nameJudAcc, summary.nameJudAcc, true],
		["name 正确率（歧义组）", old.nameAmbAcc, summary.nameAmbAcc, true],
	];
	const tbl = document.createElement("table");
	tbl.className = "bt-metrics";
	const trh = document.createElement("tr");
	["指标", "历史", "本次", "Δ"].forEach((h) => {
		const th = document.createElement("th");
		th.textContent = h;
		trh.appendChild(th);
	});
	tbl.appendChild(trh);
	let regressCnt = 0;
	rowsDef.forEach(([label, ov, nv, isPct, oTxt, nTxt]) => {
		const tr = document.createElement("tr");
		const worse =
			ov !== null &&
			ov !== undefined &&
			nv !== null &&
			nv !== undefined &&
			nv < ov - 1e-9;
		if (worse) regressCnt++;
		[
			label,
			oTxt || pct(ov),
			nTxt || pct(nv),
			ov == null || nv == null
				? "-"
				: `${nv >= ov ? "+" : ""}${((nv - ov) * 100).toFixed(1)}pt`,
		].forEach((txt, ci) => {
			const td = document.createElement("td");
			td.textContent = txt;
			if (worse && ci >= 1) td.className = "bt-regress";
			tr.appendChild(td);
		});
		tbl.appendChild(tr);
	});
	els.btCompare.replaceChildren();
	const head = document.createElement("div");
	head.innerHTML =
		`<b>回归对比（vs 历史报告）</b> ` +
		(regressCnt
			? `<span class="bt-regress">${regressCnt} 项指标下降</span>`
			: `<span class="status ok">无指标下降</span>`);
	els.btCompare.appendChild(head);
	if (old.images !== summary.images) {
		const note = document.createElement("div");
		note.className = "status";
		note.textContent = `注意：历史报告 ${old.images} 张图，本次 ${summary.images} 张图，汇总口径不同，比率对比仅供参考`;
		els.btCompare.appendChild(note);
	}
	els.btCompare.appendChild(tbl);
	els.btCompare.hidden = false;
}

/* 回测：文件输入 */
// truth JSON（多选）：按 truth.file / 文件名（去 .json）与截图配对
els.btTruth.addEventListener("change", () => {
	const files = [...els.btTruth.files];
	els.btTruth.value = "";
	if (!files.length) return;
	let loaded = 0;
	let failed = 0;
	files.forEach((f) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const truth = JSON.parse(reader.result);
				const key = truth.file || f.name.replace(/\.json$/i, "");
				bt.truths.set(key, truth);
				loaded++;
			} catch {
				failed++;
			}
			els.btTruthStatus.textContent =
				`已载入 truth ${bt.truths.size} 份` +
				(failed ? `，${failed} 份解析失败` : "") +
				"；再选测试截图开始回测，未配对的图退化为纯识别回放";
			els.btTruthStatus.className = failed ? "status err" : "status ok";
		};
		reader.readAsText(f);
	});
});

// 历史 report.json：载入后若已有本次汇总则立即渲染回归对比
els.btReport.addEventListener("change", () => {
	const f = els.btReport.files[0];
	els.btReport.value = "";
	if (!f) return;
	const reader = new FileReader();
	reader.onload = () => {
		try {
			bt.report = JSON.parse(reader.result);
			if (!bt.report.summary) throw new Error("缺少 summary");
			els.btTruthStatus.textContent = `已载入历史报告 ${f.name}（${bt.report.summary.images} 张图），回测后自动对比`;
			els.btTruthStatus.className = "status ok";
			if (bt.results.length) {
				renderBtCompare(scanScoreSummary(bt.results).summary);
			}
		} catch (e) {
			els.btTruthStatus.textContent = `历史报告解析失败：${e.message}`;
			els.btTruthStatus.className = "status err";
		}
	};
	reader.readAsText(f);
});

els.replayFile.addEventListener("change", () => {
	replayFiles(els.replayFile.files);
	els.replayFile.value = "";
});
els.replayClear.addEventListener("click", () => {
	replayStats.length = 0;
	replayFpStats.clear();
	bt.results.length = 0;
	els.replayTbody.replaceChildren();
	els.replayWrap.hidden = true;
	els.btCards.replaceChildren();
	els.btSummary.hidden = true;
	els.btFailures.hidden = true;
	els.btCompare.hidden = true;
	els.replayStatus.textContent = "尚未运行";
	els.replayStatus.className = "status";
	renderGroupView();
});

/* 元素校准 tab */
/**
 * 元素圆点色校准可视化：批量采样（锚点格 scanDiskHues 圆盘全像素采样，统计走
 * 与 node bench calib-dots 同一函数 scanCalibDots，簇分析自动产出两两零重叠建议
 * 区间）与弹窗手动累积样本双来源直方图；建议区间采用后经 computeDotRanges 反映到
 * 生效配置与输出，采用与保存均过 scanDotTypesValidate 交叠硬校验，重叠即拒绝。
 */
const DOT_TYPE_COLORS = {
	金: "#d4a017",
	木: "#4d8a52",
	水: "#3b64d8",
	火: "#e03c31",
	土: "#b87514",
	雷: "#8b5cf6",
	体: "#6b7280",
};
const dotColor = (t) => DOT_TYPE_COLORS[t] || "#9aa0a6";

/** 元素校准 tab 状态 */
const dc = {
	truths: new Map(), // 截图文件名 -> truth 对象
	imgs: [], // 已选测试截图 File[]
	items: null, // 采样确认清单 [{ f, name, img, truth（内存副本：锚点格锁死 truth，piece 上 _drop=舍弃此格 / dotOff=环心偏移（truth 已存 / 自动定位预置 / 手动拖环，确认采样后写回 truth 文件）/ _offSrc=偏移来源标记）, full, discarded（整图舍弃）, error, _cards }]
	skipped: [], // 批量采样跳过名单（舍弃 / 未配对 / 定位失败 / 异常）
	report: null, // scanCalibDots 分析结果 { types, ranges, warnings, suggest }
	cardObs: null, // 确认卡片懒绘制 IntersectionObserver（dcRenderConfirm 重建时复位）
	hoverH: null, // 直方图 hover 的 hue（null = 未 hover，mouseleave 复位）
	histHover: null, // renderDcHist 缓存的 hover 数据 { ranges, coverCnt, bins }
};

function dcStatus(text, cls) {
	els.dcStatus.textContent = text;
	els.dcStatus.className = `status${cls ? ` ${cls}` : ""}`;
}

function dcRefreshSampleBtn() {
	els.dcSample.disabled = !(dc.truths.size && dc.imgs.length);
}

// truth JSON（多选）：按 truth.file / 文件名（去 .json）与截图配对
els.dcTruth.addEventListener("change", () => {
	const files = [...els.dcTruth.files];
	els.dcTruth.value = "";
	if (!files.length) return;
	els.dcConfirm.hidden = true; // 素材变动，已展示的确认清单作废
	let failed = 0;
	files.forEach((f) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const truth = JSON.parse(reader.result);
				const key = truth.file || f.name.replace(/\.json$/i, "");
				dc.truths.set(key, truth);
			} catch {
				failed++;
			}
			dcStatus(
				`已载入 truth ${dc.truths.size} 份` +
					(failed ? `，${failed} 份解析失败` : "") +
					"；再选测试截图后点「批量采样」",
				failed ? "err" : "",
			);
			dcRefreshSampleBtn();
		};
		reader.readAsText(f);
	});
});

els.dcImg.addEventListener("change", () => {
	dc.imgs = [...els.dcImg.files].filter((f) => f.type.startsWith("image/"));
	els.dcImg.value = "";
	els.dcConfirm.hidden = true; // 素材变动，已展示的确认清单作废
	if (dc.imgs.length) {
		dcStatus(
			`已选截图 ${dc.imgs.length} 张（已载 truth ${dc.truths.size} 份），点「批量采样」开始`,
		);
	}
	dcRefreshSampleBtn();
});

/** 采样素材确认（可视化）：先跑棋盘定位（优先 worker 池并行），再按元素类别把
 *  truth 锚点格一格一卡列出——卡片图 = 锚点格切图，采样圆盘（scanDiskHues 逐像素
 *  圆盘，即实际采样范围，比例同 SCAN_REC dotCX/dotCY/dotR）画在格图上可拖动调圆心
 *  （dotOff）；圆心偏移预置优先级：truth 已存 > scanLocateDot 自动修正。确认后才真正
 *  采样，完成后 dotOff 写回 truth 文件（dcWriteBackOffsets）；其余调整只改内存副本。
 *  素材变动时各输入 handler 隐藏本区块，防陈旧确认 */
async function dcShowConfirm() {
	if (!dc.truths.size || !dc.imgs.length) return;
	const pool = await fpPoolEnsure(() =>
		dcStatus("并行 worker 启动失败，回退串行定位"),
	);
	els.dcSample.disabled = true;
	els.dcConfirm.hidden = true;
	// 旧清单的 ImageBitmap 释放后重建
	(dc.items || []).forEach((it) => it.img && it.img.close());
	dc.items = [];
	if (pool) await dcLocateParallel(); // 锚点格定位由 op=locate 在 worker 内顺带完成
	else {
		await dcLocateSerial();
		// 串行回退：主线程补跑锚点格定位（truth 未存偏移的格；规模卡顿时建议用 worker 池）
		dc.items.forEach(dcAutoLocate);
	}
	els.dcSample.disabled = false;
	const okCnt = dc.items.filter((it) => !it.error).length;
	const autoCnt = dc.items.reduce(
		(s, it) =>
			s + (it.truth?.pieces || []).filter((p) => p._offSrc === "auto").length,
		0,
	);
	dcStatus(
		`素材定位完成：${okCnt}/${dc.items.length} 张可用` +
			(autoCnt ? `，自动定位修正 ${autoCnt} 格采样环` : "") +
			`，请在下方确认后采样`,
		okCnt ? "" : "err",
	);
	dcRenderConfirm();
}

/** 单锚点格定位结果应用（串行 dcAutoLocate / 并行 op=locate 顺带结果共用口径）：
 *  truth 已存偏移（_offSrc="truth"，人工确认值）不覆盖；fromLocate 才写 dotOff
 *  并标 _offSrc="auto"；实测外缘 rEdge 更新展示圈 */
function dcApplyLocate(p, loc) {
	if (!loc || p._offSrc === "truth") return;
	const round3 = (v) => Math.round(v * 1000) / 1000;
	if (loc.fromLocate) {
		p.dotOff = [
			round3(loc.fx - SCAN_REC.dotCX),
			round3(loc.fy - SCAN_REC.dotCY),
		];
		p._offSrc = "auto";
	}
	if (loc.ok && loc.rEdge > 0) p._rEdge = loc.rEdge; // 实测徽标外缘（px），展示圈
}

/** 徽标几何定位预置（scanLocateDot）：逐锚点格跑边缘域同心双圆定位。**仅串行回退
 *  路径用**——并行路径由 op=locate 在 worker 内顺带完成。truth 已存 dotOff 的格跳过
 *  （不覆盖）。环心偏移预置优先级（_offSrc 溯源标记，下划线字段不序列化）：
 *  truth 已存 > 本次自动定位 > 规范位缺省；手动拖环标 "manual"。定位仅作展示先验，
 *  采样时按 truth 副本 dotOff 重采，两路径一致 */
function dcAutoLocate(item) {
	if (item.error) return;
	const { L, T, R, B } = item.full;
	const cw = (R - L) / item.truth.cols;
	const ch = (B - T) / item.truth.rows;
	const cv = document.createElement("canvas");
	cv.width = cv.height = N;
	const ctx = cv.getContext("2d");
	(item.truth.pieces || []).forEach((p) => {
		if (p._offSrc === "truth") return; // truth 已存偏移：整格跳过
		ctx.drawImage(
			item.img,
			L + p.anchor[1] * cw,
			T + p.anchor[0] * ch,
			cw,
			ch,
			0,
			0,
			N,
			N,
		);
		dcApplyLocate(p, scanLocateDot(ctx.getImageData(0, 0, N, N).data));
	});
}

/** 确认清单条目（定位成功）：img 主线程解码（串行路径可传入定位时已解码的
 *  bitmap 复用，所有权移交清单），truth 为内存副本（舍弃 / 拖环调整只作用副本）；
 *  truth 已存 dotOff 的锚点格标 _offSrc="truth"（人工确认值，自动定位不覆盖、
 *  也不再重复跑定位）。返回新建的条目 */
async function dcPushItem(f, truth, full, img) {
	const item = {
		f,
		name: f.name,
		img: img || (await createImageBitmap(f)),
		truth: JSON.parse(JSON.stringify(truth)), // 调整只作用内存副本
		full,
		discarded: false,
	};
	(item.truth.pieces || []).forEach((p) => {
		if (p.dotOff) p._offSrc = "truth";
	});
	dc.items.push(item);
	return item;
}

/** 定位并行路径：worker 池 op=locate（fp-worker.js：棋盘框 + truth 未存偏移的
 *  锚点格 scanLocateDot 一次解码顺带完成），主线程保序重建清单、解码
 *  ImageBitmap（卡片绘制 / 串行采样复用）并应用锚点定位结果（dcApplyLocate） */
async function dcLocateParallel() {
	const entries = dc.imgs.map((f) => ({
		f,
		truth: dc.truths.get(f.name) || null,
	}));
	const todo = entries.filter((en) => en.truth);
	const results = await FPPool.map(
		"locate",
		todo.map((en) => {
			// truth 已存 dotOff 的锚点格不再重复定位（预置优先级 truth > 自动）；
			// 其余锚点格随本次棋盘定位顺带 scanLocateDot（locs 与 anchors 下标对齐）
			en._locPieces = [];
			(en.truth.pieces || []).forEach((p, pi) => {
				if (!p.dotOff) en._locPieces.push(pi);
			});
			return {
				file: en.f,
				cols: en.truth.cols,
				rows: en.truth.rows,
				anchors: en._locPieces.map((pi) => en.truth.pieces[pi].anchor),
			};
		}),
		(done) =>
			dcStatus(
				`素材定位中… ${done}/${todo.length}（并行 ${FPPool.getSize()} 线程）`,
			),
	);
	// 保序重建（顺序同 dc.imgs；按下标配对，同名文件不串）
	const resOf = new Map(todo.map((en, i) => [en, results[i]]));
	let done = 0;
	for (const en of entries) {
		if (!en.truth) {
			dc.items.push({ f: en.f, name: en.f.name, error: "无配对 truth" });
			continue;
		}
		dcStatus(`素材解码中… ${done}/${todo.length}（${en.f.name}）`);
		done++;
		const res = resOf.get(en);
		if (!res.ok) {
			dc.items.push({ f: en.f, name: en.f.name, error: `异常：${res.error}` });
			continue;
		}
		if (!res.result.detectOk) {
			dc.items.push({ f: en.f, name: en.f.name, error: "棋盘定位失败" });
			continue;
		}
		try {
			const item = await dcPushItem(en.f, en.truth, res.result.full);
			// op=locate 顺带完成的锚点格定位结果应用（与 dcAutoLocate 同口径）
			(en._locPieces || []).forEach((pi, k) => {
				dcApplyLocate(
					item.truth.pieces[pi],
					res.result.locs && res.result.locs[k],
				);
			});
		} catch (e) {
			dc.items.push({ f: en.f, name: en.f.name, error: `异常：${e.message}` });
		}
	}
}

/** 定位串行回退：主线程 OpenCV 逐图定位（与并行同口径，检测走 scan-core.js
 *  共享实现，与 node bench / 采样 worker 逐字节一致） */
async function dcLocateSerial() {
	let cv;
	try {
		cv = await loadOpenCV();
	} catch {
		dcStatus("OpenCV 加载失败，无法自动定位棋盘", "err");
		return;
	}
	let done = 0;
	for (const f of dc.imgs) {
		dcStatus(`素材定位中… ${done}/${dc.imgs.length}（${f.name}）`);
		const truth = dc.truths.get(f.name) || null;
		if (!truth) {
			dc.items.push({ f, name: f.name, error: "无配对 truth" });
			done++;
			continue;
		}
		try {
			const img = await createImageBitmap(f);
			const { imgData, scale } = scanMakeDetectImage(img, DETECT_WIDTH);
			const rect = scanDetectBoard(cv, imgData, truth.cols, truth.rows);
			if (!rect) {
				img.close();
				dc.items.push({ f, name: f.name, error: "棋盘定位失败" });
				done++;
				continue;
			}
			await dcPushItem(f, truth, {
				L: rect.L / scale,
				T: rect.T / scale,
				R: rect.R / scale,
				B: rect.B / scale,
			}, img);
		} catch (e) {
			dc.items.push({ f, name: f.name, error: `异常：${e.message}` });
		}
		done++;
	}
}

/** 卡片懒绘制观察器复位（确认清单重建前调用）：进入视口（含 200px 预取边距）
 *  的卡片补画格图（visible/needsDraw 标记见 dcBuildCard / dcRedrawCard） */
function dcObserveCardsReset() {
	if (dc.cardObs) dc.cardObs.disconnect();
	if (!window.IntersectionObserver) {
		dc.cardObs = null;
		return;
	}
	dc.cardObs = new IntersectionObserver(
		(list) => {
			list.forEach((en) => {
				const card = en.target._dcCard;
				if (!card) return;
				card.visible = en.isIntersecting;
				if (card.visible && card.needsDraw) dcRedrawCard(card);
			});
		},
		{ rootMargin: "200px" },
	);
}

/** 确认清单渲染：一格一卡（truth 锚点格切图 + 采样环），按锚点类型分组
 *  （DOT_TYPE_COLORS 序）；类型缺失 / 不可识别的锚点进「未分类」组，可在
 *  卡片操作栏手动分类；无法采样的图（无 truth / 定位失败 / 无锚点）单列一节 */
function dcRenderConfirm() {
	const items = dc.items || [];
	items.forEach((it) => (it._cards = []));
	els.dcConfirmList.replaceChildren();
	dcObserveCardsReset(); // 旧卡片观察器复位（节点随 replaceChildren 废弃）
	const bad = []; // { item, why }
	const byType = new Map(); // 类型 -> [{ item, pi }]
	const uncls = []; // 未分类 [{ item, pi }]
	items.forEach((it) => {
		if (it.error) {
			bad.push({ item: it, why: it.error });
			return;
		}
		const pieces = it.truth.pieces || [];
		if (!pieces.length) {
			bad.push({ item: it, why: "无锚点（truth pieces 为空）" });
			return;
		}
		pieces.forEach((p, pi) => {
			if (DOT_TYPE_COLORS[p.type]) {
				if (!byType.has(p.type)) byType.set(p.type, []);
				byType.get(p.type).push({ item: it, pi });
			} else {
				uncls.push({ item: it, pi });
			}
		});
	});
	const order = Object.keys(DOT_TYPE_COLORS);
	const types = [...byType.keys()].sort(
		(a, b) => order.indexOf(a) - order.indexOf(b),
	);
	types.forEach((t) => {
		const list = byType.get(t);
		const head = document.createElement("div");
		head.className = "gx-grp-head";
		head.style.color = dotColor(t);
		head.textContent = `${t} · ${list.length} 格 / ${new Set(list.map((x) => x.item)).size} 张图`;
		const box = document.createElement("div");
		list.forEach(({ item, pi }) => box.appendChild(dcBuildCard(item, pi)));
		els.dcConfirmList.append(head, box);
	});
	if (uncls.length) {
		const head = document.createElement("div");
		head.className = "gx-grp-head";
		head.textContent = `未分类 · ${uncls.length} 格（请在卡片操作栏手动分类，未分类锚点采样时跳过）`;
		const box = document.createElement("div");
		uncls.forEach(({ item, pi }) => box.appendChild(dcBuildCard(item, pi)));
		els.dcConfirmList.append(head, box);
	}
	if (bad.length) {
		const head = document.createElement("div");
		head.className = "gx-grp-head";
		head.textContent = `无法采样 · ${bad.length} 张（采样时自动跳过）`;
		const box = document.createElement("div");
		bad.forEach(({ item, why }) => {
			const card = document.createElement("div");
			card.className = "gx-card";
			const lab = document.createElement("div");
			lab.className = "gx-src";
			lab.textContent = item.name;
			const whyEl = document.createElement("div");
			whyEl.className = "status err";
			whyEl.textContent = why;
			card.append(lab, whyEl);
			box.appendChild(card);
		});
		els.dcConfirmList.append(head, box);
	}
	dcUpdateConfirmStatus();
	els.dcConfirm.hidden = false;
	els.dcConfirm.scrollIntoView({ block: "nearest" });
}

/** 确认状态行 + 确认按钮可用性（舍弃 / 分类变动后同步；粒度 = 锚点格） */
function dcUpdateConfirmStatus() {
	const items = dc.items || [];
	let total = 0;
	let kept = 0;
	let dropped = 0;
	let uncls = 0;
	let auto = 0;
	let truthOff = 0;
	let manual = 0;
	let badImg = 0;
	items.forEach((it) => {
		if (it.error) {
			badImg++;
			return;
		}
		const pieces = it.truth.pieces || [];
		if (!pieces.length) {
			badImg++;
			return;
		}
		pieces.forEach((p) => {
			total++;
			if (p._offSrc === "auto") auto++;
			else if (p._offSrc === "truth") truthOff++;
			else if (p._offSrc === "manual") manual++;
			if (it.discarded || p._drop) dropped++;
			else if (!DOT_TYPE_COLORS[p.type]) uncls++;
			else kept++;
		});
	});
	els.dcConfirmStatus.textContent =
		`共 ${items.length} 张图 / ${total} 个锚点格：待采样 ${kept} 格` +
		(auto ? `，自动定位 ${auto} 格` : "") +
		(truthOff ? `，truth 偏移 ${truthOff} 格` : "") +
		(manual ? `，手动调环 ${manual} 格` : "") +
		(dropped ? `，已舍弃 ${dropped} 格` : "") +
		(uncls ? `，未分类 ${uncls} 格（将跳过）` : "") +
		(badImg ? `，${badImg} 张无法采样` : "");
	els.dcConfirmGo.disabled = !kept;
}

/** 单格确认卡片：锚点格切图（采样环 + 16 采样点，拖动调环心）+ 来源标注 +
 *  操作栏（类型分类按钮 / 舍弃此格 / 舍弃整图）；环心偏移来源（_offSrc：
 *  truth 已存 / 手动调环 / 缺省一律自动定位）在 dcRedrawCard 同步进标签。
 *  格图懒绘制：画布尺寸先占位保证布局稳定，绘制推迟到进入视口（dc.cardObs） */
function dcBuildCard(item, pi) {
	const p = item.truth.pieces[pi];
	const wrap = document.createElement("div");
	wrap.className = "gx-card dc-card";
	const canvas = document.createElement("canvas");
	// 画布尺寸占位（与 dcRedrawCard 绘制时同口径）
	const { L, T, R, B } = item.full;
	const cw = (R - L) / item.truth.cols;
	const ch = (B - T) / item.truth.rows;
	canvas.width = Math.max(1, Math.round(cw));
	canvas.height = Math.max(1, Math.round(ch));
	const lab = document.createElement("div");
	lab.className = "gx-src";
	const card = {
		item,
		pi,
		canvas,
		wrap,
		lab,
		typeBtns: [],
		visible: !window.IntersectionObserver, // 观察器不可用时退化为立即绘制
		needsDraw: true,
	};
	wrap._dcCard = card; // 懒绘制观察器回查
	canvas.addEventListener("pointerdown", (e) => dcRingDragStart(e, card));
	const bar = document.createElement("div");
	bar.className = "dc-bar";
	Object.keys(DOT_TYPE_COLORS).forEach((t) => {
		const btn = document.createElement("button");
		btn.className = "dc-type";
		btn.textContent = t;
		btn.style.color = dotColor(t);
		btn.title = `归为「${t}」`;
		btn.addEventListener("click", () => {
			p.type = t;
			dcRenderConfirm(); // 分组变化，整表重建
		});
		card.typeBtns.push(btn);
		bar.appendChild(btn);
	});
	card.dropBtn = document.createElement("button");
	card.dropBtn.addEventListener("click", () => {
		p._drop = !p._drop;
		dcRedrawCard(card);
		dcUpdateConfirmStatus();
	});
	card.imgBtn = document.createElement("button");
	card.imgBtn.addEventListener("click", () => {
		item.discarded = !item.discarded;
		item._cards.forEach(dcRedrawCard);
		dcUpdateConfirmStatus();
	});
	bar.append(card.dropBtn, card.imgBtn);
	wrap.append(canvas, lab, bar);
	item._cards.push(card);
	if (dc.cardObs) dc.cardObs.observe(wrap); // 懒绘制：进入视口才画格图
	dcRedrawCard(card); // 标签 / 按钮态同步（格图仅可见时绘制）
	return wrap;
}

/** 卡片重画：轻量同步（舍弃置灰 / 按钮文案 / 分类高亮 / 来源标注）任意时刻执行；
 *  格图绘制仅卡片可见时执行——清单规模千级卡片，全量同步绘制会卡顿，不可见卡片
 *  标 needsDraw，待 IntersectionObserver 进入视口补画 */
function dcRedrawCard(card) {
	const { item, pi, canvas, wrap } = card;
	const p = item.truth.pieces[pi];
	wrap.classList.toggle("excluded", !!(item.discarded || p._drop));
	card.dropBtn.textContent = p._drop ? "恢复此格" : "舍弃此格";
	card.imgBtn.textContent = item.discarded ? "恢复整图" : "舍弃整图";
	card.typeBtns.forEach((btn) =>
		btn.classList.toggle("on", btn.textContent === p.type),
	);
	// 环心偏移来源标注（_offSrc 溯源标记；确认采样后 dotOff 写回 truth）：
	// 缺省（规范位 / 自动定位未产生修正）一律标「自动定位」
	card.lab.textContent =
		`${item.name} [${p.anchor}]${p.name ? ` ${p.name}` : ""}` +
		(p._offSrc === "truth"
			? "（文件偏移）"
			: p._offSrc === "manual"
				? "（手动调环）"
				: "（自动定位）");
	if (!card.visible) {
		card.needsDraw = true;
		return;
	}
	card.needsDraw = false;
	const { L, T, R, B } = item.full;
	const cw = (R - L) / item.truth.cols;
	const ch = (B - T) / item.truth.rows;
	const w = Math.max(1, Math.round(cw));
	const h = Math.max(1, Math.round(ch));
	if (canvas.width !== w) canvas.width = w;
	if (canvas.height !== h) canvas.height = h;
	const ctx = canvas.getContext("2d");
	ctx.drawImage(
		item.img,
		L + p.anchor[1] * cw,
		T + p.anchor[0] * ch,
		cw,
		ch,
		0,
		0,
		w,
		h,
	);
	const off = p.dotOff || [0, 0];
	const sR = p.dotR || SCAN_REC.dotR; // piece 级半径覆盖（保留入口），缺省规范位
	const cx = (SCAN_REC.dotCX + off[0]) * w;
	const cy = (SCAN_REC.dotCY + off[1]) * h;
	const rx = sR * w;
	const ry = sR * h;
	// 实测徽标外缘圈（scanLocateDot 环带量测，随徽标实际大小逐格自适应）：
	// 蓝圈供对照"识别到的徽标范围"，白圈才是实际采样圆盘边界
	if (p._rEdge > 0) {
		ctx.beginPath();
		ctx.ellipse(cx, cy, (p._rEdge / N) * w, (p._rEdge / N) * h, 0, 0, 2 * Math.PI);
		ctx.strokeStyle = "rgba(0,0,0,0.7)";
		ctx.lineWidth = Math.max(2, w * 0.03);
		ctx.stroke();
		ctx.strokeStyle = "#4d9fff";
		ctx.lineWidth = Math.max(1, w * 0.015);
		ctx.stroke();
	}
	// 采样圆盘边界（scanDiskHues 逐像素采样范围，2026-08-07 Step 4 起；
	// 旧 16 点环点位标记已随环采样退役一并移除）
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
	ctx.strokeStyle = "rgba(0,0,0,0.85)";
	ctx.lineWidth = Math.max(2.5, w * 0.045);
	ctx.stroke();
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = Math.max(1, w * 0.018);
	ctx.stroke();
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(cx - 4, cy);
	ctx.lineTo(cx + 4, cy);
	ctx.moveTo(cx, cy - 4);
	ctx.lineTo(cx, cy + 4);
	ctx.stroke();
}

/** 格图拖动调采样圆心：指针位置 → 格内比例坐标（圆心限制在格内、圆盘不越界），
 *  存为相对规范位的 dotOff（千分位取整）；按下即跟随，抬起结束 */
function dcRingDragStart(e, card) {
	const { item, pi, canvas } = card;
	const p = item.truth.pieces[pi];
	if (item.discarded || p._drop) return;
	e.preventDefault();
	const sR = p.dotR || SCAN_REC.dotR; // 圆心限制：采样圆盘不越界（半径保留 piece 级覆盖入口）
	const move = (ev) => {
		const box = canvas.getBoundingClientRect();
		const fx = Math.min(
			1 - sR,
			Math.max(sR, (ev.clientX - box.left) / box.width),
		);
		const fy = Math.min(
			1 - sR,
			Math.max(sR, (ev.clientY - box.top) / box.height),
		);
		p.dotOff = [
			Math.round((fx - SCAN_REC.dotCX) * 1000) / 1000,
			Math.round((fy - SCAN_REC.dotCY) * 1000) / 1000,
		];
		p._offSrc = "manual"; // 溯源标记：手动调环（覆盖 truth / 自动定位预置）
		dcRedrawCard(card);
	};
	const up = () => {
		canvas.removeEventListener("pointermove", move);
		canvas.removeEventListener("pointerup", up);
		canvas.removeEventListener("pointercancel", up);
	};
	canvas.addEventListener("pointermove", move);
	canvas.addEventListener("pointerup", up);
	canvas.addEventListener("pointercancel", up);
	move(e);
}

els.dcSample.addEventListener("click", dcShowConfirm);
els.dcConfirmGo.addEventListener("click", () => {
	els.dcConfirm.hidden = true;
	dcRunBatch();
});
els.dcConfirmCancel.addEventListener("click", () => {
	els.dcConfirm.hidden = true;
});

/** 确认采样完成后把锚点环心偏移写回 truth（2026-08-07 起偏移持久化：溯源 + 免次次
 *  重调）。仅「本次实际参与采样」且有新增/变化的格写回，舍弃格不动（也不删已有值）；
 *  图库来源直接写 truth/<图名>.json 并联动图库表格 + 同步 dc.truths；非图库来源无法
 *  静默落盘，状态行报数提示。序列化白名单与 annSerialize 同字段 + piece 级 dotOff。
 *  返回 { written, skipped:[] } */
async function dcWriteBackOffsets(items) {
	const sameOff = (a, b) =>
		!a && !b ? true : !!(a && b && a[0] === b[0] && a[1] === b[1]);
	const changed = []; // { name, truth（合并 dotOff 后的完整对象） }
	items.forEach((it) => {
		if (it.error || it.discarded) return;
		const orig = dc.truths.get(it.name);
		if (!orig) return;
		const next = JSON.parse(JSON.stringify(orig));
		let dirty = false;
		(next.pieces || []).forEach((np) => {
			const cp = (it.truth.pieces || []).find(
				(x) => x.anchor[0] === np.anchor[0] && x.anchor[1] === np.anchor[1],
			);
			if (!cp || cp._drop || !DOT_TYPE_COLORS[cp.type]) return; // 未参与采样
			if (cp.dotOff && !sameOff(cp.dotOff, np.dotOff)) {
				np.dotOff = [...cp.dotOff];
				dirty = true;
			}
		});
		if (dirty) changed.push({ name: it.name, truth: next });
	});
	if (!changed.length) return { written: 0, skipped: [] };
	const canGal = !!(gal.dir && (await galEnsurePerm()));
	const written = [];
	const skipped = [];
	for (const { name, truth } of changed) {
		const rec = gal.records.find((r) => r.name === name);
		if (canGal && rec) {
			try {
				const truthDir = await gal.dir.getDirectoryHandle("truth", {
					create: true,
				});
				const fh = await truthDir.getFileHandle(`${name}.json`, {
					create: true,
				});
				const w = await fh.createWritable();
				await w.write(JSON.stringify(truth, null, 2));
				await w.close();
				galUpdateRecord(name, truth);
				dc.truths.set(name, truth); // 内存原值同步，下次确认页从最新 truth 拷贝
				written.push(name);
				continue;
			} catch (e) {
				console.warn(`truth 写回失败：${name}`, e);
			}
		}
		skipped.push(name);
	}
	if (skipped.length) console.warn("dotOff 未落盘（非图库来源）：", skipped);
	return { written: written.length, skipped };
}

/** 批量采样：与 bench calib-dots 同一流程（切格 → 锚点格 scanDiskHues 圆盘全像素
 *  采样分桶，2026-08-07 Step 4 起；此前为 scanDotHues 16 点环）。素材取自确认清单：
 *  舍弃 / 定位失败 / 未分类的跳过，dotOff 透传采样；串行路径复用确认阶段定位结果
 *  切格；完成后 dotOff 写回 truth（dcWriteBackOffsets） */
async function dcRunBatch() {
	const items = (dc.items || []).filter((it) => !it.error && !it.discarded);
	if (!items.length) {
		dcStatus("没有可采样的素材（全部舍弃或定位失败）", "err");
		return;
	}
	const pool = await fpPoolEnsure(() =>
		dcStatus("并行 worker 启动失败，回退串行采样"),
	);
	if (pool) return dcRunBatchParallel(items);
	els.dcSample.disabled = true;
	const buckets = {};
	dc.skipped = (dc.items || [])
		.filter((it) => it.error || it.discarded)
		.map((it) => `${it.name}（${it.error || "已舍弃"}）`);
	let done = 0;
	for (const it of items) {
		dcStatus(`采样中… ${done}/${items.length}（${it.name}）`);
		try {
			const { cells } = scanSliceCells(
				it.img,
				it.full,
				it.truth.rows,
				it.truth.cols,
			);
			it.truth.pieces.forEach((p) => {
				if (p._drop || !DOT_TYPE_COLORS[p.type]) return; // 舍弃此格 / 未分类
				const [r, c] = p.anchor;
				const data = cells[r][c].getContext("2d").getImageData(0, 0, N, N).data;
				const off = p.dotOff || [0, 0];
				const hues = sampleDiskHues(data, off[0], off[1], p.dotR || 0);
				const b = (buckets[p.type] = buckets[p.type] || {
					cells: 0,
					empty: 0,
					hues: [],
				});
				b.cells++;
				if (!hues.length) b.empty++;
				b.hues.push(...hues);
			});
		} catch (e) {
			dc.skipped.push(`${it.name}（异常：${e.message}）`);
		}
		done++;
	}
	dc.report = scanCalibDots(buckets);
	els.dcSample.disabled = false;
	const cells = Object.values(dc.report.types).reduce((s, r) => s + r.cells, 0);
	const wb = await dcWriteBackOffsets(items);
	dcStatus(
		`采样完成：${items.length}/${(dc.items || []).length} 张图，共 ${cells} 个锚点格` +
			(dc.skipped.length ? `；跳过 ${dc.skipped.length} 张` : "") +
			(wb.written ? `；环心偏移已写回 truth ${wb.written} 份` : "") +
			(wb.skipped.length
				? `；${wb.skipped.length} 份偏移更新未落盘（非图库来源）`
				: ""),
		dc.skipped.length ? "" : "ok",
	);
	renderDcAll();
}

/**
 * 元素校准批量采样并行路径：切格 / 锚点格 scanDiskHues 在 worker（op=dotSample，
 * 按确定性定位复跑，结果与确认阶段一致），主线程保序累积分桶，统计仍走共享的
 * scanCalibDots。payload 的 truth 为确认清单调整后的内存副本（已剔除未分类锚点；
 * worker 侧按 _drop 跳过、按 dotOff 透传，两路径口径一致）。
 */
async function dcRunBatchParallel(items) {
	els.dcSample.disabled = true;
	const buckets = {};
	dc.skipped = (dc.items || [])
		.filter((it) => it.error || it.discarded)
		.map((it) => `${it.name}（${it.error || "已舍弃"}）`);
	const results = await FPPool.map(
		"dotSample",
		items.map((it) => ({
			file: it.f,
			truth: {
				...it.truth,
				pieces: it.truth.pieces.filter((p) => DOT_TYPE_COLORS[p.type]),
			},
		})),
		(done) =>
			dcStatus(
				`采样中… ${done}/${items.length}（并行 ${FPPool.getSize()} 线程）`,
			),
	);
	// 保序累积（顺序同串行逐图循环；按下标配对，同名文件不串）
	items.forEach((it, i) => {
		const res = results[i];
		if (!res.ok) {
			dc.skipped.push(`${it.name}（异常：${res.error}）`);
			return;
		}
		if (!res.result.detectOk) {
			dc.skipped.push(`${it.name}（棋盘定位失败）`);
			return;
		}
		res.result.samples.forEach(({ type, hues }) => {
			const b = (buckets[type] = buckets[type] || {
				cells: 0,
				empty: 0,
				hues: [],
			});
			b.cells++;
			if (!hues.length) b.empty++;
			b.hues.push(...hues);
		});
	});
	dc.report = scanCalibDots(buckets);
	els.dcSample.disabled = false;
	const cells = Object.values(dc.report.types).reduce((s, r) => s + r.cells, 0);
	const wb = await dcWriteBackOffsets(items);
	dcStatus(
		`采样完成：${items.length}/${(dc.items || []).length} 张图，共 ${cells} 个锚点格` +
			(dc.skipped.length ? `；跳过 ${dc.skipped.length} 张` : "") +
			(wb.written ? `；环心偏移已写回 truth ${wb.written} 份` : "") +
			(wb.skipped.length
				? `；${wb.skipped.length} 份偏移更新未落盘（非图库来源）`
				: ""),
		dc.skipped.length ? "" : "ok",
	);
	renderDcAll();
}

/** 直方图：0-179 横轴；色柱=批量样本（分类型），顶部刻度=手动样本，色带 / 竖线=当前生效区间 */
function renderDcHist() {
	const cv = els.dcHist;
	const ctx = cv.getContext("2d");
	const W = cv.width;
	const H = cv.height;
	const X = (h) => (h * W) / 180; // hue -> x
	const PLOT_T = 44; // 色柱区上沿
	const PLOT_B = H - 40; // 色柱区基线
	ctx.clearRect(0, 0, W, H);

	// 当前生效区间：色带（顶部条）+ lo/hi 竖线；交叠 hue 段整高标红
	const ranges = computeDotRanges();
	const coverCnt = new Array(180).fill(0);
	ranges.forEach(([lo, hi]) => {
		for (let h = 0; h <= 179; h++) if (hInRange(h, lo, hi)) coverCnt[h]++;
	});
	ctx.fillStyle = "rgba(200, 99, 99, 0.30)";
	for (let h = 0; h <= 179; h++) {
		if (coverCnt[h] >= 2) ctx.fillRect(X(h), PLOT_T, W / 180, PLOT_B - PLOT_T);
	}
	ranges.forEach(([lo, hi, t]) => {
		const color = dotColor(t);
		// 色带（lo>hi 回绕时两段）
		ctx.fillStyle = color + "55";
		if (lo <= hi) {
			ctx.fillRect(X(lo), 4, X(hi) - X(lo), 10);
		} else {
			ctx.fillRect(X(lo), 4, W - X(lo), 10);
			ctx.fillRect(0, 4, X(hi), 10);
		}
		// lo/hi 竖线
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		[lo, hi].forEach((v) => {
			ctx.beginPath();
			ctx.moveTo(X(v), 4);
			ctx.lineTo(X(v), PLOT_B);
			ctx.stroke();
		});
	});

	// 手动样本：顶部刻度条（y 18..36）
	Object.entries(state.dotSamples).forEach(([t, hues]) => {
		if (!hues.length) return;
		ctx.strokeStyle = dotColor(t);
		ctx.lineWidth = 1;
		ctx.beginPath();
		hues.forEach((h) => {
			const x = X(h) + W / 360;
			ctx.moveTo(x, 18);
			ctx.lineTo(x, 36);
		});
		ctx.stroke();
	});

	// 批量样本：分类型色柱（按 hue 整数分桶，半透叠加）
	let ymax = 0;
	const hists = [];
	if (dc.report) {
		Object.entries(dc.report.types).forEach(([t, rec]) => {
			const bins = new Array(180).fill(0);
			rec.hues.forEach((h) => bins[Math.round(h)]++);
			hists.push([t, bins]);
			ymax = Math.max(ymax, ...bins);
		});
	}
	if (ymax) {
		const sy = (PLOT_B - PLOT_T) / ymax;
		hists.forEach(([t, bins]) => {
			ctx.fillStyle = dotColor(t) + "99";
			for (let h = 0; h <= 179; h++) {
				if (!bins[h]) continue;
				ctx.fillRect(X(h), PLOT_B - bins[h] * sy, W / 180, bins[h] * sy);
			}
		});
	}

	// 横轴：基线 + 刻度标签
	ctx.strokeStyle = "#d0d5dd";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, PLOT_B);
	ctx.lineTo(W, PLOT_B);
	ctx.stroke();
	ctx.fillStyle = "#6b7280";
	ctx.font = "10px sans-serif";
	ctx.textAlign = "center";
	for (let h = 0; h <= 179; h += 30) {
		ctx.fillText(String(h), X(h), PLOT_B + 14);
		ctx.beginPath();
		ctx.moveTo(X(h), PLOT_B);
		ctx.lineTo(X(h), PLOT_B + 4);
		ctx.stroke();
	}
	ctx.textAlign = "left";
	ctx.fillText("hue →", W - 44, PLOT_B + 28);

	// hover 数据缓存：浮层提示与本次绘制同口径
	dc.histHover = { ranges, coverCnt, bins: Object.fromEntries(hists) };
	// hover 辅助线：鼠标所在 hue 的竖虚线
	if (dc.hoverH != null) {
		const x = X(dc.hoverH) + W / 360;
		ctx.strokeStyle = "rgba(30, 64, 175, 0.55)";
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 3]);
		ctx.beginPath();
		ctx.moveTo(x, 4);
		ctx.lineTo(x, PLOT_B);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}

/* 直方图 hover：竖虚线 + 浮层提示（hue / 覆盖区间 / 批量与手动样本数） */
const dcHistTip = document.createElement("div");
dcHistTip.className = "dc-hist-tip";
dcHistTip.hidden = true;
document.body.appendChild(dcHistTip);

/** 浮层内容：hue 色样 + 所在区域 + 覆盖该 hue 的生效区间 / 批量样本数 / 手动样本数 */
function dcHistTipFill(h, y) {
	dcHistTip.replaceChildren();
	const plotB = els.dcHist.height - 40; // 同 renderDcHist PLOT_B
	const zone =
		y < 16
			? "生效区间色带"
			: y < 40
				? "手动样本刻度"
				: y <= plotB
					? "批量样本色柱"
					: "横轴";
	const head = document.createElement("div");
	head.className = "dc-hist-tip-head";
	const sw = document.createElement("i");
	sw.style.background = `hsl(${h * 2}, 85%, 45%)`;
	head.appendChild(sw);
	head.appendChild(document.createTextNode(`hue ${h} · ${zone}`));
	dcHistTip.appendChild(head);
	const hv = dc.histHover;
	if (!hv) return;
	const rows = [];
	hv.ranges.forEach(([lo, hi, t]) => {
		if (hInRange(h, lo, hi))
			rows.push([t, `区间 [${lo}, ${hi}]${lo > hi ? "（回绕）" : ""}`]);
	});
	Object.entries(hv.bins).forEach(([t, bins]) => {
		if (bins[h]) rows.push([t, `批量样本 ×${bins[h]}`]);
	});
	Object.entries(state.dotSamples).forEach(([t, hues]) => {
		const n = hues.filter((v) => Math.round(v) === h).length;
		if (n) rows.push([t, `手动样本 ×${n}`]);
	});
	rows.forEach(([t, text]) => {
		const row = document.createElement("div");
		const dot = document.createElement("i");
		dot.style.background = dotColor(t);
		row.appendChild(dot);
		row.appendChild(document.createTextNode(`${t} ${text}`));
		dcHistTip.appendChild(row);
	});
	if (!rows.length) {
		const row = document.createElement("div");
		row.className = "dc-hist-tip-none";
		row.textContent = "该 hue 无区间 / 样本覆盖";
		dcHistTip.appendChild(row);
	}
	if (hv.coverCnt[h] >= 2) {
		const row = document.createElement("div");
		row.className = "dc-hist-tip-warn";
		row.textContent = `⚠ ${hv.coverCnt[h]} 类区间在此交叠`;
		dcHistTip.appendChild(row);
	}
}

els.dcHist.addEventListener("mousemove", (e) => {
	const rect = els.dcHist.getBoundingClientRect();
	if (!rect.width || !rect.height) return;
	// canvas CSS 宽度可缩放（width:100%），按显示比例换算回 canvas 坐标
	const h = Math.min(
		179,
		Math.floor(((e.clientX - rect.left) / rect.width) * 180),
	);
	const y = ((e.clientY - rect.top) / rect.height) * els.dcHist.height;
	if (dc.hoverH !== h) {
		dc.hoverH = h;
		renderDcHist();
	}
	dcHistTipFill(h, y);
	dcHistTip.hidden = false;
	const maxL = innerWidth - dcHistTip.offsetWidth - 8;
	const maxT = innerHeight - dcHistTip.offsetHeight - 8;
	dcHistTip.style.left = `${Math.max(4, Math.min(e.clientX + 14, maxL))}px`;
	dcHistTip.style.top = `${Math.max(4, Math.min(e.clientY + 14, maxT))}px`;
});

els.dcHist.addEventListener("mouseleave", () => {
	dcHistTip.hidden = true;
	if (dc.hoverH != null) {
		dc.hoverH = null;
		renderDcHist();
	}
});

/** 图例：类型色 + 批量 / 手动样本数 */
function renderDcLegend() {
	els.dcLegend.replaceChildren();
	const types = [
		...new Set([
			...(dc.report ? Object.keys(dc.report.types) : []),
			...Object.keys(state.dotSamples).filter(
				(t) => state.dotSamples[t].length,
			),
			...computeDotRanges().map(([, , t]) => t),
		]),
	];
	types.forEach((t) => {
		const batch =
			dc.report && dc.report.types[t] ? dc.report.types[t].samples : 0;
		const manual = (state.dotSamples[t] || []).length;
		const s = document.createElement("span");
		s.innerHTML =
			`<i style="background:${dotColor(t)}"></i>${t}` +
			`（批量 ${batch} / 手动 ${manual}）`;
		els.dcLegend.appendChild(s);
	});
}

/** 统计表：每类型 样本格 / 无圆点格 / 分位数 / 建议区间 / 采用按钮；交叠类型整行标红 */
function renderDcTable() {
	els.dcTbody.replaceChildren();
	const rep = dc.report;
	if (!rep) {
		const tr = document.createElement("tr");
		const td = document.createElement("td");
		td.colSpan = 13;
		td.textContent = "尚未批量采样（手动样本见直方图顶部刻度）";
		td.style.color = "var(--muted)";
		tr.appendChild(td);
		els.dcTbody.appendChild(tr);
		els.dcAdoptAll.disabled = true;
		return;
	}
	// 建议区间交叠的类型集合（scanCalibDots warnings 解析）
	const overlapped = new Set();
	rep.warnings.forEach((w) => {
		const m = w.match(/^(.) \[\d+,\d+\] 与 (.) \[\d+,\d+\] 区间交叠/);
		if (m) {
			overlapped.add(m[1]);
			overlapped.add(m[2]);
		}
	});
	Object.entries(rep.types).forEach(([t, rec]) => {
		const tr = document.createElement("tr");
		if (overlapped.has(t)) tr.className = "dc-overlap";
		const adopted =
			state.adoptedRanges[t] &&
			rec.range &&
			state.adoptedRanges[t][0] === rec.range[0] &&
			state.adoptedRanges[t][1] === rec.range[1];
		const vals = [
			t,
			rec.cells,
			rec.emptyCells,
			rec.samples,
			rec.samples ? rec.min : "—",
			rec.samples ? rec.p1 : "—",
			rec.samples ? rec.p5 : "—",
			rec.samples ? rec.p50 : "—",
			rec.samples ? rec.p95 : "—",
			rec.samples ? rec.p99 : "—",
			rec.samples ? rec.max : "—",
			rec.range ? `[${rec.range[0]}, ${rec.range[1]}]` : "—",
		];
		vals.forEach((v) => {
			const td = document.createElement("td");
			td.textContent = v;
			tr.appendChild(td);
		});
		const tdOp = document.createElement("td");
		if (rec.range) {
			const btn = document.createElement("button");
			btn.textContent = adopted ? "已采用" : "采用";
			btn.disabled = !!adopted;
			btn.addEventListener("click", () => dcAdopt(t));
			tdOp.appendChild(btn);
		}
		tr.appendChild(tdOp);
		els.dcTbody.appendChild(tr);
	});
	els.dcAdoptAll.disabled = !rep.ranges.length;
}

/** 采用某类型建议区间：写入生效配置并联动直方图 / 弹窗区间列表 / 底部输出。
 *  入库硬校验（2026-08-07 Step 4）：采用后生效配置过 scanDotTypesValidate
 *  两两交叠检查（开区间口径，火/雷策略 B 豁免），交叠即回滚拒绝 */
function dcAdopt(t) {
	const rec = dc.report && dc.report.types[t];
	if (!rec || !rec.range) return;
	const prev = state.adoptedRanges[t];
	state.adoptedRanges[t] = [...rec.range];
	const dv = scanDotTypesValidate(computeDotRanges());
	if (!dv.ok) {
		if (prev) state.adoptedRanges[t] = prev;
		else delete state.adoptedRanges[t];
		els.dcAdoptStatus.textContent = `已拒绝采用「${t}」：${dv.problems.join("；")}`;
		els.dcAdoptStatus.className = "status err";
		renderDcAll();
		return;
	}
	saveEntries();
	renderCalRanges();
	renderOutput();
	renderDcAll();
	els.dcAdoptStatus.textContent = `已采用「${t}」[${rec.range[0]}, ${rec.range[1]}]，生效配置与输出已更新`;
	els.dcAdoptStatus.className = "status ok";
}

els.dcAdoptAll.addEventListener("click", () => {
	if (!dc.report || !dc.report.ranges.length) return;
	// 簇分析产出本身两两零重叠；此处仍为整体生效配置做入库硬校验
	// （手动样本 / 既有采用可能与新区间交叠），交叠即整体拒绝
	const next = { ...state.adoptedRanges };
	dc.report.ranges.forEach(([lo, hi, t]) => {
		next[t] = [lo, hi];
	});
	const saved = state.adoptedRanges;
	state.adoptedRanges = next;
	const dv = scanDotTypesValidate(computeDotRanges());
	if (!dv.ok) {
		state.adoptedRanges = saved;
		els.dcAdoptStatus.textContent = `已拒绝全部采用：${dv.problems.join("；")}`;
		els.dcAdoptStatus.className = "status err";
		renderDcAll();
		return;
	}
	saveEntries();
	renderCalRanges();
	renderOutput();
	renderDcAll();
	els.dcAdoptStatus.textContent = `已全部采用 ${dc.report.ranges.length} 个建议区间，生效配置与输出已更新`;
	els.dcAdoptStatus.className = "status ok";
});

/** 警告区：当前生效区间交叠 + 批量分析 warnings（建议区间交叠 / 无样本 / 跳过图）。
 *  交叠判定走 scanDotRangesOverlap（开区间口径、火/雷策略 B 豁免，与入库硬校验一致） */
function renderDcWarn() {
	const warns = [];
	const ranges = computeDotRanges();
	scanDotRangesOverlap(ranges).forEach((o) => {
		warns.push(
			`当前配置交叠：${o.a[2]} (${o.a[0]},${o.a[1]}) 与 ${o.b[2]} (${o.b[0]},${o.b[1]})`,
		);
	});
	if (dc.report) warns.push(...dc.report.warnings);
	dc.skipped.forEach((s) => warns.push(`跳过：${s}`));
	els.dcWarn.textContent = warns.join("；");
	els.dcWarn.className = warns.length ? "status err" : "status";
}

function renderDcAll() {
	renderDcHist();
	renderDcLegend();
	renderDcTable();
	renderDcWarn();
}

/* 真值标注 */
/**
 * 把 test_images/truth/*.json 的手工编写变成可视化标注：
 * 截图工作区与提取弹窗共享 createBoardWorkspace 实现（aws），
 * 点选格子组成棋子，校验（scanValidateTruth）后入列，
 * 保存为与现有 truth 文件一致的 JSON；歧义组棋子可就地提取指纹。
 * truth 格式：{ file, cols, rows, pieces: [{ cells, anchor, type, quality, name? }] }
 * （quality 1-5，红法宝=5；name 写入 truth，供回测对照与歧义组提取指纹用）。
 */
const ann = {
	fileName: "", // 当前截图文件名（草稿键 / 保存建议名）
	pieces: [], // 已标棋子 [{ cells, anchor, type, quality, name? }]
	notes: "", // 载入 truth 时保留，保存时原样写回
	anchor: null, // 当前选区锚点 [r,c]
	anchorPick: false, // 「设为锚点」模式：下一次点击选中格设为锚点
	hadSelection: false, // 品质/类型推荐只在新一次点选时填入（同弹窗）
	nameAuto: "", // 名称栏上一次自动填入值（用户手改后不再覆盖）
};

/* 歧义格识别预填：整盘识别缓存 */
/** 识别结果建「格 → 识别名」映射：只收识别出确定名称的棋子（纯函数，harness 可测） */
function annRecMap(pieces) {
	const map = new Map(); // "r,c" -> name
	(pieces || []).forEach((p) => {
		if (!p.name) return;
		p.cells.forEach(([r, c]) => map.set(`${r},${c}`, p.name));
	});
	return map;
}

/** 歧义格识别预填值：选区格识别出确定名称且落在候选名单内（候选 ≥2）才预填；
 *  识别不出 / 识别名不在候选（矛盾）/ 候选唯一或为空时返回 null（纯函数，harness 可测） */
function annRecPrefill(recMap, cells, expectNames) {
	if (!recMap || !cells || expectNames.length < 2) return null;
	for (const [r, c] of cells) {
		const name = recMap.get(`${r},${c}`);
		if (name) return expectNames.includes(name) ? name : null;
	}
	return null;
}

/** 整盘识别缓存：cells 持 aws.cells 引用，图一切换 / 重切格（引用更换）即失配失效 */
const annRec = {
	cells: null, // 缓存对应的切格
	map: null, // 「格 → 识别名」
	pending: false, // 后台识别进行中
};

/** 缓存失效且未在跑时后台跑一次整盘识别（replayRecognize 同一套流水线，切格后无需 OpenCV）；
 *  完成后刷新表单，把识别预填补进当前仍歧义的选区 */
function annRecEnsure() {
	if (annRec.pending || !aws.cells || annRec.cells === aws.cells) return;
	annRec.pending = true;
	const cells = aws.cells;
	annEls.recStatus.textContent = "识别预填：整盘识别中…";
	setTimeout(() => {
		try {
			annRec.map = annRecMap(
				replayRecognize(cells, cells.length, cells[0].length),
			);
		} catch {
			annRec.map = null; // 识别失败也落缓存，避免每次点格重跑
		}
		annRec.cells = cells;
		annRec.pending = false;
		if (currentTab === "annotate") updateAnnForm();
	}, 0);
}

function annStatus(text, cls) {
	annEls.formStatus.textContent = text;
	annEls.formStatus.className = `status${cls ? ` ${cls}` : ""}`;
}

function annTruthStatus(text, cls) {
	annEls.truthStatus.textContent = text;
	annEls.truthStatus.className = `status${cls ? ` ${cls}` : ""}`;
}

/** 格子是否已被其他棋子占用，返回棋子下标（未占用为 -1） */
function annOccupied(r, c) {
	return ann.pieces.findIndex((p) =>
		p.cells.some(([pr, pc]) => pr === r && pc === c),
	);
}

/** 当前棋盘行列数（以标注 tab 的行列输入为准） */
function annDims() {
	return {
		rows: Number(annEls.rows.value) || 1,
		cols: Number(annEls.cols.value) || 1,
	};
}

/** 锚点自动挑选：选区行优先（从上到下、从左到右）首格，即左上角类型标所在格；
 * 只按位置排序，与点选先后无关（同 scan-core 形状表 anchorOff = offs[0]） */
function annAutoAnchor(cells) {
	return [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
}

/** 数字标所在格：行优先末格（最下行最右，与 scan-core 形状表 badgeOff 一致） */
function annBadgeCell(cells) {
	return [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]).pop();
}

/** 表单联动：形状匹配 / 类型识别 / 候选名称 / 品质推荐 / 锚点维护 */
function updateAnnForm() {
	const sel = aws.selectionMatrix();
	const has = !!(sel && sel.cells.length);
	// 选中形状：迷你图示 + SHAPES 匹配名（无匹配标红）
	annEls.shapeInfo.replaceChildren();
	let shapeKey = null;
	if (has) {
		shapeKey = SHAPES_CACHE[JSON.stringify(sel.mat)] || null;
		const txt = document.createElement("span");
		txt.textContent = shapeKey || `未知形状（${sel.cells.length} 格）`;
		annEls.shapeInfo.appendChild(matMiniHtml(sel.mat, false));
		annEls.shapeInfo.appendChild(txt);
		annEls.shapeInfo.className = shapeKey ? "" : "unknown";
	} else {
		annEls.shapeInfo.textContent = "未选择格子";
		annEls.shapeInfo.className = "";
	}

	// 选中格逐格扫描（取图一次复用）：品质投票 / 空格预警 / 元素徽标类型识别
	const tally = [0, 0, 0, 0, 0];
	let emptyCnt = 0;
	const dotHits = []; // 含元素徽标的格子 [{ cell, type }]
	if (has && aws.cells) {
		sel.cells.forEach(([r, c]) => {
			const data = aws.cells[r][c]
				.getContext("2d")
				.getImageData(0, 0, N, N).data;
			const q = cellQualityVote(data);
			if (q < 0) emptyCnt++;
			else tally[q]++;
			const feat = scanCellFeat(data);
			if (feat.dot && feat.dotType)
				dotHits.push({ cell: [r, c], type: feat.dotType });
		});
	}
	// 类型自动识别：选区内徽标类型唯一时填入（仅新一次点选，识别可能出错，允许用户随后修改）；
	// 多个徽标类型冲突时不改动，标红提示手动确认
	const dotTypes = [...new Set(dotHits.map((h) => h.type))];
	if (dotTypes.length) {
		if (!ann.hadSelection && dotTypes.length === 1)
			annEls.type.value = dotTypes[0];
		annEls.typeGuess.textContent =
			dotTypes.length === 1
				? `徽标识别：${dotTypes[0]}（${dotHits.map((h) => `(${h.cell[0]},${h.cell[1]})`).join(" ")}），可手动修改`
				: `徽标识别冲突：${dotTypes.join(" / ")}，请手动确认`;
		annEls.typeGuess.style.color =
			dotTypes.length === 1 ? "" : "var(--color-red)";
	} else {
		annEls.typeGuess.textContent = "";
	}

	const type = annEls.type.value;
	const quality = Number(annEls.quality.value);
	// 候选名称：scanExpectNames 按 类型+形状+红/普通 推导（含旋转匹配）
	let expect = { names: [], rotated: false };
	if (has && type) expect = scanExpectNames(type, quality, sel.cells);
	annEls.expectNames.textContent = !has
		? "—"
		: expect.names.length
			? expect.names.join(" / ") + (expect.rotated ? "（旋转后匹配）" : "")
			: "名录无匹配";
	annEls.expectNames.style.color =
		has && !expect.names.length ? "var(--color-red)" : "";
	annEls.nameList.replaceChildren(
		...expect.names.map((name) => {
			const opt = document.createElement("option");
			opt.value = name;
			return opt;
		}),
	);
	// 歧义格识别预填：候选 ≥2 时查整盘识别缓存（失效则后台重跑），
	// 识别名落在候选内则视同自动填入（走下方同一自动值通道）
	let recPrefill = null;
	if (has && expect.names.length > 1) {
		annRecEnsure();
		if (annRec.map)
			recPrefill = annRecPrefill(annRec.map, sel.cells, expect.names);
		annEls.recStatus.textContent = annRec.pending
			? "识别预填：整盘识别中…"
			: recPrefill
				? `识别预填：${recPrefill}`
				: "识别预填：无确定结果";
	} else {
		annEls.recStatus.textContent = "";
	}

	// 名称无歧义（候选恰一名）或识别预填命中时自动填入；用户手改过（与上次自动值不同）则不覆盖。
	// 候选变为歧义 / 无匹配且无识别预填时清掉此前的自动填入值，避免把错名称带进 truth
	const nameAutoNext = expect.names.length === 1 ? expect.names[0] : recPrefill;
	if (nameAutoNext) {
		if (!annEls.name.value || annEls.name.value === ann.nameAuto) {
			annEls.name.value = nameAutoNext;
			ann.nameAuto = nameAutoNext;
		}
	} else if (ann.nameAuto && annEls.name.value === ann.nameAuto) {
		annEls.name.value = "";
		ann.nameAuto = "";
	}

	// 品质推荐：选中格多数投票（scanCellQualityVote 0-4 -> truth 1-5）
	if (has && aws.cells) {
		let mq = 0;
		tally.forEach((n, q) => {
			if (n > tally[mq]) mq = q;
		});
		if (tally[mq]) {
			if (!ann.hadSelection) annEls.quality.value = mq + 1;
			annEls.qualityGuess.textContent =
				Number(annEls.quality.value) === mq + 1
					? `推荐：${QUALITY_NAMES[mq]}阶`
					: `推荐：${QUALITY_NAMES[mq]}阶（未采用，可手动切换）`;
		} else {
			annEls.qualityGuess.textContent = "";
		}
		annEls.cellWarn.textContent = emptyCnt
			? `注意：${emptyCnt} 个选中格像空格（暗底居多），请检查是否点错`
			: "";
	} else {
		annEls.qualityGuess.textContent = "";
		if (!aws.cells) annEls.cellWarn.textContent = "";
	}

	// 锚点：不在选区内（含新一次点选）时自动重挑
	if (has) {
		if (!ann.anchor || !aws.selected.has(`${ann.anchor[0]},${ann.anchor[1]}`))
			ann.anchor = annAutoAnchor(sel.cells);
		annEls.anchorInfo.textContent = `(${ann.anchor[0]},${ann.anchor[1]})`;
	} else {
		ann.anchor = null;
		annEls.anchorInfo.textContent = "—";
	}
	ann.hadSelection = has;
	annEls.addPiece.disabled = !has;
}

/** 格子板附加样式：占用态（角标棋子序号）与锚点标记 */
function annCellClass(r, c) {
	let cls = "";
	if (annOccupied(r, c) >= 0) cls += " occupied";
	if (ann.anchor && ann.anchor[0] === r && ann.anchor[1] === c)
		cls += " anchor";
	return cls;
}

function annCellData(r, c) {
	const idx = annOccupied(r, c);
	// r/c 一并写入 dataset，供 hover 浮层事件代理定位格子
	return idx >= 0 ? { occ: idx + 1, r, c } : {};
}

/** 已标棋子格 hover 提示内容：名称（类型）-品阶，品阶文字按品质色着色 */
function annTipFill(idx) {
	const p = ann.pieces[idx];
	const q = document.createElement("span");
	q.style.color = QUALITY_TIP_COLORS[p.quality - 1] || "inherit";
	q.textContent = `${QUALITY_NAMES[p.quality - 1]}阶`;
	annTip.replaceChildren(
		document.createTextNode(`${p.name || "未命名"}（${p.type}）-`),
		q,
	);
}

/* hover 高亮 + 浮层（不用原生 title，鼠标放上即时显示并跟随）：
 * 事件代理挂在格子板容器上，格子重渲染不影响；占用格 dataset 带 r/c。
 * 范围：棋子各格外边界描白色粗线（整格覆盖层按边设 border，内邻接边不描）；
 * 元素徽标（锚点格左上圆点）与数字标（最下行最右格右下圆）盖蓝色半透明圆 */
const annTip = document.createElement("div");
annTip.className = "cell-tip";
annTip.hidden = true;
document.body.appendChild(annTip);
let annHover = -1; // 当前高亮的棋子下标（-1 无）

function annTipMove(e) {
	const pad = 14;
	const rect = annTip.getBoundingClientRect();
	let x = e.clientX + pad;
	let y = e.clientY + pad;
	if (x + rect.width > window.innerWidth - 4) x = e.clientX - rect.width - pad;
	if (y + rect.height > window.innerHeight - 4)
		y = e.clientY - rect.height - pad;
	annTip.style.left = `${x}px`;
	annTip.style.top = `${y}px`;
}

function annClearHover() {
	annHover = -1;
	annTip.hidden = true;
	annEls.cellGrid.querySelectorAll(".hl-ov").forEach((m) => m.remove());
}

function annApplyHover(idx) {
	if (!aws.cells) return;
	const cols = aws.cells[0].length;
	const cellEls = annEls.cellGrid.children;
	const p = ann.pieces[idx];
	const set = new Set(p.cells.map(([r, c]) => `${r},${c}`));
	const ov = (el, kind) => {
		const m = document.createElement("span");
		m.className = `hl-ov ${kind}`;
		el.appendChild(m);
		return m;
	};
	// 范围：每格一个整格覆盖层，只给外边界设 4px 白边（内邻接边宽 0）
	p.cells.forEach(([r, c]) => {
		const el = cellEls[r * cols + c];
		if (!el) return;
		const edge = ov(el, "edge");
		edge.style.borderWidth =
			`${set.has(`${r - 1},${c}`) ? 0 : 4}px ` +
			`${set.has(`${r},${c + 1}`) ? 0 : 4}px ` +
			`${set.has(`${r + 1},${c}`) ? 0 : 4}px ` +
			`${set.has(`${r},${c - 1}`) ? 0 : 4}px`;
	});
	// 元素徽标在锚点格（元素圆点格）左上
	const dot = cellEls[p.anchor[0] * cols + p.anchor[1]];
	if (dot) ov(dot, "dot");
	// 数字标期望位：最下行最右占用格（同 scan-core 形状表 badgeOff）
	const badge = annBadgeCell(p.cells);
	const badgeEl = cellEls[badge[0] * cols + badge[1]];
	if (badgeEl) ov(badgeEl, "badge");
	annHover = idx;
}

annEls.cellGrid.addEventListener("pointermove", (e) => {
	const wrap = e.target.closest(".cell");
	const idx =
		wrap && wrap.dataset.r !== undefined
			? annOccupied(Number(wrap.dataset.r), Number(wrap.dataset.c))
			: -1;
	if (idx < 0) {
		if (annHover >= 0) annClearHover();
		annTip.hidden = true;
		return;
	}
	if (idx !== annHover) {
		annClearHover();
		annApplyHover(idx);
	}
	const p = ann.pieces[idx];
	const key = `${idx}|${p.name}|${p.type}|${p.quality}`;
	if (annTip.dataset.key !== key) {
		annTipFill(idx);
		annTip.dataset.key = key;
	}
	annTip.hidden = false;
	annTipMove(e);
});
annEls.cellGrid.addEventListener("pointerleave", annClearHover);
// 点选 / 删除会重渲染格子板，按下即收起避免残留过期高亮
annEls.cellGrid.addEventListener("pointerdown", annClearHover);

/** 格子板点选：占用格不可选；设锚点模式下点击选中格换锚点；否则切换选区 */
function annCellClick(r, c, wrap) {
	const key = `${r},${c}`;
	if (annOccupied(r, c) >= 0) {
		annStatus("该格已被其他棋子占用，不可选", "err");
		return;
	}
	if (ann.anchorPick) {
		if (!aws.selected.has(key)) {
			annStatus("锚点必须在当前选区内，请先点选该格", "err");
			return;
		}
		ann.anchor = [r, c];
		ann.anchorPick = false;
		annEls.anchorPick.classList.remove("active");
		aws.renderCellGrid();
		annStatus("");
		return;
	}
	if (aws.selected.has(key)) aws.selected.delete(key);
	else aws.selected.add(key);
	wrap.classList.toggle("selected");
	annStatus("");
	updateAnnForm();
}

annEls.anchorPick.addEventListener("click", () => {
	ann.anchorPick = !ann.anchorPick;
	annEls.anchorPick.classList.toggle("active", ann.anchorPick);
	annStatus(ann.anchorPick ? "点击一个已选中的格子设为锚点" : "");
});
annEls.clearSel.addEventListener("click", () => {
	aws.selected.clear();
	aws.renderCellGrid();
});
annEls.type.addEventListener("change", updateAnnForm);
annEls.quality.addEventListener("change", updateAnnForm);

/** 加入棋子：scanValidateTruth 校验连通 / 重叠 / 边界 / 品质，失败红字不入列 */
annEls.addPiece.addEventListener("click", () => {
	const sel = aws.selectionMatrix();
	if (!sel || !sel.cells.length) {
		annStatus("请先点选棋子占用的格子", "err");
		return;
	}
	if (!ann.anchor || !aws.selected.has(`${ann.anchor[0]},${ann.anchor[1]}`)) {
		annStatus("锚点不在选区内", "err");
		return;
	}
	const piece = {
		cells: sel.cells,
		anchor: [...ann.anchor],
		type: annEls.type.value,
		quality: Number(annEls.quality.value),
	};
	const name = annEls.name.value.trim();
	// 名称歧义（候选两个及以上）时必须先选择其一，否则不允许加入
	const expect = scanExpectNames(piece.type, piece.quality, piece.cells);
	if (expect.names.length > 1 && !expect.names.includes(name)) {
		annStatus(
			`名称有歧义：${expect.names.join(" / ")}，请先从候选中选择名称再加入`,
			"err",
		);
		return;
	}
	if (name) piece.name = name;
	const { rows, cols } = annDims();
	const issues = scanValidateTruth(
		{ cols, rows, pieces: [...ann.pieces, piece] },
		"标注",
	);
	if (issues.length) {
		annStatus(issues.join("；"), "err");
		return;
	}
	ann.pieces.push(piece);
	aws.selected.clear();
	ann.anchor = null;
	ann.anchorPick = false;
	annEls.anchorPick.classList.remove("active");
	annEls.name.value = "";
	ann.nameAuto = "";
	aws.renderCellGrid();
	saveAnnDraft();
	annStatus(`已加入第 ${ann.pieces.length} 件棋子`, "ok");
});

/** 棋子所在歧义组：优先按名称查名录，退回按 SHAPES 精确形状键；返回组大小 */
function annGroupSize(piece) {
	let key = null;
	if (piece.name && CATALOG[piece.name]) {
		const [t, s, red] = CATALOG[piece.name];
		key = `${t}|${s || "未知形状"}|${red ? "red" : "normal"}`;
	} else {
		const shapeKey =
			SHAPES_CACHE[JSON.stringify(scanCellsToMat(piece.cells))] || null;
		if (shapeKey)
			key = `${piece.type}|${shapeKey}|${piece.quality === 5 ? "red" : "normal"}`;
	}
	return key ? (catalogGroups.get(key) || []).length : 0;
}

/** 棋子缩略图：按包围盒拼接占用格（供指纹条目 thumb） */
function annPieceThumb(piece) {
	const mat = scanCellsToMat(piece.cells);
	const minR = Math.min(...piece.cells.map((p) => p[0]));
	const minC = Math.min(...piece.cells.map((p) => p[1]));
	const cv = document.createElement("canvas");
	cv.width = mat[0].length * N;
	cv.height = mat.length * N;
	const tctx = cv.getContext("2d");
	piece.cells.forEach(([r, c]) => {
		tctx.drawImage(aws.cells[r][c], (c - minC) * N, (r - minR) * N);
	});
	return cv;
}

/** 歧义组棋子就地提取指纹：复用 extractFingerprint（签名 / 自检 / 入库） */
function annExtract(piece) {
	const { rows, cols } = annDims();
	if (!aws.cells || aws.cells.length !== rows || aws.cells[0].length !== cols) {
		annStatus("格子板与当前行列数不一致，请重新切格", "err");
		return;
	}
	let name = piece.name;
	if (!name) {
		const expect = scanExpectNames(piece.type, piece.quality, piece.cells);
		if (expect.names.length === 1) name = expect.names[0];
	}
	if (!name) {
		annStatus("该棋子尚无名称：点「编辑」载入后从候选中选择名称", "err");
		return;
	}
	const entry = extractFingerprint({
		name,
		type: piece.type,
		quality: piece.quality - 1, // truth 1-5 -> 内部 0-4
		cells: piece.cells,
		cellCanvases: aws.cells,
		thumb: annPieceThumb(piece).toDataURL(),
	});
	if (entry)
		annStatus(
			`已提取「${name}」（${QUALITY_NAMES[piece.quality - 1]}阶），见下方已提取条目`,
			"ok",
		);
}

/** 已标棋子列表：迷你图示 + 类型/品质/锚点，支持删除 / 编辑 / 歧义组提取指纹 */
function renderAnnPieces() {
	annEls.pieceList.replaceChildren();
	const { rows, cols } = annDims();
	const used = ann.pieces.reduce((n, p) => n + p.cells.length, 0);
	annEls.pieceStats.textContent = `共 ${ann.pieces.length} 件`;
	annEls.coverage.textContent = `覆盖率 ${used}/${rows * cols} 格`;
	ann.pieces.forEach((p, idx) => {
		const div = document.createElement("div");
		div.className = "entry";
		div.appendChild(matMiniHtml(scanCellsToMat(p.cells), p.quality === 5));
		const meta = document.createElement("div");
		meta.className = "meta";
		const title = document.createElement("div");
		title.textContent =
			`${idx + 1}. ${p.type} ${QUALITY_NAMES[p.quality - 1]}阶 ` +
			`锚点(${p.anchor[0]},${p.anchor[1]}) ${p.cells.length} 格` +
			(p.name ? ` · ${p.name}` : "");
		meta.appendChild(title);
		div.appendChild(meta);
		// 歧义组（同 类型+形状+红/普通 超过一件）：就地提取指纹
		if (annGroupSize(p) > 1) {
			const fp = document.createElement("button");
			fp.textContent = "提取指纹";
			fp.addEventListener("click", () => annExtract(p));
			div.appendChild(fp);
		}
		const edit = document.createElement("button");
		edit.textContent = "编辑";
		edit.addEventListener("click", () => annEditPiece(idx));
		div.appendChild(edit);
		const del = document.createElement("button");
		del.textContent = "删除";
		del.addEventListener("click", () => {
			ann.pieces.splice(idx, 1);
			aws.renderCellGrid();
			saveAnnDraft();
		});
		div.appendChild(del);
		annEls.pieceList.appendChild(div);
	});
}

/** 重新载入编辑：从列表取下该棋子，格子 / 锚点 / 字段回填到当前选区 */
function annEditPiece(idx) {
	const [p] = ann.pieces.splice(idx, 1);
	aws.selected.clear();
	p.cells.forEach(([r, c]) => aws.selected.add(`${r},${c}`));
	ann.anchor = [...p.anchor];
	annEls.type.value = p.type;
	annEls.quality.value = p.quality;
	annEls.name.value = p.name || "";
	ann.nameAuto = ""; // 名称栏为载入值，自动填入不得覆盖
	ann.hadSelection = true; // 品质/类型推荐不覆盖载入值
	aws.renderCellGrid();
	saveAnnDraft();
	annStatus(`已载入第 ${idx + 1} 件棋子，修改后重新「加入棋子」`);
}

/** 序列化为 truth JSON（字段与现有 truth 文件一致，名称一并写入；
 *  piece 级 dotOff（确认页写回的锚点环心偏移）round-trip 保留） */
function annSerialize() {
	const { rows, cols } = annDims();
	const truth = {
		file: ann.fileName,
		cols,
		rows,
		pieces: ann.pieces.map((p) => ({
			cells: p.cells,
			anchor: p.anchor,
			type: p.type,
			quality: p.quality,
			...(p.name ? { name: p.name } : {}),
			...(p.dotOff ? { dotOff: [...p.dotOff] } : {}),
		})),
	};
	if (ann.notes) truth.notes = ann.notes;
	return JSON.stringify(truth, null, 2);
}

annEls.saveTruth.addEventListener("click", async () => {
	if (!ann.pieces.length) {
		annTruthStatus("尚无已标棋子", "err");
		return;
	}
	const text = annSerialize();
	// 图库可用且当前图片来自图库：直接写 truth/<图片名>.json（文件名与 bench 扫描口径一致），不再弹保存框
	if (
		gal.dir &&
		ann.fileName &&
		gal.records.some((r) => r.name === ann.fileName) &&
		(await galEnsurePerm())
	) {
		try {
			const truthDir = await gal.dir.getDirectoryHandle("truth", {
				create: true,
			});
			const fh = await truthDir.getFileHandle(`${ann.fileName}.json`, {
				create: true,
			});
			const w = await fh.createWritable();
			await w.write(text);
			await w.close();
			annTruthStatus(`已保存 truth 到图库 truth/${ann.fileName}.json`, "ok");
			// truth 已落盘，草稿失去意义，删除避免下次误恢复旧态
			clearAnnDraft();
			// 图库表格状态联动更新（内存记录同步，无需重新扫描）
			galUpdateRecord(ann.fileName, JSON.parse(text));
			return;
		} catch (e) {
			annTruthStatus(`图库写入失败：${e.message}，转为手动保存`, "err");
			// 落到原有保存路径
		}
	}
	// 优先 showSaveFilePicker 直接写文件；API 不可用（如 file://）时降级为文本输出
	if (window.showSaveFilePicker) {
		try {
			const handle = await showSaveFilePicker({
				suggestedName: `${ann.fileName || "truth"}.json`,
				types: [
					{
						description: "truth JSON",
						accept: { "application/json": [".json"] },
					},
				],
			});
			const w = await handle.createWritable();
			await w.write(text);
			await w.close();
			annTruthStatus("已保存 truth 文件", "ok");
			// truth 已落盘，同步删除草稿
			clearAnnDraft();
			return;
		} catch (e) {
			if (e.name === "AbortError") {
				annTruthStatus("已取消保存");
				return;
			}
			// 其他异常落到降级路径
		}
	}
	annEls.output.hidden = false;
	annEls.outputBar.hidden = false;
	annEls.output.value = text;
	annTruthStatus(
		"当前环境不支持直接保存文件，请复制下方 JSON 存入 test_images/truth/",
	);
});

annEls.copy.addEventListener("click", async () => {
	if (!annEls.output.value) return;
	try {
		await navigator.clipboard.writeText(annEls.output.value);
		annTruthStatus("已复制到剪贴板", "ok");
	} catch {
		annEls.output.select();
		document.execCommand("copy");
		annTruthStatus("已复制到剪贴板", "ok");
	}
});

/** 载入 truth：校验（scanValidateTruth）+ 行列数一致性检查后填充棋子列表 */
annEls.truthFile.addEventListener("change", () => {
	const f = annEls.truthFile.files[0];
	annEls.truthFile.value = "";
	if (!f) return;
	const reader = new FileReader();
	reader.onload = () => {
		let truth;
		try {
			truth = JSON.parse(reader.result);
		} catch {
			annTruthStatus("JSON 解析失败", "err");
			return;
		}
		const issues = scanValidateTruth(truth, f.name);
		if (issues.length) {
			annTruthStatus(`校验失败：${issues.join("；")}`, "err");
			return;
		}
		const { rows, cols } = annDims();
		if (Number(truth.cols) !== cols || Number(truth.rows) !== rows) {
			annTruthStatus(
				`行列数不一致：truth 为 ${truth.rows} 行 ${truth.cols} 列，当前棋盘为 ${rows} 行 ${cols} 列`,
				"err",
			);
			return;
		}
		ann.pieces = truth.pieces.map((p) => ({
			cells: p.cells.map(([r, c]) => [r, c]),
			anchor: [...p.anchor],
			type: p.type,
			quality: p.quality,
			...(p.name ? { name: p.name } : {}),
			...(p.dotOff ? { dotOff: [...p.dotOff] } : {}), // 锚点环心偏移 round-trip
		}));
		ann.notes = truth.notes || "";
		if (!ann.fileName && truth.file) ann.fileName = truth.file;
		aws.selected.clear();
		ann.anchor = null;
		aws.renderCellGrid();
		saveAnnDraft();
		annTruthStatus(`已载入 ${f.name}：${ann.pieces.length} 件棋子`, "ok");
	};
	reader.readAsText(f);
});

/* 真值标注草稿 */
/** 删除当前图片的草稿（truth 已落盘或手动清空时调用） */
function clearAnnDraft() {
	if (ann.fileName) localStorage.removeItem(LS_ANN_PREFIX + ann.fileName);
}

function saveAnnDraft() {
	if (!ann.fileName) return; // 粘贴载入无文件名，不存草稿
	try {
		const { rows, cols } = annDims();
		localStorage.setItem(
			LS_ANN_PREFIX + ann.fileName,
			JSON.stringify({
				cols,
				rows,
				notes: ann.notes,
				pieces: ann.pieces,
			}),
		);
	} catch (e) {
		console.warn("localStorage 保存失败", e);
	}
}

annEls.clearDraft.addEventListener("click", () => {
	clearAnnDraft();
	ann.pieces = [];
	ann.notes = "";
	aws.selected.clear();
	ann.anchor = null;
	aws.renderCellGrid();
	annTruthStatus("草稿已清空");
});

/** 截图载入完成：记录文件名并按文件名恢复草稿（含行列数），随后自动定位 */
function annOnImageLoad(fileName) {
	ann.fileName = fileName;
	ann.pieces = [];
	ann.notes = "";
	ann.anchor = null;
	if (fileName) {
		let restored = false;
		try {
			const draft = JSON.parse(
				localStorage.getItem(LS_ANN_PREFIX + fileName) || "null",
			);
			if (draft) {
				annEls.rows.value = draft.rows;
				annEls.cols.value = draft.cols;
				ann.pieces = draft.pieces || [];
				ann.notes = draft.notes || "";
				annTruthStatus(
					`已恢复草稿：${ann.pieces.length} 件棋子（${fileName}）`,
				);
				restored = true;
			}
		} catch {
			ann.pieces = [];
		}
		// 无草稿且图库已有该图 truth：优先从图库载入（行列数对齐 truth，
		// 供紧随其后的自动定位使用；手动选 truth 文件保留为降级路径）
		if (!restored) {
			const rec = gal.records.find((r) => r.name === fileName);
			if (rec && rec.truth) {
				const issues = scanValidateTruth(rec.truth, `${fileName}.json`);
				if (issues.length) {
					annTruthStatus(`图库 truth 校验失败：${issues.join("；")}`, "err");
				} else {
					annEls.rows.value = rec.truth.rows;
					annEls.cols.value = rec.truth.cols;
					ann.pieces = rec.truth.pieces.map((p) => ({
						cells: p.cells.map(([r, c]) => [r, c]),
						anchor: [...p.anchor],
						type: p.type,
						quality: p.quality,
						...(p.name ? { name: p.name } : {}),
						...(p.dotOff ? { dotOff: [...p.dotOff] } : {}), // 锚点环心偏移 round-trip
					}));
					ann.notes = rec.truth.notes || "";
					saveAnnDraft();
					annTruthStatus(
						`已从图库载入 truth：${ann.pieces.length} 件棋子`,
						"ok",
					);
				}
			}
		}
	}
	renderAnnPieces();
	updateAnnForm();
}

/** 真值标注的截图工作区实例（与提取弹窗共享 createBoardWorkspace） */
const aws = createBoardWorkspace(
	{
		file: annEls.file,
		rows: annEls.rows,
		cols: annEls.cols,
		auto: annEls.auto,
		edit: annEls.edit,
		slice: annEls.slice,
		loadStatus: annEls.loadStatus,
		wrap: annEls.wrap,
		canvas: annEls.canvas,
		cellGrid: annEls.cellGrid,
		cellWarn: annEls.cellWarn,
	},
	{
		isActive: () => currentTab === "annotate" && els.modal.hidden,
		onLoad: annOnImageLoad,
		cellClass: annCellClass,
		cellData: annCellData,
		onCellClick: annCellClick,
		onGridRendered: () => {
			renderAnnPieces();
			updateAnnForm();
		},
		onDimsChange: () => {
			renderAnnPieces();
			updateAnnForm();
		},
		onSliced: (rows, cols) =>
			aws.setStatus(`切格完成：${rows}×${cols}，点选一件棋子占用的格子`, "ok"),
	},
);

/* 原始图库 */
/**
 * File System Access API 直接读写 test_images/ 目录：全量图片表格、行内跳转真值标注、
 * 回测与元素校准一键注入，替代各 tab 手动多选。目录句柄不可序列化，持久化到
 * IndexedDB（库 fp-gallery / 存储 handles / 键 galleryDir）；刷新后权限仍在直接恢复，
 * 否则用户手势重授。
 */
const gal = {
	dir: null, // test_images/ 目录句柄
	records: [], // 扫描结果 [{ name, file, lastModified, truth, truthErr }]
	showAll: true, // true 显示全部，false 只看未标注
	thumbObserver: null, // 缩略图懒加载观察器
	previewUrl: null, // 放大预览的 objectURL（关闭时回收）
};

/* IndexedDB 迷你封装（页面内联，无依赖）：句柄存 / 取（图库目录、数据文件共用，按 key 区分） */
const GAL_IDB = { db: "fp-gallery", store: "handles", key: "galleryDir" };

function galIdbOpen() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(GAL_IDB.db, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(GAL_IDB.store);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function galIdbPut(handle, key = GAL_IDB.key) {
	const db = await galIdbOpen();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(GAL_IDB.store, "readwrite");
		tx.objectStore(GAL_IDB.store).put(handle, key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

async function galIdbGet(key = GAL_IDB.key) {
	const db = await galIdbOpen();
	return new Promise((resolve, reject) => {
		const req = db
			.transaction(GAL_IDB.store, "readonly")
			.objectStore(GAL_IDB.store)
			.get(key);
		req.onsuccess = () => {
			db.close();
			resolve(req.result || null);
		};
		req.onerror = () => {
			db.close();
			reject(req.error);
		};
	});
}

/** 图库三种 UI 状态：none=未选目录 / needPerm=句柄在但需重授权 / ready=已扫描 */
function galSetState(mode) {
	els.galPick.hidden = mode === "needPerm";
	els.galPick.textContent = mode === "ready" ? "更换目录" : "选择图库目录";
	els.galPerm.hidden = mode !== "needPerm";
	els.galRefresh.hidden = mode !== "ready";
	els.galFilter.hidden = mode !== "ready";
	els.galWrap.hidden = mode !== "ready";
	// 回测 / 元素校准 / 组级提取的「从图库载入全部」仅图库可用时显示（手动多选保留作降级）
	els.btGalleryLoad.hidden = mode !== "ready";
	els.dcGalleryLoad.hidden = mode !== "ready";
	els.gxGalleryLoad.hidden = mode !== "ready";
	els.galGuide.className = "status";
	if (mode === "needPerm") {
		els.galGuide.textContent =
			"图库目录已缓存，需要重新授权后恢复访问（点左侧按钮，系统弹窗中允许）";
	} else if (mode === "ready") {
		els.galGuide.textContent =
			"行内「标注」直达真值标注（已有 truth 自动载入，草稿优先）；保存 truth 直接写回图库；目录内容变化后点「刷新」重新扫描";
	}
}

/** 读写权限确认：queryPermission 未授予时发起 requestPermission（需用户手势） */
async function galEnsurePerm() {
	if (!gal.dir) return false;
	try {
		const opts = { mode: "readwrite" };
		if ((await gal.dir.queryPermission(opts)) === "granted") return true;
		return (await gal.dir.requestPermission(opts)) === "granted";
	} catch {
		return false;
	}
}

const GAL_IMG_RE = /\.(png|jpe?g|webp)$/i;

/** 全量扫描：根下图片（含大写扩展名）+ truth/ 子目录 .json，解析 truth 摘要 */
async function galScan() {
	els.galStats.textContent = "扫描中…";
	const records = [];
	let truthDir = null;
	for await (const [name, handle] of gal.dir.entries()) {
		if (handle.kind === "directory" && name === "truth") {
			truthDir = handle;
			continue;
		}
		if (handle.kind !== "file" || !GAL_IMG_RE.test(name)) continue;
		const file = await handle.getFile();
		records.push({
			name,
			file,
			lastModified: file.lastModified,
			truth: null,
			truthErr: "",
		});
	}
	if (truthDir) {
		for await (const [name, handle] of truthDir.entries()) {
			if (handle.kind !== "file" || !/\.json$/i.test(name)) continue;
			// bench 口径：truth 文件名严格为 <图片文件名>.json
			const rec = records.find((r) => r.name === name.replace(/\.json$/i, ""));
			if (!rec) continue;
			try {
				rec.truth = JSON.parse(await (await handle.getFile()).text());
			} catch {
				rec.truthErr = "truth 解析失败";
			}
		}
	}
	// 排序：未标注（含解析失败）在前，其余按文件名
	records.sort(
		(a, b) =>
			(a.truth ? 1 : 0) - (b.truth ? 1 : 0) ||
			a.name.localeCompare(b.name, "zh"),
	);
	gal.records = records;
	galSetState("ready");
	renderGallery();
}

/** 图库表格渲染：缩略图懒加载（IntersectionObserver 进入视口才 createObjectURL） */
function renderGallery() {
	const total = gal.records.length;
	const done = gal.records.filter((r) => r.truth).length;
	els.galStats.textContent = total
		? `共 ${total} 张图，已标注 ${done}，未标注 ${total - done}`
		: "目录下没有图片文件";
	els.galTbody.replaceChildren();
	if (gal.thumbObserver) gal.thumbObserver.disconnect();
	gal.thumbObserver = new IntersectionObserver(
		(list) => {
			list.forEach((en) => {
				if (!en.isIntersecting) return;
				gal.thumbObserver.unobserve(en.target);
				const rec = gal.records[Number(en.target.dataset.idx)];
				if (rec) en.target.src = URL.createObjectURL(rec.file);
			});
		},
		{ root: els.galWrap },
	);
	gal.records.forEach((rec, idx) => {
		if (!gal.showAll && rec.truth) return;
		const tr = document.createElement("tr");
		const tdThumb = document.createElement("td");
		const img = document.createElement("img");
		img.dataset.idx = idx;
		img.alt = rec.name;
		img.title = "点击放大预览";
		img.addEventListener("click", () => galPreviewOpen(rec));
		gal.thumbObserver.observe(img);
		tdThumb.appendChild(img);
		tr.appendChild(tdThumb);
		const tdName = document.createElement("td");
		tdName.textContent = rec.name;
		tr.appendChild(tdName);
		// truth 状态：无 truth 标红「未标注」，有的显示 行×列 与棋子数
		const tdTruth = document.createElement("td");
		const tag = document.createElement("span");
		if (rec.truth) {
			tag.className = "tag tag-ok";
			tag.textContent =
				`${rec.truth.rows}×${rec.truth.cols} · ` +
				`${(rec.truth.pieces || []).length} 件棋子`;
		} else {
			tag.className = "tag tag-amb";
			tag.textContent = rec.truthErr || "未标注";
		}
		tdTruth.appendChild(tag);
		tr.appendChild(tdTruth);
		const tdTime = document.createElement("td");
		tdTime.textContent = new Date(rec.lastModified).toLocaleString();
		tr.appendChild(tdTime);
		// 操作：跳转真值标注（图片 File 直接喂给标注工作区）
		const tdOp = document.createElement("td");
		const btn = document.createElement("button");
		btn.textContent = "标注";
		btn.addEventListener("click", () => galAnnotate(rec));
		tdOp.appendChild(btn);
		tr.appendChild(tdOp);
		els.galTbody.appendChild(tr);
	});
	renderGroupView(); // 冲突组视图的库内样本数随图库 truth 刷新
}

/** 行内「标注」：切到真值标注 tab 并载入该图；truth / 草稿由 annOnImageLoad 接管 */
async function galAnnotate(rec) {
	document.querySelector('.tab-bar button[data-tab="annotate"]').click();
	await aws.loadImageBlob(rec.file, rec.name);
}

/** 缩略图点击放大预览：用独立 objectURL（与懒加载缩略图互不影响），关闭时回收 */
function galPreviewOpen(rec) {
	galPreviewClose();
	gal.previewUrl = URL.createObjectURL(rec.file);
	els.galPreviewImg.src = gal.previewUrl;
	els.galPreviewImg.alt = rec.name;
	els.galPreviewName.textContent = rec.name;
	els.galPreview.hidden = false;
}

function galPreviewClose() {
	if (gal.previewUrl) {
		URL.revokeObjectURL(gal.previewUrl);
		gal.previewUrl = null;
	}
	els.galPreview.hidden = true;
}

/** truth 写回图库后联动：更新内存记录并重排（未标注在前），不重扫目录 */
function galUpdateRecord(imgName, truth) {
	const rec = gal.records.find((r) => r.name === imgName);
	if (!rec) return;
	rec.truth = truth;
	rec.truthErr = "";
	gal.records.sort(
		(a, b) =>
			(a.truth ? 1 : 0) - (b.truth ? 1 : 0) ||
			a.name.localeCompare(b.name, "zh"),
	);
	renderGallery();
}

els.galPick.addEventListener("click", async () => {
	if (!window.showDirectoryPicker) return;
	try {
		// readwrite：保存 truth 需要写权限，一次授权读写
		gal.dir = await showDirectoryPicker({
			id: "fp-test-images",
			mode: "readwrite",
		});
		try {
			await galIdbPut(gal.dir);
		} catch (e) {
			console.warn("IndexedDB 缓存目录句柄失败", e);
		}
		await galScan();
	} catch (e) {
		if (e.name !== "AbortError") {
			els.galGuide.textContent = `打开目录失败：${e.message}`;
			els.galGuide.className = "status err";
		}
	}
});

els.galPerm.addEventListener("click", async () => {
	if (await galEnsurePerm()) await galScan();
	else {
		els.galGuide.textContent = "授权被拒绝，图库不可用";
		els.galGuide.className = "status err";
	}
});

els.galRefresh.addEventListener("click", async () => {
	if (await galEnsurePerm()) await galScan();
});

els.galFilter.addEventListener("click", () => {
	gal.showAll = !gal.showAll;
	els.galFilter.textContent = gal.showAll ? "只看未标注" : "显示全部";
	els.galFilter.classList.toggle("active", !gal.showAll);
	renderGallery();
});

// 放大预览：点遮罩任意处或按 Esc 关闭
els.galPreview.addEventListener("click", galPreviewClose);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !els.galPreview.hidden) galPreviewClose();
});

/** 回测一键注入：truth 全量进配对表（key 同手动多选口径），所有截图走 replayFiles 批量流程 */
els.btGalleryLoad.addEventListener("click", () => {
	if (!gal.records.length) return;
	let truthCnt = 0;
	gal.records.forEach((rec) => {
		if (!rec.truth) return;
		bt.truths.set(rec.truth.file || rec.name, rec.truth);
		truthCnt++;
	});
	els.btTruthStatus.textContent = `已从图库载入 ${gal.records.length} 张截图（配对 truth ${truthCnt} 份），开始回测`;
	els.btTruthStatus.className = "status";
	replayFiles(gal.records.map((r) => r.file));
});

/** 元素校准一键注入：truth 进配对表、截图进 dc.imgs，随后走与「批量采样」
 *  相同的素材确认清单（确认后才采样） */
els.dcGalleryLoad.addEventListener("click", () => {
	if (!gal.records.length) return;
	gal.records.forEach((rec) => {
		if (rec.truth) dc.truths.set(rec.truth.file || rec.name, rec.truth);
	});
	dc.imgs = gal.records.map((r) => r.file);
	dcRefreshSampleBtn();
	dcShowConfirm();
});

/** 组级提取一键注入：truth 进 gx.truths、截图进 gx.imgs（组级提取页打开时才可用） */
els.gxGalleryLoad.addEventListener("click", () => {
	if (!gal.records.length || !gx.key) return;
	gal.records.forEach((rec) => {
		if (rec.truth) gx.truths.set(rec.truth.file || rec.name, rec.truth);
	});
	gx.imgs = gal.records.map((r) => r.file);
	gxRefreshSampleBtn();
	renderGroupView(); // 样本数索引更新
	gxStatus(
		`已从图库载入 ${gx.imgs.length} 张截图（配对 truth ${gx.truths.size} 份）；点「批量采样」`,
	);
});

/** 初始化：从 IndexedDB 恢复目录句柄；权限仍在则直接扫描，否则等用户手势重授 */
async function initGallery() {
	if (!window.showDirectoryPicker) {
		els.galPick.disabled = true;
		els.galGuide.textContent =
			"当前浏览器不支持 showDirectoryPicker（需 Chrome / Edge），原始图库不可用；各 tab 的手动多选仍可正常使用";
		els.galGuide.className = "status err";
		return;
	}
	let handle = null;
	try {
		handle = await galIdbGet();
	} catch (e) {
		console.warn("IndexedDB 读取目录句柄失败", e);
	}
	if (!handle) return; // 首次使用：保持引导区「选择图库目录」
	gal.dir = handle;
	try {
		if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") {
			await galScan();
		} else {
			galSetState("needPerm");
		}
	} catch {
		galSetState("needPerm");
	}
}

/* 初始化 */
/** 并行线程设置：初始值 = 持久化值或默认（核数-2，下限 2，上限锁死为该默认值），改动即持久化并调整 worker 池 */
(function initParallelCtl() {
	if (typeof FPPool === "undefined" || !FPPool.supported()) {
		els.parallel.disabled = true;
		return;
	}
	els.parallel.max = FPPool.MAX; // 上限 = 默认值（核数-2），FPPool clampSize 兜底
	els.parallel.value = FPPool.getSize();
	els.parallel.addEventListener("change", () => {
		els.parallel.value = FPPool.setSize(Number(els.parallel.value));
	});
})();

loadEntries();
renderEntries();
updateForm();
updateAnnForm();
loadData();
renderDcAll();
initGallery();
initFpFile();
