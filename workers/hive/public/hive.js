// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

// Figma Widget 色板：紫色作为系统主色，粉 / 琥珀 / 青绿承担数据分组。
const PALETTE = [
  "#806dfa", "#00c8a9", "#ffb65c", "#ff6689", "#00d9d4",
  "#5e8ef2", "#b594ff", "#ff8dac", "#77ddd3", "#e5c77f",
  "#9289e9", "#70bdf7", "#d3b1ef", "#ffbe9d", "#a9afc7",
];

const state = { stats: null, facets: null, refreshing: false, polling: false, weeks: [], weeklyLoaded: false, latestDay: null, loop: null, loopLoaded: false, hourlyDay: null, manualBusyMode: "active" };
const charts = {};

// 筛选项 → 接口参数名；选项值来自首次全量结果，筛选后不再改动
const DIM_SELECTS = {
  fDevice: { dim: "device", placeholder: "全部设备" },
  fScene: { dim: "scene", placeholder: "全部业务场景" },
  fNature: { dim: "nature", placeholder: "全部会话性质" },
};

// ============== 工具 ==============

function $(id) { return document.getElementById(id); }

function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

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
  "有效": "#806dfa", "填表人": "#00c8a9", "无效": "#77ddd3",
  "转接未应答": "#ff8dac", "电话引导·发链接图片": "#5e8ef2",
  "内部测试": "#f3d07a", "未标记": "#d3d8e6",
};
const COLOR_CHANNEL = {
  gd_next: "#ffb65c", gd4: "#d2aa79", gd_app: "#b594ff",
  wechat_miniapp: "#00c8a9", wechat_official: "#ff6689",
  trade_weixin_app: "#5e8ef2", "未知": "#bcc2d1",
};
const COLOR_DEVICE = { pc: "#5e8ef2", mobile: "#00c8a9", "未知": "#d3d8e6" };

function colorFor(map, key, i) {
  return map[key] || PALETTE[i % PALETTE.length];
}

// hover 时压暗同一支色，保留「鼠标在这根柱子上」的反馈
function darken(hex, ratio = .82) {
  const n = parseInt(hex.slice(1), 16);
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.round(v * ratio)).toString(16).padStart(2, "0"))
    .join("");
}

// 仅柱线组合图使用：与普通柱图共享同一组三主题色。
const COMBO_BAR_TONES = ["#8676FF", "#FF708B", "#383874"];
const COMBO_COOL_LINES = ["#5554ed", "#7169f5", "#8d5be8"];
const COMBO_WARM_LINES = ["#e05091", "#c950c8"];

function comboBarTone(index, total) {
  if (total === 1) return "#8676FF";
  return COMBO_BAR_TONES[index % COMBO_BAR_TONES.length];
}

function comboBarFill(index, total) {
  return comboBarTone(index, total);
}

function comboLineTone(source, index) {
  const hex = String(source || "").toLowerCase();
  const warm = hex === "#ffb65c" || hex === "#ff6689" || hex === "#ff8dac";
  return warm
    ? COMBO_WARM_LINES[index % COMBO_WARM_LINES.length]
    : COMBO_COOL_LINES[index % COMBO_COOL_LINES.length];
}

// 折线用的横向渐变（蓝 → 紫 → 粉），面积用纵向渐隐
const LINE_GRADIENT = ["#00d9d4", "#806dfa", "#b594ff", "#ff6689"];

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
    Chart.register(valueLabels, centerText, hoverGuide, ribbonArcs, multiRingArcs, progressRing, refLine);
    Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = "#8f8ca9";
    Chart.defaults.borderColor = "#eeeaf6";
    Chart.defaults.plugins.tooltip.backgroundColor = "#393878";
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
// 镜像轴的上下界要自己定，Chart.js 不会再帮忙取整 —— 不处理就会出现 194.4 这种刻度
function cleanScales(opts) {
  const o = opts || {};
  return {
    x: {
      stacked: !!o.stacked,
      // v4 起轴线归 border 管，grid.drawBorder 已被移除，别再往 grid 里塞
      grid: { display: false },
      border: { display: false },
      ticks: { maxRotation: o.rotate ?? 0, autoSkip: o.autoSkip !== false, maxTicksLimit: o.maxTicks, padding: 6 },
    },
    y: {
      stacked: !!o.stacked,
      beginAtZero: true,
      grid: { color: "#f2f4fa", drawTicks: false },
      border: { display: false },
      ticks: { padding: 10, maxTicksLimit: 6 },
    },
  };
}

