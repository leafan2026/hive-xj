# hive 服务看板 · 前端样式规范

本文是 `public/hive.css` 和 `public/hive.js` 里已有实现的提炼，**描述现状而非愿望**。
改样式前读这里；改完若与本文冲突，要么改回来，要么连本文一起改。

> **在别的项目里复用这套风格？** 你没有 `drawCombo()` / `cleanScales()` 可调，
> **必须照抄「Chart.js 实现基线」一节的代码**。只读文字描述去重写配置，会回落到
> Chart.js 默认样式（深色大字、满格网格、直角柱、方块图例、内置标题），
> 和仓库明显不一致。写完对照末尾「走样自查」逐项检查。

## 基调

浅紫灰底 + 纯白卡片的「轻卡片」风格。靠极淡阴影和 1px 近乎透明的描边分层，
**不用重边框**；圆角偏大（16–20px）。整体偏柔和现代，不是传统 BI 的密集网格风。

字体栈 `-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei"`，
正文 14px，开 `-webkit-font-smoothing: antialiased`。

## 颜色 token

全部在 `:root`，换主题只动这里，**不要在组件里写死色值**。

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 页面底色 | `--bg` | `#f5f6fb` |
| 卡片 | `--card` | `#ffffff` |
| 主文字 | `--ink` | `#20264a` |
| 次文字 | `--ink-soft` | `#555d80` |
| 弱化文字 | `--muted` | `#9198b2` |
| 分隔线 | `--line` | `#e9ebf4` |
| 主色 | `--primary` | `#635bea` |
| 主色浅底 | `--primary-soft` | `#efefff` |

辅助色：`--blue #6e99ee`、`--violet #806dfa`、`--amber #f8b84e`、
`--green #58c59a`、`--rose #ee8d87`、`--cyan #63cfc9`。

阴影两档：`--shadow: 0 6px 18px rgba(47,54,102,.055)`、
`--shadow-hover: 0 10px 26px rgba(47,54,102,.10)`。圆角基准 `--radius: 16px`。

## 字号层级

指标卡是全站视觉重心：

- `.card-label` 12px / 500 / `--muted`
- `.card-value` **23px / 字重 720 / 字距 -0.65px**，并开 `font-variant-numeric: tabular-nums`
  （等宽数字，数值刷新时不会左右抖动，这是刻意的，别去掉）
- `.card-sub` 10.5px / `--muted`

`.chart-card h3` 15px / 700 / 字距 -0.12px，左侧有 4px 宽圆角竖条做锚点。
竖条颜色**按栅格位置轮换**：默认 `--primary`，`:nth-child(3n+2)` 用 `--cyan`，
`:nth-child(3n)` 用 `--rose`。纯装饰节奏，不承载语义，不要拿它编码数据含义。

表格 13px；`th` 12.5px / 600 / `--muted`、底色 `#f9f8ff`、sticky 吸顶。

## 栅格与卡片

`.main` 内容区 `max-width: 1400px` 居中，padding `20px 28px 10px`。

`.grid` 是 flex wrap、`gap: 18px`；`.chart-card` 为 `flex: 1 1 340px`，
窄屏自动掉成单列。三个尺寸修饰符：

| 类 | min-height | canvas 上限 |
| --- | --- | --- |
| （默认） | 320px | 300px |
| `.wide` | 320px（占满整行） | 300px |
| `.tall` | 460px | 400px |

卡片 hover 统一 `translateY(-2px)` + `--shadow-hover`，过渡 `.15s ease`。

**环图是例外**：`.multi-ring-chart` 锁 1:1、`.progress-ring-chart` 锁 2:1
（`#panel-service` 内压到 3.6:1），且必须绕开 canvas 的 300px 高度上限
（`max-height: none`），否则同心环几何会被压扁。

## 图表配色

分两层，定义在 `public/hive.js` 顶部。

**第一层：语义固定色。** 同一个值在任何图里永远同一个颜色，这是硬规则。

