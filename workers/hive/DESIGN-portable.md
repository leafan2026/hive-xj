# 仪表盘前端设计规范 v2（通用版）

从 hive 服务看板 2026-10 改版的实现中提炼，去掉业务专属的维度、接口和文件路径，供**其他仪表盘项目**直接复用。
hive 仓库内部改样式请读同目录的 `DESIGN.md`（它描述 hive 的现状，本文描述规范）。

配套三个文件，放在同目录 `portable/`：

| 文件 | 作用 |
| --- | --- |
| `dashboard-kit.css` | 全部样式：token、框架、筛选栏、卡片、胶囊、图例、DOM 柱线图、悬停卡、表格、热力格、手机 / 打印 |
| `dashboard-kit.js` | 图表工具：`domChart()` / `pairChart()` / `stackHtml()` / `sparkHtml()` / `cellTone()`、悬停卡 `bindDomTip()`、时间分桶 `rollupDays()` 等，**无任何第三方依赖** |
| `demo.html` | 一页把所有组件走一遍的示例，照着拷页面骨架 |

## 使用方式

**照抄代码，不要凭文字描述自己重写。** 只读描述去写，最常见的结果是：柱子直角、堆叠段没缝、线压在柱子上、涨跌颜色反了、手机上菜单点不开。

1. 页面引入 `dashboard-kit.css`，在 `</body>` 前引入 `dashboard-kit.js`
2. 页面骨架照 `demo.html`：`.app > .side + .main`，侧边栏里 `.side-body` 包住导航和底部块（手机抽屉要靠它）
3. 柱 / 线图一律 `domChart()`，并列双柱 `pairChart()`，悬停卡一律 `bindDomTip()`（`domChart` 已内置）
4. 字体：`Urbanist` 自托管拉丁子集（约 28KB，SIL OFL），**不走 Google Fonts**；没有就落到系统字体，不影响布局
5. 画完对照末尾「走样自查」逐项检查

v1（紫色轻卡片 + Chart.js）已废弃，两者不能混用：v2 没有 Chart.js、没有阴影、没有红色。

## 基调

浅灰底 `#ECEBEF` + 纯白大圆角卡片（22px），**无阴影、无描边**，靠底色差分层。
黑白灰为主，**品牌绿 `#75FB90` 只给需要被看见的东西**：达标、上升、AI 接住的份额、可避免的部分、当前周期底带。
不引入红、紫、橙等其他彩色；「坏 / 下降 / 慢」一律用黑。整体是安静的编辑感，不是传统 BI 的密集网格。

## 颜色 token（`:root`）

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 页面底色 | `--bg` | `#ECEBEF` |
| 卡片 | `--card` | `#FFFFFF` |
| 主文字 = 主色 | `--ink` | `#0B0B0C` |
| 次文字 | `--ink-2` | `#55545A` |
| 弱化文字、坐标轴 | `--muted` | `#76757B` |
| 中灰（次要系列） | `--gray` | `#AAA9AB` |
| 浅灰（未知 / 其他） | `--light` | `#DBDADD` |
| 浅底 | `--soft` / `--soft-2` | `#F1F0F3` / `#F7F6F9` |
| 分隔线、网格 | `--line` | `#E4E3E7` |
| 品牌绿 | `--green` | `#75FB90`（绿底上的字一律用黑） |
| 绿浅底（表格高亮行） | `--green-soft` | `#F4FDF6` |
| 当前周期底带 | `--band` | `rgba(117,251,144,.3)` |
| 悬停列 | `--hover` | `#E9E8EC` |

JS 侧对应：`INK`、`GREEN`、`GRAYS`（7 级灰阶，深 → 浅）、`BAR_DARK #4A494F`（双泳道图的柱色）、`HATCH`（斜纹，表示「待定 / 未质检」）。

### 图表配色规则

- **同一个维度值在所有图里永远同一个颜色。** 给业务维度建固定映射表（如 `COLOR_DEVICE = { pc: "#0B0B0C", mobile: "#AAA9AB", "未知": "#DBDADD" }`），
  没登记的分类用 `colorFor(map, key, i)` 按顺序拿灰阶。
