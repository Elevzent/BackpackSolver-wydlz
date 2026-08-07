/**
 * bench.js calib-types / calib-pixel 的 CV worker（由 parallel.js fork，不直接运行）：
 * init 加载识别核心并接收全量样本一次，之后每条任务训练一折（按图留一）并返回出折预测。
 * 折间天然独立：类型树模型无随机状态；像素 MLP 每次 scanTrainPixelMlp 内部自建种子
 * RNG（默认 20260804），不共享随机流——并行只改调度不改数学，预测按折序重组后与
 * 串行 scanCvTypeModel / scanCvPixelModel 逐字节一致。
 * 任务 payload：{ mode: "types"|"pixel", group, opts }；空训练/测试折返回 []（同串行 continue）。
 */
const { workerLoop } = require("../lib/parallel.js");
const { loadScanCore } = require("../lib/core.js");

workerLoop(
	(init) => {
		loadScanCore();
		return { samples: init.samples };
	},
	(ctx, task) => {
		const { mode, group, opts } = task;
		const train = ctx.samples.filter((s) => s.group !== group);
		const test = ctx.samples.filter((s) => s.group === group);
		if (!train.length || !test.length) return [];
		if (mode === "pixel") {
			const model = globalThis.scanTrainPixelMlp(train, opts);
			return test.map((s) => {
				const sc = globalThis.scanMlpScore(model, s.x);
				return {
					group: s.group,
					label: s.label,
					meta: s.meta,
					best: sc.best,
					bestScore: sc.bestScore,
					second: sc.second,
					margin: sc.margin,
					probs: sc.probs,
				};
			});
		}
		const model = globalThis.scanTrainTypeModel(train, opts);
		return test.map((s) => {
			const sc = globalThis.scanTypeModelScore(model, s.feats);
			return {
				file: s.file,
				r: s.r,
				c: s.c,
				role: s.role,
				label: s.label,
				best: sc.best,
				bestScore: sc.bestScore,
				second: sc.second,
				margin: sc.margin,
			};
		});
	},
);
