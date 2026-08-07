# tools/bench —— 识别流水线回归/校准工具集

node 端批量工具，识别逻辑复用 `script/scan-core.js`（`vm.runInThisContext` 挂
`globalThis`，等同浏览器 `<script src>`），与生产口径一致。均在**项目根目录**执行。
并行命令的并发数默认 `os.cpus()-2`，环境变量 `BENCH_JOBS` 覆盖（`=1` 退化串行）。

## 目录结构

```
bench.js            主入口：run / compare / calib-dots / calib-types / calib-pixel
refingerprint.js    全库指纹重提（段级写回 data/scan-fp-refs.js）
ab-disk.js          圆盘 vs 16 点环信号级 A/B（只出报告）
dump-feats.js       灰区特征转储 → out/feat-dump.json
dump-pixels.js      像素转储 → out/pixel-dump/
eval-dot-locate.js  scanLocateDot 全库评估（先决：dump-pixels）
eval-dot-recog.js   scanCellFeat dot 判定 A/B 评估（先决：dump-pixels）

lib/                公共模块（不直接运行）
  core.js           共享基建：路径常量、loadScanCore/loadCv、readPng、重采样包装
  parallel.js       进程池调度（resolveJobs / runPool / workerLoop）
  progress.js       终端进度条
  refs-section-io.js data/scan-fp-refs.js 段级写回

workers/            fork 专用 worker（由 parallel.js 启动，不直接运行）
  image-worker.js   bench run / calib-dots / refingerprint 按图 worker
  calib-worker.js   calib-types / calib-pixel 折 worker
  dump-worker.js    dump-feats / dump-pixels 按图 worker

out/                全部产物（报告、转储、逐图结果；已 gitignore）
```

## 常用命令

```bash
node tools/bench/bench.js run         # 全量识别回归 → out/<图名>.json
node tools/bench/bench.js compare     # 对照 truth 评分 → out/report.json
node tools/bench/bench.js calib-dots [--skip-marginal] [--yes|--no-write]
node tools/bench/bench.js calib-types [fpBudget=5] [--yes|--no-write]
node tools/bench/bench.js calib-pixel [--yes|--no-write]
node tools/bench/refingerprint.js [--no-write]
node tools/bench/ab-disk.js
node tools/bench/dump-feats.js
node tools/bench/dump-pixels.js
node tools/bench/eval-dot-locate.js
node tools/bench/eval-dot-recog.js --save out/recog-dump-base.json   # 存基线
node tools/bench/eval-dot-recog.js --diff out/recog-dump-base.json   # 对比
```

依赖：`npm install`（本目录，仅 pngjs）。各命令的详细说明见对应文件头注释。
