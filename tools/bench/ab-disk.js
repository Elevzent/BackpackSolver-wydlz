/**
 * 圆盘 vs 16 点环 信号级 A/B 工具（只出报告不改识别逻辑）：对全量 truth 图
 * 逐格对比「dot 有无 + 类型投票」信号层——环基线取现行 judgeDot 纯投票口径
 * （多数票 + 票数/连续段 ≥dotHits，不含判定链补救层），圆盘走 sampleDisk 投票
 * + scanDiskJudge 闸门（dotDiskHits / dotDiskRivalMax / dotDiskGlyphMin）。
 * 报告真锚点回退（要求 0）/ 救回、非锚点假 dot 对比（要求不增）、逐型分布与
 * dotDisk* 阈值扫描。产物：out/ab-disk-report.json + ab-disk-summary.txt。
 * 用法：node tools/bench/ab-disk.js
 */
const fs = require("fs");
const path = require("path");
const {
	IMG_DIR,
	TRUTH_DIR,
	OUT_DIR,
	loadScanCore,
	loadCv,
	readPng,
	resizeBilinear,
	sliceCell,
} = require("./lib/core.js");

function quant(sorted, q) {
	if (!sorted.length) return null;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function distSummary(vals) {
	const a = vals.slice().sort((x, y) => x - y);
	return {
		n: a.length,
		min: a[0] ?? null,
		p5: Math.round(quant(a, 0.05) * 10) / 10,
		p50: Math.round(quant(a, 0.5) * 10) / 10,
		p95: Math.round(quant(a, 0.95) * 10) / 10,
		p99: Math.round(quant(a, 0.99) * 10) / 10,
		max: a[a.length - 1] ?? null,
	};
}

/** 阈值扫描用闸门：与 scanDiskJudge 规则逐条一致，阈值显式传参 */
function diskGate(dk, ranges, hits, rivalMax, glyphMin) {
	let dotType = null;
	let top = 0;
	ranges.forEach(([, , t]) => {
		const n = dk.votes[t] || 0;
		if (n > top) {
			top = n;
			dotType = t;
		}
	});
	if (!dotType || top < hits) return null;
	const rival = Object.entries(dk.votes).reduce(
		(mx, [t, n]) => (t === dotType ? mx : Math.max(mx, n)),
		0,
	);
	if (rival > rivalMax) return null;
	if (dk.glyphFrac < glyphMin) return null;
	return dotType;
}

(async () => {
	loadScanCore();
	const cv = await loadCv();
	const N = globalThis.SCAN_CELL_SIZE;
	const DW = globalThis.SCAN_DETECT_WIDTH;
	const REC = globalThis.SCAN_REC;
	const RANGES = globalThis.SCAN_DOT_TYPES;

	const files = fs
		.readdirSync(TRUTH_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.filter((f) => fs.existsSync(path.join(IMG_DIR, f)))
		.sort();

	const recs = [];
	const skipped = [];
	for (const file of files) {
		const truth = JSON.parse(
			fs.readFileSync(path.join(TRUTH_DIR, `${file}.json`), "utf8"),
		);
		const { cols, rows, pieces } = truth;
		const png = readPng(path.join(IMG_DIR, file));
		const img = { data: png.data, width: png.width, height: png.height };
		const scale = DW / img.width;
		const dh = Math.round(img.height * scale);
		const small = resizeBilinear(img.data, img.width, img.height, DW, dh);
		const rect = globalThis.scanDetectBoard(
			cv,
			{ data: small, width: DW, height: dh },
			cols,
			rows,
		);
		if (!rect) {
			skipped.push(file);
			continue;
		}
		const full = {
			L: rect.L / scale,
			T: rect.T / scale,
			R: rect.R / scale,
			B: rect.B / scale,
		};
		const cw = (full.R - full.L) / cols;
		const ch = (full.B - full.T) / rows;
		const anchors = {};
		const occupied = {};
		const anchorOff = {};
		pieces.forEach((p) => {
			p.cells.forEach(([r, c]) => {
				occupied[r + "," + c] = p.type;
			});
			const akey = p.anchor[0] + "," + p.anchor[1];
			anchors[akey] = p.type;
			if (p.dotOff || p.dotR)
				anchorOff[akey] = { off: p.dotOff || [0, 0], dotR: p.dotR || 0 };
		});
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const key = r + "," + c;
				const cell = sliceCell(img, full.L + cw * c, full.T + ch * r, cw, ch, N);
				const ao = anchorOff[key];
				const ox = ao ? ao.off[0] : 0;
				const oy = ao ? ao.off[1] : 0;
				const samp = globalThis.scanDotSamplers(cell, RANGES);

				// 环基线：纯投票部分（多数票 + 票数/连续段 ≥dotHits）
				const f0 = samp.sampleDot(ox, oy);
				let ringType = null;
				let ringTop = 0;
				RANGES.forEach(([, , t]) => {
					const n = (f0.dotVotes[t] || []).length;
					if (n > ringTop) {
						ringTop = n;
						ringType = t;
					}
				});
				const ringRunN = ringType ? samp.ringRun(f0, ringType) : 0;
				const ringVerdict =
					ringType && ringTop >= REC.dotHits && ringRunN >= REC.dotHits
						? ringType
						: null;

				// 圆盘：sampleDisk + scanDiskJudge（当前 SCAN_REC 阈值）
				const dk = samp.sampleDisk(ox, oy);
				let diskType = null;
				let diskTop = 0;
				RANGES.forEach(([, , t]) => {
					const n = dk.votes[t] || 0;
					if (n > diskTop) {
						diskTop = n;
						diskType = t;
					}
				});
				const diskRival = Object.entries(dk.votes).reduce(
					(mx, [t, n]) => (t === diskType ? mx : Math.max(mx, n)),
					0,
				);
				const diskVerdict = globalThis.scanDiskJudge(dk, RANGES);

				recs.push({
					file,
					r,
					c,
					role: anchors[key]
						? `anchor:${anchors[key]}`
						: occupied[key]
							? `cell:${occupied[key]}`
							: "empty",
					ringType,
					ringTop,
					ringRun: ringRunN,
					ringVerdict,
					diskType,
					diskTop,
					diskRival,
					diskVerdict,
					glyphFrac: dk.glyphFrac,
					votes: { ...dk.votes },
				});
			}
		}
	}

	/* ---- A/B 对比 ---- */
	const at = (r) => r.role.startsWith("anchor:") && r.role.slice(7);
	const anchorRecs = recs.filter((r) => r.role.startsWith("anchor:"));
	const negRecs = recs.filter((r) => !r.role.startsWith("anchor:"));
	const pos = (r) => `${r.file} (${r.r},${r.c})`;

	// 回退 = 环判对而圆盘未同型判对；救回 = 环判负而圆盘判对。
	// 体锚点单独统计：灰徽标 hue 无效，圆盘信号层恒判负属预期（体走独立路径）
	const tiAnchors = anchorRecs.filter((r) => at(r) === "体");
	const hueAnchors = anchorRecs.filter((r) => at(r) !== "体");
	const regressions = hueAnchors.filter(
		(r) => r.ringVerdict === at(r) && r.diskVerdict !== at(r),
	);
	const rescues = hueAnchors.filter(
		(r) => r.ringVerdict !== at(r) && r.diskVerdict === at(r),
	);
	const diskAnchorMiss = hueAnchors.filter((r) => r.diskVerdict !== at(r));
	// 非锚点假 dot：数量对比 + 新增清单（圆盘判有而环未判有）
	const ringFalse = negRecs.filter((r) => r.ringVerdict);
	const diskFalse = negRecs.filter((r) => r.diskVerdict);
	const newFalse = negRecs.filter((r) => r.diskVerdict && !r.ringVerdict);

	/* ---- 阈值扫描 ---- */
	// 口径与 scanDiskJudge 一致；rivalMax=999 相当于关闭异型票闸门
	const HITS = [15, 18, 20, 23];
	const GLYPHS = [0.1, 0.13, 0.2, 0.3, 0.4];
	const RIVALS = [35, 999];
	const ringOkAnchors = hueAnchors.filter((r) => r.ringVerdict === at(r));
	const sweep = [];
	for (const hits of HITS) {
		for (const glyphMin of GLYPHS) {
			for (const rivalMax of RIVALS) {
				let reg = 0;
				let miss = 0;
				let falseN = 0;
				for (const r of hueAnchors) {
					const v = diskGate(r, RANGES, hits, rivalMax, glyphMin);
					if (v !== at(r)) {
						miss++;
						if (r.ringVerdict === at(r)) reg++;
					}
				}
				for (const r of negRecs) {
					if (diskGate(r, RANGES, hits, rivalMax, glyphMin)) falseN++;
				}
				sweep.push({ hits, glyphMin, rivalMax, reg, miss, falseN });
			}
		}
	}

	/* ---- 汇总输出 ---- */
	const L = [];
	const out = (s) => {
		L.push(s);
		console.log(s);
	};
	const anchorTypes = [...new Set(anchorRecs.map((r) => r.role.slice(7)))].sort();

	out(`格子总数 ${recs.length}，跳过 ${skipped.length} 张图${skipped.length ? "：" + skipped.join("、") : ""}`);
	out(
		`当前闸门：dotDiskBgDist=${REC.dotDiskBgDist} dotDiskHits=${REC.dotDiskHits} ` +
			`dotDiskRivalMax=${REC.dotDiskRivalMax} dotDiskGlyphMin=${REC.dotDiskGlyphMin}`,
	);
	out(`环基线口径：多数票 ≥dotHits(${REC.dotHits}) 且最长连续段 ≥dotHits（纯投票）`);

	out("\n========== 真锚点 A/B（非体 n=" + hueAnchors.length + "；体 " + tiAnchors.length + " 个 hue 无效走独立路径，信号层恒判负属预期） ==========");
	out(
		`环判对 ${ringOkAnchors.length}；圆盘判对 ${hueAnchors.length - diskAnchorMiss.length}；` +
			`回退 ${regressions.length}（要求 0）；漏判 ${diskAnchorMiss.length}；救回 ${rescues.length}`,
	);
	if (regressions.length) {
		out("回退清单：");
		regressions.forEach((r) =>
			out(
				`  ${pos(r)} ${at(r)} 环 ${r.ringTop}票/run${r.ringRun} → 圆盘 ` +
					`${r.diskVerdict || "负"}（本型 ${r.votes[at(r)] || 0} 异型max ${r.diskRival} glyph ${r.glyphFrac.toFixed(2)}）`,
			),
		);
	}
	out("\n========== 非锚点格假 dot（n=" + negRecs.length + "） ==========");
	out(
		`环基线假 dot ${ringFalse.length}；圆盘假 dot ${diskFalse.length}` +
			`（要求不增）；其中新增（环负圆盘中）${newFalse.length}`,
	);
	if (newFalse.length) {
		out("新增假 dot 清单（前 30 条）：");
		newFalse.slice(0, 30).forEach((r) =>
			out(
				`  ${pos(r)} ${r.role} → 圆盘判 ${r.diskVerdict}（票 ${r.diskTop} 异型max ${r.diskRival} glyph ${r.glyphFrac.toFixed(2)}）`,
			),
		);
	}

	out("\n========== 逐型分布（圆盘口径） ==========");
	for (const t of anchorTypes) {
		const own = anchorRecs.filter((r) => r.role === `anchor:${t}`).map((r) => r.votes[t] || 0);
		const rival = anchorRecs
			.filter((r) => r.role === `anchor:${t}`)
			.map((r) => r.diskRival);
		const glyph = anchorRecs.filter((r) => r.role === `anchor:${t}`).map((r) => r.glyphFrac);
		const d = distSummary(own);
		const dr = distSummary(rival);
		const dg = distSummary(glyph.map((x) => Math.round(x * 100)));
		out(
			`[${t}] 本型票 min=${d.min} p5=${d.p5} p50=${d.p50} | 异型票 p95=${dr.p95} max=${dr.max} | glyphFrac(×100) min=${dg.min} p5=${dg.p5}`,
		);
	}
	const negTop = distSummary(negRecs.map((r) => r.diskTop));
	const negGlyph = distSummary(negRecs.map((r) => Math.round(r.glyphFrac * 100)));
	out(`非锚点格 圆盘最高票 ${JSON.stringify(negTop)} glyphFrac(×100) ${JSON.stringify(negGlyph)}`);

	out("\n========== 阈值扫描（reg=真锚点回退 miss=圆盘锚点未判对 falseN=非锚点假 dot；基线：环判对 " + ringOkAnchors.length + " / 环假 dot " + ringFalse.length + "） ==========");
	out("hits\tglyphMin\trivalMax\treg\tmiss\tfalseN");
	sweep.forEach((s) =>
		out(`${s.hits}\t${s.glyphMin}\t${s.rivalMax}\t${s.reg}\t${s.miss}\t${s.falseN}`),
	);

	fs.writeFileSync(
		path.join(OUT_DIR, "ab-disk-report.json"),
		JSON.stringify(
			{
				gate: {
					dotDiskBgDist: REC.dotDiskBgDist,
					dotDiskHits: REC.dotDiskHits,
					dotDiskRivalMax: REC.dotDiskRivalMax,
					dotDiskGlyphMin: REC.dotDiskGlyphMin,
				},
				totals: {
					cells: recs.length,
					anchors: anchorRecs.length,
					neg: negRecs.length,
					ringOk: ringOkAnchors.length,
					regressions: regressions.length,
					rescues: rescues.length,
					ringFalse: ringFalse.length,
					diskFalse: diskFalse.length,
					newFalse: newFalse.length,
				},
				sweep,
				regressions,
				newFalse,
				recs,
			},
			null,
			1,
		),
	);
	fs.writeFileSync(path.join(OUT_DIR, "ab-disk-summary.txt"), L.join("\n") + "\n");
	console.log(`\n产物：${path.join(OUT_DIR, "ab-disk-report.json")} / ab-disk-summary.txt`);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
