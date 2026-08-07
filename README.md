# 法宝背包求解

纯网页端法宝背包布局求解工具：选好法宝、棋盘与权重后多线程搜索得分最高的摆放方案，支持截图识别导入弟子棋盘。无构建、无外部依赖，浏览器直接打开 `index.html` 即可使用。

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

产出的条目结构：`bonus`（加成类型/作用域）、`shape`（二维数组）、`value`（普通法宝 4 行品质 / 红法宝 1 行）。红法宝固定品质由 index.html 运行时派生，不在数据文件里。

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
- 法宝头行：`名称，形状代号[，作用域[，加成类型]]`
  - 形状代号：格数数字 + 形状字母（`一` 横排、`i` 竖排、`j` J形、`o` 正方形、`p` P形、`z` 折线，`f` 前缀表反转，纯数字为"点"）；可用组合以 `shapesObj` 为准
  - 作用域：`z` 自身、`l` 相邻，**留空 = 无加成**；加成类型：`a` 攻击、`d` 防御、`h` 血量，留空默认 `a`
- 数值行：`攻击，防御，血量[，加成值]`，空值按 0 计；普通法宝 4 行（绿→蓝→紫→金），红法宝 1 行
  - **填了作用域的法宝每行都必须填加成值**，无加成的不写第 4 列

## 注意事项

- 有任何警告（缺行、重名、未知代号等）都视为数据有误：脚本不写文件并删除旧的 blocks 数据，修好源文本再重跑。
- 形状有增删时，先重新生成 shapes.json，再跑图鉴脚本。
- `shapes.data.js` / `blocks.data.js` 缺失时 index.html 报错提示重新生成；`scan-fp-refs.js` 缺失不报错，识别配置退回内置默认值。
