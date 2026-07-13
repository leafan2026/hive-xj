// Field mapping
const FIELD_LABELS = {
  field_1: "vx链接",
  field_2: "会话链接",
  field_3: "分类",
  field_4: "场景",
  field_5: "会话时间",
  field_6: "第几周",
  field_7: "跟进情况",
  field_8: "意向",
  field_9: "跟进时间",
};

const CATEGORY_ORDER = ["A潜客", "B入驻", "C首单", "D存量", "E流失"];

// 从金数据拉取所有条目（游标分页）
async function fetchAllEntries(env) {
  const key = env.JSJ_API_KEY;
  const secret = env.JSJ_API_SECRET;
  const auth = btoa(`${key}:${secret}`);

  const base = "https://next.jinshuju.net/api/v1/forms/G9Kct7/entries";
  let cursor = null;
  let allData = [];

  do {
    const url = cursor ? `${base}?per_page=100&next=${cursor}` : `${base}?per_page=100`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "User-Agent": "WDL-Dashboard/1.0",
      },
    });
    if (!res.ok) {
      throw new Error(`JinShuJu API error: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    allData = allData.concat(json.data);
    cursor = json.next || null;
  } while (cursor);

  return allData;
}

// 构建统计摘要
function buildStats(entries) {
  const categoryCounts = {};
  const intentionCounts = {};
  const weeklyCounts = {};
  const weeklyCategoryCounts = {}; // { "27": { "A潜客": 3, ... }, ... }
  const followerCounts = {};
  let followedCount = 0;
  let withIntention = 0;

  for (const e of entries) {
    const cat = e.field_3 || "未分类";
    const intent = e.field_8 || "未标记";
    const week = e.field_6 || "未知";
    const follower = e.field_10 || "未分配";

    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    intentionCounts[intent] = (intentionCounts[intent] || 0) + 1;
    weeklyCounts[week] = (weeklyCounts[week] || 0) + 1;
    followerCounts[follower] = (followerCounts[follower] || 0) + 1;

    // 按周 + 分类的交叉统计
    if (!weeklyCategoryCounts[week]) weeklyCategoryCounts[week] = {};
    weeklyCategoryCounts[week][cat] = (weeklyCategoryCounts[week][cat] || 0) + 1;

    if (e.field_7 && e.field_7.trim()) followedCount++;
    if (intent !== "未标记" && intent !== "无") withIntention++;
  }

  return {
    total: entries.length,
    followedCount,
    withIntention,
    followUpRate: entries.length
      ? ((followedCount / entries.length) * 100).toFixed(1)
      : "0",
    intentionRate: entries.length
      ? ((withIntention / entries.length) * 100).toFixed(1)
      : "0",
    categoryCounts,
    intentionCounts,
    weeklyCounts,
    weeklyCategoryCounts,
    followerCounts,
  };
}

// 计算周数排序
function sortWeeks(weeks) {
  return Object.keys(weeks)
    .filter((w) => w !== "未知" && !isNaN(Number(w)))
    .sort((a, b) => Number(a) - Number(b));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ============== API 路由 ==============
    if (path === "/api/dashboard") {
      try {
        const entries = await fetchAllEntries(env);
        const stats = buildStats(entries);
        const sortedWeeks = sortWeeks(stats.weeklyCounts);

        return Response.json({
          success: true,
          stats,
          sortedWeeks,
        });
      } catch (err) {
        return Response.json(
          { success: false, error: err.message },
          { status: 500 }
        );
      }
    }

    if (path === "/api/entries") {
      try {
        const entries = await fetchAllEntries(env);
        const page = parseInt(url.searchParams.get("page") || "1", 10);
        const perPage = Math.min(
          parseInt(url.searchParams.get("per_page") || "20", 10),
          100
        );
        const category = url.searchParams.get("category") || "";
        const intention = url.searchParams.get("intention") || "";
        const search = url.searchParams.get("search") || "";

        let filtered = entries;

        if (category) {
          filtered = filtered.filter((e) => e.field_3 === category);
        }
        if (intention) {
          filtered = filtered.filter((e) => e.field_8 === intention);
        }
        if (search) {
          const q = search.toLowerCase();
          filtered = filtered.filter(
            (e) =>
              (e.field_4 && e.field_4.toLowerCase().includes(q)) ||
              (e.field_7 && e.field_7.toLowerCase().includes(q))
          );
        }

        // 按会话时间倒序
        filtered.sort((a, b) => {
          const tA = a.field_5 || a.created_at || "";
          const tB = b.field_5 || b.created_at || "";
          return tB.localeCompare(tA);
        });

        const total = filtered.length;
        const totalPages = Math.ceil(total / perPage);
        const start = (page - 1) * perPage;
        const paged = filtered.slice(start, start + perPage);

        return Response.json({
          success: true,
          total,
          page,
          perPage,
          totalPages,
          data: paged,
        });
      } catch (err) {
        return Response.json(
          { success: false, error: err.message },
          { status: 500 }
        );
      }
    }

    // ============== 前端页面 ==============
    if (path === "/" || path === "") {
      const [cssUrl, jsUrl] = await Promise.all([
        env.ASSETS.url("/dashboard.css"),
        env.ASSETS.url("/dashboard.js"),
      ]);

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>跟进数据看板 - 小金商户用户跟踪</title>
  <link rel="stylesheet" href="${cssUrl}">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <h1>📊 小金商户用户跟踪 · 数据看板</h1>
      <div class="header-meta">
        <span>数据来源：金数据</span>
        <button class="refresh-btn" onclick="refreshData()">🔄 刷新数据</button>
      </div>
    </div>
  </header>

  <main class="main">
    <div class="summary-cards" id="summaryCards">
      <div class="card"><div class="card-label">总记录</div><div class="card-value" id="statTotal">—</div></div>
      <div class="card"><div class="card-label">已跟进</div><div class="card-value" id="statFollowed">—</div></div>
      <div class="card"><div class="card-label">有意向</div><div class="card-value" id="statIntention">—</div></div>
      <div class="card"><div class="card-label">跟进率</div><div class="card-value" id="statRate">—</div></div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h3>分类分布</h3>
        <canvas id="categoryChart"></canvas>
      </div>
      <div class="chart-card">
        <h3>意向分布</h3>
        <canvas id="intentionChart"></canvas>
      </div>
      <div class="chart-card chart-card-wide">
        <h3>各周趋势 · 按分类</h3>
        <canvas id="weeklyChart"></canvas>
      </div>
      <div class="chart-card">
        <h3>跟进人统计</h3>
        <canvas id="creatorChart"></canvas>
      </div>
    </div>

    <div class="filters">
      <select id="filterCategory" onchange="loadEntries()">
        <option value="">全部分类</option>
        <option value="A潜客">A潜客</option>
        <option value="B入驻">B入驻</option>
        <option value="C首单">C首单</option>
        <option value="D存量">D存量</option>
        <option value="E流失">E流失</option>
      </select>
      <select id="filterIntention" onchange="loadEntries()">
        <option value="">全部意向</option>
        <option value="无">无</option>
        <option value="低">低</option>
        <option value="中">中</option>
        <option value="高">高</option>
      </select>
      <input type="text" id="filterSearch" placeholder="搜索场景/跟进内容…" oninput="debounceSearch()">
      <span class="entry-count" id="entryCount"></span>
    </div>

    <div class="table-wrapper">
      <table class="entries-table" id="entriesTable">
        <thead>
          <tr>
            <th>#</th>
            <th>分类</th>
            <th>场景</th>
            <th>意向</th>
            <th>会话时间</th>
            <th>跟进情况</th>
            <th>跟进时间</th>
            <th>跟进人</th>
            <th>链接</th>
          </tr>
        </thead>
        <tbody id="entriesBody"></tbody>
      </table>
    </div>

    <div class="pagination" id="pagination"></div>

    <div class="loading-overlay" id="loadingOverlay">
      <div class="loading-spinner"></div>
      <div>加载中…</div>
    </div>
  </main>

  <footer class="footer">
    <p>Powered by WDL</p>
  </footer>

  <script src="${jsUrl}"></script>
</body>
</html>`;

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
