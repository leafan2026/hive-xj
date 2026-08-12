// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

// 统一的低饱和调色板：饱和度约 55%、明度约 70%，同色系跨图表复用
const PALETTE = [
  "#6f9bec", "#5cc191", "#f0b64f", "#a08ae6", "#ef8f8a",
  "#68c3dd", "#5ec8c0", "#eaa96b", "#c39ae0", "#f0a3a8",
  "#8a9bef", "#7fd3a8", "#f2bd8e", "#b6a5ee", "#a9b1c4",
];

const state = { stats: null, facets: null, refreshing: false, polling: false, weeks: [], weeklyLoaded: false, latestDay: null };
const charts = {};

// 筛选项 → 接口参数名；选项值来自首次全量结果，筛选后不再改动
const DIM_SELECTS = {
  fDevice: { dim: "device", placeholder: "全部设备" },
  fScene: { dim: "scene", placeholder: "全部业务场景" },
  fNature: { dim: "nature", placeholder: "全部会话性质" },
};

// ============== 工具 ==============

function $(id) { return document.getElementById(id); }

// 首屏先占位，避免大片空白
function renderSkeleton() {
  const labels = ["会话总数", "AI 独立率", "可避免转人工", "人工接待总时长", "接待轮次总计"];
  $("cards").innerHTML = labels.map((l) =>
    '<div class="card skeleton"><div class="card-label">' + l + '</div>' +
    '<div class="card-value">—</div><div class="card-sub">加载中…</div></div>'
  ).join("");
}

function banner(msg, kind) {
  const el = $("banner");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = "banner" + (kind === "info" ? " info" : "");
  el.textContent = msg;
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined || sec === "") return "—";
  const s = Number(sec);
  if (!s) return "0 秒";
  if (s < 60) return s + " 秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分 " + (s % 60) + " 秒";
  return Math.floor(m / 60) + " 时 " + (m % 60) + " 分";
}

function sortedPairs(obj, limit) {
  const pairs = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  return limit ? pairs.slice(0, limit) : pairs;
}

// 统一走这里，401 和非 JSON 响应都给出可读的提示
async function api(path, init) {
  const res = await fetch(BASE + path, init);
  if (res.status === 401) {
    // 会话过期：直接回登录页，不用让用户自己刷新
    location.href = BASE + "/";
    throw new Error("登录状态已失效，正在跳转登录页…");
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error("接口返回 " + res.status + "：" + text.slice(0, 120));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("返回内容不是 JSON：" + text.slice(0, 120));
  }
}

// ============== 图表 ==============

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

// 底色偏亮时改用深色字，浅色柱上的白字会看不清
function readableInk(color) {
  const m = String(color).match(/^#([0-9a-f]{6})$/i);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#2a3050" : "#fff";
}

function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n >= 10000 ? (n / 1000).toFixed(1) + "K" : String(n);
  return n.toFixed(n < 10 ? 2 : 1);
}

// 分类固定配色，跨图表保持一致
const COLOR_NATURE = {
  "有效": "#8fb2f2", "填表人": "#6fcfc6", "无效": "#8fdcaa",
  "转接未应答": "#f4a8a4", "电话引导·发链接图片": "#6f9bec",
  "内部测试": "#f3d07a", "未标记": "#d3d8e6",
};
const COLOR_CHANNEL = {
  gd_next: "#eaa96b", gd4: "#c0a07a", gd_app: "#a08ae6",
  wechat_miniapp: "#5cc191", wechat_official: "#ef8f8a",
  trade_weixin_app: "#6f9bec", "未知": "#bcc2d1",
};
const COLOR_DEVICE = { pc: "#6f9bec", mobile: "#5cc191", "未知": "#d3d8e6" };

function colorFor(map, key, i) {
  return map[key] || PALETTE[i % PALETTE.length];
}

// 折线用的横向渐变（蓝 → 紫 → 粉），面积用纵向渐隐
const LINE_GRADIENT = ["#74c2f5", "#8194f2", "#b183ee", "#e79ecb"];

function strokeGradient(chart, colors) {
  const { ctx, chartArea } = chart;
  if (!chartArea) return colors[0];
  const g = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
  return g;
}

function areaGradient(chart, hex) {
  const { ctx, chartArea } = chart;
  if (!chartArea) return "rgba(0,0,0,0)";
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, hex + "30");
  g.addColorStop(1, hex + "00");
  return g;
}

// Chart.js 万一没加载成功，卡片和文字结论照常可用
let chartsInited = false;
function chartReady() {
  if (typeof Chart === "undefined") return false;
  if (!chartsInited) {
    Chart.register(valueLabels, centerText, hoverGuide, ribbonArcs);
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = "#8b90a7";
    Chart.defaults.borderColor = "#f0f2f8";
    Chart.defaults.plugins.tooltip.backgroundColor = "#12162b";
    Chart.defaults.plugins.tooltip.padding = 11;
    Chart.defaults.plugins.tooltip.cornerRadius = 10;
    Chart.defaults.plugins.tooltip.displayColors = false;
    Chart.defaults.plugins.tooltip.titleFont = { size: 11.5, weight: "500" };
    Chart.defaults.plugins.tooltip.titleColor = "#b9bdd0";
    Chart.defaults.plugins.tooltip.bodyFont = { size: 14, weight: "700" };
    Chart.defaults.plugins.tooltip.caretSize = 6;
    chartsInited = true;
  }
  return true;
}

// 无边框、无纵轴的坐标系（参考里的柱状图都不画纵轴和竖网格）
function cleanScales(opts) {
  const o = opts || {};
  return {
    x: {
      stacked: !!o.stacked,
      grid: { display: false, drawBorder: false },
      border: { display: false },
      ticks: { maxRotation: o.rotate ?? 0, autoSkip: o.autoSkip !== false, maxTicksLimit: o.maxTicks, padding: 6 },
    },
    y: {
      stacked: !!o.stacked,
      beginAtZero: true,
      grid: { color: "#f2f4fa", drawTicks: false },
      border: { display: false, dash: [0, 1] },
      ticks: { padding: 10, maxTicksLimit: 6 },
    },
  };
}

// ============== 环形图（参考：粗圆角弧 + 大内圈 + 中心指标） ==============