- 设备 `COLOR_DEVICE`：pc `#5e8ef2`、mobile `#00c8a9`、未知 `#d3d8e6`
- 渠道 `COLOR_CHANNEL`：gd_next `#ffb65c`、gd4 `#d2aa79`、gd_app `#b594ff`、
  wechat_miniapp `#00c8a9`、wechat_official `#ff6689`、trade_weixin_app `#5e8ef2`、未知 `#bcc2d1`
- 会话性质 `COLOR_NATURE`：有效 `#806dfa`、填表人 `#00c8a9`、无效 `#77ddd3`、
  转接未应答 `#ff8dac`、电话引导·发链接图片 `#5e8ef2`、内部测试 `#f3d07a`、未标记 `#d3d8e6`

「未知 / 未标记」一律用灰（`#d3d8e6`、`#bcc2d1`），**不占用彩色**——
缺数据不该在图里抢注意力。

**第二层：兜底色序。** 没进映射表的维度走 15 色 `PALETTE`，按索引取模
（`colorFor(map, key, i)`）。新增维度优先进映射表，不要依赖取模顺序，
否则数据一变颜色就跟着漂。

```js
const PALETTE = [
  "#806dfa", "#00c8a9", "#ffb65c", "#ff6689", "#00d9d4",
  "#5e8ef2", "#b594ff", "#ff8dac", "#77ddd3", "#e5c77f",
  "#9289e9", "#70bdf7", "#d3b1ef", "#ffbe9d", "#a9afc7",
];
```

**同一张图的多个系列，按 PALETTE 顺序依次取**（紫 → 青 → 橙 → 粉 …），
相邻两色色相跨度很大，保证可区分。**不要从 `:root` 辅助色里挑同色系**——
`--primary #635bea` 和 `--violet #806dfa` 放进同一张图几乎分不清。
`:root` 的辅助色是给界面装饰用的（标题竖条、标签底色），不是给数据系列用的。

**已知坑：系列超过 4 个会撞色。** `PALETTE[1] #00c8a9` 和 `PALETTE[4] #00d9d4`
都是青绿，同一张图里第 2 条和第 5 条几乎分不清。超过 4 个系列时**跳过 `[4]`**
（第 5 个取 `[5] #5e8ef2`），或者干脆拆成两张图——5 条以上的线本来就很难读。

hover 用 `darken(hex, .82)` 压暗同一支色，**不换成另一种颜色**。

## Chart.js 实现基线（跨项目复用必须照抄）

图表观感大半由下面这些配置决定，而不是 CSS。仓库里它们分散在 `hive.js` 的
`Chart.defaults`、`cleanScales()`、`drawCombo()`、`comboLegend()` 里；
别的项目没有这些函数，**照抄本节代码**，不要凭描述重写。

### 1. 全局默认（创建任何图表之前设置一次）

```js
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
Chart.defaults.font.size = 11.5;            // 坐标轴/图例比正文小，默认 12 偏大
Chart.defaults.color = "#8f8ca9";           // 坐标轴/图例文字，Chart.js 默认 #666 偏黑
Chart.defaults.borderColor = "#eeeaf6";
Chart.defaults.plugins.tooltip.backgroundColor = "#393878";
Chart.defaults.plugins.tooltip.padding = 11;
Chart.defaults.plugins.tooltip.cornerRadius = 10;
Chart.defaults.plugins.tooltip.displayColors = false;
Chart.defaults.plugins.tooltip.titleFont = { size: 11.5, weight: "500" };
Chart.defaults.plugins.tooltip.titleColor = "#b9bdd0";
Chart.defaults.plugins.tooltip.bodyFont = { size: 14, weight: "700" };
Chart.defaults.plugins.tooltip.caretSize = 6;
```

漏掉这一段是最常见的走样来源：坐标轴字会变大变黑，整张图立刻「不像」。

### 2. 坐标轴（对应仓库 `cleanScales()`）

X 轴既无网格线也无轴线；Y 轴只留 `#f2f4fa` 淡横线、无轴线。
**量级相差一个数量级以上的系列，小的那组走右侧 `y1`**（右轴同样无网格无轴线）。

