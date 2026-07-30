// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

const PALETTE = [
  "#2f80ed", "#27ae60", "#f2994a", "#9b51e0", "#eb5757",
  "#56ccf2", "#219653", "#f2c94c", "#bb6bd9", "#e57373",
  "#4f8ef7", "#6fcf97", "#f7a55b", "#a889d6", "#7f8c9b",
];

const state = { stats: null, facets: null, refreshing: false, polling: false, weeks: [], weeklyLoaded: false, latestDay: null };
const charts = {};

// 筛选项 → 接口参数名；选项值来自首次全量结果，筛选后不再改动
const DIM_SELECTS = {
  fChannel: { dim: "channel", placeholder: "全部渠道" },
  fDevice: { dim: "device", placeholder: "全部设备" },
  fStatus: { dim: "status", placeholder: "全部处理状态" },
  fScene: { dim: "scene", placeholder: "全部业务场景" },
  fNature: { dim: "nature", placeholder: "全部会话性质" },
  fPlan: { dim: "plan", placeholder: "全部套餐" },
};

// ============== 工具 ==============

function $(id) { return document.getElementById(id); }

// 首屏先占位，避免大片空白
function renderSkeleton() {
  const labels = ["会话总数", "已人工质检", "Jiri 可解答率", "可避免转人工", "人工接待总时长", "接待轮次总计"];
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
    throw new Error("登录状态已失效，请刷新页面重新输入账号密码");
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

// Chart.js 万一没加载成功，卡片和文字结论照常可用
let labelsRegistered = false;
function chartReady() {
  if (typeof Chart === "undefined") return false;
  if (!labelsRegistered) { Chart.register(valueLabels); labelsRegistered = true; }
  return true;
}

function drawBar(key, canvasId, pairs, opts) {
  const o = opts || {};
  if (!chartReady()) return;
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;
  charts[key] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: pairs.map((p) => p[0]),
      datasets: [{
        label: o.label || "会话数",
        data: pairs.map((p) => p[1]),
        backgroundColor: o.color || "#2f80ed",
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: o.horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: !o.horizontal }, ticks: { autoSkip: false, maxRotation: o.rotate || 0 } },
        y: { beginAtZero: true, grid: { display: !!o.horizontal } },
      },
    },
  });
}

function drawDoughnut(key, canvasId, pairs) {
  if (!chartReady()) return;
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;
  charts[key] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: pairs.map((p) => p[0]),
      datasets: [{
        data: pairs.map((p) => p[1]),
        backgroundColor: pairs.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 1,
        borderColor: "#fff",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "48%",
      layout: { padding: { top: 4, bottom: 2 } },
      plugins: {
        // 图例放底部横排：右侧竖排会把大半张卡片留白，环也被压小
        legend: {
          position: "bottom",
          labels: { boxWidth: 11, boxHeight: 11, padding: 9, font: { size: 11.5 } },
        },
        tooltip: {
          callbacks: {
            label(c) {
              const sum = c.dataset.data.reduce((a, b) => a + (Number(b) || 0), 0);
              const pctVal = sum ? ((c.parsed / sum) * 100).toFixed(1) : 0;
              return " " + c.label + "：" + c.parsed + "（" + pctVal + "%）";
            },
          },
        },
      },
    },
  });
}

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
        borderColor: "#2f80ed",
        backgroundColor: "rgba(47,128,237,.14)",
        fill: true,
        tension: .3,
        pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// ============== 数值标签 ==============

// 参考看板会把数值直接标在柱子和折线上，这里用一个内联插件实现，不引第三方依赖
const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins?.valueLabels;
    if (!opt || opt.enabled === false) return;
    const { ctx, data } = chart;
    const count = data.labels?.length || 0;
    if (count > (opt.maxLabels || 40)) return;

    ctx.save();
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.textAlign = "center";

    const stackTotals = {};
    const stackTop = {};

    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      const kind = ds.type || meta.type || chart.config.type;

      // 环形/饼图：扇区内标「数值 · 占比」，太窄的扇区跳过
      if (kind === "doughnut" || kind === "pie") {
        const sum = ds.data.reduce((a, b) => a + (Number(b) || 0), 0);
        meta.data.forEach((el, i) => {
          const v = Number(ds.data[i]) || 0;
          if (!v || !sum) return;
          const share = v / sum;
          if (share < 0.055) return;
          const p = el.getCenterPoint();
          ctx.fillStyle = "#fff";
          ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.fillText(fmtNum(v), p.x, p.y - 1);
          ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.fillText((share * 100).toFixed(1) + "%", p.x, p.y + 11);
        });
        return;
      }

      meta.data.forEach((el, i) => {
        const v = ds.data[i];
        if (v === null || v === undefined || v === 0) return;

        if (kind === "line") {
          ctx.fillStyle = "#5a6678";
          ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.fillText(fmtNum(v), el.x, el.y - 7);
          return;
        }
        if (typeof el.base !== "number") return;
        // 堆叠柱：段内标数值（高度够才标），顶部标合计
        const h = Math.abs(el.base - el.y);
        if (h >= 15) {
          ctx.fillStyle = "#fff";
          ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
          ctx.fillText(fmtNum(v), el.x, (el.y + el.base) / 2 + 4);
        }
        stackTotals[i] = (stackTotals[i] || 0) + v;
        stackTop[i] = stackTop[i] === undefined ? el.y : Math.min(stackTop[i], el.y);
      });
    });

    if (opt.showStackTotal !== false) {
      ctx.fillStyle = "#3b475c";
      ctx.font = '11.5px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      Object.keys(stackTotals).forEach((i) => {
        const meta = chart.getDatasetMeta(0);
        const el = meta.data[i];
        if (!el) return;
        ctx.fillText(fmtNum(stackTotals[i]), el.x, stackTop[i] - 6);
      });
    }
    ctx.restore();
  },
};