function drawDoughnut(key, canvasId, pairs, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;
  // 占比不足 1% 的分类会被圆头压成一条线，合并成「其他」
  const rawSum = pairs.reduce((a, p) => a + p[1], 0);
  const tiny = pairs.filter((p) => rawSum && p[1] / rawSum < 0.01);
  let shown = pairs;
  if (tiny.length > 1) {
    const rest = tiny.reduce((a, p) => a + p[1], 0);
    shown = pairs.filter((p) => !tiny.includes(p)).concat([["其他（各 <1%）", rest]]);
  }
  const colors = shown.map((p, i) => (o.colorMap ? colorFor(o.colorMap, p[0], i) : PALETTE[i % PALETTE.length]));
  const sum = shown.reduce((a, p) => a + p[1], 0);
  const top = shown[0];
  const pairs2 = shown;

  charts[key] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: pairs2.map((p) => p[0]),
      datasets: [{
        data: pairs2.map((p) => p[1]),
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 0,
        spacing: 0,
        hoverOffset: 0,
        hoverBorderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      layout: { padding: { top: 6, bottom: 2 } },
      plugins: {
        valueLabels: { enabled: false },
        ribbonArcs: { enabled: true },
        centerText: {
          value: top && sum ? ((top[1] / sum) * 100).toFixed(1) + "%" : "—",
          label: top ? top[0] : "",
        },
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 12,
            font: { size: 12 },
            generateLabels(chart) {
              const ds = chart.data.datasets[0];
              return chart.data.labels.map((l, i) => ({
                text: l + "  " + fmtNum(ds.data[i]),
                fillStyle: ds.backgroundColor[i],
                strokeStyle: ds.backgroundColor[i],
                lineWidth: 0,
                pointStyle: "circle",
                hidden: !chart.getDataVisibility(i),
                index: i,
              }));
            },
          },
        },
        tooltip: {
          displayColors: true,
          callbacks: {
            title: (items) => items[0].label,
            label(c) {
              const total = c.dataset.data.reduce((a, b) => a + (Number(b) || 0), 0);
              return c.parsed + "（" + (total ? ((c.parsed / total) * 100).toFixed(1) : 0) + "%）";
            },
          },
        },
      },
    },
  });
}

// 环形图的层叠效果：Chart.js 的 borderRadius 会把圆头内缩进扇区角度里，必然留缝。
// 这里让它自带的弧透明，改用「圆头描边弧」自己画 —— 圆头溢出扇区边界压到相邻弧上，
// 配合柔和阴影就是参考稿里一段搭一段的观感。
const ribbonArcs = {
  id: "ribbonArcs",
  // 让 Chart.js 自己画的扇区隐形（几何仍在，tooltip/图例的命中判定照常）
  beforeDatasetDraw(chart) {
    if (!chart.options.plugins?.ribbonArcs?.enabled) return;
    chart.ctx.save();
    chart.ctx.globalAlpha = 0;
  },
  afterDatasetDraw(chart) {
    if (!chart.options.plugins?.ribbonArcs?.enabled) return;
    chart.ctx.restore();
  },

  afterDatasetsDraw(chart) {
    if (!chart.options.plugins?.ribbonArcs?.enabled) return;
    const meta = chart.getDatasetMeta(0);
    const ds = chart.data.datasets[0];
    const first = meta.data[0];
    if (!first) return;

    const { ctx } = chart;
    const cx = first.x;
    const cy = first.y;
    const width = first.outerRadius - first.innerRadius;
    const radius = (first.outerRadius + first.innerRadius) / 2;
    const active = (chart.tooltip?.getActiveElements?.() || []).map((a) => a.index);

    ctx.save();
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(31, 35, 64, .2)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;

    // 圆头会往两侧各溢出半个线宽，全额溢出会把小占比的段吃掉：
    // 把两端各内收一点，重叠量压到半个圆头以内，且不超过该段自身跨度的三成
    const capAngle = (width / 2) / radius;

    // 正序绘制：占比大的先画落在底层，小的后画压在上面，保证都看得见
    for (let i = 0; i < meta.data.length; i++) {
      if (!chart.getDataVisibility(i)) continue;
      const arc = meta.data[i];
      if (!arc) continue;
      const span = arc.endAngle - arc.startAngle;
      if (span <= 0) continue;
      const inset = Math.min(capAngle * 0.5, span * 0.3);
      const hot = active.includes(i);
      // 跨度小于一个圆头时按比例收细，否则 0.2% 的段会被撑成和 6% 一样大的圆点
      const minSpan = capAngle * 0.9;
      const lw = span >= minSpan ? width : Math.max(width * 0.36, width * (span / minSpan));
      ctx.lineWidth = hot ? lw + 5 : lw;
      ctx.strokeStyle = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, arc.startAngle + inset, arc.endAngle - inset);
      ctx.stroke();
    }
    ctx.restore();
  },
};

// 环形图中心的大号指标
const centerText = {
  id: "centerText",
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins?.centerText;
    if (!o || !o.value) return;
    const arc = chart.getDatasetMeta(0).data[0];
    if (!arc) return;
    const { ctx } = chart;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#1f2340";
    ctx.font = '700 24px -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
    ctx.fillText(o.value, arc.x, arc.y + 2);
    if (o.label) {
      ctx.fillStyle = "#8b90a7";
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(o.label, arc.x, arc.y + 22);
    }
    ctx.restore();
  },
};

// ============== 条形图（参考：胶囊条 + 末端数值 + 双色交替） ==============

function drawBar(key, canvasId, pairs, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;

  const alt = o.colors || ["#6f9bec", "#f0a385"];
  const colors = o.color ? pairs.map(() => o.color) : pairs.map((_, i) => alt[i % alt.length]);

  charts[key] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: pairs.map((p) => p[0]),
      datasets: [{
        label: o.label || "会话数",
        data: pairs.map((p) => p[1]),
        backgroundColor: colors,
        hoverBackgroundColor: colors,
        borderRadius: 20,           // 全圆角，做成胶囊
        borderSkipped: false,
        barPercentage: o.horizontal ? .55 : .42,
        categoryPercentage: .8,
      }],
    },
    options: {
      indexAxis: o.horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: o.horizontal ? 44 : 8, top: o.horizontal ? 0 : 22 } },
      plugins: {
        legend: { display: false },
        valueLabels: { maxLabels: 40, showStackTotal: false },
        tooltip: { callbacks: { title: (i) => i[0].label, label: (c) => fmtNum(c.parsed[o.horizontal ? "x" : "y"]) } },
      },
      scales: o.horizontal
        ? {
            x: { display: false, beginAtZero: true, grace: "8%" },
            y: { grid: { display: false }, border: { display: false }, ticks: { padding: 8, font: { size: 12 } } },
          }
        : cleanScales({ rotate: o.rotate }),
    },
  });
}

// ============== 折线图（参考：渐变描边 + 渐变面积 + 白心圆点） ==============

