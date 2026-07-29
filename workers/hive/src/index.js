// AI 会话质检看板 — 数据源：金数据表单 EQca39
const FORM_TOKEN = "EQca39";
const JSJ_BASE = `https://next.jinshuju.net/api/v1/forms/${FORM_TOKEN}/entries`;
const JSJ_TABLE_URL = `https://next.jinshuju.net/tables/${FORM_TOKEN}`;

const K_STATS = "hive:stats:v1";
const K_ENTRIES = "hive:entries:v1";
const K_META = "hive:meta:v1";

// 金数据 per_page 实际封顶 50；next 是 serial_number 偏移，可并行取页
const PAGE_SIZE = 50;
const CONCURRENCY = 10;
const RUNNING_TTL_MS = 5 * 60 * 1000;

// 可避免的转人工原因（AI 本可以接住）
const AVOIDABLE_REASONS = new Set([
  "AI能答没给机会",
  "没等答完/顺手转",
  "可自助",
  "答对仍要人",
]);

// ============== 取数 ==============

async function fetchPage(auth, next) {
  const url = next ? `${JSJ_BASE}?next=${encodeURIComponent(next)}` : JSJ_BASE;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "User-Agent": "WDL-Hive-QC/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`JinShuJu API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.json();
}

async function fetchAllEntries(env) {
  const auth = btoa(`${env.JSJ_API_KEY}:${env.JSJ_API_SECRET}`);
  const seen = new Set();
  const rows = [];
  let maxNext = null;

  const absorb = (page) => {
    for (const e of page.data || []) {
      // token 在这张表里多为 null，用 serial_number 去重
      const key = e.serial_number ?? e.token;
      if (key === null || key === undefined || seen.has(key)) continue;
      seen.add(key);
      rows.push(trim(e));
    }
    if (page.next && (maxNext === null || Number(page.next) > Number(maxNext))) {
      maxNext = page.next;
    }
  };

  const first = await fetchPage(auth, null);
  const total = first.total || 0;
  absorb(first);

  // 并行按偏移取剩余页（页区间跨度 ≥ 步长，序号有空洞也不会漏，重复由 token 去重）
  const offsets = [];
  for (let o = PAGE_SIZE + 1; o <= total; o += PAGE_SIZE) offsets.push(o);
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const pages = await Promise.all(
      offsets.slice(i, i + CONCURRENCY).map((o) => fetchPage(auth, o))
    );
    pages.forEach(absorb);
  }

  // 兜底：仍有缺口时顺序补拉
  let guard = 0;
  while (rows.length < total && maxNext && guard < 100) {
    const page = await fetchPage(auth, maxNext);
    const before = rows.length;
    absorb(page);
    guard++;
    if (rows.length === before && !page.next) break;
  }

  return { rows, total };
}

// 精简条目：只留看板/明细要用的字段，控制 KV value 体积
function trim(e) {
  return {
    sn: e.serial_number,
    t: e.field_1 || "",
    url: e.field_2 || "",
    ch: e.field_4 || "未知",
    dev: e.field_5 || "未知",
    med: e.field_6 || "未知",
    st: e.field_7 || "未标记",
    plan: e.field_10 || "未知",
    sm: e.field_11 || "",
    dur: typeof e.field_12 === "number" ? e.field_12 : null,
    turns: typeof e.field_13 === "number" ? e.field_13 : null,
    nat: e.field_14 || "未标记",
    scene: e.field_15 || "未分类",
    cat: e.field_16 || "无关",
    jiri: e.field_17 || "未标记",
    way: e.field_18 || "",
    reason: e.field_19 || "",
    creator: e.creator_name || "未知",
  };
}

// ============== 聚合 ==============

