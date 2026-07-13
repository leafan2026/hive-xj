// State
let dashboardData = null;
let currentPage = 1;
const PER_PAGE = 20;
const JINSHUJU_TABLE_URL = "https://next.jinshuju.net/tables/G9Kct7";

// Chart instances
let categoryChart = null;
let intentionChart = null;
let weeklyChart = null;
let creatorChart = null;

// 分类顺序与图标/颜色
const CATEGORIES = [
  { key: "A潜客", icon: "🔍", color: "#0071e3" },
  { key: "B入驻", icon: "🏠", color: "#34c759" },
  { key: "C首单", icon: "🛒", color: "#ff9500" },
  { key: "D存量", icon: "📦", color: "#af52de" },
  { key: "E流失", icon: "⚠️", color: "#ff3b30" },
];

// Debounce
let searchTimer = null;
function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage = 1;
    loadEntries();
  }, 400);
}

// ============== Data Loading ==============

async function fetchAPI(path) {
  const res = await fetch(path);
  return res.json();
}

async function loadDashboard() {
  showLoading(true);
  try {
    const res = await fetchAPI("/app/api/dashboard");
    if (!res.success) throw new Error(res.error);
    dashboardData = res;
    renderSummary(res.stats);
    renderCategoryChart(res.stats);
    renderIntentionChart(res.stats);
    renderWeeklyChart(res.stats, res.sortedWeeks);
    renderCreatorChart(res.stats);
  } catch (err) {
    console.error("加载看板失败:", err);
    document.querySelector(".charts-grid").innerHTML =
      `<div class="chart-card" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#c00;">
        ❌ 加载失败：${err.message}。请确保金数据 API 凭据正确且表格可访问。
      </div>`;
  } finally {
    showLoading(false);
  }
}