function drawLine(key, canvasId, pairs) {
  if (!chartReady()) return;
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;
  charts[key] = new Chart(ctx, {
    type: "line",
    data: {
      labels: pairs.map((p) => p[0]),
      datasets: [{
        label: "会话数",
        data: pairs.map((p) => p[1]),
        borderColor: (c) => strokeGradient(c.chart, LINE_GRADIENT),
        backgroundColor: (c) => areaGradient(c.chart, "#8194f2"),
        borderWidth: 3,
        fill: true,
        tension: .42,
        pointRadius: 3,
        pointBackgroundColor: "#fff",
        pointBorderColor: "#8194f2",
        pointBorderWidth: 2,
        pointHoverRadius: 6,
        pointHoverBorderWidth: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        valueLabels: { enabled: false },
        hoverGuide: { enabled: true },
      },
      scales: cleanScales({ maxTicks: 14 }),
    },
  });
}

// 悬停时的竖向虚线（参考图里的定位线）
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

// ============== 组合图：堆叠柱 + 双轴折线 ==============

function drawCombo(key, canvasId, labels, bars, lines, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;

  const single = bars.length === 1;
  const datasets = [
    ...bars.map((b, i) => ({
      type: "bar",
      label: b.label,
      data: b.data,
      backgroundColor: b.color,
      hoverBackgroundColor: b.color,
      stack: "s",
      yAxisID: "y",
      borderWidth: 0,
      // 单系列做成胶囊，堆叠时只给最上面一段留圆角
      borderRadius: single ? 20 : (i === bars.length - 1 ? { topLeft: 5, topRight: 5 } : 2),
      borderSkipped: false,
      // 段与段之间留一条白色细缝，避免颜色直接相接糊在一起
      borderColor: "#fff",
      borderWidth: single ? 0 : { top: 2, right: 0, bottom: 0, left: 0 },
      barPercentage: single ? .42 : .62,
      categoryPercentage: .82,
      order: 2,
    })),
    ...lines.map((l) => ({
      type: "line",
      label: l.label,
      data: l.data,
      borderColor: l.color,
      backgroundColor: l.color,
      yAxisID: l.axis || "y1",
      tension: .42,
      borderWidth: 2.5,
      pointRadius: 2.5,
      pointBackgroundColor: "#fff",
      pointBorderColor: l.color,
      pointBorderWidth: 2,
      pointHoverRadius: 5.5,
      fill: false,
      order: 1,
    })),
  ];

  const scales = cleanScales({ stacked: true, rotate: o.rotate ?? 45, autoSkip: false });
  if (o.yLabel) scales.y.title = { display: true, text: o.yLabel };
  if (lines.length) {
    scales.y1 = {
      position: "right",
      beginAtZero: true,
      grid: { display: false },
      border: { display: false },
      ticks: { padding: 8, maxTicksLimit: 6 },
      title: o.y1Label ? { display: true, text: o.y1Label } : undefined,
    };
  }

  charts[key] = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 22 } },
      plugins: {
        legend: {
          position: "top",
          align: "start",
          labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 14, font: { size: 12 } },
        },
        hoverGuide: { enabled: true },
        valueLabels: { maxLabels: o.maxLabels ?? 40, showStackTotal: o.showStackTotal !== false, lineLabels: false },
        tooltip: { displayColors: true, bodyFont: { size: 12.5, weight: "500" } },
      },
      scales,
    },
  });
}

// ============== 数值标签 ==============

// 把数值直接标在柱子和折线上，用内联插件实现，不引第三方依赖
const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.valueLabels;
    if (!opt || opt.enabled === false) return;
    const count = chart.data.labels?.length || 0;
    if (count > (opt.maxLabels || 40)) return;

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
          items.push({ p: 1, text: fmtNum(v), x: el.x + 8, y: el.y + 4, font: F(600, 12), fill: "#454b69", align: "left" });
          return;
        }
        if (Math.abs(el.base - el.y) >= 16) {
          items.push({ p: 2, text: fmtNum(v), x: el.x, y: (el.y + el.base) / 2 + 4, font: F(600, 11), fill: readableInk(color), align: "center" });
        }
        stackTotals[i] = (stackTotals[i] || 0) + v;
        stackTop[i] = stackTop[i] === undefined ? el.y : Math.min(stackTop[i], el.y);
      });
    });

    if (opt.showStackTotal !== false) {
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

// ============== 看板 ==============

// 缓存还在构建时轮询，构建完自动渲染
function pollUntilReady() {
  if (state.polling) return;
  state.polling = true;
  const tick = async () => {
    try {
      const meta = (await api("/api/status")).meta || {};
      if (meta.status === "ok") {
        state.polling = false;
        banner("");
        await loadDashboard();
        return;
      }
      if (meta.status === "error") {
        state.polling = false;
        banner("数据拉取失败：" + (meta.error || "未知错误") + "（可点右上角重试）");
        return;
      }
    } catch (e) { /* 忽略单次轮询失败 */ }
    setTimeout(tick, 4000);
  };
  setTimeout(tick, 4000);
}

// ============== 筛选 ==============

function currentQuery() {
  const p = new URLSearchParams();
  const range = $("fRange").value;
  if (range && range !== "custom") {
    // 「近 N 天」交给服务端按数据里最新日期换算，前端不必先知道最新日期
    p.set("range", range);
  } else if (range === "custom") {
    const from = $("fFrom").value;
    const to = $("fTo").value;
    if (from) p.set("from", from);
    if (to) p.set("to", to);
  }
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    if ($(id).value) p.set(cfg.dim, $(id).value);
  }
  return p;
}

// 选项来自全量口径（facets），筛选后不跟着缩水
function fillFacets(facets) {
  if (state.facets || !facets) return;
  state.facets = true;
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    const el = $(id);
    const current = el.value;
    el.innerHTML = '<option value="">' + cfg.placeholder + "</option>" +
      sortedPairs(facets[cfg.dim]).map((p) =>
        '<option value="' + p[0] + '">' + p[0] + "（" + p[1] + "）</option>"
      ).join("");
    el.value = current;
  }
}

// 高亮生效中的筛选项
function markActive() {
  const ids = ["fRange", "fFrom", "fTo", ...Object.keys(DIM_SELECTS)];
  ids.forEach((id) => {
    const el = $(id);
    el.classList.toggle("active", !!el.value);
  });
}

function applyRangePreset() {
  const v = $("fRange").value;
  const from = $("fFrom");
  const to = $("fTo");
  if (v === "custom") {
    from.disabled = to.disabled = false;
  } else {
    // 预设区间由服务端换算，日期框只做回显
    from.disabled = to.disabled = true;
    if (v === "") { from.value = ""; to.value = ""; }
  }
}

async function reload() {
  $("matchInfo").textContent = "筛选中…";
  document.querySelector(".filterbar").classList.add("busy");
  try {
    await loadDashboard();
  } finally {
    document.querySelector(".filterbar").classList.remove("busy");
  }
}

