// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

const PALETTE = [
  "#2f80ed", "#27ae60", "#f2994a", "#9b51e0", "#eb5757",
  "#56ccf2", "#219653", "#f2c94c", "#bb6bd9", "#e57373",
  "#4f8ef7", "#6fcf97", "#f7a55b", "#a889d6", "#7f8c9b",
];

const state = { stats: null, page: 1, perPage: 25, refreshing: false, polling: false };
const charts = {};
let searchTimer = null;

// ============== 工具 ==============

function $(id) { return document.getElementById(id); }

// 加载态只落在明细表里，不再用全屏遮罩盖住已经渲染好的卡片和图表
function showLoading(on) {
  const body = $("entriesBody");
  if (!body) return;
  if (on && !body.querySelector("tr:not(.loading-row)")) {
    body.innerHTML = '<tr class="loading-row"><td colspan="12">加载中…</td></tr>';
  }
}

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

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

// Chart.js 万一没加载成功，卡片和明细表照常可用
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

// ============== 看板 ==============

// 缓存还在构建时轮询，构建完自动渲染
function pollUntilReady() {
  if (state.polling) return;
  state.polling = true;
  const tick = async () => {
    try {
      const json = await api("/api/status");
      const meta = json.meta || {};
      if (meta.status === "ok") {
        state.polling = false;
        banner("");
        await loadDashboard();
        await loadEntries();
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

async function loadDashboard() {
  showLoading(true);
  try {
    const json = await api("/api/dashboard");
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      banner("首次缓存正在构建：从金数据全量拉取 6600+ 条会话，约需 20 秒，完成后自动显示。", "info");
      pollUntilReady();
      return;
    }
    state.stats = json.stats;
    renderCards(json.stats);
    renderAI(json.stats);
    renderTrend(json.stats);
    renderScene(json.stats);
    renderCost(json.stats);
    fillFilters(json.stats);
    if (json.meta) {
      $("updatedAt").textContent =
        "数据更新于 " + new Date(json.meta.updatedAt).toLocaleString("zh-CN") +
        "（" + json.meta.total + " 条）";
    }
    banner("");
  } catch (err) {
    banner("看板数据加载失败：" + err.message);
  } finally {
    showLoading(false);
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
  drawBar("creator", "chartCreator", sortedPairs(s.creator, 10), { horizontal: true, color: "#27ae60" });

  const d = s.derived;
  const items = [
    ["人工接待总时长", d.durSumHours + " 小时"],
    ["平均单会话时长", fmtDuration(d.durAvg)],
    ["中位单会话时长", fmtDuration(d.durMedian)],
    ["有记录时长的会话", s.durCount + " 条"],
    ["转人工接待总次数", s.turnsSum],
    ["有效会话占比", d.effectiveRate + "%"],
  ];
  $("costSummary").innerHTML = items.map((i) =>
    "<div><span>" + i[0] + "</span><strong>" + i[1] + "</strong></div>"
  ).join("");
}

function fillFilters(s) {
  const fill = (id, obj, placeholder) => {
    const el = $(id);
    const current = el.value;
    el.innerHTML = '<option value="">' + placeholder + "</option>" +
      sortedPairs(obj).map((p) =>
        '<option value="' + p[0] + '">' + p[0] + "（" + p[1] + "）</option>"
      ).join("");
    el.value = current;
  };
  fill("fChannel", s.channel, "全部渠道");
  fill("fScene", s.scene, "全部业务场景");
  fill("fNature", s.nature, "全部会话性质");
  fill("fJiri", s.jiri, "Jiri 解答情况");
}

// ============== 明细表 ==============

function natureClass(v) {
  if (v === "有效") return "pill good";
  if (v === "无效" || v === "转接未应答") return "pill bad";
  if (v === "内部测试" || v === "填表人") return "pill warn";
  return "pill";
}

function jiriClass(v) {
  if (v === "能") return "pill good";
  if (v === "不能") return "pill bad";
  if (v === "部分") return "pill warn";
  return "pill";
}

async function loadEntries() {
  showLoading(true);
  try {
    const params = new URLSearchParams({
      page: String(state.page),
      per_page: String(state.perPage),
      channel: $("fChannel").value,
      scene: $("fScene").value,
      nature: $("fNature").value,
      jiri: $("fJiri").value,
      search: $("fSearch").value.trim(),
    });
    const json = await api("/api/entries?" + params.toString());
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) { pollUntilReady(); return; }

    $("entryCount").textContent = "共 " + json.total + " 条，第 " + json.page + " / " + json.totalPages + " 页";
    $("entriesBody").innerHTML = json.data.length
      ? json.data.map((r) =>
          "<tr>" +
          '<td><a href="' + window.JSJ_TABLE_URL + "?serial_number=" + r.sn + '" target="_blank" rel="noopener">' + r.sn + "</a></td>" +
          "<td>" + (r.t || "—") + "</td>" +
          "<td>" + r.ch + "</td>" +
          "<td>" + r.dev + "</td>" +
          "<td>" + r.plan + "</td>" +
          "<td>" + r.scene + "</td>" +
          '<td><span class="' + natureClass(r.nat) + '">' + r.nat + "</span></td>" +
          '<td><span class="' + jiriClass(r.jiri) + '">' + r.jiri + "</span></td>" +
          "<td>" + (r.reason || "—") + "</td>" +
          "<td>" + fmtDuration(r.dur) + "</td>" +
          '<td class="summary">' + (r.sm || "—") + "</td>" +
          "<td>" + (r.url ? '<a href="' + r.url + '" target="_blank" rel="noopener">会话</a>' : "—") + "</td>" +
          "</tr>"
        ).join("")
      : '<tr><td colspan="12" style="text-align:center;color:#8c97a8;padding:28px">没有符合条件的会话</td></tr>';

    renderPagination(json.page, json.totalPages);
  } catch (err) {
    banner("明细加载失败：" + err.message);
  } finally {
    showLoading(false);
  }
}

function renderPagination(page, totalPages) {
  const el = $("pagination");
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  const btn = (label, target, opts) => {
    const o = opts || {};
    return '<button data-page="' + target + '"' +
      (o.disabled ? " disabled" : "") +
      (o.active ? ' class="active"' : "") + ">" + label + "</button>";
  };
  let html = btn("‹", page - 1, { disabled: page === 1 });
  const from = Math.max(1, page - 3);
  const to = Math.min(totalPages, from + 6);
  if (from > 1) html += btn("1", 1) + "<span>…</span>";
  for (let i = from; i <= to; i++) html += btn(String(i), i, { active: i === page });
  if (to < totalPages) html += "<span>…</span>" + btn(String(totalPages), totalPages);
  html += btn("›", page + 1, { disabled: page === totalPages });
  el.innerHTML = html;
  el.querySelectorAll("button[data-page]").forEach((b) => {
    b.addEventListener("click", () => {
      const p = Number(b.dataset.page);
      if (p >= 1 && p <= totalPages && p !== page) { state.page = p; loadEntries(); }
    });
  });
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
    state.page = 1;
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
        await loadEntries();
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

function initFilters() {
  ["fChannel", "fScene", "fNature", "fJiri"].forEach((id) => {
    $(id).addEventListener("change", () => { state.page = 1; loadEntries(); });
  });
  $("fSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.page = 1; loadEntries(); }, 400);
  });
  $("refreshBtn").addEventListener("click", hardRefresh);
}

const T0 = performance.now();

initTabs();
initFilters();
renderSkeleton();
showLoading(true);

// 两个接口互不依赖，并行发出，谁先回谁先渲染
Promise.all([loadDashboard(), loadEntries()]).then(() => {
  try {
  // 把首屏耗时写在页脚，方便定位慢在网络还是接口
  const parts = ["数据 " + Math.round(performance.now() - T0) + " ms"];
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav) parts.push("页面 " + Math.round(nav.responseEnd - nav.startTime) + " ms");
  const res = performance.getEntriesByName ? performance.getEntriesByType("resource") : [];
  const chart = res.find((r) => r.name.includes("chart.min.js"));
  if (chart) parts.push("Chart.js " + Math.round(chart.duration) + " ms");
  const f = document.querySelector(".footer p");
  if (f) f.textContent = "Powered by WDL · " + parts.join(" · ");
  } catch (e) { /* 统计失败不影响看板 */ }
});
