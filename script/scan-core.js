/**
 * 截图识别核心：index.html（截图导入）与 tools/法宝图标指纹提取工具.html 共用。
 * 两端通过 <script src> 引入，全部以 var / function 挂到全局。
 *
 * 内容：
 *   - 几何常量（SCAN_CELL_SIZE / SCAN_DETECT_WIDTH；阈值参数 SCAN_REC 与
 *     SCAN_DOT_TYPES / SCAN_FP_REFS / SCAN_TYPE_MODEL 统一在 data/scan-fp-refs.js 维护）
 *   - 基础像素工具（RGB->HSV / 品质分类 / 边缘带下标）
 *   - 单格特征与签名（scanCellFeat / scanDotHues / scanLocateDot /
 *     scanCellQualityVote / scanCellBg / scanCellSig / scanCellSigLegacy）
 *   - 灰区统计分类器（scanCellTypeFeats / scanCellGrayFeats / scanTypeModelScore，
 *     集成与校准依据见下方「灰区统计分类器」注释块）
 *   - 棋子识别流水线（SCAN_SHAPE_LIST / scanCellIconMask / scanCandCont /
 *     scanGenCandidates / scanPack / scanPieceFp / scanPieceSig / scanFpDiff / scanNamePiece）
 *   - 共享重采样（scanResampleBilinear，浏览器与 node bench 同一双线性实现）
 *   - 棋盘定位与切格（scanDetectBoard / scanMakeDetectImage / scanSliceCells）
 *   - 棋子缩略图（scanPieceThumb）
 *
 * 签名算法约定（提取端与识别端必须一致，故集中在此维护）：
 *   - 每格归一化为 SCAN_CELL_SIZE²。
 *   - 底色估计：取格子边缘带（SCAN_BAND_IDX 规则）像素 RGB 中位数。
 *   - sig（scanPieceSig，现行匹配口径）：每格 4×4 块，块内只统计「图标像素」（与底色
 *     RGB 差的绝对值之和 > SCAN_REC.iconDiff），块均值为该块签名；图标像素
 *     < SCAN_REC.iconMinPx 的块记 null（匹配时跳过）。
 *   - sigLegacy（scanPieceFp）：每格 2×2 象限全像素均值，占用格按行优先展开；
 *     2026-08-05 前为匹配口径，现仅供无 sig 的旧指纹条目回退。
 *   - 空格判定：边缘带暗像素占比为主，图标像素数（SCAN_REC.emptyIconPx）兜底
 *     ——带品质底色的漩涡空格会骗过暗底判定，但凑不够真占用格的图标像素量。
 *
 * 元素徽标（圆点）检测约定（scanCellFeat，阈值校准依据见 SCAN_REC 注释）：
 *   - 彩色元素（金/木/水/土/雷）：环上 16 点按 SCAN_DOT_TYPES hue 区间投票
 *     （归属口径 scanDotHueTypes：雷 [144,180) 与火 [174,9] 的 175-179 重叠段
 *     对两类各记一票，其余区间交叠维持首命中；2026-08-05 策略 B），多数票
 *     定类型（并列取 ranges 序靠前者）；dot=true 需同时满足 票数≥dotHits、
 *     环上最长连续段≥dotHits
 *     （真徽标覆盖连续弧，图标碎片票分散）、环主色与底色 HSV 距离≥dotBgDist、
 *     内盘暗纹占比≥dotGlyphDark（雷走分类型阈值 dotLeiGlyphDark），及分类型
 *     防伪（金/木/土/火各一条，见代码）；2026-08-07 Step 3 起叠加圆盘数量门
 *     （judgeDisk = judgeDot + diskOk：圆盘本型票≥dotDiskHits、异型票
 *     ≤dotDiskRivalMax、暗纹占比≥dotDiskGlyphMin，叠加理由与依据见下方
 *     「圆盘全像素采样」注释块）。
 *   - 体（灰色徽标 hue 无效）：专属路径「低饱和灰盘 + 亮度两档（亮灰/深灰）+
 *     暗纹 + 亮度双峰 std」，与彩色路径互斥（彩色判不出才尝试）。
 *   - 几何定位引导（2026-08-07，scanLocateDot 边缘域同心双圆定位）：规范位
 *     彩色/强票/体路径全负且环上留有残票（≥2）时跑几何定位，核验通过且
 *     圆心显著偏离规范位即在定位环心重采样判定；只增不替——定位失败落回
 *     邻域盲搜兜底（否决策略实测亏 TP：定位盲区恰是兜底路径的主战场）。
 *   - 棋盘定位（scanDetectBoard）：主路径失败后按放宽参数兜底重试；
 *     两轴吸附步长不一致时做双向交叉验证选胜者网格；拟合结果须通过
 *     方形校验与格距合理性校验，否则判失败（宁可交人工）；最后做相位校正
 *     ——稀疏占用时网格可整行/整列平移而 inlier 不变，用 ±1 行/列相位变体
 *     按 inlier → edge（SCAN_REC.phaseEdgeMin 余量）裁决换回正确相位。
 *     最后一组兜底（稀疏模式 clusterFilter/phaseFix）针对极空盘：成团过滤
 *     剔除孤立噪点、斑块边长约束格距下限、棋盘外推相位逐行校准。
 *
 * 灰区统计分类器（scanCellTypeFeats / scanCellGrayFeats 特征 + scanTypeModelScore
 *   打分 + SCAN_TYPE_MODEL 模型，特征 2026-08-04 新增、模型兜底同日集成）：
 *   - 用途：规则快路径（规范位彩色/强票补救/体路径/几何定位引导/邻域闸门）
 *     全部判负的
 *     「灰区」格子，交给 truth 图库训练的统计模型兜底打分（金/木/水/火/土/体
 *     vs 负样本），主攻土同色徽标、体/火无票等规则链硬伤漏检。
 *   - 集成（scanCellFeat 末尾）：全路径判负（含空格兜底抹除）后才计算灰区
 *     特征并打分（判中格零开销），bestScore >= gate.scoreTh 且 margin >=
 *     gate.marginMin 双条件同时满足才置 dot/dotType；灰区特征复用本格采样器
 *     与邻域搜索已采样的偏移位结果，不重复扫图。
 *   - SCAN_TYPE_MODEL 定义在 data/scan-fp-refs.js（生成物，
 *     node tools/bench/bench.js calib-types 产出，训练数据
 *     tools/bench/out/feat-dump.json）。软守卫：模型缺失时跳过兜底
 *     （增强而非必需，缺失不产生错误结果，故不像 SCAN_REC 那样 throw）。
 *   - 模型与闸门校准依据（2026-08-07 Step 3 圆盘判定链接入后重训，78 图
 *     3276 格、按图留一 78 折 CV，详见 tools/bench/out/calib-types-report.json）：
 *     灰区 2055 格（训练样本：neg 2049 / 土 2 / 水 4）；全配置 CV TP=0/6
 *     （水11 的 4 个正样本同图同折，留一不可学），采用 nb（闸门
 *     scoreTh=-1179.4498 / marginMin=172.8725，FP=0）——本图库上模型恒不
 *     补救，端到端等价纯规则链（规则链含圆盘补救后锚点 fastTP 1194/1200）。
 *     同日末轮重训（圆盘补救 C 支救回最后 6 个灰区正样本后）灰区 2049 格
 *     0 正样本，calib-types 检出后按「无补救职责」保留本模型不写回
 *     （bench.js 有零正样本分支；scanTypeModelScore 已加空得分守卫，
 *     出折零正类模型不崩溃）。
 *     2026-08-05 首轮校准（策略 B 后、63 折、1664 格正样本 20）的历史依据
 *     见 git 历史；当时的 ovr/tree 取舍结论随灰区清空已不适用。
 *   - 特征全部复用 scanDotSamplers（与 scanCellFeat 同一抽样口径），采样参数
 *     读 SCAN_REC、hue 区间读 SCAN_DOT_TYPES，禁止硬编码；清单见函数注释。
 *   - 训练/调闸门/交叉验证等离线函数在 scan-bench.js（node bench 与提取工具
 *     共用）；推理打分 scanTypeModelScore 在本文件（index.html 运行时只加载
 *     scan-core.js + scan-fp-refs.js）。
 *
 * 像素验证层（scanPixelMlpFeats / scanPixelMlpScore + SCAN_PIXEL_MODEL 模型，
 *   2026-08-05 集成，像素级小模型计划阶段 2，仅 T2 全量 dot 验证）：
 *   - 用途：规则链（规范位彩色/强票补救/体路径/邻域闸门）判 dot=true 的格
 *     过像素 MLP 验证器（16²×3 HSV 降采样 + 1 隐层 tanh + softmax 二分类
 *     real/fake），vScore = log p(real) - log p(fake) 低于阈值则直接否决
 *     dot（dot=false/dotType=null，原判定留 pixelVeto 调试字段）；阈值按
 *     dotType 取 gate.vScoreThByType（分类型出折 min 校准 + 在样收紧，缺失
 *     类型回退 gate.vScoreTh，校准依据见模型段头注释）。
 *     杀规则链内的假 dot（土系碎裂件内假锚点、规范位纹理伪命中）后，
 *     scanGenCandidates 的冲突否决自然消解，被拖死的真锚点救回。
 *   - 作用域限制：模型兜底（SCAN_TYPE_MODEL）判中的格不过验证器——训练
 *     分布是「规则链 dot=true」格，灰区格在分布外（灰区真锚点的 vScore
 *     可低于阈值，扩到灰区会误伤）。
 *     被否决格 dot=false 后模型兜底可正常再判（链路确定性不变）；
 *     skipModel（训练转储口径）下验证器同样跳过，标签不回流。
 *   - 模型与阈值校准依据（node tools/bench/bench.js calib-pixel，2026-08-07
 *     Step 3 圆盘判定链 + 圆盘补救接入后重训，详见
 *     tools/bench/out/calib-pixel-report.json）：训练样本=规则链 dot=true
 *     1227 格（real 1200/fake 27），78 折按图留一：阈值 -8.9321 =
 *     出折真锚点 min vScore (-8.4321) - 安全余量 0.5，留一 杀假 16/27
 *     误伤 0/1200；全量重训 in-sample 杀假 23/27 误伤 0/1200。
 *     幸存 4 假 dot：体7 (4,3)、体8 (2,3)（灰石纹理金票）、火5 (1,0)/(1,2)。
 *     2026-08-05 首轮校准（旧环链 982 格 real 958/fake 24、阈值 -4.3453）
 *     的历史依据见 git 历史。
 *   - 软守卫：SCAN_PIXEL_MODEL 缺失时整段跳过（同 SCAN_TYPE_MODEL 先例）。
 *   - 训练/阈值寻优在 scan-bench.js 与 bench.js calib-pixel；推理
 *     scanPixelMlpFeats / scanPixelMlpScore 在本文件（index.html 只加载
 *     scan-core.js + scan-fp-refs.js），输入向量口径与 scan-bench.js
 *     scanPixelFeats 逐位一致（对拍脚本 tools/bench/out/verify-pixel-core.js）。
 *
 * 组合合法性校验与纠正（SCAN_LEGAL_COMBOS + scanGenCandidates 内两层，
 * 阶段0 摸底与仿真见 tools/bench/out/stage0-*.js，结论要点）：
 *   - 合法集：运行时由 BLOCKS+SHAPES 构建（SCAN_LEGAL_COMBOS IIFE），
 *     (类型|品质) → 合法规范形状名集合。精确方向口径：BLOCKS 条目的 shape
 *     矩阵 JSON 原方向查 SHAPES 反向映射，不做旋转等价——全库 978 个 truth
 *     件无一需旋转匹配 BLOCKS（compare 的 rotated notes 恒空），棋盘不旋转
 *     摆放；旋转容忍口径反而会漏过「体/q4 三格/I」这类错件。邪类型名录两组
 *     皆空属数据现状，自然不产生合法项（当前图库无邪件）。
 *   - 第一层 候选硬过滤：非法 (类型,品质,形状) 候选不生成。阶段0 验证：
 *     全库 3976 候选中非法 847（21.3%），956 个正确候选零误杀；重打包仿真
 *     配对 +10 无回退。品质取候选多数档 mq（与命名同源），quality 判错可
 *     翻转合法性的风险当前 0 案例（qualAcc 99.9%）。
 *   - 第二层 软杀迭代纠正：过滤后零合法候选的 dot 锚点标记为「可被其他
 *     候选覆盖」重生成，迭代至不动点（dot 不删、锚点仍参与 packing 可被
 *     跳过，无任何不可逆操作）。全库此类锚点仅火5 的 4 个（(0,0) 真锚点
 *     首轮进入、次轮因获得合法 L 候选退出，(0,2)/(1,0)/(1,2) 假锚点留底），
 *     仿真火5 配对 13/15→15/15；每轮重算全量空锚点集合，与遍历顺序无关，
 *     SCAN_LEGAL_MAX_ROUNDS 上限兜底防振荡。
 */

var SCAN_CELL_SIZE = 64; // 归一化格边长
var SCAN_DETECT_WIDTH = 600; // 棋盘检测在缩放到该宽度的副本上进行

/**
 * SCAN_REC 识别阈值与采样参数：值统一定义在 data/scan-fp-refs.js（全项目唯一来源，
 * 由提取工具校准后整体重写，本文件不赋值、不设兜底——缺失即报错，避免静默产生
 * 垃圾结果）。各键含义与校准依据记录如下，调整阈值时请同步更新数据文件与此处：
 *
 * 单格特征采样（位置与阈值均用样例校准）：
 *   darkV — 低于该亮度视为暗底（空格 / 图标描边）
 *   minS — 底色投票的最低饱和度
 *   emptyDark — 边缘带暗像素占比超过该值判空格
 *   dotCX / dotCY / dotR — 元素徽标（圆角方块，宽约 0.17 格）中心 / 采样环半径
 *     （格宽比例）；环半径 6.1px 恰骑在徽标边缘上：小徽标（水/土）只有部分环点命中
 *   dotHits — 环上 16 点中多数票类型的最少票数（真值锚点最低票数为 6——水/土小徽标
 *     结构性命中 6 票，阈值紧贴结构下限；再低会放进 ~12% 的图标纹理误检票）
 *   dotMinS — 圆点环采样最低饱和度；水徽标蓝底饱和度偏低（真值环点 S 中位 111、
 *     约 6% 样本 ≤90），110 会把水环点过滤到不足 dotHits（水系曾整片漏检），
 *     降到 60 后全部 115 个水锚点 ≥6 票；误检风险由 dotBgDist/dotGlyphDark 兜底
 *   dotBgDist — 徽标主色与格底色（边缘带中位数）的 HSV 距离下限（环形 hue 差 +
 *     |ΔS| + |ΔV|）。误检主要来自品质底色本身落入元素 hue 区间（金品质橙底 hue
 *     13-16 落在土 [8,17] 内），此时「环主色 == 底色」距离≈0；真值锚点徽标与底色
 *     恒有色差（亮度/饱和度差为主）：锚点 p5=99，非锚点格 p50=28 / p95=161，
 *     取 80 在锚点召回 469/476 与误检压制（101→50 格）间折中。
 *     已知边际案例：火徽标配橙红棋盘底（底色 hue~14 与火 hue~5 接近）色距可低至
 *     78（火+金 (2,0) 真锚点；2026-08-04 truth 修标后由规范位强票补救路径救回，
 *     见 dotBgDistRemedy，dotBgDist 本身不动——降到 78 会放进 ~50 个误检格）
 *   dotGlyphDark — 内盘（r≤dotInnerR 格宽）暗像素（V<150）占比下限：真徽标内有
 *     元素字符暗纹（真值锚点 min=0.19，取 0.2 会损失 2 个边缘土锚点，但均匀底色格
 *     p50=0.06、暗纹理图标格 ~0.2-0.6，需此阈值压制误检）
 *   dotLeiGlyphDark — 雷徽标分类型暗纹占比下限（judgeDot 中雷走此值）：雷徽标紫底
 *     暗纹结构性偏低，calib-dots-v2 报告（2026-08-05）16 个雷失败格全部卡在全局
 *     dotGlyphDark=0.2（实测 0.09-0.19，多数贴边 0.19，最低 0.09）；取 0.08 贴失败格
 *     实测下沿留余量，全库 2646 格扫描验证无新增假 dot/假雷
 *   dotInnerR — 内盘半径（格宽比例，≈3.2px），必在徽标（半径≈5.5px）内部
 * 圆盘全像素采样（sampleDisk，2026-08-07 Step 1 新增采样能力、Step 2 经
 * tools/bench/ab-disk.js 全量 A/B 重校阈值、Step 3 接入判定链——接入方式为
 * 「叠加」而非「替代」：judgeDisk = judgeDot 环证据门（票数/连续段/bgDist/暗纹/
 * 分类型防伪全部保留）+ 圆盘三闸（本型票/异型票/glyphFrac）。Step 3 全量转储
 * 实测：纯圆盘闸门任意组合规范位假 dot 最少 126 个（旧环链 28 个）——图标纹理
 * 在圆盘上是连续色块，票点连通域占比/质心偏心与真徽标同分布不可分，环连续段
 * 与环主色 bgDist 是抗纹理主防线，属环口径圆盘覆盖不了的职责；圆盘提供票数
 * 量级余量（真锚点 20-117 票 vs 环 6-16 结构性贴底）。叠加三闸严格严于旧链；
 * 再加规范位圆盘补救（tier2 A/B/C 支，见 scanCellFeat 代码处注释）后救回小
 * 徽标/同色徽标硬例，端到端 1191→1195/1200（土+体 16→17、水11 14→16 全配对、
 * 土7 13→14，逐格 diff 仅此 3 图且全为改善）。
 * 校准样本：全量 63 图
 * 3276 格 = 1200 真锚点（非体 1061；体 139 个 hue 无效走独立灰徽标路径，不在本
 * 信号层）+ 2076 非锚点格；产物 tools/bench/out/ab-disk-report.json /
 * ab-disk-summary.txt。选定档下非体锚点 0 回退（环判对的 1028 个全保留）0 漏判
 * （环判负的 33 个非体锚点全部救回）、非锚点假 dot 647 远低于环纯投票基线 1556）：
 *   dotDiskBgDist — 圆盘点级背景剔除阈值（与格底色 HSV 距离 <T 的点不投票，
 *     度量同 dotBgDist：环形 hue 差+|ΔS|+|ΔV|）。多阈值扫描 T∈{20,30,40,50,60}：
 *     T≥40 时土+体两个同色徽标锚点（(0,0)/(3,0)，徽标填充与格底色同色）本型票
 *     被点级剔除崩到 16-20，T=30 回升到 36/26、T=20 到 83/28；T=20 非锚点假票
 *     增多（同闸门 falseN 752 vs T=30 的 678）。取 30：全锚点保住且假票更低
 *   dotDiskHits — 圆盘本型票下限。T=30 锚点本型票 min：水 23（小徽标结构性
 *     下限，p5=37）/ 土 26（土+体 (3,0) 同色徽标离群点，p5=72）/ 雷 33 / 木 67 /
 *     金 76 / 火 78；取 20 对水 min 留 3 票、对土离群点留 6 票余量
 *   dotDiskRivalMax — 圆盘异型票上限。T=30 锚点异型票 max：火 33（含雷 175-179
 *     重叠段双计，见 scanDotHueTypes 策略 B）/ 木 32 / 金 30 / 水 22 / 雷 21 /
 *     土 19；取 35 对最高者留 2 票余量。多数票类型在全部非体锚点上等于真型
 *     （0 类型翻转）
 *   dotDiskGlyphMin — 圆盘暗纹证据下限（暗纹 V<150 只统计不除权——土棕/雷紫/
 *     深红徽标填充色本身即暗色，按 V 踢票会清光本型票）。T=30 锚点 glyphFrac
 *     min：土 0.138/0.162（土+体同色徽标两个离群点，其后 0.371、土 p5=0.684）/
 *     雷 0.487 / 金 0.530 / 水 0.621；非锚点格 p50=0.14。取 0.13 仅压唯一离群
 *     点下沿（余量 0.008，极薄）——该闸在本信号层近乎不滤假，价值留待 Step 3
 *     与类别方块/暗纹等组合闸门联审时重校
 *   dotDiskRescueGlyphMin / dotDiskRescueInDarkMax — 规范位圆盘补救 B 支
 *     （2026-08-07 Step 3，代码处注释有分支定义）双证据：圆盘暗纹占比下限 0.5 +
 *     内盘暗纹占比上限 0.5。校准（全量 3276 格逐格仿真）：B 支救回锚点 3 个
 *     （水11 (2,1)/(2,3)/(5,0)，glyph 0.707-0.724、inDark 0.375-0.406——蓝底
 *     暗字纹：圆盘暗纹高、内盘非整盘暗）；「仅环票数/连续段失败且无方块」假票
 *     候选池 60 格在双证据下 0 幸存（亮水纹理 glyph ≤0.41 被下限挡；暗绿叶/
 *     深木纹理 inDark 0.625-1.0 被上限挡），两侧间距均 >0.1
 *   dotDiskRescueVotes / dotDiskRescueBgMin / dotDiskRescueInVMedMax — 补救 C 支
 *     （环失败仅为 bgDist：徽标与格底色同色系，环沿骑缝采样混底色；点级剔除后
 *     圆盘票点即纯徽标像素，盘主色 bgDist 才是真色距）：本型票 ≥40 + 软 rival
 *     （异型<本型）+ 盘主色 bgDist ≥88 + 圆盘暗纹 ≥0.5（同上键）+ 内盘亮度中位
 *     ≤120 + 内盘暗纹 ≤0.8（dotDiskRescueDarkMax）。校准（同转储）：救回锚点
 *     3 个（土7 (3,0) 票47/盘bg92/glyph0.75/inDark0.688、土7 (0,2)/(1,1)）——
 *     C 支门槛间隙：票 假票 max 37 < 40 ≤锚点 min 47；盘bg 锚点 min 92（余量 4）；
 *     inVMed 锚点 max 112 < 120 < 假票 min 125；内盘暗纹 锚点 max 0.75 < 0.8 <
 *     暗红纹理假票 1.0；假票 0 幸存。土7 (0,0) 盘多数型为金（76票 vs 土40，金/土
 *     hue 邻接污染）类型归属本身错误，任何分支均不救（维持旧链漏检，不新增
 *     错型锚点）
 * 体（灰色徽标，hue 无意义）专属判定参数：
 *   dotTiLowS — 内盘低饱和（S<40）像素占比下限；体锚点 p10=0.91，非锚点格 p90=0.47
 *   dotTiVMin / dotTiVMax — 亮灰徽标亮度中位数区间：体徽标石灰底 V 中位
 *     p10=158/p90=200，下限压灰色图标误检（其 V 中位多 ≤154），上限含略亮个体
 *     （4 个锚点 201-205）
 *   dotTiDarkVMin — 深灰徽标档（体2 样例 10 个锚点 V 中位 75-129，浅灰档会整片漏）：
 *     [70,140) 区间需同时满足 dotTiDarkGlyph / dotTiDarkVStd（深灰盘+暗字纹对比更大）
 *   dotTiDarkGlyph — 深灰档暗纹占比下限：体2 深灰锚点 min=0.66，灰色图标均匀暗纹低
 *   dotTiDarkVStd — 深灰档亮度双峰 std 下限：体2 深灰锚点 min=56.7，均匀图标 ≤43.6
 *   dotTiGlyph — 灰徽标内暗纹（V<150）占比下限；体锚点 min=0.1875（体4/体5 各
 *     1 个，0.2 会漏掉），747 个非锚点占用格在该阈值下仍 0 通过体路径
 * 分类型防伪（校准数据如下）：
 *   dotJinGlyphDh — 金：真徽标内盘含暗色「金」字纹，内盘饱和像素 hue 中位相对环
 *     主色恒有偏移（真值 min=2.64）；同质纹理（剑刃/绸缎）环芯同色（误检 max=1.3）
 *   dotMuRingVMax — 木：真徽标为暗绿底（121 个木锚点环 V 中位 max=110）；误检为
 *     亮绿树叶/藤蔓图标（V 中位 185-234）
 *   dotTuVoteMax / dotTuRingVMin — 土：满票（>15）且环上无暗纹（环 V min≥80）才是
 *     均匀材质。土徽标是小方块，采样环骑在边缘上，真土锚点恒有部分环点落在徽标外
 *     （19 个真值锚点票数 6-15）；16/16 满票多为整环同一片连续材质（红底上的
 *     深棕木纹），但红色大幡真锚点（土+体 (3,6)，16 票）也满环，单靠票数会误杀；
 *     真徽标满环时暗色字纹必压到环上（土+体 (3,6) 环 V min=47.8），均匀木纹
 *     材质环 V min ~100；两者借此可分
 *   dotTuHMedMin — 土票 hue 中位下限：土徽标 calib hue p5=11（真锚点环 hue
 *     中位 min=12.8）；hue 8.x 的暗棕材质（土+体 (2,4) 剑柄，hMed=8.15）恰在区间
 *     边缘凑票，非徽标
 *   dotHuoGlyphDarkMax — 火：内盘暗像素占比上限。真火徽标=亮红底+暗色字纹（108 个
 *     真值火锚点 inDark max=0.70）；均匀暗材质整盘皆暗（土系深棕木纹/布料误检格
 *     0.91-1.00、雷系暗红图标误检格 0.91-0.94）
 *   dotHuoInnerVMin / dotHuoInnerVMax — 火：内盘亮度中位区间（真值火锚点 min=88；
 *     过其余规则的 95 个真值火锚点 max=160）。火焰图标暗部碎片凑票格（火+水样例
 *     6 个非锚点格 inVMed 56-61）过低；亮色图标本体无暗纹压亮度（误检 min=176：
 *     雷1 (1,0) 亮红宝珠 215、火7 (1,6) 棋子亮面 213、火6 (1,3)/(3,0) 亮红图标
 *     203/176）过高
 *   dotHuoHMedMax — 火：环多数票 hue 中位上限（真值火锚点 2.7-6.4，回绕高端票极少
 *     故线性中位不失真）；橙棕材质（雷+木1 (0,4) hMed=7.5）排除
 *   dotHuoRingVMin — 火：环多数票亮度中位下限（真值火锚点 min=92）；暗红图标纹理
 *     （火+水 (3,6) vMed=74.9）排除
 *   dotHuoRingSMin — 火：环多数票饱和度中位下限（真值火锚点 min=133.3）；偏棕暗红
 *     纹理饱和度不足（雷3 (5,1) sMed=123）排除
 *   dotTiVStdMin — 体：内盘亮度标准差下限。真灰徽标 = 均匀灰底 + 暗色字纹，亮度
 *     双峰（94 个体锚点 min=45.7）；均匀灰色石质图标 std≤43.6
 * 规范位强票补救（2026-08-04 干净 truth 重校，对 tools/bench/out/dot-trace.json
 * 1717 个规范位判负格校准，救回 TP=3、FP=0）：
 *   dotStrongVotes — 规范位环多数票票数下限（= dotHits+4）。真锚点规范位票型
 *     集中（火+金 (2,0) 火 12 票、木2 (0,0) 木 15 票、土+体 (1,4) 土 10 票）
 *   dotBgDistRemedy — 补救路径 bgDist 边际带下限。上述真锚点色距 72-78（徽标与
 *     格底色色相接近被 dotBgDist 误杀）；「强票+方块+暗纹+分类型防伪全过」组合下
 *     非锚点候选色距最高 44（体3 (0,1) 土票 13 票），取 60 上下边距均 >12
 * 邻域徽标搜索闸门增量（同日同数据重校，闸门 TP=36、FP=0，逐条依据见代码处注释）：
 *   dotNbOvVMin — 规范位同型票 ov≥9 时非土类型的偏移位票下限（满环级）。干净
 *     truth 下 ov≥9 且 v≥14 的非土命中全部是真锚点（火+金 (2,0) ov=12、
 *     火+水 (0,4)/(3,4) ov=9/12、木2 (0,0) ov=15）；土不放宽（4 个 cell:土 假命中
 *     与真土锚点同签名不可分）；雷偏移命中 241 个全部落在真雷锚点格（紫 hue 在
 *     图标纹理中无票源），整段不设附加门槛——真雷锚点偏移位票仅 6-13，v≥14
 *     会整片误杀（雷1-雷9、雷+木2 共 31 格）
 *   dotNbResidualMin — 规范位同型残票下限（几何定位 maxOv 前提与邻域 ov 闸门
 *     共用）：真偏移徽标在规范位只留小半弧残票，无残票格两路均不进（依据同上
 *     1717 格转储校准）
 *   dotNbFullRingVotes — 偏移位满环级票下限（ov∈[6,8] 放行与土门槛共用）：环
 *     16 点中 14 票即近满环，真徽标偏移位签名；土因 hue 与橙黄图标纹理最近，
 *     弱票土全是误检故全票档套用（4 个 cell:土 假命中 v=14-16 见代码处注释）
 *   dotNbInDarkMax — 偏移位内盘暗纹占比上限：全暗图标区排除（土7 (3,3) 金假
 *     命中 inDark=0.97）
 * 类别方块 / 数字徽标 / 空格兜底：
 *   squareX / squareY / squareMaxS — 类别方块中心（圆点正下方）与灰白方块饱和度上限
 *   badgeCX / badgeCY / badgeR — 数字徽标圆心 / 半径（格宽比例）
 *   badgeMin — 被棕底包围的白字像素数下限
 *   badgeBrownMin — 徽标圆内棕底像素数下限：真数字徽标是完整的深棕圆（507 个真值
 *     徽标格检出者 brown 中位 73，仅 1 格 <40）；此前不计棕底量，图标棕块+白高光
 *     即可凑够白字包围数（132 格误触 brown 中位仅 26），误触会破坏「恰一个徽标」判定
 *   badgeBrownFracMin / badgeCompMin / badgeCompMax — 徽标强化校验（阶段 C，
 *     2026-08-04，依据 tools/bench/out/analysis-c.md 严格档）：badgeMin+badgeBrownMin
 *     初筛通过后追加「圆内棕底占比 ≥0.4 且圆内白点 8 连通域最大尺寸 ∈ [10,60]」。
 *     校准样本：全量 63 图初筛 TP=973/FP=47/FN=5（强化前 P=95.4% R=99.5%）。
 *     误触多为图标棕色部件/高光，棕底不成整盘（FP brownFrac p50=0.412 vs 真值
 *     p5=0.473）、白点要么零散过小要么大块（FP compMaxSize p95=78 vs 真值 p5=32）；
 *     真徽标是完整棕色圆盘+数字笔画 1-2 个紧凑连通域。强化后 TP=971（损 2）FP=18
 *     → P=98.2% R=99.28%。边际案例：损失的 2 个 TP 为土+体 (2,0)/(5,0)
 *     （brownFrac 0.305/0.313 的边际真徽标）；幸存 FP=18 主要是金系锚点格金色
 *     圆饰，与真徽标同签名不可再分——误触未清零，故下游 bScore/bExcess 保持
 *     软惩罚，不升级硬否决
 *   qualVeto — 格底色置信度达到该值才可否决议候选品质一致性
 *   emptyIconPx — 空格兜底判定：格内图标像素数（与底色 RGB 差 > iconDiff）下限。
 *     部分空格底色带品质色（褐底漩涡格 hue~21 会投出金品质票，水7 样例
 *     空格 qconf=1.00），暗底判定漏过它们，拼件候选会把空格当占用格吞入。
 *     校准（2026-08-10 全库 100 图 4200 格重校）：4093 个真值占用格 iconPx
 *     min=735（金系淡图标格），107 个空格 max=514（火+水(5,6) 高噪漩涡空格，
 *     次高 384；此前 63 空格样本 max=324 漏掉该档），615 为几何中点两侧
 *     ≥1.19 倍余量
 *   contLo / contHi — 图标跨格连贯性：候选内部共享边两侧 2px 带内位置对齐的图标
 *     像素相接数 touch 经 [contLo,contHi] 线性映射为边连贯分（≤lo 记 0，≥hi 记 1），
 *     候选连贯分取「双弱边均值」（2026-08-10 改，原取最弱边——抢格候选的接缝弱边
 *     会被真件自身弱边掩盖：邪6 真件边 19/60 vs 抢格候选 19/20/60 min 同为 19，
 *     双弱边均值 39.5 > 19.5 可分）。校准：854 条真值件内边 touch min=7/p5=28，
 *     1352 条拼缝边 p5=7/p25=18；contLo 仍不能超 7（355 件真值多格件最弱边 min=7），
 *     contHi=28 对齐真值件内边 p5。全量回归（100 图）：格召回 99.8%、配对率 99.9%，
 *     其余 96 图零回退
 *   phaseEdgeMin — 棋盘定位相位校正（scanDetectBoard，2026-08-04 新增）：拟合完成后
 *     把当前网格 ±1 行/列的相位变体一并评分，inlier（斑块中心与格中心对齐数）多者
 *     胜出，打平时变体的外边界暗带占比 edge 须低过本余量才换相位，否则保持原相位
 *     （res 整格平移后恒打平、fill 偏好错误相位，均不参与相位裁决）。校准（63 张
 *     样例全量回放）：唯一需要平移的土1 以 inlier 25:24 直接胜出（edge 0.03<0.05
 *     同向佐证）；全部对齐正常网格的相位变体要么 inlier 更低，要么 edge 打平/更高，
 *     唯一 edge 打平的水1 变体差为 0（fill +0.002 为噪声），取 0.01 挡噪声级 edge 差
 * 签名格式参数（改动后已存指纹 sig 全部失效，需重新提取）：
 *   iconDiff — 图标像素判定：与底色 RGB 差阈值
 *   iconMinPx — sig 块内图标像素下限，不足记 null（匹配时跳过）
 */
