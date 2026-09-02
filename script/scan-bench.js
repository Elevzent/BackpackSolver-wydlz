/**
 * 真值（truth）标注相关纯逻辑：tools/bench/bench.js（node 回归跑分）与
 * tools/法宝图标指纹提取工具.html（浏览器端真值标注编辑器）共用。
 * 两端通过 <script src> 引入，全部以 var / function 挂到全局；
 * 纯数据计算，无 fs / DOM 依赖，BLOCKS 直接读全局（与 scan-core.js 一致）。
 *
 * 内容：truth 校验（scanValidateTruth）、形状矩阵工具（scanCellsToMat /
 * scanRotMat / scanCellsKey）、期望名称推导（scanExpectNames）、回测评分
 * （scanScoreImage / scanScoreSummary，bench.js compare 与工具页「回放验证」
 * 同口径）、元素圆点 hue 校准（scanCalibDots 统计；v2：scanDotRingRaw /
 * scanDotGateDetail / scanDotMarginalCause，见下方段标题）、灰区类型分类器
 * （scanTypeSamples / scanTrainTypeModel / scanTuneTypeGate / scanEvalTypeModel /
 * scanCvTypeModel / scanEndToEndTypeMetrics；推理打分 scanTypeModelScore 在
 * scan-core.js 与生产兜底路径同驻）、像素级 MLP（scanMlpRng /
 * scanTrainPixelMlp / scanMlpScore / scanCvPixelModel）与像素验证器产品化
 * （SCAN_PIXEL_ARCH / SCAN_PIXEL_CLASSES / scanPixelFeats / scanTunePixelGate）。
 */

/**
 * truth 标注校验：坐标不越界、件内边相邻连通、件间无重叠、quality∈1-5。
 * 返回问题描述字符串数组（空数组表示无问题）。
 * 参数：truth —— { cols, rows, pieces }；tag —— 错误信息前缀（通常是文件名）
 */
function scanValidateTruth(truth, tag) {
	const issues = [];
	const { cols, rows, pieces } = truth;
	if (!Array.isArray(pieces)) {
		issues.push(`${tag}: pieces 不是数组`);
		return issues;
	}
	const occ = new Map();
	pieces.forEach((p, pi) => {
		const pTag = `${tag} 第${pi + 1}件(${p.type} q${p.quality})`;
		if (!Array.isArray(p.cells) || !p.cells.length) {
			issues.push(`${pTag}: cells 为空`);
			return;
		}
		if (!(p.quality >= 1 && p.quality <= 5)) {
			issues.push(`${pTag}: quality=${p.quality} 越界（应为 1-5）`);
		}
		const set = new Set(p.cells.map(([r, c]) => `${r},${c}`));
		if (set.size !== p.cells.length) issues.push(`${pTag}: cells 有重复坐标`);
		p.cells.forEach(([r, c]) => {
			if (r < 0 || r >= rows || c < 0 || c >= cols) {
				issues.push(`${pTag}: 坐标 (${r},${c}) 越界（${rows}×${cols}）`);
			}
			const key = `${r},${c}`;
			if (occ.has(key)) {
				issues.push(`${pTag}: 格子 (${r},${c}) 与第${occ.get(key) + 1}件重叠`);
			} else {
				occ.set(key, pi);
			}
		});
		// 边相邻连通性：从首格泛洪，应覆盖全部格子
		const seen = new Set([p.cells[0].join(",")]);
		const queue = [p.cells[0]];
		while (queue.length) {
			const [r, c] = queue.pop();
			[
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			].forEach(([dr, dc]) => {
				const k = `${r + dr},${c + dc}`;
				if (set.has(k) && !seen.has(k)) {
					seen.add(k);
					queue.push([r + dr, c + dc]);
				}
			});
		}
		if (seen.size !== set.size) {
			issues.push(`${pTag}: cells 不连通（${seen.size}/${set.size}）`);
		}
	});
	return issues;
}

/**
 * cells（[[r,c],...]）平移归一化到原点后展开为 0/1 矩阵（形状比较用）。
 */
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

/** cells 集合的规范化 key（排序后拼接，与顺序无关），用于 truth/识别结果按格配对 */
function scanCellsKey(cells) {
	return cells
		.map(([r, c]) => `${r},${c}`)
		.sort()
		.join(";");
}

/**
 * 期望名称推导：BLOCKS[type][红/普通] 中 shape 与真实 cells 形状一致的条目。
 * 参数：type —— 元素类型；quality —— 1-5（5 为红）；cells —— 占用格坐标。
 * 返回 { names, rotated }：rotated 表示原方向零匹配、旋转后才匹配上（记 notes）。
 */
function scanExpectNames(type, quality, cells) {
	const grp = ((BLOCKS[type] || {})[quality === 5 ? "red" : "normal"]) || {};
	let mat = scanCellsToMat(cells);
	for (let i = 0; i < 4; i++) {
		const json = JSON.stringify(mat);
		const names = Object.entries(grp)
			.filter(([, d]) => JSON.stringify(d.shape) === json)
			.map(([name]) => name);
		if (names.length || i === 3) return { names, rotated: i > 0 && names.length > 0 };
		mat = scanRotMat(mat);
	}
	return { names: [], rotated: false };
}

/**
 * 单图评分：truth 标注对照检测结果（bench run 输出）打分。
 * 配对规则：cells 集合完全一致（scanCellsKey）配对；配对后逐项判 type/quality/name；
 * name 期望由 scanExpectNames 推导（单名=可判定、多名=歧义组落在组内算对）。
 * 参数：truth —— { cols, rows, pieces }；det —— { detectOk, pieces }（bench run 输出）；
 *       tag —— 名称推导 notes 的前缀（通常是文件名）。
 * 返回 { rec, nameNotes, pairs }：
 *   rec 字段与 bench report images[] 一致（file/detectOk/各比率/missed/falsePos/wrongXxx）；
 *   pairs 为配对明细 [{ tp, dp, typeOk, qualOk, nameOk }]，供浏览器端叠加着色用
 *   （不写入 report，bench.js 忽略）。
 */
function scanScoreImage(truth, det, tag) {
	const nameNotes = [];

	const truthPieces = truth.pieces.map((p) => {
		const exp = scanExpectNames(p.type, p.quality, p.cells);
		if (exp.rotated) {
			nameNotes.push(
				`${tag}: ${p.type} q${p.quality} ${JSON.stringify(p.cells)} 原方向在 BLOCKS 中无形状匹配，旋转后匹配 ${exp.names.join("/")}`,
			);
		} else if (!exp.names.length) {
			nameNotes.push(
				`${tag}: ${p.type} q${p.quality} ${JSON.stringify(p.cells)} 含旋转在 BLOCKS 中均无形状匹配`,
			);
		}
		return { ...p, key: scanCellsKey(p.cells), expNames: exp.names };
	});

	const detByKey = new Map(det.pieces.map((p) => [scanCellsKey(p.cells), p]));
	const matched = [];
	const missed = [];
	truthPieces.forEach((tp) => {
		const dp = detByKey.get(tp.key);
		if (dp) {
			matched.push({ tp, dp });
			detByKey.delete(tp.key);
		} else {
			missed.push(tp);
		}
	});
	const falsePos = [...detByKey.values()];

	const wrongType = [];
	const wrongQual = [];
	const wrongName = [];
	let typeOk = 0;
	let qualOk = 0;
	let nameJud = 0;
	let nameJudOk = 0;
	let nameAmb = 0;
	let nameAmbOk = 0;
	const pairs = [];
	matched.forEach(({ tp, dp }) => {
		const desc = `${JSON.stringify(tp.cells)} 期望 ${tp.type}/q${tp.quality} 实际 ${dp.type || "?"}/q${dp.quality}`;
		const tOk = dp.type === tp.type;
		const qOk = dp.quality === tp.quality;
		let nOk = true; // 无可判定名称（名录无匹配）时不参与 name 判错
		if (tOk) typeOk++;
		else wrongType.push(desc);
		if (qOk) qualOk++;
		else wrongQual.push(desc);
		if (tp.expNames.length === 1) {
			nameJud++;
			nOk = dp.name === tp.expNames[0];
			if (nOk) nameJudOk++;
			else {
				wrongName.push(
					`${JSON.stringify(tp.cells)} 期望「${tp.expNames[0]}」实际「${dp.name || "(空)"}」`,
				);
			}
		} else if (tp.expNames.length > 1) {
			// 歧义组：识别名落在组内即算正确
			nameAmb++;
			nOk = tp.expNames.includes(dp.name);
			if (nOk) nameAmbOk++;
			else {
				wrongName.push(
					`${JSON.stringify(tp.cells)} 歧义组「${tp.expNames.join("/")}」实际「${dp.name || "(空)"}」`,
				);
			}
		}
		pairs.push({ tp, dp, typeOk: tOk, qualOk: qOk, nameOk: nOk });
	});

	const covered = matched.reduce((s, { tp }) => s + tp.cells.length, 0);
	const totalCells = truthPieces.reduce((s, p) => s + p.cells.length, 0);
	const rec = {
		file: tag,
		detectOk: det.detectOk,
		truthPieces: truthPieces.length,
		detPieces: det.pieces.length,
		matched: matched.length,
		cellRecall: totalCells ? covered / totalCells : 1,
		typeAcc: matched.length ? typeOk / matched.length : null,
		qualAcc: matched.length ? qualOk / matched.length : null,
		nameJudAcc: nameJud ? nameJudOk / nameJud : null,
		nameAmbAcc: nameAmb ? nameAmbOk / nameAmb : null,
		missed: missed.map((p) => ({
			cells: p.cells,
			type: p.type,
			quality: p.quality,
		})),
		falsePos: falsePos.map((p) => ({
			cells: p.cells,
			type: p.type,
			quality: p.quality,
			name: p.name,
		})),
		wrongType,
		wrongQual,
		wrongName,
	};
	// 原始计数：scanScoreSummary 汇总用（比率由计数重算，避免浮点反推误差）
	const counts = {
		detectOk: det.detectOk ? 1 : 0,
		truthCells: totalCells,
		coveredCells: covered,
		truthPieces: truthPieces.length,
		matched: matched.length,
		detPieces: det.pieces.length,
		typeOk,
		qualOk,
		nameJud,
		nameJudOk,
		nameAmb,
		nameAmbOk,
	};
	return { rec, nameNotes, pairs, counts };
}

/**
 * 多图汇总：输入 scanScoreImage 返回对象的数组（读取其 counts 累加），
 * 输出 { summary, sum }：summary 字段与 bench report.summary 一致，
 * sum 为原始计数（bench.js 控制台报告打印用）。
 */
