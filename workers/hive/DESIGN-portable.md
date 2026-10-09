# 仪表盘前端样式规范（通用版）

本文从 hive 服务看板（`workers/hive/`）的实现中提炼，去掉了 hive 专属的业务维度和文件路径，
供**其他仪表盘项目**直接复用。hive 仓库内部改样式请读同目录的 `DESIGN.md`。

适用于 **Chart.js v4**（v3 的坐标轴写法不同，不适用）。

## 使用方式

**照抄下面两段代码，不要凭文字描述自己重写配置。** 只读描述去写，图表会退回 Chart.js
默认样式：坐标轴字大偏黑、网格铺满、直角柱、方块居中图例。

1. 页面引入「一、CSS」
2. 在 `chart.min.js`（v4）之后引入「二、图表工具代码」
3. 所有柱 / 线图都用 `comboChart()` 画，不要直接 `new Chart()`
4. 画完对照末尾「六、走样自查」逐项检查

两段代码都经过实测：照抄后画出单系列柱 + 线、并列柱 + 累计线、5 条线、堆叠柱 + 线
四种图，以及指标卡、筛选器、按钮、语义色块，零报错，卡片无溢出。

## 基调

浅紫灰底配纯白卡片。用极淡的阴影和几乎透明的描边分层，**不用重边框**。
圆角偏大（16px）。整体柔和、现代，不是传统 BI 那种密集网格。

## 一、CSS

```css
:root {
  --bg: #f5f6fb;            /* 页面底色 */
  --card: #ffffff;          /* 卡片 */
  --ink: #20264a;           /* 主文字 */
  --ink-soft: #555d80;      /* 次文字 */
  --muted: #9198b2;         /* 弱化文字 */
  --line: #e9ebf4;          /* 分隔线 */
  --primary: #635bea;       /* 主色 */
  --primary-soft: #efefff;  /* 主色浅底 */
  --cyan: #63cfc9;
  --rose: #ee8d87;
  --shadow: 0 6px 18px rgba(47, 54, 102, .055);
  --shadow-hover: 0 10px 26px rgba(47, 54, 102, .10);
  --radius: 16px;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--ink);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

.main { max-width: 1400px; margin: 0 auto; padding: 20px 28px 10px; }

/* ---- 图表卡 ---- */
.grid { display: flex; flex-wrap: wrap; gap: 18px; }
.chart-card {
  background: var(--card);
  border-radius: var(--radius);
  padding: 19px 21px 22px;
  min-height: 320px;
  box-shadow: var(--shadow);
  flex: 1 1 340px;                       /* 窄屏自动变单列 */
  min-width: min(340px, 100%);
  border: 1px solid rgba(57, 56, 120, .045);
  transition: transform .15s ease, box-shadow .15s ease;
}
.chart-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
.chart-card.wide { flex: 1 1 100%; min-width: 100%; }
.chart-card.tall { min-height: 460px; }

/* 卡片标题：左侧 4px 圆角竖条，颜色按位置轮换（纯装饰，不表达含义） */
.chart-card h3 {
  position: relative; margin: 0 0 16px; padding-left: 12px;
  color: var(--ink); font-size: 15px; font-weight: 700; letter-spacing: -.12px;
}
.chart-card h3::before {
  content: ""; position: absolute; left: 0; top: .25em;
  width: 4px; height: 1em; border-radius: 999px; background: var(--primary);
}
.grid .chart-card:nth-child(3n + 2) h3::before { background: var(--cyan); }
.grid .chart-card:nth-child(3n) h3::before { background: var(--rose); }

/* 画布定高：必须和 JS 里的 maintainAspectRatio:false 配合，否则 X 轴标签会冲出卡片 */
.chart-card canvas { max-height: 300px; }
.chart-card.tall canvas { max-height: 400px; }

/* ---- 指标卡（KPI） ---- */
.card {
  background: var(--card); border-radius: 20px; padding: 19px 18px 17px;
  box-shadow: 0 12px 26px rgba(57, 56, 120, .06);
  border: 1px solid rgba(56, 56, 116, .035); min-height: 118px;
}
.card-label { color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1.3; }
.card-value {
  color: var(--ink); font-size: 23px; font-weight: 720; line-height: 1.1;
  letter-spacing: -.65px; white-space: nowrap;
  font-variant-numeric: tabular-nums;   /* 等宽数字：数值刷新时不左右抖动 */
}
.card-sub { color: var(--muted); font-size: 10.5px; line-height: 1.45; }

/* ---- 控件 ---- */
.btn {
  background: var(--primary); color: #fff; border: none; border-radius: 9px;
  padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 5px 12px rgba(99, 91, 234, .25); transition: transform .15s, box-shadow .15s;
}
.btn:hover { transform: translateY(-1px); box-shadow: 0 8px 16px rgba(99, 91, 234, .32); }
.btn:disabled { opacity: .55; cursor: not-allowed; transform: none; box-shadow: none; }

.tab {
  background: var(--card); border: none; border-radius: 10px; padding: 8px 15px;
  font-size: 13px; font-weight: 500; color: var(--muted); cursor: pointer;
  box-shadow: 0 3px 8px rgba(47, 54, 102, .04);
}
.tab:hover { color: var(--primary); }
.tab.active { background: var(--primary); color: #fff; font-weight: 600; box-shadow: 0 5px 12px rgba(99, 91, 234, .24); }

select, input[type="date"] {
  padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px;
  background: #fafbfe; font-size: 13px; color: var(--ink); outline: none;
  transition: border-color .14s, background .14s;
}
select:focus, input:focus { border-color: var(--primary); background: #fff; }
select.active, input.active {           /* 筛选生效中，一眼可见 */
  border-color: var(--primary); background: var(--primary-soft); color: var(--primary); font-weight: 500;
}

/* ---- 表格 ---- */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 13px 16px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { background: #f9f8ff; position: sticky; top: 0; z-index: 2; font-weight: 600; color: var(--muted); font-size: 12.5px; }

/* ---- 语义色 ---- */
/* 环比/同比：按方向固定红增绿减，不按指标好坏翻转 */
.delta { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.delta.up   { background: #fdecee; color: #d9484d; }
.delta.down { background: #e7f8ef; color: #199c58; }
.delta.flat { background: #f1f2f9; color: #6a7089; }
/* 状态标签：按好坏 */
.pill { display: inline-block; padding: 4px 13px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.pill.good { background: #e7f8ef; color: #199c58; }
.pill.warn { background: #fef3e2; color: #cf8016; }
.pill.bad  { background: #fdecee; color: #d9484d; }
.banner { background: #fdeeee; color: #c8393a; padding: 13px 18px; border-radius: 12px; }
```