if (!window.SCAN_REC) {
	throw new Error("SCAN_REC 未定义：请先加载 data/scan-fp-refs.js（识别阈值配置）");
}

/** 元素圆点 hue(0-179) 区间 → 法宝类型；lo > hi 表示跨 180 回绕（如红色 [170, 5]）。
 *  SCAN_DOT_TYPES / SCAN_FP_REFS / SCAN_REC 配置在 data/scan-fp-refs.js（由指纹提取
 *  工具校准，var 全局定义），文件缺失时退回内置默认；不可用 const/let 重复声明，
 *  否则与数据文件的全局 var 冲突，整段脚本直接无法解析 */
if (!window.SCAN_DOT_TYPES) window.SCAN_DOT_TYPES = [[40, 85, "木"]];
if (!window.SCAN_FP_REFS) window.SCAN_FP_REFS = {};
/* SCAN_TYPE_MODEL（灰区统计分类器模型，同为 data/scan-fp-refs.js 定义）不设默认、
 * 不 throw：模型是规则链判负后的增强兜底而非必需，缺失时 scanCellFeat 末尾的
 * 模型路径按软守卫跳过（见该处），识别结果退化为纯规则链（集成前行为） */

/** RGB → HSV（H 0-179 / S 0-255 / V 0-255，与 OpenCV 刻度一致） */
function scanRgb2Hsv(r, g, b) {
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	const d = mx - mn;
	let h = 0;
	if (d) {
		if (mx === r) h = ((g - b) / d) % 6;
		else if (mx === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 30;
		if (h < 0) h += 180;
	}
	return [h, mx ? (d / mx) * 255 : 0, mx];
}

/** 品质底色 hue 分类：绿0 蓝1 紫2 金3 红4 */
function scanQualClass(h) {
	if (h < 11 || h > 168) return 4;
	if (h < 41) return 3;
	if (h < 89) return 0;
	if (h < 129) return 1;
	return 2;
}

/** 64×64 格内品质采样边缘带（像素下标）：避开中心图案、左上锚点区与右下徽标区 */
var SCAN_BAND_IDX = (() => {
	const idx = [];
	const N = SCAN_CELL_SIZE;
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const fx = x / N;
			const fy = y / N;
			const onBand =
				(fy >= 0.04 && fy <= 0.1) ||
				(fy >= 0.9 && fy <= 0.96) ||
				(fx >= 0.04 && fx <= 0.1) ||
				(fx >= 0.9 && fx <= 0.96);
			if (!onBand) continue;
			if (fx < 0.32 && fy < 0.52) continue; // 左上锚点（圆点 + 类别方块）
			if (fx > 0.68 && fy > 0.68) continue; // 右下数字徽标
			idx.push(y * N + x);
		}
	}
	return idx;
})();

/**
 * 环上采样点 hue 归属（2026-08-05 策略 B，依据 calib-dots-v2 报告）：返回该 hue
 * 记票的类型数组。雷 [144,180) 与火 [174,9] 在 175-179 重叠，重叠段的点对两类
 * 各记一票（按类型独立计票，多数决在 judgeSample 完成）——旧 ranges.find 首命中
 * 会把重叠段票全归列前者（火），切掉雷 166-179 尾约半数票。
 * 其余区间交叠维持首命中归属：火/土 (8,9)、金/土 (16,17)、金/木 (25,26) 为边界
 * 互补设计，双计会抬高土/木票放进假 dot（calib-dots-v3 验证：8 格新增假 dot
 * 全部由 (8,9)/(16,17) 段土票双计抬过闸门造成）。
 */
function scanDotHueTypes(h, ranges) {
	let hits = null;
	for (const [lo, hi, t] of ranges) {
		if (lo <= hi ? h > lo && h < hi : h > lo || h < hi) {
			(hits = hits || []).push(t);
		}
	}
	if (!hits) return [];
	if (hits.length > 1 && hits.every((t) => t === "火" || t === "雷")) return hits;
	return [hits[0]];
}

/**
 * 元素徽标 / 类别方块采样器工厂：scanCellFeat 与 scanCellTypeFeats 共用同一
 * 实现（抽样口径唯一来源，保证灰区特征与快路径判定完全同源）。
 *   - sampleSquare(ox, oy)：类别方块（元素徽标正下方灰白低饱和块）采样，返回
 *     是否低饱和方块；ox/oy 为相对规范采样位的偏移（64 格比例），供邻域徽标
 *     搜索做「随动方块」防伪校验。
 *   - sampleDot(ox, oy)：元素徽标采样，环与内盘一起平移。返回环投票/环上命中
 *     标记与内盘统计（暗纹占比 / 低饱和占比 / 亮度中位 / 饱和 hue 中位 / 亮度
 *     标准差）。环上 16 点（3×3 均值）按类型区间投票；内盘（r≤dotInnerR，必在
 *     徽标内部）统计暗纹（v<150）与低饱和（s<40）占比——徽标内有元素字符，
 *     均匀底色/图标无暗纹。
 *   - ringRun(f, t)：环上某类型的最长连续段（环首尾相接，展开两倍扫描）。
 *   - sampleDisk(ox, oy)：圆盘全像素采样（2026-08-07 Step 1 新增采样能力，
 *     以徽标位（dotCX+ox, dotCY+oy）为圆心、dotR 为半径的圆盘内逐像素采 HSV：
 *     S>dotMinS 且与格底色 HSV 点级距离 ≥dotDiskBgDist 的像素按 scanDotHueTypes
 *     投票（点级背景剔除，杀品质底色/图标同色污染票）；暗纹（V<150）只统计
 *     glyphFrac 不除权（徽标填充色本身是暗色，按 V 踢票会清光本型票）。
 *     返回 { votes（类型->票数）, tot（圆盘像素数）, glyphFrac }；结果带缓存，
 *     供邻域搜索偏移位复用。体（灰徽标）走独立路径，不经本采样器。
 *   - bgHsv()：格底色 HSV（边缘带中位数，带缓存；bgDist 用，邻域搜索中多次调用）。
 */
function scanDotSamplers(data, ranges) {
	const N = SCAN_CELL_SIZE;
	const sampleSquare = (ox, oy) => {
		const sqx = Math.round((SCAN_REC.squareX + ox) * N);
		const sqy = Math.round((SCAN_REC.squareY + oy) * N);
		const sats = [];
		for (let dy = -3; dy <= 3; dy++) {
			for (let dx = -3; dx <= 3; dx++) {
				const py = sqy + dy;
				const px = sqx + dx;
				if (px < 0 || py < 0 || px >= N || py >= N) continue;
				const i = (py * N + px) * 4;
				sats.push(scanRgb2Hsv(data[i], data[i + 1], data[i + 2])[1]);
			}
		}
		sats.sort((a, b) => a - b);
		return sats.length
			? sats[Math.floor(sats.length / 2)] < SCAN_REC.squareMaxS
			: false;
	};
	const sampleDot = (ox, oy) => {
		const icx = (SCAN_REC.dotCX + ox) * N;
		const icy = (SCAN_REC.dotCY + oy) * N;
		const ir2 = (SCAN_REC.dotInnerR * N) ** 2;
		let inN = 0;
		let inDark = 0;
		let inLowS = 0;
		const inVs = [];
		const inHs = []; // 饱和像素 hue（金徽标暗纹校验用）
		for (let y = Math.floor(icy - SCAN_REC.dotInnerR * N); y <= icy + SCAN_REC.dotInnerR * N; y++) {
			for (let x = Math.floor(icx - SCAN_REC.dotInnerR * N); x <= icx + SCAN_REC.dotInnerR * N; x++) {
				const ddx = x - icx;
				const ddy = y - icy;
				if (ddx * ddx + ddy * ddy > ir2) continue;
				const i = (y * N + x) * 4;
				const [h, s, v] = scanRgb2Hsv(data[i], data[i + 1], data[i + 2]);
				inN++;
				if (v < 150) inDark++;
				if (s < 40) inLowS++;
				if (s > SCAN_REC.dotMinS) inHs.push(h);
				inVs.push(v);
			}
		}
		inVs.sort((a, b) => a - b);
		inHs.sort((a, b) => a - b);
		// 内盘亮度标准差（体灰徽标防伪：均匀灰底+暗字纹呈双峰，std 大；灰色石质图标均匀，std 小）
		let inVStd = 0;
		if (inN) {
			const mean = inVs.reduce((s, v) => s + v, 0) / inN;
			inVStd = Math.sqrt(
				inVs.reduce((s, v) => s + (v - mean) ** 2, 0) / inN,
			);
		}
		const dotVotes = {}; // type -> [[h,s,v],...]
		const dotRun = {}; // type -> 环上命中标记（16 点 0/1）
		for (let k = 0; k < 16; k++) {
			const ang = (2 * Math.PI * k) / 16;
			const cx = Math.round((SCAN_REC.dotCX + ox + SCAN_REC.dotR * Math.cos(ang)) * N);
			const cy = Math.round((SCAN_REC.dotCY + oy + SCAN_REC.dotR * Math.sin(ang)) * N);
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
			const [h, s, v] = scanRgb2Hsv(r / n, g / n, b / n);
			if (s <= SCAN_REC.dotMinS) continue;
			// hue 归属见 scanDotHueTypes（策略 B：仅雷/火 175-179 重叠段双计，
			// 其余交叠维持首命中）；多数决在 judgeSample 完成
			for (const ty of scanDotHueTypes(h, ranges)) {
				(dotVotes[ty] = dotVotes[ty] || []).push([h, s, v]);
				(dotRun[ty] = dotRun[ty] || new Array(16).fill(0))[k] = 1;
			}
		}
		return {
			dotVotes,
			dotRun,
			inDarkFrac: inN ? inDark / inN : 0,
			inLowSFrac: inN ? inLowS / inN : 0,
			inVMed: inN ? inVs[Math.floor(inN / 2)] : 0,
			inHMed: inHs.length ? inHs[Math.floor(inHs.length / 2)] : null,
			inVStd,
		};
	};
	const ringRun = (f, t) => {
		const hits = f.dotRun[t];
		if (!hits) return 0;
		let run = 0;
		let cur = 0;
		for (let k = 0; k < 32; k++) {
			if (hits[k % 16]) {
				cur++;
				if (cur > run) run = cur;
			} else cur = 0;
		}
		return run > 16 ? 16 : run;
	};
	let bgHsvCache = null;
	const bgHsv = () => {
		if (!bgHsvCache) {
			const [bgR, bgG, bgB] = scanCellBg(data);
			bgHsvCache = scanRgb2Hsv(bgR, bgG, bgB);
		}
		return bgHsvCache;
	};
	// 圆盘全像素采样（判定链接入版，2026-08-07 Step 3）：结果按偏移位缓存
	// （键与 nbDotCache 同格口径），供邻域搜索偏移位复用。返回 { votes,
	// votePts（票点中位数防伪用）, tot, glyphFrac, in* }——in* 为内盘
	// （r≤dotInnerR，圆盘子集）统计，与 sampleDot 同公式同像素集，
	// 接入后偏移位无需再跑 sampleDot
	const diskCache = {};
	const sampleDisk = (ox, oy) => {
		const key = ox.toFixed(4) + "," + oy.toFixed(4);
		if (diskCache[key]) return diskCache[key];
		const [bgH, bgS, bgV] = bgHsv();
		const cx = (SCAN_REC.dotCX + ox) * N;
		const cy = (SCAN_REC.dotCY + oy) * N;
		const R = SCAN_REC.dotR * N;
		const R2 = R * R;
		const ir2 = (SCAN_REC.dotInnerR * N) ** 2;
		const votes = {}; // type -> 圆盘内有效票数
		const votePts = {}; // type -> [[h,s,v],...]（与 sampleDot dotVotes 同构）
		let tot = 0;
		let glyph = 0;
		let inN = 0;
		let inDark = 0;
		let inLowS = 0;
		const inVs = [];
		const inHs = []; // 内盘饱和像素 hue（金徽标暗纹校验用）
		for (
			let y = Math.max(0, Math.floor(cy - R));
			y <= Math.min(N - 1, Math.ceil(cy + R));
			y++
		) {
			for (
				let x = Math.max(0, Math.floor(cx - R));
				x <= Math.min(N - 1, Math.ceil(cx + R));
				x++
			) {
				const ddx = x - cx;
				const ddy = y - cy;
				const rr = ddx * ddx + ddy * ddy;
				if (rr > R2) continue;
				const i = (y * N + x) * 4;
				const [h, s, v] = scanRgb2Hsv(data[i], data[i + 1], data[i + 2]);
				tot++;
				// 暗纹仅作证据统计，不剥夺投票权：土棕/雷紫/深红等徽标填充色
				// 本身 V<150（实验锚点 glyphFrac 0.5-0.8），按 V 排除会清光本型票
				if (v < 150) glyph++;
				if (rr <= ir2) {
					inN++;
					if (v < 150) inDark++;
					if (s < 40) inLowS++;
					if (s > SCAN_REC.dotMinS) inHs.push(h);
					inVs.push(v);
				}
				if (s <= SCAN_REC.dotMinS) continue;
				// 点级背景剔除：与格底色 HSV 距离（环形 hue 差+|ΔS|+|ΔV|，同
				// dotBgDist 度量）不足阈值的点不投票
				const dhh = Math.min(Math.abs(h - bgH), 180 - Math.abs(h - bgH));
				if (dhh + Math.abs(s - bgS) + Math.abs(v - bgV) < SCAN_REC.dotDiskBgDist) continue;
				// hue 归属同 sampleDot（scanDotHueTypes 策略 B）
				for (const ty of scanDotHueTypes(h, ranges)) {
					votes[ty] = (votes[ty] || 0) + 1;
					(votePts[ty] = votePts[ty] || []).push([h, s, v]);
				}
			}
		}
		inVs.sort((a, b) => a - b);
		inHs.sort((a, b) => a - b);
		// 内盘亮度标准差（同 sampleDot：真灰徽标双峰 std 大，均匀石质图标 std 小）
		let inVStd = 0;
		if (inN) {
			const mean = inVs.reduce((s, v) => s + v, 0) / inN;
			inVStd = Math.sqrt(inVs.reduce((s, v) => s + (v - mean) ** 2, 0) / inN);
		}
		const res = {
			votes,
			votePts,
			tot,
			glyphFrac: tot ? glyph / tot : 0,
			inDarkFrac: inN ? inDark / inN : 0,
			inLowSFrac: inN ? inLowS / inN : 0,
			inVMed: inN ? inVs[Math.floor(inN / 2)] : 0,
			inHMed: inHs.length ? inHs[Math.floor(inHs.length / 2)] : null,
			inVStd,
		};
		diskCache[key] = res;
		return res;
	};
	return { sampleSquare, sampleDot, sampleDisk, ringRun, bgHsv };
}