```js
scales: {
  x: {
    stacked,                                   // 堆叠图 true，并列柱 false
    grid: { display: false },
    border: { display: false },                // v4 起轴线归 border 管，grid.drawBorder 已移除
    ticks: { maxRotation: 45, autoSkip: false, padding: 6 },
  },
  y: {
    stacked,
    beginAtZero: true,
    grid: { color: "#f2f4fa", drawTicks: false },
    border: { display: false },
    ticks: { padding: 10, maxTicksLimit: 6 },
  },
  y1: {                                        // 只在有第二量级系列时加
    position: "right",
    beginAtZero: true,
    grid: { display: false },                  // 右轴不画网格，否则两套横线交错
    border: { display: false },
    ticks: { padding: 8, maxTicksLimit: 6 },
  },
}
```

### 3. 数据集样式（对应仓库 `drawCombo()`）

```js
// 柱 · 堆叠（构成整体的分段，如设备 pc/mobile/未知）
{
  type: "bar", stack: "s", yAxisID: "y",
  borderSkipped: false,
  borderColor: "#fff", borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },  // 段间白缝
  borderRadius: isTopSegment ? { topLeft: 5, topRight: 5 } : 2,                // 只给最上面一段圆角
  barPercentage: .62, categoryPercentage: .82,
  order: 2,
}

// 柱 · 单系列 → 胶囊
{ type: "bar", yAxisID: "y", borderRadius: 20, borderWidth: 0, borderSkipped: false,
  barPercentage: .42, categoryPercentage: .82, order: 2 }

// 柱 · 并列（彼此不构成整体的指标，如接待人数 vs 接待企业数）→ 不设 stack
{ type: "bar", yAxisID: "y", borderRadius: { topLeft: 5, topRight: 5 }, borderWidth: 0,
  borderSkipped: false, barPercentage: .8, categoryPercentage: .74, order: 2 }

// 线
{
  type: "line", yAxisID: "y1",                 // 和柱同图时走右轴
  tension: .42,                                // 平滑曲线，不是折线
  borderWidth: 2.5,
  pointRadius: 2.5,
  pointBackgroundColor: "#fff",                // 白心点 + 彩色描边，不是实心点
  pointBorderColor: color,
  pointBorderWidth: 2,
  pointHoverRadius: 5.5,
  fill: false,
  order: 1,                                    // order 小的画在上面：线永远压在柱上
}
```

柱子一律有圆角，**不存在直角柱**。

### 4. 图表级选项

```js
options: {
  responsive: true,
  maintainAspectRatio: false,                  // 必须！高度交给 CSS，见下
  interaction: { mode: "index", intersect: false },
  layout: { padding: { top: 22 } },            // 给柱顶合计数留位置
  plugins: {
    title: { display: false },                 // 卡片 h3 就是标题，不要再开 Chart.js 标题
    legend: {
      position: "top",
      align: "start",                          // 左对齐，不是居中
      labels: {
        usePointStyle: true,
        boxWidth: 9, boxHeight: 9, padding: 14,
        font: { size: 12 },
        // 柱系列用方块 "rect"，线系列用圆点 "circle"，一眼区分图形类型
        generateLabels(chart) {
          return Chart.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
            const ds = chart.data.datasets[item.datasetIndex] || {};
            const isLine = ds.type === "line";
            // 必须显式给 fill/stroke：否则线系列会取 pointBackgroundColor "#fff"，图例变成白心空环
            const color = isLine ? ds.borderColor : ds.backgroundColor;
            return { ...item, fillStyle: color, strokeStyle: color,
                     lineWidth: isLine ? 2 : 0, pointStyle: isLine ? "circle" : "rect" };
          });
        },
      },
    },
  },
}
```

### 5. 画布定高（防止坐标轴标签溢出卡片）

`maintainAspectRatio: false` 让 Chart.js 不再按宽高比自算高度，改由 CSS 决定：

