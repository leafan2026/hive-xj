// ============== 明道云 HAP 取数 ==============
const MD_WORKSHEET = "6a55d4aa9a45d48bb3a3d649";
const MD_VIEW = "6a55d4e4ac501cfc947ff91a"; // 「全部」视图

// 明道云字段 ID → 看板字段
const MD_FIELDS = {
  field_1: "6a55d4aa9a45d48bb3a3d64a", // vx链接
  field_2: "6a55d4aa9a45d48bb3a3d64b", // 会话链接
  field_3: "6a55d4aa9a45d48bb3a3d64c", // 分类（下拉）
  field_4: "6a55d4aa9a45d48bb3a3d64d", // 场景
  field_5: "6a55d4aa9a45d48bb3a3d64e", // 会话时间
  field_6: "6a55d4aa9a45d48bb3a3d64f", // 第几周
  field_7: "6a55d4aa9a45d48bb3a3d650", // 跟进情况
  field_8: "6a55d4aa9a45d48bb3a3d651", // 意向（下拉）
  field_9: "6a55d4aa9a45d48bb3a3d652", // 跟进时间
  field_10: "6a55d4aa9a45d48bb3a3d653", // 跟进人（下拉）
  field_11: "6a55dae40b68d2c42bcc1677", // 启动状态（Lookup）
};
const MD_OPTION_FIELDS = new Set(["field_3", "field_8", "field_10"]);

// 下拉字段值形如 [{key, value}]
function mdOptionValue(v) {
  return Array.isArray(v) && v.length > 0 ? v[0].value : "";
}

function mdText(v) {
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === "object" ? x.value || "" : String(x)))
      .filter(Boolean)
      .join(",");
  }
  return String(v);
}

function mdMapRow(row) {
  const e = { created_at: row.ctime || "" };
  for (const [name, id] of Object.entries(MD_FIELDS)) {
    e[name] = MD_OPTION_FIELDS.has(name)
      ? mdOptionValue(row[id])
      : mdText(row[id]);
  }
  return e;
}

// 从明道云拉取所有记录（分页）
async function fetchAllEntries(env) {
  const pageSize = 1000;
  let pageIndex = 1;
  let all = [];

  while (true) {
    const res = await fetch(
      `https://api.mingdao.com/v3/app/worksheets/${MD_WORKSHEET}/rows/list`,
      {
        method: "POST",
        headers: {
          "HAP-Appkey": env.HAP_APPKEY,
          "HAP-Sign": env.HAP_SIGN,
          "Content-Type": "application/json",
          "User-Agent": "WDL-Dashboard/1.0",
        },
        body: JSON.stringify({
          pageSize,
          pageIndex,
          viewId: MD_VIEW,
          useFieldIdAsKey: true,
          includeTotalCount: true,
        }),
      }
    );
    if (!res.ok) {
      throw new Error(`Mingdao API error: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    if (!json.success || !json.data) {
      throw new Error(
        `Mingdao API error: ${json.error_code} ${json.error_msg || ""}`
      );
    }
    const rows = json.data.rows || [];
    all = all.concat(rows.map(mdMapRow));
    const total = json.data.total || 0;
    if (rows.length < pageSize || all.length >= total) break;
    pageIndex++;
  }

  return all;
}

// 构建统计摘要
function buildStats(entries) {
  const categoryCounts = {};
  const intentionCounts = {};
  const weeklyCounts = {};
  const weeklyCategoryCounts = {}; // { "27": { "A潜客": 3, ... }, ... }
  const followerCounts = {};
  const startupCounts = {};
  let followedCount = 0;
  let withIntention = 0;

  for (const e of entries) {
    const cat = e.field_3 || "未分类";
    const intent = e.field_8 || "未标记";
    const week = e.field_6 || "未知";
    const follower = e.field_10 || "未分配";
    const startup = e.field_11 || "未标记";

    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    intentionCounts[intent] = (intentionCounts[intent] || 0) + 1;
    weeklyCounts[week] = (weeklyCounts[week] || 0) + 1;
    followerCounts[follower] = (followerCounts[follower] || 0) + 1;
    startupCounts[startup] = (startupCounts[startup] || 0) + 1;

    // 按周 + 分类的交叉统计
    if (!weeklyCategoryCounts[week]) weeklyCategoryCounts[week] = {};
    weeklyCategoryCounts[week][cat] = (weeklyCategoryCounts[week][cat] || 0) + 1;

    if (e.field_7 && e.field_7.trim()) followedCount++;
    if (intent !== "未标记" && intent !== "无" && intent !== "/") withIntention++;
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
    startupCounts,
  };
}

// 计算周数排序
function sortWeeks(weeks) {
  return Object.keys(weeks)
    .filter((w) => w !== "未知" && !isNaN(Number(w)))
    .sort((a, b) => Number(a) - Number(b));
}

// ============== 访问验证（Basic Auth） ==============
// AUTH_USERS secret 格式："user1:pass1,user2:pass2"，未配置时不启用验证
function checkAuth(request, env) {
  const users = (env.AUTH_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (users.length === 0) return true;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  return users.includes(decoded);
}

export default {
  async fetch(request, env, ctx) {
    if (!checkAuth(request, env)) {
      return new Response("\u9700\u8981\u767b\u5f55", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Dashboard", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

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
      <h1>小金商户用户跟踪 · 数据看板</h1>
      <div class="header-meta">
        <span>数据来源：明道云</span>
        <button class="refresh-btn" onclick="refreshData()">刷新数据</button>
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
      <div class="chart-card">
        <h3>跟进人统计</h3>
        <canvas id="creatorChart"></canvas>
      </div>
      <div class="chart-card chart-card-wide">
        <h3>启动状态</h3>
        <canvas id="startupChart"></canvas>
      </div>
      <div class="chart-card chart-card-wide">
        <h3>各周趋势 · 按分类</h3>
        <canvas id="weeklyChart"></canvas>
      </div>
    </div>


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