function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n >= 10000 ? (n / 1000).toFixed(1) + "K" : String(n);
  return n.toFixed(n < 10 ? 2 : 1);
}

// 分类固定配色，跨图表保持一致
const COLOR_NATURE = {
  "有效": "#7eb6e8", "填表人": "#8fdcd0", "无效": "#b4e197",
  "转接未应答": "#f6a6a6", "电话引导·发链接图片": "#2f80ed",
  "内部测试": "#f6d47a", "未标记": "#c9d1dd",
};
const COLOR_CHANNEL = {
  gd_next: "#f2994a", gd4: "#b07a4f", gd_app: "#9b51e0",
  wechat_miniapp: "#27ae60", wechat_official: "#eb5757",
  trade_weixin_app: "#2f80ed", "未知": "#9aa5b6",
};
const COLOR_DEVICE = { pc: "#2f80ed", mobile: "#27ae60", "未知": "#b0b8c4" };

function colorFor(map, key, i) {
  return map[key] || PALETTE[i % PALETTE.length];
}

// ============== 组合图：堆叠柱 + 双轴折线 ==============

function drawCombo(key, canvasId, labels, bars, lines, opts) {
  if (!chartReady()) return;
  const o = opts || {};
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;

  const datasets = [
    ...bars.map((b) => ({
      type: "bar",
      label: b.label,
      data: b.data,
      backgroundColor: b.color,
      stack: "s",
      yAxisID: "y",
      borderWidth: 0,
      order: 2,
    })),
    ...lines.map((l) => ({
      type: "line",
      label: l.label,
      data: l.data,
      borderColor: l.color,
      backgroundColor: l.color,
      yAxisID: l.axis || "y1",
      tension: .35,
      pointRadius: 2.5,
      pointBackgroundColor: "#fff",
      borderWidth: 2,
      fill: false,
      order: 1,
    })),
  ];

  const scales = {
    x: { stacked: true, grid: { display: false }, ticks: { maxRotation: o.rotate ?? 45, autoSkip: false, font: { size: 11 } } },
    y: { stacked: true, beginAtZero: true, title: { display: !!o.yLabel, text: o.yLabel || "" } },
  };
  if (lines.length) {
    scales.y1 = {
      position: "right",
      beginAtZero: true,
      grid: { drawOnChartArea: false },
      title: { display: !!o.y1Label, text: o.y1Label || "" },
    };
    if (lines.some((l) => l.axis === "y2")) {
      scales.y2 = { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, display: false };
    }
  }

  charts[key] = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start", labels: { boxWidth: 12, usePointStyle: false, font: { size: 12 } } },
        valueLabels: { maxLabels: o.maxLabels ?? 40, showStackTotal: o.showStackTotal !== false },
      },
      scales,
    },
  });
}