## 二、图表工具代码

在 `chart.min.js` 之后引入，执行一次即可。包含两个自定义插件（柱上数字 `valueLabels`、
悬停竖虚线 `hoverGuide`）、全局默认、色板和统一入口 `comboChart()`。

`comboChart()` 把最容易出错的几条规则写进了代码：按柱型自动选数字标注方式、
跳过撞色的颜色、有线有柱时自动开右侧副轴。

```js
function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n >= 10000 ? (n / 1000).toFixed(1) + "K" : String(n);
  return n.toFixed(n < 10 ? 2 : 1);
}

function readableInk(color) {
  const m = String(color).match(/^#([0-9a-f]{6})$/i);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#2a3050" : "#fff";
}

const hoverGuide = {
  id: "hoverGuide",
  afterDatasetsDraw(chart) {
    if (!chart.options.plugins?.hoverGuide?.enabled) return;
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#b9c0f0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.valueLabels;
    if (!opt || opt.enabled === false) return;
    const count = chart.data.labels?.length || 0;
    // 合计数和柱内分段值分开限流：分段值挤在柱子里，柱多了必须让位；
    // 但柱顶的合计数是最该看到的，阈值放宽，画不下的交给下面的碰撞检测丢弃。
    const showSeg = count <= (opt.maxLabels || 40);
    const showTotal = count <= (opt.maxTotalLabels || 150);
    if (!showSeg && !showTotal) return;

    const { ctx } = chart;
    const horizontal = chart.options.indexAxis === "y";
    const F = (w, size) => w + " " + size + 'px -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';

    // 先收集候选标签再统一画：合计 > 折线值 > 柱内分段值，
    // 位置冲突时丢掉优先级低的，避免数字叠在一起
    const items = [];
    const stackTotals = {};
    const stackTop = {};

    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      const kind = ds.type || meta.type || chart.config.type;
      if (kind === "doughnut" || kind === "pie") return;

      meta.data.forEach((el, i) => {
        const v = ds.data[i];
        if (v === null || v === undefined || v === 0) return;

        if (kind === "line") {
          // 柱线组合图里折线值会落进柱子内部，标出来会被误读成柱子的数值，
          // 所以组合图关掉它，交给悬停 tooltip
          if (opt.lineLabels === false) return;
          items.push({ p: 1, text: fmtNum(v), x: el.x, y: el.y - 9, font: F(600, 11), fill: "#5b6180", halo: true, align: "center" });
          return;
        }
        if (typeof el.base !== "number") return;

        const color = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor;
        if (horizontal) {
          const txt = (ds.customLabels && ds.customLabels[i]) || fmtNum(v);
          items.push({ p: 1, text: txt, x: el.x + 8, y: el.y + 4, font: F(600, 12), fill: (ds.labelInk && ds.labelInk[i]) || "#454b69", align: "left" });
          return;
        }
        if (opt.barTop) {
          // 并列柱：值画在柱顶。柱子矮时画在里面会看不见。
          if (showTotal) {
            items.push({ p: 1, text: fmtNum(v), x: el.x, y: el.y - 6, font: F(700, 11), fill: "#454b69", halo: true, align: "center" });
          }
        } else if (showSeg && Math.abs(el.base - el.y) >= 16) {
          items.push({ p: 2, text: fmtNum(v), x: el.x, y: (el.y + el.base) / 2 + 4, font: F(600, 11), fill: readableInk(color), align: "center" });
        }
        stackTotals[i] = (stackTotals[i] || 0) + v;
        stackTop[i] = stackTop[i] === undefined ? el.y : Math.min(stackTop[i], el.y);
      });
    });

    if (opt.showStackTotal !== false && showTotal) {
      Object.keys(stackTotals).forEach((i) => {
        const el = chart.getDatasetMeta(0).data[i];
        if (!el) return;
        items.push({ p: 0, text: fmtNum(stackTotals[i]), x: el.x, y: stackTop[i] - 7, font: F(700, 11.5), fill: "#1f2340", halo: true, align: "center" });
      });
    }

    ctx.save();
    ctx.lineJoin = "round";
    const boxes = [];
    const hits = (b) => boxes.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);

    for (const it of items.sort((a, b) => a.p - b.p)) {
      ctx.font = it.font;
      const w = ctx.measureText(it.text).width;
      const left = it.align === "left" ? it.x : it.x - w / 2;
      const box = { x1: left - 2, x2: left + w + 2, y1: it.y - 11, y2: it.y + 4 };
      if (hits(box)) continue;
      boxes.push(box);
      ctx.textAlign = it.align;
      if (it.halo) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255, 255, 255, .92)";
        ctx.strokeText(it.text, it.x, it.y);
      }
      ctx.fillStyle = it.fill;
      ctx.fillText(it.text, it.x, it.y);
    }
    ctx.restore();
  },
};


// ========== 全局默认：创建任何图表之前执行一次 ==========
Chart.register(valueLabels, hoverGuide);
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
Chart.defaults.font.size = 11.5;
Chart.defaults.color = "#8f8ca9";
Chart.defaults.borderColor = "#eeeaf6";
Object.assign(Chart.defaults.plugins.tooltip, {
  backgroundColor: "#393878", padding: 11, cornerRadius: 10, displayColors: false, caretSize: 6,
  titleFont: { size: 11.5, weight: "500" }, titleColor: "#b9bdd0", bodyFont: { size: 14, weight: "700" },
});

// ========== 色板 ==========
const PALETTE = [
  "#806dfa", "#00c8a9", "#ffb65c", "#ff6689", "#00d9d4",
  "#5e8ef2", "#b594ff", "#ff8dac", "#77ddd3", "#e5c77f",
  "#9289e9", "#70bdf7", "#d3b1ef", "#ffbe9d", "#a9afc7",
];
// 第 i 个系列的颜色。跳过 [4]：它和 [1] 同为青绿，系列一多就撞色。
function seriesColor(i) {
  const usable = PALETTE.filter((_, k) => k !== 4);
  return usable[i % usable.length];
}

/**
 * 统一入口。bars / lines 各是 [{ label, data, color? }]。
 * kind：
 *   "stacked" 多段构成整体（如 pc + mobile = 总量）→ 柱顶标合计
 *   "grouped" 并列、彼此不构成整体（如 人数 vs 企业数）→ 每根柱顶各标各的，绝不求和
 *   单系列柱自动按胶囊处理，只在柱内标值
 * 有 lines 时自动开右侧副轴 y1，线默认走 y1；lineAxis:"y" 让线和柱共用左轴。
 */
function comboChart(canvas, { labels, bars = [], lines = [], kind = "stacked", lineAxis = "y1", rotate = 45 }) {
  const single = bars.length === 1;
  const grouped = kind === "grouped" && !single;
  const stacked = !grouped && !single && bars.length > 1;
  let ci = 0;

  const barSets = bars.map((b, i) => ({
    type: "bar", label: b.label, data: b.data, yAxisID: "y",
    backgroundColor: b.color || seriesColor(ci++),
    stack: stacked ? "s" : undefined,
    borderSkipped: false,
    borderColor: "#fff",
    borderWidth: stacked ? { top: 2, right: 0, bottom: 0, left: 0 } : 0,
    borderRadius: single ? 20 : stacked ? (i === bars.length - 1 ? { topLeft: 5, topRight: 5 } : 2) : { topLeft: 5, topRight: 5 },
    barPercentage: single ? .42 : grouped ? .8 : .62,
    categoryPercentage: grouped ? .74 : .82,
    order: 2,
  }));
  barSets.forEach((d) => (d.hoverBackgroundColor = d.backgroundColor));

  const axisForLine = bars.length ? lineAxis : "y";
  const lineSets = lines.map((l) => {
    const c = l.color || seriesColor(ci++);
    return {
      type: "line", label: l.label, data: l.data, yAxisID: axisForLine,
      borderColor: c, backgroundColor: c, tension: .42, borderWidth: 2.5,
      pointRadius: 2.5, pointBackgroundColor: "#fff", pointBorderColor: c, pointBorderWidth: 2,
      pointHoverRadius: 5.5, fill: false, order: 1,
    };
  });

  const scales = {
    x: { stacked, grid: { display: false }, border: { display: false },
         ticks: { maxRotation: rotate, autoSkip: false, padding: 6 } },
    y: { stacked, beginAtZero: true, grid: { color: "#f2f4fa", drawTicks: false },
         border: { display: false }, ticks: { padding: 10, maxTicksLimit: 6 } },
  };
  if (lineSets.length && axisForLine === "y1") {
    scales.y1 = { position: "right", beginAtZero: true, grid: { display: false },
                  border: { display: false }, ticks: { padding: 8, maxTicksLimit: 6 } };
  }

  return new Chart(canvas, {
    data: { labels, datasets: [...barSets, ...lineSets] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 22 } },
      plugins: {
        title: { display: false },
        legend: {
          position: "top", align: "start",
          labels: {
            usePointStyle: true, boxWidth: 9, boxHeight: 9, padding: 14, font: { size: 12 },
            generateLabels(chart) {
              return Chart.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
                const ds = chart.data.datasets[item.datasetIndex] || {};
                const isLine = ds.type === "line";
                const color = isLine ? ds.borderColor : ds.backgroundColor;
                return { ...item, fillStyle: color, strokeStyle: color,
                         lineWidth: isLine ? 2 : 0, pointStyle: isLine ? "circle" : "rect" };
              });
            },
          },
        },
        valueLabels: {
          maxLabels: 40, maxTotalLabels: 150, lineLabels: false,
          showStackTotal: stacked,     // 只有堆叠柱才标合计
          barTop: grouped,             // 并列柱：值画柱顶
        },
        hoverGuide: { enabled: true },
      },
      scales,
    },
  });
}
```