```css
.chart-card canvas { max-height: 300px; }
.chart-card.tall canvas { max-height: 400px; }
```

两者缺一不可。用默认的 `maintainAspectRatio: true`，宽屏下画布会按 2:1 撑得很高，
旋转的 X 轴标签就会冲出卡片底部、压到下一张卡上。

### 6. 柱顶合计数与悬停竖线（自定义插件，需原样复制）

这两个效果不是 Chart.js 自带的，照抄上面的配置**得不到**：

- `valueLabels`：柱顶合计数 / 柱内分段值，规则见下文「柱上数字」。
  从 `public/hive.js` 第 977 行起原样复制 `const valueLabels = { … };`
- `hoverGuide`：悬停时一条 `#b9c0f0` 竖虚线。从第 753 行起原样复制 `const hoverGuide = { … };`

复制后注册一次 `Chart.register(valueLabels, hoverGuide);`。`valueLabels` 的配置
**必须按柱型区分**，不能一刀切开 `showStackTotal`——插件会把同一 X 位置的所有柱值相加：

| 柱型 | `valueLabels` 配置 | 一刀切开合计会怎样 |
| --- | --- | --- |
| 堆叠柱（多段构成整体） | `{ showStackTotal: true }` | 正确：柱顶是各段之和 |
| 单系列柱 | `{ showStackTotal: false }` | 同一个数画两遍（柱顶 + 柱内） |
| 并列柱（指标不构成整体） | `{ showStackTotal: false, barTop: true }` | **柱顶显示两柱之和，是错数**；柱内数字还会被窄柱截断 |

公共部分：

```js
plugins: {
  valueLabels: { maxLabels: 40, maxTotalLabels: 150, lineLabels: false, /* 加上表中按柱型的两项 */ },
  hoverGuide: { enabled: true },
}
```

`lineLabels: false` 是固定的：柱线组合图里折线值会落进柱子内部，标出来会被误读成柱值。

`valueLabels` 依赖仓库里的 `fmtNum()` 和 `readableInk()`，一起复制。行号随代码变动，
以 `const valueLabels = {` 为准搜索。

### 7. 悬停与 tooltip

仓库用两个自定义插件：`hoverGuide`（悬停时一条 `#b9c0f0` 4px 间隔的竖虚线）和
外置 HTML 玻璃态 tooltip（`glassTooltip`）。新项目不移植的话，
第 1 节的 `Chart.defaults.plugins.tooltip.*` 深色配置就是正确的兜底。

## 柱上数字（valueLabels 插件）

两档限流，**不是一个阈值**：

- 柱顶合计数：≤150 根柱时绘制
- 柱内分段值：≤40 根柱时绘制（挤在柱子里，柱多了必须让位）

超出部分交给碰撞检测按优先级丢弃：合计数 `p:0` > 折线值 `p:1` > 柱内分段 `p:2`。
合计数带白色描边（halo），压在柱子上也读得清。

并列柱（`grouped: true`）模式下值画在**柱顶**而非柱内——柱子矮时画在里面看不见。

## 语义色

**环比/同比固定红增绿减，不按指标好坏翻转。** 这条踩过坑后定死，别再改成
「指标变好就绿」——同一个色块在不同卡片含义相反，读表的人会误判。

| 类 | 含义 | 底色 / 字色 |
| --- | --- | --- |
| `.dl.up` | 上升 | `#fdecee` / `#d9484d` |
| `.dl.down` | 下降 | `#e7f8ef` / `#199c58` |
| `.dl.flat` | 持平 | `#f1f2f9` / `#6a7089` |

状态标签 `.pill` 则按好坏：`.good` `#e7f8ef`/`#199c58`、
`.warn` `#fef3e2`/`#cf8016`、`.bad` `#fdecee`/`#d9484d`。

错误提示条 `.banner`：`#fdeeee` 底 / `#c8393a` 字。

## 控件

- `.btn` 主按钮：primary 实底、圆角 9px、13px/600，投影 `0 5px 12px rgba(99,91,234,.25)`，
  hover 上浮 1px；`:disabled` 时 `opacity: .55` 并取消位移和投影