/**
 * 圆盘投票信号级判定（2026-08-07 Step 2 新增；影子判定与 tools/bench/ab-disk.js
 * A/B 工具共用，口径唯一来源。注意：判定链（scanCellFeat judgeDisk）用的是
 * 「judgeDot 环证据门 + diskOk 圆盘数量门」的叠加口径而非本函数——纯圆盘信号
 * 闸门压不住图标纹理假票，见文件头「圆盘全像素采样」注释块）：多数票类型
 * （并列取 ranges 序靠前者，
 * 与 judgeSample 同口径）需同时满足 本型票 ≥dotDiskHits、最高异型票
 * ≤dotDiskRivalMax、暗纹证据 glyphFrac ≥dotDiskGlyphMin。只比「dot 有无 + 类型
 * 投票」信号质量，不含环判定链的 bgDist/连续段/分类型防伪层。
 * 阈值校准依据见文件头 SCAN_REC 注释。返回类型或 null。
 */
function scanDiskJudge(disk, ranges) {
	let dotType = null;
	let top = 0;
	ranges.forEach(([, , t]) => {
		const n = disk.votes[t] || 0;
		if (n > top) {
			top = n;
			dotType = t;
		}
	});
	if (!dotType) return null;
	if (top < SCAN_REC.dotDiskHits) return null;
	const rival = Object.entries(disk.votes).reduce(
		(mx, [t, n]) => (t === dotType ? mx : Math.max(mx, n)),
		0,
	);
	// 分类型异型票上限与判定链 diskOk 同口径（邪走 dotXieDiskRivalMax，缺失回退全局）
	const rivalMax =
		dotType === "邪" && SCAN_REC.dotXieDiskRivalMax != null
			? SCAN_REC.dotXieDiskRivalMax
			: SCAN_REC.dotDiskRivalMax;
	if (rival > rivalMax) return null;
	if (disk.glyphFrac < SCAN_REC.dotDiskGlyphMin) return null;
	return dotType;
}

/**
 * 单格特征提取：data 为 64×64 RGBA 像素数组。
 * dotTypes 默认取全局 SCAN_DOT_TYPES；提取工具回放时传当前输出配置（含未保存校准）。
 * skipModel 为 true 时跳过末尾的灰区统计模型兜底（scanCellTypeFeats 转储用——
 * 训练标签须固定为「规则链判定」口径，模型补救不回流，同时防模型路径递归）。
 * 返回 { qual, qconf, dot, dotType, square, badge, iconPx, data }：
 * qual=-1 表示空格（暗底判定为主、图标像素数 emptyIconPx 兜底，兜底会连带
 * 抹除该格的 dot/dotType——空格漩涡纹理上不可能有真锚点）。
 */
function scanCellFeat(data, dotTypes, skipModel) {
	const N = SCAN_CELL_SIZE;
	const ranges = dotTypes || SCAN_DOT_TYPES;
	// 品质底色：边缘带投票，暗像素占多数判空格
	let dark = 0;
	let valid = 0;
	const votes = [0, 0, 0, 0, 0];
	SCAN_BAND_IDX.forEach((i) => {
		const [h, s, v] = scanRgb2Hsv(
			data[i * 4],
			data[i * 4 + 1],
			data[i * 4 + 2],
		);
		if (v < SCAN_REC.darkV) {
			dark++;
			return;
		}
		if (s < SCAN_REC.minS) return;
		votes[scanQualClass(h)]++;
		valid++;
	});
	let qual = -1;
	let qconf = 0;
	if (valid && dark / SCAN_BAND_IDX.length <= SCAN_REC.emptyDark) {
		let mq = 0;
		votes.forEach((n, q) => {
			if (n > votes[mq]) mq = q;
		});
		qual = mq;
		qconf = votes[mq] / valid;
	}
	// 类别方块 / 元素徽标采样器（sampleSquare/sampleDot/ringRun/bgHsv）抽为
	// scanDotSamplers 工厂（抽样口径与灰区特征函数 scanCellGrayFeats 共用）；
	// sampleSquare(ox, oy) 供邻域徽标搜索做「随动方块」防伪校验，返回特征固定取规范位；
	// samplers 本体与 nbDotCache 供模型兜底路径复用（灰区特征不再重复扫图）
	const samplers = scanDotSamplers(data, ranges);
	const { sampleSquare, sampleDot, ringRun, bgHsv } = samplers;
	let nbDotCache = null; // 邻域搜索已采样的偏移位结果（"ix,iy" -> sampleDot 返回）
	const square = sampleSquare(0, 0);
	const f0 = sampleDot(0, 0);
	// 规范位圆盘投票（Step 3 接入判定链；体路径不引用，体走内盘统计独立路径）
	const dk0 = qual >= 0 ? samplers.sampleDisk(0, 0) : null;
	// 体路径只取规范位内盘统计：灰纹理在偏移位凑齐条件的风险高，不做邻域平移
	const inDarkFrac = f0.inDarkFrac;
	const inLowSFrac = f0.inLowSFrac;
	const inVMed = f0.inVMed;
	const inVStd = f0.inVStd;
	// 单类型判定：票数/环形最长连续段（环首尾相接，故展开两倍扫描）≥dotHits、
	// 主色与格底色 HSV 距离 ≥dotBgDist、内盘暗纹占比 ≥dotGlyphDark、分类型防伪
	// （金/木/土/火各一条，阈值校准数据见顶部 SCAN_REC 注释）。
	// bgMin / hitMin 供规范位强票补救路径使用（放宽 bgDist、收紧票数，缺省取规范值）。
	// 返回失败闸门标签数组（空 = 全过）；judgeDot 为其布尔包装。
	// skipQuantity：圆盘补救（tier2）专用——环票数/连续段是小徽标结构性短板
	// （水/土环票贴底 6 票），由圆盘量级证据（diskOk）替代，其余环证据门全保留
	const judgeDotFails = (t, f, bgMin, hitMin, skipQuantity) => {
		const pts = f.dotVotes[t];
		if (!pts) return ["无票"];
		const fails = [];
		if (!skipQuantity) {
			if (pts.length < (hitMin || SCAN_REC.dotHits)) fails.push("票数");
			if (ringRun(f, t) < SCAN_REC.dotHits) fails.push("连续段");
		}
		// 多数票主色（各通道中位数）与格底色距离
		const hs = pts.map((p) => p[0]).sort((a, b) => a - b);
		const ss = pts.map((p) => p[1]).sort((a, b) => a - b);
		const vs = pts.map((p) => p[2]).sort((a, b) => a - b);
		const mid = Math.floor(pts.length / 2);
		const [bgH, bgS, bgV] = bgHsv();
		const dh = Math.min(
			Math.abs(hs[mid] - bgH),
			180 - Math.abs(hs[mid] - bgH),
		);
		const bgDist = dh + Math.abs(ss[mid] - bgS) + Math.abs(vs[mid] - bgV);
		let typeOk = true;
		if (t === "金" && f.inHMed !== null) {
			const gd = Math.min(Math.abs(f.inHMed - hs[mid]), 180 - Math.abs(f.inHMed - hs[mid]));
			if (gd < SCAN_REC.dotJinGlyphDh) typeOk = false;
		}
		if (t === "木" && vs[mid] > SCAN_REC.dotMuRingVMax) typeOk = false;
		if (t === "土") {
			if (hs[mid] < SCAN_REC.dotTuHMedMin) typeOk = false;
			if (
				pts.length > SCAN_REC.dotTuVoteMax &&
				vs[0] >= SCAN_REC.dotTuRingVMin
			) {
				typeOk = false;
			}
		}
		if (t === "火") {
			if (f.inDarkFrac > SCAN_REC.dotHuoGlyphDarkMax) typeOk = false;
			if (f.inVMed < SCAN_REC.dotHuoInnerVMin) typeOk = false;
			if (f.inVMed > SCAN_REC.dotHuoInnerVMax) typeOk = false;
			if (hs[mid] > SCAN_REC.dotHuoHMedMax) typeOk = false;
			if (vs[mid] < SCAN_REC.dotHuoRingVMin) typeOk = false;
			if (ss[mid] < SCAN_REC.dotHuoRingSMin) typeOk = false;
		}
		if (!typeOk) fails.push("防伪");
		if (bgDist < (bgMin || SCAN_REC.dotBgDist)) fails.push("bgDist");
		// 雷暗纹走分类型阈值：16 个雷失败格实测内盘暗纹 0.09-0.19（多数贴边
		// 0.19），全局 dotGlyphDark=0.2 会整片误杀（calib-dots-v2 报告归因）
		if (f.inDarkFrac < (t === "雷" ? SCAN_REC.dotLeiGlyphDark : SCAN_REC.dotGlyphDark)) fails.push("暗纹");
		return fails;
	};
	const judgeDot = (t, f, bgMin, hitMin) =>
		judgeDotFails(t, f, bgMin, hitMin).length === 0;
	// 多数票优先（票最多的类型胜出；并列时取 SCAN_DOT_TYPES 序靠前者——确定性
	// tie-break，与 scanCellGrayFeats 的多数票选取同口径）；多数票为火且被否决时
	// 降级次优类型——火区间是后加的，
	// 雷/土锚点的橙红污染票盖过真票时简单否决会把整个锚点判丢
	// （雷+木1 (0,4) 雷锚点 7 张橙红票被火防伪否决后由次优 6 张雷票救回；
	// 降级即回到加火区间前的票型归属，对其余类型行为与之前完全一致）
	const judgeSample = (f, bgMin, hitMin) => {
		let dotType = null;
		let dotTopN = 0;
		ranges.forEach(([, , t]) => {
			const n = (f.dotVotes[t] || []).length;
			if (n > dotTopN) {
				dotTopN = n;
				dotType = t;
			}
		});
		if (!dotType) return null;
		if (judgeDot(dotType, f, bgMin, hitMin)) return dotType;
		if (dotType === "火") {
			let second = null;
			let secondN = 0;
			ranges.forEach(([, , t]) => {
				if (t === "火") return;
				const n = (f.dotVotes[t] || []).length;
				if (n > secondN) {
					secondN = n;
					second = t;
				}
			});
			if (second && judgeDot(second, f, bgMin, hitMin)) return second;
		}
		return null;
	};
	// 圆盘数量门（2026-08-07 Step 3 接入，叠加在 judgeDot 环证据门之后而非替代：
	// 实测纯圆盘闸门任意组合规范位假 dot 最少 126 个（旧环链 28 个）——图标纹理
	// 在圆盘上是连续色块，空间特征不可分，环连续段与环主色 bgDist 才是抗纹理主
	// 防线；圆盘提供票数量级余量（真锚点 20-117 票 vs 环 6-16 贴底）。三闸校准
	// 依据见顶部 SCAN_REC 注释；叠加后严格严于旧链——假票只减不增、锚点 0 损失）
	const diskOk = (t, dk) => {
		const n = dk.votes[t] || 0;
		if (n < SCAN_REC.dotDiskHits) return false;
		const rival = Object.entries(dk.votes).reduce(
			(mx, [ty, m]) => (ty === t ? mx : Math.max(mx, m)),
			0,
		);
		// 邪走分类型上限 dotXieDiskRivalMax（校准依据见 data/scan-fp-refs.js 该键注释）；
		// 键缺失（旧数据文件）时回退全局值——与 SCAN_REC 整段缺失 throw 不同，单键缺
		// 失属增量部署场景，回退不产生错误结果
		const rivalMax =
			t === "邪" && SCAN_REC.dotXieDiskRivalMax != null
				? SCAN_REC.dotXieDiskRivalMax
				: SCAN_REC.dotDiskRivalMax;
		if (rival > rivalMax) return false;
		return dk.glyphFrac >= SCAN_REC.dotDiskGlyphMin;
	};
	const judgeDisk = (t, f, dk, bgMin, hitMin) =>
		judgeDot(t, f, bgMin, hitMin) && diskOk(t, dk);
	// judgeSample 的圆盘叠加版（多数票/并列/火降级口径一致，仅每型判定加 diskOk）
	const judgeDiskSample = (f, dk, bgMin, hitMin) => {
		let dotType = null;
		let dotTopN = 0;
		ranges.forEach(([, , t]) => {
			const n = (f.dotVotes[t] || []).length;
			if (n > dotTopN) {
				dotTopN = n;
				dotType = t;
			}
		});
		if (!dotType) return null;
		if (judgeDisk(dotType, f, dk, bgMin, hitMin)) return dotType;
		if (dotType === "火") {
			let second = null;
			let secondN = 0;
			ranges.forEach(([, , t]) => {
				if (t === "火") return;
				const n = (f.dotVotes[t] || []).length;
				if (n > secondN) {
					secondN = n;
					second = t;
				}
			});
			if (second && judgeDisk(second, f, dk, bgMin, hitMin)) return second;
		}
		return null;
	};
	// 主判定顺序（与加邻域搜索前的基线完全一致，保证零回退；补救为新增放行，
	// 只救回被误杀格、不改变既有判定结果）：
	//   1) 规范位彩色路径；1.5) 规范位强票补救；2) 规范位体路径；
	//   2.5) 几何定位引导采样（scanLocateDot，新增放行同纪律）；3) 邻域徽标搜索（带防伪闸门）。
	let dot = false;
	let dotType = null;
	if (qual >= 0) {
		dotType = judgeDiskSample(f0, dk0);
		if (dotType) dot = true;
	}
	// 规范位强票补救（2026-08-04 干净 truth 重校，依据见顶部 SCAN_REC 注释）：
	// 规范位票数 ≥dotStrongVotes（远高于 dotHits）且类别方块在时，bgDist 边际带
	// [dotBgDistRemedy, dotBgDist) 放行——真锚点徽标与格底色色相接近时色距可低至
	// 72-78（火+金 (2,0) 火 78、木2 (0,0) 木 76、土+体 (1,4) 土 72，均因色距<80 被
	// 规范位误杀），而「强票+方块+暗纹+分类型防伪全过」组合下 1717 个候选格中非锚点
	// 色距最高仅 44（体3 (0,1) 土票），60 上下边距均 >12
	if (!dot && qual >= 0 && square) {
		const t = judgeDiskSample(f0, dk0, SCAN_REC.dotBgDistRemedy, SCAN_REC.dotStrongVotes);
		if (t) {
			dot = true;
			dotType = t;
		}
	}
	// 规范位圆盘补救（tier2，2026-08-07 Step 3）：tier1（judgeDiskSample）判负后，
	// 按环失败签名分支以圆盘量级证据补救（全量 3276 格逐格仿真校准，阈值与各门槛
	// 间隙数据见顶部 SCAN_REC 注释）：
	//   A/B 支——环失败仅为「票数/连续段」（小徽标结构性贴底：环 16 点对水/土
	//     小徽标先天只有 2-6 票，证据不足而非徽标不在），圆盘多数型过硬 rival 三闸
	//     且环其余证据门（bgDist/暗纹/防伪）全过：A 支类别方块在（徽标-方块对证据）；
	//     B 支无方块时要求 圆盘暗纹 ≥dotDiskRescueGlyphMin 且内盘暗纹
	//     ≤dotDiskRescueInDarkMax（真徽标=有色填充+暗字纹；暗绿叶/深木纹理两者
	//     皆高，亮水纹理两者皆低）。
	//   C 支——环失败仅为「bgDist」的逐型评估（环沿骑缝采样的中位色距在小/偏徽标
	//     上混入底色；点级剔除后的圆盘票点是纯徽标像素，盘主色 bgDist 才是真色距）。
	//     类型归属仍由环主色决定——圆盘含徽标周围的图标像素，盘多数型可能被图标
	//     污染：土7 (0,0) 盘多数型为金 76 票（金/土 hue 邻接）而环主色为土，真型土。
	//   校准结果：A 救回锚点 9 / 假票 5；B 救回 3（水11 (2,1)/(2,3)/(5,0)）/ 假票 0；
	//   C 救回 4（土7 (3,0) 等）/ 假票 0；规范位假 dot 合计 20 仍少于旧环链 28
	if (!dot && qual >= 0) {
		let top = null;
		let topN = 0;
		ranges.forEach(([, , t]) => {
			const n = dk0.votes[t] || 0;
			if (n > topN) {
				topN = n;
				top = t;
			}
		});
		if (top && topN >= SCAN_REC.dotDiskHits) {
			const rival = Object.entries(dk0.votes).reduce(
				(mx, [ty, m]) => (ty === top ? mx : Math.max(mx, m)),
				0,
			);
			const fails = judgeDotFails(top, f0, undefined, undefined, true);
			let ok = false;
			if (
				fails.length === 0 &&
				rival <= SCAN_REC.dotDiskRivalMax &&
				dk0.glyphFrac >= SCAN_REC.dotDiskGlyphMin
			) {
				// A / B 支（A 支附内盘暗纹上限：方块在但整盘皆暗的是暗色图标区——
				// 救回锚点 inDark max 0.781，假票 min 0.813，取既有先例 0.8）
				ok =
					(square && f0.inDarkFrac <= SCAN_REC.dotDiskRescueDarkMax) ||
					(dk0.glyphFrac >= SCAN_REC.dotDiskRescueGlyphMin &&
						f0.inDarkFrac <= SCAN_REC.dotDiskRescueInDarkMax);
			} 
			// C 支：逐型评估（类型归属由环主色决定，圆盘只作量/色距/暗纹证据）
			if (!ok) {
				let bestT = null;
				let bestN = -1;
				ranges.forEach(([, , t]) => {
					const pts = dk0.votePts[t];
					if (!pts || pts.length < SCAN_REC.dotDiskRescueVotes) return;
					if (pts.length <= bestN) return;
					const f2 = judgeDotFails(t, f0, undefined, undefined, true);
					if (!(f2.length === 1 && f2[0] === "bgDist")) return;
					if (dk0.glyphFrac < SCAN_REC.dotDiskRescueGlyphMin) return;
					if (f0.inVMed > SCAN_REC.dotDiskRescueInVMedMax) return;
					if (f0.inDarkFrac > SCAN_REC.dotDiskRescueDarkMax) return;
					// 盘主色（票点各通道中位数）与格底色距离
					const hs = pts.map((p) => p[0]).sort((a, b) => a - b);
					const ss = pts.map((p) => p[1]).sort((a, b) => a - b);
					const vs = pts.map((p) => p[2]).sort((a, b) => a - b);
					const mid = Math.floor(pts.length / 2);
					const [bgH, bgS, bgV] = bgHsv();
					const dh = Math.min(Math.abs(hs[mid] - bgH), 180 - Math.abs(hs[mid] - bgH));
					if (
						dh + Math.abs(ss[mid] - bgS) + Math.abs(vs[mid] - bgV) <
						SCAN_REC.dotDiskRescueBgMin
					)
						return;
					bestT = t;
					bestN = pts.length;
				});
				if (bestT) {
					ok = true;
					top = bestT;
				}
			}
			if (ok) {
				dot = true;
				dotType = top;
			}
		}
	}
	// 体（灰色徽标）专属路径：hue 无效，改判「低饱和灰盘 + 亮度区间 + 暗纹 + 亮度双峰」。
	// 亮度两档：亮灰徽标 [dotTiVMin, dotTiVMax]；深灰徽标（体2 样例 10 个锚点 V 中位
	// 75-129）[dotTiDarkVMin, dotTiVMin)，需更高的暗纹占比与双峰 std 兜底（深灰盘
	// +暗字纹亮度对比更大）。不再要求类别方块：体5 有锚点方块被图标遮挡（747 个
	// 非锚点占用格在本路径全条件下 0 通过，方块不是必要防线）
	if (!dot && qual >= 0) {
		const tiBright = inVMed >= SCAN_REC.dotTiVMin && inVMed <= SCAN_REC.dotTiVMax;
		const tiDark =
			inVMed >= SCAN_REC.dotTiDarkVMin &&
			inVMed < SCAN_REC.dotTiVMin &&
			inDarkFrac >= SCAN_REC.dotTiDarkGlyph &&
			inVStd >= SCAN_REC.dotTiDarkVStd;
		if (
			inLowSFrac >= SCAN_REC.dotTiLowS &&
			(tiBright || tiDark) &&
			inDarkFrac >= SCAN_REC.dotTiGlyph &&
			inVStd >= SCAN_REC.dotTiVStdMin
		) {
			dot = true;
			dotType = "体";
		}
	}
	// 几何定位引导采样（2026-08-07，scanLocateDot 边缘域同心双圆定位接入识别端）：
	// 规范位彩色/强票/体路径全负且环上留有残票（maxOv≥dotNbResidualMin，与邻域搜索闸门同源前提
	// ——真偏移徽标在规范位留小半弧残票，无残票格邻域闸门同样过不了）时先跑几何
	// 定位：核验通过且圆心显著偏离规范位（fromLocate）即在定位环心重采样判定。
	// 定位自带外侧底色/环带一致性/双向对比闸门（SCAN_LOCATE_DOT 头注），几何+颜色
	// 双重证据下不叠加邻域搜索的组合闸门；定位失败或定位处判定失败落回既有邻域
	// 盲搜兜底（贴角半切徽标等定位盲区靠它救回）。
	if (!dot && qual >= 0) {
		let maxOv = 0;
		ranges.forEach(([, , t]) => {
			const n = (f0.dotVotes[t] || []).length;
			if (n > maxOv) maxOv = n;
		});
		if (maxOv >= SCAN_REC.dotNbResidualMin) {
			const loc = scanLocateDot(data);
			let locT = null;
			if (loc.ok && loc.fromLocate) {
				const fLoc = sampleDot(
					loc.fx - SCAN_REC.dotCX,
					loc.fy - SCAN_REC.dotCY,
				);
				const dkLoc = samplers.sampleDisk(
					loc.fx - SCAN_REC.dotCX,
					loc.fy - SCAN_REC.dotCY,
				);
				locT = judgeDiskSample(fLoc, dkLoc);
				if (locT) {
					dot = true;
					dotType = locT;
				}
			}
			if (globalThis.SCAN_DOT_TRACE) {
				globalThis.SCAN_DOT_TRACE.push({
					locate: true,
					ok: loc.ok,
					fromLocate: loc.fromLocate,
					fx: +loc.fx.toFixed(3),
					fy: +loc.fy.toFixed(3),
					energy: loc.energy,
					pass: !!locT,
					t: locT,
				});
			}
		}
	}
	// 邻域徽标搜索（2026-08-04 干净 truth 重校；此前闸门在 truth 误标期校准，注释里
	// 「火+金 (2,0) 假命中 ov=9-12」实为真锚点，结论已用新数据推翻重校）：
	// 火+水（棋子未满）版式的角标徽标在格内统一
	// 偏低约 10-15px（徽标中心相对格顶 ≈33px，dotCY 期望 ≈20px；金1 同版式只有 16px；
	// 格宽 148px 即 0.07-0.10 格），环采样偏出徽标采到图标纹理，多数票被土/金抢走。
	// 规范位两条路径都判负时，在窗口（纵向 [-0.02,+0.12]、横向 ±0.04、步长 0.02≈3px@148）
	// 内平移采样中心（环+内盘一起）重试。误检是对抗重点：图标纹理在 39 个偏移位之一
	// 凑齐票数的概率远高于规范位（无闸门全量误检 +300 件），逐格特征（票数/连续段/
	// 方块/中环盘同色占比/平台宽度）实测均无法完全分开真伪（火+水 (0,4) 非锚点格
	// 伪造出 v=16 run=16 与真锚点 (1,5) 同签名），故闸门用组合条件（对
	// tools/bench/out/dot-trace.json 1717 个候选格校准后 TP=36、FP=0）：
	//   1) 规范位类别方块须存在（真锚点的徽标-方块对只下移 ~13px，方块仍大半压中；
	//      非锚点格在规范位有灰白块纯属巧合，通过率 15% vs 锚点 65%）
	//   2) 规范位同型票 ov ∈ [dotNbResidualMin,5]，或 ov ∈ [6,8] 且偏移位满环
	//      （v≥dotNbFullRingVotes）——真偏移徽标
	//      在规范位只留小半弧残票；ov≥9 放宽为「非土须偏移位满环级票（v≥dotNbOvVMin）」：
	//      干净 truth 下 ov≥9 且 v≥14 的非土命中全部是真锚点（火+金 (2,0) ov=12、
	//      火+水 (0,4)/(3,4) ov=9/12、木2 (0,0) ov=15）；土不放宽——4 个 cell:土 假命中
	//      （土1 (1,3)、土3 (2,1)、土6 (0,4)、土7 (4,6)，v=14-16）与真土锚点同签名，
	//      票数/连续段/disk/inDark/偏移距离均不可分；雷整段不设附加门槛——雷紫 hue
	//      [144,180) 在图标纹理中无票源（241 个雷偏移命中全部落在真雷锚点格，0 误检），
	//      真雷锚点偏移位票仅 6-13，v≥14 会整片误杀（雷1-雷9、雷+木2 共 31 格）
	//   3) 内盘暗纹 ≤dotNbInDarkMax（土7 (3,3) 金假命中落在全暗图标区 inDark=0.97）
	//   4) 土须满环级票（v≥dotNbFullRingVotes）：土 hue [8,17] 与橙黄图标纹理最近，弱票土全是误检
	// 评分取同型过闸命中数最多（真徽标偏移后呈平台，(3,6) 水平台 8 > 土平台 5）、
	// 次取票数、连续段、离规范位最近。
	if (!dot && qual >= 0) {
		const trace = globalThis.SCAN_DOT_TRACE; // 调试：记录各偏移位通过明细
		if (trace) {
			const votes = {};
			Object.entries(f0.dotVotes).forEach(([t, arr]) => { votes[t] = arr.length; });
			// 规范位各类型判定明细（校准「强票补救路径」用）：票数/连续段/bgDist/
			// 暗纹/是否过判定；pass=false 且 bgDist、glyph 均达标时可反推为防伪否决
			const detail = Object.keys(f0.dotVotes).map((t) => {
				const pts = f0.dotVotes[t];
				const hs = pts.map((p) => p[0]).sort((a, b) => a - b);
				const ss = pts.map((p) => p[1]).sort((a, b) => a - b);
				const vs = pts.map((p) => p[2]).sort((a, b) => a - b);
				const mid = Math.floor(pts.length / 2);
				const [bgH, bgS, bgV] = bgHsv();
				const dh = Math.min(Math.abs(hs[mid] - bgH), 180 - Math.abs(hs[mid] - bgH));
				return {
					t, v: pts.length, r: ringRun(f0, t),
					bgDist: Math.round(dh + Math.abs(ss[mid] - bgS) + Math.abs(vs[mid] - bgV)),
					hMed: +hs[mid].toFixed(1), sMed: +ss[mid].toFixed(1),
					vMed: +vs[mid].toFixed(1), vMin: +vs[0].toFixed(1),
					inVMed: +f0.inVMed.toFixed(1),
					inHMed: f0.inHMed === null ? null : +f0.inHMed.toFixed(1),
					glyph: +f0.inDarkFrac.toFixed(2), pass: !!judgeDot(t, f0),
				};
			});
			trace.push({ origin: true, votes, detail, square });
		}
		const gated = [];
		for (let iy = -1; iy <= 6; iy++) {
			for (let ix = -2; ix <= 2; ix++) {
				if (ix === 0 && iy === 0) continue;
				const f = sampleDot(ix * 0.02, iy * 0.02);
				(nbDotCache = nbDotCache || {})[ix + "," + iy] = f; // 供模型兜底复用
				const dk = samplers.sampleDisk(ix * 0.02, iy * 0.02); // 偏移位圆盘（带缓存）
				const t = judgeDiskSample(f, dk);
				if (!t) continue;
				const originVotes = (f0.dotVotes[t] || []).length;
				const v = f.dotVotes[t].length;
				const r = ringRun(f, t);
				if (trace) {
					// 中环盘同色占比：内盘与采样环之间（r 0.055-0.085 格）像素落在
					// 该类型 hue 区间且饱和达标的比例（校准参考，未入闸门）
					const cx0 = (SCAN_REC.dotCX + ix * 0.02) * N;
					const cy0 = (SCAN_REC.dotCY + iy * 0.02) * N;
					const r1 = 0.055 * N, r2 = 0.085 * N;
					let dIn = 0, dN = 0;
					for (let yy = Math.floor(cy0 - r2); yy <= cy0 + r2; yy++) {
						for (let xx = Math.floor(cx0 - r2); xx <= cx0 + r2; xx++) {
							const ddx = xx - cx0, ddy = yy - cy0;
							const rr = ddx * ddx + ddy * ddy;
							if (rr < r1 * r1 || rr > r2 * r2) continue;
							if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
							const i2 = (yy * N + xx) * 4;
							const [hh, sss] = scanRgb2Hsv(data[i2], data[i2 + 1], data[i2 + 2]);
							dN++;
							// hue 归属与 sampleDot 投票同口径（scanDotHueTypes）
							if (sss > SCAN_REC.dotMinS && scanDotHueTypes(hh, ranges).includes(t)) dIn++;
						}
					}
					trace.push({
						ox: +(ix * 0.02).toFixed(2), oy: +(iy * 0.02).toFixed(2), t,
						v, r, ov: originVotes,
						inDark: +f.inDarkFrac.toFixed(2), sq: sampleSquare(ix * 0.02, iy * 0.02),
						disk: dN ? +(dIn / dN).toFixed(2) : 0,
					});
				}
				if (!square) continue;
				if (originVotes < SCAN_REC.dotNbResidualMin) continue;
				const ovOk =
					originVotes <= 5 ||
					(originVotes <= 8 && v >= SCAN_REC.dotNbFullRingVotes) ||
					(originVotes >= 9 && t !== "土" && v >= SCAN_REC.dotNbOvVMin) ||
					t === "雷";
				if (!ovOk) continue;
				if (f.inDarkFrac > SCAN_REC.dotNbInDarkMax) continue;
				if (t === "土" && v < SCAN_REC.dotNbFullRingVotes) continue;
				gated.push({ t, v, r, ox: ix * 0.02, oy: iy * 0.02 });
			}
		}
		let best = null;
		for (const h of gated) {
			const nWin = gated.filter((x) => x.t === h.t).length;
			const d = Math.abs(h.ox) + Math.abs(h.oy);
			if (
				!best ||
				nWin > best.nWin ||
				(nWin === best.nWin && h.v > best.v) ||
				(nWin === best.nWin && h.v === best.v && h.r > best.r) ||
				(nWin === best.nWin && h.v === best.v && h.r === best.r && d < best.d)
			) {
				best = { t: h.t, nWin, v: h.v, r: h.r, d };
			}
		}
		if (best) {
			dot = true;
			dotType = best.t;
		}
	}
	// 数字徽标：右下深棕圆，只判断有无（圆内白字被棕底包围），不 OCR。
	// 初筛（enc/brownCnt）过后追加强化校验（brownFrac + 白点连通域尺寸区间，
	// 校准依据见文件头 SCAN_REC 注释）；强化特征只在初筛通过格上计算
	const t = Math.floor(0.7 * N);
	const brown = new Uint8Array(N * N);
	const whites = [];
	let brownCnt = 0;
	let circleN = 0;
	const bcx = SCAN_REC.badgeCX * N;
	const bcy = SCAN_REC.badgeCY * N;
	const br2 = (SCAN_REC.badgeR * N) ** 2;
	for (let y = t; y < N; y++) {
		for (let x = t; x < N; x++) {
			const dx = x - bcx;
			const dy = y - bcy;
			if (dx * dx + dy * dy > br2) continue;
			circleN++;
			const i = (y * N + x) * 4;
			const [h, s, v] = scanRgb2Hsv(data[i], data[i + 1], data[i + 2]);
			if (h >= 8 && h <= 30 && s >= 45 && v >= 50 && v <= 205) {
				brown[y * N + x] = 1;
				brownCnt++;
			}
			if (v > 180 && s < 80) whites.push([x, y]);
		}
	}
	let enc = 0;
	whites.forEach(([x, y]) => {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				if (dx * dx + dy * dy > 4) continue;
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
				if (brown[ny * N + nx]) {
					enc++;
					return;
				}
			}
		}
	});
	let badge = enc >= SCAN_REC.badgeMin && brownCnt >= SCAN_REC.badgeBrownMin;
	if (badge) {
		// brownFrac：圆内棕底像素占比（真徽标是完整棕色圆盘；图标棕色部件不规则）
		const brownFrac = brownCnt / circleN;
		// compMaxSize：圆内白点 8 连通域的最大尺寸（数字笔画是紧凑连通域；
		// 高光点要么零散过小、要么大块超上限）
		const wmask = new Uint8Array(N * N);
		whites.forEach(([x, y]) => {
			wmask[y * N + x] = 1;
		});
		const wseen = new Uint8Array(N * N);
		let compMaxSize = 0;
		whites.forEach(([x0, y0]) => {
			if (wseen[y0 * N + x0]) return;
			let size = 0;
			const stack = [[x0, y0]];
			wseen[y0 * N + x0] = 1;
			while (stack.length) {
				const [x, y] = stack.pop();
				size++;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx;
						const ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
						if (wmask[ny * N + nx] && !wseen[ny * N + nx]) {
							wseen[ny * N + nx] = 1;
							stack.push([nx, ny]);
						}
					}
				}
			}
			if (size > compMaxSize) compMaxSize = size;
		});
		badge =
			brownFrac >= SCAN_REC.badgeBrownFracMin &&
			compMaxSize >= SCAN_REC.badgeCompMin &&
			compMaxSize <= SCAN_REC.badgeCompMax;
	}
	// 空格兜底：底色投票会把带品质色的漩涡空格判成占用格（水7 样例 qconf=1.00）。
	// 真占用格必有大量图标像素（全库 min=735），空格只有漩涡纹理（全库 max=514），
	// 图标像素不足的格统一按空格处理（qual=-1，锚点/徽标一并抹除）
	const bgPx = scanCellBg(data);
	let iconPx = 0;
	for (let i = 0; i < N * N; i++) {
		const dr = Math.abs(data[i * 4] - bgPx[0]);
		const dg = Math.abs(data[i * 4 + 1] - bgPx[1]);
		const db = Math.abs(data[i * 4 + 2] - bgPx[2]);
		if (dr + dg + db > SCAN_REC.iconDiff) iconPx++;
	}
	if (iconPx < SCAN_REC.emptyIconPx) {
		qual = -1;
		qconf = 0;
		dot = false;
		dotType = null;
	}
	// 像素验证层（SCAN_PIXEL_MODEL，T2 全量 dot 验证器，校准依据见文件头注释）：
	// 只验证规则链判 dot=true 的格（模型兜底判中的不过，灰区在训练分布外）；
	// 否决后 dot=false/dotType=null，模型兜底可正常再判；skipModel（转储口径）
	// 与模型缺失（软守卫）时跳过；原判定留 pixelVeto 供调试。
	let pixelVeto = null;
	if (dot && !skipModel && window.SCAN_PIXEL_MODEL && window.SCAN_PIXEL_MODEL.gate) {
		const pm = window.SCAN_PIXEL_MODEL;
		const pv = scanPixelMlpScore(pm, scanPixelMlpFeats(data));
		const vScore = Math.log(pv.probs.real + 1e-12) - Math.log(pv.probs.fake + 1e-12);
		// 分类型阈值（calib-pixel 按规则链 dotType 分组的出折真锚点 min 校准，依据
		// 见模型段头注释）：全局阈值被最差类型（邪，暗徽标泛化落差大）拖低时其余
		// 类型仍保杀假能力；vScoreThByType 缺失或未覆盖该类型时回退全局阈值
		const thByType =
			pm.gate.vScoreThByType && dotType !== null
				? pm.gate.vScoreThByType[dotType]
				: undefined;
		const vScoreTh = thByType === undefined ? pm.gate.vScoreTh : thByType;
		if (vScore < vScoreTh) {
			pixelVeto = { dotType, vScore: +vScore.toFixed(4) };
			dot = false;
			dotType = null;
		}
	}
	// 灰区统计模型兜底（SCAN_TYPE_MODEL，生成物与闸门校准依据见文件头注释）：
	// 规范位彩色/强票补救/体路径/邻域闸门与空格兜底全部判负后才触发（判中格
	// 零开销）；灰区特征复用本格采样器与邻域搜索已采样的偏移位结果，不重复扫图。
	// 软守卫：模型未加载（SCAN_TYPE_MODEL 缺失）时直接跳过——模型是规则链的
	// 增强兜底而非必需，缺失不产生错误结果，故不像 SCAN_REC 那样 throw。
	if (!dot && !skipModel && window.SCAN_TYPE_MODEL && window.SCAN_TYPE_MODEL.gate) {
		const m = window.SCAN_TYPE_MODEL;
		const dotCache = Object.assign({ "0,0": f0 }, nbDotCache);
		const gfeats = scanCellGrayFeats(
			data,
			ranges,
			{ qual, qconf, square, badge, iconPx },
			samplers,
			dotCache,
		);
		const sc = scanTypeModelScore(m, gfeats);
		// 闸门双条件同时满足才放行（ovr 打分不含 neg 类，best!=="neg" 为防御性检查）
		if (
			sc.best !== "neg" &&
			sc.bestScore >= m.gate.scoreTh &&
			sc.margin >= m.gate.marginMin
		) {
			dot = true;
			dotType = sc.best;
		}
	}
	// 圆盘影子判定（2026-08-07 Step 2，仅记录不参与任何判定结果）：规范位圆盘
	// 投票 + scanDiskJudge 信号级判定，经 SCAN_DOT_TRACE 输出（条目带 shadow 标记，
	// 与 origin/locate 条目并存——现有消费者按 origin/locate/ox 字段识别，互不影响）。
	// 生产路径不设置 SCAN_DOT_TRACE，零开销；采样结果走 sampleDisk 偏移位缓存
	if (globalThis.SCAN_DOT_TRACE && qual >= 0) {
		const dk = samplers.sampleDisk(0, 0);
		globalThis.SCAN_DOT_TRACE.push({
			shadow: true,
			votes: { ...dk.votes },
			tot: dk.tot,
			glyphFrac: +dk.glyphFrac.toFixed(3),
			shadowType: scanDiskJudge(dk, ranges),
			dot,
			dotType,
		});
	}
	return { qual, qconf, dot, dotType, square, badge, iconPx, data, pixelVeto };
}

