/* scan-fp-refs.js 全文序列化（唯一写回口径，纯函数，浏览器/Node 双端通用）
 *
 * 职责划分：
 * - SCAN_DOT_TYPES / SCAN_FP_REFS：调用方（校准工具）负责的段，传新值；
 * - SCAN_REC / SCAN_TYPE_MODEL / SCAN_PIXEL_MODEL：非调用方职责的段，把
 *   <script src> 加载到的原值原样传入做轮转——历史上 TYPE_MODEL 就因未轮转
 *   在保存时被整段丢掉，新段入库时必须同步加进本函数（软守卫静默失效，不报错）。
 *
 * 注意：本函数重新生成全文，各段头部的详细校准依据注释会被压缩为通用说明行。
 * 需保留详细注释的写回应走文本级局部替换（实现：tools/bench/lib/refs-section-io.js）。 */
var SCAN_FP_IO_QUALITY_NAMES = ["一", "二", "三", "四", "五"];

/** 单条指纹条目序列化（SCAN_FP_REFS 组内元素） */
function scanFpRefEntryLines(en) {
	return [
		"\t\t{",
		`\t\t\tname: "${en.name}",`,
		`\t\t\tquality: ${en.quality},${
			en.quality != null
				? ` // ${SCAN_FP_IO_QUALITY_NAMES[en.quality]}阶样本`
				: " // 通用模板"
		}`,
		`\t\t\tmaxDiff: ${en.maxDiff},`,
		`\t\t\tsig: ${JSON.stringify(en.sig)},`,
		`\t\t\tsigLegacy: ${JSON.stringify(en.sigLegacy)},`,
		// 组级提取（冲突组多样本聚合）产出的统计字段，旧条目没有则不输出；
		// 匹配端 2026-08-05 起用 sig（scan-core.js scanNamePiece），sigVar/samples 为模板质量信息
		...(en.sigVar
			? [`\t\t\tsigVar: ${JSON.stringify(en.sigVar)}, // 逐块类内离散度（MAD）`]
			: []),
		...(en.samples != null
			? [`\t\t\tsamples: ${en.samples}, // 聚合样本数`]
			: []),
		"\t\t},",
	];
}

/**
 * 组装 scan-fp-refs.js 全文。
 * dotTypes: SCAN_DOT_TYPES 新值；scanRec/typeModel/pixelModel: 原值轮转（可缺省，缺省则不输出该段）；
 * fpGroups: Map（键 `类型|形状|red|normal` → 条目数组），与工具 mergedFpRefs 返回结构一致。
 */
function scanFpRefsSerialize({ dotTypes, scanRec, fpGroups, typeModel, pixelModel }) {
	const lines = [
		"// 截图识别配置与图标指纹：由 tools/法宝图标指纹提取工具.html 校准后整体替换本文件，请勿手改",
		"//",
		"// SCAN_DOT_TYPES：元素圆点 hue(0-179) 区间 -> 法宝类型；lo > hi 表示跨 180 回绕（如红色 [170, 5]）",
		`var SCAN_DOT_TYPES = ${JSON.stringify(dotTypes)};`,
		"//",
		"// SCAN_REC：识别阈值与采样参数（随加载配置原样轮转；各键含义与校准依据见 script/scan-core.js 顶部注释）",
		`var SCAN_REC = ${JSON.stringify(scanRec, null, "\t")};`,
		"//",
		"// SCAN_FP_REFS：同 类型+形状+红/普通 存在多个法宝时的图标指纹参考（由样例校准）。",
		"// 键 `类型|形状|red|normal`；sig 为每格 4×4 块图标像素均值（不足记 null），",
		"// 匹配端（scanNamePiece）2026-08-05 起用 sig；sigLegacy 为每格 2×2 象限全像素均值 RGB，",
		"// 仅供无 sig 的旧条目回退。组级提取条目另带 sigVar（逐块类内离散度 MAD）/ samples",
		"// （聚合样本数）。maxDiff 为组级建议值（组内最小类间 diff 的一半，下限 5，无可比项 25），",
		"// 同组条目同一值，缺失时匹配端回退 25。",
		"// quality: 0~4 对应 一~五阶；图标跨品质一致的条目可改为 null 作为该组通用模板。",
		"// 匹配差值超过 maxDiff 时不猜名，低置信交人工选择。",
		...scanFpRefsSectionLines(fpGroups),
	];
	// 模型段随加载配置原样轮转（生成物；不轮转会在下次保存时从文件里整段丢掉）
	if (typeModel) {
		lines.push(
			"//",
			"// SCAN_TYPE_MODEL：灰区元素类型统计分类器模型（随加载配置原样轮转；生成物，来源命令与校准依据见 script/scan-core.js 顶部注释）",
			`var SCAN_TYPE_MODEL = ${JSON.stringify(typeModel)};`,
		);
	}
	if (pixelModel) {
		lines.push(
			"//",
			"// SCAN_PIXEL_MODEL：全量 dot 像素验证器模型（随加载配置原样轮转；生成物，来源命令与校准依据见 script/scan-core.js 顶部注释）",
			`var SCAN_PIXEL_MODEL = ${JSON.stringify(pixelModel)};`,
		);
	}
	return lines.join("\n");
}

/** SCAN_FP_REFS var 语句序列化（scanFpRefsSerialize 的段内部分；
 *  段级无损替换写回单独替换本段时复用，口径保持一致） */
function scanFpRefsSectionLines(fpGroups) {
	const lines = ["var SCAN_FP_REFS = {"];
	fpGroups.forEach((list, key) => {
		if (!list.length) return;
		lines.push(`\t"${key}": [`);
		list.forEach((en) => lines.push(...scanFpRefEntryLines(en)));
		lines.push("\t],");
	});
	lines.push("};");
	return lines;
}
