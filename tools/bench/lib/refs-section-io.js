/**
 * data/scan-fp-refs.js 段级写回工具（node 侧，bench / refingerprint 共用）：
 * 文本级局部替换——只动目标段（段头注释锚点 → var 语句结束），其余段一字节不动，
 * 保住各段头部的人工校准依据注释（已排除整文重序列化方案：scan-fp-io.js 那条路
 * 会把这些注释压成通用说明行）。
 *
 * - replaceSectionText           纯函数：定位并替换，返回新全文；
 * - writeFileAtomic              临时文件 + rename 原子落盘；
 * - verifyRefsVar                写后整文 vm 解析冒烟 + 目标 var 存在性检查；
 * - writeRefsSectionInteractive  决策摘要 + 确认 + 写回一条龙
 *   （--yes 直写 / --no-write 跳过 / 非 TTY 默认跳过；交互默认 N）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const readline = require("readline");
const { execSync } = require("child_process");

/**
 * 段定位替换。锚点：startMarker（段头注释首行，如 "// SCAN_TYPE_MODEL："）、
 * varMarker（"var X = "）；endMarker 从 varMarker 起找：
 * - inclusiveEnd=true：段尾含 endMarker（多行对象段，endMarker "\n};"）；
 * - inclusiveEnd=false：endMarker 仅作边界、保留在原位（单行 var 段，
 *   endMarker "\n" 界定行尾；文件末尾无换行时取 EOF）。
 * appendIfMissing：段整体不存在时追加到文件末尾（模型段被软守卫移除后的重挂）。
 */
function replaceSectionText(
	text,
	{ startMarker, varMarker, endMarker, inclusiveEnd = true, newBlock, appendIfMissing = false },
) {
	const start = text.indexOf(startMarker);
	const varAt = text.indexOf(varMarker);
	if (start < 0 && varAt < 0 && appendIfMissing) {
		const sep = text.endsWith("\n") ? "" : "\n";
		return `${text}${sep}//\n${newBlock}\n`;
	}
	if (start < 0 || varAt < 0 || start > varAt) {
		throw new Error(`${varMarker} 段定位失败，未写回`);
	}
	let endAt = text.indexOf(endMarker, varAt);
	if (endAt < 0) {
		if (inclusiveEnd) throw new Error(`${varMarker} 段尾定位失败，未写回`);
		endAt = text.length;
	}
	const end = inclusiveEnd ? endAt + endMarker.length : endAt;
	return text.slice(0, start) + newBlock + text.slice(end);
}

/** 原子写：同目录临时文件 + rename（中途崩溃最多留临时文件，不会截断数据源） */
function writeFileAtomic(filePath, content) {
	const tmp = `${filePath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmp, content);
		fs.renameSync(tmp, filePath);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw e;
	}
}

/** 写后冒烟：整文在新 vm 上下文解析执行（同浏览器 <script src> 口径），目标 var 须在 */
function verifyRefsVar(refsPath, varName) {
	const code = fs.readFileSync(refsPath, "utf8");
	const ctx = vm.createContext({});
	vm.runInContext(code, ctx, { filename: path.basename(refsPath) });
	if (!ctx[varName]) {
		throw new Error(`写回后 ${varName} 缺失（整文解析冒烟未过），请检查 ${refsPath}`);
	}
}

/** 写回方式：--yes 直写 / --no-write 跳过 / 其余看 TTY——非交互默认跳过 */
function resolveWriteMode(argv) {
	const yes = argv.includes("--yes");
	const no = argv.includes("--no-write");
	if (yes && no) throw new Error("--yes 与 --no-write 不能同时使用");
	if (yes) return "yes";
	if (no) return "no";
	return process.stdin.isTTY ? "ask" : "no";
}

/** git 脏检查（仅用于提示；git 不可用静默跳过） */
function gitDirtyNote(refsPath) {
	try {
		const root = execSync(
			`git -C ${JSON.stringify(path.dirname(refsPath))} rev-parse --show-toplevel`,
			{ stdio: ["ignore", "pipe", "ignore"] },
		)
			.toString()
			.trim();
		const rel = path.relative(root, refsPath);
		const out = execSync(
			`git -C ${JSON.stringify(root)} status --porcelain -- ${JSON.stringify(rel)}`,
			{ stdio: ["ignore", "pipe", "ignore"] },
		)
			.toString()
			.trim();
		return out ? "  　　　注意：该文件当前有未提交改动，写回将叠加其上；" : "";
	} catch {
		return "";
	}
}

function askConfirm(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (ans) => {
			rl.close();
			resolve(/^y(es)?$/i.test(ans.trim()));
		});
	});
}

/**
 * 训练产物写回一条龙：打印决策摘要 → 按 --yes/--no-write/TTY 决定 → 段级
 * 替换 + 原子写 + 冒烟。返回是否已写回。段定位参数同 replaceSectionText，
 * 另加 refsPath / varName / summaryLines（决策摘要行）。
 */
async function writeRefsSectionInteractive(opts) {
	const { refsPath, varName, summaryLines = [] } = opts;
	console.log("\n========== 写回决策 ==========");
	summaryLines.forEach((l) => console.log(`  ${l}`));
	console.log(
		`  目标：${path.relative(process.cwd(), refsPath)} 的 ${varName} 段（段头注释随本次运行整块重生成，`,
	);
	console.log("  　　　段内人工补充会丢失，可从 git diff 找回）");
	const dirty = gitDirtyNote(refsPath);
	if (dirty) console.log(dirty);

	const mode = resolveWriteMode(process.argv);
	if (mode === "no") {
		console.log("  未写回（默认）。产物见上方 out/ 路径；确认后可重跑加 --yes 或手动替换");
		return false;
	}
	if (mode === "ask" && !(await askConfirm(`  写回 ${varName} 段？[y/N] `))) {
		console.log("  已取消，未写回");
		return false;
	}
	const text = fs.readFileSync(refsPath, "utf8");
	const next = replaceSectionText(text, opts);
	writeFileAtomic(refsPath, next);
	verifyRefsVar(refsPath, varName);
	console.log(`  已写回 ${varName} 段（段级替换，其余段未动；整文解析冒烟通过）。git diff 核对后提交`);
	return true;
}

module.exports = {
	replaceSectionText,
	writeFileAtomic,
	verifyRefsVar,
	resolveWriteMode,
	writeRefsSectionInteractive,
};