function scanScoreSummary(results) {
	const sum = {
		detectOk: 0,
		truthCells: 0,
		coveredCells: 0,
		truthPieces: 0,
		matched: 0,
		detPieces: 0,
		typeOk: 0,
		qualOk: 0,
		nameJud: 0, // 可判定名称样本数
		nameJudOk: 0,
		nameAmb: 0, // 歧义组样本数
		nameAmbOk: 0,
	};
	results.forEach((r) => {
		Object.keys(sum).forEach((k) => {
			sum[k] += r.counts[k];
		});
	});
	const summary = {
		images: results.length,
		detectOk: sum.detectOk,
		cellRecall: sum.truthCells ? sum.coveredCells / sum.truthCells : null,
		pieceMatch: sum.truthPieces ? sum.matched / sum.truthPieces : null,
		truthPieces: sum.truthPieces,
		matchedPieces: sum.matched,
		detPieces: sum.detPieces,
		typeAcc: sum.matched ? sum.typeOk / sum.matched : null,
		qualAcc: sum.matched ? sum.qualOk / sum.matched : null,
		nameJudAcc: sum.nameJud ? sum.nameJudOk / sum.nameJud : null,
		nameJudCount: sum.nameJud,
		nameAmbAcc: sum.nameAmb ? sum.nameAmbOk / sum.nameAmb : null,
		nameAmbCount: sum.nameAmb,
	};
	return { summary, sum };
}

/** 校准统计的类型排序：常用元素在前，其余按出现顺序附后 */
var SCAN_CALIB_TYPE_ORDER = ["金", "木", "水", "火", "土", "雷", "邪", "体"];

/** 体桶不出区间：灰徽标 hue 为图标污染、不可用于校准（体走独立低饱和路径） */
var SCAN_CALIB_NO_RANGE_TYPES = ["体"];

/**
 * SCAN_DOT_TYPES 区间两两交叠检测（入库硬校验共用：bench.js calib-dots 与
 * 工具页「元素校准」tab 的采用/保存链路都经本函数判定）。
 * 开区间口径（h>lo && h<hi，lo>hi 跨 180 回绕，同 scan-core.js scanDotHueTypes）：
 * v2 设计区间端点相邻（火[174,9]/土[8,17] 的 8/9、金[16,26]/土[8,17] 的 16/17、
 * 金/木 的 25/26）属边界互补而非交叠，本口径下零交叠、可通过校验；火/雷交叠
 * 为策略 B 既有设计（175-179 双计多数决，scan-core.js scanDotHueTypes），豁免。
 * 参数：ranges —— [[lo, hi, 类型], ...]。返回交叠明细 [{ a, b, hues[] }]，空=无交叠。
 */
function scanDotRangesOverlap(ranges) {
	const inArc = (lo, hi, h) =>
		lo <= hi ? h > lo && h < hi : h > lo || h < hi;
	const out = [];
	for (let i = 0; i < ranges.length; i++) {
		for (let j = i + 1; j < ranges.length; j++) {
			const [loA, hiA, tA] = ranges[i];
			const [loB, hiB, tB] = ranges[j];
			// 火/雷交叠 = 策略 B 双计设计，豁免（其余类型组合一律判定）
			if ([tA, tB].every((t) => t === "火" || t === "雷")) continue;
			const hues = [];
			for (let h = 0; h < 180; h++) {
				if (inArc(loA, hiA, h) && inArc(loB, hiB, h)) hues.push(h);
			}
			if (hues.length) out.push({ a: ranges[i], b: ranges[j], hues });
		}
	}
	return out;
}

/**
 * SCAN_DOT_TYPES 入库硬校验：交叠明细（scanDotRangesOverlap）转结论。
 * 返回 { ok, problems[]（可读文本）, overlaps }；ok=false 时写出方必须拒绝入库。
 */
function scanDotTypesValidate(ranges) {
	const overlaps = scanDotRangesOverlap(ranges);
	const problems = overlaps.map(
		(o) =>
			`${o.a[2]} [${o.a[0]},${o.a[1]}] 与 ${o.b[2]} [${o.b[0]},${o.b[1]}] 区间交叠` +
			`（hue ${o.hues[0]}${o.hues.length > 1 ? `~${o.hues[o.hues.length - 1]}` : ""} 共 ${o.hues.length} 点），已拒绝入库`,
	);
	return { ok: !overlaps.length, problems, overlaps };
}

/**
 * hue 直方图分水岭簇分析（2026-08-07 Step 4，取代旧 p1~p99±2 的"人工收窄"
 * 口径）：全体类型在同一 0-179 环形直方图（3-bin 循环平滑）上逐 bin 比较，
 * bin 归属平滑计数最大的类型；区间 = 主峰所在连续归属段（遇非本型 bin 即止）。
 * 边界自然落在相邻簇主导权交叉点（如 金/土 16/17、金/木 26/27，与 v2 人工
 * 收窄结论一致），按构造两两零重叠，无需人工收窄；离群散点与污染尾
 * （雷 0-13 离群、水低端污染）被排除在主峰段外。
 * 参数：bucketsHues —— { 类型: hues[] }（体等 SCAN_CALIB_NO_RANGE_TYPES 与
 * 无样本类型须预先剔除）。
 * 返回 { 类型: { peak, loBin, hiBin, range } }：range 为开区间编码
 * [loBin-1, hiBin+1]（hiBin=179 时 hi 取 180，同 v2 雷 [144,180]；loBin=0
 * 且不回绕时取 lo=179 的回绕编码）；主峰被夺走（病态）时 range=null。
 */
function scanHueWatershed(bucketsHues) {
	const types = Object.keys(bucketsHues);
	const smooth = {};
	types.forEach((t) => {
		const hist = new Array(180).fill(0);
		bucketsHues[t].forEach((h) => {
			hist[((Math.round(h) % 180) + 180) % 180]++;
		});
		smooth[t] = hist.map(
			(_, h) => (hist[(h + 179) % 180] + hist[h] + hist[(h + 1) % 180]) / 3,
		);
	});
	// 逐 bin 归属：平滑计数最大的类型（全零 bin 无归属）
	const owner = new Array(180).fill(null);
	for (let h = 0; h < 180; h++) {
		let best = null;
		let bv = 0;
		types.forEach((t) => {
			if (smooth[t][h] > bv) {
				bv = smooth[t][h];
				best = t;
			}
		});
		owner[h] = best;
	}
	const out = {};
	types.forEach((t) => {
		let peak = 0;
		for (let h = 1; h < 180; h++) if (smooth[t][h] > smooth[t][peak]) peak = h;
		if (!smooth[t][peak] || owner[peak] !== t) {
			out[t] = { peak, loBin: null, hiBin: null, range: null }; // 病态：主峰被夺走
			return;
		}
		let lo = peak;
		let hi = peak;
		let guard = 0;
		while (owner[(lo + 179) % 180] === t && guard++ < 179) lo = (lo + 179) % 180;
		guard = 0;
		while (owner[(hi + 1) % 180] === t && guard++ < 179) hi = (hi + 1) % 180;
		out[t] = {
			peak,
			loBin: lo,
			hiBin: hi,
			range: [lo === 0 ? 179 : lo - 1, hi === 179 ? 180 : hi + 1],
		};
	});
	return out;
}

/**
 * 元素圆点 hue 校准统计：输入采样分桶，输出与 bench calib-dots-report.json 一致的分析。
 * 参数：buckets —— { 类型: { cells, empty, hues[] } }：cells 采样格数，empty
 *   其中无有效票格数，hues 全部有效 hue 样本（0-179）。分桶采样为圆盘全像素
 *   口径（scan-core.js scanDiskHues，~100 票/格，2026-08-07 Step 4 起；此前为
 *   16 点环 ~16 点/格）。
 * 返回 { types, ranges, warnings, suggest }：
 *   types    —— 类型 -> { cells, emptyCells, samples, hues(升序), wrap,
 *               min/p1/p5/p50/p95/p99/max, cluster:{peak,loBin,hiBin}, range:[lo,hi] }
 *               （无样本类型无分位数与 range，并记 warning；体等不出 range）；
 *   ranges   —— 建议区间：分水岭簇分析（scanHueWatershed）按构造两两零重叠；
 *   warnings —— 无样本 / 不出区间 / 主峰被夺病态 / 复核残留的交叠（正常应为空，
 *               残留即禁止入库）；suggest —— 建议配置文本 `var SCAN_DOT_TYPES = ...`。
 */
function scanCalibDots(buckets) {
	// 分位数（升序线性插值）
	const quant = (sorted, q) => {
		if (!sorted.length) return null;
		const pos = (sorted.length - 1) * q;
		const lo = Math.floor(pos);
		const hi = Math.ceil(pos);
		return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
	};

	const types = [
		...SCAN_CALIB_TYPE_ORDER.filter((t) => buckets[t]),
		...Object.keys(buckets).filter((t) => !SCAN_CALIB_TYPE_ORDER.includes(t)),
	];
	const report = { types: {}, ranges: [], warnings: [] };
	const calibHues = {}; // 参与簇分析的类型 -> hues（剔除无样本与体等不出区间类型）
	const noRange = {}; // 类型 -> 不出区间原因

	types.forEach((t) => {
		const b = buckets[t];
		const hues = b.hues.slice().sort((a, b2) => a - b2);
		const rec = {
			cells: b.cells,
			emptyCells: b.empty,
			samples: hues.length,
			hues, // 原始样本（升序），供直方图分析
		};
		report.types[t] = rec;
		if (!hues.length) {
			report.warnings.push(`${t}: 无 hue 样本，无法校准`);
			return;
		}
		// 跨 0/179 回绕检测：同时存在低端与高端样本时，整体旋转 90 再统计（仅供分位数展示）
		const wrap = hues[0] <= 20 && hues[hues.length - 1] >= 160;
		const rot = wrap
			? hues.map((h) => (h + 90) % 180).sort((a, b2) => a - b2)
			: hues;
		const qs = [0, 0.01, 0.05, 0.5, 0.95, 0.99, 1].map((q) =>
			Math.round(quant(rot, q) * 10) / 10,
		);
		rec.wrap = wrap;
		[rec.min, rec.p1, rec.p5, rec.p50, rec.p95, rec.p99, rec.max] = qs;
		if (SCAN_CALIB_NO_RANGE_TYPES.includes(t)) {
			noRange[t] = `${t}: hue 为徽标/图标污染，不出建议区间（${t} 走独立判定路径）`;
			report.warnings.push(noRange[t]);
			return;
		}
		calibHues[t] = hues;
	});

	// 分水岭簇分析（全体类型一次计算，bin 归属交叉决定边界；产出自动零重叠）
	const clusters = scanHueWatershed(calibHues);
	Object.entries(clusters).forEach(([t, c]) => {
		const rec = report.types[t];
		rec.cluster = { peak: c.peak, loBin: c.loBin, hiBin: c.hiBin };
		if (!c.range) {
			report.warnings.push(`${t}: 主峰 hue=${c.peak} 归属被其他类型夺走（病态），不出建议区间`);
			return;
		}
		rec.range = c.range;
		report.ranges.push([c.range[0], c.range[1], t]);
	});

	// 产出复核（开区间口径，火/雷豁免）：残留交叠 = 病态，禁止入库
	scanDotRangesOverlap(report.ranges).forEach((o) => {
		report.warnings.push(
			`${o.a[2]} [${o.a[0]},${o.a[1]}] 与 ${o.b[2]} [${o.b[0]},${o.b[1]}] 区间交叠（簇分析产出异常，禁止入库）`,
		);
	});

	report.suggest = `var SCAN_DOT_TYPES = ${JSON.stringify(report.ranges.map(([lo, hi, t]) => [lo, hi, t]))};`;
	return report;
}