/**
 * 灰区统计分类器特征向量（训练转储与集成兜底打分共用，用途见文件头注释）。
 * 内部以 skipModel=true 跑一遍 scanCellFeat 取 qual/qconf/square/badge/iconPx/
 * dot/dotType（与快路径判定完全同源；模型补救不回流训练标签，也防递归），
 * 特征向量本体由 scanCellGrayFeats 计算。
 * 返回 { dot, dotType, feats }（feats 维清单见 scanCellGrayFeats 注释）。
 */
function scanCellTypeFeats(data, dotTypes) {
	const ranges = dotTypes || SCAN_DOT_TYPES;
	const feat = scanCellFeat(data, dotTypes, true);
	const feats = scanCellGrayFeats(data, ranges, feat);
	return { dot: feat.dot, dotType: feat.dotType, feats };
}

/**
 * 灰区特征向量本体：给定 scanCellFeat 结果（feat，至少含 qual/qconf/square/
 * badge/iconPx）计算 ~68 维特征。samplers / dotCache 可选传入做采样复用
 * （scanCellFeat 模型兜底路径把本格采样器与邻域搜索已采样的偏移位结果传入，
 * 避免重复扫图；缺省时自建采样器全量采样）。采样参数全部读 SCAN_REC，
 * hue 区间读 SCAN_DOT_TYPES（ranges）。
 *
 * feats 为扁平字典（维名 -> 数值，null 表示该维缺失——模型按缺失掩码处理）：
 *   规范位（sampleDot(0,0)，类型取 SCAN_DOT_TYPES 六类）：
 *     v{t}     — 环 16 点该类型票数（0-16）
 *     r{t}     — 环上该类型最长连续段（0-16）
 *     mh/ms/mv — 多数票（票数最高类型）h/s/v 中位；无票时全 null
 *     bgDist   — 多数票主色与格底色 HSV 距离（环形 hue 差+|ΔS|+|ΔV|，与
 *                judgeDot 同口径）；无票时 null
 *     rvMin    — 环上多数票点最低亮度（真徽标满环时暗字纹压环，值低；
 *                均匀材质 ~100）；无票时 null
 *     gdMed    — 内盘饱和 hue 中位与环主色的环形差（环芯同色校验）；
 *                无票或无饱和像素时 null
 *     inDark / inLowS / inVMed / inHMed / inVStd — 内盘统计（inHMed 无饱和
 *                像素时为 null，如体类灰徽标）
 *   规范位圆盘（sampleDisk(0,0)，2026-08-07 Step 3 增维）：
 *     dv{t}    — 圆盘该类型有效票数（0-117，点级背景剔除后；小徽标水/土
 *                结构性 23-100 票，环 16 点只有 2-16——灰区模型主信号）
 *     dglyph   — 圆盘暗纹（V<150）占比
 *   格级（scanCellFeat 结果 + 格底色）：
 *     bgH/bgS/bgV — 格底色 HSV（边缘带中位数）；square/badge — 0/1；
 *     sqSat — 规范位方块饱和度中位（连续值）；qual（-1..4）/ qconf / iconPx
 *   邻域搜索窗口（与现有闸门同窗口：纵向 [-0.02,+0.12]、横向 ±0.04、步长 0.02，
 *   共 38 个偏移位），按类型取「最佳偏移位」（票数最高，打平取连续段长、再取
 *   离规范位近者）：
 *     nw{t}    — 最佳偏移位票数（无任何偏移位有票时 0，其余维度 null）
 *     nr{t}    — 最佳偏移位环最长连续段
 *     nd{t}    — 最佳偏移距离（|ox|+|oy|，格宽比例）
 *     np{t}    — 平台宽度：该类型票数 ≥SCAN_REC.dotHits 的偏移位计数
 *     nsq{t}   — 最佳偏移位随动方块（sampleSquare，0/1）
 *     ndisk{t} — 最佳偏移位中环盘（内盘与采样环之间，r 0.055-0.085 格，与
 *                SCAN_DOT_TRACE 调试块同口径）同色占比
 *     dnw{t}   — 最佳偏移位圆盘票数（圆盘口径，Step 3 增维；最佳位按圆盘票
 *                独立选取，打平取离规范位近者；无票 0）
 *     dnp{t}   — 圆盘平台宽度：圆盘票数 ≥SCAN_REC.dotDiskHits 的偏移位计数
 */
function scanCellGrayFeats(data, ranges, feat, samplers, dotCache) {
	const N = SCAN_CELL_SIZE;
	const { sampleSquare, sampleDot, sampleDisk, ringRun, bgHsv } =
		samplers || scanDotSamplers(data, ranges);
	// 偏移位采样（"ix,iy" 整数键缓存复用，未命中才现采）
	const dotAt = (ix, iy) => {
		const key = ix + "," + iy;
		return (dotCache && dotCache[key]) || sampleDot(ix * 0.02, iy * 0.02);
	};
	const types = ranges.map((r) => r[2]);
	const feats = {};
	// 规范位：六类型票数与环最长连续段、多数票主色与色距、内盘统计
	const f0 = dotAt(0, 0);
	const [bgH, bgS, bgV] = bgHsv();
	let topT = null;
	let topN = 0;
	types.forEach((t) => {
		const arr = f0.dotVotes[t];
		feats[`v${t}`] = arr ? arr.length : 0;
		feats[`r${t}`] = ringRun(f0, t);
		if (arr && arr.length > topN) {
			topN = arr.length;
			topT = t;
		}
	});
	if (topT) {
		const pts = f0.dotVotes[topT];
		const hs = pts.map((p) => p[0]).sort((a, b) => a - b);
		const ss = pts.map((p) => p[1]).sort((a, b) => a - b);
		const vs = pts.map((p) => p[2]).sort((a, b) => a - b);
		const mid = Math.floor(pts.length / 2);
		const dh = Math.min(Math.abs(hs[mid] - bgH), 180 - Math.abs(hs[mid] - bgH));
		feats.mh = hs[mid];
		feats.ms = ss[mid];
		feats.mv = vs[mid];
		feats.bgDist = dh + Math.abs(ss[mid] - bgS) + Math.abs(vs[mid] - bgV);
		// 环上多数票最低亮度：真徽标满环时暗色字纹必压到环上（vMin 低），
		// 均匀材质环 vMin ~100（土防伪 dotTuRingVMin 同依据）
		feats.rvMin = vs[0];
		// 环芯同色校验：真徽标内盘饱和像素 hue 中位与环主色接近（金防伪
		// dotJinGlyphDh 同依据），同质纹理/杂色图标两者偏离大
		feats.gdMed =
			f0.inHMed === null
				? null
				: Math.min(Math.abs(f0.inHMed - hs[mid]), 180 - Math.abs(f0.inHMed - hs[mid]));
	} else {
		feats.mh = null;
		feats.ms = null;
		feats.mv = null;
		feats.bgDist = null;
		feats.rvMin = null;
		feats.gdMed = null;
	}
	feats.inDark = f0.inDarkFrac;
	feats.inLowS = f0.inLowSFrac;
	feats.inVMed = f0.inVMed;
	feats.inHMed = f0.inHMed; // 可能为 null（无饱和像素），模型按缺失掩码处理
	feats.inVStd = f0.inVStd;
	// 规范位圆盘特征（Step 3 增维；sampleDisk 带缓存，与判定链同源）
	const dk0 = sampleDisk(0, 0);
	types.forEach((t) => {
		feats[`dv${t}`] = dk0.votes[t] || 0;
	});
	feats.dglyph = dk0.glyphFrac;
	feats.bgH = bgH;
	feats.bgS = bgS;
	feats.bgV = bgV;
	feats.square = feat.square ? 1 : 0;
	// 规范位方块饱和度中位（连续值，square 布尔特征的细粒度版）
	{
		const sqx = Math.round(SCAN_REC.squareX * N);
		const sqy = Math.round(SCAN_REC.squareY * N);
		const sats = [];
		for (let dy = -3; dy <= 3; dy++) {
			for (let dx = -3; dx <= 3; dx++) {
				const py = sqy + dy;
				const px = sqx + dx;
				if (px < 0 || py < 0 || px >= N || py >= N) continue;
				const i = (py * N + px) * 4;
				sats.push(scanRgb2Hsv(data[i], data[i + 1], data[i + 2])[1]);
			}
		}
		sats.sort((a, b) => a - b);
		feats.sqSat = sats.length ? sats[Math.floor(sats.length / 2)] : null;
	}
	feats.badge = feat.badge ? 1 : 0;
	feats.qual = feat.qual;
	feats.qconf = feat.qconf;
	feats.iconPx = feat.iconPx;
	// 中环盘同色占比（内盘与采样环之间 r 0.055-0.085 格，hue 归属该类型
	// 且饱和达标的像素比例；与 SCAN_DOT_TRACE 调试块同口径，hue 归属与
	// sampleDot 投票同为 scanDotHueTypes 口径）
	const diskFrac = (ox, oy, t) => {
		const cx0 = (SCAN_REC.dotCX + ox) * N;
		const cy0 = (SCAN_REC.dotCY + oy) * N;
		const r1 = 0.055 * N;
		const r2 = 0.085 * N;
		let dIn = 0;
		let dN = 0;
		for (let yy = Math.floor(cy0 - r2); yy <= cy0 + r2; yy++) {
			for (let xx = Math.floor(cx0 - r2); xx <= cx0 + r2; xx++) {
				const ddx = xx - cx0;
				const ddy = yy - cy0;
				const rr = ddx * ddx + ddy * ddy;
				if (rr < r1 * r1 || rr > r2 * r2) continue;
				if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
				const i = (yy * N + xx) * 4;
				const [hh, sss] = scanRgb2Hsv(data[i], data[i + 1], data[i + 2]);
				dN++;
				if (sss > SCAN_REC.dotMinS && scanDotHueTypes(hh, ranges).includes(t)) {
					dIn++;
				}
			}
		}
		return dN ? dIn / dN : 0;
	};
	// 邻域搜索窗口（与现有闸门同窗口）：各类型最佳偏移位特征
	const nbBest = {}; // t -> { v, r, d, ox, oy }
	const nbPlateau = {}; // t -> 票数 >= dotHits 的偏移位计数
	const nbDiskBest = {}; // t -> { v, d }（圆盘票数最佳位）
	const nbDiskPlateau = {}; // t -> 圆盘票数 >= dotDiskHits 的偏移位计数
	types.forEach((t) => {
		nbPlateau[t] = 0;
		nbDiskPlateau[t] = 0;
	});
	for (let iy = -1; iy <= 6; iy++) {
		for (let ix = -2; ix <= 2; ix++) {
			if (ix === 0 && iy === 0) continue;
			const ox = ix * 0.02;
			const oy = iy * 0.02;
			const f = dotAt(ix, iy);
			const dk = sampleDisk(ox, oy); // 工厂内缓存，判定链已采的偏移位零开销
			const d = Math.abs(ox) + Math.abs(oy);
			types.forEach((t) => {
				const dv = dk.votes[t] || 0;
				if (dv >= SCAN_REC.dotDiskHits) nbDiskPlateau[t]++;
				const db = nbDiskBest[t];
				if (!db || dv > db.v || (dv === db.v && d < db.d)) {
					nbDiskBest[t] = { v: dv, d };
				}
				const arr = f.dotVotes[t];
				if (!arr || !arr.length) return;
				const v = arr.length;
				if (v >= SCAN_REC.dotHits) nbPlateau[t]++;
				const r = ringRun(f, t);
				const b = nbBest[t];
				if (!b || v > b.v || (v === b.v && r > b.r) || (v === b.v && r === b.r && d < b.d)) {
					nbBest[t] = { v, r, d, ox, oy };
				}
			});
		}
	}
	types.forEach((t) => {
		const db = nbDiskBest[t];
		feats[`dnw${t}`] = db ? db.v : 0;
		feats[`dnp${t}`] = nbDiskPlateau[t];
		const b = nbBest[t];
		if (!b) {
			feats[`nw${t}`] = 0;
			feats[`nr${t}`] = null;
			feats[`nd${t}`] = null;
			feats[`np${t}`] = 0;
			feats[`nsq${t}`] = null;
			feats[`ndisk${t}`] = null;
			return;
		}
		feats[`nw${t}`] = b.v;
		feats[`nr${t}`] = b.r;
		feats[`nd${t}`] = b.d;
		feats[`np${t}`] = nbPlateau[t];
		feats[`nsq${t}`] = sampleSquare(b.ox, b.oy) ? 1 : 0;
		feats[`ndisk${t}`] = diskFrac(b.ox, b.oy, t);
	});
	return feats;
}