async function loadDashboard() {
  try {
    const qs = currentQuery().toString();
    const json = await api("/api/dashboard" + (qs ? "?" + qs : ""));
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      banner("首次缓存正在构建：从金数据全量拉取 6600+ 条会话，约需 20 秒，完成后自动显示。", "info");
      pollUntilReady();
      return;
    }
    state.stats = json.stats;
    fillFacets(json.facets);
    if (json.latestDay) state.latestDay = json.latestDay;
    // 预设区间回显服务端换算出的起止日期
    if ($("fRange").value && $("fRange").value !== "custom") {
      $("fFrom").value = json.resolvedFrom || "";
      $("fTo").value = json.resolvedTo || "";
    }
    renderCards(json.stats);
    renderCharts(json.stats);
    markActive();
    $("matchInfo").innerHTML = json.filtered
      ? "筛选后 <b>" + json.matched + "</b> / " + json.fullTotal + " 条会话参与统计"
      : "全部 <b>" + (json.fullTotal || json.stats.total) + "</b> 条会话";
    if (json.meta) {
      $("updatedAt").textContent =
        "数据更新于 " + new Date(json.meta.updatedAt).toLocaleString("zh-CN") +
        "（" + json.meta.total + " 条）";
    }
    banner(
      json.stats.total === 0 ? "当前筛选条件下没有会话，放宽条件或点「重置筛选」。" : "",
      "info"
    );
  } catch (err) {
    banner("看板数据加载失败：" + err.message);
  }
}

function renderCharts(s) {
  renderAI(s);
  renderTrend(s);
  renderScene(s);
  renderCost(s);
}

function renderCards(s) {
  const d = s.derived;
  const cards = [
    { label: "会话总数", value: s.total, sub: "有效会话 " + d.effectiveCount + " 条 · " + d.effectiveRate + "%" },
    { label: "AI 独立率", value: d.aiRate + "%", sub: "AI 独立接待 " + d.aiOnlyCount + " 条 · 人工在线 " + d.manualCount + " 条 / " + d.manualRate + "%" },
    { label: "可避免转人工", value: d.avoidableRate + "%", sub: d.avoidableCount + " / " + s.transferred + " 次本可由 AI 承接" },
    { label: "人工接待总时长", value: d.durSumHours + " 小时", sub: "均 " + fmtDuration(d.durAvg) + " · 中位 " + fmtDuration(d.durMedian) },
    { label: "接待轮次总计", value: s.turnsSum, sub: "有时长记录会话 " + s.durCount + " 条" },
  ];
  $("cards").innerHTML = cards.map((c) =>
    '<div class="card"><div class="card-label">' + c.label + '</div>' +
    '<div class="card-value">' + c.value + '</div>' +
    '<div class="card-sub">' + c.sub + '</div></div>'
  ).join("");
}

function renderAI(s) {
  // 只画已质检的部分，未标记会淹没分布
  drawDoughnut("jiri", "chartJiri", sortedPairs(s.jiri).filter((p) => p[0] !== "未标记"));
  drawDoughnut("way", "chartWay", sortedPairs(s.way));
  drawBar("reason", "chartReason", sortedPairs(s.reason), { horizontal: true, colors: ["#f0a385", "#6f9bec"] });

  const d = s.derived;
  const top = sortedPairs(s.reason, 1)[0];
  $("noteAvoidable").innerHTML =
    "转人工 <b>" + s.transferred + "</b> 次，<b>" + d.avoidableCount + "</b> 次（" +
    d.avoidableRate + "%）属于可避免类型（AI 能答没给机会 / 没等答完顺手转 / 可自助 / 答对仍要人）。" +
    (top ? " 最主要原因是 <b>" + top[0] + "</b>（" + top[1] + " 次）。" : "");
}

// 桶里出现过的分类，按全量占比排序，保证堆叠顺序稳定
function bucketKeys(buckets, field, order) {
  const totals = {};
  for (const b of buckets) {
    for (const [k, v] of Object.entries(b[field] || {})) totals[k] = (totals[k] || 0) + v;
  }
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!order) return keys;
  return keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

function sortedKeys(obj, asc) {
  return Object.keys(obj || {}).filter((k) => /^\d{4}(-\d{2}-\d{2}|W\d{2})$/.test(k))
    .sort((a, b) => (asc === false ? b.localeCompare(a) : a.localeCompare(b)));
}

// 2026-07-28 → 26/07/28
function dayLabel(d) {
  return d.slice(2).replace(/-/g, "/");
}

// 同月：26/07/05～06；跨月：26/07/31～08/01
function rangeLabel(a, b) {
  if (a === b) return dayLabel(a);
  return dayLabel(a) + "～" + (a.slice(0, 7) === b.slice(0, 7) ? b.slice(8) : b.slice(5).replace("-", "/"));
}

// 把连续的空白日期（无人工接待）合并成一格，省掉整片空柱子
function compressEmptyDays(days, buckets, isEmpty) {
  const labels = [];
  const out = [];
  let i = 0;
  while (i < days.length) {
    if (!isEmpty(buckets[i])) {
      labels.push(dayLabel(days[i]));
      out.push(buckets[i]);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < days.length && isEmpty(buckets[j + 1])) j++;
    labels.push(rangeLabel(days[i], days[j]));
    out.push(buckets.slice(i, j + 1).reduce((acc, b) => ({
      total: acc.total + b.total,
      dur: acc.dur + b.dur,
      durCount: acc.durCount + b.durCount,
      transfer: acc.transfer + b.transfer,
      turns: acc.turns + b.turns,
      dev: {}, ch: {}, nat: {},
    }), { total: 0, dur: 0, durCount: 0, transfer: 0, turns: 0 }));
    i = j + 1;
  }
  return { labels, buckets: out, merged: days.length - labels.length };
}

function setTotal(id, label, value) {
  const el = $(id);
  if (el) el.innerHTML = label + "<b>" + fmtNum(value) + "</b>";
}