/* ===== 元素圆点 hue 校准 v2（边际案例归因为现行产出；口径见 CONTEXT.md 第一部分）=====
 * scanDotGateDetail 与 scan-core.js scanCellFeat judgeDot / 体路径同口径，
 * 判定逻辑改动时须同步。
 * 2026-08-07 Step 5 清理：scanDotCellVotes / scanDotVoteDist /
 * scanDotStrategySim 为环口径票量/策略仿真，随 bench.js calib-dots v2
 * 对应三节一并删除——区间与雷/火策略 B 均已拍板入库；其专用分位数
 * helper scanQuantile 同删。 */

/**
 * 圆点环 16 点原始采样：环位 / 3×3 均值与 scan-core.js scanDotHues 完全同口径，
 * 但不做饱和度过滤与区间归属，返回全部 16 点 {h,s}（四舍五入取整），
 * 供失败格逐案诊断复用（h 原始坐標，不做回绕旋转）。
 */
function scanDotRingRaw(data) {
	const N = SCAN_CELL_SIZE;
	const ring = [];
	for (let k = 0; k < 16; k++) {
		const ang = (2 * Math.PI * k) / 16;
		const cx = Math.round((SCAN_REC.dotCX + SCAN_REC.dotR * Math.cos(ang)) * N);
		const cy = Math.round((SCAN_REC.dotCY + SCAN_REC.dotR * Math.sin(ang)) * N);
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || y < 0 || x >= N || y >= N) continue;
				const i = (y * N + x) * 4;
				r += data[i];
				g += data[i + 1];
				b += data[i + 2];
				n++;
			}
		}
		const [h, s] = scanRgb2Hsv(r / n, g / n, b / n);
		ring.push({ h: Math.round(h), s: Math.round(s) });
	}
	return ring;
}

/**
 * 规范位闸门逐项诊断（边际案例归因用）：与 scan-core.js scanCellFeat 的
 * judgeDisk（= judgeDot 环证据门 + diskOk 圆盘数量门）/ 强票补救 / 体路径
 * 同口径（判定逻辑改动时须同步本函数）；与判定链的差异：不在首个失败闸门
 * 处短路，全部闸门逐项求值以便归因。
 * 返回 { square（规范位类别方块是否在）,
 *   types: { t: { votes/run/hMed/sMed/vMed/vMin/bgDist/glyph（环证据）、
 *     dv/dRival/dGlyph（圆盘本型票/最高异型票/glyphFrac）、
 *     failGates/pass（dotBgDist/dotHits 口径）、failRemedy/passRemedy（强票补救口径）} },
 *   ti: { inLowSFrac, inVMed, inDarkFrac, inVStd, bright, dark, failGates, pass } }；
 * failGates 元素取自 票数/连续段/bgDist/暗纹/圆盘票数/圆盘异型/圆盘暗纹/防伪:*，
 * 全过则 pass=true。
 */
function scanDotGateDetail(data, ranges) {
	ranges = ranges || SCAN_DOT_TYPES;
	const { sampleSquare, sampleDot, sampleDisk, ringRun, bgHsv } = scanDotSamplers(data, ranges);
	const f0 = sampleDot(0, 0);
	const dk0 = sampleDisk(0, 0);
	const square = sampleSquare(0, 0);
	const round1 = (x) => Math.round(x * 10) / 10;
	const judge = (t, bgMin, hitMin) => {
		const pts = f0.dotVotes[t];
		const fails = [];
		const hs = pts.map((p) => p[0]).sort((a, b) => a - b);
		const ss = pts.map((p) => p[1]).sort((a, b) => a - b);
		const vs = pts.map((p) => p[2]).sort((a, b) => a - b);
		const mid = Math.floor(pts.length / 2);
		const [bgH, bgS, bgV] = bgHsv();
		const dh = Math.min(Math.abs(hs[mid] - bgH), 180 - Math.abs(hs[mid] - bgH));
		const bgDist = dh + Math.abs(ss[mid] - bgS) + Math.abs(vs[mid] - bgV);
		if (pts.length < hitMin) fails.push("票数");
		if (ringRun(f0, t) < SCAN_REC.dotHits) fails.push("连续段");
		// 分类型防伪（同 scan-core.js judgeDot，改动须同步）
		if (t === "金" && f0.inHMed !== null) {
			const gd = Math.min(
				Math.abs(f0.inHMed - hs[mid]),
				180 - Math.abs(f0.inHMed - hs[mid]),
			);
			if (gd < SCAN_REC.dotJinGlyphDh) fails.push("防伪:金环芯同色");
		}
		if (t === "木" && vs[mid] > SCAN_REC.dotMuRingVMax) fails.push("防伪:木环过亮");
		if (t === "土") {
			if (hs[mid] < SCAN_REC.dotTuHMedMin) fails.push("防伪:土hue中位");
			if (pts.length > SCAN_REC.dotTuVoteMax && vs[0] >= SCAN_REC.dotTuRingVMin) {
				fails.push("防伪:土满票无暗纹");
			}
		}
		if (t === "火") {
			if (f0.inDarkFrac > SCAN_REC.dotHuoGlyphDarkMax) fails.push("防伪:火整盘暗");
			if (f0.inVMed < SCAN_REC.dotHuoInnerVMin) fails.push("防伪:火内盘过暗");
			if (f0.inVMed > SCAN_REC.dotHuoInnerVMax) fails.push("防伪:火内盘过亮");
			if (hs[mid] > SCAN_REC.dotHuoHMedMax) fails.push("防伪:火hue中位");
			if (vs[mid] < SCAN_REC.dotHuoRingVMin) fails.push("防伪:火环过暗");
			if (ss[mid] < SCAN_REC.dotHuoRingSMin) fails.push("防伪:火环低饱和");
		}
		if (bgDist < bgMin) fails.push("bgDist");
		// 雷走分类型暗纹阈值（同 scan-core.js judgeDot，改动须同步）
		const glyphMin = t === "雷" ? SCAN_REC.dotLeiGlyphDark : SCAN_REC.dotGlyphDark;
		if (f0.inDarkFrac < glyphMin) fails.push("暗纹");
		// 圆盘数量门（同 scan-core.js diskOk，改动须同步）
		const dv = dk0.votes[t] || 0;
		const dRival = Object.entries(dk0.votes).reduce(
			(mx, [ty, m]) => (ty === t ? mx : Math.max(mx, m)),
			0,
		);
		if (dv < SCAN_REC.dotDiskHits) fails.push("圆盘票数");
		if (dRival > SCAN_REC.dotDiskRivalMax) fails.push("圆盘异型");
		if (dk0.glyphFrac < SCAN_REC.dotDiskGlyphMin) fails.push("圆盘暗纹");
		return {
			fails,
			info: {
				votes: pts.length,
				run: ringRun(f0, t),
				hMed: round1(hs[mid]),
				sMed: round1(ss[mid]),
				vMed: round1(vs[mid]),
				vMin: round1(vs[0]),
				bgDist: round1(bgDist),
				glyph: Math.round(f0.inDarkFrac * 100) / 100,
				dv,
				dRival,
				dGlyph: Math.round(dk0.glyphFrac * 100) / 100,
			},
		};
	};
	const types = {};
	Object.keys(f0.dotVotes).forEach((t) => {
		const d = judge(t, SCAN_REC.dotBgDist, SCAN_REC.dotHits);
		const dr = judge(t, SCAN_REC.dotBgDistRemedy, SCAN_REC.dotStrongVotes);
		types[t] = {
			...d.info,
			failGates: d.fails,
			pass: !d.fails.length,
			failRemedy: dr.fails,
			passRemedy: !dr.fails.length,
		};
	});
	// 体路径（同 scan-core.js 体专属路径，改动须同步）
	const bright = f0.inVMed >= SCAN_REC.dotTiVMin && f0.inVMed <= SCAN_REC.dotTiVMax;
	const dark =
		f0.inVMed >= SCAN_REC.dotTiDarkVMin &&
		f0.inVMed < SCAN_REC.dotTiVMin &&
		f0.inDarkFrac >= SCAN_REC.dotTiDarkGlyph &&
		f0.inVStd >= SCAN_REC.dotTiDarkVStd;
	const tiFails = [];
	if (f0.inLowSFrac < SCAN_REC.dotTiLowS) tiFails.push("低饱和占比");
	if (!bright && !dark) tiFails.push("亮度档");
	if (f0.inDarkFrac < SCAN_REC.dotTiGlyph) tiFails.push("暗纹");
	if (f0.inVStd < SCAN_REC.dotTiVStdMin) tiFails.push("双峰std");
	return {
		square,
		types,
		ti: {
			inLowSFrac: Math.round(f0.inLowSFrac * 100) / 100,
			inVMed: round1(f0.inVMed),
			inDarkFrac: Math.round(f0.inDarkFrac * 100) / 100,
			inVStd: round1(f0.inVStd),
			bright,
			dark,
			failGates: tiFails,
			pass: !tiFails.length,
		},
	};
}

/**
 * 边际案例闸门归因：输入 bench 侧逐格诊断记录 rec
 *   { isAnchor, truthType, dot, dotType, qual, iconPx, pixelVeto,
 *     ruleDot, ruleDotType,            // skipModel 口径的规则链结果
 *     gate（scanDotGateDetail 结果）, neighborHits（trace 偏移命中数组，
 *     未进邻域搜索为 null）, locate（trace 几何定位引导条目或 undefined：
 *     { ok, fromLocate, fx, fy, energy, pass, t }）,
 *     model（{ best, bestScore, margin, gate } 或 null） }
 * 输出 { causes }——逐项列出每道卡死/放行闸门（非只首因；文字供报告直接展示）。
 */