## 三、用法示例

```html
<div class="grid">
  <div class="chart-card wide"><h3>交易笔数与 GMV</h3><canvas id="c1"></canvas></div>
  <div class="chart-card"><h3>申请、开通与累计</h3><canvas id="c2"></canvas></div>
</div>
```

```js
// 单系列柱 + 线：交易笔数（上万）走左轴，GMV（几百）自动走右轴
comboChart(document.getElementById("c1"), {
  labels: weeks,
  bars:  [{ label: "交易笔数", data: orders }],
  lines: [{ label: "GMV（万元）", data: gmv }],
  rotate: 0,
});

// 并列柱 + 累计线：每周新增用柱，累计用线走右轴
comboChart(document.getElementById("c2"), {
  labels: weeks, kind: "grouped",
  bars:  [{ label: "申请量", data: applied }, { label: "新开通", data: opened }],
  lines: [{ label: "累计超 3 笔商户", data: cumulative }],
});

// 堆叠柱：几段相加等于总量
comboChart(el, { labels: days, kind: "stacked",
  bars: [{ label: "pc", data: pc }, { label: "mobile", data: mobile },
         { label: "未知", data: unknown, color: "#d3d8e6" }] });

// 纯线
comboChart(el, { labels: weeks, lines: [{ label: "A", data: a }, { label: "B", data: b }] });
```