- **只用灰阶区分系列**：堆叠段之间有 2px 白缝，靠明度就分得开。「未知 / 未标记 / 其他」一律最浅的灰，不抢注意力。
- 排名条：第一名黑、其余 `#8D8C93`、「其他」`#DBDADD`。
- 折线：黑色实线（右轴），**不画虚线、一张图不画多条线**；需要强调的单条线（如「平均时长」）可用品牌绿 3px。
- 绿只出现在：`.dl.up` 上升胶囊、`.pill.good` 达标、当前周期底带、表格高亮行、少数「好的那一段」（如 AI 接住的份额）。

## 涨跌与状态

**涨＝绿、跌＝黑、持平＝浅灰，只看方向不看好坏。**（v1 的「红涨绿跌」已废弃。）

| 类 | 含义 | 底 / 字 |
| --- | --- | --- |
| `.dl.up` | 上升 | `#75FB90` / `#0B0B0C` |
| `.dl.down` | 下降 | `#0B0B0C` / `#FFFFFF` |
| `.dl.flat` | 持平 | `#F1F0F3` / `#0B0B0C` |
| `.pill.good` / `.pill.bad` | 达成 / 未达成 | 同 up / down |

文字用 `▲ 4.2%`、`▼ 1.5pp`、`持平`；计数看相对变化（%），比率看差值（pp）——`changeText(cur, prev)` / `changeText(cur, prev, "pp")`，
`pillHtml(text)` 直接出胶囊。深色悬停卡上「下降」胶囊自动改用 `#3A3A40` 底（CSS 已处理）。

## 信息架构与布局

- **左侧固定侧边栏**（236px，≤1100px 收窄到 200px 但保留）。导航分组，**分组依据是「受不受顶部筛选影响」**：
  「分析 · 随筛选变化」和「报告 · 固定口径」。报告页隐藏筛选栏（`body.is-report`）。
- 页面按「回答什么问题」分，不按图表来源分。当前页写进 URL hash，可直接分享。
- 页头：面包屑 12px → 标题 34px/600 → 一句副标题 13px；右侧 `.page-tools` 放「随筛选变化」绿点胶囊和筛选命中数。
- 筛选栏 `.sticky-top > .filterbar`：白底圆角条，每个控件前有小标签（`.f-label`），控件浅灰底无边框，**生效中的控件白底黑边**（`.active`）。
- 指标卡 `.cards`：`repeat(auto-fit, minmax(190px, 1fr))`，靠宽度自己折行。
- 大图一张一张竖排（`.panel > .chart-card`），小卡用 `.grid`（三列）/ `.grid.two`（两列）/ `.flex-row`。
- 卡片标题 `h3` 13px/500/`--ink-2` 小字，真正的主角是卡片里的大数字；副标题 `.chart-sub` 12px；分组标题 `.group-head h2` 20px/600 带编号。
- 字号阶梯：页面标题 34、分组标题 20、指标卡数值 38、卡片大数字 64（`.hero-big`，次要 52）、双数字 34（`.bignums`）、百分比大数 56（`.big-kpi`）。
  数字统一 `font-variant-numeric: tabular-nums`，字重 400、负字距。
- **手机（≤640px）**：侧边栏折成顶部一条（logo 左、汉堡 `.menu-btn` 右，sticky），`.side-body` 变成右侧抽屉（`body.menu-open`，遮罩 `.menu-backdrop`，
  点导航 / 遮罩 / × / Esc 收回）。筛选栏默认收起成一行摘要（`.filter-toggle`），展开后两列。指标卡两列、数值 30px；大数字 44px；
  图表隐藏左右轴刻度；表格按最小宽度横向滚动。调用 `initMenu()` 一次即可。
- 打印：只留当前 `.panel.active`，侧边栏 / 筛选栏 / 工具条隐藏；「导出」按钮直接 `window.print()`。

## 组件