function scanDotMarginalCause(rec) {
	const R = SCAN_REC;
	const causes = [];
	const T = rec.truthType;
	const g = rec.gate;
	if (rec.qual < 0) {
		causes.push(
			`空格判定：qual=-1，iconPx=${rec.iconPx}${rec.iconPx < R.emptyIconPx ? "<" : ">="}emptyIconPx=${R.emptyIconPx}（底色暗票过多或图标像素不足，dot 链不执行）`,
		);
		return { causes };
	}
	if (rec.pixelVeto) {
		causes.push(
			`像素模型否决：规则链判 ${rec.pixelVeto.dotType}，vScore=${rec.pixelVeto.vScore} 低于 vScoreTh`,
		);
	}
	if (T && g) {
		const d = g.types[T];
		if (d) {
			if (!d.pass) {
				causes.push(
					`规范位${T}未过：${d.failGates.join("/")}（票=${d.votes} 段=${d.run} bgDist=${d.bgDist} 暗纹=${d.glyph}）`,
				);
				if (!d.passRemedy) {
					causes.push(
						`强票补救不够格：${d.failRemedy.join("/")}（需票≥${R.dotStrongVotes}、bgDist≥${R.dotBgDistRemedy}、方块在；square=${g.square}）`,
					);
				}
			}
		} else {
			causes.push(`规范位环上无${T}票（hue 落区间外或饱和度不足）`);
		}
	}
	if (T && rec.dotType === "体") {
		if (rec.ruleDotType === "体") {
			const ti = g && g.ti;
			causes.push(
				`体路径竞争：灰盘条件全过接走锚点${ti ? `（低饱和=${ti.inLowSFrac} 亮度中位=${ti.inVMed} 暗纹=${ti.inDarkFrac} std=${ti.inVStd}）` : ""}`,
			);
		} else if (!rec.ruleDot) {
			causes.push(
				`灰区模型判体：规则链判负后模型兜底给体${rec.model ? `（score=${rec.model.bestScore} margin=${rec.model.margin}）` : ""}`,
			);
		}
	}
	if (T && rec.dot && rec.dotType && rec.dotType !== T && rec.dotType !== "体") {
		const d = g && g.types[rec.dotType];
		causes.push(
			`误判为${rec.dotType}${d ? `（票=${d.votes} 段=${d.run} bgDist=${d.bgDist}）` : ""}`,
		);
	}
	if (T && rec.neighborHits) {
		const th = rec.neighborHits.filter((h) => h.t === T);
		if (th.length) {
			causes.push(
				`邻域搜索有${T}命中但被闸门拦截：${th.map((h) => `(${h.ox},${h.oy})v=${h.v}`).join(" ")}（闸门：方块/规范位残票/inDark≤0.8/土满环）`,
			);
		} else if (rec.neighborHits.length) {
			causes.push(`邻域搜索无${T}命中（有其他型命中 ${rec.neighborHits.length} 个）`);
		} else {
			causes.push("邻域搜索无任何命中");
		}
	}
	// 几何定位引导（locate 条目存在 = 规范位全负且残票≥2 跑了 scanLocateDot）
	if (T && rec.locate) {
		const L = rec.locate;
		causes.push(
			!L.ok
				? `几何定位未过闸（E=${L.energy}），未引导重采样`
				: !L.fromLocate
					? `几何定位圆心贴规范位（E=${L.energy}），未引导重采样`
					: L.pass
						? `几何定位救回：环心 (${L.fx},${L.fy}) 判${L.t}（E=${L.energy}）`
						: `几何定位环心 (${L.fx},${L.fy})（E=${L.energy}）但定位处判定未过`,
		);
	}
	if (T && !rec.dot && !rec.ruleDot && rec.model) {
		const m = rec.model;
		if (m.best === "neg") {
			causes.push("灰区模型判 neg（不兜底）");
		} else if (m.bestScore < m.gate.scoreTh || m.margin < m.gate.marginMin) {
			causes.push(
				`灰区模型低于闸门：best=${m.best} score=${m.bestScore}${m.bestScore < m.gate.scoreTh ? "<" : ">="}scoreTh=${+m.gate.scoreTh.toFixed(3)}，margin=${m.margin}${m.margin < m.gate.marginMin ? "<" : ">="}marginMin=${+m.gate.marginMin.toFixed(3)}`,
			);
		}
	}
	if (!rec.isAnchor && rec.dot) {
		if (!rec.ruleDot && rec.model) {
			causes.push(
				`灰区模型放行：best=${rec.model.best} score=${rec.model.bestScore} margin=${rec.model.margin}`,
			);
		} else if (rec.ruleDotType === "体") {
			const ti = g && g.ti;
			causes.push(
				`体路径误判${ti ? `（低饱和=${ti.inLowSFrac} 亮度中位=${ti.inVMed} 暗纹=${ti.inDarkFrac} std=${ti.inVStd}）` : ""}`,
			);
		} else if (rec.ruleDotType) {
			const d = g && g.types[rec.ruleDotType];
			causes.push(
				`彩色路径误判为${rec.ruleDotType}${d ? `（票=${d.votes} 段=${d.run} bgDist=${d.bgDist}）` : ""}${rec.neighborHits && rec.neighborHits.length ? "（邻域搜索命中）" : "（规范位直判）"}`,
			);
		}
	}
	return { causes };
}

/* ===== 灰区元素类型统计分类器（阶段一：特征转储 → 训练 → 交叉验证）=====
 * 训练目标：在「规则快路径判负（dot=false）」的灰区格子上，分辨
 * anchor:金/木/水/火/土/体 vs 负样本（cell:* 与 empty）。特征由
 * scan-core.js scanCellTypeFeats 计算（两端同一实现）。以下全部为纯函数，
 * 无 fs / DOM 依赖，bench.js calib-types 与浏览器端共用。 */

/** 灰区模型正样本类型（雷锚点漏检属闸门问题，不入本分类器，见报告） */
var SCAN_TYPE_MODEL_CLASSES = ["金", "木", "水", "火", "土", "体"];

/**
 * 转储 → 训练样本：只取灰区格（dot=false）。
 * 参数：dump —— dump-feats.js 输出 [{file, r, c, role, dot, dotType, feats}]
 * 返回 { samples, excluded, stats }：
 *   samples  —— [{group(=file), file, r, c, role, label, feats}]，
 *               label 为类型名或 "neg"（cell:* 与 empty）；
 *   excluded —— 被排除的灰区格（anchor:雷——雷漏检是 square 闸门问题，
 *               放入负样本会教模型拒真锚点，故不入训练/评估，单列观察）；
 *   stats    —— { roles: role->格数, gray: 灰区格数, labelDist: label->样本数 }
 */
function scanTypeSamples(dump) {
	const samples = [];
	const excluded = [];
	const roles = {};
	dump.forEach((s) => {
		roles[s.role] = (roles[s.role] || 0) + 1;
		if (s.dot) return;
		let label = null;
		if (s.role === "empty" || s.role.startsWith("cell:")) label = "neg";
		else if (s.role.startsWith("anchor:")) {
			const t = s.role.slice(7);
			if (SCAN_TYPE_MODEL_CLASSES.includes(t)) label = t;
			else excluded.push(s); // anchor:雷
		}
		if (label) samples.push({ group: s.file, file: s.file, r: s.r, c: s.c, role: s.role, label, feats: s.feats });
	});
	const labelDist = {};
	samples.forEach((s) => {
		labelDist[s.label] = (labelDist[s.label] || 0) + 1;
	});
	return {
		samples,
		excluded,
		stats: { roles, gray: dump.filter((s) => !s.dot).length, labelDist },
	};
}

/**
 * 训练灰区类型模型（纯函数）。
 * 参数：samples —— scanTypeSamples 输出；opts —— { kind, varK, maxDepth,
 *   minLeaf, posWeight }：
 *   kind="nb"（默认）对角协方差高斯朴素贝叶斯：每类每维 均值/方差 + 先验，
 *     对数似然打分；方差向全样本方差收缩（var=(n·var+varK·gVar)/(n+varK)，
 *     防小类零方差除零）；某类某维无样本或特征值缺失（null）时该维不计入
 *     似然（缺失掩码，如体类无 hue 维）。
 *   kind="centroid" 对照基线：标准化欧氏最近质心（全局方差标准化）。
 *   kind="tree" CART 决策树：加权 gini 分裂（neg 权重 1，正样本类权重
 *     posWeight——正负 1:60 失衡，不加重正类全沉进 neg 叶），候选阈值为
 *     相邻取值中点（精确扫描），缺失维按分裂收益定向（missLeft）；叶节点存
 *     原始（未加权）类分布，打分时 Laplace 平滑出对数概率。树能表达
 *     「inDark 与 inVStd 同时高（双峰字纹）」「票数中段为真、满环为均匀
 *     材质」这类二维交互与非单调规则，NB/质心均不能。
 * 返回 model（kind=nb/centroid）：{ version, kind, dims, classes, varK,
 *   stats: {label: {n, prior, mean: [...], var: [...]}} }（mean/var 按 dims
 *   对齐，null 表示该类该维缺失）；
 * kind=tree：{ version, kind, dims, classes, posWeight, tree: 节点数组 }
 *   内部节点 {d, th, ml, l, r}（ml=缺失往左），叶节点 {dist:[各类计数]}。
 */
