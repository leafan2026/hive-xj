// State
let dashboardData = null;
let currentPage = 1;
const PER_PAGE = 20;

// Chart.js 全局默认
if (window.Chart) {
  Chart.defaults.font.family =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif';
  Chart.defaults.color = "#7d7a95";
  Chart.defaults.plugins.tooltip.backgroundColor = "rgba(29, 29, 31, 0.88)";
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
}

// Chart instances
let categoryChart = null;
let intentionChart = null;
let weeklyChart = null;
let creatorChart = null;
let startupChart = null;

// 分类顺序与图标/颜色
const CATEGORIES = [
  { key: "A潜客", icon: "🔍", color: "#a997df" },
  { key: "B入驻", icon: "🏠", color: "#4f517d" },
  { key: "C首单", icon: "🛒", color: "#ddc4dd" },
  { key: "D存量", icon: "📦", color: "#1a3a3a" },
  { key: "E流失", icon: "⚠️", color: "#dccfec" },
];

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
    renderStartupChart(res.stats);
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

async function refreshData() {
  const btn = document.querySelector(".refresh-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 刷新中…";
  currentPage = 1;
  await loadDashboard();
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

  const order = CATEGORIES.map((c) => c.key);
  const labels = Object.keys(stats.categoryCounts).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b)
  );
  const values = labels.map((l) => stats.categoryCounts[l]);
  const colors = labels.map(
    (l) => (CATEGORIES.find((c) => c.key === l) || {}).color || "#d9e0e4"
  );

  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderWidth: 3,
          borderColor: "#fff",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: "62%",
      plugins: {
        legend: {
          position: "right",
          labels: {
            font: { size: 12 },
            padding: 12,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
          },
        },
        tooltip: {
          callbacks: {
            label: function (ctx) {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return ctx.label + ": " + ctx.parsed + " (" + pct + "%)";
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
    未标记: "#e0dcea",
    无: "#e0dcea",
    低: "#ddc4dd",
    中: "#a997df",
    高: "#4f517d",
  };

  intentionChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "数量",
          data: values,
          backgroundColor: labels.map((l) => colors[l] || "#e0dcea"),
          borderRadius: 6,
          maxBarThickness: 56,
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
          grid: { color: "#e7e2f0" },
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
    borderRadius: 3,
    maxBarThickness: 72,
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
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
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
          grid: { color: "#e7e2f0" },
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
  
  creatorChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "记录数",
          data: values,
          backgroundColor: "#4f517d",
          borderRadius: 6,
          maxBarThickness: 26,
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
          grid: { color: "#e7e2f0" },
        },
        y: {
          ticks: { font: { size: 11 } },
          grid: { display: false },
        },
      },
    },
  });
}


function renderStartupChart(stats) {
  const ctx = document.getElementById("startupChart").getContext("2d");
  if (startupChart) startupChart.destroy();

  const entries = Object.entries(stats.startupCounts || {}).sort(
    (a, b) => b[1] - a[1]
  );
  const labels = entries.map((e) => e[0]);
  const values = entries.map((e) => e[1]);
  // 未标记灰色，其余长春花紫
  const colors = labels.map((l) => (l === "未标记" ? "#e0dcea" : "#a997df"));

  startupChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "记录数",
          data: values,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 26,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 11 } },
          grid: { color: "#e7e2f0" },
        },
        y: {
          ticks: { font: { size: 12 } },
          grid: { display: false },
        },
      },
    },
  });
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