| 组件 | 类 / 函数 | 规则 |
| --- | --- | --- |
| 指标卡 | `.card` | 标签 12px → 数值 38px（单位 `<small>`）→ 同一行「胶囊 + 说明」→ 底部 `sparkHtml()` 一排小柱（最近一根黑、其余浅灰） |
| 大数字卡 | `.hero-head` | 左：小标题 + 64px 数字 + 一句说明；右：粒度页签 `.seg` + 图例 `.legend` |
| 粒度页签 | `.seg` + `initSeg()` | 下划线式「日 周 月 季 年」，选中加粗 + 黑下划线，纯前端换分桶 |
| 图例 | `.legend` | 柱 = 10×10 圆角方块、线 = 16×2.5 短横（`i.ln`）、当前周期 = 16×10 绿底色块（`i.band`） |
| 占比条 | `stackHtml(items)` | 一行 14px 胶囊分段 + 下方图例行（名称 · 数值 · 占比右对齐） |
| 排名条 | `.rank` + `.track` | 名称 + 数值在上，8px 轨道在下；第一名黑、其余灰 |
| 热力格 | `.heat-table` + `cellTone(ratio)` | 格子 38px 高、9px 圆角、4px 缝；0 留白，浅 → 深 7 级灰，过半改白字；首列 150px、合计列 80px，中间均分 |
| 表格 | `.report-table.even` | `table-layout: fixed`、首列 20%、表头可折行、`min-width: 760px` 在 `.table-wrapper` 里横向滚动；数值列 `.num` 右对齐；高亮行 `tr.hl` 绿浅底 |
| 按钮 | `.btn` / `.btn-ghost` | 黑底白字 40px 高 12px 圆角 / 透明底，按下态黑底 |
| 提示条 | `.banner` | 黑底白字；`.banner.info` 白底 |

## 柱线图（`domChart()`）

原则：**胶囊柱 + 一条平滑曲线，两者永不打架。**

- **柱子一律胶囊**：`border-radius: 999px`，没有直角柱。堆叠柱整根一个胶囊、内部平直分段、段间 2px 白缝（`.dc-bar.stacked`，`overflow: hidden`）。
- **柱宽按格宽比例**：一根 = 格宽 × 55%，再按粒度封顶 `BAR_MAX = { day 48, week 48, month 56, quarter 64, year 80 }`（`barW(grain)`）；
  并列双柱各 26%、封顶一半（`pairW()`）。根数少自然粗、多自然细，不要定死像素。
- **折线**：SVG `viewBox="0 0 1000 H"` + `preserveAspectRatio="none"` + `vector-effect: non-scaling-stroke`，点在每根柱的中心；
  `smoothPath()` 用单调三次插值（Fritsch–Carlson），**不会在 0 附近冲到负值**。黑色实线 2～2.5px；根数 ≤ 31 时每个点画 7px 圆点（`line.dots`）。
- **柱 + 线同图时用双泳道**（`lanes: true`）：柱子只占绘图区下面 58%，折线只在上面 32%（68%–100%），中间留 10% 空隙，
  两者在任何数据下都不交叉；左轴刻度落在下泳道、右轴刻度落在上泳道，**都从 0 起，不做假的负轴**。柱色 `BAR_DARK`、悬停变黑（`hoverInk`），总高 340。
  刻度位置由调用方按泳道给：`yTicks pos = p × LANE_BAR`、`hTicks pos = LANE_LINE_FROM + p × LANE_LINE`。
- **当前周期底带**（`band`）：按天 = 最近 7 根「近 7 天」，其他粒度 = 最后一根「本周 / 本月 / 本季 / 本年」（`currentBand()`）；
  背后铺品牌绿 30% 底、左上角写标签；**柱子本身不变色**；图例里的「当前周期」写同一个词。
- **还没过完的桶**（含今天，`isOngoing()`）画成虚线空心柱（`dashed: true`），横轴写「今天」，悬停卡注「读数还会往上走」。
- **横轴**（`axisFor(buckets, grain)`）：按天 ≤ 31 天逐天写 MM-DD（太密自动隔几根标，「今天」永远保留），更长只标每月 1 号；
  按周 ≤ 12 根逐根标 `W41`、更多隔根标；月 / 季 / 年逐根标。