function scanTrainTypeModel(samples, opts) {
	const kind = (opts && opts.kind) || "nb";
	const dimSet = new Set();
	samples.forEach((s) => Object.keys(s.feats).forEach((d) => dimSet.add(d)));
	const dims = [...dimSet].sort();
	const classes = [...new Set(samples.map((s) => s.label))];
	if (kind === "tree") {
		const tree = scanBuildTypeTree(samples, dims, classes, opts || {});
		return {
			version: 1,
			kind,
			dims,
			classes,
			posWeight: (opts && opts.posWeight) || 30,
			tree,
		};
	}
	if (kind === "ovr") {
		// 一对其余二分类树集：每个正样本类型一棵 类型 vs 其余全部 的树。
		// 多分类树的贪婪分裂由主导类（neg）的纯度收益驱动，少数类区域易被
		// 无关首维劈散；OvR 每棵树的分裂收益完全由该类型的分离驱动，
		// 更适合「单类型小区域 vs 海量负样本」的灰区结构。
		const posWeight = (opts && opts.posWeight) || 30;
		const ovr = {};
		SCAN_TYPE_MODEL_CLASSES.filter((t) => classes.includes(t)).forEach((t) => {
			const sub = samples.map((s) => ({
				label: s.label === t ? t : "neg",
				feats: s.feats,
			}));
			ovr[t] = { tree: scanBuildTypeTree(sub, dims, [t, "neg"], opts || {}) };
		});
		return { version: 1, kind, dims, classes, posWeight, ovr };
	}
	const varK = (opts && opts.varK) || 5;
	// 全样本每维均值/方差（收缩目标）
	const gMean = {};
	const gVar = {};
	dims.forEach((d) => {
		const vals = samples.map((s) => s.feats[d]).filter((v) => v !== null && v !== undefined);
		const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
		gMean[d] = mean;
		gVar[d] = vals.length
			? Math.max(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length, 1e-6)
			: 1e-6;
	});
	const stats = {};
	classes.forEach((cl) => {
		const ss = samples.filter((s) => s.label === cl);
		const mean = [];
		const va = [];
		dims.forEach((d) => {
			const vals = ss.map((s) => s.feats[d]).filter((v) => v !== null && v !== undefined);
			if (!vals.length) {
				mean.push(null); // 该类该维缺失：打分时跳过该维
				va.push(null);
				return;
			}
			const m = vals.reduce((a, b) => a + b, 0) / vals.length;
			const v0 = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
			mean.push(m);
			// 方差向全样本方差收缩：小类（n<varK）以全样本方差为主，防零除与过拟合
			va.push(Math.max((vals.length * v0 + varK * gVar[d]) / (vals.length + varK), 1e-6));
		});
		stats[cl] = { n: ss.length, prior: ss.length / samples.length, mean, var: va };
	});
	return { version: 1, kind, dims, classes, varK, stats };
}

/** CART 树构建（scanTrainTypeModel kind=tree 用）：返回前序节点数组，0 为根 */
function scanBuildTypeTree(samples, dims, classes, opts) {
	const maxDepth = opts.maxDepth || 8;
	const minLeaf = opts.minLeaf || 2;
	const posWeight = opts.posWeight || 30;
	const wOf = (l) => (l === "neg" ? 1 : posWeight);
	const X = samples.map((s) =>
		dims.map((d) => {
			const v = s.feats[d];
			return v === null || v === undefined ? NaN : v;
		}),
	);
	const Y = samples.map((s) => s.label);
	const giniOf = (c) => {
		let tot = 0;
		Object.values(c).forEach((v) => (tot += v));
		if (!tot) return 0;
		let g = 1;
		Object.values(c).forEach((v) => (g -= (v / tot) ** 2));
		return g * tot;
	};
	const addCnt = (a, b) => {
		const out = { ...a };
		Object.entries(b).forEach(([k, v]) => (out[k] = (out[k] || 0) + v));
		return out;
	};
	const nodes = [];
	const build = (idxs, depth) => {
		const id = nodes.length;
		const cnt = {};
		const wcnt = {};
		idxs.forEach((i) => {
			cnt[Y[i]] = (cnt[Y[i]] || 0) + 1;
			wcnt[Y[i]] = (wcnt[Y[i]] || 0) + wOf(Y[i]);
		});
		const node = { dist: classes.map((c) => cnt[c] || 0) };
		nodes.push(node);
		if (depth >= maxDepth || idxs.length < 2 * minLeaf || Object.keys(cnt).length === 1) return id;
		const base = giniOf(wcnt);
		let best = null;
		for (let di = 0; di < dims.length; di++) {
			const withVal = idxs
				.filter((i) => !isNaN(X[i][di]))
				.sort((a, b) => X[a][di] - X[b][di]);
			if (withVal.length < 2 * minLeaf) continue;
			const missCnt = {};
			idxs.forEach((i) => {
				if (isNaN(X[i][di])) missCnt[Y[i]] = (missCnt[Y[i]] || 0) + wOf(Y[i]);
			});
			// 排序扫描：left 累计 / right 剩余，候选阈值为相邻不同取值中点
			const right = { ...wcnt };
			const left = {};
			for (let k = 0; k < withVal.length - 1; k++) {
				const l = Y[withVal[k]];
				const w = wOf(l);
				left[l] = (left[l] || 0) + w;
				right[l] -= w;
				if (X[withVal[k + 1]][di] === X[withVal[k]][di]) continue;
				if (k + 1 < minLeaf || withVal.length - (k + 1) < minLeaf) continue;
				for (const ml of [true, false]) {
					const g = giniOf(ml ? addCnt(left, missCnt) : left) + giniOf(ml ? right : addCnt(right, missCnt));
					if (g < base - 1e-9 && (!best || g < best.g)) {
						best = {
							g,
							di,
							th: (X[withVal[k]][di] + X[withVal[k + 1]][di]) / 2,
							ml,
						};
					}
				}
			}
		}
		if (!best) return id;
		node.d = best.di;
		node.th = best.th;
		node.ml = best.ml ? 1 : 0;
		const li = [];
		const ri = [];
		idxs.forEach((i) => {
			const x = X[i][best.di];
			const goLeft = isNaN(x) ? best.ml : x <= best.th;
			(goLeft ? li : ri).push(i);
		});
		node.l = build(li, depth + 1);
		node.r = build(ri, depth + 1);
		return id;
	};
	build(
		samples.map((_, i) => i),
		0,
	);
	return nodes;
}

/**
 * 模型打分函数 scanTypeModelScore 已移入 script/scan-core.js（2026-08-04 阶段二
 * 集成：生产兜底路径在 scanCellFeat 内，index.html 只加载 scan-core.js，
 * 推理打分须与识别核心同驻；本文件保留训练/调闸门/评估等离线函数）。
 */

/**
 * 闸门寻优（纯函数）：判负机制 = 最高分 < scoreTh 或 (第一名-第二名) < marginMin
 * 时输出「不确定」（null）。FP 预算制：在 FP <= opts.fpBudget（默认 5）的候选中
 * 按字典序 (TP 最多, FP 最少, 判错类型最少, 不确定最少) 选优——灰区正样本极
 * 稀缺（27 个），严格 FP=0 会把闸门推到 TP=0 的退化区；允许少量 FP 换取召回。
 * 参数：scored —— [{label, best, bestScore, margin}]（一般是 CV 出折预测）；
 *       opts —— { fpBudget }。
 * 返回 { scoreTh, marginMin, fp, wrongType, tp, unsure, trace }；trace 为
 * FP/TP 曲线（每个 FP 档位下 TP 最高的闸门组合）。
 * 性能：decided ⟺ bestScore>=th && margin>=mg 是二维优势查询，故用类别二维
 * 后缀和网格（构建 O(|th|·|mg|)、每对 O(1)，全量 n≈2k 单配置 <1s；逐对评估
 * 为 O(|th|·|mg|·n) 需数分钟）。候选集合、迭代顺序与计数口径与原实现严格一致
 * （随机对拍 + 全量报告逐字节对比验证）。
 */
function scanTuneTypeGate(scored, opts) {
	const fpBudget = opts && opts.fpBudget !== undefined ? opts.fpBudget : 5;
	const pos = scored.filter((s) => s.label !== "neg");
	// 候选阈值：bestScore / margin 的全体取值（决策随阈值单调变化，只需在
	// 样本取值处评估）；bestScore=NaN 的样本对任何阈值都不判出，NaN 候选
	// 只会产出垃圾闸门，一并剔除（与原实现在无 NaN 输入下逐项一致）
	const thCands = [...new Set(scored.map((s) => s.bestScore).filter((v) => !Number.isNaN(v)))].sort((a, b) => a - b);
	const mgCands = [...new Set(scored.map((s) => s.margin).filter((m) => isFinite(m)))].sort((a, b) => a - b);

	// 类别二维后缀和网格：g[ti][mi] = Σ_{i>=ti, j>=mi} 该类别样本数
	// 类别：0=neg 判出且 best!=="neg"（→fp）；1=正样本判对（→tp）；
	// 2=正样本判错类型（→wrongType）。neg 判出为 "neg" 与一切未判出 → unsure
	// （= 总数 - fp - tp - wrongType，与原 evalGate 口径一致），不入网格。
	// margin=NaN/-Inf 任何闸门都不判出（不入网格）；margin=+Inf 对所有有限
	// mg 候选均判出，置于 mi=nmg；bestScore=NaN 任何阈值都不判出（不入网格）。
	const nth = thCands.length;
	const nmg = mgCands.length;
	const W = nmg + 2; // 列：mi 0..nmg（nmg 为 +Inf margin 样本列）+ 1 列零边界
	const tiOf = new Map(thCands.map((v, i) => [v, i]));
	const miOf = new Map(mgCands.map((v, i) => [v, i]));
	const grids = [0, 1, 2].map(() => new Uint32Array((nth + 1) * W));
	scored.forEach((s) => {
		if (Number.isNaN(s.bestScore)) return;
		if (!(s.margin > -Infinity)) return; // NaN / -Infinity
		const ti = tiOf.get(s.bestScore);
		const mi = s.margin === Infinity ? nmg : miOf.get(s.margin);
		const cat =
			s.label === "neg"
				? s.best && s.best !== "neg"
					? 0
					: -1 // neg 判出为 neg → unsure
				: s.best === s.label
					? 1
					: 2;
		if (cat >= 0) grids[cat][ti * W + mi]++;
	});
	grids.forEach((g) => {
		for (let i = nth - 1; i >= 0; i--) {
			for (let j = nmg; j >= 0; j--) {
				g[i * W + j] += g[(i + 1) * W + j] + g[i * W + j + 1] - g[(i + 1) * W + j + 1];
			}
		}
	});
	const evalGrid = (T, M) => {
		const o = T * W + M;
		const fp = grids[0][o];
		const tp = grids[1][o];
		const wrongType = grids[2][o];
		return { fp, wrongType, tp, unsure: scored.length - fp - tp - wrongType };
	};
	let best = null;
	const curve = {}; // fp 档位 -> 该档最优候选
	// 预算内字典序：TP → FP → 判错类型 → 不确定（完全并列先见者胜）
	const better = (a, b) =>
		a.tp > b.tp ||
		(a.tp === b.tp && a.fp < b.fp) ||
		(a.tp === b.tp && a.fp === b.fp && a.wrongType < b.wrongType) ||
		(a.tp === b.tp && a.fp === b.fp && a.wrongType === b.wrongType && a.unsure < b.unsure);
	thCands.forEach((th, T) => {
		mgCands.forEach((mg, M) => {
			const r = evalGrid(T, M);
			const cand = { scoreTh: th, marginMin: mg, ...r };
			if (r.fp <= fpBudget && (!best || better(cand, best))) best = cand;
			// FP/TP 曲线：同 fp 档保留 TP 最高（再 tie-break 判错少）者
			const cur = curve[r.fp];
			if (!cur || r.tp > cur.tp || (r.tp === cur.tp && r.wrongType < cur.wrongType)) curve[r.fp] = cand;
		});
	});
	if (!best) {
		// 所有候选 FP 都超预算（理论上不会发生：阈值取 +∞ 时 FP=0），兜底全判负
		// （走原口径逐样本评估：网格查询覆盖不到 (Infinity, Infinity) 组合）
		let fp = 0;
		let wrongType = 0;
		let tp = 0;
		let unsure = 0;
		scored.forEach((s) => {
			const decided = s.bestScore >= Infinity && s.margin >= Infinity;
			const pred = decided ? s.best : null;
			if (s.label === "neg") {
				if (pred && pred !== "neg") fp++;
				else unsure++;
			} else if (!pred) unsure++;
			else if (pred === s.label) tp++;
			else wrongType++;
		});
		best = { scoreTh: Infinity, marginMin: Infinity, fp, wrongType, tp, unsure };
	}
	best.posTotal = pos.length;
	best.negTotal = scored.length - pos.length;
	// 按 FP 升序的 FP/TP 前沿（只保留 fp<=traceFpCap 段，高 FP 段无实践意义且体积大）
	const traceFpCap = (opts && opts.traceFpCap) || 20;
	best.trace = Object.keys(curve)
		.map(Number)
		.sort((a, b) => a - b)
		.filter((fp) => fp <= traceFpCap)
		.map((fp) => {
			// 拷出纯数据（curve 里可能引用 best 本体，直接挂会成环）
			const c = curve[fp];
			return { scoreTh: c.scoreTh, marginMin: c.marginMin, fp: c.fp, wrongType: c.wrongType, tp: c.tp, unsure: c.unsure };
		});
	return best;
}