`kind` 的选择：

| 柱的关系 | `kind` | 数字标在哪 |
| --- | --- | --- |
| 几段相加等于总量（如 pc + mobile） | `"stacked"` | 柱顶合计 + 柱内分段 |
| 彼此不构成整体（如人数 vs 企业数） | `"grouped"` | 每根柱顶各标各的，**不求和** |
| 只有一组柱 | 不用管，自动识别 | 柱内 |

## 四、配色规则

**同一个维度值，在所有图里永远是同一个颜色。** 比如「pc」在这张图是蓝色，到另一张图
也必须是蓝色。做法是给业务维度建一张固定映射表，用 `color` 字段传进去：

```js
const COLOR_DEVICE = { pc: "#5e8ef2", mobile: "#00c8a9", "未知": "#d3d8e6" };
bars: keys.map((k) => ({ label: k, data: ..., color: COLOR_DEVICE[k] }))
```

只有临时的、不跨图复用的系列，才交给 `seriesColor()` 按顺序取色。

**「未知 / 未标记」一律用灰色**（`#d3d8e6` 或 `#bcc2d1`），不占用彩色。
缺失的数据不应该在图里抢注意力。

**CSS 里的 `--primary`、`--cyan`、`--rose` 是界面装饰色**（标题竖条、按钮、标签底色），
不要拿来当数据系列的颜色。`--primary #635bea` 和色板第一色 `#806dfa` 都是紫色，
放在同一张图里分不清。