// 多条折线，可各自挂不同 Y 轴
function drawMultiLine(key, canvasId, labels, series) {
  if (!chartReady()) return;
  destroyChart(key);
  const ctx = $(canvasId);
  if (!ctx) return;
  const scales = { x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 16 } } };
  series.forEach((s, i) => {
    const axis = s.axis || "y";
    scales[axis] = {
      position: i === 0 ? "left" : "right",
      beginAtZero: true,
      title: { display: !!s.axisLabel, text: s.axisLabel || "" },
      grid: { drawOnChartArea: i === 0 },
    };
  });
  charts[key] = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        yAxisID: s.axis || "y",
        borderColor: s.color,
        backgroundColor: s.fill ? s.color.replace(")", ", .14)").replace("rgb", "rgba") : s.color,
        fill: !!s.fill,
        tension: .3,
        pointRadius: 2,
        borderWidth: 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 12 } } } },
      scales,
    },
  });
}

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
  if ($("fQc").value) p.set("qc", $("fQc").value);
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
  const ids = ["fRange", "fFrom", "fTo", "fQc", ...Object.keys(DIM_SELECTS)];
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
    { label: "已人工质检", value: d.labeledCount, sub: "占全部会话 " + d.labeledRate + "%（AI 指标口径）" },
    { label: "Jiri 可解答率", value: d.resolveRate + "%", sub: "不能 " + d.cannotRate + "% · 部分 " + d.partialRate + "%（已质检内）" },
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
  drawBar("reason", "chartReason", sortedPairs(s.reason), { horizontal: true, color: "#eb5757" });

  const d = s.derived;
  const top = sortedPairs(s.reason, 1)[0];
  $("noteAvoidable").innerHTML =
    "本板块口径：已人工质检的 <b>" + d.labeledCount + "</b> 条会话（占全部 " + d.labeledRate + "%），" +
    "未打标的 " + (s.jiri["未标记"] || 0) + " 条不参与计算。<br>" +
    "其中转人工 <b>" + s.transferred + "</b> 次，<b>" + d.avoidableCount + "</b> 次（" +
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
      { label: "人工接待总时长（小时）", data: dayB.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f2c94c", axis: "y1" },
      { label: "转人工会话接待次数", data: dayB.map((b) => b.transfer), color: "#7f8c9b", axis: "y1" },
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
  drawBar("medium", "chartMedium", sortedPairs(s.medium, 12), { horizontal: true, color: "#9b51e0" });
}