/**
 * 模型打分（纯函数，2026-08-04 自 scan-bench.js 移入：生产兜底路径在
 * scanCellFeat 内，index.html 只加载本文件，推理打分须与识别核心同驻；
 * 训练/调闸门等评估函数仍留在 scan-bench.js）：返回各类得分与第一名/第二名。
 * nb：loglik_c = log(prior_c) + Σ_有效维 [-0.5·log(2π·var) - (x-mean)²/(2·var)]
 * centroid：score_c = -0.5 · Σ_有效维 (x-mean)²/var（var 同样取类内收缩方差）
 * tree：沿树走到叶节点（缺失维按节点 ml 定向），score_c = log 平滑后类概率。
 * ovr：每棵「类型 vs 其余」树走到叶，score_t = log 加权叶概率（不含 neg，
 *     是否判负由闸门决定）。
 * 返回 { scores, best, bestScore, second, secondScore, margin }。
 */
function scanTypeModelScore(model, feats) {
	const scores = {};
	if (model.kind === "tree") {
		let node = model.tree[0];
		while (node.d !== undefined) {
			const x = feats[model.dims[node.d]];
			const goLeft = x === null || x === undefined ? !!node.ml : x <= node.th;
			node = model.tree[goLeft ? node.l : node.r];
		}
		// 叶节点类分布按训练时的类权重折算（正负 1:60 失衡，原始计数下
		// 「1 正 + 3 负」的叶会被 neg 抢走；加权后正类叶在留一 CV 各折间稳定）
		const wOf = (cl) => (cl === "neg" ? 1 : model.posWeight || 30);
		const smooth = 1;
		let tot = 0;
		model.classes.forEach((cl, i) => (tot += wOf(cl) * node.dist[i] + smooth));
		model.classes.forEach((cl, i) => {
			scores[cl] = Math.log((wOf(cl) * node.dist[i] + smooth) / tot);
		});
	} else if (model.kind === "ovr") {
		// 一对其余：每棵树给出「该类型 vs 其余」的加权叶概率，得分 = log(p_t)。
		// scores 不含 neg——是否判负交由闸门（scoreTh/marginMin）决定。
		const posWeight = model.posWeight || 30;
		Object.keys(model.ovr).forEach((t) => {
			let node = model.ovr[t].tree[0];
			while (node.d !== undefined) {
				const x = feats[model.dims[node.d]];
				const goLeft = x === null || x === undefined ? !!node.ml : x <= node.th;
				node = model.ovr[t].tree[goLeft ? node.l : node.r];
			}
			// dist[0]=该类型计数，dist[1]=neg 计数（与训练时 classes=[t,"neg"] 对齐）
			const p = (posWeight * node.dist[0] + 1) / (posWeight * node.dist[0] + node.dist[1] + 2);
			scores[t] = Math.log(p);
		});
	} else {
		model.classes.forEach((cl) => {
			const st = model.stats[cl];
			let s = model.kind === "centroid" ? 0 : Math.log(st.prior);
			model.dims.forEach((d, i) => {
				const x = feats[d];
				if (x === null || x === undefined) return; // 特征缺失：该维不计入
				const m = st.mean[i];
				if (m === null) return; // 该类该维缺失：该维不计入
				const v = st.var[i];
				if (model.kind !== "centroid") s += -0.5 * Math.log(2 * Math.PI * v);
				s += -((x - m) ** 2) / (2 * v);
			});
			scores[cl] = s;
		});
	}
	const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
	// 空得分守卫：灰区正样本趋零时按图留一的出折模型可能无任何可评类
	// （ovr 无正类树），此时恒判 neg（不补救），不抛异常
	if (!ranked.length) {
		return {
			scores,
			best: "neg",
			bestScore: -Infinity,
			second: null,
			secondScore: null,
			margin: Infinity,
		};
	}
	return {
		scores,
		best: ranked[0][0],
		bestScore: ranked[0][1],
		second: ranked[1] ? ranked[1][0] : null,
		secondScore: ranked[1] ? ranked[1][1] : null,
		margin: ranked[1] ? ranked[0][1] - ranked[1][1] : Infinity,
	};
}

/**
 * 像素验证器输入向量（纯函数）：64×64 RGBA → 16×16×3 HSV 归一化 [0,1]。
 * 与 scan-bench.js scanPixelFeats 同一流程（同一 scanResampleBilinear 双线性
 * 降采样 + scanRgb2Hsv），训练/推理口径逐位一致（对拍：
 * tools/bench/out/verify-pixel-core.js，全 2646 格逐维全等）。
 */
function scanPixelMlpFeats(data) {
	const S = 16;
	const N = SCAN_CELL_SIZE;
	const small = scanResampleBilinear(data, N, N, 0, 0, N, N, S, S);
	const x = new Array(S * S * 3);
	for (let i = 0; i < S * S; i++) {
		const [h, s, v] = scanRgb2Hsv(small[i * 4], small[i * 4 + 1], small[i * 4 + 2]);
		x[i * 3] = h / 179;
		x[i * 3 + 1] = s / 255;
		x[i * 3 + 2] = v / 255;
	}
	return x;
}

/**
 * 像素验证器前向传播（纯函数）：1 隐层 tanh + softmax（Float32Array），
 * 读 SCAN_PIXEL_MODEL 的 xMean/xStd/W1/b1/W2/b2（arch 子对象兼容，与
 * scan-bench.js scanMlpScore 同口径）。返回 { probs }；判定分数
 * vScore = log p(real) - log p(fake)，闸门在 SCAN_PIXEL_MODEL.gate.vScoreTh。
 */
function scanPixelMlpScore(model, x) {
	const arch = model.arch || model;
	const { dims, hidden, activation } = arch;
	const { classes } = model;
	const K = classes.length;
	const A1 = new Float32Array(hidden);
	for (let h = 0; h < hidden; h++) {
		let z = model.b1[h];
		for (let d = 0; d < dims; d++) z += ((x[d] - model.xMean[d]) / model.xStd[d]) * model.W1[d * hidden + h];
		A1[h] = activation === "relu" ? Math.max(z, 0) : Math.tanh(z);
	}
	const Z2 = new Float32Array(K);
	for (let k = 0; k < K; k++) {
		let z = model.b2[k];
		for (let h = 0; h < hidden; h++) z += A1[h] * model.W2[h * K + k];
		Z2[k] = z;
	}
	let mx = -Infinity;
	for (let k = 0; k < K; k++) mx = Math.max(mx, Z2[k]);
	let es = 0;
	for (let k = 0; k < K; k++) es += Math.exp(Z2[k] - mx);
	const probs = {};
	classes.forEach((c, k) => { probs[c] = Math.exp(Z2[k] - mx) / es; });
	return { probs };
}

/** 徽标几何定位参数（scanLocateDot 用，bench 标定后在此调整；不放 SCAN_REC
 *  ——定位结果只决定环心 / 半径先验，不进指纹与模型，改动不触发重训口径）。
 *  边缘域同心双圆方案（2026-08-07 原型验证后替换原"径向梯度+实心剖面"像素
 *  统计方案；原型 tools/dotproto/algo.js，评估 tools/bench/eval-dot-locate.js。
 *  全库 3276 格（pixel-dump）：锚点召回 98.2%、非锚点误检 0.6%、圆心偏移
 *  p50=1.44px / p99=4.4px，八类元素 92%~100%）。
 *  流程：
 *  1) Di Zenzo 彩色梯度边缘图——等亮度但异色度的边（雷徽标淡紫环）在亮度
 *     梯度上为零边、在彩色梯度上真实存在；
 *  2) 左上小区域 × 半径域穷举，**同心双圆联合评分**（外沿 + 内沿 inset
 *     2~4px：徽标普遍有两条同圆心圆边——雷=淡盘+暗环+淡描边、火=暗盘+亮环、
 *     体=白字盘+暗厚环；真圆心吃双边证据，只套中单边的候选分减半），边贡献
 *     按梯度方向与径向对齐度加权、幅值相对自适应阈值封顶（整周中等强度的
 *     真环 > 局部超强的图标描边/字纹），再乘规范位高斯先验（贴角落徽标的
 *     弱边分打不过格子中部强纹理）；
 *  3) NMS 取前 candMax 个候选，第一个通过完整核验的胜出（几何提议、颜色
 *     仲裁——几何平分秋色时靠"环带颜色一致且与内外均异色"裁决；名次 ≥1
 *     的候选几何分须 ≥ 头名 × candScoreFrac 才给翻盘，防纹理格低分候选
 *     碰巧过颜色）；
 *  4) 外沿 rOut 只从"外侧是格底色"（bgFrac）的半径里按环带质量
 *     bandQ = 外对比度/(1+std) 选取——剖面最大值常落在环-盘内沿（体徽标
 *     白字 226 vs 暗环 51 对比极端），"外侧是底色"才是外沿的定义特征 */
var SCAN_LOCATE_DOT = {
	blur: true, // 梯度前 3×3 高斯模糊（抗锯齿边合并为单响应）
	edgePct: 80, // 边缘阈值 = 左上区域内梯度幅值的分位数（0-100，自适应底色）
	edgeFloor: 18, // 分位数结果的绝对下限（0-255 梯度幅值，防全平区阈值归零）
	angles: 32, // 圆周采样角度数
	alignW: 0.7, // 径向对齐权重：边贡献 = 幅值 × (1-alignW + alignW×|dir·radial|)
	magCap: 1.5, // 边幅值相对阈值的封顶倍数（整周中等边 > 局部超强边）
	supPow: 2, // 支撑度惩罚幂次：score = 平均边贡献 × 软支撑度^supPow
	supMin: 0.6, // 外沿圆周软支撑度下限（软支撑 = Σmin(m/thr,1)/K：淡紫/灰
	// 环边软，硬阈值整周漏票；漩涡杂边方向随机被对齐权重压掉）
	cLo: 0.05, // 圆心搜索域（格宽比例，徽标限定左上区域）
	cHi: 0.3,
	rLo: 5, // 外沿半径搜索域（px，逐 1px）
	rHi: 12,
	insetLo: 2, // 同心内沿间距搜索域（px，环带宽 2~4）
	insetHi: 4,
	inW: 0.7, // 内沿评分权重（相对外沿）
	candMax: 5, // 颜色仲裁的候选数（NMS 后按分降序）
	candMinDist: 2.5, // NMS 候选间最小圆心距（px）
	candScoreFrac: 0.6, // 翻盘线：名次 ≥1 的候选过核验后，几何分还须 ≥ 头名 × 此值
	rProfLo: 2, // 径向剖面扫描范围（px）
	rProfHi: 14,
	rEdgeLo: 6, // 外沿合法区间（px，真值 ≈8~10 留余量——半径不定死，越界不认）
	rEdgeHi: 11,
	bgTol: 40, // 外侧环带像素与底色的 RGB L1 均值距离容差（判"再往外是底色"）
	bgFracMin: 0.4, // 外沿候选 r 的外侧环带底色占比下限（不达标不给当外沿）
	bandAngles: 24, // 环带颜色采样角度数
	bandInset: 1.5, // 环带采样半径 = rOut - 此值（px，环带贴外沿内侧）
	bandQStd: 20, // 环带质量 bandQ = 外对比度 / (1 + std/此值)，外沿选取器
	bandStdMax: 35, // 环带颜色一致性：RGB 各通道 std 均值上限
	contrastMin: 25, // 环带 vs 内盘 / 外底 RGB L1 均值距离，两者较小者的下限
	priorSig: 5, // 规范位空间先验高斯 σ（px，0=关闭）：候选得分 ×
	// exp(-d²/2σ²) 再排名，d≈4px 内几乎不惩罚（≈0.73）
};

/**
 * 单格元素徽标几何定位（边缘域同心双圆，无视元素颜色先验）：
 * 流程与各项参数的标定依据见 SCAN_LOCATE_DOT 头注。定位出圆心与实测
 * 外缘 rOut；采样环半径维持校准基准 SCAN_REC.dotR（发光环带 hue 沿半径
 * 有梯度，逐格自适应会打散已校准 hue 分布——旧版 bench 半径策略对比实测
 * 污染率 0.087→0.195，故半径只实测、不喂采样）。
 * 返回 { fx, fy（格宽比例圆心）, fr（=SCAN_REC.dotR）, energy, ok,
 * fromLocate（核验通过且圆心显著偏离规范位±1px）, locEnergy, canonEnergy,
 * rEdge（实测外缘 px，未过核验为 0） }。
 * 供校准确认页预置采样环、识别侧先验 */
function scanLocateDot(data) {
	const N = SCAN_CELL_SIZE;
	const P = SCAN_LOCATE_DOT;
	// 1. Di Zenzo 彩色梯度边缘图（先 3×3 高斯模糊，抗锯齿边合并为单响应）
	let px = data;
	if (P.blur) {
		px = new Float32Array(N * N * 4);
		const tmp = new Float32Array(N * N * 4);
		for (let y = 0; y < N; y++) {
			for (let x = 0; x < N; x++) {
				const i = (y * N + x) * 4;
				for (let c = 0; c < 4; c++) {
					const l = x > 0 ? data[i - 4 + c] : data[i + c];
					const m = data[i + c];
					const r = x < N - 1 ? data[i + 4 + c] : data[i + c];
					tmp[i + c] = (l + 2 * m + r) / 4;
				}
			}
		}
		for (let y = 0; y < N; y++) {
			for (let x = 0; x < N; x++) {
				const i = (y * N + x) * 4;
				for (let c = 0; c < 4; c++) {
					const u = y > 0 ? tmp[i - N * 4 + c] : tmp[i + c];
					const m = tmp[i + c];
					const d = y < N - 1 ? tmp[i + N * 4 + c] : tmp[i + c];
					px[i + c] = (u + 2 * m + d) / 4;
				}
			}
		}
	}
	const mag = new Float32Array(N * N);
	const dirx = new Float32Array(N * N);
	const diry = new Float32Array(N * N);
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const i = y * N + x;
			const il = y * N + Math.max(0, x - 1);
			const ir = y * N + Math.min(N - 1, x + 1);
			const iu = Math.max(0, y - 1) * N + x;
			const id = Math.min(N - 1, y + 1) * N + x;
			let sx = 0;
			let sy = 0;
			let tx = 0;
			for (let c = 0; c < 3; c++) {
				const gx = (px[ir * 4 + c] - px[il * 4 + c]) / 2;
				const gy = (px[id * 4 + c] - px[iu * 4 + c]) / 2;
				sx += gx * gx;
				sy += gy * gy;
				tx += gx * gy;
			}
			const a2 = (sx + sy) / 2;
			const b2 = Math.sqrt(((sx - sy) / 2) ** 2 + tx * tx);
			mag[i] = Math.sqrt(Math.max(0, a2 + b2));
			const th = 0.5 * Math.atan2(2 * tx, sx - sy);
			dirx[i] = Math.cos(th);
			diry[i] = Math.sin(th);
		}
	}
	// 左上区域内自适应边缘阈值（分位数 + 绝对下限，防全平区阈值归零）
	const RW = Math.round(N * 0.45);
	const region = [];
	for (let y = 0; y < RW; y++)
		for (let x = 0; x < RW; x++) region.push(mag[y * N + x]);
	region.sort((a, b) => a - b);
	const edgeThr = Math.max(
		P.edgeFloor,
		region[Math.round(((region.length - 1) * P.edgePct) / 100)],
	);
	// 双线性采样器（越界按 0——贴角徽标的圈外角度自然失票）
	const bilin = (f, x, y) => {
		if (x < 0 || y < 0 || x > N - 1 || y > N - 1) return 0;
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const x1 = Math.min(N - 1, x0 + 1);
		const y1 = Math.min(N - 1, y0 + 1);
		const fx = x - x0;
		const fy = y - y0;
		return (
			f[y0 * N + x0] * (1 - fx) * (1 - fy) +
			f[y0 * N + x1] * fx * (1 - fy) +
			f[y1 * N + x0] * (1 - fx) * fy +
			f[y1 * N + x1] * fx * fy
		);
	};
	const K = P.angles;
	const cosT = [];
	const sinT = [];
	for (let k = 0; k < K; k++) {
		cosT.push(Math.cos((2 * Math.PI * k) / K));
		sinT.push(Math.sin((2 * Math.PI * k) / K));
	}
	/** 单圆周 (cx,cy,r) 评分：对齐加权边贡献 × 软支撑度惩罚 */
	const circScore = (cx, cy, r) => {
		let sum = 0;
		let sup = 0;
		for (let k = 0; k < K; k++) {
			const x = cx + cosT[k] * r;
			const y = cy + sinT[k] * r;
			const m = bilin(mag, x, y);
			if (m <= 0) continue;
			sup += Math.min(1, m / edgeThr);
			const dx = bilin(dirx, x, y);
			const dy = bilin(diry, x, y);
			const len = Math.hypot(dx, dy) || 1;
			const align = Math.abs((dx * cosT[k] + dy * sinT[k]) / len);
			sum +=
				Math.min(m / edgeThr, P.magCap) * (1 - P.alignW + P.alignW * align);
		}
		const support = sup / K;
		return { score: (sum / K) * Math.pow(support, P.supPow), support };
	};
	/** 规范位空间先验（高斯，priorSig=0 关闭） */
	const ccx = SCAN_REC.dotCX * N;
	const ccy = SCAN_REC.dotCY * N;
	const prior = (cx, cy) => {
		if (!P.priorSig) return 1;
		const dx = cx - ccx;
		const dy = cy - ccy;
		return Math.exp(-(dx * dx + dy * dy) / (2 * P.priorSig * P.priorSig));
	};
	/** 同心双圆联合评分：{ r, rIn, score, support }（未含先验） */
	const pairScore = (cx, cy) => {
		let b = null;
		for (let r = P.rLo; r <= P.rHi; r++) {
			const so = circScore(cx, cy, r);
			let best = { r, rIn: 0, score: so.score, support: so.support };
			for (let ins = P.insetLo; ins <= P.insetHi; ins++) {
				const ri = r - ins;
				if (ri < 2) continue;
				const si = circScore(cx, cy, ri);
				if (si.support < 0.3) continue; // 内沿起码支撑才计入，防纯噪声加分
				const s = so.score + P.inW * si.score;
				if (s > best.score)
					best = { r, rIn: ri, score: s, support: so.support };
			}
			if (!b || best.score > b.score) b = best;
		}
		return b;
	};
	// 2. 圆心穷举（整数 px，每圆心记最佳同心对）+ NMS 取候选
	const cMin = Math.max(0, Math.floor(P.cLo * N));
	const cMax = Math.min(N - 1, Math.ceil(P.cHi * N));
	const perCenter = [];
	for (let cy = cMin; cy <= cMax; cy++) {
		for (let cx = cMin; cx <= cMax; cx++) {
			const b = pairScore(cx, cy);
			b.score *= prior(cx, cy);
			perCenter.push({ cx, cy, ...b });
		}
	}
	perCenter.sort((a, b) => b.score - a.score);
	const cand = [];
	for (const c of perCenter) {
		if (cand.length >= P.candMax) break;
		if (cand.every((d) => Math.hypot(d.cx - c.cx, d.cy - c.cy) >= P.candMinDist))
			cand.push(c);
	}
	// 亚像素精化（±0.5，含先验重排）
	for (const c of cand) {
		for (const ox of [-0.5, 0, 0.5]) {
			for (const oy of [-0.5, 0, 0.5]) {
				if (!ox && !oy) continue;
				const b = pairScore(c.cx + ox, c.cy + oy);
				const sc = b.score * prior(c.cx + ox, c.cy + oy);
				if (sc > c.score) {
					c.cx += ox;
					c.cy += oy;
					c.r = b.r;
					c.rIn = b.rIn;
					c.score = sc;
					c.support = b.support;
				}
			}
		}
	}
	cand.sort((a, b) => b.score - a.score);
	const bg = scanCellBg(data); // 徽标浮在格子背景上：外沿外侧应与底色一致
	const l1At = (i, ref) =>
		(Math.abs(data[i] - ref[0]) +
			Math.abs(data[i + 1] - ref[1]) +
			Math.abs(data[i + 2] - ref[2])) /
		3;
	/** 候选完整核验：外侧底色核验 + bandQ 选外沿 → 闸门 */
	const evaluate = (cx, cy) => {
		// 径向边缘剖面（内沿显示用）
		const prof = [];
		for (let r = P.rProfLo; r <= P.rProfHi; r++) {
			let sum = 0;
			for (let k = 0; k < K; k++) {
				const x = cx + cosT[k] * r;
				const y = cy + sinT[k] * r;
				const m = bilin(mag, x, y);
				const dx = bilin(dirx, x, y);
				const dy = bilin(diry, x, y);
				const len = Math.hypot(dx, dy) || 1;
				const align = Math.abs((dx * cosT[k] + dy * sinT[k]) / len);
				sum += m * (1 - P.alignW + P.alignW * align);
			}
			prof.push(sum / K);
		}
		// 外侧底色核验：r+1.5 环带与底色匹配占比
		const bgFracAt = (r) => {
			let n = 0;
			let hit = 0;
			for (let k = 0; k < K; k++) {
				const x = Math.round(cx + cosT[k] * (r + 1.5));
				const y = Math.round(cy + sinT[k] * (r + 1.5));
				if (x < 0 || y < 0 || x >= N || y >= N) continue;
				n++;
				if (l1At((y * N + x) * 4, bg) <= P.bgTol) hit++;
			}
			return n ? hit / n : 0;
		};
		const bgFracs = [];
		for (let r = P.rEdgeLo; r <= P.rEdgeHi; r++) bgFracs.push(bgFracAt(r));
		// 每候选半径的环带量测：bandQ = 外对比度/(1+std) 驱动外沿选取
		// （不看内盘对比——雷大徽标的可用边界是暗盘沿，带采样落在暗盘里，
		// 与盘芯同色，用内盘对比会把正确半径压掉）
		const M = P.bandAngles;
		const meanOf = (arr) => {
			const m = [0, 0, 0];
			arr.forEach((p) => {
				m[0] += p[0];
				m[1] += p[1];
				m[2] += p[2];
			});
			return m.map((v) => v / Math.max(1, arr.length));
		};
		const l1 = (a, b) =>
			(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
		const ringAt = (rr) => {
			const px2 = [];
			for (let k = 0; k < M; k++) {
				const a = (2 * Math.PI * k) / M;
				const x = Math.round(cx + Math.cos(a) * rr);
				const y = Math.round(cy + Math.sin(a) * rr);
				if (x < 0 || y < 0 || x >= N || y >= N) continue;
				const i = (y * N + x) * 4;
				px2.push([data[i], data[i + 1], data[i + 2]]);
			}
			return px2;
		};
		const meas = [];
		for (let r = P.rEdgeLo; r <= P.rEdgeHi; r++) {
			const rm = Math.max(1, r - P.bandInset);
			const bandPx = ringAt(rm);
			const bandMean = meanOf(bandPx);
			let bandStd = 0;
			if (bandPx.length) {
				for (let c = 0; c < 3; c++) {
					const mu = bandMean[c];
					bandStd += Math.sqrt(
						bandPx.reduce((s, p) => s + (p[c] - mu) * (p[c] - mu), 0) /
							bandPx.length,
					);
				}
				bandStd /= 3;
			}
			// 内盘均值（r ≤ r-3 网格采样）
			const diskPx = [];
			const dr = Math.max(1, r - 3);
			for (let y = Math.floor(cy - dr); y <= Math.ceil(cy + dr); y++) {
				for (let x = Math.floor(cx - dr); x <= Math.ceil(cx + dr); x++) {
					if (x < 0 || y < 0 || x >= N || y >= N) continue;
					const ddx = x - cx;
					const ddy = y - cy;
					if (ddx * ddx + ddy * ddy > dr * dr) continue;
					const i = (y * N + x) * 4;
					diskPx.push([data[i], data[i + 1], data[i + 2]]);
				}
			}
			const diskMean = meanOf(diskPx);
			const outMean = meanOf(ringAt(r + 2));
			const inDist = l1(bandMean, diskMean);
			const outDist = l1(bandMean, outMean);
			const q = outDist / (1 + bandStd / P.bandQStd);
			meas.push({ r, rm, bandStd, inDist, outDist, q });
		}
		const pickBy = (okFn) => {
			let m = null;
			for (const mm of meas) if (okFn(mm) && (!m || mm.q > m.q)) m = mm;
			return m;
		};
		let sel = pickBy((m) => bgFracs[m.r - P.rEdgeLo] >= P.bgFracMin);
		const bgOk = !!sel;
		if (!sel) {
			// 兜底：外侧全被图标内容挡住（贴角落徽标）——放宽到 bgFrac≥0.3
			sel = pickBy((m) => bgFracs[m.r - P.rEdgeLo] >= 0.3);
		}
		if (!sel) sel = pickBy(() => true);
		const rOut = sel.r;
		// 内沿（展示用）：剖面在 [rOut-4, rOut-2] 的最大值
		let rIn = -1;
		for (let r = Math.max(P.rProfLo, rOut - 4); r <= rOut - 2; r++)
			if (rIn < 0 || prof[r - P.rProfLo] > prof[rIn - P.rProfLo]) rIn = r;
		const outCirc = circScore(cx, cy, rOut);
		// 闸门：支撑度 + 外侧底色 + 环带一致性 + 环带与内外双向对比
		const ok =
			outCirc.support >= P.supMin &&
			bgOk &&
			sel.bandStd <= P.bandStdMax &&
			Math.min(sel.inDist, sel.outDist) >= P.contrastMin;
		return { ok, rOut, rIn, support: outCirc.support };
	};
	// 4. 颜色仲裁：第一个通过完整核验的候选胜出（名次 ≥1 须几何分 ≥
	//  头名 × candScoreFrac 才给翻盘）；全部不过则取头名摊 ok=false
	let chosen = null;
	let det = null;
	for (let i = 0; i < cand.length; i++) {
		const ev = evaluate(cand[i].cx, cand[i].cy);
		if (ev.ok && (i === 0 || cand[i].score >= P.candScoreFrac * cand[0].score)) {
			chosen = cand[i];
			det = ev;
			break;
		}
	}
	if (!chosen) {
		chosen = cand[0];
		det = evaluate(cand[0].cx, cand[0].cy);
		det.ok = false;
	}
	// 5. 返回映射：圆心仅"核验通过且显著偏离规范位（±1px）"才给定位值
	//  （fromLocate=true，确认页据此覆盖 dotOff 并标注「自动定位」），否则
	//  维持规范位——先验已把几何排名偏向规范位，仍留此闸防边缘误挪
	const nearCanon =
		Math.abs(chosen.cx - ccx) <= 1 && Math.abs(chosen.cy - ccy) <= 1;
	const fromLocate = det.ok && !nearCanon;
	const round2 = (v) => Math.round(v * 100) / 100;
	return {
		fx: (fromLocate ? chosen.cx : ccx) / N,
		fy: (fromLocate ? chosen.cy : ccy) / N,
		fr: SCAN_REC.dotR,
		energy: round2(chosen.score),
		ok: det.ok,
		fromLocate,
		locEnergy: round2(cand[0].score),
		canonEnergy: round2(pairScore(ccx, ccy).score),
		rEdge: det.ok ? det.rOut : 0,
	};
}