function renderTrend(s) {
  const days = sortedKeys(s.byDay);
  const dayB = days.map((d) => s.byDay[d]);
  const weeks = sortedKeys(s.byWeek);
  const weekB = weeks.map((w) => s.byWeek[w]);

  // 会话接待分布（按天）：设备堆叠柱 + 人工总时长 / 转人工次数双折线
  const devKeys = bucketKeys(dayB, "dev");
  drawCombo(
    "dayRecept", "chartDayRecept", days,
    devKeys.map((k, i) => ({ label: k, data: dayB.map((b) => b.dev[k] || 0), color: colorFor(COLOR_DEVICE, k, i) })),
    [
      { label: "人工接待总时长（小时）", data: dayB.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f0b64f", axis: "y1" },
      { label: "转人工会话接待次数", data: dayB.map((b) => b.transfer), color: "#a9b1c4", axis: "y1" },
    ],
    { maxLabels: 40, rotate: 60 }
  );
  setTotal("totalDayRecept", "总计：", dayB.reduce((a, b) => a + b.total, 0));

  // 每周会话来源：渠道堆叠
  const chKeys = bucketKeys(weekB, "ch");
  drawCombo(
    "weekChannel", "chartWeekChannel", weeks,
    chKeys.map((k, i) => ({ label: k, data: weekB.map((b) => b.ch[k] || 0), color: colorFor(COLOR_CHANNEL, k, i) })),
    [], { rotate: 0 }
  );
  setTotal("totalWeekChannel", "总计：", weekB.reduce((a, b) => a + b.total, 0));

  // 渠道 × 会话性质
  const channels = sortedPairs(s.channel).map((p) => p[0]);
  const natKeys = sortedPairs(s.nature).map((p) => p[0]);
  drawCombo(
    "channelNature", "chartChannelNature", channels,
    natKeys.map((k, i) => ({
      label: k,
      data: channels.map((c) => (s.natureByChannel[c] || {})[k] || 0),
      color: colorFor(COLOR_NATURE, k, i),
    })),
    [], { rotate: 20 }
  );
  setTotal("totalChannelNature", "记录数量：", s.total);

  // 设备 × 会话性质
  const devices = sortedPairs(s.device).map((p) => p[0]);
  drawCombo(
    "deviceNature", "chartDeviceNature", devices,
    natKeys.map((k, i) => ({
      label: k,
      data: devices.map((d) => (s.natureByDevice[d] || {})[k] || 0),
      color: colorFor(COLOR_NATURE, k, i),
    })),
    [], { rotate: 0 }
  );
  setTotal("totalDeviceNature", "总计：", s.total);

  drawDoughnut("status", "chartStatus", sortedPairs(s.status));
  drawBar("medium", "chartMedium", sortedPairs(s.medium, 12), { horizontal: true, colors: ["#a08ae6", "#68c3dd"] });
}

function renderScene(s) {
  drawDoughnut("nature2", "chartNature2", sortedPairs(s.nature), { colorMap: COLOR_NATURE });
  setTotal("totalNature2", "记录数量：", s.total);

  drawBar("scene", "chartScene", sortedPairs(s.effectiveScene), { horizontal: true, colors: ["#6f9bec", "#f0a385"] });
  drawDoughnut("plan", "chartPlan", sortedPairs(s.plan));
  // 「无关」占九成以上，会把其他分类压成一条线，剔除后只看真正相关的会话
  const xj = sortedPairs(s.xjCategory).filter((p) => p[0] !== "无关");
  drawDoughnut("xj", "chartXj", xj);
  setTotal("totalXj", "相关会话：", xj.reduce((a, p) => a + p[1], 0));

  // 行列都按有效会话口径，避免出现全零的行/列
  const planTotals = {};
  for (const row of Object.values(s.sceneByPlan || {})) {
    for (const [k, v] of Object.entries(row)) planTotals[k] = (planTotals[k] || 0) + v;
  }
  // 套餐按档位从低到高固定排序，不按数量排
  const PLAN_ORDER = ["免费版", "专业版", "专业增强版", "企业基础版", "企业协作版", "企业高级版", "商业合作版"];
  const plans = Object.keys(planTotals).sort((a, b) => {
    const ia = PLAN_ORDER.indexOf(a);
    const ib = PLAN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const scenes = sortedPairs(s.effectiveScene).map((p) => p[0]);
  let html = "<thead><tr><th>业务场景</th>" +
    plans.map((p) => "<th>" + p + "</th>").join("") + "<th>合计</th></tr></thead><tbody>";
  for (const sc of scenes) {
    const row = s.sceneByPlan[sc] || {};
    const total = plans.reduce((sum, p) => sum + (row[p] || 0), 0);
    html += "<tr><td>" + sc + "</td>" +
      plans.map((p) => "<td>" + (row[p] || "—") + "</td>").join("") +
      "<td><b>" + total + "</b></td></tr>";
  }
  $("crossTable").innerHTML = html + "</tbody>";
}

function renderCost(s) {
  const weeks = sortedKeys(s.byWeek);
  const weekB = weeks.map((w) => s.byWeek[w]);
  const days = sortedKeys(s.byDay);
  const dayB = days.map((d) => s.byDay[d]);

  // 会话接待分布（按周）：会话数柱 + 人工总时长 / 转人工次数双折线
  drawCombo(
    "weekRecept", "chartWeekRecept", weeks,
    [{ label: "会话数", data: weekB.map((b) => b.total), color: "#6f9bec" }],
    [
      { label: "人工接待总时长（小时）", data: weekB.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f0b64f", axis: "y1" },
      { label: "转人工会话接待次数", data: weekB.map((b) => b.transfer), color: "#a9b1c4", axis: "y1" },
    ],
    { rotate: 0, showStackTotal: false }
  );
  setTotal("totalWeekRecept", "总计：", weekB.reduce((a, b) => a + b.total, 0));

  // 会话时长（按周）：会话性质堆叠 + 单会话平均时长折线
  const natKeys = bucketKeys(weekB, "nat");
  drawCombo(
    "weekDur", "chartWeekDur", weeks,
    natKeys.map((k, i) => ({ label: k, data: weekB.map((b) => b.nat[k] || 0), color: colorFor(COLOR_NATURE, k, i) })),
    [{
      label: "单会话平均时长（分钟）",
      data: weekB.map((b) => (b.durCount ? Number((b.dur / b.durCount / 60).toFixed(2)) : 0)),
      color: "#f2c94c",
      axis: "y1",
    }],
    { rotate: 0 }
  );
  setTotal("totalWeekDur", "人工接待总时长：", Number((weekB.reduce((a, b) => a + b.dur, 0) / 3600).toFixed(1)));

  // 每日人工成本：只看最近 30 天，无人工接待的连续日期合并成一格
  const recentDays = days.slice(-30);
  const recentB = recentDays.map((d) => s.byDay[d]);
  const noManual = (b) => !b || (b.dur === 0 && b.transfer === 0);
  const cz = compressEmptyDays(recentDays, recentB, noManual);

  drawCombo(
    "dayCost", "chartDayCost", cz.labels,
    [{ label: "转人工会话数", data: cz.buckets.map((b) => b.transfer), color: "#c3d7f7" }],
    [
      { label: "人工接待总时长（小时）", data: cz.buckets.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f0b64f", axis: "y1" },
      { label: "单会话平均时长（分钟）", data: cz.buckets.map((b) => (b.durCount ? Number((b.dur / b.durCount / 60).toFixed(1)) : 0)), color: "#ef8f8a", axis: "y1" },
    ],
    { rotate: 60, maxLabels: 40, showStackTotal: false }
  );
  setTotal("totalDayCost", "人工接待总时长：", Number((recentB.reduce((a, b) => a + b.dur, 0) / 3600).toFixed(1)));
  const hint = $("hintDayCost");
  if (hint) {
    hint.textContent = "最近 " + recentDays.length + " 天" +
      (cz.merged > 0 ? "，其中 " + cz.merged + " 个无人工接待的日期已与相邻空档合并" : "");
  }
}

// ============== 周报 ==============

const DOW_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// [0,1,2,3] → 周一~周四；不连续则逐个列出
function sceneCount(pairs, scene) {
  const hit = (pairs || []).find((p) => p[0] === scene);
  return hit ? hit[1] : 0;
}

function dowLabel(dows) {
  if (!dows || !dows.length) return "同期";
  const names = dows.map((d) => DOW_CN[d] || "?");
  const contiguous = dows.every((d, k) => k === 0 || d === dows[k - 1] + 1);
  if (dows.length === 7) return "整周";
  return contiguous && dows.length > 1 ? names[0] + "~" + names[names.length - 1] : names.join("、");
}

function weekLabel(w) {
  return "第 " + Number(w.slice(5)) + " 周（" + w + "）";
}

function delta(cur, prev, unit, invert) {
  if (prev === null || prev === undefined || prev === 0) return "";
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
  const good = invert ? d < 0 : d > 0;
  const sign = d > 0 ? "+" : "";
  return '<span class="dl ' + (good ? "up" : "down") + '">' + sign + Number(d.toFixed(1)) + (unit || "") + "</span>";
}

async function loadWeekly() {
  if (state.weeklyLoaded) return;
  try {
    const json = await api("/api/weekly");
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      $("wkHint").textContent = "周报数据正在构建，稍后重开此页签。";
      return;
    }
    state.weeks = json.weeks || [];
    state.weeklyLoaded = true;

    const sel = $("wkSelect");
    sel.innerHTML = state.weeks.slice().reverse().map((w) =>
      '<option value="' + w.week + '">' + weekLabel(w.week) +
      (w.dayCount < 7 ? "（不完整）" : "") + "</option>"
    ).join("");
    // 默认本周：weeks 里只有有数据的周，所以最后一项就是本周；
    // 本周还没数据时最后一项自然是上周
    sel.value = state.weeks[state.weeks.length - 1].week;
    sel.addEventListener("change", () => renderWeekly(sel.value));
    renderWeekly(sel.value);
  } catch (err) {
    $("wkHint").textContent = "周报加载失败：" + err.message;
  }
}

function renderWeekly(week) {
  const i = state.weeks.findIndex((w) => w.week === week);
  if (i < 0) return;
  const w = state.weeks[i];
  const p = i > 0 ? state.weeks[i - 1] : null;

  $("wkHint").textContent = w.firstDay + " ~ " + w.lastDay + "（" + w.dayCount + " 天）" +
    (w.dayCount < 7 ? " · 本周数据尚不完整" : "") +
    (p ? " · 对比第 " + Number(p.week.slice(5)) + " 周" : "");

  // 一、目标追踪
  const g = w.goals;
  const pg = p ? p.goals : null;
  const rows = [
    {
      name: "操作引导类人工时长占比",
      target: "≤ " + g.guideTarget + "%",
      value: g.guideShare + "%",
      ok: g.guideShare <= g.guideTarget,
      delta: pg ? delta(g.guideShare, pg.guideShare, "pp", true) : "",
      note: "目标把操作引导类问题交给 Jiri，人工时长占比压到 10% 以内",
    },
    ...g.mustHuman.map((m, k) => {
      const prev = pg ? pg.mustHuman[k] : null;
      return {
        name: "单次接待时长中位数 · " + m.label + "（" + m.scene + "）",
        target: "≤ " + m.target + " 分",
        value: m.raw === null ? "—" : Number(m.raw).toFixed(1) + " 分",
        ok: m.value !== null && m.value <= m.target,
        delta: prev && prev.raw !== null && m.raw !== null ? delta(m.raw, prev.raw, " 分", true) : "",
        note: m.receptions ? m.receptions + " 次接待" : "本周无接待",
      };
    }),
  ];
  $("tblGoals").innerHTML =
    '<thead><tr><th>目标</th><th class="num">目标值</th><th class="num">本周</th><th class="num">达成</th><th class="num">环比</th><th>说明</th></tr></thead><tbody>' +
    rows.map((r) =>
      "<tr><td>" + r.name + '</td><td class="num">' + r.target + "</td>" +
      '<td class="num strong">' + r.value + "</td>" +
      '<td class="num"><span class="pill ' + (r.ok ? "good" : "bad") + '">' + (r.ok ? "达成" : "未达成") + "</span></td>" +
      '<td class="num">' + (r.delta || "—") + "</td>" +
      '<td class="dim">' + r.note + "</td></tr>"
    ).join("") + "</tbody>";

  // 二、周度接待概览：只看到所选周为止的最近 5 周，底部附同期对齐的环比
  const recent = state.weeks.slice(Math.max(0, i - 4), i + 1);
  const cmp = w.compare;
  const scope = cmp ? dowLabel(cmp.dows) : "";
  const num = (v) => '<td class="num">' + v + "</td>";
  // 单个百分比药丸
  const pct1 = (cur, prev, invert) => {
    if (prev === null || prev === undefined || prev === 0) return '<span class="dl flat">—</span>';
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
    const good = invert ? d < 0 : d > 0;
    return '<span class="dl ' + (good ? "up" : "down") + '">' + (d > 0 ? "+" : "") + d.toFixed(1) + "%</span>";
  };
  const ratio = (cur, prev, suffix, invert) => num(pct1(cur, prev, invert));
  // 环比与同比合并成一格，省掉两行同期原始值
  const dual = (cur, prev, yoy, invert) =>
    '<td class="num dual">' +
    '<span class="dl-row"><i>环</i>' + pct1(cur, prev, invert) + "</span>" +
    (yoy === null || yoy === undefined ? "" :
      '<span class="dl-row"><i>同</i>' + pct1(cur, yoy, invert) + "</span>") +
    "</td>";

  let html =
    '<thead><tr><th>周</th><th class="num">会话总量</th><th class="num">对话人数</th><th class="num">人均会话</th>' +
    '<th class="num">AI 独立接待 / 独立率</th><th class="num">人工在线 / 占比</th><th class="num">填表人</th><th class="num">有效会话</th></tr></thead><tbody>' +
    recent.slice().reverse().map((x) =>
      "<tr" + (x.week === week ? ' class="hl"' : "") + "><td>第 " + Number(x.week.slice(5)) + " 周</td>" +
      num(x.total) + num(x.users) + num(x.perUser) +
      num(x.aiOnly + " / " + x.aiRate + "%") +
      num(x.manualOnline + " / " + x.manualRate + "%") +
      num(x.formFillers) + num(x.productSessions) + "</tr>"
    ).join("");

  if (cmp) {
    const p2 = cmp.prev;
    const y2 = cmp.yoy || null;
    const yNo = cmp.yoyWeek ? Number(cmp.yoyWeek.slice(5)) : null;
    const g = (k) => (y2 ? y2[k] : null);
    html +=
      '<tr class="sum"><td>环比 / 同比<span class="cmp-note">环＝上周同期（' + scope + "）" +
      (yNo ? " · 同＝第 " + yNo + " 周同期" : "") + "</span></td>" +
      dual(w.total, p2.total, g("total")) +
      dual(w.users, p2.users, g("users")) +
      dual(w.perUser, p2.perUser, g("perUser")) +
      dual(w.aiRate, p2.aiRate, g("aiRate")) +
      dual(w.manualRate, p2.manualRate, g("manualRate"), true) +
      dual(w.formFillers, p2.formFillers, g("formFillers")) +
      dual(w.productSessions, p2.productSessions, g("productSessions")) + "</tr>";
  }
  $("tblOverview").innerHTML = html + "</tbody>";

  // 三、人工接待现状：每个口径都给本周 / 上周同期 / 环比 / 4 周前同期 / 同比
  const d1 = (v) => Number(v).toFixed(1);
  const yoyNo = cmp && cmp.yoyWeek ? Number(cmp.yoyWeek.slice(5)) : null;

  const statCells = (g) =>
    num(g.receptions) + num(d1(g.durHours) + " h") + num(d1(g.medianMin) + " 分") +
    num(d1(g.avgMin) + " 分") + num(g.sessions) + num(g.users);

  const groupRows = (label, key) => {
    let out = "<tr><td><b>" + label + "</b></td>" + statCells(w[key]) + "</tr>";
    if (!cmp) return out;
    const a = w[key];
    const b = cmp.prev[key];
    const c = cmp.yoy ? cmp.yoy[key] : null;
    const g = (k) => (c ? c[k] : null);
    out += '<tr class="sum"><td>' + label + " · 环比 / 同比" +
      '<span class="cmp-note">环＝上周同期（' + scope + "）" +
      (yoyNo ? " · 同＝第 " + yoyNo + " 周同期" : "") + "</span></td>" +
      dual(a.receptions, b.receptions, g("receptions")) +
      dual(a.durHours, b.durHours, g("durHours")) +
      dual(a.medianMin, b.medianMin, g("medianMin"), true) +
      dual(a.avgMin, b.avgMin, g("avgMin"), true) +
      dual(a.sessions, b.sessions, g("sessions")) +
      dual(a.users, b.users, g("users")) + "</tr>";
    return out;
  };

  $("tblManual").innerHTML =
    '<thead><tr><th>口径</th><th class="num">接待次数</th><th class="num">总工时</th>' +
    '<th class="num">单次中位</th><th class="num">单次平均</th><th class="num">会话数</th>' +
    '<th class="num">去重用户</th></tr></thead><tbody>' +
    groupRows("有效人工", "eff") + groupRows("全部仅人工", "allManual") + "</tbody>";

  const prevEff = cmp ? cmp.prev.eff : null;
  $("manualNote").innerHTML =
    "有效人工 <b>" + w.eff.sessions + "</b> 场会话（去重用户 " + w.eff.users + " 人）/ <b>" +
    w.eff.receptions + "</b> 次接待，总工时 <b>" + w.eff.durHours + " h</b>" +
    (prevEff ? "（上周同期 " + prevEff.durHours + " h，" +
      (w.eff.durHours >= prevEff.durHours ? "+" : "") +
      Number((w.eff.durHours - prevEff.durHours).toFixed(1)) + " h）" : "") + "。<br>" +
    "不愿和 Jiri 沟通率 <b>" + w.directTransfer + " / " + w.eff.sessions + " = " + w.directRate + "%</b>" +
    (cmp ? "（上周同期 " + cmp.prev.directTransfer + " / " + cmp.prev.eff.sessions + "）" : "") +
    " —— 有效人工里「直接转」的场次占比。<br>" +
    '<span class="dim-note">口径：有效人工 = 处理状态「仅人工」且会话性质「有效」；接待次数取「转人工会话接待次数」' +
    '（表单里「人工接待次数」两个字段全为空）；单次中位 = 每场「时长 ÷ 接待次数」的中位数。' +
    '环比对比上周同期，同比对比 4 周前同期，都按相同星期对齐。</span>';

  // 四、有效人工场景 × 工作量
  const sceneVal = (src, scene, field) => {
    const hit = src && src.scenes ? src.scenes[scene] : null;
    return hit ? hit[field] : null;
  };
  $("tblScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">接待次数</th><th class="num">总时长（分）</th>' +
    '<th class="num">占总时长</th><th class="num">单次中位</th><th class="num">单次平均</th>' +
    '<th class="num">时长环比</th><th class="num">时长同比</th></tr></thead><tbody>' +
    w.scenes.map((x) => {
      const isGuide = x.scene === "操作引导/功能咨询";
      return "<tr" + (isGuide ? ' class="warn-row"' : "") + "><td>" + x.scene + "</td>" +
        num(x.receptions) + num(x.durMin) +
        '<td class="num strong">' + x.share + "%" + (isGuide ? "（目标 ≤ 10%）" : "") + "</td>" +
        num(Number(x.medianMin).toFixed(1)) + num(Number(x.avgMin).toFixed(1)) +
        (cmp ? ratio(x.durMin, sceneVal(cmp.prev, x.scene, "durMin")) : num("—")) +
        (cmp && cmp.yoy ? ratio(x.durMin, sceneVal(cmp.yoy, x.scene, "durMin")) : num("—")) + "</tr>";
    }).join("") +
    '<tr class="sum"><td>合计</td>' + num(w.eff.receptions) + num(w.eff.durMin) +
    num("100%") + num(Number(w.eff.medianMin).toFixed(1)) + num(Number(w.eff.avgMin).toFixed(1)) +
    (cmp ? ratio(w.eff.durMin, cmp.prev.eff.durMin) : num("—")) +
    (cmp && cmp.yoy ? ratio(w.eff.durMin, cmp.yoy.eff.durMin) : num("—")) + "</tr></tbody>";

  // 六、业务分型 × 建表转化（从有标注的那周起才有数据）
  const bizBlock = $("blockBiz");
  const bizRows = w.bizTypes || [];
  bizBlock.hidden = bizRows.length === 0;
  if (bizRows.length) {
    const findBiz = (src, type) => (src && src.bizTypes ? src.bizTypes.find((x) => x.type === type) : null);
    const bizCell = (x, field, prevRow, yoyRow, suffix) =>
      '<td class="num dual"><span class="dl-strong">' + x[field] + (suffix || "") + "</span>" +
      '<span class="dl-row"><i>环</i>' + pct1(x[field], prevRow ? prevRow[field] : null) + "</span>" +
      (cmp && cmp.yoy ? '<span class="dl-row"><i>同</i>' + pct1(x[field], yoyRow ? yoyRow[field] : null) + "</span>" : "") +
      "</td>";

    $("tblBiz").innerHTML =
      '<thead><tr><th>业务分型</th><th class="num">会话数</th><th class="num">建表率</th>' +
      '<th class="num">对口</th><th class="num">建完收到数据</th><th class="num">Jiri 代建（MCP）</th>' +
      "</tr></thead><tbody>" +
      bizRows.map((x) => {
        const p = cmp ? findBiz(cmp.prev, x.type) : null;
        const y = cmp && cmp.yoy ? findBiz(cmp.yoy, x.type) : null;
        return "<tr><td>" + x.type + "</td>" +
          bizCell(x, "sessions", p, y) +
          bizCell(x, "builtRate", p, y, "%") +
          bizCell(x, "onTargetRate", p, y, "%") +
          bizCell(x, "gotDataRate", p, y, "%") +
          bizCell(x, "jiriBuiltRate", p, y, "%") + "</tr>";
      }).join("") +
      (() => {
        const sum = (k) => bizRows.reduce((a, x) => a + x[k], 0);
        const n = sum("sessions");
        const r = (k) => (n ? ((sum(k) / n) * 100).toFixed(1) : 0);
        return '<tr class="sum"><td>合计</td>' + num(n) + num(r("built") + "%") +
          num(r("onTarget") + "%") + num(r("gotData") + "%") + num(r("jiriBuilt") + "%") + "</tr>";
      })() + "</tbody>";

    const pend = bizRows.reduce((a, x) => a + x.pending, 0);
    $("bizNote").innerHTML =
      "口径：分母是该分型的会话数；<b>建表率</b> = 「对口建表」标了是或否（都表示建了表，只是对不对口）；" +
      "<b>对口</b> = 「对口建表 = 是」；<b>建完收到数据</b> = 「对口表单收数据 = 是」；" +
      "<b>Jiri 代建</b> = 「Jiri代建表单 = 是」。<br>" +
      "「只跟金数据打交道」「看不出用途」不是建表需求，未计入。" +
      (pend ? " 当前还有 <b>" + pend + "</b> 条「对口建表」标记为待定（7 天窗口未到或待复核），会随标注推进变化。" : "") +
      '<br><span class="dim-note">环比对比上周同期、同比对比 4 周前同期，都按相同星期对齐。</span>';
  }

  // 五、仅 Jiri 有效场景
  $("tblJiriScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">场次</th><th class="num">占比</th>' +
    '<th class="num">环比</th><th class="num">同比</th></tr></thead><tbody>' +
    w.jiriScenes.map((x) =>
      "<tr><td>" + x[0] + "</td>" + num(x[1]) +
      num((w.jiriSceneTotal ? ((x[1] / w.jiriSceneTotal) * 100).toFixed(1) : 0) + "%") +
      (cmp ? ratio(x[1], (cmp.prev.jiriScenes || {})[x[0]] || 0) : num("—")) +
      (cmp && cmp.yoy ? ratio(x[1], (cmp.yoy.jiriScenes || {})[x[0]] || 0) : num("—")) + "</tr>"
    ).join("") +
    '<tr class="sum"><td>合计</td>' + num(w.jiriSceneTotal) + num("100%") +
    (cmp ? ratio(w.jiriSceneTotal, cmp.prev.jiriSceneTotal) : num("—")) +
    (cmp && cmp.yoy ? ratio(w.jiriSceneTotal, cmp.yoy.jiriSceneTotal) : num("—")) + "</tr></tbody>";
}

// ============== 交互 ==============

async function hardRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const btn = $("refreshBtn");
  btn.disabled = true;
  btn.textContent = "拉取中…";
  banner("正在后台从金数据全量拉取，约需 20 秒，完成后自动刷新页面数据。", "info");
  try {
    const json = await api("/api/refresh", { method: "POST" });
    if (!json.success) throw new Error(json.error || "未知错误");
    await waitForRefresh();
  } catch (err) {
    banner("刷新失败：" + err.message);
  } finally {
    state.refreshing = false;
    btn.disabled = false;
    btn.textContent = "重新拉取数据";
  }
}

// 等后台刷新落地（最多 90 秒）
async function waitForRefresh() {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const meta = (await api("/api/status")).meta || {};
      if (meta.status === "ok") {
        banner("");
        await loadDashboard();
        return;
      }
      if (meta.status === "error") {
        banner("数据拉取失败：" + (meta.error || "未知错误"));
        return;
      }
    } catch (e) { /* 忽略 */ }
  }
  banner("拉取仍未完成，请稍后刷新页面查看。", "info");
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("panel-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "weekly") loadWeekly();
      // 切回图表页签时重绘，避免 canvas 在隐藏状态下算错尺寸
      else if (state.stats) requestAnimationFrame(() => renderCharts(state.stats));
    });
  });
}

