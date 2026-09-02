# 法宝背包求解

纯网页端法宝背包布局求解工具：选好法宝、棋盘与权重后多线程搜索高分摆放方案，支持截图识别导入弟子棋盘。无构建、无外部依赖，浏览器直接打开 `index.html` 即可使用。

## 本项目说明

本仓库是基于 [gbcdby/knapsack-solver](https://github.com/gbcdby/knapsack-solver) 的个性化衍生版本。原作者为 `gbcdby`，原项目采用 Apache License 2.0，本仓库保留原项目的版权与许可证声明。

当前衍生修改包括邪系棋子及截图识别支持、实时布局的连续物品显示、白色物品分隔线、左右列表的可选显示列控制，以及绿/蓝/紫/金/红品质显示。法宝列表按占用格数升序显示，同格数下将相同形状相邻分组。

## 更新日志

### 2026-09-02

- 优化求解器与截图识别流程；同步法宝数据，并补充邪系棋子及截图识别支持。
- 相邻攻击加成支持带相邻作用域的多格法宝参与计算；拜火焚星笙按品质提供 `1%/1%/1%/2%` 相邻攻击加成。
- 加载本地方案时从当前法宝数据恢复形状、属性与加成，历史最优结果按新版评分口径自动失效。
- 入口页显示版本号；识别指纹数据使用版本参数，避免浏览器继续读取旧缓存。

### 2026-09-01

- 同步上游数据与识别支持，补充邪系棋子；法宝列表按占用格数升序、同格数下按完整形状分组。
- 新增相邻攻击加成：炎脉髓、玄黄令为绿/蓝/紫/金 `1%/2%/3%/4%`；拜火焚星笙为 `1%/1%/1%/2%`；蕴金戒调整为 `1%/2%/3%/5%`。

### 2026-08-13

- “计入相邻加成”默认关闭；开启后，带 `p` 标记的 1x1 相邻加成会进入总属性、历史最优有效性判断、Worker 评分、初始排序和深度搜索上界。切换到“深度”会自动将线程数设为设备支持的最大值。
- 品质显示统一为绿、蓝、紫、金、红；蕴金戒补充相邻攻击加成。
- 实时布局中，同一法宝连续格不显示内部格线，不同法宝之间保留白色分隔线；左右法宝列表可分别控制显示列。
- 优化求解器退火热路径并修正 LNS 失败缓存的布局标识；固定 7x6 满格基准下，单 Worker 三轮中位迭代速度由约 664,683 提升至约 1,638,854 次/秒。基准脚本：`node tools/bench/solver-perf-bench.js`。

## 数据产出流程

`index.html` 依赖的数据全部由 `tools/` 下工具产出到 `data/`（**请勿手改**），用 `<script src>` 引入：

```
① node tools/形状生成工具.js      →  data/shapes.json / shapes.data.js（SHAPES）
② node tools/文本图鉴转对象工具.js  →  data/blocks.json / blocks.data.js（BLOCKS）
③ tools/法宝图标指纹提取工具.html  →  data/scan-fp-refs.js（SCAN_DOT_TYPES + SCAN_FP_REFS）
```

- ①② 顺序固定（② 读取 ① 的产物）：分别修改脚本顶部的 `shapesObj` / `str` 后运行。`.json` 为数据留档，`.data.js` 供页面引入。
- ③ 为截图识别配置与图标指纹：由页面工具校准 + `tools/bench/` 回归重训，Chromium 系可直写文件，非 Chromium 复制输出**整体替换**该文件。

## 目录结构

```
├── index.html               ← 主页面
├── css/                     ← style.common.css（共用，须先引入）/ style.main.css / style.fp.css
├── script/
│   ├── main.index.js        ← index.html 主逻辑
│   ├── main.fp.js           ← 指纹提取工具主逻辑
│   ├── scan-core.js         ← 截图识别核心（页面两端与 bench 共用）
│   ├── scan-bench.js        ← 识别回放与评分（回放 tab 与 node bench 共用）
│   ├── scan-fp-io.js        ← scan-fp-refs.js 解析/序列化/段级写回
│   ├── opencv-loader.js     ← OpenCV 懒加载器
│   └── fp-pool.js / fp-worker.js  ← 批量流程 Web Worker 池
├── lib/opencv.js            ← opencv库，棋盘自动定位用
├── data/                    ← 全部自动生成，请勿手改
├── test_images/             ← 原始图库与 truth
└── tools/
    ├── 形状生成工具.js / 文本图鉴转对象工具.js   ← 改顶部数据后需要重新运行
    ├── 法宝图标指纹提取工具.html               ← 识别指纹管理工具，浏览器直接打开
    ├── test-fp-group.js     ← 工具页纯逻辑 Node 测试
    └── bench/               ← Node 端回归/校准管线（refs-section-io.js 为
                               scan-fp-refs.js 段级写回共用工具）
```

## 一、法宝数据生成

```bash
node tools/形状生成工具.js      # 生成 SHAPES
node tools/文本图鉴转对象工具.js  # 读取 shapes.json，生成 BLOCKS
```

产出的条目结构：`bonus`（加成类型/作用域）、`shape`（二维数组）、`value`（普通法宝 4 行品质 / 红法宝 1 行），以及可选的 `previewAdjacent`（1x1 相邻加成标记）。红法宝固定品质由 index.html 运行时派生，不在数据文件里。

## 布局目标与相邻加成

- 选择“填满优先”时，求解器先最大化占格数，再按攻/防/血权重最大化归一化属性分；“属性优先”则把占格作为次级目标。快速与深度均为限时启发式搜索，结果不保证数学上的全局最优。
- 自身加成参与求解评分。图鉴条目带 `p` 标记的 1x1 相邻加成，以及带相邻加成的多格法宝，在用户开启“计入相邻加成”后会折算到四向接触的同系法宝对应基础属性（伤害加成为攻击力），并计入总属性、排序、Worker 评分和深度搜索；同一件相邻法宝即使多边接触也只计算一次，多个提供者的百分比相加。
- 相邻加成默认关闭。后续新增同类法宝时，在法宝头行追加 `，p`，再重跑文本图鉴生成器。
- 改动相邻加成算法后运行 `node tools/test-adjacent-bonus.js`；它覆盖开关、单/多提供者叠加、跨系排除和多边接触去重。
- “深度”切换会把线程数设为 `max(4, navigator.hardwareConcurrency - 1)`；可在切换后手动调低。性能对比应固定同一棋盘、法宝、浏览器版本和 Worker 数量。

## 二、识别配置与图标指纹（截图识别校准）

校准分两侧：浏览器端 `tools/法宝图标指纹提取工具.html`（标注、提取、回放、入库），Node 端 `tools/bench/`（回归、校准、重训）。

### 总流程

```
① Node    node tools/形状生成工具.js && node tools/文本图鉴转对象工具.js   # 前置数据
② 浏览器  打开指纹提取工具，「原始图库」授权 test_images/ 目录
③ 浏览器  「真值标注」逐图标注 truth（直写 test_images/truth/）
④ 浏览器  「法宝名录」冲突组「进入提取」组级提取指纹；0 样本法宝「手动补图」
⑤ 浏览器  「回放验证」载入 truth + 截图跑识别评分
⑥ 浏览器  「元素校准」圆盘采样 + 簇分析校准 SCAN_DOT_TYPES 区间（采用/保存）
⑦ Node    按需跑回归 / 重训 / 批量重提指纹（见下）
⑧ 浏览器  「保存到数据文件」直写 data/scan-fp-refs.js
```

前置：先跑 ①；截图必须是**弟子棋盘截图**。工具页顶部显示"名录已加载"即正常，红色报错则重跑 ①。

首次打开截图导入时，页面按需加载本地 `lib/opencv.js`。若使用 CSP 限制脚本，`script-src` 必须保留 `blob:`、`'wasm-unsafe-eval'` 和 `'unsafe-eval'`：OpenCV 的 embind 运行时会使用 `new Function(...)` 生成绑定代码，缺少任一例外都会导致组件下载后初始化失败。

### 浏览器端操作要点

- **真值标注**：自动定位切格（失败可拖框微调），逐件点选棋子；歧义格自动后台预填。草稿存 localStorage。
- **组级提取**：truth+截图批量采样 → 逐卡剔除 → 按 名称+品质 中位数聚合 → 差分报告确认后入库。
- **回放验证**：与 index.html 完全相同的识别流水线；**写回数据文件前先跑一遍回归**，确认已有指纹无退化。
- **保存**：Chromium 系授权文件后「保存到数据文件」直写（段级替换，未改动段逐字节保留）；非 Chromium 复制输出整体替换。

### Node 端操作（项目根目录执行）

- `node tools/bench/bench.js run`：全量识别回归，产出 `tools/bench/out/report.json`
- `node tools/bench/bench.js compare`：对照基线报告逐项回归对比（下降标红）
- `node tools/bench/bench.js calib-dots`：SCAN_DOT_TYPES 区间校准（圆盘全像素采样 + hue 分水岭簇分析，产出两两零重叠建议区间；经交叠硬校验后 `--yes` 段级写回，交叠即拒绝）
- `node tools/bench/refingerprint.js`：批量重提全库指纹并收紧组 maxDiff
- `node tools/bench/solve-bench.js`：求解引擎无头回归（worker_threads 直跑 main.index.js 引擎段，多 seed 对比最优分分布）；`--src HEAD` 跑改动前基线，改动求解算法后用它出前后对比数据
- **模型重训**（SCAN_DOT_TYPES 区间变更入库后必做）：
  ```bash
  node tools/bench/dump-feats.js && node tools/bench/bench.js calib-types && \
  node tools/bench/dump-pixels.js && node tools/bench/bench.js calib-pixel
  ```
  calib-types / calib-pixel 训练结束打印决策摘要并询问是否段级写回 `data/scan-fp-refs.js`
  （默认 N，只出 `tools/bench/out/` 产物；`--yes` 跳过确认直写，`--no-write` 非交互场景用）。
- `node tools/test-fp-group.js`：工具页纯逻辑测试，改动工具页逻辑后跑一遍

## 三、文本图鉴格式

- 大类名（金/木/水/火/土/雷/邪/体）单独成行，`===` 结束当前大类；`---` 分割普通法宝和红法宝（先普通后红）
- 法宝头行：`名称，形状代号[，作用域[，加成类型[，布局预估]]]`
  - 形状代号：格数数字 + 形状字母（`一` 横排、`i` 竖排、`j` J形、`o` 正方形、`p` P形、`z` 折线，`f` 前缀表反转，纯数字为"点"）；可用组合以 `shapesObj` 为准
  - 作用域：`z` 自身、`l` 相邻，**留空 = 无加成**；加成类型：`a` 攻击、`d` 防御、`h` 血量，留空默认 `a`；相邻计算：`p` 标记可让 1x1 相邻加成在用户开启对应开关后参与实时布局和求解评分
- 数值行：`攻击，防御，血量[，加成值]`，空值按 0 计；普通法宝 4 行（绿→蓝→紫→金），红法宝 1 行
  - **填了作用域的法宝每行都必须填加成值**，无加成的不写第 4 列

## 注意事项

- 有任何警告（缺行、重名、未知代号等）都视为数据有误：脚本不写文件并删除旧的 blocks 数据，修好源文本再重跑。
- 形状有增删时，先重新生成 shapes.json，再跑图鉴脚本。
- `shapes.data.js` / `blocks.data.js` 缺失时 index.html 报错提示重新生成；`scan-fp-refs.js` 缺失不报错，识别配置退回内置默认值。