// ============== 环形图（一律同心进度环） ==============

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
  // 只要不止一类就走独立轨道。不按类别数切换画法 —— 同一行里一张单环一张同心环，
  // 看着就是两套东西。类别多时靠 cutout 保证中心指标不被最里面那圈压住。
  const isMultiRing = shown.length >= 2;
  // 多环必须渲染在正方形画布内；否则 CSS 压缩高度后会把数学圆拉成椭圆。
  ctx.classList.toggle("multi-ring-chart", isMultiRing);
  const datasets = isMultiRing
    ? shown.map((p, i) => ({
        // 每一圈都是该类别占全部的准确比例，灰色部分是同一总量的剩余部分。
        // 因此三类以上不再被挤在一条彩虹单环里，也不会改变各类别数值。
        label: p[0],
        data: [p[1], Math.max(0, sum - p[1])],
        backgroundColor: [colors[i], "#edf0f8"],
        borderWidth: 0,
        borderRadius: 0,
        spacing: 0,
        hoverOffset: 0,
      }))
    : [{
        data: shown.map((p) => p[1]),
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 0,
        spacing: 0,
        hoverOffset: 0,
        hoverBorderWidth: 0,
      }];

  charts[key] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: isMultiRing ? ["类别占比", "剩余比例"] : shown.map((p) => p[0]),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: isMultiRing,
      aspectRatio: isMultiRing ? 1 : undefined,
      // 多环由 multiRingArcs 自绘 270° 的「轨道 + 进度弧」。
      // Chart.js 仅保留透明命中区；不能直接设 circumference，否则每个 dataset
      // 会把 270° 再按数据切分，变成一组短弧。
      cutout: isMultiRing ? "42%" : "71%",
      // 环始终占完整方形区域；左上数据块仅放在 270° 缺口内，不能挤压环本身。
      layout: { padding: { top: 6, bottom: 6, left: 6, right: 6 } },
      // 同心环别做旋转入场：动画中途每圈都只画出一小段，看着像一把散开的短弧，
      // 切页签时又会重放一次，很容易被当成渲染坏了。
      animation: isMultiRing ? { animateRotate: false } : undefined,
      plugins: {
        valueLabels: { enabled: false },
        ribbonArcs: { enabled: !isMultiRing },
        multiRingArcs: {
          enabled: isMultiRing,
          items: shown.map((p, i) => ({ label: p[0], value: p[1], color: colors[i] })),
          total: sum,
        },
        centerText: isMultiRing ? { enabled: false } : {
          value: top && sum ? ((top[1] / sum) * 100).toFixed(1) + "%" : "—",
          label: top ? top[0] : "",
        },
        legend: {
          display: !isMultiRing,
          position: "bottom",
          labels: {
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 12,
            font: { size: 12 },
            generateLabels(chart) {
              return shown.map((p, i) => ({
                text: p[0] + "  " + fmtNum(p[1]),
                fillStyle: colors[i],
                strokeStyle: colors[i],
                lineWidth: 0,
                pointStyle: "circle",
                hidden: isMultiRing ? !chart.isDatasetVisible(i) : !chart.getDataVisibility(i),
                datasetIndex: isMultiRing ? i : undefined,
                index: isMultiRing ? undefined : i,
              }));
            },
          },
          onClick(e, item, legend) {
            const chart = legend.chart;
            if (isMultiRing) {
              const visible = chart.isDatasetVisible(item.datasetIndex);
              chart.setDatasetVisibility(item.datasetIndex, !visible);
            } else chart.toggleDataVisibility(item.index);
            chart.update();
          },
        },
        tooltip: {
          enabled: !isMultiRing,
          displayColors: true,
          callbacks: {
            title: (items) => isMultiRing ? shown[items[0].datasetIndex]?.[0] : items[0].label,
            label(c) {
              const value = isMultiRing ? shown[c.datasetIndex]?.[1] : c.parsed;
              return value + "（" + (sum ? ((value / sum) * 100).toFixed(1) : 0) + "%）";
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
    ctx.shadowColor = "rgba(57, 56, 120, .17)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;

    // 圆头会在两端各多探出「半个线宽」那么长的弧。所以线宽要先按本段可用跨度定下来，
    // 端点再按这个线宽内收，整颗药丸才刚好落在自己的扇区里。
    // （旧写法内收的是半个圆头，相邻两段必定重叠半个环厚 —— 段数一多就糊成一堆叠起来的胶囊。）
    const gap = 0.028;                    // 段间留 1.6° 左右的缝，边界看得清
    const minWidth = width * 0.34;        // 再小的占比也保留可见的粗度

    for (let i = 0; i < meta.data.length; i++) {
      if (!chart.getDataVisibility(i)) continue;
      const arc = meta.data[i];
      if (!arc) continue;
      const span = arc.endAngle - arc.startAngle;
      if (span <= 0) continue;
      const hot = active.includes(i);
      // 一颗两端圆头、长度为 0 的药丸本身就占 lw/radius 的弧，跨度不够就把它收细
      const lw = Math.max(minWidth, Math.min(width, Math.max(0, span - gap) * radius));
      const cap = (lw / 2) / radius;
      const from = arc.startAngle + cap + gap / 2;
      const to = arc.endAngle - cap - gap / 2;
      const mid = (arc.startAngle + arc.endAngle) / 2;
      ctx.lineWidth = lw;
      ctx.strokeStyle = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor;
      ctx.beginPath();
      // 跨度太小时退化成一个圆点：留 1e-3 的长度，否则 canvas 不画零长度子路径
      ctx.arc(cx, cy, radius, Math.min(from, mid), Math.max(to, mid + 1e-3));
      ctx.stroke();
      // hover 只加外发光，不再加粗 —— 加粗会让药丸探出自己的扇区
      if (hot) {
        ctx.save();
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 0;
        ctx.shadowColor = ctx.strokeStyle;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  },
};

// 多类别环图：用同心「270° 轨道 + 进度弧」表达各类别占比。
// 图例固定画在左上，进度环放在右下；Chart.js 保留透明的扇区命中区，
// 因此 tooltip 仍可逐项交互。
const multiRingArcs = {
  id: "multiRingArcs",
  beforeDatasetDraw(chart) {
    if (!chart.options.plugins?.multiRingArcs?.enabled) return;
    chart.ctx.save();
    chart.ctx.globalAlpha = 0;
  },
  afterDatasetDraw(chart) {
    if (!chart.options.plugins?.multiRingArcs?.enabled) return;
    chart.ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins?.multiRingArcs;
    if (!o?.enabled) return;
    const { ctx } = chart;
    const items = o.items || [];
    const total = Number(o.total) || 0;
    const start = -Math.PI / 2; // 从正上方起笔，270° 缺口正好落在左上
    const sweep = Math.PI * 1.5;
    // 以画布里最大的正方形为基准：整个圆环区域不被图例挤压。
    // 圆心略向右下移动，让起点竖线正好成为左上数据块的右对齐线。
    const side = Math.min(chart.width, chart.height);
    const squareLeft = (chart.width - side) / 2;
    const squareTop = (chart.height - side) / 2;
    const cx = squareLeft + side * .52;
    const cy = squareTop + side * .52;
    const count = items.length;
    // 外圈连同圆头和阴影都留在安全边距内，不能被画布底边裁断。
    const outerRadius = side * .44;
    // 环宽、文字高度与环距都是全站固定规格，不因卡片里的类别数而变化。
    // 环数只会向中心延伸，不能让某张卡显得更粗、字号更大或环距更松。
    const textHeight = 16;
    const ringWidth = 16;
    const ringGap = 10;
    const ringStep = ringWidth + ringGap;
    // 每个对象只有一个起笔锚点：文字、颜色标记和圆环都从这里读取位置。
    // 禁止再按“第几行文字”另行计算 y，避免环数变化后出现错位。
    const rings = items.map((item, i) => ({
      radius: outerRadius - ringStep * i,
      startX: cx - ringWidth / 2,
      startY: cy - (outerRadius - ringStep * i),
    }));
    // 起笔是圆头：可见边界比几何起点 cx 向左多出半个线宽。
    // 文本组与圆头之间留一个字高；每条文本的纵向位置另按其对应环的起笔高度计算。
    const ringStartX = rings[0]?.startX || cx - ringWidth / 2;
    const legendRight = ringStartX - textHeight;

    ctx.save();
    ctx.lineCap = "round";

    // 左上：数据块的右边界（百分比）严格对齐最外环圆头的可见起点。
    // 这里不使用 Chart.js 的底部 legend，让文本只占 270° 缺口，不缩小圆环。
    items.forEach((item, i) => {
      // 文字与对应进度环共用同一个 startY。
      const y = rings[i].startY;
      const percent = total ? (Number(item.value) / total) * 100 : 0;
      const label = String(item.label) + "： ";
      const value = percent.toFixed(1) + "%";
      ctx.font = '500 ' + textHeight + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const labelWidth = ctx.measureText(label).width;
      ctx.font = '700 ' + textHeight + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const valueWidth = ctx.measureText(value).width;
      const textLeft = legendRight - labelWidth - valueWidth;
      ctx.beginPath();
      ctx.fillStyle = item.color;
      ctx.arc(textLeft - textHeight * .82, y - 1, textHeight * .28, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '500 ' + textHeight + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillStyle = "#727995";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, textLeft, y);
      ctx.font = '700 ' + textHeight + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillStyle = "#2b3153";
      ctx.fillText(value, textLeft + labelWidth, y);
    });

    chart.data.datasets.forEach((dataset, i) => {
      if (!chart.isDatasetVisible(i)) return;
      const radius = rings[i]?.radius;
      if (!Number.isFinite(radius)) return;
      const value = Number(dataset.data[0]) || 0;
      const rest = Number(dataset.data[1]) || 0;
      const progress = value + rest ? Math.max(0, Math.min(1, value / (value + rest))) : 0;
      const end = start + sweep;
      const progressEnd = start + sweep * progress;
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "#edf0f8";
      ctx.lineWidth = ringWidth;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, end);
      ctx.stroke();
      if (progress > 0) {
        const hot = (chart.tooltip?.getActiveElements?.() || []).some((active) => active.datasetIndex === i);
        ctx.shadowColor = hot ? dataset.backgroundColor[0] : "rgba(57, 56, 120, .13)";
        ctx.shadowBlur = hot ? 14 : 7;
        ctx.shadowOffsetY = hot ? 0 : 3;
        ctx.strokeStyle = dataset.backgroundColor[0];
        ctx.beginPath();
        ctx.arc(cx, cy, radius, start, progressEnd);
        ctx.stroke();
      }
    });
    ctx.restore();
  },
};

// 单指标进度环：用于「某一个目标分类占比」，避免把不需比较的其他分类画成多环。
const progressRing = {
  id: "progressRing",
  beforeDatasetDraw(chart) {
    if (!chart.options.plugins?.progressRing?.enabled) return;
    chart.ctx.save();
    chart.ctx.globalAlpha = 0;
  },
  afterDatasetDraw(chart) {
    if (!chart.options.plugins?.progressRing?.enabled) return;
    chart.ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins?.progressRing;
    if (!o?.enabled) return;
    const { ctx } = chart;
    const side = Math.min(chart.width, chart.height);
    const cx = (chart.width - side) / 2 + side / 2;
    const cy = (chart.height - side) / 2 + side / 2;
    const value = Math.max(0, Number(o.value) || 0);
    const total = Math.max(0, Number(o.total) || 0);
    const ratio = total ? Math.min(1, value / total) : 0;
    // 半圆仪表盘：从左向右沿上半圆推进，底部留给指标文字。
    const start = Math.PI;
    const sweep = Math.PI;
    const radius = side * .39;
    const width = Math.max(16, Math.min(28, side * .075));
    const percent = (ratio * 100).toFixed(1) + "%";

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = width;
    ctx.strokeStyle = "#e9edf7";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + sweep);
    ctx.stroke();
    if (ratio > 0) {
      ctx.strokeStyle = o.color || "#8676FF";
      ctx.shadowColor = "rgba(86, 80, 237, .16)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, start, start + sweep * ratio);
      ctx.stroke();
    }
    ctx.shadowColor = "transparent";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#858ba7";
    ctx.font = '600 ' + Math.max(12, Math.min(15, side * .038)) + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(o.label || "占比", cx, cy - side * .085);
    ctx.fillStyle = "#303660";
    ctx.font = '750 ' + Math.max(36, Math.min(56, side * .15)) + 'px -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
    ctx.fillText(percent, cx, cy + side * .035);
    ctx.fillStyle = "#858ba7";
    ctx.font = '500 ' + Math.max(11, Math.min(14, side * .034)) + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(fmtNum(value) + " / " + fmtNum(total) + " 会话", cx, cy + side * .16);
    ctx.restore();
  },
};

function drawProgressRing(key, canvasId, opts) {
  if (!chartReady()) return;
  const ctx = $(canvasId);
  if (!ctx) return;
  destroyChart(key);
  ctx.classList.add("progress-ring-chart");
  const o = opts || {};
  charts[key] = new Chart(ctx, {
    type: "doughnut",
    data: { labels: [o.label || "占比", "其余"], datasets: [{ data: [o.value || 0, Math.max(0, (o.total || 0) - (o.value || 0))], backgroundColor: [o.color || "#8676FF", "#e9edf7"], borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: true, aspectRatio: 2,
      animation: { animateRotate: false },
      plugins: {
        legend: { display: false }, valueLabels: { enabled: false }, centerText: { enabled: false }, ribbonArcs: { enabled: false }, multiRingArcs: { enabled: false },
        progressRing: { enabled: true, label: o.label, value: o.value, total: o.total, color: o.color },
        tooltip: { callbacks: { label: () => fmtNum(o.value || 0) + " / " + fmtNum(o.total || 0) + " 会话" } },
      },
    },
  });
}

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
    ctx.fillStyle = "#393878";
    ctx.font = '750 25px -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
    ctx.fillText(o.value, arc.x, arc.y + 2);
    if (o.label) {
      ctx.fillStyle = "#9995b5";
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.fillText(o.label, arc.x, arc.y + 22);
    }
    ctx.restore();
  },
};

// ============== 条形图（参考：胶囊条 + 末端数值 + 双色交替） ==============

const BAR_THREE_COLORS = ["#8676FF", "#FF708B", "#383874"];

function drawBar(key, canvasId, pairs, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;

  // 所有普通柱状图统一只轮换三色，不再引入第四种橙色。
  const alt = BAR_THREE_COLORS;
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
        backgroundColor: (c) => areaGradient(c.chart, "#806dfa"),
        borderWidth: 3,
        fill: true,
        tension: .42,
        pointRadius: 3,
        pointBackgroundColor: "#fff",
        pointBorderColor: "#806dfa",
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

// 竖向参考线（业务闭环图里标整体水平）
const refLine = {
  id: "refLine",
  afterDatasetsDraw(chart) {
    const o = chart.options.plugins?.refLine;
    if (!o || o.value === null || o.value === undefined) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(o.value);
    if (!isFinite(x)) return;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = o.color || "#8b90a7";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    if (o.label) {
      ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif';
      ctx.fillStyle = o.color || "#8b90a7";
      ctx.textAlign = x > (chartArea.left + chartArea.right) / 2 ? "right" : "left";
      ctx.fillText(o.label, x + (ctx.textAlign === "right" ? -6 : 6), chartArea.top + 12);
    }
    ctx.restore();
  },
};

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

// 柱线组合图的图例/悬浮指标统一语义：柱是方块，折线是圆点。
function comboDatasetColor(dataset, index) {
  const source = dataset.type === "line" ? dataset.borderColor : dataset.backgroundColor;
  return Array.isArray(source) ? source[index] || source[0] : source || "#806dfa";
}

function comboLegend() {
  return {
    position: "top",
    align: "start",
    labels: {
      usePointStyle: true,
      boxWidth: 9,
      boxHeight: 9,
      padding: 14,
      font: { size: 12 },
      generateLabels(chart) {
        return Chart.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
          const dataset = chart.data.datasets[item.datasetIndex] || {};
          const color = comboDatasetColor(dataset, item.index);
          const isLine = dataset.type === "line";
          return {
            ...item,
            fillStyle: color,
            strokeStyle: color,
            lineWidth: isLine ? 2 : 0,
            pointStyle: isLine ? "circle" : "rect",
          };
        });
      },
    },
  };
}

function glassTooltip(context) {
  const { chart, tooltip } = context;
  let el = document.getElementById("hive-glass-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "hive-glass-tooltip";
    el.className = "chart-glass-tooltip";
    document.body.appendChild(el);
  }
  if (!tooltip || tooltip.opacity === 0) {
    el.classList.remove("visible");
    return;
  }

  el.replaceChildren();
  const title = tooltip.title?.[0];
  if (title) {
    const titleEl = document.createElement("div");
    titleEl.className = "chart-glass-tooltip-title";
    titleEl.textContent = title;
    el.appendChild(titleEl);
  }
  (tooltip.dataPoints || []).forEach((point) => {
    const row = document.createElement("div");
    row.className = "chart-glass-tooltip-row";
    const marker = document.createElement("span");
    marker.className = "chart-glass-tooltip-marker " + (point.dataset.type === "line" ? "is-line" : "is-bar");
    marker.style.backgroundColor = comboDatasetColor(point.dataset, point.dataIndex);
    const text = document.createElement("span");
    text.textContent = point.dataset.label + "：" + point.formattedValue;
    row.append(marker, text);
    el.appendChild(row);
  });
  const notes = tooltip.afterBody || [];
  if (notes.length) {
    const note = document.createElement("div");
    note.className = "chart-glass-tooltip-note";
    note.textContent = notes.join(" ");
    el.appendChild(note);
  }

  // 先在不可见状态下完成定位，避免首次悬停时提示框从旧位置滑入。
  el.classList.remove("visible");
  const canvasBox = chart.canvas.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const anchorX = canvasBox.left + tooltip.caretX;
  const anchorY = canvasBox.top + tooltip.caretY;
  let left = anchorX + 14;
  if (left + box.width > window.innerWidth - 12) left = anchorX - box.width - 14;
  left = Math.min(Math.max(12, left), window.innerWidth - box.width - 12);
  let top = anchorY - box.height - 14;
  if (top < 12) top = anchorY + 14;
  top = Math.min(Math.max(12, top), window.innerHeight - box.height - 12);
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.classList.add("visible");
}

function comboTooltip(extraCallbacks) {
  return {
    enabled: false,
    displayColors: false,
    usePointStyle: true,
    position: "nearest",
    external: glassTooltip,
    callbacks: {
      labelColor(context) {
        const color = comboDatasetColor(context.dataset, context.dataIndex);
        return { backgroundColor: color, borderColor: color, borderWidth: context.dataset.type === "line" ? 2 : 0 };
      },
      labelPointStyle(context) {
        return { pointStyle: context.dataset.type === "line" ? "circle" : "rect", rotation: 0 };
      },
      ...(extraCallbacks || {}),
    },
  };
}

// ============== 组合图：堆叠柱 + 双轴折线 ==============

function drawCombo(key, canvasId, labels, bars, lines, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;

  const single = bars.length === 1;
  const hasLines = lines.length > 0;
  const datasets = [
    ...bars.map((b, i) => ({
      type: "bar",
      label: b.label,
      data: b.data,
      // 普通柱图沿用业务色；只有带折线的组合图采用参考色阶。
      backgroundColor: hasLines ? comboBarFill(i, bars.length) : b.color,
      hoverBackgroundColor: hasLines ? comboBarTone(i, bars.length) : b.color,
      // grouped：并列柱。用于彼此不构成整体的指标（如接待人数 vs 接待企业数），
      // 堆叠会读成「人数 + 企业数」这种没有意义的合计。
      stack: o.grouped ? undefined : "s",
      yAxisID: "y",
      // 单系列做成胶囊，堆叠时只给最上面一段留圆角，并列柱每根都留圆角
      borderRadius: o.grouped ? (o.pillBars ? 20 : { topLeft: 5, topRight: 5 }) : (single ? 20 : (i === bars.length - 1 ? { topLeft: 5, topRight: 5 } : 2)),
      borderSkipped: false,
      // 段与段之间留一条白色细缝，避免颜色直接相接糊在一起（单柱和并列柱不需要）
      borderColor: "#f7f8fc",
      borderWidth: (single || o.grouped) ? 0 : { top: 2, right: 0, bottom: 0, left: 0 },
      barPercentage: o.grouped ? (o.pillBars ? .54 : .8) : (single ? .42 : .62),
      categoryPercentage: o.grouped ? .74 : .82,
      order: 2,
    })),
    ...lines.map((l, i) => {
      const lineColor = l.strokeColor || comboLineTone(l.color, i);
      return {
        type: "line",
        label: l.label,
        data: l.data,
        borderColor: lineColor,
        backgroundColor: lineColor,
        yAxisID: l.axis || "y1",
        tension: .42,
        borderWidth: 3.2,
        borderDash: [7, 5],
        pointRadius: 0,
        pointBackgroundColor: "#fff",
        pointBorderColor: lineColor,
        pointBorderWidth: 2.5,
        pointHoverRadius: 5.5,
        fill: false,
        order: 1,
      };
    }),
  ];

  const scales = cleanScales({ stacked: !o.grouped, rotate: o.rotate ?? 45, autoSkip: false });
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
        legend: comboLegend(),
        hoverGuide: { enabled: true },
        valueLabels: { maxLabels: o.maxLabels ?? 40, maxTotalLabels: o.maxTotalLabels ?? 150, showStackTotal: o.showStackTotal !== false && !o.grouped, barTop: !!o.grouped, lineLabels: false },
        tooltip: comboTooltip(o.tooltipCallbacks),
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
    const options = [new Option(cfg.placeholder, "")];
    for (const [value, count] of sortedPairs(facets[cfg.dim])) {
      options.push(new Option(value + "（" + count + "）", value));
    }
    el.replaceChildren(...options);
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
    // 上一等长周期由 /api/dashboard 同一次响应带回（json.previous），不再单独发第二次请求。
    renderCards(json.stats, json.previous);
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

// 缓存最近一次渲染用的 stats：切聚合粒度只是换个分桶方式，
// 没必要重新打接口（顶部筛选变化时才 reload）。
let LAST_STATS = null;

function renderCharts(s) {
  LAST_STATS = s;
  renderAI(s);
  renderTrend(s);
  renderScene(s);
  renderCost(s);
}

function renderCards(s, previous) {
  const d = s.derived;
  // 五张卡统一口径：折线画的都是「该卡片头部那个指标」的日粒度值，
  // 实线本期、虚线上一等长周期（previous 由 /api/dashboard 同一次响应带回）。
  const prevDay = previous?.byDay || null;
  const prevLabel = previous?.from ? "上一周期 " + previous.from + " ~ " + previous.to : "上一等长周期";
  const rate = (numerator, denominator) => (denominator > 0 ? (numerator / denominator) * 100 : 0);
  const series = (byDay, valueOf) => sortedKeys(byDay || {}).map((day) => {
    const value = valueOf(byDay[day] || {});
    return Number.isFinite(value) ? value : 0;
  });
  // 缓存刚升级、日桶里还没有 aiOnly / avoidable 时会算出 NaN，series 已经兜成 0
  const trendOf = (valueOf) => ({ current: series(s.byDay, valueOf), previous: series(prevDay, valueOf) });

  const cards = [
    {
      label: "会话总数", value: s.total, tone: "violet",
      sub: "有效会话 " + d.effectiveCount + " 条 · " + d.effectiveRate + "%",
      trend: trendOf((b) => Number(b.total) || 0),
      hint: "每日会话数",
    },
    {
      label: "AI 独立率", value: d.aiRate + "%", tone: "cyan",
      sub: "AI 独立接待 " + d.aiOnlyCount + " 条 · 人工在线 " + d.manualCount + " 条 / " + d.manualRate + "%",
      trend: trendOf((b) => rate(b.aiOnly, b.total)),
      hint: "每日 AI 独立率",
    },
    {
      label: "可避免转人工", value: d.avoidableRate + "%", tone: "amber",
      sub: d.avoidableCount + " / " + s.transferred + " 次本可由 AI 承接",
      trend: trendOf((b) => rate(b.avoidable, b.transfer)),
      hint: "每日可避免转人工占比（当天没有转人工的记 0）",
    },
    {
      label: "人工接待总时长", value: d.durSumHours + " 小时", tone: "rose",
      sub: "均 " + fmtDuration(d.durAvg) + " · 中位 " + fmtDuration(d.durMedian),
      trend: trendOf((b) => (Number(b.dur) || 0) / 3600),
      hint: "每日人工接待时长（小时）",
    },
    {
      label: "接待轮次总计", value: s.turnsSum, tone: "blue",
      sub: "有时长记录会话 " + s.durCount + " 条",
      trend: trendOf((b) => Number(b.turns) || 0),
      hint: "每日接待轮次",
    },
  ];

  $("cards").innerHTML = cards.map((c) =>
    '<div class="card card--metric card--' + c.tone + '"><div class="card-summary"><div class="card-label">' + c.label + '</div>' +
    '<div class="card-value">' + c.value + '</div></div>' +
    '<div class="card-visual">' + miniTrend(c.trend.current, c.trend.previous, c.tone, c.hint, prevLabel) + '</div>' +
    '<div class="card-sub">' + c.sub + '</div></div>'
  ).join("");
}

const escAttr = escHtml;

// 折线纯图形，看不出画的是什么：统一挂 title（悬停可读）+ aria-label（读屏可读）
function describe(hint) {
  const text = escAttr(hint);
  return ' role="img" aria-label="' + text + '" title="' + text + '"';
}

function miniTrend(current, previous, tone, hint, prevLabel) {
  const now = (current || []).filter((value) => Number.isFinite(value));
  const before = (previous || []).filter((value) => Number.isFinite(value));
  if (!now.length) return '<span class="metric-trend"' + describe(hint) + '></span>';
  const max = Math.max(...now.concat(before), 1);
  const width = 132, height = 58, padding = 5;
  const points = (values) => values.map((value, index) => {
    const x = padding + ((width - padding * 2) * (values.length === 1 ? .5 : index / (values.length - 1)));
    const y = height - padding - ((height - padding * 2) * value / max);
    return [x.toFixed(1), y.toFixed(1)];
  });
  const curve = (values) => {
    const p = points(values);
    if (p.length === 1) return "M" + p[0][0] + " " + p[0][1];
    let path = "M" + p[0][0] + " " + p[0][1];
    for (let i = 1; i < p.length; i++) {
      const prev = p[i - 1], next = p[i];
      const midX = ((Number(prev[0]) + Number(next[0])) / 2).toFixed(1);
      const midY = ((Number(prev[1]) + Number(next[1])) / 2).toFixed(1);
      path += i === p.length - 1 ? " Q" + prev[0] + " " + prev[1] + " " + next[0] + " " + next[1] : " Q" + prev[0] + " " + prev[1] + " " + midX + " " + midY;
    }
    return path;
  };
  const last = points(now).at(-1);
  const label = hint + (before.length ? "；实线为本期，虚线为" + prevLabel : "");
  return '<span class="metric-trend metric-trend--' + tone + '"' + describe(label) + '><svg viewBox="0 0 ' + width + " " + height + '">' +
    '<path class="metric-trend-grid" d="M5 17.5H127 M5 40.5H127"></path>' +
    (before.length ? '<path class="metric-trend-before" d="' + curve(before) + '"></path>' : "") +
    '<path class="metric-trend-current" d="' + curve(now) + '"></path>' +
    '<circle class="metric-trend-dot" cx="' + last[0] + '" cy="' + last[1] + '" r="3.2"></circle></svg></span>';
}

function renderAI(s) {
  const jiri = s.jiri || {};
  const way = s.way || {};
  const status = s.status || {};
  // 三张卡都只表达一个决策指标，分母仅包含该指标可比较的会话。
  drawProgressRing("jiri", "chartJiri", {
    label: "不能占比", value: jiri["不能"] || 0,
    total: (jiri["不能"] || 0) + (jiri["能"] || 0) + (jiri["部分"] || 0), color: "#8676FF",
  });
  drawProgressRing("way", "chartWay", {
    label: "沟通后转占比", value: way["沟通后转"] || 0,
    total: (way["沟通后转"] || 0) + (way["直接转"] || 0), color: "#FF708B",
  });
  drawProgressRing("status", "chartStatus", {
    label: "仅 Jiri 占比", value: status["仅 Jiri"] || 0,
    total: (status["仅 Jiri"] || 0) + (status["仅人工"] || 0), color: "#383874",
  });
  drawBar("reason", "chartReason", sortedPairs(s.reason), { horizontal: true, colors: ["#ff8dac", "#806dfa", "#00c8a9", "#ffb65c"] });

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

// ============================================================================
// 会话接待分布 · 聚合粒度
//
// byDay 是服务端下发的完整日桶（含 dev/ch/nat 三个维度 map），所以年/季/月/周
// 都能在客户端从它聚合出来，不需要动接口。
// ============================================================================

const RECEPT_GRAINS = {
  day:     { label: "按天",   maxLabels: 40, rotate: 60 },
  week:    { label: "按周",   maxLabels: 40, rotate: 45 },
  month:   { label: "按月",   maxLabels: 36, rotate: 0  },
  quarter: { label: "按季度", maxLabels: 24, rotate: 0  },
  year:    { label: "按年",   maxLabels: 12, rotate: 0  },
};

let receptGrain = "day";

// ISO 周键。必须和服务端 isoWeek()（src/index.js）算法一致，否则「按周」
// 会和「会话接待分布（按周）」那张图对不上。
function isoWeekOf(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  if (isNaN(d)) return "";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return t.getUTCFullYear() + "W" + String(1 + Math.round((t - ft) / 604800000)).padStart(2, "0");
}

// "2026-08-04" → 该粒度下的周期键
function periodKeyOf(day, grain) {
  switch (grain) {
    case "week":    return isoWeekOf(day);
    case "month":   return day.slice(0, 7);
    case "quarter": return day.slice(0, 4) + "-Q" + (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1);
    case "year":    return day.slice(0, 4);
    default:        return day;
  }
}

// multiYear：范围跨了多个年份时，周标签要带上年份，否则 2025W22 和 2026W22
// 都会显示成「第 22 周」，两根柱子看不出区别。月/季/年本身已含年份。
function periodLabel(key, grain, multiYear) {
  switch (grain) {
    case "week":    return (multiYear ? key.slice(2, 4) + " 年" : "") + "第 " + Number(key.slice(5)) + " 周";
    case "quarter": return key.replace("-Q", " Q");
    case "month":
    case "year":    return key;
    default:        return key;   // 按天保持 2026-08-04 原样，和改动前一致
  }
}

/**
 * 把日桶按粒度合并。
 *
 * 注意：不能照抄 compressEmptyDays 里那个 reduce——它合并时直接
 * `dev: {}, ch: {}, nat: {}` 丢掉了三个维度 map（那里只合并空白天，无所谓）。
 * 这里必须逐 key 累加，否则 bucketKeys(buckets,"dev") 推不出设备维度，
 * 堆叠柱会塌成一根灰柱子。
 */
function rollupDays(byDay, grain) {
  const order = [];
  const map = {};
  const days = Object.keys(byDay || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  for (const day of days) {
    const key = periodKeyOf(day, grain);
    if (!key) continue;
    if (!map[key]) {
      map[key] = { total: 0, dur: 0, durCount: 0, transfer: 0, turns: 0, dev: {}, ch: {}, nat: {} };
      order.push(key);
    }
    const t = map[key], b = byDay[day];
    t.total += b.total;
    t.dur += b.dur;
    t.durCount += b.durCount;
    t.transfer += b.transfer;
    t.turns += b.turns;
    for (const f of ["dev", "ch", "nat"]) {
      for (const [k, v] of Object.entries(b[f] || {})) t[f][k] = (t[f][k] || 0) + v;
    }
  }
  return { keys: order, buckets: order.map((k) => map[k]) };
}

let uniqGrain = "week";

/**
 * 接待人数（user_id 去重）/ 接待企业数（billing_account_id 去重）。
 *
 * 两个指标不构成整体（一个企业下可能有多个用户），所以用并列柱不堆叠。
 * 数据只能来自服务端 s.uniq[粒度]——去重计数无法在客户端从日粒度累加，
 * 同一个用户跨两天来过，按天是 2、按月只能算 1。
 */
function drawUniqChart(s) {
  const g = RECEPT_GRAINS[uniqGrain] || RECEPT_GRAINS.week;
  const by = (s.uniq && s.uniq[uniqGrain]) || {};
  const keys = Object.keys(by).sort();   // 五种粒度的键都可直接字典序排
  const multiYear = new Set(keys.map((k) => k.slice(0, 4))).size > 1;

  drawCombo(
    "receptUniq", "chartReceptUniq", keys.map((k) => periodLabel(k, uniqGrain, multiYear)),
    [
      { label: "接待人数", data: keys.map((k) => by[k].users), color: "#806dfa" },
      { label: "接待企业数", data: keys.map((k) => by[k].orgs), color: "#00c8a9" },
    ],
    [],
    { grouped: true, pillBars: true, maxLabels: g.maxLabels, rotate: g.rotate }
  );

  // 总计用全区间去重数，不是各周期相加——相加会把跨周期的回访用户重复计数。
  const all = s.uniqAll || { users: 0, orgs: 0 };
  const el = $("totalReceptUniq");
  if (el) {
    el.innerHTML = "区间去重：接待人数 <b>" + fmtNum(all.users) + "</b> 人 · 企业 <b>" + fmtNum(all.orgs) + "</b> 家";
  }
  const hint = $("hintReceptUniq");
  if (hint) hint.textContent = "各周期去重独立计算，不可相加";
}

// 设备堆叠柱 + 人工总时长 / 转人工次数双折线
function drawReceptChart(s) {
  const g = RECEPT_GRAINS[receptGrain] || RECEPT_GRAINS.day;
  const { keys, buckets } = rollupDays(s.byDay, receptGrain);
  const multiYear = new Set(keys.map((k) => k.slice(0, 4))).size > 1;
  const labels = keys.map((k) => periodLabel(k, receptGrain, multiYear));
  const devKeys = bucketKeys(buckets, "dev");

  drawCombo(
    "dayRecept", "chartDayRecept", labels,
    devKeys.map((k, i) => ({ label: k, data: buckets.map((b) => b.dev[k] || 0), color: colorFor(COLOR_DEVICE, k, i) })),
    [
      { label: "人工接待总时长（小时）", data: buckets.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#ffb65c", axis: "y1" },
      { label: "转人工会话接待次数", data: buckets.map((b) => b.transfer), color: "#a9b1c4", axis: "y1" },
    ],
    { maxLabels: g.maxLabels, rotate: g.rotate }
  );
  setTotal("totalDayRecept", "总计：", buckets.reduce((a, b) => a + b.total, 0));
}

function renderTrend(s) {
  const weeks = sortedKeys(s.byWeek);
  const weekB = weeks.map((w) => s.byWeek[w]);

  // 会话接待分布：粒度可切（天/周/月/季/年），见 drawReceptChart
  drawReceptChart(s);
  drawUniqChart(s);

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

  drawBar("medium", "chartMedium", sortedPairs(s.medium, 12), { horizontal: true, colors: ["#806dfa", "#00d9d4", "#ff8dac", "#ffb65c"] });
}

function renderScene(s) {
  drawDoughnut("nature2", "chartNature2", sortedPairs(s.nature), { colorMap: COLOR_NATURE });
  setTotal("totalNature2", "记录数量：", s.total);

  drawBar("scene", "chartScene", sortedPairs(s.effectiveScene), { horizontal: true, colors: ["#806dfa", "#ff8dac", "#00c8a9", "#ffb65c"] });
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
    plans.map((p) => "<th>" + escHtml(p) + "</th>").join("") + "<th>合计</th></tr></thead><tbody>";
  for (const sc of scenes) {
    const row = s.sceneByPlan[sc] || {};
    const total = plans.reduce((sum, p) => sum + (row[p] || 0), 0);
    html += "<tr><td>" + escHtml(sc) + "</td>" +
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
    [{ label: "会话数", data: weekB.map((b) => b.total), color: "#806dfa" }],
    [
      { label: "人工接待总时长（小时）", data: weekB.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#ffb65c", axis: "y1" },
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
      color: "#ffb65c",
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
    [{ label: "转人工会话数", data: cz.buckets.map((b) => b.transfer), color: "#b9b3f5" }],
    [
      { label: "人工接待总时长（小时）", data: cz.buckets.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#ffb65c", axis: "y1" },
      { label: "单会话平均时长（分钟）", data: cz.buckets.map((b) => (b.durCount ? Number((b.dur / b.durCount / 60).toFixed(1)) : 0)), color: "#ff6689", axis: "y1" },
    ],
    { rotate: 60, maxLabels: 40, showStackTotal: false }
  );
  setTotal("totalDayCost", "人工接待总时长：", Number((recentB.reduce((a, b) => a + b.dur, 0) / 3600).toFixed(1)));
  const hint = $("hintDayCost");
  if (hint) {
    hint.textContent = "最近 " + recentDays.length + " 天" +
      (cz.merged > 0 ? "，其中 " + cz.merged + " 个无人工接待的日期已与相邻空档合并" : "");
  }

  drawHourlyService(s);
  drawManualBusy(s);
}

function hourlyDayLabel(day) {
  const date = new Date(day + "T00:00:00Z");
  return isNaN(date) ? day : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short",
  }).format(date);
}

function drawHourlyService(s) {
  const hourly = s.hourly || {};
  const days = Array.isArray(hourly.days) ? hourly.days : [];
  const tabs = $("hourlyDayTabs");
  const note = $("hourlyServiceNote");
  if (!days.length || !tabs) {
    destroyChart("hourlyService");
    if (note) note.textContent = "当前筛选条件下没有可展示的小时数据。";
    return;
  }
  if (!days.includes(state.hourlyDay)) state.hourlyDay = days.at(-1);
  tabs.replaceChildren(...days.map((day) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hourly-day-tab" + (day === state.hourlyDay ? " active" : "");
    button.dataset.day = day;
    button.textContent = hourlyDayLabel(day);
    button.setAttribute("aria-pressed", String(day === state.hourlyDay));
    return button;
  }));

  const buckets = hourly.byDay?.[state.hourlyDay] || [];
  const points = Array.from({ length: 24 }, (_, hour) => buckets[hour] || { jiri: 0, manual: 0, manualDur: 0 });
  drawCombo(
    "hourlyService", "chartHourlyService", points.map((_, hour) => String(hour).padStart(2, "0") + ":00"),
    [],
    [
      { label: "Jiri 会话量", data: points.map((p) => p.jiri), color: "#8676FF", strokeColor: "#8676FF", axis: "y" },
      { label: "人工会话量", data: points.map((p) => p.manual), color: "#FF708B", strokeColor: "#FF708B", axis: "y" },
      { label: "人工会话时长（小时）", data: points.map((p) => Number((p.manualDur / 3600).toFixed(2))), color: "#383874", strokeColor: "#383874", axis: "y1" },
    ],
    { grouped: true, rotate: 0, maxLabels: 0, showStackTotal: false, yLabel: "会话数", y1Label: "小时" }
  );
  const total = points.reduce((sum, point) => sum + point.jiri + point.manual, 0);
  setTotal("totalHourlyService", hourlyDayLabel(state.hourlyDay) + "：", total + " 场会话");
  if (note) note.textContent = "每个点覆盖该小时的 00 分至 59 分；人工时长只统计处理状态为“仅人工”的会话。";
}

const BUSY_COLORS = ["busy-empty", "busy-level-1", "busy-level-2", "busy-level-3", "busy-level-4", "busy-level-5"];

// 时段定义由 /api/dashboard 随 manualBusy 下发，前端不再各存一份常量。
// 兜底值只服务于「刚部署完、KV 还是旧结构」这一小段时间。
const BUSY_SLOT_FALLBACK = { startMinute: 9 * 60 + 30, endMinute: 19 * 60, slotMinutes: 15, slotCount: 38 };

function busySlotOf(busy) {
  const s = busy && busy.slot ? busy.slot : null;
  return s && s.slotCount > 0 ? s : BUSY_SLOT_FALLBACK;
}

function minuteLabel(minute) {
  return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
}

function busySlotLabel(slot, index) {
  const start = slot.startMinute + index * slot.slotMinutes;
  return minuteLabel(start) + "–" + minuteLabel(start + slot.slotMinutes);
}

// 分母是**最近 N 个自然日**（含当天没有人工接待的日子），不是网格上显示的行数 ——
// 两个数不一样，所以文案里必须把「按几天平均」写出来。
function setBusySummary(slot, peak, second, days, mode) {
  const summary = $("manualBusySummary");
  if (!summary) return;
  if (!peak || !days.length) {
    summary.textContent = "";
    return;
  }
  const label = mode === "active" ? "同时服务" : "新转人工";
  const per = (slot2) => fmtNum(slot2.total / days.length) + " 人";
  const lead = "最忙高峰为 " + busySlotLabel(slot, peak.index) + "（" + label + " " + per(peak) + "）";
  summary.textContent = lead +
    (second ? "；次高峰为 " + busySlotLabel(slot, second.index) + "（" + label + " " + per(second) + "）" : "") +
    "。以上为按最近 " + days.length + " 个自然日平均，空闲日也计入分母。";
}

function drawManualBusy(s) {
  const busy = s.manualBusy || {};
  const days = Array.isArray(busy.days) ? busy.days : [];
  const slot = busySlotOf(busy);
  const grid = $("manualBusyGrid");
  const hint = $("manualBusyHint");
  if (!grid) return;

  // 列数跟着下发的 slotCount 走，CSS 只留一个兜底值
  grid.style.setProperty("--busy-slots", String(slot.slotCount));

  const mode = state.manualBusyMode === "incoming" ? "incoming" : "active";
  document.querySelectorAll("#manualBusyModes button[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  const clear = () => {
    grid.replaceChildren();
    setBusySummary(slot, null, null, [], mode);
    if (hint) hint.textContent = "当前筛选条件下没有可展示的人工服务数据。";
  };
  if (!days.length) return clear();

  const visibleRows = days.map((day) => ({
    day,
    values: Array.from({ length: slot.slotCount }, (_, index) => {
      return Number(busy.byDay?.[day]?.[index]?.[mode]) || 0;
    }),
  })).filter(({ values }) => values.some((value) => value > 0));

  if (!visibleRows.length) return clear();

  if (hint) {
    // active 靠时长铺开，没有时长记录的会话进不了这张图；把差额说清楚，
    // 否则两个模式的总量对不上会被当成 bug。
    const noDuration = Number(busy.noDuration) || 0;
    hint.textContent = "最近 " + days.length + " 天 · 显示 " + visibleRows.length + " 个有人工接待的日期 · " +
      minuteLabel(slot.startMinute) + "–" + minuteLabel(slot.endMinute) + " · 每格 " + slot.slotMinutes + " 分钟" +
      (mode === "active" && noDuration
        ? " · 另有 " + noDuration + " 场无时长记录，只计入「新转人工人数」"
        : "");
  }

  const rows = visibleRows.map(({ values }) => values);
  const max = Math.max(...rows.flat());
  const slotTotals = Array.from({ length: slot.slotCount }, (_, index) => ({
    index,
    total: rows.reduce((sum, row) => sum + row[index], 0),
  })).filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total || a.index - b.index);

  const cells = [];
  const corner = document.createElement("span");
  corner.className = "manual-busy-time manual-busy-corner";
  cells.push(corner);
  for (let index = 0; index < slot.slotCount; index++) {
    const time = document.createElement("span");
    time.className = "manual-busy-time";
    time.textContent = index % 4 === 0 ? minuteLabel(slot.startMinute + index * slot.slotMinutes) : "";
    cells.push(time);
  }
  visibleRows.forEach(({ day: visibleDay, values: row }) => {
    const day = document.createElement("span");
    day.className = "manual-busy-day";
    day.textContent = hourlyDayLabel(visibleDay);
    cells.push(day);
    row.forEach((value, index) => {
      const level = value ? Math.min(5, Math.max(1, Math.ceil(value / max * 5))) : 0;
      const cell = document.createElement("span");
      cell.className = "manual-busy-cell " + BUSY_COLORS[level];
      const metric = mode === "active" ? "同时服务" : "新转人工";
      const tooltip = hourlyDayLabel(visibleDay) + " " + busySlotLabel(slot, index) + " · " + metric + " " + value + " 人";
      if (value) cell.dataset.tooltip = tooltip;
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", tooltip);
      cells.push(cell);
    });
  });
  grid.replaceChildren(...cells);
  setBusySummary(slot, slotTotals[0], slotTotals[1], days, mode);
}

// ============== 业务闭环 ==============

async function loadLoop() {
  if (state.loopLoaded) return;
  try {
    const json = await api("/api/loop");
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      $("hintLoopWeek").textContent = "数据正在构建，稍后重开此页签。";
      return;
    }
    state.loop = json.loop;
    state.loopLoaded = true;
    renderLoop(json.loop);
  } catch (err) {
    $("hintLoopWeek").textContent = "加载失败：" + err.message;
  }
}

function renderLoop(loop) {
  const ws = loop.weeks || [];
  const o = loop.overall || {};

  // 图一：每周趋势 —— 是/否/待定 堆叠柱（合计即适用会话数）+ 闭环率折线
  const labels = ws.map((x) => "第 " + Number(x.week.slice(5)) + " 周");
  const unsettled = ws.map((x) => x.unsettled);
  const rates = ws.map((x) => x.rate);

  destroyChart("loopWeek");
  if (chartReady()) {
    const cv = $("chartLoopWeek");
    charts.loopWeek = new Chart(cv, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "闭环 是", data: ws.map((x) => x.yes), backgroundColor: comboBarFill(0, 3), stack: "s", borderColor: "#f7f8fc", borderWidth: { top: 2 }, borderRadius: 2, borderSkipped: false, barPercentage: .6, order: 3 },
          { type: "bar", label: "未闭环 否", data: ws.map((x) => x.no), backgroundColor: comboBarFill(1, 3), stack: "s", borderColor: "#f7f8fc", borderWidth: { top: 2 }, borderRadius: 2, borderSkipped: false, barPercentage: .6, order: 3 },
          { type: "bar", label: "待定（结果未定）", data: ws.map((x) => x.pending), backgroundColor: comboBarFill(2, 3), stack: "s", borderColor: "#f7f8fc", borderWidth: { top: 2 }, borderRadius: { topLeft: 5, topRight: 5 }, borderSkipped: false, barPercentage: .6, order: 3 },
          {
            type: "line", label: "闭环率", data: rates, yAxisID: "y1",
            borderColor: comboLineTone("#806dfa", 0), borderWidth: 3.2, borderDash: [7, 5], tension: .35, spanGaps: false,
            pointBackgroundColor: ws.map((x) => (x.unsettled ? "#eef1fe" : "#fff")),
            pointBorderColor: ws.map((x) => (x.unsettled ? "#c9c2ff" : comboLineTone("#806dfa", 0))),
            pointBorderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6, order: 1,
            // 待定占比 >30% 的周还会往上走，那一段画成虚线 + 浅色
            segment: {
              borderDash: () => [7, 5],
              borderColor: (c) => (unsettled[c.p0DataIndex] || unsettled[c.p1DataIndex] ? "#c9c2ff" : comboLineTone("#806dfa", 0)),
            },
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 22 } },
        plugins: {
          legend: comboLegend(),
          valueLabels: { maxLabels: 40, showStackTotal: true, lineLabels: false },
          hoverGuide: { enabled: true },
          tooltip: comboTooltip({
              afterBody(items) {
                const x = ws[items[0].dataIndex];
                return ["适用会话 " + x.applicable + " · 待定占比 " + x.pendingRate + "%" +
                  (x.rate === null ? " · 闭环率不可用（无适用会话）" : x.unsettled ? " · 下限值，还会往上走" : "")];
              },
            }),
        },
        scales: {
          x: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { padding: 6 } },
          y: { stacked: true, beginAtZero: true, grid: { color: "#f2f4fa", drawTicks: false }, border: { display: false }, ticks: { padding: 10, maxTicksLimit: 6 } },
          y1: { position: "right", min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { padding: 8, maxTicksLimit: 6, callback: (v) => v + "%" } },
        },
      },
    });
  }
  setTotal("totalLoopWeek", "整体闭环率：", o.rate === null ? "—" : o.rate + "%");
  const un = ws.filter((x) => x.unsettled).map((x) => "第 " + Number(x.week.slice(5)) + " 周");
  $("hintLoopWeek").textContent = un.length ? un.join("、") + " 待定占比超 30%，闭环率是下限、还会往上走" : "各周结果均已定";
  $("loopWeekNote").innerHTML =
    "口径：闭环 = 咨询后 7 天内该账户名下收到过填写数据；判的是<b>账户</b>不是某一张表，大账户会偏高。<br>" +
    "适用会话 = 业务闭环标了是 / 否 / 待定（「不适用」和空已排除）；闭环率 = 是 ÷ 全部适用行（是 + 否 + 待定），<b>下限口径</b>。" +
    '<span class="dim-note"><br>收到过数据的会话立刻判是，不等 7 天满；待定 = 窗口还没满、也还没收到数据，只会往是或否落地。' +
    "所以当周读数只会低估不会高估，待定清零后就等于最终闭环率。待定占比超 30% 的周，折线画成浅色虚线。</span>";

  // 图二：按业务分型（全部适用行，含待定），横向条形图 + 整体参考线
  const types = loop.types || [];
  destroyChart("loopType");
  if (chartReady() && types.length) {
    const cv = $("chartLoopType");
    charts.loopType = new Chart(cv, {
      type: "bar",
      data: {
        labels: types.map((x) => x.type + (x.small ? "（样本少）" : "")),
        datasets: [{
          label: "闭环率",
          data: types.map((x) => x.rate),
          backgroundColor: types.map((x, i) => (x.small ? "#d3d8e6" : PALETTE[i % PALETTE.length])),
          hoverBackgroundColor: types.map((x, i) => (x.small ? "#c6ccdd" : darken(PALETTE[i % PALETTE.length]))),
          borderRadius: 20, borderSkipped: false, barPercentage: .58, categoryPercentage: .82,
          customLabels: types.map((x) => "场次 " + x.sessions + " ｜ 闭环率 " + (x.rate === null ? "—" : x.rate.toFixed(1) + "%")),
          labelInk: types.map((x) => (x.small ? "#9aa0b4" : "#454b69")),
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 190 } },
        plugins: {
          legend: { display: false },
          valueLabels: { maxLabels: 40, showStackTotal: false },
          refLine: { value: o.rate, label: "整体 " + (o.rate === null ? "—" : o.rate + "%"), color: "#8b90a7" },
          tooltip: {
            callbacks: {
              title: (i) => types[i[0].dataIndex].type,
              label: (c) => {
                const x = types[c.dataIndex];
                return "闭环 " + x.yes + " / 未闭环 " + x.no + " / 待定 " + x.pending + " · 闭环率 " + x.rate + "%";
              },
            },
          },
        },
        scales: {
          x: { min: 0, max: 100, grid: { color: "#f2f4fa", drawTicks: false }, border: { display: false }, ticks: { callback: (v) => v + "%", maxTicksLimit: 6 } },
          y: { grid: { display: false }, border: { display: false }, ticks: { padding: 8, font: { size: 12 } } },
        },
      },
    });
  }
  const small = types.filter((x) => x.small);
  setTotal("totalLoopType", "适用会话：", o.applicable + " 场");
  $("hintLoopType").textContent = small.length ? "灰色为场次不足 10 的分型，样本太小" : "";
  $("loopTypeNote").innerHTML =
    "口径：闭环 = 咨询后 7 天内该账户名下收到过填写数据；判的是<b>账户</b>不是某一张表，大账户会偏高。<br>" +
    "与上图同口径：闭环率 = 是 ÷ 全部适用行（含待定），待定多的分型会被拉低；虚线为整体闭环率 <b>" +
    (o.rate === null ? "—" : o.rate + "%") + "</b>（是 " + o.yes + " / 否 " + o.no + " / 待定 " + o.pending + "）。" +
    (small.length ? '<span class="dim-note"><br>' + small.map((x) => escHtml(x.type) + "（" + x.sessions + " 场）").join("、") + " 场次少于 10，仅作参考。</span>" : "");
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