- **柱顶数值**（`label`）：≤ 20 根时才标，11px/600。
- **悬停**：整列铺一块 `--hover` 圆角底（CSS 的 `.dc-col:hover::before`），**不画竖虚线**；提示卡是深色卡片 `.chart-glass-tooltip`
  （`rgba(11,11,12,.94)`、圆角 14、宽 220）：标题（`bucketTitle()`：`2026-10-05 周一` / `W41 · 10-05 – 10-11（不完整）`）→
  每个系列一行（柱 = 10×10 方块、线 = 14×3 短横 + 名称 + 右对齐数值）→ 底部合计 + 涨跌胶囊 → 可选灰色备注。
  位置锚在所在列旁边，**越过视口中线翻到左侧**。数据变了只换 `el.$tip`，不重复绑事件。

### 用法

```html
<div class="chart-card">
  <div class="hero-head">
    <div class="hero-title"><h3>会话接待分布</h3><div class="hero-big" id="heroTotal">—</div><div class="hero-caption" id="heroCaption"></div></div>
    <div class="hero-right">
      <div class="seg" id="granHero" role="tablist"></div>
      <div class="legend"><span><i style="background:#4A494F"></i>会话量</span><span><i class="band"></i><span id="heroBand">近 7 天</span></span><span><i class="ln" style="background:#0B0B0C"></i>人工接待时长（右轴）</span></div>
    </div>
  </div>
  <div id="heroChart"></div>
</div>
```

```js
// byDay = { "2026-10-05": { total: 212, dur: 7300, dev: { pc: 120, mobile: 86, "未知": 6 } }, ... }
let grain = "day";
function draw() {
  const { buckets } = rollupDays(byDay, grain);           // 日桶 → 任意粒度，数值字段直接相加
  const n = buckets.length;
  const maxS = niceMax(Math.max(...buckets.map((b) => b.total), 0) * 1.08);
  const maxH = niceMax(Math.max(...buckets.map((b) => b.dur / 3600), 0) * 1.15);
  const band = currentBand(buckets, grain);
  domChart($("heroChart"), {
    height: 340, max: maxS, lanes: true, hoverInk: true, band,
    bars: buckets.map((b) => ({ segs: [{ v: b.total, color: BAR_DARK }], ...barW(grain), dashed: isOngoing(b) })),
    line: { values: buckets.map((b) => b.dur / 3600), color: INK, width: 2.5, max: maxH, dots: n <= 31 },
    yTicks: [0, .5, 1].map((p) => ({ pos: p * LANE_BAR, label: fmtNum(Math.round(maxS * p)) })),
    hTicks: [0, .5, 1].map((p) => ({ pos: LANE_LINE_FROM + p * LANE_LINE, label: (maxH * p).toFixed(1) + "h" })),
    ...axisFor(buckets, grain),
    tip: (i) => { const b = buckets[i], p = buckets[i - 1]; return b && {
      title: bucketTitle(b, grain),
      rows: [{ name: "pc", value: fmtNum(b.dev.pc), color: "#0B0B0C" }, { name: "人工接待时长", value: (b.dur / 3600).toFixed(1) + " 小时", color: INK, line: true }],
      foot: { name: "会话量", value: fmtNum(b.total), delta: p ? changeText(b.total, p.total) : "" },
      notes: [isOngoing(b) ? "还没过完，读数还会往上走" : ""] }; },
  });
  $("heroBand").textContent = band.label;
}
initSeg($("granHero"), grain, (g) => { grain = g; draw(); });
draw();
```

