// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

const PALETTE = [
  "#2f80ed", "#27ae60", "#f2994a", "#9b51e0", "#eb5757",
  "#56ccf2", "#219653", "#f2c94c", "#bb6bd9", "#e57373",
  "#4f8ef7", "#6fcf97", "#f7a55b", "#a889d6", "#7f8c9b",
];

const state = { stats: null, facets: null, refreshing: false, polling: false };
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
function chartReady() { return typeof Chart !== "undefined"; }

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
      cutout: "52%",
      plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 12 } } } },
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
  const from = $("fFrom").value;
  const to = $("fTo").value;
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  if ($("fQc").value) p.set("qc", $("fQc").value);
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    if ($(id).value) p.set(cfg.dim, $(id).value);
  }
  return p;
}

// 选项只在拿到全量结果时填一次，否则筛完选项会跟着缩水
function fillFacets(stats) {
  if (state.facets) return;
  state.facets = true;
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    const el = $(id);
    el.innerHTML = '<option value="">' + cfg.placeholder + "</option>" +
      sortedPairs(stats[cfg.dim]).map((p) =>
        '<option value="' + p[0] + '">' + p[0] + "（" + p[1] + "）</option>"
      ).join("");
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
  if (v === "") {
    from.value = "";
    to.value = "";
    from.disabled = to.disabled = true;
  } else if (v === "custom") {
    from.disabled = to.disabled = false;
  } else {
    const days = Number(v);
    // 以数据里的最新日期为基准，而不是今天 —— 数据可能滞后
    const latest = state.latestDay || new Date().toISOString().slice(0, 10);
    const end = new Date(latest + "T00:00:00");
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    from.value = start.toISOString().slice(0, 10);
    to.value = latest;
    from.disabled = to.disabled = true;
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
    if (!json.filtered) {
      fillFacets(json.stats);
      const days = Object.keys(json.stats.daily || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      state.latestDay = days[days.length - 1] || null;
      if (state.latestDay) {
        $("fFrom").max = $("fTo").max = state.latestDay;
        $("fFrom").min = $("fTo").min = days[0];
      }
    }
    renderCards(json.stats);
    renderAI(json.stats);
    renderTrend(json.stats);
    renderScene(json.stats);
    renderCost(json.stats);
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

function renderTrend(s) {
  const daily = Object.entries(s.daily || {})
    .filter((p) => p[0] && p[0] !== "未标记")
    .sort((a, b) => a[0].localeCompare(b[0]));
  drawLine("daily", "chartDaily", daily);
  drawDoughnut("channel", "chartChannel", sortedPairs(s.channel));
  drawDoughnut("device", "chartDevice", sortedPairs(s.device));
  drawDoughnut("status", "chartStatus", sortedPairs(s.status));
  drawBar("medium", "chartMedium", sortedPairs(s.medium, 12), { horizontal: true, color: "#9b51e0" });
}

function renderScene(s) {
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
  drawDoughnut("nature", "chartNature", sortedPairs(s.nature));

  const days = Object.keys(s.dailyCost || {})
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const cost = days.map((d) => s.dailyCost[d]);

  drawMultiLine("dailyCost", "chartDailyCost", days, [
    {
      label: "人工接待总时长（小时）",
      data: cost.map((c) => Number((c.dur / 3600).toFixed(2))),
      color: "rgb(47, 128, 237)",
      axis: "y",
      axisLabel: "小时",
      fill: true,
    },
    {
      label: "平均单会话时长（分钟）",
      data: cost.map((c) => (c.n ? Number((c.dur / c.n / 60).toFixed(1)) : 0)),
      color: "rgb(242, 153, 74)",
      axis: "y1",
      axisLabel: "分钟",
    },
  ]);

  drawMultiLine("dailyTransfer", "chartDailyTransfer", days, [
    {
      label: "转人工会话数",
      data: cost.map((c) => c.transfer),
      color: "rgb(235, 87, 87)",
      axis: "y",
      axisLabel: "会话数",
      fill: true,
    },
    {
      label: "人工接待轮次",
      data: cost.map((c) => c.turns),
      color: "rgb(39, 174, 96)",
      axis: "y1",
      axisLabel: "轮次",
    },
  ]);
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