/**
 * 灰区模型评估（纯函数）：按闸门决策输出每类 precision/recall、混淆矩阵、
 * 灰区 TP/FP/判错类型/不确定计数与 FP 明细。
 * 参数：scored —— [{file, r, c, role, label, best, bestScore, second, margin}]；
 *       gate —— { scoreTh, marginMin }（缺省不设闸门，全部按 best 判）。
 */
function scanEvalTypeModel(scored, gate) {
	const scoreTh = gate ? gate.scoreTh : -Infinity;
	const marginMin = gate ? gate.marginMin : 0;
	const labels = SCAN_TYPE_MODEL_CLASSES;
	const perClass = {};
	labels.forEach((t) => {
		perClass[t] = { support: 0, tp: 0, fp: 0, fn: 0 };
	});
	perClass.neg = { support: 0, tp: 0, fp: 0, fn: 0 };
	const confusion = {}; // label -> pred -> 数
	const fpCases = [];
	const wrongCases = [];
	let unsure = 0;
	scored.forEach((s) => {
		const decided = s.bestScore >= scoreTh && s.margin >= marginMin;
		const pred = decided ? s.best : null;
		const pc = perClass[s.label];
		if (pc) pc.support++;
		if (!pred) {
			unsure++;
			if (pc) pc.fn++;
			confusion[s.label] = confusion[s.label] || {};
			confusion[s.label]["(不确定)"] = (confusion[s.label]["(不确定)"] || 0) + 1;
			return;
		}
		confusion[s.label] = confusion[s.label] || {};
		confusion[s.label][pred] = (confusion[s.label][pred] || 0) + 1;
		if (pred === s.label) {
			if (pc) pc.tp++;
		} else {
			if (pc) pc.fn++;
			if (perClass[pred]) perClass[pred].fp++;
			const rec = { file: s.file, r: s.r, c: s.c, role: s.role, label: s.label, pred, bestScore: +s.bestScore.toFixed(2), margin: +s.margin.toFixed(2) };
			if (s.label === "neg") fpCases.push(rec);
			else wrongCases.push(rec);
		}
	});
	Object.values(perClass).forEach((pc) => {
		pc.precision = pc.tp + pc.fp ? pc.tp / (pc.tp + pc.fp) : null;
		pc.recall = pc.support ? pc.tp / pc.support : null;
	});
	return { perClass, confusion, fpCases, wrongCases, unsure, total: scored.length };
}

/**
 * 按图留一交叉验证（纯函数）：同一张图的格子不跨训练/验证集。
 * 参数：samples —— scanTypeSamples 输出（含 group=file）；opts 同
 * scanTrainTypeModel（kind 选择 nb / centroid 对照）。
 * 返回 { preds, folds }：preds 为全部样本的出折预测
 * [{file, r, c, role, label, best, bestScore, second, margin}]。
 */
function scanCvTypeModel(samples, opts) {
	const groups = [...new Set(samples.map((s) => s.group))];
	const preds = [];
	groups.forEach((g) => {
		const train = samples.filter((s) => s.group !== g);
		const test = samples.filter((s) => s.group === g);
		const model = scanTrainTypeModel(train, opts);
		test.forEach((s) => {
			const sc = scanTypeModelScore(model, s.feats);
			preds.push({
				file: s.file,
				r: s.r,
				c: s.c,
				role: s.role,
				label: s.label,
				best: sc.best,
				bestScore: sc.bestScore,
				second: sc.second,
				margin: sc.margin,
			});
		});
	});
	return { preds, folds: groups.length };
}

/**
 * 端到端等效指标（纯函数）：快路径（dot=true 判对）+ 灰区模型补救的合成
 * 锚点级口径，与「现有规则链基线（仅快路径）」对比。
 * 参数：dump —— feat-dump 全量格；preds —— 灰区出折预测（scanCvTypeModel）；
 *       gate —— { scoreTh, marginMin }。
 * 返回 { byType, anchors: {total, fastTP, fastWrongType, grayTP, grayWrongType,
 *   grayMiss, baselineRecall, modelRecall}, fp: {baseline, model, modelCases} }
 * baseline 锚点误检 = 非锚点格被快路径判 dot=true；model 为灰区负样本被判类型。
 */
function scanEndToEndTypeMetrics(dump, preds, gate) {
	const scoreTh = gate ? gate.scoreTh : -Infinity;
	const marginMin = gate ? gate.marginMin : 0;
	const predOf = {};
	preds.forEach((p) => {
		const decided = p.bestScore >= scoreTh && p.margin >= marginMin;
		predOf[`${p.file}|${p.r},${p.c}`] = decided ? p.best : null;
	});
	const byType = {};
	const anchors = { total: 0, fastTP: 0, fastWrongType: 0, grayTP: 0, grayWrongType: 0, grayMiss: 0 };
	const fp = { baseline: 0, model: 0, modelCases: [] };
	dump.forEach((s) => {
		if (s.role.startsWith("anchor:")) {
			const t = s.role.slice(7);
			byType[t] = byType[t] || { total: 0, fastTP: 0, grayTotal: 0, grayTP: 0, grayWrongType: 0, grayMiss: 0 };
			const bt = byType[t];
			bt.total++;
			anchors.total++;
			if (s.dot) {
				if (s.dotType === t) {
					bt.fastTP++;
					anchors.fastTP++;
				} else anchors.fastWrongType++; // 快路径判错类型（含被空格兜底抹除前已判出）
			} else {
				bt.grayTotal++;
				const pred = predOf[`${s.file}|${s.r},${s.c}`];
				if (!pred) {
					bt.grayMiss++;
					anchors.grayMiss++;
				} else if (pred === t) {
					bt.grayTP++;
					anchors.grayTP++;
				} else {
					bt.grayWrongType++;
					anchors.grayWrongType++;
				}
			}
		} else {
			// 非锚点格：快路径 dot=true 即基线锚点误检
			if (s.dot) fp.baseline++;
			else {
				const pred = predOf[`${s.file}|${s.r},${s.c}`];
				if (pred && pred !== "neg") {
					fp.model++;
					fp.modelCases.push({ file: s.file, r: s.r, c: s.c, role: s.role, pred });
				}
			}
		}
	});
	anchors.baselineRecall = anchors.total ? anchors.fastTP / anchors.total : null;
	anchors.modelRecall = anchors.total ? (anchors.fastTP + anchors.grayTP) / anchors.total : null;
	return { byType, anchors, fp };
}


/* ===== 像素级 MLP 训练器（像素级小模型计划 阶段 0 骨架，纯函数，无 fs/DOM）=====
 * 用途：像素 patch 降采样向量（或像素+手工特征 hybrid 向量）上的小型
 * 多层感知机，评估「灰区替换 / 全量 dot 验证 / 类别扩展」三任务可行性。
 * 结构：输入逐维标准化 → 1 隐层（tanh/relu）→ softmax；类权重对冲失衡；
 * mini-batch + Float32Array；Xavier/He init + Adam/SGD momentum（手写）；
 * 固定种子可复现。阶段 1 再产品化（闸门寻优/序列化预算）。 */

/**
 * 固定种子伪随机数（mulberry32）：训练可复现用。
 * 返回 () => [0,1) 浮点。
 */