/** 单格元素圆点采样：环上 16 点 3×3 均值，返回饱和度达标的 hue 列表（提取工具校准用）。
 *  ox / oy：环心相对规范位（SCAN_REC.dotCX/dotCY）的格宽比例偏移（校准确认页
 *  逐锚点手动拖环修正用），缺省 0 即规范位；fr：采样环半径（格宽比例），
 *  缺省 SCAN_REC.dotR（scanLocateDot 也只回这个基准——实测外缘不进采样） */
function scanDotHues(data, ox = 0, oy = 0, fr = 0) {
	const N = SCAN_CELL_SIZE;
	const hues = [];
	const bcx = SCAN_REC.dotCX + (ox || 0);
	const bcy = SCAN_REC.dotCY + (oy || 0);
	const bR = fr || SCAN_REC.dotR;
	for (let k = 0; k < 16; k++) {
		const ang = (2 * Math.PI * k) / 16;
		const cx = Math.round((bcx + bR * Math.cos(ang)) * N);
		const cy = Math.round((bcy + bR * Math.sin(ang)) * N);
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
		if (s <= SCAN_REC.dotMinS) continue;
		hues.push(Math.round(h));
	}
	return hues;
}

/** 单格元素徽标圆盘原始 hue 采样（校准分桶用，2026-08-07 Step 4）：以徽标位
 *  为圆心、dotR（或 fr 覆盖）为半径的圆盘逐像素采 HSV，返回「有效票」hue
 *  列表（四舍五入取整 0-179），样本量约 100/格（16 点环的 ~7 倍）。过滤口径
 *  与 scanDotSamplers.sampleDisk 完全一致：S>dotMinS；与格底色 HSV 点级距离
 *  （环形 hue 差+|ΔS|+|ΔV|）<dotDiskBgDist 的像素剔除（杀品质底色/图标同色
 *  污染票）——sampleDisk 过滤改动时须同步本函数。calib-dots 与工具页
 *  「元素校准」tab 的分桶统一走本函数（两端同一实现，经各自 worker 调用）。
 *  ox / oy：圆盘中心相对规范位偏移（同 scanDotHues）；fr：半径覆盖（格宽
 *  比例），缺省 SCAN_REC.dotR */
function scanDiskHues(data, ox = 0, oy = 0, fr = 0) {
	const N = SCAN_CELL_SIZE;
	const [bgR, bgG, bgB] = scanCellBg(data);
	const [bgH, bgS, bgV] = scanRgb2Hsv(bgR, bgG, bgB);
	const cx = (SCAN_REC.dotCX + (ox || 0)) * N;
	const cy = (SCAN_REC.dotCY + (oy || 0)) * N;
	const R = (fr || SCAN_REC.dotR) * N;
	const R2 = R * R;
	const hues = [];
	for (
		let y = Math.max(0, Math.floor(cy - R));
		y <= Math.min(N - 1, Math.ceil(cy + R));
		y++
	) {
		for (
			let x = Math.max(0, Math.floor(cx - R));
			x <= Math.min(N - 1, Math.ceil(cx + R));
			x++
		) {
			const ddx = x - cx;
			const ddy = y - cy;
			if (ddx * ddx + ddy * ddy > R2) continue;
			const i = (y * N + x) * 4;
			const [h, s, v] = scanRgb2Hsv(data[i], data[i + 1], data[i + 2]);
			if (s <= SCAN_REC.dotMinS) continue;
			const dhh = Math.min(Math.abs(h - bgH), 180 - Math.abs(h - bgH));
			if (dhh + Math.abs(s - bgS) + Math.abs(v - bgV) < SCAN_REC.dotDiskBgDist) continue;
			hues.push(Math.round(h));
		}
	}
	return hues;
}

/** 单格底色品质投票：返回品质 0~4，暗底居多（像空格）或无法判断返回 -1 */
function scanCellQualityVote(data) {
	const votes = [0, 0, 0, 0, 0];
	let dark = 0;
	SCAN_BAND_IDX.forEach((i) => {
		const [h, s, v] = scanRgb2Hsv(
			data[i * 4],
			data[i * 4 + 1],
			data[i * 4 + 2],
		);
		if (v < SCAN_REC.darkV) {
			dark++;
			return;
		}
		if (s < SCAN_REC.minS) return;
		votes[scanQualClass(h)]++;
	});
	if (dark / SCAN_BAND_IDX.length > SCAN_REC.emptyDark) return -1;
	let mq = 0;
	votes.forEach((n, q) => {
		if (n > votes[mq]) mq = q;
	});
	return votes[mq] ? mq : -1;
}

/** 单格底色估计：边缘带像素 RGB 中位数 */
function scanCellBg(data) {
	const rs = [];
	const gs = [];
	const bs = [];
	SCAN_BAND_IDX.forEach((i) => {
		rs.push(data[i * 4]);
		gs.push(data[i * 4 + 1]);
		bs.push(data[i * 4 + 2]);
	});
	rs.sort((a, b) => a - b);
	gs.sort((a, b) => a - b);
	bs.sort((a, b) => a - b);
	const m = Math.floor(rs.length / 2);
	return [rs[m], gs[m], bs[m]];
}

/** 单格 sig（新）：4×4 块，块内图标像素均值；图标像素不足记 null */
function scanCellSig(data, bg) {
	const N = SCAN_CELL_SIZE;
	const sig = [];
	const B = 4;
	const bs = N / B;
	for (let bi = 0; bi < B; bi++) {
		for (let bj = 0; bj < B; bj++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let y = bi * bs; y < (bi + 1) * bs; y++) {
				for (let x = bj * bs; x < (bj + 1) * bs; x++) {
					const k = (y * N + x) * 4;
					const dr = Math.abs(data[k] - bg[0]);
					const dg = Math.abs(data[k + 1] - bg[1]);
					const db = Math.abs(data[k + 2] - bg[2]);
					if (dr + dg + db <= SCAN_REC.iconDiff) continue;
					r += data[k];
					g += data[k + 1];
					b += data[k + 2];
					n++;
				}
			}
			sig.push(
				n >= SCAN_REC.iconMinPx
					? [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
					: null,
			);
		}
	}
	return sig;
}

/** 单格 sigLegacy：2×2 象限全像素均值 */
function scanCellSigLegacy(data) {
	const N = SCAN_CELL_SIZE;
	const sig = [];
	for (let i = 0; i < 2; i++) {
		for (let j = 0; j < 2; j++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let y = (i * N) / 2; y < ((i + 1) * N) / 2; y++) {
				for (let x = (j * N) / 2; x < ((j + 1) * N) / 2; x++) {
					const k = (y * N + x) * 4;
					r += data[k];
					g += data[k + 1];
					b += data[k + 2];
				}
			}
			const n = (N / 2) ** 2;
			sig.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
		}
	}
	return sig;
}

/** 图标指纹：形状占用格行优先，每格 2×2 块均值 RGB（sigLegacy 旧口径，无 sig 旧条目回退用） */
function scanPieceFp(cand, feat) {
	const sig = [];
	cand.shape.offs.forEach(([dr, dc]) => {
		const data = feat[cand.origin[0] + dr][cand.origin[1] + dc].data;
		sig.push(...scanCellSigLegacy(data));
	});
	return sig;
}

/** 图标指纹（sig 现行口径）：形状占用格行优先，每格 4×4 块图标像素均值（scanCellSig） */
function scanPieceSig(cand, feat) {
	const sig = [];
	cand.shape.offs.forEach(([dr, dc]) => {
		const data = feat[cand.origin[0] + dr][cand.origin[1] + dc].data;
		sig.push(...scanCellSig(data, scanCellBg(data)));
	});
	return sig;
}

/** 两条 sig 的均值绝对差（跳过任一侧为 null 的块）；无块可比返回 Infinity */
function scanFpDiff(a, b) {
	let sum = 0;
	let n = 0;
	a.forEach((p, i) => {
		if (!p || !b[i]) return;
		sum +=
			Math.abs(p[0] - b[i][0]) +
			Math.abs(p[1] - b[i][1]) +
			Math.abs(p[2] - b[i][2]);
		n += 3;
	});
	return n ? sum / n : Infinity;
}

/** 形状表解析：占用偏移(行优先) / 锚点(最高行最左占用格) / 期望徽标位(最下行最右占用格) */
var SCAN_SHAPE_LIST = (() => {
	return Object.entries(SHAPES)
		.filter(([key]) => key.includes("/"))
		.map(([key, mat]) => {
			const offs = [];
			mat.forEach((row, r) =>
				row.forEach((v, c) => {
					if (v) offs.push([r, c]);
				}),
			);
			const botRow = offs[offs.length - 1][0];
			return {
				key,
				mat,
				offs,
				anchorOff: offs[0],
				badgeOff: offs.filter(([r]) => r === botRow).pop(),
				area: offs.length,
			};
		});
})();

/**
 * 合法组合集合（校准依据见文件头注释）：运行时由 BLOCKS+SHAPES 构建，
 * `${type}|${quality}` → Set(规范形状名)。精确方向口径（shape 矩阵 JSON
 * 原方向查 SHAPES 反向映射，不旋转）；normal 四档（q1-4）共享法宝形状，
 * red 为 q5；映射不回规范名的条目忽略（阶段0 实测 0 个），邪类型两组
 * 皆空自然不产生合法项。
 */
var SCAN_LEGAL_COMBOS = (() => {
	const set = {};
	Object.entries(BLOCKS).forEach(([type, grps]) => {
		Object.entries(grps).forEach(([grp, names]) => {
			Object.values(names).forEach((d) => {
				const shName = SHAPES[JSON.stringify(d.shape)];
				if (!shName) return;
				(grp === "red" ? [5] : [1, 2, 3, 4]).forEach((q) => {
					const key = `${type}|${q}`;
					(set[key] = set[key] || new Set()).add(shName);
				});
			});
		});
	});
	return set;
})();

/** 软杀迭代上限（防振荡兜底；阶段0 实测全库最多 3 轮收敛） */
var SCAN_LEGAL_MAX_ROUNDS = 5;

/**
 * 组合合法性判定：(类型,品质,规范形状名) 是否在 SCAN_LEGAL_COMBOS 中。
 * dotType 缺失时无法判定，放行（与 scanNamePiece 的全类型兜底一致；
 * 阶段0 实测全库候选 dotType 无 null）。
 */
function scanComboLegal(type, quality, shapeKey) {
	if (!type) return true;
	const s = SCAN_LEGAL_COMBOS[`${type}|${quality}`];
	return !!(s && s.has(shapeKey));
}

/**
 * 单格图标像素掩码（64×64 0/1）：与底色（边缘带中位数）RGB 差 > SCAN_REC.iconDiff。
 * 供候选「图标跨格连贯性」评分使用。
 */
function scanCellIconMask(data) {
	const N = SCAN_CELL_SIZE;
	const bg = scanCellBg(data);
	const m = new Uint8Array(N * N);
	for (let i = 0; i < N * N; i++) {
		const dr = Math.abs(data[i * 4] - bg[0]);
		const dg = Math.abs(data[i * 4 + 1] - bg[1]);
		const db = Math.abs(data[i * 4 + 2] - bg[2]);
		if (dr + dg + db > SCAN_REC.iconDiff) m[i] = 1;
	}
	return m;
}

/**
 * 候选图标跨格连贯分：对候选内部每条共享边，沿边界逐位置检查两侧 2px 带内
 * 是否有位置对齐的图标像素（相接数 touch 0-64）。每件法宝的图标是一幅完整
 * 独立的图案，真件内部边上图标多跨界相接；拼件接缝处两侧分属两幅图标，
 * 对齐相接显著更少。候选连贯分 = 双弱边（最弱两条边）touch 均值经
 * [contLo,contHi] 的线性映射——取双弱边而非最弱边：抢格候选（真件+偷来的
 * 邻格）的接缝弱边会被真件自身的弱边掩盖，单看 min 无法区分（校准依据见
 * 文件头 contLo/contHi 注释）。masks 为格图标掩码缓存（Map "r,c" ->
 * Uint8Array），由调用方按需填充。
 */
function scanCandCont(cells, feat, masks) {
	if (cells.length < 2) return 1;
	const N = SCAN_CELL_SIZE;
	const set = new Set(cells.map(([r, c]) => `${r},${c}`));
	const maskOf = (r, c) => {
		const key = `${r},${c}`;
		let m = masks.get(key);
		if (!m) {
			m = scanCellIconMask(feat[r][c].data);
			masks.set(key, m);
		}
		return m;
	};
	const touches = [];
	cells.forEach(([r, c]) => {
		[
			[1, 0, "v"],
			[0, 1, "h"],
		].forEach(([dr, dc, dir]) => {
			if (!set.has(`${r + dr},${c + dc}`)) return;
			const mA = maskOf(r, c);
			const mB = maskOf(r + dr, c + dc);
			let touch = 0;
			for (let p = 0; p < N; p++) {
				let aIcon = false;
				let bIcon = false;
				for (let d = 0; d < 2; d++) {
					if (dir === "v") {
						if (mA[(N - 1 - d) * N + p]) aIcon = true;
						if (mB[d * N + p]) bIcon = true;
					} else {
						if (mA[p * N + (N - 1 - d)]) aIcon = true;
						if (mB[p * N + d]) bIcon = true;
					}
				}
				if (aIcon && bIcon) touch++;
			}
			touches.push(touch);
		});
	});
	// 双弱边均值（2026-08-10）：抢格候选=真件+偷来的邻格，其边集=真件的边+接缝弱边，
	// 单看最弱边时接缝被真件自身的弱边掩盖（邪6：真件边 19/60，抢格候选 19/20/60，
	// min 同为 19 无法区分）；取最弱两边均值后真件 39.5 > 抢格 19.5 可分。拆分候选
	// （真件的子集）边更少但全是真件内边，双弱边均值反而缩小了整件与拆分的连贯分
	// 差距（整件的次弱边通常很强），方向上同样安全
	touches.sort((a, b) => a - b);
	const minTouch = touches.length > 1 ? (touches[0] + touches[1]) / 2 : touches[0];
	const lo = SCAN_REC.contLo;
	const hi = SCAN_REC.contHi;
	return Math.max(0, Math.min(1, (minTouch - lo) / (hi - lo)));
}

/**
 * 候选生成：每个锚点(左上元素圆点)枚举全部形状，锚点对齐形状的最高行最左占用格。
 * 硬条件：在棋盘内、不覆盖空格、不覆盖其他锚点、覆盖格品质一致
 * （高置信异类格否决，低置信异类格容忍并按比例扣一致性得分）。
 * 得分 = 底色置信 0.4 + 品质一致性 0.25 + 数字徽标 0.15 + 图标跨格连贯 0.2
 * （数字徽标看期望位——形状最下行最右占用格；连贯分单格候选恒为 1，
 * 多格候选取双弱边均值——品质均一棋盘上拼件方案的接缝边得分低，
 * 打破「覆盖格数打平」时偏向真实拆分的依据），
 * 再减多余徽标惩罚 0.3/个（候选覆盖格内徽标数超过 1 个——拼件吞入邻件
 * 格子必连带其真徽标，超额恒不小于真实拆分方案，方向恒安全）。
 * 组合合法性两层（SCAN_LEGAL_COMBOS，校准依据见文件头注释）：候选生成时
 * 硬过滤非法 (类型,品质,形状)；生成后「零合法候选的 dot 锚点」软杀——标记
 * 为可被其他候选覆盖并重生成，迭代至不动点（上限 SCAN_LEGAL_MAX_ROUNDS）。
 * 返回 { anchors, candMap, legalDebug }：legalDebug = { filtered, rounds,
 * coverable } 为合法性过滤/软杀调试字段（对齐 pixelVeto 观测风格）。
 */
function scanGenCandidates(feat, rows, cols) {
	const anchors = [];
	for (let r = 0; r < rows; r++)
		for (let c = 0; c < cols; c++) if (feat[r][c].dot) anchors.push([r, c]);
	const iconMasks = new Map(); // 图标掩码惰性缓存（连贯分用，跨候选共享；重生成时 feat 未变可复用）
	// 单次候选生成：coverable 为「可被其他候选覆盖」的 dot 格集合（软杀迭代用，
	// 首轮为空集即原始口径）；filtered 统计被组合合法性硬过滤的候选数
	const genOnce = (coverable) => {
		const candMap = new Map();
		let filtered = 0;
		anchors.forEach(([ar, ac]) => {
			const list = [];
			SCAN_SHAPE_LIST.forEach((sh) => {
				const orow = ar - sh.anchorOff[0];
				const ocol = ac - sh.anchorOff[1];
				const cov = sh.offs.map(([dr, dc]) => [orow + dr, ocol + dc]);
				if (cov.some(([r, c]) => r < 0 || r >= rows || c < 0 || c >= cols))
					return;
				if (cov.some(([r, c]) => feat[r][c].qual < 0)) return;
				if (
					cov.some(
						([r, c]) =>
							feat[r][c].dot && (r !== ar || c !== ac) && !coverable.has(`${r},${c}`),
					)
				)
					return;
				const tally = [0, 0, 0, 0, 0];
				cov.forEach(([r, c]) => tally[feat[r][c].qual]++);
				let mq = 0;
				tally.forEach((n, q) => {
					if (n > tally[mq]) mq = q;
				});
				if (
					cov.some(
						([r, c]) =>
							feat[r][c].qual !== mq && feat[r][c].qconf >= SCAN_REC.qualVeto,
					)
				)
					return;
				// 组合合法性硬过滤（阶段0 验证零误杀，依据见文件头注释）：非法
				// (类型,品质,形状) 候选直接不生成；品质取多数档 mq（与命名同源）
				if (!scanComboLegal(feat[ar][ac].dotType, mq + 1, sh.key)) {
					filtered++;
					return;
				}
				const consist = tally[mq] / cov.length;
				const qscore =
					cov.reduce((s, [r, c]) => s + feat[r][c].qconf, 0) / cov.length;
				const bCnt = cov.filter(([r, c]) => feat[r][c].badge).length;
				const eb = [orow + sh.badgeOff[0], ocol + sh.badgeOff[1]];
				// 徽标得分只看「期望位（形状最下行最右占用格）有无数字徽标」：
				// 原先还要求全件恰一个徽标，但图标的棕色圆块+高光会误触徽标检测
				// （棕色剑柄/宝石与徽标同为棕底白点，误触格 brown 计数与真徽标同量级），
				// 多出一个误触就把正确候选的 badgeOk 打成 false，导致棋型竞争输给拆分方案
				const badgeOk = feat[eb[0]][eb[1]].badge;
				const bScore = badgeOk ? 1 : bCnt === 1 ? 0.4 : 0;
				// 多余徽标惩罚：每件法宝恰 1 个数字徽标。拼件候选吞入邻件格子后
				// 必含邻件的真徽标（徽标召回 517/522），其超额恒不小于真实拆分方案
				// （excess(并集) ≥ excess(子集1)+excess(子集2)，金底误触格对两方案
				// 等价），故该惩罚方向上恒有利于真实拆分，永不误伤
				const bExcess = Math.max(0, bCnt - 1);
				const cont = scanCandCont(cov, feat, iconMasks);
				let mask = 0n;
				cov.forEach(([r, c]) => {
					mask |= 1n << BigInt(r * cols + c);
				});
				list.push({
					shape: sh,
					anchor: [ar, ac],
					origin: [orow, ocol],
					cells: cov,
					quality: mq,
					consist,
					badgeOk,
					cont,
					score:
						qscore * 0.4 +
						consist * 0.25 +
						bScore * 0.15 +
						cont * 0.2 -
						bExcess * 0.3,
					mask,
				});
			});
			list.sort((a, b) => b.score - a.score);
			candMap.set(`${ar},${ac}`, list);
		});
		return { candMap, filtered };
	};
	// 软杀迭代纠正：过滤后零合法候选的 dot 锚点标记为「可被其他候选覆盖」后
	// 重生成，迭代至不动点（dot 不删，锚点仍在 anchors 中参与 packing、可被
	// 第二阶段跳过）；每轮重算全量空锚点集合故与遍历顺序无关，上限兜底防振荡
	let coverable = new Set();
	let gen = genOnce(coverable);
	let rounds = 0;
	for (let it = 0; it < SCAN_LEGAL_MAX_ROUNDS; it++) {
		const empty = new Set();
		gen.candMap.forEach((list, key) => {
			if (!list.length) empty.add(key);
		});
		if (
			empty.size === coverable.size &&
			[...empty].every((k) => coverable.has(k))
		)
			break;
		coverable = empty;
		rounds++;
		gen = genOnce(coverable);
	}
	const legalDebug = { filtered: gen.filtered, rounds, coverable: [...coverable] };
	if (gen.filtered || coverable.size)
		console.debug(
			"合法性校验",
			`过滤候选 ${gen.filtered}，软杀锚点 ${JSON.stringify(legalDebug.coverable)}（生成 ${rounds + 1} 轮）`,
		);
	return { anchors, candMap: gen.candMap, legalDebug };
}