async function loadEntries() {
  showLoading(true);
  try {
    const category = document.getElementById("filterCategory").value;
    const intention = document.getElementById("filterIntention").value;
    const search = document.getElementById("filterSearch").value;

    let url = `/app/api/entries?page=${currentPage}&per_page=${PER_PAGE}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    if (intention) url += `&intention=${encodeURIComponent(intention)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const res = await fetchAPI(url);
    if (!res.success) throw new Error(res.error);

    renderTable(res);
    renderPagination(res);
    document.getElementById("entryCount").textContent = `共 ${res.total} 条`;
  } catch (err) {
    console.error("加载列表失败:", err);
  } finally {
    showLoading(false);
  }
}

async function refreshData() {
  const btn = document.querySelector(".refresh-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 刷新中…";
  currentPage = 1;
  await Promise.all([loadDashboard(), loadEntries()]);
  btn.disabled = false;
  btn.textContent = "🔄 刷新数据";
}

// ============== Render Functions ==============

function renderSummary(stats) {
  document.getElementById("statTotal").textContent = stats.total;
  document.getElementById("statFollowed").textContent = stats.followedCount;
  document.getElementById("statIntention").textContent = stats.withIntention;
  document.getElementById("statRate").textContent = `${stats.followUpRate}%`;
}

function renderCategoryChart(stats) {
  const ctx = document.getElementById("categoryChart").getContext("2d");
  if (categoryChart) categoryChart.destroy();

  const labels = Object.keys(stats.categoryCounts);
  const values = Object.values(stats.categoryCounts);
  const colors = CATEGORIES.map((c) => c.color);

  categoryChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: labels.map((l) => {
        const m = CATEGORIES.find((c) => c.key === l);
        return l;
      }),
      datasets: [
        {
          data: values,
          backgroundColor: colors.slice(0, labels.length),
          borderWidth: 2,
          borderColor: "#fff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: "right",
          labels: { font: { size: 12 }, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function renderIntentionChart(stats) {
  const ctx = document.getElementById("intentionChart").getContext("2d");
  if (intentionChart) intentionChart.destroy();

  const labels = Object.keys(stats.intentionCounts);
  const values = Object.values(stats.intentionCounts);
  const colors = {
    无: "#d2d2d7",
    低: "#ff9500",
    中: "#34c759",
    高: "#0071e3",
  };

  intentionChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "数量",
          data: values,
          backgroundColor: labels.map((l) => colors[l] || "#b3d9fa"),
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 11 } },
          grid: { color: "#e8e8ed" },
        },
        x: {
          ticks: { font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

function renderWeeklyChart(stats, sortedWeeks) {
  const ctx = document.getElementById("weeklyChart").getContext("2d");
  if (weeklyChart) weeklyChart.destroy();

  const weekLabels = sortedWeeks.map((w) => `第${w}周`);

  // 每个分类作为一个 dataset（堆叠柱状图）
  const datasets = CATEGORIES.filter((c) => {
    // 只在有数据的分类才显示
    return sortedWeeks.some((w) => (stats.weeklyCategoryCounts[w]?.[c.key] || 0) > 0);
  }).map((cat) => ({
    label: cat.key,
    data: sortedWeeks.map((w) => stats.weeklyCategoryCounts[w]?.[cat.key] || 0),
    backgroundColor: cat.color,
    borderRadius: 2,
  }));

  weeklyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: weekLabels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: "top",
          labels: {
            font: { size: 12 },
            padding: 14,
            usePointStyle: true,
            pointStyle: "rectRounded",
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: function (ctx) {
              const total = ctx.chart.data.datasets
                .map((ds) => ds.data[ctx.dataIndex])
                .reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((ctx.parsed.y / total) * 100).toFixed(1) : 0;
              return `${ctx.dataset.label}: ${ctx.parsed.y}条 (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { font: { size: 11 } },
          grid: { display: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 11 } },
          grid: { color: "#e8e8ed" },
        },
      },
    },
  });
}

function renderCreatorChart(stats) {
  const ctx = document.getElementById("creatorChart").getContext("2d");
  if (creatorChart) creatorChart.destroy();

  const entries = Object.entries(stats.followerCounts).sort((a, b) => b[1] - a[1]);
  const labels = entries.map((e) => e[0]);
  const values = entries.map((e) => e[1]);
  const bgColors = ["#0071e3", "#3f8ce8", "#6ba7ee", "#93c0f3", "#b9d7f8", "#dcebfc"];

  creatorChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "记录数",
          data: values,
          backgroundColor: bgColors.slice(0, labels.length),
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 11 } },
          grid: { color: "#e8e8ed" },
        },
        y: {
          ticks: { font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}

function renderTable(res) {
  const tbody = document.getElementById("entriesBody");
  tbody.innerHTML = "";

  if (res.data.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="9" style="text-align:center;padding:40px;color:#999;">暂无数据</td></tr>';
    return;
  }

  for (const e of res.data) {
    const tr = document.createElement("tr");
    const catClass = getCategoryClass(e.field_3);
    const intentClass = getIntentionClass(e.field_8);

    const scene = e.field_4 || "";
    const followup = e.field_7 || "";
    const sessionTime = e.field_5 || "-";
    const followTime = e.field_9 || "-";

    // 序列号 → 跳转到金数据详情页
    const snLink = e.serial_number
      ? `<a class="sn-link" href="${JINSHUJU_TABLE_URL}?serial_number=${e.serial_number}" target="_blank" rel="noopener">${e.serial_number}</a>`
      : "-";

    const vxLink = e.field_1
      ? `<a class="link-icon" href="${escapeHtml(e.field_1)}" target="_blank" rel="noopener">vx</a>`
      : "-";
    const chatLink = e.field_2
      ? `<a class="link-icon" href="${escapeHtml(e.field_2)}" target="_blank" rel="noopener">会话</a>`
      : "-";

    tr.innerHTML = `
      <td>${snLink}</td>
      <td><span class="badge ${catClass}">${getCatIcon(e.field_3)} ${escapeHtml(e.field_3 || "-")}</span></td>
      <td class="scene-cell" title="${escapeHtml(scene)}">${escapeHtml(scene) || "-"}</td>
      <td><span class="badge ${intentClass}">${escapeHtml(e.field_8 || "-")}</span></td>
      <td>${escapeHtml(sessionTime)}</td>
      <td class="followup-cell" title="${escapeHtml(followup)}">${escapeHtml(followup) || "-"}</td>
      <td>${escapeHtml(followTime)}</td>
      <td>${escapeHtml(e.field_10 || "未分配")}</td>
      <td>${vxLink} ${chatLink}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderPagination(res) {
  const container = document.getElementById("pagination");
  container.innerHTML = "";

  if (res.totalPages <= 1) return;

  const prev = document.createElement("button");
  prev.className = "page-btn";
  prev.textContent = "‹";
  prev.disabled = currentPage <= 1;
  prev.onclick = () => {
    if (currentPage > 1) {
      currentPage--;
      loadEntries();
    }
  };
  container.appendChild(prev);

  const start = Math.max(1, currentPage - 2);
  const end = Math.min(res.totalPages, currentPage + 2);

  if (start > 1) {
    const first = document.createElement("button");
    first.className = "page-btn";
    first.textContent = "1";
    first.onclick = () => {
      currentPage = 1;
      loadEntries();
    };
    container.appendChild(first);
    if (start > 2) {
      const dots = document.createElement("span");
      dots.style.padding = "0 4px";
      dots.textContent = "…";
      container.appendChild(dots);
    }
  }

  for (let i = start; i <= end; i++) {
    const btn = document.createElement("button");
    btn.className = "page-btn" + (i === currentPage ? " active" : "");
    btn.textContent = i;
    btn.onclick = () => {
      currentPage = i;
      loadEntries();
    };
    container.appendChild(btn);
  }

  if (end < res.totalPages) {
    if (end < res.totalPages - 1) {
      const dots = document.createElement("span");
      dots.style.padding = "0 4px";
      dots.textContent = "…";
      container.appendChild(dots);
    }
    const last = document.createElement("button");
    last.className = "page-btn";
    last.textContent = res.totalPages;
    last.onclick = () => {
      currentPage = res.totalPages;
      loadEntries();
    };
    container.appendChild(last);
  }

  const next = document.createElement("button");
  next.className = "page-btn";
  next.textContent = "›";
  next.disabled = currentPage >= res.totalPages;
  next.onclick = () => {
    if (currentPage < res.totalPages) {
      currentPage++;
      loadEntries();
    }
  };
  container.appendChild(next);
}

// ============== Helpers ==============

function getCategoryClass(cat) {
  if (!cat) return "";
  const m = { A: "badge-a", B: "badge-b", C: "badge-c", D: "badge-d", E: "badge-e" };
  const prefix = cat.charAt(0);
  return m[prefix] || "";
}

function getCatIcon(cat) {
  if (!cat) return "";
  const m = { A: "🔍", B: "🏠", C: "🛒", D: "📦", E: "⚠️" };
  return m[cat.charAt(0)] || "";
}

function getIntentionClass(intent) {
  if (!intent) return "";
  const m = { 无: "badge-intent-none", 低: "badge-intent-low", 中: "badge-intent-mid", 高: "badge-intent-high" };
  return m[intent] || "";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showLoading(active) {
  document.getElementById("loadingOverlay").classList.toggle("active", active);
}

// ============== Init ==============

document.addEventListener("DOMContentLoaded", () => {
  refreshData();
});