function scanMlpRng(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * 训练像素级 MLP（纯函数）。
 * 参数：samples —— [{ x: number[] | Float32Array, label, ... }]（其余字段
 *   原样忽略，CV 透传用）；
 *   opts —— {
 *     hidden: 隐层宽（默认 32），activation: "tanh"（默认）| "relu",
 *     classes: 类序（缺省按样本出现顺序），epochs（默认 30），
 *     batchSize（默认 32），lr（默认 0.01），optimizer: "adam"（默认）| "sgd",
 *     momentum（sgd 用，默认 0.9），l2（权重衰减，默认 1e-4），
 *     classWeight: "balanced"（默认，n/(K·count_k)）| {label: w} | null,
 *     seed（默认 20260804）
 *   }
 * 返回 model：{ version, kind:"mlp", dims, hidden, activation, classes,
 *   xMean, xStd, W1, b1, W2, b2, loss }；权重为普通数组（序列化友好），
 *   布局 W1[dims][hidden]、W2[hidden][K] 行主序扁平。
 */
function scanTrainPixelMlp(samples, opts) {
	const o = opts || {};
	const hidden = o.hidden || 32;
	const activation = o.activation || "tanh";
	const epochs = o.epochs || 30;
	const batchSize = o.batchSize || 32;
	const lr = o.lr || 0.01;
	const optimizer = o.optimizer || "adam";
	const momentum = o.momentum === undefined ? 0.9 : o.momentum;
	const l2 = o.l2 === undefined ? 1e-4 : o.l2;
	const seed = o.seed === undefined ? 20260804 : o.seed;
	const n = samples.length;
	const dims = samples[0].x.length;
	const classes = o.classes || [...new Set(samples.map((s) => s.label))];
	const K = classes.length;
	const clsIdx = {};
	classes.forEach((c, i) => {
		clsIdx[c] = i;
	});

	// 输入逐维标准化（均值/方差存进模型，推理同口径）
	const xMean = new Float32Array(dims);
	const xStd = new Float32Array(dims);
	for (let d = 0; d < dims; d++) {
		let m = 0;
		for (let i = 0; i < n; i++) m += samples[i].x[d];
		m /= n;
		let v = 0;
		for (let i = 0; i < n; i++) v += (samples[i].x[d] - m) ** 2;
		xMean[d] = m;
		xStd[d] = Math.max(Math.sqrt(v / n), 1e-6);
	}
	// 标准化后的设计矩阵（避免每轮重复换算）
	const X = new Float32Array(n * dims);
	for (let i = 0; i < n; i++) {
		const xi = samples[i].x;
		for (let d = 0; d < dims; d++) X[i * dims + d] = (xi[d] - xMean[d]) / xStd[d];
	}
	const Y = new Int32Array(n);
	for (let i = 0; i < n; i++) Y[i] = clsIdx[samples[i].label];

	// 类权重（对冲失衡）
	const cw = new Float32Array(K).fill(1);
	if (o.classWeight === undefined || o.classWeight === "balanced") {
		const cnt = new Float32Array(K);
		for (let i = 0; i < n; i++) cnt[Y[i]]++;
		for (let k = 0; k < K; k++) cw[k] = cnt[k] > 0 ? n / (K * cnt[k]) : 1;
	} else if (o.classWeight) {
		classes.forEach((c, k) => {
			cw[k] = o.classWeight[c] === undefined ? 1 : o.classWeight[c];
		});
	}

	// 权重初始化（He for relu / Xavier for tanh）
	const rng = scanMlpRng(seed);
	// Box-Muller 高斯
	const gauss = () => {
		const u = Math.max(rng(), 1e-12);
		const v = rng();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	};
	const s1 = Math.sqrt((activation === "relu" ? 2 : 1) / dims);
	const s2 = Math.sqrt((activation === "relu" ? 2 : 1) / hidden);
	const W1 = new Float32Array(dims * hidden);
	const b1 = new Float32Array(hidden);
	const W2 = new Float32Array(hidden * K);
	const b2 = new Float32Array(K);
	for (let i = 0; i < W1.length; i++) W1[i] = gauss() * s1;
	for (let i = 0; i < W2.length; i++) W2[i] = gauss() * s2;

	// Adam / SGD momentum 状态
	const nW = W1.length + b1.length + W2.length + b2.length;
	const mAdam = new Float32Array(nW);
	const vAdam = new Float32Array(nW);
	let adamT = 0;

	// mini-batch 前向/反向
	const act = (z) => (activation === "relu" ? Math.max(z, 0) : Math.tanh(z));
	const actGrad = (z) => {
		if (activation === "relu") return z > 0 ? 1 : 0;
		const t = Math.tanh(z);
		return 1 - t * t;
	};
	const idx = new Int32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	let lastLoss = 0;
	for (let ep = 0; ep < epochs; ep++) {
		// Fisher-Yates 洗牌（种子 rng，折间可复现）
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const t = idx[i];
			idx[i] = idx[j];
			idx[j] = t;
		}
		for (let b0 = 0; b0 < n; b0 += batchSize) {
			const B = Math.min(batchSize, n - b0);
			const Z1 = new Float32Array(B * hidden);
			const A1 = new Float32Array(B * hidden);
			const Z2 = new Float32Array(B * K);
			// 前向：Z1 = X·W1 + b1；A1 = act(Z1)；Z2 = A1·W2 + b2
			for (let bi = 0; bi < B; bi++) {
				const row = idx[b0 + bi] * dims;
				for (let h = 0; h < hidden; h++) {
					let z = b1[h];
					for (let d = 0; d < dims; d++) z += X[row + d] * W1[d * hidden + h];
					Z1[bi * hidden + h] = z;
					A1[bi * hidden + h] = act(z);
				}
				for (let k = 0; k < K; k++) {
					let z = b2[k];
					for (let h = 0; h < hidden; h++) z += A1[bi * hidden + h] * W2[h * K + k];
					Z2[bi * K + k] = z;
				}
			}
			// softmax + 加权交叉熵；dZ2 = w·(p - onehot)，按批内权重和归一
			const dZ2 = new Float32Array(B * K);
			let wSum = 0;
			for (let bi = 0; bi < B; bi++) {
				const yi = Y[idx[b0 + bi]];
				const w = cw[yi];
				wSum += w;
				let mx = -Infinity;
				for (let k = 0; k < K; k++) mx = Math.max(mx, Z2[bi * K + k]);
				let es = 0;
				for (let k = 0; k < K; k++) {
					const e = Math.exp(Z2[bi * K + k] - mx);
					dZ2[bi * K + k] = e;
					es += e;
				}
				let pYi = 0;
				for (let k = 0; k < K; k++) {
					const p = dZ2[bi * K + k] / es;
					if (k === yi) pYi = p;
					dZ2[bi * K + k] = w * (p - (k === yi ? 1 : 0));
				}
				if (ep === epochs - 1) lastLoss += -w * Math.log(pYi + 1e-12);
			}
			const gScale = 1 / Math.max(wSum, 1e-12);
			// 反向：dW2 = A1ᵀ·dZ2；dA1 = dZ2·W2ᵀ；dZ1 = dA1·act'(Z1)；dW1 = Xᵀ·dZ1
			const dW1 = new Float32Array(dims * hidden);
			const db1 = new Float32Array(hidden);
			const dW2 = new Float32Array(hidden * K);
			const db2 = new Float32Array(K);
			const dZ1 = new Float32Array(B * hidden);
			for (let bi = 0; bi < B; bi++) {
				for (let k = 0; k < K; k++) {
					const g = dZ2[bi * K + k] * gScale;
					db2[k] += g;
					for (let h = 0; h < hidden; h++) dW2[h * K + k] += A1[bi * hidden + h] * g;
				}
				for (let h = 0; h < hidden; h++) {
					let da = 0;
					for (let k = 0; k < K; k++) da += dZ2[bi * K + k] * W2[h * K + k];
					dZ1[bi * hidden + h] = da * actGrad(Z1[bi * hidden + h]) * gScale;
				}
				const row = idx[b0 + bi] * dims;
				for (let d = 0; d < dims; d++) {
					const xv = X[row + d];
					for (let h = 0; h < hidden; h++) dW1[d * hidden + h] += xv * dZ1[bi * hidden + h];
				}
				for (let h = 0; h < hidden; h++) db1[h] += dZ1[bi * hidden + h];
			}
			// L2 权重衰减（只作用权重矩阵）
			for (let i = 0; i < W1.length; i++) dW1[i] += l2 * W1[i];
			for (let i = 0; i < W2.length; i++) dW2[i] += l2 * W2[i];
			// 参数更新（Adam 步数每批 +1，四段共用同一偏差修正）
			adamT++;
			const update = (grad, off, len) => {
				if (optimizer === "sgd") {
					for (let i = 0; i < len; i++) {
						mAdam[off + i] = momentum * mAdam[off + i] - lr * grad[i];
						// 直接就地累加到参数（见下方 apply）
					}
					return;
				}
				const bc1 = 1 - Math.pow(0.9, adamT);
				const bc2 = 1 - Math.pow(0.999, adamT);
				for (let i = 0; i < len; i++) {
					mAdam[off + i] = 0.9 * mAdam[off + i] + 0.1 * grad[i];
					vAdam[off + i] = 0.999 * vAdam[off + i] + 0.001 * grad[i] * grad[i];
					grad[i] = (lr * (mAdam[off + i] / bc1)) / (Math.sqrt(vAdam[off + i] / bc2) + 1e-8);
				}
			};
			update(dW1, 0, W1.length);
			update(db1, W1.length, b1.length);
			update(dW2, W1.length + b1.length, W2.length);
			update(db2, W1.length + b1.length + W2.length, b2.length);
			const apply = (P, grad, off) => {
				if (optimizer === "sgd") {
					for (let i = 0; i < P.length; i++) P[i] += mAdam[off + i];
				} else {
					for (let i = 0; i < P.length; i++) P[i] -= grad[i];
				}
			};
			apply(W1, dW1, 0);
			apply(b1, db1, W1.length);
			apply(W2, dW2, W1.length + b1.length);
			apply(b2, db2, W1.length + b1.length + W2.length);
		}
	}

	return {
		version: 1,
		kind: "mlp",
		dims,
		hidden,
		activation,
		classes,
		xMean: [...xMean],
		xStd: [...xStd],
		W1: [...W1],
		b1: [...b1],
		W2: [...W2],
		b2: [...b2],
		loss: lastLoss / n,
	};
}

/**
 * MLP 打分（纯函数）：前向传播，返回与 scanTypeModelScore 同形的结果
 * （scores 为 log 概率，margin = 第一名-第二名 log 概率差）。
 * 参数：model —— scanTrainPixelMlp 返回（架构参数在顶层）或序列化格式
 *   SCAN_PIXEL_MODEL（架构参数在 arch 子对象）；x —— 与训练同口径的输入向量。
 */
function scanMlpScore(model, x) {
	const arch = model.arch || model;
	const { dims, hidden, activation } = arch;
	const { classes } = model;
	const K = classes.length;
	const A1 = new Float32Array(hidden);
	for (let h = 0; h < hidden; h++) {
		let z = model.b1[h];
		for (let d = 0; d < dims; d++) {
			z += ((x[d] - model.xMean[d]) / model.xStd[d]) * model.W1[d * hidden + h];
		}
		A1[h] = activation === "relu" ? Math.max(z, 0) : Math.tanh(z);
	}
	const Z2 = new Float32Array(K);
	for (let k = 0; k < K; k++) {
		let z = model.b2[k];
		for (let h = 0; h < hidden; h++) z += A1[h] * model.W2[h * K + k];
		Z2[k] = z;
	}
	// log-softmax（数值稳定）
	let mx = -Infinity;
	for (let k = 0; k < K; k++) mx = Math.max(mx, Z2[k]);
	let es = 0;
	for (let k = 0; k < K; k++) es += Math.exp(Z2[k] - mx);
	const logSum = mx + Math.log(es);
	const scores = {};
	const probs = {};
	classes.forEach((c, k) => {
		scores[c] = Z2[k] - logSum;
		probs[c] = Math.exp(Z2[k] - logSum);
	});
	const ranked = classes
		.map((c, k) => [c, Z2[k] - logSum])
		.sort((a, b) => b[1] - a[1]);
	return {
		scores,
		probs,
		best: ranked[0][0],
		bestScore: ranked[0][1],
		second: ranked[1] ? ranked[1][0] : null,
		secondScore: ranked[1] ? ranked[1][1] : null,
		margin: ranked[1] ? ranked[0][1] - ranked[1][1] : Infinity,
	};
}