/**
 * 全局 packing：回溯 + MRV(候选少的锚点先决策) + BigInt 位掩码，
 * 每个锚点至多选一个候选且互不重叠，优先覆盖全部非空格，同覆盖数取总分最高；
 * 记录次高分解判断布局歧义，无完整解时返回覆盖率最高的部分结果。
 * 两阶段：第一阶段不允许跳过锚点，搜索每锚点都选候选的完整解
 * （候选硬条件禁止覆盖其他锚点，存在完整解时跳过不可能提高覆盖率，
 * 故完整解即全局最优，且免去 2^锚点数 的 skip 搜索树）；
 * 仅第一阶段无完整解时才运行允许跳过的第二阶段，保留节点预算截断保护。
 */
function scanPack(anchors, candMap, feat, rows, cols) {
	let total = 0;
	for (let r = 0; r < rows; r++)
		for (let c = 0; c < cols; c++) if (feat[r][c].qual >= 0) total++;
	const order = anchors
		.slice()
		.sort(
			(a, b) =>
				candMap.get(`${a[0]},${a[1]}`).length -
				candMap.get(`${b[0]},${b[1]}`).length,
		);
	// 后缀上界（剪枝用）：suf 为可覆盖格数上界，sufScore 为得分上界
	const suf = new Array(order.length + 1).fill(0);
	const sufScore = new Array(order.length + 1).fill(0);
	for (let i = order.length - 1; i >= 0; i--) {
		const list = candMap.get(`${order[i][0]},${order[i][1]}`);
		suf[i] =
			suf[i + 1] +
			(list.length ? Math.max(...list.map((cand) => cand.cells.length)) : 0);
		sufScore[i] =
			sufScore[i + 1] +
			(list.length ? Math.max(...list.map((cand) => cand.score)) : 0);
	}
	const assign = new Array(order.length).fill(null);
	const best = {
		cov: -1,
		score: 0,
		assign: null,
		second: 0,
		ambiguous: false,
	};
	let nodes = 0;
	let truncated = false;
	// 节点预算：锚点多的满棋盘（15+ 锚点 × 每锚点数十候选）第一阶段组合数
	// 远超 30 万（8 张测试图被截断，金系满盘棋型竞争最烈），截断会退回次优
	// 拆分把真件拆小（误检+漏检双增）；提到 200 万后 33 张测试图无一截断
	const NODE_BUDGET = 2000000;
	const dfs = (i, used, covCnt, score, allowSkip) => {
		if (nodes > NODE_BUDGET) {
			// 节点超预算：标记截断，结果不可靠，需人工核对
			truncated = true;
			return;
		}
		nodes++;
		if (covCnt + suf[i] < best.cov) return;
		// 同覆盖时只按总分决胜：覆盖上界持平而得分上界不超当前最优的分支不可能翻盘
		// （33 张测试图中 15+ 锚点的满盘棋型竞争，此剪枝使节点数从 >200 万降到 <30 万）
		if (covCnt + suf[i] === best.cov && score + sufScore[i] <= best.score) {
			return;
		}
		if (i === order.length) {
			if (covCnt > best.cov) {
				best.cov = covCnt;
				best.score = score;
				best.assign = assign.slice();
				best.second = 0;
				best.ambiguous = false;
			} else if (covCnt === best.cov) {
				if (score > best.score) {
					best.second = best.score;
					best.score = score;
					best.assign = assign.slice();
					best.ambiguous = false;
				} else {
					if (score > best.second) best.second = score;
					if (score >= best.score * 0.98) best.ambiguous = true;
				}
			}
			return;
		}
		const list = candMap.get(`${order[i][0]},${order[i][1]}`);
		list.forEach((cand) => {
			if (used & cand.mask) return;
			assign[i] = cand;
			dfs(
				i + 1,
				used | cand.mask,
				covCnt + cand.cells.length,
				score + cand.score,
				allowSkip,
			);
			assign[i] = null;
		});
		// 跳过该锚点：仅第二阶段允许，无完整解时保留覆盖率最高的部分结果
		if (allowSkip) dfs(i + 1, used, covCnt, score, allowSkip);
	};
	// 第一阶段：不允许跳过，找完整解；找到即全局最优，直接采用
	dfs(0, 0n, 0, 0, false);
	// 第二阶段：第一阶段无完整解（best.assign 仍为空）时才允许跳过锚点；
	// 重置节点预算使回退搜索与旧行为一致，truncated 标记跨阶段累计
	if (!best.assign) {
		nodes = 0;
		dfs(0, 0n, 0, 0, true);
	}
	return {
		order,
		assign: best.assign || assign.map(() => null),
		cov: Math.max(0, best.cov),
		total,
		ambiguous: best.ambiguous,
		truncated,
	};
}

/**
 * 命名：锚点元素圆点颜色定类型，按 类型+形状+普通/红+品质 查 BLOCKS。
 * 唯一候选直接命名；多候选有指纹参考则可靠匹配，无法可靠匹配留空名低置信交人工选择。
 * fpRefs 默认取全局 SCAN_FP_REFS；提取工具回放时传当前输出配置（含未保存条目）。
 * 返回值附带 rank：歧义组指纹匹配的完整排名 [{name, diff, maxDiff}]（低 diff 在前），
 * 无歧义或无指纹参考时为 null，供提取工具回放报告使用。
 */
function scanNamePiece(cand, feat, fpRefs) {
	const type = feat[cand.anchor[0]][cand.anchor[1]].dotType;
	const red = cand.quality === 4;
	const json = JSON.stringify(cand.shape.mat);
	const names = [];
	(type ? [type] : Object.keys(BLOCKS)).forEach((t) => {
		const grp = (BLOCKS[t] || {})[red ? "red" : "normal"] || {};
		Object.entries(grp).forEach(([name, d]) => {
			if (JSON.stringify(d.shape) === json) names.push(name);
		});
	});
	let name = "";
	let nameFactor = 0.35;
	let rank = null;
	if (names.length === 1) {
		name = names[0];
		nameFactor = 1;
	} else if (names.length > 1) {
		const refs = (fpRefs || SCAN_FP_REFS)[
			`${type}|${cand.shape.key}|${red ? "red" : "normal"}`
		];
		if (refs) {
			// sig 匹配（2026-08-05 迁移，全库重提后条目均带 sig 中位数模板）：
			// 条目带 sig 走 4×4 图标签名（scanPieceSig），仅含 sigLegacy 的旧条目
			// 回退旧口径；maxDiff 取条目的组级建议值（同组同一值），缺失回退 25
			let sigNew = null;
			let sigOld = null;
			rank = refs
				.map((rf) => {
					const useSig = !!rf.sig;
					const s = useSig
						? (sigNew = sigNew || scanPieceSig(cand, feat))
						: (sigOld = sigOld || scanPieceFp(cand, feat));
					return {
						name: rf.name,
						maxDiff: rf.maxDiff != null ? rf.maxDiff : 25,
						diff: scanFpDiff(s, useSig ? rf.sig : rf.sigLegacy || rf.sig),
					};
				})
				.sort((a, b) => a.diff - b.diff);
			const hit = rank[0];
			console.debug(
				"指纹匹配",
				`${type}|${cand.shape.key}|${red ? "red" : "normal"}`,
				hit ? `${hit.name} diff=${hit.diff.toFixed(1)}` : "无参考",
			);
			if (hit && hit.diff <= hit.maxDiff) {
				name = hit.name;
				nameFactor = 0.9;
			}
		}
	}
	return { name, names, type, red, nameFactor, rank };
}

/** 棋子缩略图：按形状包围盒拼接 64×64 格图 */
function scanPieceThumb(piece, cells) {
	const N = SCAN_CELL_SIZE;
	const cv = document.createElement("canvas");
	cv.width = piece.shapeMat[0].length * N;
	cv.height = piece.shapeMat.length * N;
	const ctx = cv.getContext("2d");
	piece.cells.forEach(([r, c]) => {
		ctx.drawImage(
			cells[r][c],
			(c - piece.origin[1]) * N,
			(r - piece.origin[0]) * N,
		);
	});
	return cv;
}

/**
 * 在 600px 宽的检测图上定位棋盘。
 * 原理：格子底色是明亮的饱和色（品质色），而格间隙、面板、图标都偏暗，
 * 以 HSV 阈值（S>45, V>160）分割出格子斑块，再对等距网格做相位拟合：
 * 横向上自由搜索格距与原点，纵向上利用格子为正方形固定格距只搜原点，
 * 并以覆盖率打破平局（防止对齐到棋盘上方一排同样等距的标签卡）。
 * 主路径失败时按 opts.fallbacks 逐组放宽参数重试（默认四组：
 * 降斑块数门槛 —— 大半空盘的灰空格不出斑块；降 HSV 阈值 —— 低清截图
 * 底色偏暗偏灰；最后保留严格 HSV + 更低斑块门槛 —— 水1 样例 42 格仅 12 格
 * 占用，空格的灰褐底色与板外面板同色，放宽 HSV 会把整个面板连成巨块
 * 锁到 2×/4× 假网格，反而严格阈值下 12 个占用格斑块足以拟合真网格）。
 * 重试只在主路径失败时触发，不影响已可定位的截图。
 * 返回检测图坐标下的 { L, T, R, B }，失败返回 null。
 */
function scanDetectBoard(cv, imgData, cols, rows, opts) {
	const sw = imgData.width;
	const sh = imgData.height;
	const attempts = [
		{ sTh: 45, vTh: 160, minFrac: 0.5 },
		...((opts && opts.fallbacks) || [
			{ sTh: 45, vTh: 160, minFrac: 0.3 },
			{ sTh: 25, vTh: 110, minFrac: 0.5 },
			{ sTh: 25, vTh: 110, minFrac: 0.3 },
			// 稀疏兜底：极空盘（水1 样例 42 格仅 12 格占用、10 个成团斑块）
			// 收紧格距搜索到真棋盘经验范围 [0.7,0.95]×ref 挡掉亚谐波假格距，
			// 成团过滤剔除孤立噪点，纵向相位用「棋盘外不再像棋盘」逐行校准
			{
				sTh: 45,
				vTh: 160,
				minFrac: 0.2,
				pitchLo: 0.7,
				pitchHi: 0.95,
				clusterFilter: true,
				phaseFix: true,
			},
			// 解码差异兜底：同一张图在浏览器（libjpeg）与 node 参考链路
			// （sips 转码）下逐像素差 ±2 级别，HSV 阈值边界的斑块会掉出
			// inRange / 腐蚀后尺寸门槛，使前面全部尝试以 1-2 个斑块之差失败
			// （木3 样例：JPEG 伪装 .PNG，node 第 4 尝以 25/110/0.3 成功、
			// 浏览器差一个斑块；35/120/0.2 两端拟出同一棋盘）。仅在前面
			// 全部失败时触发，对已成功定位的图无影响；末尾方形校验与格距
			// 合理性校验照样把关，错位假网格仍会被拒
			{ sTh: 35, vTh: 120, minFrac: 0.2 },
		]),
	];
	for (const att of attempts) {
		const rect = scanDetectBoardOnce(cv, imgData, cols, rows, att);
		if (rect) return rect;
	}
	return null;
}

