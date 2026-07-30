// hive 服务看板 — 数据源：金数据表单 EQca39
const FORM_TOKEN = "EQca39";
const JSJ_BASE = `https://next.jinshuju.net/api/v1/forms/${FORM_TOKEN}/entries`;
const JSJ_TABLE_URL = `https://next.jinshuju.net/tables/${FORM_TOKEN}`;

const K_STATS = "hive:stats:v1";
const K_ENTRIES = "hive:entries:v1";
const K_WEEKLY = "hive:weekly:v1";
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

function numOf(v) {
  const n = Number(String(v ?? "").trim());
  return isFinite(n) ? n : 0;
}

// 精简条目：只留看板/周报要用的字段，控制 KV value 体积
function trim(e) {
  return {
    sn: e.serial_number,
    t: e.field_1 || "",
    url: e.field_2 || "",
    uid: e.field_8 || "",
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

// ISO 周编号，形如 2026W31
function isoWeek(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  if (isNaN(d)) return "";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return t.getUTCFullYear() + "W" + String(1 + Math.round((t - ft) / 604800000)).padStart(2, "0");
}

function bump(obj, k1, k2) {
  const inner = obj[k1] || (obj[k1] = {});
  inner[k2] = (inner[k2] || 0) + 1;
}

function bucket() {
  return { total: 0, dur: 0, durCount: 0, transfer: 0, turns: 0, dev: {}, ch: {}, nat: {} };
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
    nature: {}, durSum: 0, durCount: 0, turnsSum: 0,
    // 按天 / 按周的复合桶，供堆叠柱 + 双轴折线用
    byDay: {}, byWeek: {},
    // 交叉分布
    natureByDevice: {}, natureByChannel: {}, effectiveScene: {},
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

    bump(s.natureByDevice, r.dev, r.nat);
    bump(s.natureByChannel, r.ch, r.nat);
    if (r.nat === "有效") tally(s.effectiveScene, r.scene);

    const day = r.t ? r.t.slice(0, 10) : "";
    if (day) {
      tally(s.daily, day);
      const week = isoWeek(day);
      for (const b of [
        s.byDay[day] || (s.byDay[day] = bucket()),
        week ? (s.byWeek[week] || (s.byWeek[week] = bucket())) : null,
      ]) {
        if (!b) continue;
        b.total++;
        b.dev[r.dev] = (b.dev[r.dev] || 0) + 1;
        b.ch[r.ch] = (b.ch[r.ch] || 0) + 1;
        b.nat[r.nat] = (b.nat[r.nat] || 0) + 1;
        if (typeof r.dur === "number" && r.dur > 0) { b.dur += r.dur; b.durCount++; }
        if (typeof r.turns === "number") b.turns += r.turns;
        if (r.way) b.transfer++;
      }
    }

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

// ============== 周报 ==============

const PCT = (n, d) => (d ? Number(((n / d) * 100).toFixed(1)) : 0);

// 人工必处理场景：目标值 = 第 21 周中位数下降 30% 后的值
const MUST_HUMAN = [
  { scene: "故障/技术", label: "故障", target: 9 },
  { scene: "账务", label: "财务", target: 6 },
  { scene: "违规/申诉/举报", label: "申诉", target: 4 },
  { scene: "小金商户/在线收款", label: "收款", target: 5 },
  { scene: "实名认证/资质", label: "实名", target: 2 },
];

const GUIDE_SCENE = "操作引导/功能咨询";
const GUIDE_TARGET = 10; // 操作引导类人工时长占比目标 ≤10%

// 接待次数取 field_13（转人工会话接待次数）—— field_20/21 在这张表里全为空
// 单次中位 = 每场「时长 ÷ 接待次数」的中位数；单次平均 = 总时长 ÷ 接待次数
function perReception(rows) {
  return rows.filter((r) => r.turns > 0 && r.dur > 0).map((r) => r.dur / r.turns);
}

function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function groupStats(rows) {
  const durSec = rows.reduce((a, r) => a + (r.dur || 0), 0);
  const receptions = rows.reduce((a, r) => a + (r.turns || 0), 0);
  return {
    sessions: rows.length,
    users: new Set(rows.map((r) => r.uid).filter(Boolean)).size,
    receptions,
    durHours: Number((durSec / 3600).toFixed(1)),
    durMin: Math.round(durSec / 60),
    medianMin: Number((median(perReception(rows)) / 60).toFixed(1)),
    avgMin: receptions ? Number((durSec / receptions / 60).toFixed(1)) : 0,
  };
}

function buildWeekly(rows) {
  const grouped = {};
  for (const r of rows) {
    const day = (r.t || "").slice(0, 10);
    if (!day) continue;
    const w = isoWeek(day);
    if (!w) continue;
    (grouped[w] || (grouped[w] = [])).push(r);
  }

  return Object.keys(grouped).sort().map((week) => {
    const all = grouped[week];
    const days = new Set(all.map((r) => r.t.slice(0, 10)));
    const manual = all.filter((r) => r.st === "仅人工");
    const jiri = all.filter((r) => r.st === "仅 Jiri");
    const effManual = manual.filter((r) => r.nat === "有效");
    const effJiri = jiri.filter((r) => r.nat === "有效");
    const users = new Set(all.map((r) => r.uid).filter(Boolean)).size;

    const eff = groupStats(effManual);
    const allManual = groupStats(manual);

    // 有效人工场景 × 工作量（占比按时长）
    const sceneAgg = {};
    for (const r of effManual) {
      const a = sceneAgg[r.scene] || (sceneAgg[r.scene] = { receptions: 0, durSec: 0, rows: [] });
      a.receptions += r.turns || 0;
      a.durSec += r.dur || 0;
      a.rows.push(r);
    }
    const totalDurSec = effManual.reduce((a, r) => a + (r.dur || 0), 0);
    const scenes = Object.entries(sceneAgg).map(([scene, a]) => ({
      scene,
      receptions: a.receptions,
      durMin: Math.round(a.durSec / 60),
      share: totalDurSec ? Number(((a.durSec / totalDurSec) * 100).toFixed(0)) : 0,
      medianMin: Number((median(perReception(a.rows)) / 60).toFixed(1)),
      avgMin: Number((mean(perReception(a.rows)) / 60).toFixed(1)),
    })).sort((x, y) => y.durMin - x.durMin);

    // 仅 Jiri 有效场景
    const jiriScenes = {};
    for (const r of effJiri) jiriScenes[r.scene] = (jiriScenes[r.scene] || 0) + 1;

    const direct = effManual.filter((r) => r.way === "直接转").length;
    const guide = scenes.find((s) => s.scene === GUIDE_SCENE);

    return {
      week,
      dayCount: days.size,
      firstDay: [...days].sort()[0],
      lastDay: [...days].sort().pop(),
      total: all.length,
      users,
      perUser: users ? Number((all.length / users).toFixed(2)) : 0,
      aiOnly: jiri.length,
      aiRate: PCT(jiri.length, all.length),
      manualOnline: manual.length,
      manualRate: PCT(manual.length, all.length),
      formFillers: all.filter((r) => r.nat === "填表人").length,
      productSessions: all.filter((r) => r.nat === "有效").length,
      eff,
      allManual,
      directTransfer: direct,
      directRate: eff.sessions ? Number(((direct / eff.sessions) * 100).toFixed(1)) : 0,
      scenes,
      jiriSceneTotal: effJiri.length,
      jiriScenes: Object.entries(jiriScenes).sort((a, b) => b[1] - a[1]),
      goals: {
        guideShare: guide ? guide.share : 0,
        guideTarget: GUIDE_TARGET,
        mustHuman: MUST_HUMAN.map((m) => {
          const hit = scenes.find((s) => s.scene === m.scene);
          return {
            label: m.label,
            scene: m.scene,
            target: m.target,
            value: hit ? Math.round(hit.medianMin) : null,
            raw: hit ? hit.medianMin : null,
            receptions: hit ? hit.receptions : 0,
          };
        }),
      },
    };
  });
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
      env.CACHE.put(K_WEEKLY, JSON.stringify(buildWeekly(rows))),
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

// ============== 筛选 ==============

const FILTER_KEYS = ["range", "from", "to", "channel", "device", "status", "scene", "nature", "plan", "qc"];

// 数据里最新的一天，用它当「近 N 天」的基准（数据可能滞后，按今天算容易算空）
function latestDayOf(stats) {
  const days = Object.keys(stats?.daily || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return days.length ? days[days.length - 1] : "";
}

// 时间区间在服务端换算，按东八区的「今天」为基准
const iso = (dt) => dt.toISOString().slice(0, 10);
const mkUTC = (y, m, d) => new Date(Date.UTC(y, m, d));
const shift = (dt, n) => mkUTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() + n);

function resolveNamedRange(key) {
  if (!key) return { from: "", to: "" };
  const now = new Date(Date.now() + 8 * 3600000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = mkUTC(y, m, now.getUTCDate());
  const dow = (today.getUTCDay() + 6) % 7; // 周一 = 0
  const q0 = Math.floor(m / 3) * 3;

  switch (key) {
    case "this_week": return { from: iso(shift(today, -dow)), to: iso(today) };
    case "last_week": {
      const s = shift(today, -dow - 7);
      return { from: iso(s), to: iso(shift(s, 6)) };
    }
    case "this_month": return { from: iso(mkUTC(y, m, 1)), to: iso(today) };
    case "last_month": return { from: iso(mkUTC(y, m - 1, 1)), to: iso(mkUTC(y, m, 0)) };
    case "this_quarter": return { from: iso(mkUTC(y, q0, 1)), to: iso(today) };
    case "last_quarter": return { from: iso(mkUTC(y, q0 - 3, 1)), to: iso(mkUTC(y, q0, 0)) };
    case "this_year": return { from: iso(mkUTC(y, 0, 1)), to: iso(today) };
    case "last_year": return { from: iso(mkUTC(y - 1, 0, 1)), to: iso(mkUTC(y - 1, 11, 31)) };
    default: {
      const n = parseInt(key, 10); // 过去 N 天，含今天
      if (n > 0) return { from: iso(shift(today, -(n - 1))), to: iso(today) };
      return { from: "", to: "" };
    }
  }
}

function resolveRange(q) {
  const from = q.get("from") || "";
  const to = q.get("to") || "";
  if (from || to) return { from, to };
  return resolveNamedRange(q.get("range") || "");
}

function facetsOf(stats) {
  if (!stats) return null;
  return {
    channel: stats.channel, device: stats.device, status: stats.status,
    scene: stats.scene, nature: stats.nature, plan: stats.plan,
  };
}

function applyFilters(rows, q, range) {
  const from = (range && range.from) || q.get("from") || "";
  const to = (range && range.to) || q.get("to") || "";
  const ch = q.get("channel") || "";
  const dev = q.get("device") || "";
  const st = q.get("status") || "";
  const scene = q.get("scene") || "";
  const nat = q.get("nature") || "";
  const plan = q.get("plan") || "";
  const qc = q.get("qc") || "";

  return rows.filter((r) => {
    const day = (r.t || "").slice(0, 10);
    if (from && (!day || day < from)) return false;
    if (to && (!day || day > to)) return false;
    if (ch && r.ch !== ch) return false;
    if (dev && r.dev !== dev) return false;
    if (st && r.st !== st) return false;
    if (scene && r.scene !== scene) return false;
    if (nat && r.nat !== nat) return false;
    if (plan && r.plan !== plan) return false;
    if (qc === "labeled" && r.jiri === "未标记") return false;
    if (qc === "unlabeled" && r.jiri !== "未标记") return false;
    return true;
  });
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
  // Chart.js 随静态资源部署，不走公共 CDN（jsdelivr 国内经常卡住，且是阻塞脚本）
  const [cssUrl, jsUrl, chartUrl] = await Promise.all([
    env.ASSETS.url("/hive.css"),
    env.ASSETS.url("/hive.js"),
    env.ASSETS.url("/chart.min.js"),
  ]);

  return new Response(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>hive 服务看板</title>
<link rel="stylesheet" href="${cssUrl}">
<link rel="preload" as="script" href="${chartUrl}">
</head>
<body>
<header class="header">
  <div class="header-inner">
    <h1>hive 服务看板</h1>
    <div class="header-meta">
      <span id="updatedAt">—</span>
      <button class="btn" id="refreshBtn">重新拉取数据</button>
    </div>
  </div>
</header>

<main class="main">
  <div id="banner" class="banner" hidden></div>

  <section class="filterbar">
    <div class="filter-row">
      <select id="fRange" title="时间范围">
        <option value="">全部时间</option>
        <optgroup label="相对区间">
          <option value="7">过去 7 天</option>
          <option value="14" selected>过去 14 天</option>
          <option value="30">过去 30 天</option>
          <option value="60">过去 60 天</option>
          <option value="90">过去 90 天</option>
          <option value="365">过去 365 天</option>
        </optgroup>
        <optgroup label="自然周期">
          <option value="this_week">本周</option>
          <option value="last_week">上周</option>
          <option value="this_month">本月</option>
          <option value="last_month">上个月</option>
          <option value="this_quarter">本季度</option>
          <option value="last_quarter">上季度</option>
          <option value="this_year">本年</option>
          <option value="last_year">去年</option>
        </optgroup>
        <option value="custom">自定义</option>
      </select>
      <input type="date" id="fFrom" title="起始日期">
      <span class="dash">至</span>
      <input type="date" id="fTo" title="截止日期">
      <select id="fDevice" data-dim="device"></select>
      <select id="fScene" data-dim="scene"></select>
      <select id="fNature" data-dim="nature"></select>
      <button class="btn-ghost" id="resetBtn">重置筛选</button>
      <span class="match-info" id="matchInfo"></span>
    </div>
  </section>

  <section class="cards" id="cards"></section>

  <nav class="tabs">
    <button class="tab active" data-tab="weekly">周报</button>
    <button class="tab" data-tab="ai">AI 能力与转人工</button>
    <button class="tab" data-tab="trend">会话量趋势与来源</button>
    <button class="tab" data-tab="scene">业务场景与套餐</button>
    <button class="tab" data-tab="cost">人工成本</button>
  </nav>

  <section class="panel active" id="panel-weekly">
    <div class="report-bar">
      <label>统计周</label>
      <select id="wkSelect"></select>
      <span class="report-hint" id="wkHint"></span>
    </div>

    <div class="report-block">
      <h3>一、目标追踪</h3>
      <div class="table-wrapper"><table class="report-table" id="tblGoals"></table></div>
    </div>

    <div class="report-block">
      <h3>二、周度接待概览</h3>
      <div class="table-wrapper"><table class="report-table" id="tblOverview"></table></div>
    </div>

    <div class="report-block">
      <h3>三、人工接待现状</h3>
      <div class="table-wrapper"><table class="report-table" id="tblManual"></table></div>
      <div class="note" id="manualNote"></div>
    </div>

    <div class="report-block">
      <h3>四、有效人工场景 × 工作量（占比按时长）</h3>
      <div class="table-wrapper"><table class="report-table" id="tblScenes"></table></div>
    </div>

    <div class="report-block">
      <h3>五、仅 Jiri 有效场景</h3>
      <div class="table-wrapper"><table class="report-table" id="tblJiriScenes"></table></div>
    </div>
  </section>

  <section class="panel" id="panel-ai">
    <div class="grid">
      <div class="chart-card"><h3>Jiri 是否能解答</h3><canvas id="chartJiri"></canvas></div>
      <div class="chart-card"><h3>转人工方式</h3><canvas id="chartWay"></canvas></div>
      <div class="chart-card"><h3>最后接待对象（仅人工 / 仅 Jiri）</h3><canvas id="chartStatus"></canvas></div>
      <div class="chart-card wide"><h3>转人工原因分布</h3><canvas id="chartReason"></canvas></div>
    </div>
    <div class="note" id="noteAvoidable"></div>
  </section>

  <section class="panel" id="panel-trend">
    <div class="grid">
      <div class="chart-card wide tall">
        <div class="chart-head"><h3>会话接待分布（按天）</h3><span class="chart-total" id="totalDayRecept"></span></div>
        <canvas id="chartDayRecept"></canvas>
      </div>
      <div class="chart-card wide">
        <div class="chart-head"><h3>每周会话来源</h3><span class="chart-total" id="totalWeekChannel"></span></div>
        <canvas id="chartWeekChannel"></canvas>
      </div>
      <div class="chart-card wide">
        <div class="chart-head"><h3>会话分布（渠道 × 会话性质）</h3><span class="chart-total" id="totalChannelNature"></span></div>
        <canvas id="chartChannelNature"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-head"><h3>设备 × 会话性质</h3><span class="chart-total" id="totalDeviceNature"></span></div>
        <canvas id="chartDeviceNature"></canvas>
      </div>
      <div class="chart-card"><h3>入口媒介 Top 12</h3><canvas id="chartMedium"></canvas></div>
    </div>
  </section>

  <section class="panel" id="panel-scene">
    <div class="grid">
      <div class="chart-card">
        <div class="chart-head"><h3>有效会话场景</h3><span class="chart-total" id="totalEffScene"></span></div>
        <canvas id="chartEffScene"></canvas>
      </div>
      <div class="chart-card">
        <div class="chart-head"><h3>会话性质</h3><span class="chart-total" id="totalNature2"></span></div>
        <canvas id="chartNature2"></canvas>
      </div>
      <div class="chart-card"><h3>当前套餐分布</h3><canvas id="chartPlan"></canvas></div>
      <div class="chart-card">
        <div class="chart-head"><h3>小金商户分类</h3><span class="chart-total" id="totalXj"></span></div>
        <canvas id="chartXj"></canvas>
      </div>
      <div class="chart-card wide"><h3>业务场景分布（全部会话）</h3><canvas id="chartScene"></canvas></div>
      <div class="chart-card wide">
        <h3>业务场景 × 套餐</h3>
        <div class="table-wrapper compact"><table id="crossTable"></table></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-cost">
    <div class="grid">
      <div class="chart-card wide">
        <div class="chart-head">
          <h3>会话接待分布（按周）</h3>
          <span class="chart-total" id="totalWeekRecept"></span>
        </div>
        <canvas id="chartWeekRecept"></canvas>
      </div>
      <div class="chart-card wide">
        <div class="chart-head">
          <h3>会话时长（按周 · 会话性质堆叠 + 单会话平均时长）</h3>
          <span class="chart-total" id="totalWeekDur"></span>
        </div>
        <canvas id="chartWeekDur"></canvas>
      </div>
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>每日人工接待时长与转人工次数</h3>
          <span class="chart-total" id="totalDayCost"></span>
          <span class="chart-hint" id="hintDayCost"></span>
        </div>
        <canvas id="chartDayCost"></canvas>
      </div>
    </div>
  </section>

</main>

<footer class="footer"><p>Powered by WDL</p></footer>
<script>window.JSJ_TABLE_URL = ${JSON.stringify(JSJ_TABLE_URL)};</script>
<script defer src="${chartUrl}"></script>
<script defer src="${jsUrl}"></script>
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
          "WWW-Authenticate": 'Basic realm="hive Dashboard", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/dashboard") {
      const q = url.searchParams;
      const hasFilter = FILTER_KEYS.some((k) => q.get(k));

      // 无筛选走预聚合缓存（几 KB，最快）；有筛选才读明细现算
      if (!hasFilter) {
        const [stats, meta] = await Promise.all([
          env.CACHE.get(K_STATS, { type: "json" }),
          readMeta(env),
        ]);
        if (!stats) {
          kickoff(env, ctx, meta);
          return json({ success: true, building: true, meta: await readMeta(env) });
        }
        return json({
          success: true, stats, meta, filtered: false,
          matched: stats.total, fullTotal: stats.total,
          facets: facetsOf(stats), latestDay: latestDayOf(stats),
        });
      }

      const [rows, full, meta] = await Promise.all([
        env.CACHE.get(K_ENTRIES, { type: "json" }),
        env.CACHE.get(K_STATS, { type: "json" }),
        readMeta(env),
      ]);
      if (!rows) {
        kickoff(env, ctx, meta);
        return json({ success: true, building: true, meta: await readMeta(env) });
      }
      const range = resolveRange(q);
      const filtered = applyFilters(rows, q, range);
      return json({
        success: true,
        stats: buildStats(filtered),
        meta,
        filtered: true,
        matched: filtered.length,
        fullTotal: rows.length,
        facets: facetsOf(full),
        latestDay: latestDayOf(full),
        resolvedFrom: range.from,
        resolvedTo: range.to,
      });
    }

    if (path === "/api/weekly") {
      const [weekly, meta] = await Promise.all([
        env.CACHE.get(K_WEEKLY, { type: "json" }),
        readMeta(env),
      ]);
      if (!weekly) {
        kickoff(env, ctx, meta);
        return json({ success: true, building: true, meta: await readMeta(env) });
      }
      return json({ success: true, weeks: weekly, meta });
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