```js
// 堆叠柱（几段相加等于总量）：柱顶标合计，≤20 根时
domChart($("distChart"), {
  height: 230, band: currentBand(buckets, g),
  bars: buckets.map((b) => ({ segs: [{ v: b.dev.pc, color: "#0B0B0C" }, { v: b.dev.mobile, color: "#AAA9AB" }, { v: b.dev["未知"], color: "#DBDADD" }], ...barW(g), label: fmtNum(b.total), dashed: isOngoing(b) })),
  yTicks: [0, .5, 1].map((p) => ({ pos: p * 100, label: fmtNum(Math.round(max * p)) })),
  ...axisFor(buckets, g), tip,
});

// 并列双柱（彼此不构成整体，如人数 vs 企业数）：各标各的，绝不求和
pairChart($("pairChart"), { height: 200, grain: g, band: currentBand(buckets, g), items: buckets.map((b) => ({ a: b.users, b: b.orgs })), ...axisFor(buckets, g), tip });

// 占比条 + 图例行 / 排名条 / 热力格
$("devStack").innerHTML = stackHtml([{ label: "pc", value: 12800, color: "#0B0B0C" }, { label: "mobile", value: 7600, color: "#AAA9AB" }]);
const t = cellTone(v / rowMax);   // → { bg, fg }，写进 <td style="background:…;color:…">
```

## 数据表达规则（硬约束）

这几条不是样式偏好，违反了会让人读错数。

- **相差一个数量级以上的两组数据不共用一根 Y 轴。** 柱 + 线用双泳道，线走右轴；两组都是柱就拆成两张图。
- **累计值用线、每期新增用柱**，不要放进同一组并列柱，否则新增的柱子小到看不见。
- **彼此不构成整体的指标不堆叠**（人数 vs 企业数），用 `pairChart`，各标各的，绝不求和。
- **去重计数不能跨周期相加。** 按周 / 按月的去重人数必须在后端分别算，`rollupDays` 的直接相加只对计数类字段成立；「合计」是整个区间去重后的数。
- **一张图一条线。** 要比多条线就拆成小倍数（每个分类一张小图，柱上标数）。
- **多分类优先拆小倍数**，不要 6 种灰堆在一根柱上。
- **区间首尾的不完整周期**标「不完整」，还没过完的画虚线空心柱，不参与「最近一期」对比。
- **不要为了图好看改数据口径。** 改分母或过滤条件时在图旁写明口径。

## 走样自查

| 看到的现象 | 漏了什么 |
| --- | --- |
| 出现紫色 / 红色 / 橙色 | 写死了 v1 色值；改用 token、`GRAYS`、`GREEN` |
| 卡片有阴影或描边 | 用了 v1 的 `.chart-card`；v2 只靠底色差分层 |
| 柱子有直角，或堆叠段之间没缝 | `.dc-bar` 的 `border-radius: 999px` + `.stacked` 的 `gap: 2px` |
| 堆叠柱像几个球叠着 | 每段各自圆角了；应整根 `overflow: hidden`，段平直 |
| 柱子细得像线 | 还在用固定像素；改 `...barW(grain)` |
| 折线和柱子糊在一起 | 柱 + 线没开 `lanes: true` |
| 折线在 0 附近凹到负值 | 没用 `smoothPath()`（单调插值） |
| 下降显示成绿色或红色 | `.dl.down` 应为黑底白字 |
| 当前周期的柱子变色了 | 只铺底带，柱子不变色 |
| 横轴标签挤成一团 | 没走 `axisFor()`；或 `.dc-x.per` 没让 `thinPerBarLabels` 隔根标 |
| 悬停没有卡片 | 容器没 `data-tip` 或没 `bindDomTip` / `el.$tip` |
| 悬停卡挡住正在看的柱子 | 没用 `placeTip()` 的过中线翻转 |
| 并列柱的柱顶出现一个数，等于两根柱之和 | 并列柱用了堆叠；**这是错误的数字**，改 `pairChart` |
| 表格首列占掉大半宽 | 表没加 `even` |
| 手机上菜单点不开 | 遮罩 `z-index` 高过了抽屉，或 `.side-body` 没包住导航 |
| 手机上找不到刷新 / 退出 | 它们不在 `.side-body` 里 |
| 报告页还露出筛选栏 | `body` 没加 `is-report` |