function scanDetectBoardOnce(cv, imgData, cols, rows, att) {
	const sw = imgData.width;
	const sh = imgData.height;
	let src, rgb, hsv, mask, kernel, contours, hierarchy;
	try {
		src = cv.matFromImageData(imgData);
		rgb = new cv.Mat();
		hsv = new cv.Mat();
		mask = new cv.Mat();
		cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
		cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
		const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, att.sTh, att.vTh, 0]);
		const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 255, 255, 0]);
		cv.inRange(hsv, low, high, mask);
		low.delete();
		high.delete();
		// 腐蚀拉开相邻格子（间隙只有几像素）
		kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
		cv.erode(mask, mask, kernel);

		contours = new cv.MatVector();
		hierarchy = new cv.Mat();
		cv.findContours(
			mask,
			contours,
			hierarchy,
			cv.RETR_EXTERNAL,
			cv.CHAIN_APPROX_SIMPLE,
		);
		const guess = (0.8 * sw) / cols;
		const pts = [];
		let maxBlobDim = 0; // 最大合格斑块边长（稀疏兜底的格距下限约束用）
		for (let i = 0; i < contours.size(); i++) {
			const r = cv.boundingRect(contours.get(i));
			const ar = r.width / r.height;
			const sz = (r.width + r.height) / 2;
			if (ar > 0.55 && ar < 1.8 && sz > 0.4 * guess && sz < 1.6 * guess) {
				pts.push([r.x + r.width / 2, r.y + r.height / 2]);
				maxBlobDim = Math.max(maxBlobDim, r.width, r.height);
			}
		}
		// 稀疏兜底（att.clusterFilter）：极空盘的斑块中混有侧栏/面板的
		// 孤立噪点（水1 样例 15 个斑块 5 个噪点），其 inlier 会帮移位假网格
		// 赢下拟合。棋盘上占用格彼此相邻成团，噪点孤立——只保留
		// 1.6 倍格距内有邻居的斑块。过滤后为空则放弃过滤（保底）
		if (att.clusterFilter) {
			const keep = pts.filter((p) =>
				pts.some(
					(q) =>
						q !== p &&
						Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1.6 * guess,
				),
			);
			if (keep.length) {
				pts.length = 0;
				pts.push(...keep);
			}
		}
		if (pts.length < cols * rows * att.minFrac) return null;

		// 全图遮罩行/列占比：fitPitch 的 inlier 平局裁决（fill）用。
		// 棋盘是图内最大连片亮区，对齐棋盘的网格内部遮罩覆盖率最高；
		// 无此裁决时原点平移一格后 inlier 打平，会误取棋盘外的等距斑块列
		// （水+土样例左侧栏图标列曾使整板左偏一列，全部锚点错位）
		const maskRowSum = new Float64Array(sh);
		for (let y = 0; y < sh; y++) {
			let s = 0;
			for (let x = 0; x < sw; x++) if (mask.data[y * sw + x]) s++;
			maskRowSum[y] = s / sw / 255;
		}
		const maskColSum = new Float64Array(sw);
		for (let x = 0; x < sw; x++) {
			let s = 0;
			for (let y = 0; y < sh; y++) if (mask.data[y * sw + x]) s++;
			maskColSum[x] = s / sh / 255;
		}

		// 一维等距网格拟合：搜索 (原点, 格距)，最大化对齐点数；
		// inlier 打平时取网格内部遮罩覆盖率（fill）高者。
		// 格距搜索范围默认 [0.45,0.95]×dim/n，att.pitchLo/pitchHi 可收紧
		// （稀疏兜底用：斑块少且含面板/侧栏噪点时，过松的下限会放进
		// 亚谐波假格距——水1 样例 0.64×ref 的假格距曾以 13:12 赢下真格距）
		const fitPitch = (vals, n, dim, lineSum, lo, hi) => {
			const sorted = [...vals].sort((a, b) => a - b);
			let best = null;
			for (
				let pitch = (dim * (lo || 0.45)) / n;
				pitch <= (dim * (hi || 0.95)) / n;
				pitch += 0.5
			) {
				const tol = pitch * 0.28;
				for (
					let o = sorted[0] - pitch;
					o <= sorted[sorted.length - 1];
					o += pitch / 8
				) {
					let inl = 0;
					for (const p of sorted) {
						const k = Math.round((p - o) / pitch);
						if (k < 0 || k > n - 1) continue;
						if (Math.abs(p - (o + k * pitch)) < tol) inl++;
					}
					const t = Math.max(0, Math.floor(o - pitch / 2));
					const b = Math.min(
						dim,
						Math.ceil(o + (n - 1) * pitch + pitch / 2),
					);
					let fill = 0;
					for (let x = t; x < b; x++) fill += lineSum[x];
					fill = b > t ? fill / (b - t) : 0;
					if (
						!best ||
						inl > best.inl ||
						(inl === best.inl && fill > best.fill)
					) {
						best = { inl, fill, o, pitch };
					}
				}
			}
			return best;
		};
		const fitOrigin = (vals, n, pitch, lineSum, dim) => {
			const sorted = [...vals].sort((a, b) => a - b);
			const tol = pitch * 0.28;
			let best = null;
			for (
				let o = sorted[0] - pitch;
				o <= sorted[sorted.length - 1];
				o += pitch / 8
			) {
				let inl = 0;
				for (const p of sorted) {
					const k = Math.round((p - o) / pitch);
					if (k < 0 || k > n - 1) continue;
					if (Math.abs(p - (o + k * pitch)) < tol) inl++;
				}
				const t = Math.max(0, Math.floor(o - pitch / 2));
				const b = Math.min(
					dim,
					Math.ceil(o + (n - 1) * pitch + pitch / 2),
				);
				let fill = 0;
				for (let y = t; y < b; y++) fill += lineSum[y];
				fill = b > t ? fill / (b - t) : 0;
				if (
					!best ||
					inl > best.inl ||
					(inl === best.inl && fill > best.fill)
				) {
					best = { inl, fill, o };
				}
			}
			return best;
		};

		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		const dbg = (stage, info) => {
			if (globalThis.SCAN_DEBUG)
				console.log(`[detect] 拒绝@${stage}`, info || "", `pts=${pts.length}`);
		};
		// 稀疏兜底：格距不能小于最大斑块边长（腐蚀后斑块 ≈ 格宽 - 间隙 - 4px，
		// 水1 样例满格斑块 66-67px 对应真格距 73，而移位假网格格距 67.5 比
		// 斑块还小），以此收紧搜索下限
		const pLoEff =
			att.clusterFilter && maxBlobDim
				? Math.max(att.pitchLo || 0.45, (maxBlobDim + 3) / (sw / cols))
				: att.pitchLo;
		const fx = fitPitch(xs, cols, sw, maskColSum, pLoEff, att.pitchHi);
		if (!fx || fx.inl < cols * rows * att.minFrac) {
			dbg("fitX", fx && `inl=${fx.inl} pitch=${fx.pitch}`);
			return null;
		}
		// 格子为正方形：纵向格距沿用横向结果
		let fy = fitOrigin(ys, rows, fx.pitch, maskRowSum, sh);
		let ch = fx.pitch;
		if (!fy || fy.inl < cols * rows * att.minFrac) {
			fy = fitPitch(ys, rows, sh, maskRowSum, pLoEff, att.pitchHi);
			if (!fy || fy.inl < cols * rows * att.minFrac) {
				dbg("fitY", fy && `inl=${fy.inl} pitch=${fy.pitch}`);
				return null;
			}
			ch = fy.pitch;
		}
		const cw = fx.pitch;
		// 网格线精化：粗拟合的原点 / 格距受量化步长限制会累计偏差，
		// 而格间隙在遮罩上是暗带；在每条粗网格线 ±0.2 格距内吸附到
		// 遮罩占比最低的暗带中心，再由内侧线等距外推外边界
		const t0 = Math.max(0, Math.floor(fy.o - ch / 2));
		const b0 = Math.min(sh, Math.ceil(fy.o + (rows - 1) * ch + ch / 2));
		const l0 = Math.max(0, Math.floor(fx.o - cw / 2));
		const r0 = Math.min(sw, Math.ceil(fx.o + (cols - 1) * cw + cw / 2));
		const colFrac = new Float64Array(sw);
		for (let x = 0; x < sw; x++) {
			let s = 0;
			for (let y = t0; y < b0; y++) if (mask.data[y * sw + x]) s++;
			colFrac[x] = s / Math.max(1, b0 - t0);
		}
		const rowFrac = new Float64Array(sh);
		for (let y = 0; y < sh; y++) {
			let s = 0;
			for (let x = l0; x < r0; x++) if (mask.data[y * sw + x]) s++;
			rowFrac[y] = s / Math.max(1, r0 - l0);
		}
		// o 为第 0 格中心，内侧网格线 i=1..n-1 位于 o - pitch/2 + pitch*i
		const snapLines = (o, pitch, n, dim, frac) => {
			const lines = [];
			for (let i = 1; i < n; i++) {
				const xp = o - pitch / 2 + pitch * i;
				const w = Math.max(2, Math.round(pitch * 0.2));
				const lo = Math.max(0, Math.round(xp) - w);
				const hi = Math.min(dim - 1, Math.round(xp) + w);
				let min = Infinity;
				for (let x = lo; x <= hi; x++) min = Math.min(min, frac[x]);
				let sum = 0;
				let cnt = 0;
				for (let x = lo; x <= hi; x++) {
					if (frac[x] <= min + 0.05) {
						sum += x;
						cnt++;
					}
				}
				lines.push(cnt ? sum / cnt : xp);
			}
			if (!lines.length) return null;
			// 端点线离群校正：步长由首尾两条吸附线决定，单条端点线误吸到
			// 图标暗带会整轴拉伸（土7 首线偏 6.7px → 横向拉伸 2.6%，间距序列
			// 79.7/73/73.5/73/72.5 首项离群；土10 尾线偏 6.8px → 纵向 2.9%）。
			// 以相邻间距中位数为基准校验两条端点线，离群则用次端线 ∓ 中位
			// 间距回推；未离群时保持原吸附值，正常网格数值不受影响。
			// 判据要求端点间距的偏差显著强于其余所有间距（>2 倍）：单一端点线
			// 误吸只影响端部一个间距，而内侧线误吸会造成相邻两个补偿性大偏差
			// （金7 第 2 线误吸 → 间距 80.1/65.4 互相补偿、水1 稀疏盘多线噪声），
			// 此时偏差最大的虽是端部间距，但动端点反而把正确网格拉偏
			if (lines.length > 2) {
				const sp = [];
				for (let i = 0; i + 1 < lines.length; i++)
					sp.push(lines[i + 1] - lines[i]);
				const sps = [...sp].sort((a, b) => a - b);
				const med =
					sps.length % 2
						? sps[(sps.length - 1) / 2]
						: (sps[sps.length / 2 - 1] + sps[sps.length / 2]) / 2;
				const devs = sp.map((s) => Math.abs(s - med));
				const tol = Math.max(2, pitch * 0.05);
				const maxOther = (skip) =>
					Math.max(...devs.filter((_, i) => i !== skip));
				if (devs[0] > tol && devs[0] > 2 * maxOther(0))
					lines[0] = lines[1] - med;
				const li = sp.length - 1;
				if (devs[li] > tol && devs[li] > 2 * maxOther(li))
					lines[lines.length - 1] = lines[lines.length - 2] + med;
			}
			const step =
				lines.length > 1
					? (lines[lines.length - 1] - lines[0]) / (lines.length - 1)
					: pitch;
			return {
				start: lines[0] - step,
				end: lines[lines.length - 1] + step,
			};
		};
		const rx = snapLines(fx.o, cw, cols, sw, colFrac);
		const ry = snapLines(fy.o, ch, rows, sh, rowFrac);
		if (globalThis.SCAN_DEBUG)
			console.log(
				`[detect] 粗拟合 fx.o=${fx.o.toFixed(1)} cw=${cw.toFixed(1)} fy.o=${fy.o.toFixed(1)} ch=${ch.toFixed(1)}`,
				rx ? `stepX=${((rx.end - rx.start) / cols).toFixed(1)}` : "rx=null",
				ry ? `stepY=${((ry.end - ry.start) / rows).toFixed(1)}` : "ry=null",
			);
		// 格子应为正方形：两方向吸附步长不一致说明至少一侧吸附失败（吸附窗口
		// 内混入图标/面板暗带）。历史样例两个方向都错过：水+土横向粗格距受图标
		// 斑块干扰偏小 6%，窗口偏出真暗带吸到图标边缘，整板横向错位一列余；
		// 火+金纵向吸到板下方暗带（stepY 比 stepX 大 4.0%），整板纵向拉伸、
		// 底行偏移 ~30px 全部锚点采空。故不预设哪轴可信，做双向交叉验证：
		// 分别以 stepY 重拟横向原点+重吸附、以 stepX 重拟纵向原点+重吸附，
		// 与原始网格一起按 inlier/edge/res/fill 裁决（口径见 scoreGrid 注释），
		// 原始网格平局优先（防量化噪声把正常网格带偏）。
		// 阈值 2% 校准（63 张样例）：对齐正常的网格两轴步长差 ≤1.9%，吸附失败
		// 的 ≥2.6%（火+水 2.6% / 土+体 3.2% / 火+金 4.0% / 土4 5.1% / 水+土 6.9%）。
		// 土7/土10 曾各因一条端点吸附线误吸图标暗带整轴拉伸 ~2-3%（2.007%/2.41%
		// 压线触发），现由 snapLines 端点线离群校正在吸附阶段直接修正，
		// 两轴步长差回落到 0.3% 档，不再走到这里的候选裁决
		let rxUse = rx;
		let ryUse = ry;
		if (rx && ry) {
			// 候选网格评分：斑块中心与格中心的二维对齐数（inlier）为主，inl
			// 差 ≥2 票多者胜。inl 完全等票时取外边界暗带占比（edge）低者——
			// 网格线应落在棋盘框的暗缝上，纵向相位错一格时 inlier 不变（整格
			// 平移对称）但上/下边界会切进棋盘外亮区（火+水样例网格整体上移
			// 一行，上边界切进板上方「共鸣神通」卡片亮带；此时 fill 反而偏好
			// 错误相位，edge 可分）；再打平取 inlier 平均对齐残差（相对格距
			// 归一）小者；最后取网格内遮罩覆盖率（fill）高者（与 fitPitch
			// 裁决口径一致）。inl 差 1 票为噪声级（边缘斑块落在容差边界上的
			// 翻转，不反映网格优劣），不用 edge/fill（±2px 边界带占比与覆盖
			// 率的同级差也是噪声），只认残差显著差（>0.005）：错位网格边缘
			// 累积偏差常仍落在容差内，票数噪声打平但残差显著更大（土+体样例
			// 横向拉伸 3.2% 时票数 34:33 噪声打平，残差 0.248:0.237 可分辨）。
			// skipFill：调用方不用 fill（相位校正）时跳过全网格覆盖率统计——
			// 它是本评分唯一的大像素循环，逐图 5 个相位变体会显著拖慢定位
			const scoreGrid = (gx, gy, skipFill) => {
				const sx = (gx.end - gx.start) / cols;
				const sy = (gy.end - gy.start) / rows;
				let inl = 0;
				let err = 0;
				for (const p of pts) {
					const kx = Math.round((p[0] - gx.start) / sx - 0.5);
					const ky = Math.round((p[1] - gy.start) / sy - 0.5);
					if (kx < 0 || kx >= cols || ky < 0 || ky >= rows) continue;
					const ex = Math.abs(p[0] - (gx.start + (kx + 0.5) * sx));
					const ey = Math.abs(p[1] - (gy.start + (ky + 0.5) * sy));
					if (ex < 0.28 * sx && ey < 0.28 * sy) {
						inl++;
						err += ex / sx + ey / sy;
					}
				}
				const xa = Math.max(0, Math.round(gx.start));
				const xb = Math.min(sw, Math.round(gx.end));
				const ya = Math.max(0, Math.round(gy.start));
				const yb = Math.min(sh, Math.round(gy.end));
				let hit = 0;
				let n = 0;
				if (!skipFill) {
					for (let y = ya; y < yb; y++) {
						for (let x = xa; x < xb; x++) {
							n++;
							if (mask.data[y * sw + x]) hit++;
						}
					}
				}
				// 四条外边界 ±2px 带的遮罩占比
				let eHit = 0;
				let eN = 0;
				const band = (x0, x1, y0, y1) => {
					for (
						let y = Math.max(0, y0);
						y <= Math.min(sh - 1, y1);
						y++
					) {
						for (
							let x = Math.max(0, x0);
							x <= Math.min(sw - 1, x1);
							x++
						) {
							eN++;
							if (mask.data[y * sw + x]) eHit++;
						}
					}
				};
				band(xa, xb, Math.round(gy.start) - 2, Math.round(gy.start) + 2);
				band(xa, xb, Math.round(gy.end) - 2, Math.round(gy.end) + 2);
				band(Math.round(gx.start) - 2, Math.round(gx.start) + 2, ya, yb);
				band(Math.round(gx.end) - 2, Math.round(gx.end) + 2, ya, yb);
				return {
					inl,
					res: inl ? err / inl : Infinity,
					edge: eN ? eHit / eN : 0,
					fill: n ? hit / n : 0,
				};
			};
			const stepX = (rx.end - rx.start) / cols;
			const stepY = (ry.end - ry.start) / rows;
			if (Math.abs(stepX - stepY) / Math.max(stepX, stepY) > 0.02) {
				const cands = [{ gx: rx, gy: ry, s: scoreGrid(rx, ry) }];
				// 以纵向步长为准重拟横向原点（fill 裁决防侧栏等距斑块列带偏）并重吸附
				const fx2 = fitOrigin(xs, cols, stepY, maskColSum, sw);
				if (fx2 && fx2.inl >= cols * rows * att.minFrac) {
					const rx2 = snapLines(fx2.o, stepY, cols, sw, colFrac);
					if (rx2) cands.push({ gx: rx2, gy: ry, s: scoreGrid(rx2, ry) });
				}
				// 以横向步长为准重拟纵向原点并重吸附
				const fy2 = fitOrigin(ys, rows, stepX, maskRowSum, sh);
				if (fy2 && fy2.inl >= cols * rows * att.minFrac) {
					const ry2 = snapLines(fy2.o, stepX, rows, sh, rowFrac);
					if (ry2) cands.push({ gx: rx, gy: ry2, s: scoreGrid(rx, ry2) });
				}
				// 纵向相位变体：稀疏占用时纵向拟合可整行平移而 inlier 不变
				// （火+水样例上移一行，边界切进板上方卡片亮带），把各候选的
				// 纵向网格 ±1 行一并送入裁决（edge 指标负责区分相位）
				const base = cands.slice();
				for (const cd of base) {
					const sy = (cd.gy.end - cd.gy.start) / rows;
					for (const d of [-1, 1]) {
						const gyS = { start: cd.gy.start + d * sy, end: cd.gy.end + d * sy };
						cands.push({ gx: cd.gx, gy: gyS, s: scoreGrid(cd.gx, gyS) });
					}
				}
				// inl 差 ≥2 票多者胜；完全等票按 edge → res → fill 严格裁决
				// （edge 为整格相位平移设计，见上面评分注释）。差 1 票以 res 裁决
				// 且要求残差差显著（绝对差 >0.005，防 0.0003 级量化噪声翻盘——
				// 土7 样例 res 0.2112:0.2114 纯噪声）：多 1 票者除非残差显著更差
				// 否则胜（火+水样例 24:23 为真实优势，res 差 0.0006 不构成反证）；
				// 少 1 票者须残差显著更优才翻盘（土+体样例正确网格 33 票/res 0.237
				// 对错位网格 34 票/res 0.248，残差差 0.011 可分辨）。edge/fill 不参与
				// 1 票差裁决——±2px 边界带 0.02 级占比差本身是噪声（土4 样例正确
				// 网格 27 票被错位候选 26 票/edge 0.00 误翻）。均不满足时保持原胜者
				// （原始网格平局优先，防量化噪声带偏正常网格）
				const better = (a, b) => {
					if (a.s.inl > b.s.inl + 1) return true;
					if (a.s.inl < b.s.inl - 1) return false;
					if (a.s.inl === b.s.inl) {
						if (a.s.edge < b.s.edge) return true;
						if (
							a.s.edge === b.s.edge &&
							(a.s.res < b.s.res ||
								(a.s.res === b.s.res && a.s.fill > b.s.fill))
						)
							return true;
						return false;
					}
					if (a.s.inl === b.s.inl + 1) return a.s.res <= b.s.res + 0.005;
					return a.s.res < b.s.res - 0.005;
				};
				let best = cands[0];
				for (const cd of cands) {
					if (better(cd, best)) best = cd;
				}
				if (globalThis.SCAN_DEBUG)
					console.log(
						`[detect] 步长交叉验证 stepX=${stepX.toFixed(1)} stepY=${stepY.toFixed(1)}`,
						cands
							.map(
								(cd) =>
									`inl=${cd.s.inl} edge=${cd.s.edge.toFixed(2)} res=${cd.s.res.toFixed(3)} fill=${cd.s.fill.toFixed(3)}`,
							)
							.join(" | "),
					);
				// 外边界精化：外边界由内侧网格线等距外推，原点/步长的系统偏差会
				// 让边界偏离棋盘框暗缝（火+水样例上边界偏高 ~13px，格内徽标相对
				// 采样位下沉 5.6px，环上仅 ~4 点命中徽标，锚点整片采空）。
				// 四条外边界各自在 ±0.15 步长窗口内吸附到遮罩占比最低的暗带
				// （与 snapLines 同口径），重评分后仅在优于胜者时采用
				const snapPt = (pos, step, frac) => {
					const w = Math.max(2, Math.round(step * 0.15));
					const lo = Math.max(0, Math.round(pos) - w);
					const hi = Math.min(frac.length - 1, Math.round(pos) + w);
					let min = Infinity;
					for (let x = lo; x <= hi; x++) min = Math.min(min, frac[x]);
					let sum = 0;
					let cnt = 0;
					for (let x = lo; x <= hi; x++) {
						if (frac[x] <= min + 0.05) {
							sum += x;
							cnt++;
						}
					}
					return cnt ? sum / cnt : pos;
				};
				const sxB = (best.gx.end - best.gx.start) / cols;
				const syB = (best.gy.end - best.gy.start) / rows;
				const gxR = {
					start: snapPt(best.gx.start, sxB, colFrac),
					end: snapPt(best.gx.end, sxB, colFrac),
				};
				const gyR = {
					start: snapPt(best.gy.start, syB, rowFrac),
					end: snapPt(best.gy.end, syB, rowFrac),
				};
				const sR = scoreGrid(gxR, gyR);
				if (
					sR.inl > best.s.inl ||
					(sR.inl === best.s.inl && sR.edge < best.s.edge) ||
					(sR.inl === best.s.inl &&
						sR.edge === best.s.edge &&
						sR.res < best.s.res) ||
					(sR.inl === best.s.inl &&
						sR.edge === best.s.edge &&
						sR.res === best.s.res &&
						sR.fill > best.s.fill)
				) {
					if (globalThis.SCAN_DEBUG)
						console.log(
							`[detect] 外边界精化 inl=${sR.inl} edge=${sR.edge.toFixed(2)} res=${sR.res.toFixed(3)} fill=${sR.fill.toFixed(3)}（采用）`,
						);
					best = { gx: gxR, gy: gyR, s: sR };
				}
				rxUse = best.gx;
				ryUse = best.gy;
			}
			// 相位校正：稀疏占用时拟合只需对齐占用行/列，网格整体平移整行/整列
			// inlier 不变（土1 样例横向左偏一列：右边缘列棋子稀疏、定位参考不足，
			// 两轴步长差 1.1% 不触发上面的步长交叉验证；错位后左边界被推出图外、
			// 右边界切进棋盘内亮格区，edge 指标可分）。把当前网格 ±1 行/列的
			// 相位变体一并评分，按「inlier 多 → edge 低过 SCAN_REC.phaseEdgeMin
			// 余量」裁决，否则保持原相位。整格平移后斑块几何不变，res 恒打平
			// 无法区分相位，fill 反而偏好错误相位（同火+水教训：错位的网格内
			// 可能框进更多亮区——水1 样例相位变体曾以 fill +0.002 噪声级优势
			// 误换），故两项不参与相位裁决；满盘平移会丢边缘列 inlier，
			// 正常网格不会被误换
			{
				const phSx = (rxUse.end - rxUse.start) / cols;
				const phSy = (ryUse.end - ryUse.start) / rows;
				const phCands = [
					{ gx: rxUse, gy: ryUse, s: scoreGrid(rxUse, ryUse, true) },
				];
				for (const d of [-1, 1]) {
					const gxS = {
						start: rxUse.start + d * phSx,
						end: rxUse.end + d * phSx,
					};
					phCands.push({ gx: gxS, gy: ryUse, s: scoreGrid(gxS, ryUse, true) });
					const gyS = {
						start: ryUse.start + d * phSy,
						end: ryUse.end + d * phSy,
					};
					phCands.push({ gx: rxUse, gy: gyS, s: scoreGrid(rxUse, gyS, true) });
				}
				let phBest = phCands[0];
				for (const cd of phCands) {
					if (
						cd.s.inl > phBest.s.inl ||
						(cd.s.inl === phBest.s.inl &&
							cd.s.edge < phBest.s.edge - SCAN_REC.phaseEdgeMin)
					) {
						phBest = cd;
					}
				}
				if (globalThis.SCAN_DEBUG)
					console.log(
						`[detect] 相位校正${phBest === phCands[0] ? "（保持）" : "（平移）"}`,
						phCands
							.map(
								(cd) =>
									`inl=${cd.s.inl} edge=${cd.s.edge.toFixed(2)} res=${cd.s.res.toFixed(3)}`,
							)
							.join(" | "),
					);
				rxUse = phBest.gx;
				ryUse = phBest.gy;
			}
		}
		// 最终方形校验：步长差异仍 >10% 说明拟合锁到了非棋盘结构
		// （大半空盘的截图放宽阈值后，空底灰格与面板元素凑出假等距网格，
		// 木3 样例纵向步长曾被拟合为横向的 2.9 倍）——宁可判失败交人工，
		// 也不返回一个错位棋盘让后续识别在垃圾格子上出整版误检
		const outCw = rxUse ? (rxUse.end - rxUse.start) / cols : cw;
		const outCh = ryUse ? (ryUse.end - ryUse.start) / rows : ch;
		if (Math.abs(outCw - outCh) / Math.max(outCw, outCh) > 0.1) {
			dbg("square", `cw=${outCw.toFixed(1)} ch=${outCh.toFixed(1)}`);
			return null;
		}
		// 格距合理性：真棋盘格距 ≈ (0.75~0.95) × sw/cols（33 张样例 65-79px，
		// sw/cols=85.7）；放宽兜底可能锁到 2×/4× 格距的假网格（水1 样例 156/313px
		// 仍能通过方形校验），按 [0.5, 1.3] × sw/cols 拒绝
		const pitchRef = sw / cols;
		if (
			outCw < 0.5 * pitchRef ||
			outCw > 1.3 * pitchRef ||
			outCh < 0.5 * pitchRef ||
			outCh > 1.3 * pitchRef
		) {
			dbg("pitch", `cw=${outCw.toFixed(1)} ch=${outCh.toFixed(1)} ref=${pitchRef.toFixed(1)}`);
			return null;
		}
		// 稀疏兜底（att.phaseFix）：
		// 1) 棋盘整体须在图内（移位假网格常把棋盘推出左/上边界）
		// 2) 纵向相位校准：稀疏时拟合只能对齐占用行，网格整体平移整行后
		//    inlier 不变（水1 样例曾下移 2 行）。用放宽遮罩（含空格灰褐底）
		//    检查棋盘正上方/正下方一行是否仍是「棋盘样」底色——是则说明
		//    真边界还在外面，逐行外移直至顶到底色突变处
		let rect = {
			L: rxUse ? rxUse.start : fx.o - cw / 2,
			R: rxUse ? rxUse.end : fx.o + (cols - 1) * cw + cw / 2,
			T: ryUse ? ryUse.start : fy.o - ch / 2,
			B: ryUse ? ryUse.end : fy.o + (rows - 1) * ch + ch / 2,
		};
		if (att.phaseFix) {
			const pX = (rect.R - rect.L) / cols;
			const pY = (rect.B - rect.T) / rows;
			// 棋盘整体须在图内：稀疏拟合的相位模糊可能把网格整体平移出界
			// （水1 样例曾右移 1 列使 R 出界）。棋盘宽 < 图宽时界内相位唯一，
			// 按整格平移回界内即可；移不回（格距错误）才判失败
			let guard = 0;
			while (rect.R > sw + 0.35 * pX && guard++ < cols) {
				rect.L -= pX;
				rect.R -= pX;
			}
			guard = 0;
			while (rect.L < -0.35 * pX && guard++ < cols) {
				rect.L += pX;
				rect.R += pX;
			}
			guard = 0;
			while (rect.B > sh + 0.35 * pY && guard++ < rows) {
				rect.T -= pY;
				rect.B -= pY;
			}
			guard = 0;
			while (rect.T < -0.35 * pY && guard++ < rows) {
				rect.T += pY;
				rect.B += pY;
			}
			if (
				rect.L < -0.35 * pX ||
				rect.R > sw + 0.35 * pX ||
				rect.T < -0.35 * pY ||
				rect.B > sh + 0.35 * pY
			) {
				dbg("bounds", `L=${rect.L.toFixed(0)} R=${rect.R.toFixed(0)} T=${rect.T.toFixed(0)} B=${rect.B.toFixed(0)}`);
				return null;
			}
			const mask2 = new cv.Mat();
			const low2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 25, 110, 0]);
			const high2 = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, 255, 255, 0]);
			cv.inRange(hsv, low2, high2, mask2);
			low2.delete();
			high2.delete();
			const xl = Math.max(0, Math.round(rect.L));
			const xr = Math.min(sw, Math.round(rect.R));
			const covY = (y0, y1) => {
				const ya = Math.max(0, Math.round(y0));
				const yb = Math.min(sh, Math.round(y1));
				if (yb <= ya) return 0;
				let hit = 0;
				let n = 0;
				for (let y = ya; y < yb; y++)
					for (let x = xl; x < xr; x++) {
						n++;
						if (mask2.data[y * sw + x]) hit++;
					}
				return n ? hit / n : 0;
			};
			// 上方仍像棋盘 → 网格下移了一行，逐行上移。
			// 不做对称的下移检查：棋盘下方的按钮/面板（水1 样例底部彩色面板）
			// 在放宽遮罩里同样高覆盖，会把已对齐的网格误判为「还应下移」
			let guard2 = 0;
			while (rect.T - pY > -0.35 * pY && covY(rect.T - pY, rect.T) > 0.5 && guard2++ < rows) {
				rect.T -= pY;
				rect.B -= pY;
			}
			mask2.delete();
		}
		if (globalThis.SCAN_DEBUG)
			console.log(
				`[detect] 定位 pts=${pts.length} 格子=${cols * rows} 占用=${(pts.length / (cols * rows)).toFixed(2)} att={sTh:${att.sTh},vTh:${att.vTh},minFrac:${att.minFrac}}`,
			);
		return rect;
	} catch (e) {
		console.error("棋盘定位失败", e);
		return null;
	} finally {
		[src, rgb, hsv, mask, kernel, contours, hierarchy].forEach(
			(m) => m && m.delete && m.delete(),
		);
	}
}

/**
 * 共享重采样（浏览器与 node bench 同一实现，保证两端识别输入逐字节一致）：
 * 从源 RGBA 像素数组 src（srcW×srcH）的子区域 (sx,sy,sw,sh) 按像素中心对齐
 * 双线性缩放到 dstW×dstH。目标像素中心映射回源坐标（-0.5 对齐像素中心），
 * 采样坐标 clamp 到整图边界内，写 Uint8ClampedArray 自然舍入；alpha 恒置 255
 * （截图源均不透明）。全图缩放即 (sx,sy,sw,sh)=(0,0,srcW,srcH) 的特例。
 */
function scanResampleBilinear(src, srcW, srcH, sx, sy, sw, sh, dstW, dstH) {
	const dst = new Uint8ClampedArray(dstW * dstH * 4);
	const fx = sw / dstW;
	const fy = sh / dstH;
	for (let y = 0; y < dstH; y++) {
		const gy = Math.min(srcH - 1, Math.max(0, sy + (y + 0.5) * fy - 0.5));
		const y0 = Math.floor(gy);
		const y1 = Math.min(srcH - 1, y0 + 1);
		const wy = gy - y0;
		for (let x = 0; x < dstW; x++) {
			const gx = Math.min(srcW - 1, Math.max(0, sx + (x + 0.5) * fx - 0.5));
			const x0 = Math.floor(gx);
			const x1 = Math.min(srcW - 1, x0 + 1);
			const wx = gx - x0;
			const di = (y * dstW + x) * 4;
			const i00 = (y0 * srcW + x0) * 4;
			const i01 = (y0 * srcW + x1) * 4;
			const i10 = (y1 * srcW + x0) * 4;
			const i11 = (y1 * srcW + x1) * 4;
			for (let k = 0; k < 3; k++) {
				const v0 = src[i00 + k] * (1 - wx) + src[i01 + k] * wx;
				const v1 = src[i10 + k] * (1 - wx) + src[i11 + k] * wx;
				dst[di + k] = v0 * (1 - wy) + v1 * wy;
			}
			dst[di + 3] = 255;
		}
	}
	return dst;
}

/**
 * 浏览器端取像素：img（ImageBitmap / canvas / Image）1:1 绘制后 getImageData。
 * 图像来自 file input / createImageBitmap，canvas 不会被 file:// 污染。
 */
function scanImagePixels(img) {
	const cv = document.createElement("canvas");
	cv.width = img.width;
	cv.height = img.height;
	const ctx = cv.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	return ctx.getImageData(0, 0, cv.width, cv.height);
}

/**
 * 检测图生成（浏览器端）：原图 1:1 取像素后经 scanResampleBilinear 缩放到
 * 检测宽度（替代 canvas drawImage 平滑缩放，与 node bench 检测图同一实现）。
 * 返回 { imgData, scale }，scale 用于把检测图坐标换算回原图坐标。
 */
function scanMakeDetectImage(img, detectWidth) {
	const src = scanImagePixels(img);
	const scale = detectWidth / src.width;
	const dw = detectWidth;
	const dh = Math.round(src.height * scale);
	const data = scanResampleBilinear(
		src.data,
		src.width,
		src.height,
		0,
		0,
		src.width,
		src.height,
		dw,
		dh,
	);
	return { imgData: { data, width: dw, height: dh }, scale };
}

/**
 * 归一化切格：棋盘区域按 rows×cols 均分，每格经 scanResampleBilinear 重采样为
 * SCAN_CELL_SIZE² 的独立 canvas（与 node bench 切格同一实现，替代 drawImage
 * 平滑缩放）；返回 { cells, grid }，grid 为整盘拼接图（预览 / 调试用，
 * 由归一化格图 1:1 拼出，与格内容一致）。
 */
function scanSliceCells(img, rect, rows, cols) {
	const N = SCAN_CELL_SIZE;
	const src = scanImagePixels(img);
	const cw = (rect.R - rect.L) / cols;
	const ch = (rect.B - rect.T) / rows;
	const cells = [];
	const grid = document.createElement("canvas");
	grid.width = cols * N;
	grid.height = rows * N;
	const gctx = grid.getContext("2d");
	for (let r = 0; r < rows; r++) {
		const rowArr = [];
		for (let c = 0; c < cols; c++) {
			const data = scanResampleBilinear(
				src.data,
				src.width,
				src.height,
				rect.L + cw * c,
				rect.T + ch * r,
				cw,
				ch,
				N,
				N,
			);
			const cell = document.createElement("canvas");
			cell.width = N;
			cell.height = N;
			cell.getContext("2d").putImageData(new ImageData(data, N, N), 0, 0);
			gctx.drawImage(cell, c * N, r * N);
			rowArr.push(cell);
		}
		cells.push(rowArr);
	}
	return { cells, grid };
}
