/**
 * 命令行进度条（bench 各并行命令共用）：
 * - TTY 下单行覆盖刷新（cursorTo + clearLine，兼容中文宽字符），显示 完成数/总数、
 *   百分比、bar、已耗时、ETA、最近完成项；行宽超终端列数时按显示宽度截断（宽字符
 *   计 2）——折行会让 cursorTo(0) 只回到末行，进度条退化成逐行刷屏；
 * - 非 TTY（重定向 / CI）退化为每 5% 打一行普通日志，避免控制字符污染日志。
 * 用法：
 *   const bar = new ProgressBar({ total, label: "run 识别" });
 *   ... onTaskDone: (i, r) => bar.tick(r.file)
 *   bar.done();  // 收尾换行，之后可正常 console.log
 */
/** 终端显示宽度：CJK 等宽字符计 2，其余（含 █/░/│）计 1 */
function dispWidth(s) {
	let w = 0;
	for (const ch of s) w += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
	return w;
}

/** 按显示宽度截断（不劈开宽字符） */
function fitWidth(s, max) {
	let w = 0;
	let out = "";
	for (const ch of s) {
		const cw = ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
		if (w + cw > max) break;
		w += cw;
		out += ch;
	}
	return out;
}

class ProgressBar {
	constructor({ total, label = "", width = 24 }) {
		this.total = total;
		this.label = label;
		this.width = width;
		this.doneCnt = 0;
		this.t0 = Date.now();
		this.tty = !!process.stdout.isTTY;
		this.lastLogBucket = -1;
		this.finished = false;
		this._render("");
	}

	/** 完成一项；info 为可选的最近完成项说明（如文件名） */
	tick(info) {
		if (this.finished) return;
		this.doneCnt++;
		this._render(info || "");
	}

	/** 收尾：补到 100% 并换行，后续 console.log 从新行开始 */
	done(info) {
		if (this.finished) return;
		this.finished = true;
		this.doneCnt = this.total;
		if (this.tty) {
			this._render(info || "");
			process.stdout.write("\n");
		} else {
			this._render(info || "");
		}
	}

	_render(info) {
		const pct = this.total ? this.doneCnt / this.total : 1;
		const el = (Date.now() - this.t0) / 1000;
		const eta =
			this.doneCnt > 0 && this.doneCnt < this.total
				? (el / this.doneCnt) * (this.total - this.doneCnt)
				: null;
		const filled = Math.round(pct * this.width);
		const bar = "█".repeat(filled) + "░".repeat(this.width - filled);
		let line =
			`${this.label} [${bar}] ${this.doneCnt}/${this.total}` +
			` (${(pct * 100).toFixed(0)}%) 耗时 ${el.toFixed(0)}s`;
		if (eta !== null) line += ` ETA ~${eta.toFixed(0)}s`;
		if (info) line += ` │ ${info}`;
		if (this.tty) {
			const cols = process.stdout.columns || 80;
			line = fitWidth(line, cols - 1);
			process.stdout.cursorTo(0);
			process.stdout.clearLine(0);
			process.stdout.write(line);
		} else {
			// 非 TTY：每 5% 一桶，跨桶或收尾时打一行
			const bucket = Math.floor(pct * 20);
			if (bucket !== this.lastLogBucket || this.finished) {
				this.lastLogBucket = bucket;
				console.log(line);
			}
		}
	}
}

module.exports = { ProgressBar };