function tally(target, key) {
  const k = key === "" || key === null || key === undefined ? "未标记" : key;
  target[k] = (target[k] || 0) + 1;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function buildStats(rows) {
  const s = {
    total: rows.length,
    jiri: {}, way: {}, reason: {}, avoidable: 0, transferred: 0,
    daily: {}, channel: {}, device: {}, medium: {}, status: {},
    scene: {}, plan: {}, sceneByPlan: {}, xjCategory: {},
    nature: {}, durSum: 0, durCount: 0, turnsSum: 0, creator: {},
  };
  const durations = [];

  for (const r of rows) {
    tally(s.jiri, r.jiri);
    tally(s.status, r.st);
    tally(s.channel, r.ch);
    tally(s.device, r.dev);
    tally(s.medium, r.med);
    tally(s.scene, r.scene);
    tally(s.plan, r.plan);
    tally(s.xjCategory, r.cat);
    tally(s.nature, r.nat);
    tally(s.creator, r.creator);
    if (r.t) tally(s.daily, r.t.slice(0, 10));

    if (r.way) { s.transferred++; tally(s.way, r.way); }
    if (r.reason) {
      tally(s.reason, r.reason);
      if (AVOIDABLE_REASONS.has(r.reason)) s.avoidable++;
    }

    if (!s.sceneByPlan[r.scene]) s.sceneByPlan[r.scene] = {};
    s.sceneByPlan[r.scene][r.plan] = (s.sceneByPlan[r.scene][r.plan] || 0) + 1;

    if (typeof r.dur === "number" && r.dur > 0) {
      s.durSum += r.dur;
      s.durCount++;
      durations.push(r.dur);
    }
    if (typeof r.turns === "number") s.turnsSum += r.turns;
  }

  const pct = (n, d) => (d ? Number(((n / d) * 100).toFixed(1)) : 0);
  const effective = s.nature["有效"] || 0;
  // 「Jiri 是否能解答」等字段只在人工质检过的会话上有值，AI 指标按这批口径算
  const labeled = s.total - (s.jiri["未标记"] || 0);

  s.derived = {
    labeledCount: labeled,
    labeledRate: pct(labeled, s.total),
    effectiveCount: effective,
    effectiveRate: pct(effective, s.total),
    transferRate: pct(s.transferred, s.total),
    avoidableCount: s.avoidable,
    avoidableRate: pct(s.avoidable, s.transferred),
    resolveRate: pct(s.jiri["能"] || 0, labeled),
    cannotRate: pct(s.jiri["不能"] || 0, labeled),
    partialRate: pct(s.jiri["部分"] || 0, labeled),
    durSumHours: Number((s.durSum / 3600).toFixed(1)),
    durAvg: s.durCount ? Math.round(s.durSum / s.durCount) : 0,
    durMedian: median(durations),
    turnsAvg: s.total ? Number((s.turnsSum / s.total).toFixed(2)) : 0,
  };

  return s;
}

// ============== 缓存 ==============

async function readMeta(env) {
  return (await env.CACHE.get(K_META, { type: "json" })) || null;
}

async function refreshCache(env) {
  const startedAt = Date.now();
  await env.CACHE.put(
    K_META,
    JSON.stringify({ status: "running", startedAt, startedAtIso: new Date(startedAt).toISOString() })
  );

  try {
    const { rows, total } = await fetchAllEntries(env);
    rows.sort((a, b) => (b.t || "").localeCompare(a.t || ""));
    const stats = buildStats(rows);
    const meta = {
      status: "ok",
      updatedAt: new Date().toISOString(),
      total: rows.length,
      reportedTotal: total,
      tookMs: Date.now() - startedAt,
    };
    await Promise.all([
      env.CACHE.put(K_STATS, JSON.stringify(stats)),
      env.CACHE.put(K_ENTRIES, JSON.stringify(rows)),
      env.CACHE.put(K_META, JSON.stringify(meta)),
    ]);
    console.log("[refresh] ok", JSON.stringify(meta));
    return meta;
  } catch (err) {
    const meta = {
      status: "error",
      error: err.message,
      failedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
    };
    await env.CACHE.put(K_META, JSON.stringify(meta));
    console.error("[refresh] failed:", err.message);
    return meta;
  }
}

function isRunning(meta) {
  return !!meta && meta.status === "running" && Date.now() - (meta.startedAt || 0) < RUNNING_TTL_MS;
}

// 缓存缺失时后台起一次刷新，不阻塞当前请求
function kickoff(env, ctx, meta) {
  if (isRunning(meta)) return false;
  ctx.waitUntil(refreshCache(env));
  return true;
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

// ============== 页面 ==============

async function renderPage(env) {
  const [cssUrl, jsUrl] = await Promise.all([
    env.ASSETS.url("/hive.css"),
    env.ASSETS.url("/hive.js"),
  ]);

  return new Response(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 会话质检看板</title>
<link rel="stylesheet" href="${cssUrl}">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
</head>
<body>
<header class="header">
  <div class="header-inner">
    <h1>AI 会话质检看板</h1>
    <div class="header-meta">
      <span id="updatedAt">—</span>
      <button class="btn" id="refreshBtn">重新拉取数据</button>
    </div>
  </div>
</header>

<main class="main">
  <div id="banner" class="banner" hidden></div>

  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button class="tab active" data-tab="ai">AI 能力与转人工</button>
    <button class="tab" data-tab="trend">会话量趋势与来源</button>
    <button class="tab" data-tab="scene">业务场景与套餐</button>
    <button class="tab" data-tab="cost">人工成本</button>
  </nav>

  <section class="panel active" id="panel-ai">
    <div class="grid">
      <div class="chart-card"><h3>Jiri 是否能解答</h3><canvas id="chartJiri"></canvas></div>
      <div class="chart-card"><h3>转人工方式</h3><canvas id="chartWay"></canvas></div>
      <div class="chart-card wide"><h3>转人工原因分布</h3><canvas id="chartReason"></canvas></div>
    </div>
    <div class="note" id="noteAvoidable"></div>
  </section>

  <section class="panel" id="panel-trend">
    <div class="grid">
      <div class="chart-card wide"><h3>每日会话量</h3><canvas id="chartDaily"></canvas></div>
      <div class="chart-card"><h3>渠道分布</h3><canvas id="chartChannel"></canvas></div>
      <div class="chart-card"><h3>设备分布</h3><canvas id="chartDevice"></canvas></div>
      <div class="chart-card"><h3>处理状态（仅人工 / 仅 Jiri）</h3><canvas id="chartStatus"></canvas></div>
      <div class="chart-card wide"><h3>入口媒介 Top 12</h3><canvas id="chartMedium"></canvas></div>
    </div>
  </section>

  <section class="panel" id="panel-scene">
    <div class="grid">
      <div class="chart-card wide"><h3>业务场景分布</h3><canvas id="chartScene"></canvas></div>
      <div class="chart-card"><h3>当前套餐分布</h3><canvas id="chartPlan"></canvas></div>
      <div class="chart-card"><h3>小金商户分类</h3><canvas id="chartXj"></canvas></div>
      <div class="chart-card wide">
        <h3>业务场景 × 套餐</h3>
        <div class="table-wrapper compact"><table id="crossTable"></table></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-cost">
    <div class="grid">
      <div class="chart-card"><h3>会话性质分布</h3><canvas id="chartNature"></canvas></div>
      <div class="chart-card"><h3>质检人统计</h3><canvas id="chartCreator"></canvas></div>
      <div class="chart-card wide"><h3>人工接待时长概览</h3><div id="costSummary" class="stat-list"></div></div>
    </div>
  </section>

  <h2 class="section-title">会话明细</h2>
  <div class="filters">
    <select id="fChannel"><option value="">全部渠道</option></select>
    <select id="fScene"><option value="">全部业务场景</option></select>
    <select id="fNature"><option value="">全部会话性质</option></select>
    <select id="fJiri"><option value="">Jiri 解答情况</option></select>
    <input type="text" id="fSearch" placeholder="搜索一句话总结 / 转人工原因…">
    <span class="entry-count" id="entryCount"></span>
  </div>
  <div class="table-wrapper">
    <table class="entries-table">
      <thead><tr>
        <th>#</th><th>会话时间</th><th>渠道</th><th>设备</th><th>套餐</th>
        <th>业务场景</th><th>性质</th><th>Jiri</th><th>转人工原因</th>
        <th>人工时长</th><th>一句话总结</th><th>链接</th>
      </tr></thead>
      <tbody id="entriesBody"></tbody>
    </table>
  </div>
  <div class="pagination" id="pagination"></div>

  <div class="loading-overlay" id="loading" hidden><div class="spinner"></div><div>加载中…</div></div>
</main>

<footer class="footer"><p>Powered by WDL</p></footer>
<script>window.JSJ_TABLE_URL = ${JSON.stringify(JSJ_TABLE_URL)};</script>
<script src="${jsUrl}"></script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ============== 访问验证（Basic Auth，与 app worker 一致） ==============
// AUTH_USERS secret 格式："user1:pass1,user2:pass2"，未配置时不启用验证
function checkAuth(request, env) {
  const users = (env.AUTH_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (users.length === 0) return true;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    return users.includes(atob(header.slice(6)));
  } catch {
    return false;
  }
}

// ============== 路由 ==============

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },

  async fetch(request, env, ctx) {
    if (!checkAuth(request, env)) {
      return new Response("需要登录", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Hive QC Dashboard", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/dashboard") {
      const [stats, meta] = await Promise.all([
        env.CACHE.get(K_STATS, { type: "json" }),
        readMeta(env),
      ]);
      if (!stats) {
        kickoff(env, ctx, meta);
        return json({ success: true, building: true, meta: await readMeta(env) });
      }
      return json({ success: true, stats, meta });
    }

    if (path === "/api/entries") {
      const rows = await env.CACHE.get(K_ENTRIES, { type: "json" });
      if (!rows) {
        kickoff(env, ctx, await readMeta(env));
        return json({ success: true, building: true, total: 0, page: 1, totalPages: 1, data: [] });
      }

      const q = url.searchParams;
      const page = Math.max(1, parseInt(q.get("page") || "1", 10));
      const perPage = Math.min(100, Math.max(1, parseInt(q.get("per_page") || "25", 10)));
      const channel = q.get("channel") || "";
      const scene = q.get("scene") || "";
      const nature = q.get("nature") || "";
      const jiri = q.get("jiri") || "";
      const search = (q.get("search") || "").toLowerCase();

      let filtered = rows;
      if (channel) filtered = filtered.filter((r) => r.ch === channel);
      if (scene) filtered = filtered.filter((r) => r.scene === scene);
      if (nature) filtered = filtered.filter((r) => r.nat === nature);
      if (jiri) filtered = filtered.filter((r) => r.jiri === jiri);
      if (search) {
        filtered = filtered.filter(
          (r) =>
            (r.sm && r.sm.toLowerCase().includes(search)) ||
            (r.reason && r.reason.toLowerCase().includes(search))
        );
      }

      const total = filtered.length;
      const start = (page - 1) * perPage;
      return json({
        success: true,
        total,
        page,
        perPage,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
        data: filtered.slice(start, start + perPage),
      });
    }

    // 后台刷新：立即返回，进度写在 meta 里
    if (path === "/api/refresh") {
      if (request.method !== "POST") return json({ success: false, error: "use POST" }, 405);
      const meta = await readMeta(env);
      if (isRunning(meta)) return json({ success: true, alreadyRunning: true, meta }, 202);
      ctx.waitUntil(refreshCache(env));
      return json({ success: true, started: true }, 202);
    }

    if (path === "/api/status") return json({ success: true, meta: await readMeta(env) });

    if (path === "/") return renderPage(env);

    return new Response("Not Found", { status: 404 });
  },
};