function initActions() {
  $("refreshBtn").addEventListener("click", hardRefresh);

  const out = $("logoutBtn");
  if (out) out.addEventListener("click", async () => {
    out.disabled = true;
    out.textContent = "退出中…";
    try { await fetch(BASE + "/api/logout", { method: "POST" }); } catch (e) { /* 忽略 */ }
    // replace + 时间戳：不留历史记录，也绕开缓存
    location.replace(BASE + "/?t=" + Date.now());
  });

  // 维度下拉 + 质检状态：改动即重算
  Object.keys(DIM_SELECTS).forEach((id) => {
    $(id).addEventListener("change", reload);
  });

  $("fRange").addEventListener("change", () => { applyRangePreset(); reload(); });
  $("fFrom").addEventListener("change", reload);
  $("fTo").addEventListener("change", reload);

  $("resetBtn").addEventListener("click", () => {
    ["fRange", ...Object.keys(DIM_SELECTS)].forEach((id) => { $(id).value = ""; });
    applyRangePreset();
    reload();
  });

  applyRangePreset();
}

const T0 = performance.now();

initTabs();
initActions();
renderSkeleton();
loadWeekly();

loadDashboard().then(() => {
  try {
    // 把首屏耗时写在页脚，方便定位慢在网络还是接口
    const parts = ["数据 " + Math.round(performance.now() - T0) + " ms"];
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) parts.push("页面 " + Math.round(nav.responseEnd - nav.startTime) + " ms");
    const chart = performance.getEntriesByType("resource").find((r) => r.name.includes("chart.min.js"));
    if (chart) parts.push("Chart.js " + Math.round(chart.duration) + " ms");
    const f = document.querySelector(".footer p");
    if (f) f.textContent = "Powered by WDL · " + parts.join(" · ");
  } catch (e) { /* 统计失败不影响看板 */ }
});