// 颜色只看方向：涨＝红（up），跌＝绿（down）。不按「指标变好变坏」上色 ——
// 有些指标越小越好（时长、人工占比），但配色跟着语义翻转会让人读不准涨跌。
function delta(cur, prev, unit) {
  if (prev === null || prev === undefined || prev === 0) return "";
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
  const sign = d > 0 ? "+" : "";
  return '<span class="dl ' + (d > 0 ? "up" : "down") + '">' + sign + Number(d.toFixed(1)) + (unit || "") + "</span>";
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
    if (!state.weeks.length) {
      $("wkHint").textContent = "暂无可展示的周报数据。";
      document.querySelectorAll("#panel-weekly .report-block").forEach((block) => { block.hidden = true; });
      return;
    }
    document.querySelectorAll("#panel-weekly .report-block").forEach((block) => { block.hidden = false; });

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
      delta: pg ? delta(g.guideShare, pg.guideShare, "pp") : "",
      note: "目标把操作引导类问题交给 Jiri，人工时长占比压到 10% 以内",
    },
    ...g.mustHuman.map((m, k) => {
      const prev = pg ? pg.mustHuman[k] : null;
      return {
        name: "单次接待时长中位数 · " + m.label + "（" + m.scene + "）",
        target: "≤ " + m.target + " 分",
        value: m.raw === null ? "—" : Number(m.raw).toFixed(1) + " 分",
        ok: m.value !== null && m.value <= m.target,
        delta: prev && prev.raw !== null && m.raw !== null ? delta(m.raw, prev.raw, " 分") : "",
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
  const pct1 = (cur, prev) => {
    if (prev === null || prev === undefined || prev === 0) return '<span class="dl flat">—</span>';
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
    return '<span class="dl ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "+" : "") + d.toFixed(1) + "%</span>";
  };
  const ratio = (cur, prev) => num(pct1(cur, prev));
  // 环比与同比合并成一格，省掉两行同期原始值
  const dual = (cur, prev, yoy) =>
    '<td class="num dual">' +
    '<span class="dl-row"><i>环</i>' + pct1(cur, prev) + "</span>" +
    (yoy === null || yoy === undefined ? "" :
      '<span class="dl-row"><i>同</i>' + pct1(cur, yoy) + "</span>") +
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
      dual(w.manualRate, p2.manualRate, g("manualRate")) +
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
      dual(a.medianMin, b.medianMin, g("medianMin")) +
      dual(a.avgMin, b.avgMin, g("avgMin")) +
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
      return "<tr" + (isGuide ? ' class="warn-row"' : "") + "><td>" + escHtml(x.scene) + "</td>" +
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

  // 五、仅 Jiri 有效场景
  $("tblJiriScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">场次</th><th class="num">占比</th>' +
    '<th class="num">环比</th><th class="num">同比</th></tr></thead><tbody>' +
    w.jiriScenes.map((x) =>
      "<tr><td>" + escHtml(x[0]) + "</td>" + num(x[1]) +
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
      else if (tab.dataset.tab === "loop") loadLoop();
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

  // 会话接待分布的聚合粒度：纯前端换分桶，不重新请求接口
  const gran = $("granRecept");
  if (gran) {
    gran.value = receptGrain;
    gran.addEventListener("change", () => {
      receptGrain = RECEPT_GRAINS[gran.value] ? gran.value : "day";
      if (LAST_STATS) drawReceptChart(LAST_STATS);
    });
  }

  const granU = $("granUniq");
  if (granU) {
    granU.value = uniqGrain;
    granU.addEventListener("change", () => {
      uniqGrain = RECEPT_GRAINS[granU.value] ? granU.value : "week";
      if (LAST_STATS) drawUniqChart(LAST_STATS);
    });
  }

  const hourlyTabs = $("hourlyDayTabs");
  if (hourlyTabs) hourlyTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-day]");
    if (!button || !LAST_STATS) return;
    state.hourlyDay = button.dataset.day;
    drawHourlyService(LAST_STATS);
  });

  const manualBusyModes = $("manualBusyModes");
  if (manualBusyModes) manualBusyModes.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || !LAST_STATS) return;
    state.manualBusyMode = button.dataset.mode === "incoming" ? "incoming" : "active";
    drawManualBusy(LAST_STATS);
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