**环比 / 同比固定红增绿减**（`.delta.up` 红、`.delta.down` 绿），按方向上色，
不按指标好坏翻转。否则同一个颜色在不同卡片里含义相反，读表的人会误判。
状态标签 `.pill` 才按好坏上色（good 绿 / warn 橙 / bad 红）。

## 五、数据表达规则

这几条不是样式偏好，违反了会让人读错数。

**相差一个数量级以上的两组数据，不能共用一根 Y 轴。** 比如 GMV（几百）和交易笔数
（上万）共用一根轴，GMV 会被压成一条贴底的直线。`comboChart` 默认让线走右轴；
如果两组都是柱，就拆成两张图。

**累计值用线，每周新增用柱，不要放进同一组并列柱。** 累计值（如累计商户数，上千）和
每周新增（如申请量，几十）并排放柱子，新增的柱子会小到看不见。

**彼此不构成整体的指标，不要堆叠。** 比如人数和企业数：一个企业下可能有多个用户，
堆叠起来会读成「人数 + 企业数」，这个和没有意义。用 `kind: "grouped"`。

**去重计数不能跨周期相加。** 同一个用户周一、周二各来一次，按天统计是 2，按周只能算 1。
所以按周、按月的去重人数必须在后端分别计算，不能把按天的数字加起来；「合计」也应该是
整个区间去重后的数，而不是各周期相加。

**一张图最多 4 条线。** 再多就难以分辨，应该拆成两张图。

**饼图 / 环图里占比不到 1% 的分类，合并为「其他」**，否则会细到看不见。

**不要为了图表好看去改数据口径。** 改分母或过滤条件时，要在图表旁边写明口径。

## 六、走样自查

画完逐项对照。左边任何一条出现，就是漏了右边对应的配置：

| 看到的现象 | 原因 |
| --- | --- |
| 坐标轴文字偏大、偏黑 | 没执行「全局默认」那段 |
| 卡片标题下面又多了一个图表标题 | 开了 Chart.js 的 `title`，卡片 h3 才是唯一标题 |
| X 轴有竖网格线，或 Y 轴左侧有一根竖线 | 没用 `comboChart`，自己写的 `scales` |
| 某条线贴着底部几乎是一条直线 | 两组数据量级差太大却共用一根轴 |
| 两个系列颜色分不清 | 从 CSS 装饰色里挑了同色系，或一张图超过 4 条线 |
| 折线是直的、数据点是实心圆 | 没用 `comboChart` 的线样式 |
| 柱子是直角 | 同上 |
| 图例居中、全是方块 | 同上 |
| 图例里线的图标是白心空环 | 自己改了图例，漏了 `fillStyle` / `strokeStyle` |
| X 轴标签冲出卡片底部 | 少了 `maintainAspectRatio: false`，或 CSS 少了 canvas 的 `max-height` |
| 并列柱的柱顶出现一个数，等于两根柱之和 | 并列柱没传 `kind: "grouped"`，**这是错误的数字** |
| 柱内数字被截掉一半 | 同上，数字挤在了窄柱里 |
| 单系列柱的数字在柱顶、柱内各出现一次 | 自己开了 `showStackTotal` |
| 一组柱里有几根几乎看不见 | 累计值和每周新增放在了同一组并列柱 |
| 柱顶没有数字、悬停没有竖虚线 | 漏了 `Chart.register(valueLabels, hoverGuide)` |