function renderScene(s) {
  const effScene = sortedPairs(s.effectiveScene);
  drawDoughnut("effScene", "chartEffScene", effScene);
  setTotal("totalEffScene", "有效会话：", effScene.reduce((a, p) => a + p[1], 0));

  drawDoughnut("nature2", "chartNature2", sortedPairs(s.nature));
  setTotal("totalNature2", "记录数量：", s.total);

  drawBar("scene", "chartScene", sortedPairs(s.scene), { horizontal: true, color: "#2f80ed" });
  drawDoughnut("plan", "chartPlan", sortedPairs(s.plan));
  drawDoughnut("xj", "chartXj", sortedPairs(s.xjCategory));

  const plans = sortedPairs(s.plan).map((p) => p[0]);
  const scenes = sortedPairs(s.scene).map((p) => p[0]);
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
    [{ label: "会话数", data: weekB.map((b) => b.total), color: "#3aa0e8" }],
    [
      { label: "人工接待总时长（小时）", data: weekB.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f2c94c", axis: "y1" },
      { label: "转人工会话接待次数", data: weekB.map((b) => b.transfer), color: "#7f8c9b", axis: "y1" },
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
    [{ label: "转人工会话数", data: cz.buckets.map((b) => b.transfer), color: "#a8cff0" }],
    [
      { label: "人工接待总时长（小时）", data: cz.buckets.map((b) => Number((b.dur / 3600).toFixed(2))), color: "#f2c94c", axis: "y1" },
      { label: "单会话平均时长（分钟）", data: cz.buckets.map((b) => (b.durCount ? Number((b.dur / b.durCount / 60).toFixed(1)) : 0)), color: "#eb5757", axis: "y1" },
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
    // 默认选最近一个完整周 —— 周报看的是已结束的那一周
    const complete = state.weeks.filter((w) => w.dayCount >= 7);
    sel.value = (complete.length ? complete[complete.length - 1] : state.weeks[state.weeks.length - 1]).week;
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

  // 二、周度接待概览（全部周）
  $("tblOverview").innerHTML =
    '<thead><tr><th>周</th><th class="num">会话总量</th><th class="num">对话人数</th><th class="num">人均会话</th>' +
    '<th class="num">AI 独立接待 / 独立率</th><th class="num">人工在线 / 占比</th><th class="num">填表人</th><th class="num">有效会话</th></tr></thead><tbody>' +
    state.weeks.slice().reverse().map((x) =>
      "<tr" + (x.week === week ? ' class="hl"' : "") + "><td>第 " + Number(x.week.slice(5)) + " 周</td>" +
      '<td class="num">' + x.total + "</td>" +
      '<td class="num">' + x.users + "</td>" +
      '<td class="num">' + x.perUser + "</td>" +
      '<td class="num">' + x.aiOnly + " / " + x.aiRate + "%</td>" +
      '<td class="num">' + x.manualOnline + " / " + x.manualRate + "%</td>" +
      '<td class="num">' + x.formFillers + "</td>" +
      '<td class="num">' + x.productSessions + "</td></tr>"
    ).join("") + "</tbody>";

  // 三、人工接待现状
  const d1 = (v) => Number(v).toFixed(1);
  const line = (label, s) =>
    "<tr><td>" + label + "</td>" +
    '<td class="num">' + s.receptions + "</td>" +
    '<td class="num">' + d1(s.durHours) + " h</td>" +
    '<td class="num">' + d1(s.medianMin) + " 分</td>" +
    '<td class="num">' + d1(s.avgMin) + " 分</td>" +
    '<td class="num">' + s.sessions + "</td>" +
    '<td class="num">' + s.users + "</td></tr>";
  $("tblManual").innerHTML =
    '<thead><tr><th>口径</th><th class="num">接待次数</th><th class="num">总工时</th><th class="num">单次中位</th><th class="num">单次平均</th><th class="num">会话数</th><th class="num">去重用户</th></tr></thead><tbody>' +
    line("有效人工", w.eff) + line("全部仅人工", w.allManual) + "</tbody>";

  const prevEff = p ? p.eff : null;
  $("manualNote").innerHTML =
    "有效人工 <b>" + w.eff.sessions + "</b> 场会话（去重用户 " + w.eff.users + " 人）/ <b>" + w.eff.receptions + "</b> 次接待，总工时 <b>" +
    w.eff.durHours + " h</b>" +
    (prevEff ? "（上周 " + prevEff.durHours + " h，" +
      (w.eff.durHours >= prevEff.durHours ? "+" : "") +
      Number((w.eff.durHours - prevEff.durHours).toFixed(1)) + " h）" : "") + "。<br>" +
    "不愿和 Jiri 沟通率 <b>" + w.directTransfer + " / " + w.eff.sessions + " = " + w.directRate + "%</b>" +
    (p ? "（上周 " + p.directRate + "%）" : "") +
    " —— 有效人工里「直接转」的场次占比。<br>" +
    '<span class="dim-note">口径：有效人工 = 处理状态「仅人工」且会话性质「有效」；接待次数取「转人工会话接待次数」' +
    '（表单里「人工接待次数」两个字段全为空）；单次中位 = 每场「时长 ÷ 接待次数」的中位数。</span>';

  // 四、有效人工场景 × 工作量
  $("tblScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">接待次数</th><th class="num">总时长（分）</th><th class="num">占总时长</th><th class="num">单次中位</th><th class="num">单次平均</th></tr></thead><tbody>' +
    w.scenes.map((s) => {
      const isGuide = s.scene === "操作引导/功能咨询";
      return "<tr" + (isGuide ? ' class="warn-row"' : "") + "><td>" + s.scene + "</td>" +
        '<td class="num">' + s.receptions + "</td>" +
        '<td class="num">' + s.durMin + "</td>" +
        '<td class="num strong">' + s.share + "%" + (isGuide ? "（目标 ≤ 10%）" : "") + "</td>" +
        '<td class="num">' + Number(s.medianMin).toFixed(1) + "</td>" +
        '<td class="num">' + Number(s.avgMin).toFixed(1) + "</td></tr>";
    }).join("") +
    '<tr class="sum"><td>合计</td><td class="num">' + w.eff.receptions + '</td><td class="num">' +
    w.eff.durMin + '</td><td class="num">100%</td><td class="num">' + Number(w.eff.medianMin).toFixed(1) +
    '</td><td class="num">' + Number(w.eff.avgMin).toFixed(1) + "</td></tr></tbody>";

  // 五、仅 Jiri 有效场景
  $("tblJiriScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">场次</th><th class="num">占比</th></tr></thead><tbody>' +
    w.jiriScenes.map((s) =>
      "<tr><td>" + s[0] + '</td><td class="num">' + s[1] + '</td><td class="num">' +
      (w.jiriSceneTotal ? ((s[1] / w.jiriSceneTotal) * 100).toFixed(1) : 0) + "%</td></tr>"
    ).join("") +
    '<tr class="sum"><td>合计</td><td class="num">' + w.jiriSceneTotal + '</td><td class="num">100%</td></tr></tbody>';
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

  // 维度下拉 + 质检状态：改动即重算
  [...Object.keys(DIM_SELECTS), "fQc"].forEach((id) => {
    $(id).addEventListener("change", reload);
  });

  $("fRange").addEventListener("change", () => { applyRangePreset(); reload(); });
  $("fFrom").addEventListener("change", reload);
  $("fTo").addEventListener("change", reload);

  $("resetBtn").addEventListener("click", () => {
    ["fRange", "fQc", ...Object.keys(DIM_SELECTS)].forEach((id) => { $(id).value = ""; });
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