- `.tab`：常态白底 + `--muted` 字 + 极淡阴影；`.active` 换 primary 实底白字
- 筛选器 `select` / `input[type=date]`：`#fafbfe` 底、1px `--line` 描边、圆角 10px；
  focus 时边框转主色、底色转纯白；`.active` 态用 `--primary-soft` 底 + 主色字 + 500 字重，
  让「这个筛选器生效中」一眼可见
- `.chart-grain`（图表卡内的粒度下拉）：同一套的小号版本，padding `4px 9px`、12.5px

## 图表的数据表达规则

这几条不是样式偏好，是会导致读错数的硬约束。

**去重计数不能跨周期相加。** 接待人数（user_id 去重）、接待企业数
（billing_account_id 去重）这类指标，每个粒度必须由服务端各自去重一次；
「总计」显示全区间去重数（`uniqAll`），不是各周期求和。

**不构成整体的指标不堆叠。** 人数与企业数用并列柱——一个企业下可能有多个用户，
堆叠会读成没有意义的「人数 + 企业数」。

**量级相差一个数量级以上的系列不能共用一根 Y 轴。** 比如「GMV 万元」（几百）和
「交易笔数」（上万）同轴，GMV 会被压成一条贴底直线。小量级的那组走右侧 `y1`。

**存量用线，增量用柱，二者不放进同一组并列柱。** 「累计超 3 笔商户数」是存量
（只增不减，上千），「申请量」「新开通数」是每周增量（几十）。放进同一组并列柱，
增量柱会被压到几乎看不见。正确做法：增量作柱走左轴 `y`，累计作线走右轴 `y1`。

**环图中占比不足 1% 的分类合并为「其他」**，否则会被圆头压成一条看不见的线。

**不要为了图好看改数据定义。** 改分母或过滤规则时，必须在变更说明里写清口径。

## 走样自查

写完图表对照这张表。左列任何一条出现，就是漏了右列的配置。

| 看到的现象 | 漏了什么 |
| --- | --- |
| 坐标轴文字偏大、偏黑 | 「全局默认」的 `Chart.defaults.font.size` / `color` |
| 卡片标题下面又有一个图表标题 | `plugins.title` 没关；卡片 h3 是唯一标题 |
| X 轴有竖网格线，或 Y 轴左侧有一根竖轴线 | `cleanScales` 那组 `grid` / `border` 配置 |
| 某条线贴着底部几乎是直线 | 量级差太大却共用 Y 轴，该走 `y1` |
| 两个系列颜色分不清 | 从辅助色里挑了同色系；应按 `PALETTE` 顺序取 |
| 折线是直的、数据点是实心圆 | 线的 `tension: .42` 和白心点配置 |
| 柱子是直角 | 柱的 `borderRadius` |
| 图例居中、全是方块 | 图例 `align: "start"` 和按类型区分 rect / circle |
| X 轴标签冲出卡片底部 | `maintainAspectRatio: false` + canvas `max-height` |
| 一组柱里有几根几乎看不见 | 存量和增量混在同组并列柱；存量改线走 `y1` |
| 图例里线系列是白心空环 | 图例 `generateLabels` 没显式给 `fillStyle` / `strokeStyle` |
| 第 2 条和第 5 条线颜色几乎一样 | 系列超过 4 个撞上 `PALETTE[1]` / `[4]`，跳过 `[4]` 或拆图 |
| 柱顶没有合计数、悬停没有竖虚线 | 没复制注册 `valueLabels` / `hoverGuide` 插件 |
| 并列柱顶出现一个数，等于两根柱之和 | 并列柱没关 `showStackTotal`，改为 `false` 并开 `barTop: true` |
| 单系列柱的数字柱顶柱内各一遍 | 单系列柱没关 `showStackTotal` |
| 柱内数字被截成半个（如「104」显示成「04」） | 并列柱没开 `barTop`，数字挤在窄柱里 |