/**
 * 按组交叉验证（纯函数）：同一 group（图）的样本不跨训练/验证集。
 * 参数：samples —— scanTrainPixelMlp 样本 + { group, meta }（meta 为任意
 *   透传字段，如 { file, r, c, role }）；
 *   opts —— scanTrainPixelMlp opts + { folds: "loo"（按组留一，默认）|
 *     正整数 k（按组序固定切 k 折，种子与组序决定，可复现）,
 *     onFold: (foldIdx, foldCount) 可选回调（进度/计时用） }。
 * 返回 { preds, folds }：preds 为全部样本的出折预测
 *   [{ group, label, meta, best, bestScore, second, margin, probs }]。
 */
function scanCvPixelModel(samples, opts) {
	const o = opts || {};
	const groups = [...new Set(samples.map((s) => s.group))];
	const foldsSpec = o.folds === undefined ? "loo" : o.folds;
	const foldOf = {};
	if (foldsSpec === "loo") {
		groups.forEach((g, i) => {
			foldOf[g] = i;
		});
	} else {
		// 固定切分：按组序轮询分 k 折（组序即转储文件序，确定性）
		groups.forEach((g, i) => {
			foldOf[g] = i % foldsSpec;
		});
	}
	const foldCount = foldsSpec === "loo" ? groups.length : foldsSpec;
	const trainOpts = { ...o };
	delete trainOpts.folds;
	delete trainOpts.onFold;
	const preds = [];
	for (let f = 0; f < foldCount; f++) {
		const train = samples.filter((s) => foldOf[s.group] !== f);
		const test = samples.filter((s) => foldOf[s.group] === f);
		if (!train.length || !test.length) continue;
		const model = scanTrainPixelMlp(train, trainOpts);
		test.forEach((s) => {
			const sc = scanMlpScore(model, s.x);
			preds.push({
				group: s.group,
				label: s.label,
				meta: s.meta,
				best: sc.best,
				bestScore: sc.bestScore,
				second: sc.second,
				margin: sc.margin,
				probs: sc.probs,
			});
		});
		if (o.onFold) o.onFold(f + 1, foldCount);
	}
	return { preds, folds: foldCount };
}


/* ===== 像素验证器产品化（阶段 1：T2 直接否决式验证层，纯函数）=====
 * scanPixelFeats：patch → 输入向量（训练与阶段 2 推理同一实现）；
 * scanTunePixelGate：验证器阈值寻优（严格档零误伤 + 折间抖动安全余量）。 */

/** 像素验证器固定架构（阶段 0 搜索结论：16²×3 HSV、hidden=32、tanh） */
var SCAN_PIXEL_ARCH = { size: 16, space: "hsv", hidden: 32, activation: "tanh" };

/** 像素验证器类序（vScore = log p(real) - log p(fake)，与类序无关，写清备查） */
var SCAN_PIXEL_CLASSES = ["real", "fake"];

/**
 * patch → 像素验证器输入向量（纯函数）。
 * 64×64 RGBA 双线性降采样到 size×size（复用 scan-core.js 的全局函数
 * scanResampleBilinear，与训练转储/生产切格同径），按 space 取
 * RGB(/255) 或 HSV(h/179,s/255,v/255) 归一化到 [0,1]，行主序 R-G-B 通道交错。
 * 参数：data —— SCAN_CELL_SIZE² RGBA；opts —— { size=16, space="hsv" }。
 * 返回 number[]（长度 size²·3）。
 */
function scanPixelFeats(data, opts) {
	const o = opts || {};
	const S = o.size || SCAN_PIXEL_ARCH.size;
	const space = o.space || SCAN_PIXEL_ARCH.space;
	const N = SCAN_CELL_SIZE;
	const small = scanResampleBilinear(data, N, N, 0, 0, N, N, S, S);
	const x = new Array(S * S * 3);
	for (let i = 0; i < S * S; i++) {
		const r = small[i * 4];
		const g = small[i * 4 + 1];
		const b = small[i * 4 + 2];
		if (space === "hsv") {
			const [h, s, v] = scanRgb2Hsv(r, g, b);
			x[i * 3] = h / 179;
			x[i * 3 + 1] = s / 255;
			x[i * 3 + 2] = v / 255;
		} else {
			x[i * 3] = r / 255;
			x[i * 3 + 1] = g / 255;
			x[i * 3 + 2] = b / 255;
		}
	}
	return x;
}

/**
 * 像素验证器阈值寻优（纯函数，严格档零误伤）。
 * vScore = log p(real) - log p(fake)（越大越像真锚点；杀假 iff vScore < 阈值）。
 * 阈值 = 出折真锚点全局 min vScore - 安全余量 margin（默认 0.5）：阈值起点
 * 本身已是 63 折全样本的最差出折分（极值统计已含泛化落差），余量只覆盖
 * 「CV 模型 → 全量重训模型 → 未来图片」的残余漂移；折间 min 抖动分布
 * （foldMinStats，右偏极值分布）输出为余量充分性的校验证据。
 * 注：不取折 min 的 std 做余量——该分布右偏（median≈1.8 而 min≈-4.5），
 * std 被含强锚点的折抬高（实测 2.09），按它放余量会把杀假压到 8/21 而无
 * 不必要的保护。
 * 参数：preds —— scanCvPixelModel 出折预测（含 group/label/probs/meta）；
 *   opts —— { minMargin, traceMargins }。
 * 返回 { vScoreTh, vScoreThByType, typeMin, globalMin, margin, foldMinStats,
 *   kills, harms, killsByType, harmsByType, realTotal, fakeTotal, killedCases,
 *   harmedCases, killedCasesByType, harmedCasesByType, trace }（vScoreThByType
 *   为分类型阈值——按规则链 dotType 分组的出折真锚点 min - margin，消费端缺失
 *   类型回退 vScoreTh；trace 为各候选余量下的杀假/误伤对照，供报告呈现余量敏感性）。
 */
function scanTunePixelGate(preds, opts) {
	const o = opts || {};
	const minMargin = o.minMargin === undefined ? 0.5 : o.minMargin;
	const vScore = (p) =>
		Math.log(p.probs.real + 1e-12) - Math.log(p.probs.fake + 1e-12);
	const reals = preds.filter((p) => p.label === "real");
	const fakes = preds.filter((p) => p.label === "fake");
	const globalMin = Math.min(...reals.map(vScore));
	const margin = minMargin;
	const vScoreTh = globalMin - margin;
	// 分类型阈值（2026-08-10 加邪系后校）：全局阈值由全样本最差出折真锚点决定，
	// 该极值来自邪（暗徽标泛化落差大），把其余类型阈值一并拖低约 5 分——出折假
	// dot vScore 集中在 [-10.5,-8] 区间全部漏杀（calib-pixel 报告 survivingFakes）。
	// 分类型取 min 后阈值只可能 ≥ 全局值（同 margin），语义仍为「零误伤严格档」；
	// 阈值键取规则链输出 dotType（与 scanCellFeat 验证层消费口径一致）
	const typeOf = (p) => p.meta.dotType || "?";
	const typeMin = {};
	reals.forEach((p) => {
		const t = typeOf(p);
		const v = vScore(p);
		if (!(t in typeMin) || v < typeMin[t]) typeMin[t] = v;
	});
	const vScoreThByType = {};
	Object.entries(typeMin).forEach(([t, v]) => {
		vScoreThByType[t] = v - margin;
	});
	// 分类型阈值下的出折杀假/误伤（生产口径：阈值按各格 dotType 取）
	const thOfType = (p) => {
		const th = vScoreThByType[typeOf(p)];
		return th === undefined ? vScoreTh : th;
	};
	const byType = {
		killed: fakes.filter((p) => vScore(p) < thOfType(p)),
		harmed: reals.filter((p) => vScore(p) < thOfType(p)),
	};
	// 折间 min 抖动分布：每折（group=留一测试图）测试集真锚点 min vScore
	const byGroup = {};
	reals.forEach((p) => {
		(byGroup[p.group] = byGroup[p.group] || []).push(vScore(p));
	});
	const foldMins = Object.values(byGroup).map((vs) => Math.min(...vs)).sort((a, b) => a - b);
	const mean = foldMins.reduce((a, b) => a + b, 0) / foldMins.length;
	const std = Math.sqrt(foldMins.reduce((a, b) => a + (b - mean) ** 2, 0) / foldMins.length);
	const fq = (frac) => foldMins[Math.min(foldMins.length - 1, Math.floor(foldMins.length * frac))];
	const evalAt = (th) => {
		const killed = fakes.filter((p) => vScore(p) < th);
		const harmed = reals.filter((p) => vScore(p) < th);
		return { killed, harmed };
	};
	const { killed, harmed } = evalAt(vScoreTh);
	const trace = (o.traceMargins || [0, 0.25, 0.5, 0.75, 1, 1.5]).map((m) => {
		const r = evalAt(globalMin - m);
		return { margin: m, th: +(globalMin - m).toFixed(4), kills: r.killed.length, harms: r.harmed.length };
	});
	return {
		vScoreTh,
		vScoreThByType,
		typeMin,
		globalMin,
		margin,
		foldMinStats: { n: foldMins.length, min: foldMins[0], p5: fq(0.05), p25: fq(0.25), median: fq(0.5), max: foldMins[foldMins.length - 1], mean, std },
		kills: killed.length,
		harms: harmed.length,
		killsByType: byType.killed.length,
		harmsByType: byType.harmed.length,
		realTotal: reals.length,
		fakeTotal: fakes.length,
		killedCases: killed.map((p) => ({ ...p.meta, vScore: +vScore(p).toFixed(4) })),
		harmedCases: harmed.map((p) => ({ ...p.meta, vScore: +vScore(p).toFixed(4) })),
		killedCasesByType: byType.killed.map((p) => ({ ...p.meta, vScore: +vScore(p).toFixed(4) })),
		harmedCasesByType: byType.harmed.map((p) => ({ ...p.meta, vScore: +vScore(p).toFixed(4) })),
		trace,
	};
}
