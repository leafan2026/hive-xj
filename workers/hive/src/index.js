// hive 服务看板 — 数据源：金数据表单 EQca39
const FORM_TOKEN = "EQca39";
const JSJ_BASE = `https://next.jinshuju.net/api/v1/forms/${FORM_TOKEN}/entries`;

// v6 在 manualBusy 里下发时段定义（起点/格宽/格数），前端不再硬编码。
// v3 的明细去掉了全链路无消费者的 sn/url/sm/inWindow/creator。
// v7 / v4（2026-09-17）：明细加回 url（会话地址）并新增 rep/repFrom（复问、复问自，读质检表 field_33/34），
// 日/周桶新增 rep（复问数），stats 新增 repeats 明细。weekly v2：目标追踪加 guideSplit（操作引导占比按 Jiri 能否解答拆分）；v3：加 jiri（JIRI 接待现状板块，读 field_35/36）；v4：加 agents/agentsCum（客服接待评估，读 field_37~39）；stats v8 / entries v5 / weekly v5（2026-09-18）：明细加 emo（field_40 用户情绪），新增 秒转·可解答、客服×场景时长、用户情绪三项。
// **stats v9 / weekly v6 / q v4（2026-09-18 当天）：教训——同日把 agentScene 转置成 {agents, rows}、emotion 加 pairs/negRate，
// 改了 payload 形状却没 bump 键，结果页面是新前端 + 旧形状缓存，两张表直接空白。
// 规矩：`buildStats` / `weekMetrics` 的返回结构一改，就必须 bump 对应的键，不能只靠"点一次重新拉取数据"。**
// 旧 v3 明细没有这些字段，读到会把复问率画成全 0，所以三个键一起换，让首次访问后台重建。
// 保留旧版本键，不删除既有 KV，首次访问会安全地后台重建新缓存。
// 2026-09-18 补：bump 之后页面卡在「正在构建」整整几小时，原因是后台刷新死在半路、
// meta 一直停在 running 把重试全挡掉。现在 stats/weekly/loop 缺失时会直接从 K_ENTRIES 现算（见「派生」），
// 所以只有 K_ENTRIES 这个键是真正要靠拉数重建的，另外三个换键已经不会再让页面空着。
// stats v10 / weekly v7 / q v5（2026-09-18）：情绪里加 emoList（负向 + 正向会话的时间/地址/末接客服），照规矩 bump。
// entries v6 / stats v11 / q v6（2026-10-13 改版）：明细加 sum（field_11 一句话总结），复问明细改成按「复问链」合并：
// 一行 = 首次提问摘要 + 复问了几次 + 最后一次谁接的。明细多了一个字段，所以 K_ENTRIES 也要换键、重新拉数。
const K_STATS = "hive:stats:v15";
// entries v7（2026-10-21）：明细改成按月分块存，K_ENTRIES 只放清单，见「明细分块存储」。
// entries v8（2026-10-21）：明细加 sn（金数据 serial_number），按「最后更新时间」增量同步要靠它合并，见「增量同步」。
const K_ENTRIES = "hive:entries:v8";
const K_WEEKLY = "hive:weekly:v7";
const K_LOOP = "hive:loop:v1";
const K_META = "hive:meta:v1";
// 筛选结果记忆缓存：键里带 meta.updatedAt，数据一刷新自然失效；
// TTL 只用来回收过期键，不承担正确性。
const K_QUERY_PREFIX = "hive:q:v11:";   // v11：响应里加了 series（总览条带的全序列日桶）
// 固定口径的「最近 24 周」stats（2026-10-14 用户定：接待量页的三张图和总览的接待人数图不随筛选），按数据版本缓存
const K_FIXED_PREFIX = "hive:fixed:v2:";
const FIXED_WEEKS = 24;
// 总览「会话接待分布」下方条带的全序列：最近 52 周（筛选区间更早时往前延到筛选起点），只套维度筛选、不套日期
const SERIES_DAYS = 364;
const QUERY_CACHE_TTL_S = 3600;

// 金数据 per_page 实际封顶 50；next 是 serial_number 偏移，可并行取页
const PAGE_SIZE = 50;
const CONCURRENCY = 10;
const PAGE_TIMEOUT_MS = 20 * 1000;
// 全量刷新实测 25～40 秒。超过 2 分钟还停在 running，就是后台任务已经死了
// （被运行时回收或某页挂死），这时必须允许再起一次，而不是让页面干等。
const RUNNING_TTL_MS = 2 * 60 * 1000;

// 可避免的转人工原因（AI 本可以接住）
const AVOIDABLE_REASONS = new Set([
  "AI能答没给机会",
  "没等答完/顺手转",
  "可自助",
  "答对仍要人",
]);

// ============== 取数 ==============

// 一页最多等 PAGE_TIMEOUT_MS。没有超时的话，只要有一页挂住不返回，
// 整个 refreshCache 就永远不结束，meta 会一直停在 running、把后续刷新全挡掉（2026-09-18 的故障现场）。
// params：{ next, filters }。带 filters 时金数据的 next 是行偏移，不再是 serial_number。
async function fetchPage(auth, next, filters) {
  const qs = new URLSearchParams();
  if (next !== null && next !== undefined) qs.set("next", String(next));
  if (filters) qs.set("filters", JSON.stringify(filters));
  const url = qs.toString() ? `${JSJ_BASE}?${qs}` : JSJ_BASE;
  let lastErr;
  for (let 第几次 = 0; 第几次 < 2; 第几次++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "User-Agent": "WDL-Hive-QC/1.0",
        },
      });
      if (!res.ok) {
        throw new Error(`JinShuJu API ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`取页失败（${filters ? "增量 " : ""}${next ?? "首页"}）：${lastErr && lastErr.message}`);
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

// ============== 增量同步（2026-10-21） ==============
// 全量拉一次要 600 多页、25～40 秒，而数据源一天只进一两批新会话；老会话也会被回填改动
// （实测 10-04 改了 26 天前的记录、10-21 改了 8 天前的），所以不能按「N 天前冻结」，
// 改为按金数据的「最后更新时间」只拉上次同步之后新增或改过的记录，按 sn 合并进已存明细。
// 增量看不到删除，所以每天北京时间 FULL_SYNC_HOUR 点后的第一次刷新、或手动「重新拉取数据」走全量。
const SYNC_OVERLAP_MS = 10 * 60 * 1000;   // 游标往回多拉 10 分钟，盖住时钟误差和同步期间正在写入的记录
const FULL_SYNC_HOUR = 3;                 // 数据源每天约 04:30 进批量，凌晨 3 点后全量一次
const INCR_MAX_ROWS = 3000;               // 改动超过这个数（顺序 60 页）就直接走全量

// 金数据的时间参数按北京时间解析
function bjTime(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

async function fetchUpdatedSince(env, sinceMs) {
  const auth = btoa(`${env.JSJ_API_KEY}:${env.JSJ_API_SECRET}`);
  const filters = [{ field: "updated_at", operator: "gte", value: bjTime(sinceMs) }];
  const seen = new Set();
  const rows = [];
  const absorb = (page) => {
    for (const e of page.data || []) {
      const key = e.serial_number;
      if (key === null || key === undefined || seen.has(key)) continue;
      seen.add(key);
      rows.push(trim(e));
    }
  };
  const first = await fetchPage(auth, null, filters);
  const total = first.total || 0;
  // 改动太多（大批回填）就不逐页顺序拉了，交给并行的全量，更快
  if (total > INCR_MAX_ROWS) return null;
  absorb(first);
  // 2026-10-22 教训：带 updated_at 筛选时，金数据返回的 next 仍是 serial_number 游标，不是行偏移。
  // 第一版按行偏移并行取，第 2 页起拿到的全是第 1 页的重复，只合并了最早的 50 条，
  // 10-21 那批 205 条新会话整批漏掉、meta 还报 ok。现在只顺着接口返回的 next 一页页走，不自己算偏移。
  let next = first.next;
  for (let guard = 0; next !== null && next !== undefined && rows.length < total && guard < 200; guard++) {
    const page = await fetchPage(auth, next, filters);
    absorb(page);
    if (!page.next || String(page.next) === String(next) || !(page.data || []).length) break;
    next = page.next;
  }
  // 少拉一条都不合并：宁可这次报错、页面停在上一版，也不能悄悄漏数据
  if (rows.length < total) throw new Error(`增量只拉到 ${rows.length} / ${total} 条，本次不合并`);
  return { rows, total };
}

// 精简条目：只留看板/周报要用的字段，控制 KV value 体积。
// 只保留有消费者的字段 —— 明细每多一个字段，筛选路径就要多解析 6600 次。
function trim(e) {
  return {
    sn: e.serial_number,            // 增量同步按它合并同一条记录
    t: e.field_1 || "",
    url: e.field_2 || "",           // 会话地址，只有「复问明细」表消费（复问自 指向的也是它）
    uid: e.field_8 || "",
    baid: e.field_9 || "",          // billing_account_id，用于「接待企业数」去重
    ch: e.field_4 || "未知",
    dev: e.field_5 || "未知",
    med: e.field_6 || "未知",
    st: e.field_7 || "未标记",
    plan: e.field_10 || "免费版",   // 套餐为空即未付费，归入免费版
    dur: typeof e.field_12 === "number" ? e.field_12 : null,
    turns: typeof e.field_13 === "number" ? e.field_13 : null,
    nat: e.field_14 || "未标记",
    scene: e.field_15 || "未分类",
    cat: e.field_16 || "无关",
    jiri: e.field_17 || "未标记",
    way: e.field_18 || "",
    reason: e.field_19 || "",
    biz: e.field_22 || "",          // 业务分型
    onTarget: e.field_23 || "",     // 对口建表
    gotData: e.field_25 || "",      // 对口表单收数据
    jiriBuilt: e.field_27 || "",    // Jiri 代建表单
    loop: e.field_30 || "",         // 业务闭环
    sum: String(e.field_11 || "").trim().slice(0, 120),  // 一句话总结：复问明细的「首次提问摘要」，只留 120 字控制 KV 体积
    rep: e.field_33 === "是",       // 复问（上游 算复问.py 算好写回：同用户隔 6~36h 再进线且一句话总结相似）
    repFrom: e.field_34 || "",      // 复问自：前一场会话地址
    uturns: e.field_35 === "" || e.field_35 === null || e.field_35 === undefined || isNaN(Number(e.field_35)) ? null : Number(e.field_35),  // 用户轮次（客户说话条数，上游 推轮次与at到质检表.py）
    atJiri: e.field_36 === "是",    // 人工中@jiri：仅人工会话里客服有没有 @jiri
    csFirst: e.field_37 || "",      // 首接客服（仅人工行；上游从转录发言人读）
    csLast: e.field_38 || "",       // 末接客服
    csAll: Array.isArray(e.field_39) ? e.field_39 : (e.field_39 ? [e.field_39] : []),  // 全部客服（多选）
    emo: e.field_40 || "",          // 用户情绪（负向/中性/正向；系统自动标注，第 31 周起 100% 覆盖）
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

// "2026-08-04" → 该粒度下的周期键。客户端 periodKeyOf 必须与此保持一致。
function periodKeyOf(day, grain) {
  switch (grain) {
    case "week":    return isoWeek(day);
    case "month":   return day.slice(0, 7);
    case "quarter": return day.slice(0, 4) + "-Q" + (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1);
    case "year":    return day.slice(0, 4);
    default:        return day;
  }
}

const UNIQ_GRAINS = ["day", "week", "month", "quarter", "year"];

function bump(obj, k1, k2) {
  const inner = obj[k1] || (obj[k1] = {});
  inner[k2] = (inner[k2] || 0) + 1;
}

function bucket() {
  return {
    total: 0, dur: 0, durCount: 0, transfer: 0, turns: 0,
    aiOnly: 0, avoidable: 0,
    rep: 0,                        // 复问会话数（质检表 field_33=是）
    // 人工有效·秒转·jiri 可解答：sjBase = 有效人工场次（分母），sj = 其中「直接转 且 Jiri能答」
    sj: 0, sjBase: 0,
    // AI 表现「人工有效 · 秒转 · Jiri 可解答」三条周走势：manual = 仅人工场次，effManual = 其中有效，
    // direct = 有效人工里「直接转」的场次，canA / canBase = 转人工会话里 Jiri 标了「能」/ 标了能否的场次
    manual: 0, effManual: 0, direct: 0, canA: 0, canBase: 0,
    dev: {}, ch: {}, nat: {}, natDur: {},
    med: {},                       // 入口媒介 → 会话数（接待量页「入口媒介 · 最近 9 周」矩阵用，2026-10-14 加）
  };
}

function timestampDayMinute(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? { day: match[1], hour, minute: hour * 60 + minute }
    : null;
}

// 忙闲图：全天 96 个 15 分钟格（2026-10 改版前只看 09:30–19:00、最近 7 天；现在看整个筛选区间，分工作日 / 周末取日均）
const BUSY_SLOT_MINUTES = 15;
const BUSY_SLOT_COUNT = (24 * 60) / BUSY_SLOT_MINUTES;
const BUSY_CAPACITY = 6;   // 在岗容量：同时在线人工会话超过这个数就算超负荷（2026-10-13 用户定为 6）
// 人工服务页两张时段图（24 小时节奏、忙闲）只看 09:30～18:30（2026-10-13 用户定）；服务端仍按全天 96 格统计，
// 窗口随数据下发，前端照窗口裁，改窗口只改这里
const SERVICE_WINDOW = { start: 9 * 60 + 30, end: 18 * 60 + 30 };

function recentCalendarDays(latestDay, count = 7) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latestDay || "")) return [];
  const end = new Date(latestDay + "T00:00:00Z");
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (count - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// 复问明细：把同一用户的「首问 → 复问 → 再复问」串成一条链，一链一行。
// 复问自（field_34）指向上一场，顺着指针找到链头（第一场不是复问的会话）；链头不在当前筛选范围内时，
// 就以它的地址做键、信息取链里最早那场。返回按最后一次复问时间倒序。
function repeatChains(repRows, rows) {
  const byUrl = new Map();
  for (const r of rows) if (r.url) byUrl.set(r.url, r);
  const chains = new Map();
  for (const r of repRows) {
    let head = r, guard = 0;
    while (head.rep && head.repFrom && byUrl.has(head.repFrom) && guard++ < 20) head = byUrl.get(head.repFrom);
    const key = head.rep ? (head.repFrom || head.url) : head.url;
    const c = chains.get(key) || { first: head.rep ? null : head, firstUrl: head.rep ? head.repFrom : head.url, reps: [] };
    c.reps.push(r);
    chains.set(key, c);
  }
  return [...chains.values()].map((c) => {
    c.reps.sort((a, b) => (a.t || "").localeCompare(b.t || ""));
    const last = c.reps[c.reps.length - 1];
    const src = c.first || c.reps[0];
    return {
      t: last.t,                       // 最后一次复问的时间
      scene: src.scene,                // 首问的业务场景
      q: src.sum || last.sum || "",    // 首次提问摘要（链头不在范围内时退回第一次复问的总结）
      n: c.reps.length,                // 复问了几次
      who: last.st,                    // 最后一次复问是谁接的：仅人工 / 仅 Jiri
      url: last.url,                   // 最后一次复问的会话地址
      from: c.firstUrl,                // 首问的会话地址
    };
  }).sort((a, b) => (b.t || "").localeCompare(a.t || ""));
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
    // 服务节奏（2026-10-14 用户定）：**过去 7 个完整自然日**（不含今天）× 全天 96 个 15 分钟格的人工会话数，按日期排行，
    // 每行一天（days[i] 是 YYYY-MM-DD）；按金数据记录的原始日历时间落格，页面只画 window（09:30～18:30）那一段。
    // 以前是周一～周日按星期几合计整个区间，用户要的是「最近 7 天实时变化」，改回按天。days / manual 在循环结束后填
    hourlyWeek: { days: [], manual: [], slotMinutes: BUSY_SLOT_MINUTES, window: SERVICE_WINDOW },
    // 人工服务忙闲：全天 96 个 15 分钟格，每格 = 同时处于人工接待中的会话数（靠时长铺开，所以只统计有时长的会话），
    // 按「工作日 / 周末」分别对区间内的自然日取平均；noDuration = 没有时长、进不了这张图的仅人工会话数。
    manualBusy: {
      slotMinutes: BUSY_SLOT_MINUTES, slotCount: BUSY_SLOT_COUNT, capacity: BUSY_CAPACITY, window: SERVICE_WINDOW,
      weekday: Array(BUSY_SLOT_COUNT).fill(0), weekend: Array(BUSY_SLOT_COUNT).fill(0),
      weekdayDays: 0, weekendDays: 0, noDuration: 0,
    },
    // 接待人数（user_id 去重）/ 接待企业数（billing_account_id 去重）。
    // 去重计数不能跨周期相加——一个用户在两天各来一次，按天是 2、按月是 1——
    // 所以每个粒度各自去重一次，不能让客户端从日粒度累加。
    uniq: {},
    // 全区间去重总数。各周期的去重数不能相加，所以「总计」必须单独算一份。
    uniqAll: { users: 0, orgs: 0 },
    // 交叉分布
    natureByDevice: {}, natureByChannel: {}, effectiveScene: {},
    // 业务场景分布柱下的「AI 93%」：该场景有效会话里仅 Jiri 接待的场次（Jiri 独立解决率的分子；分母 = effectiveScene）
    effectiveSceneAI: {},
    // 复问明细（时间 / 本场会话地址 / 前一场会话地址），给「复问明细」表；只含 复问=是 的行，量很小
    repeats: [],
  };
  const durations = [];
  const repRows = [];     // 复问=是 的行，循环完再串成复问链
  const daysSeen = new Set();   // 区间内出现过会话的自然日，用来数工作日 / 周末各几天、每个星期几各几天
  const busyByDay = {};         // day → Int32Array(96)，循环完再按日型求平均
  const manualByDay = {};       // day → Int32Array(96)，仅人工会话按记录时间落格，循环完取最近 7 个完整自然日
  const noDurByDay = {};        // day → 没有时长、进不了忙闲图的仅人工会话数
  // 中间态：每个粒度每个周期一组 Set，收尾时转成计数再下发（不然 payload 会很大）
  const uniqSets = {};
  for (const g of UNIQ_GRAINS) uniqSets[g] = {};
  const allUsers = new Set(), allOrgs = new Set();

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
    if (r.nat === "有效") { tally(s.effectiveScene, r.scene); if (r.st === "仅 Jiri") tally(s.effectiveSceneAI, r.scene); }

    const day = r.t ? r.t.slice(0, 10) : "";
    const hourSlot = timestampDayMinute(r.t);
    if (hourSlot) {
      daysSeen.add(hourSlot.day);
      if (r.st === "仅人工") {
        const mslots = manualByDay[hourSlot.day] || (manualByDay[hourSlot.day] = new Int32Array(BUSY_SLOT_COUNT));
        mslots[Math.floor(hourSlot.minute / BUSY_SLOT_MINUTES)]++;
        const hasDuration = typeof r.dur === "number" && r.dur > 0;
        if (!hasDuration) { s.manualBusy.noDuration++; noDurByDay[hourSlot.day] = (noDurByDay[hourSlot.day] || 0) + 1; }
        else {
          // 会话从记录时间起铺到 时长 结束，跨过午夜的部分截掉
          const slots = busyByDay[hourSlot.day] || (busyByDay[hourSlot.day] = new Int32Array(BUSY_SLOT_COUNT));
          const first = Math.floor(hourSlot.minute / BUSY_SLOT_MINUTES);
          const last = Math.min(BUSY_SLOT_COUNT - 1, Math.floor((hourSlot.minute + r.dur / 60 - 1e-9) / BUSY_SLOT_MINUTES));
          for (let index = first; index <= last; index++) slots[index]++;
        }
      }
    }
    if (day) {
      tally(s.daily, day);
      for (const g of UNIQ_GRAINS) {
        const key = periodKeyOf(day, g);
        if (!key) continue;
        const slot = uniqSets[g][key] || (uniqSets[g][key] = { u: new Set(), o: new Set() });
        if (r.uid) slot.u.add(r.uid);
        if (r.baid) slot.o.add(r.baid);
      }
      if (r.uid) allUsers.add(r.uid);
      if (r.baid) allOrgs.add(r.baid);
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
        if (r.med) b.med[r.med] = (b.med[r.med] || 0) + 1;
        if (typeof r.dur === "number" && r.dur > 0) {
          b.dur += r.dur; b.durCount++;
          b.natDur[r.nat] = (b.natDur[r.nat] || 0) + r.dur;   // 各会话性质的人工时长（秒），给「会话时长 · 按周」堆叠
        }
        if (typeof r.turns === "number") b.turns += r.turns;
        if (r.way) b.transfer++;
        if (r.st === "仅 Jiri") b.aiOnly++;
        if (AVOIDABLE_REASONS.has(r.reason)) b.avoidable++;
        if (r.rep) b.rep++;
        if (r.st === "仅人工") {
          b.manual++;
          if (r.nat === "有效") { b.effManual++; if (r.way === "直接转") b.direct++; }
        }
        if (r.way && r.jiri !== "未标记") { b.canBase++; if (r.jiri === "能") b.canA++; }
        if (r.st === "仅人工" && r.nat === "有效") {
          b.sjBase += receptions(r);
          if (isSecondTransfer(r)) b.sj += receptions(r);
        }
      }
      if (r.rep) repRows.push(r);
    }

    if (r.way) { s.transferred++; tally(s.way, r.way); }
    if (r.reason) {
      tally(s.reason, r.reason);
      if (AVOIDABLE_REASONS.has(r.reason)) s.avoidable++;
    }

    // 交叉表只算有效会话，和「业务场景分布（有效会话）」对齐，
    // 否则未质检的「未分类」会占掉一整行
    if (r.nat === "有效") {
      if (!s.sceneByPlan[r.scene]) s.sceneByPlan[r.scene] = {};
      s.sceneByPlan[r.scene][r.plan] = (s.sceneByPlan[r.scene][r.plan] || 0) + 1;
    }

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

  const aiOnly = s.status["仅 Jiri"] || 0;
  const manualOnly = s.status["仅人工"] || 0;

  s.derived = {
    aiOnlyCount: aiOnly,
    aiRate: pct(aiOnly, s.total),
    manualCount: manualOnly,
    manualRate: pct(manualOnly, s.total),
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

  // Set → 计数。只下发数字，payload 与粒度数成正比而与会话量无关。
  for (const g of UNIQ_GRAINS) {
    const out = {};
    for (const [key, slot] of Object.entries(uniqSets[g])) {
      out[key] = { users: slot.u.size, orgs: slot.o.size };
    }
    s.uniq[g] = out;
  }
  s.uniqAll = { users: allUsers.size, orgs: allOrgs.size };
  s.repeats = repeatChains(repRows, rows);

  // 忙闲：按日型求平均。分母是区间内**有会话的**自然日（不是日历天数：区间首尾不完整，也避免长区间里的假期把平均摊薄）
  // 服务节奏：最近 7 个完整自然日 = 以「昨天」（北京时间）和区间内最晚一天中较早者为末日，往前数 7 天；没数据的天也占一行
  {
    const seen = [...daysSeen].sort();
    const yesterday = shiftDay(todayInShanghai(), -1);
    const end = seen.length && seen[seen.length - 1] < yesterday ? seen[seen.length - 1] : yesterday;
    const days = Array.from({ length: 7 }, (_, i) => shiftDay(end, i - 6));
    s.hourlyWeek.days = days;
    s.hourlyWeek.manual = days.map((d) => Array.from(manualByDay[d] || new Int32Array(BUSY_SLOT_COUNT)));
    // 人工服务忙闲（2026-10-14 用户定）：只看最近一个完整自然日（同上面的末日），每格 = 当时同时处于人工接待中的会话数，不再按日型平均
    s.manualBusy.day = end;
    s.manualBusy.slots = Array.from(busyByDay[end] || new Int32Array(BUSY_SLOT_COUNT));
    s.manualBusy.noDurationDay = noDurByDay[end] || 0;
  }
  for (const day of daysSeen) {
    const dow = dowOf(day);
    if (dow < 0) continue;
    const weekend = dow >= 5;
    if (weekend) s.manualBusy.weekendDays++; else s.manualBusy.weekdayDays++;
    const slots = busyByDay[day];
    if (!slots) continue;
    const target = weekend ? s.manualBusy.weekend : s.manualBusy.weekday;
    for (let i = 0; i < BUSY_SLOT_COUNT; i++) target[i] += slots[i];
  }
  s.manualBusy.weekday = s.manualBusy.weekday.map((v) => (s.manualBusy.weekdayDays ? Number((v / s.manualBusy.weekdayDays).toFixed(2)) : 0));
  s.manualBusy.weekend = s.manualBusy.weekend.map((v) => (s.manualBusy.weekendDays ? Number((v / s.manualBusy.weekendDays).toFixed(2)) : 0));
  // 服务概览的两张表：都跑在当前筛选后的行上（区间表、情绪表）
  const manualRows = rows.filter((r) => r.st === "仅人工");
  s.agentScene = agentSceneDuration(manualRows.filter((r) => r.nat === "有效"));
  s.emotion = emotionStats(manualRows);

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

// 操作引导类人工时长占比，按这些会话的「Jiri 是否能解答」标注拆成四段（能 / 不能 / 部分 / 未质检）。
// 分子分母与 sceneWorkload 的 share 完全一致：分母 = 全部有效人工会话时长，分子 = 操作引导类里各标注的时长。
// exact 是一位小数的精确占比；pp 是按「最大余数法」凑成整数、四段之和恰好等于表头那个整数占比（用户定：加起来要等于 22%）。
const GUIDE_LABELS = ["能", "不能", "部分", "未标记"];
function guideSplitOf(effManual, totalShare) {
  const totalSec = effManual.reduce((a, r) => a + (r.dur || 0), 0);
  const sec = { "能": 0, "不能": 0, "部分": 0, "未标记": 0 };
  const cnt = { "能": 0, "不能": 0, "部分": 0, "未标记": 0 };
  for (const r of effManual) {
    if (r.scene !== GUIDE_SCENE) continue;
    const k = GUIDE_LABELS.includes(r.jiri) ? r.jiri : "未标记";
    sec[k] += r.dur || 0;
    cnt[k] += 1;
  }
  const raw = GUIDE_LABELS.map((k) => (totalSec ? (sec[k] / totalSec) * 100 : 0));
  const floors = raw.map((v) => Math.floor(v));
  let rest = Math.max(0, totalShare - floors.reduce((a, b) => a + b, 0));
  const order = raw.map((v, i) => [v - floors[i], i]).sort((x, y) => y[0] - x[0]);
  for (const [, i] of order) { if (rest <= 0) break; floors[i] += 1; rest -= 1; }
  return GUIDE_LABELS.map((k, i) => ({
    label: k, sessions: cnt[k], durMin: Math.round(sec[k] / 60),
    exact: Number(raw[i].toFixed(1)), pp: floors[i],
  }));
}

// 星期序号，周一 = 0
// 「最近 24 周」窗口的起点：本周（北京时间）往前数 23 周的周一
function fixedWindowFrom() {
  const today = todayInShanghai();
  const dow = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;   // 周一 = 0
  return shiftDay(today, -dow - (FIXED_WEEKS - 1) * 7);
}

// 北京时间的今天（YYYY-MM-DD）；金数据记录的时间就是北京时间，两边要一致
function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function shiftDay(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dowOf(day) {
  const d = new Date(day + "T00:00:00Z");
  return isNaN(d) ? -1 : (d.getUTCDay() + 6) % 7;
}

// 周度接待概览的指标 —— 对齐同期时要在子集上重算（对话人数是去重值，不能按天相加）
function overview(rows) {
  const jiri = rows.filter((r) => r.st === "仅 Jiri");
  const manual = rows.filter((r) => r.st === "仅人工");
  const users = new Set(rows.map((r) => r.uid).filter(Boolean)).size;
  return {
    total: rows.length,
    users,
    perUser: users ? Number((rows.length / users).toFixed(2)) : 0,
    aiOnly: jiri.length,
    aiRate: PCT(jiri.length, rows.length),
    manualOnline: manual.length,
    manualRate: PCT(manual.length, rows.length),
    formFillers: rows.filter((r) => r.nat === "填表人").length,
    productSessions: rows.filter((r) => r.nat === "有效").length,
  };
}

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

// 场景 × 工作量（有效人工）
// 人工有效·秒转·jiri 可解答（2026-09-18 用户定名）：有效人工里「转人工方式=直接转 且 Jiri是否能解答=能」的场次。
// 与已有两个指标的区别（别混）：「可避免转人工」= 四类可避免原因 ÷ 全部转人工，宽得多；
// 「不愿和 Jiri 沟通率」是逐场读原文的严口径子集。本指标分母 = 有效人工，口径见 hive 仓库 skills/统计口径.md。
function isSecondTransfer(r) {
  return r.way === "直接转" && r.jiri === "能";
}

// **全站人工口径统一用「接待次数」，不用场次**（2026-09-18 用户定：「要口径一直用接待次数不要场次」）。
// 取 field_13 转人工会话接待次数——一场会话转了几次人工就记几次；没记录的按 1 次兜底，免得整场消失。
function receptions(r) {
  return typeof r.turns === "number" && r.turns > 0 ? r.turns : 1;
}

// 按场景拆：给周报表用。返回按命中数降序的数组。
function secondTransferByScene(effManual) {
  const agg = {};
  for (const r of effManual) {
    const a = agg[r.scene] || (agg[r.scene] = { scene: r.scene, base: 0, hit: 0 });
    a.base += receptions(r);
    if (isSecondTransfer(r)) a.hit += receptions(r);
  }
  return Object.values(agg)
    .map((a) => ({ ...a, rate: a.base ? Number(((a.hit / a.base) * 100).toFixed(1)) : 0 }))
    .sort((x, y) => y.hit - x.hit || y.base - x.base);
}

// 场景 × 客服 · 单次接待时长中位数（2026-09-18 用户定；同日改成场景作行、客服作列，行列都不截断）。
// 只看有效人工，且**排除多客服接力的会话**——一个会话只有一个总时长，没法拆给几个人（累计 11.6% 场次、24.2% 时长）。
// 归属取首接客服（单客服会话里首接=末接）。格 = 该场景该客服「时长 ÷ 接待次数」的中位数 + **接待次数**（口径统一，不用场次）；
// 胶囊 = 该格中位数 − 该行全员中位线（把该场景全部会话合在一起取的 pooled median）。
function agentSceneDuration(effManual) {
  const rows = effManual.filter((r) =>
    (r.csAll || []).length === 1 && r.csFirst && typeof r.dur === "number" && r.dur > 0 && typeof r.turns === "number" && r.turns > 0);
  const per = (r) => ({ min: r.dur / r.turns / 60, cnt: receptions(r) });
  // v = 单次接待时长中位数（分钟）；n = 接待次数
  // v = 中位数（分钟，1 位小数，周报用）；sec = 同一个中位数的整秒（人工服务页热力格写 m:ss 用）；n = 接待次数
  const cell = (list) => {
    if (!list.length) return null;
    const sec = median(list.map((x) => x.min * 60));
    return { v: Number((sec / 60).toFixed(1)), sec: Math.round(sec), n: list.reduce((a, x) => a + x.cnt, 0) };
  };
  const cnt = (obj, k, r) => { obj[k] = (obj[k] || 0) + receptions(r); };
  const sceneCount = {}, agentCount = {};
  for (const r of rows) { cnt(sceneCount, r.scene, r); cnt(agentCount, r.csFirst, r); }
  // 行 = 全部场景、列 = 全部客服，都按接待次数降序，不截断
  const scenes = Object.entries(sceneCount).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const agents = Object.entries(agentCount).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const table = scenes.map((sc) => {
    const inScene = rows.filter((r) => r.scene === sc);
    const base = cell(inScene.map(per));
    return {
      scene: sc, base,
      cells: agents.map((ag) => {
        const c = cell(inScene.filter((r) => r.csFirst === ag).map(per));
        return c ? { ...c, d: base ? Number((c.v - base.v).toFixed(1)) : null } : null;
      }),
    };
  });
  return { agents, rows: table, excludedMulti: effManual.length - rows.length };
}

// 用户情绪（2026-09-18 用户定）：三档直接显示，本项目只透传不改判。
// 同日改版：主表改成**每个人的负向场景分布**——行 = 客服 × 业务场景，给负向/正向的次数与占比。
// 口径统一按**接待次数**（一场会话的情绪套在它的接待次数上），分母 = 该客服该场景的接待次数。
// 归属取末接客服（谁收尾算谁，与复问一致）。第 27~30 周导出没这列，计入「无标注」。
function emotionStats(manual) {
  const blank = () => ({ total: 0, eff: 0, neg: 0, neu: 0, pos: 0, none: 0 });
  const add = (o, r) => {
    const n = receptions(r);
    o.total += n;
    if (r.nat === "有效") o.eff += n;
    if (r.emo === "负向") o.neg += n;
    else if (r.emo === "中性") o.neu += n;
    else if (r.emo === "正向") o.pos += n;
    else o.none += n;
  };
  const team = blank();
  const byAgent = {}, byScene = {}, byPair = {};
  const emoList = [];
  for (const r of manual) {
    add(team, r);
    // 负向 / 正向明细：上表只看得到「几次」，要回原文得有链接，所以逐场留下地址
    if (r.emo === "负向" || r.emo === "正向") {
      emoList.push({ t: r.t || "", url: r.url || "", agent: r.csLast || "", emo: r.emo, scene: r.scene, q: r.sum || "" });
    }
    if (r.csLast) {
      add(byAgent[r.csLast] || (byAgent[r.csLast] = blank()), r);
      const key = r.csLast + "\u0000" + r.scene;
      const cell = byPair[key] || (byPair[key] = { agent: r.csLast, scene: r.scene, ...blank() });
      add(cell, r);
    }
    // 按场景只算有情绪标注的行，否则负向率会被没这列的老周稀释
    if (r.emo) add(byScene[r.scene] || (byScene[r.scene] = blank()), r);
  }
  const rate = (n, o) => {
    const d = o.neg + o.neu + o.pos;
    return d ? Number(((n / d) * 100).toFixed(1)) : null;
  };
  const withRate = (o) => ({ ...o, negRate: rate(o.neg, o), posRate: rate(o.pos, o) });
  return {
    team: withRate({ name: "合计", ...team }),
    agents: Object.entries(byAgent).map(([name, o]) => withRate({ name, ...o })).sort((a, b) => b.total - a.total),
    // 负向场景分布：只列出有负向或正向的格子，按负向次数降序（全是中性的格子没有可看的东西）
    pairs: Object.values(byPair).map(withRate).filter((x) => x.neg > 0 || x.pos > 0)
      .sort((a, b) => b.neg - a.neg || b.pos - a.pos || b.total - a.total),
    scenes: Object.entries(byScene).map(([name, o]) => withRate({ name, ...o }))
      .sort((a, b) => b.neg - a.neg || b.total - a.total),
    // 负向在前、正向在后，各自按时间倒序
    emoList: emoList.sort((a, b) => (a.emo === b.emo ? (b.t || "").localeCompare(a.t || "") : a.emo === "负向" ? -1 : 1)),
  };
}

function sceneWorkload(effManual) {
  const agg = {};
  for (const r of effManual) {
    const a = agg[r.scene] || (agg[r.scene] = { receptions: 0, durSec: 0, rows: [] });
    a.receptions += r.turns || 0;
    a.durSec += r.dur || 0;
    a.rows.push(r);
  }
  const totalSec = effManual.reduce((a, r) => a + (r.dur || 0), 0);
  const out = {};
  for (const [scene, a] of Object.entries(agg)) {
    out[scene] = {
      receptions: a.receptions,
      durMin: Math.round(a.durSec / 60),
      share: totalSec ? Number(((a.durSec / totalSec) * 100).toFixed(0)) : 0,
      medianMin: Number((median(perReception(a.rows)) / 60).toFixed(1)),
      avgMin: Number((mean(perReception(a.rows)) / 60).toFixed(1)),
    };
  }
  return out;
}

// 同一份聚合的数组形态：周报表格要按总时长降序排，同期对比要按场景名查。
// 两种形态必须出自同一个 sceneWorkload，否则口径迟早会漂。
function sceneWorkloadList(effManual) {
  return Object.entries(sceneWorkload(effManual))
    .map(([scene, a]) => ({ scene, ...a }))
    .sort((x, y) => y.durMin - x.durMin);
}

// 业务分型 × 建表转化。「只跟金数据打交道」「看不出用途」不是建表需求，排除
const BIZ_EXCLUDE = new Set(["只跟金数据打交道", "看不出用途"]);

function bizTypeStats(rows) {
  const g = {};
  for (const r of rows) {
    if (!r.biz || BIZ_EXCLUDE.has(r.biz)) continue;
    (g[r.biz] || (g[r.biz] = [])).push(r);
  }
  return Object.entries(g).map(([type, rs]) => {
    const n = rs.length;
    // 「对口建表」= 是/否 都表示建了表（只是对不对口）；待定/不适用视为还没建
    const built = rs.filter((r) => r.onTarget === "是" || r.onTarget === "否").length;
    const onTarget = rs.filter((r) => r.onTarget === "是").length;
    const gotData = rs.filter((r) => r.gotData === "是").length;
    const jiriBuilt = rs.filter((r) => r.jiriBuilt === "是").length;
    return {
      type,
      sessions: n,
      built, onTarget, gotData, jiriBuilt,
      pending: rs.filter((r) => r.onTarget === "待定").length,
      builtRate: PCT(built, n),
      onTargetRate: PCT(onTarget, n),
      gotDataRate: PCT(gotData, n),
      jiriBuiltRate: PCT(jiriBuilt, n),
    };
  }).sort((a, b) => b.sessions - a.sessions);
}

// 一批会话 → 周报三/四/五要用的全部指标（同期对齐时在子集上重算）
// 周报「JIRI（AI）接待现状」板块（2026-09-17 加）。口径与 hive 仓库 skills/统计口径.md 一致：
// - 轮次三档的分母 = 仅 Jiri 且有效；单轮 =1、2 轮 =2、深度 ≥3（另给深度中位轮次）；三档之和与分母的差 = 用户 0 轮（只有 Jiri 单方说话）
// - 复问、填表人的分母 = 全部会话（表内不含内部测试）；填表人分 AI 侧（仅 Jiri）与含人工侧
// - 人工中 @jiri 的分母 = 全部仅人工
function jiriStats(rows, manual, effJiri) {
  const turns = effJiri.map((r) => r.uturns).filter((n) => typeof n === "number");
  const deepTurns = turns.filter((n) => n >= 3);
  const one = turns.filter((n) => n === 1).length;
  const two = turns.filter((n) => n === 2).length;
  const deep = deepTurns.length;
  return {
    base: effJiri.length, unlabeled: effJiri.length - turns.length,
    one, two, deep, zero: turns.length - one - two - deep,
    deepMedian: median(deepTurns),
    repeat: rows.filter((r) => r.rep).length,
    fillerAI: rows.filter((r) => r.nat === "填表人" && r.st === "仅 Jiri").length,
    fillerAll: rows.filter((r) => r.nat === "填表人").length,
    atJiri: manual.filter((r) => r.atJiri).length,
    manual: manual.length,
    total: rows.length,
  };
}

function weekMetrics(rows) {
  const manual = rows.filter((r) => r.st === "仅人工");
  const effManual = manual.filter((r) => r.nat === "有效");
  const effJiri = rows.filter((r) => r.st === "仅 Jiri" && r.nat === "有效");
  const jiriScenes = {};
  for (const r of effJiri) jiriScenes[r.scene] = (jiriScenes[r.scene] || 0) + 1;
  return {
    ...overview(rows),
    jiri: jiriStats(rows, manual, effJiri),
    secondTransfer: {
      total: effManual.filter(isSecondTransfer).reduce((a, r) => a + receptions(r), 0),
      base: effManual.reduce((a, r) => a + receptions(r), 0),
      scenes: secondTransferByScene(effManual),
    },
    agentScene: agentSceneDuration(effManual),
    emotion: emotionStats(manual),
    eff: groupStats(effManual),
    allManual: groupStats(manual),
    directTransfer: effManual.filter((r) => r.way === "直接转").length,
    scenes: sceneWorkload(effManual),
    bizTypes: bizTypeStats(rows),
    jiriScenes,
    jiriSceneTotal: effJiri.length,
  };
}

// 按接待客服评估（2026-09-17 用户定，只看仅人工；口径见 hive 仓库 skills/统计口径.md「按接待客服评估」）：
// - 接待人次：一场里出现的每位客服各记 1（全部客服列）
// - 秒转率：归首接客服——秒转（转人工方式=直接转）是用户进来就要人工，发生在任何客服接手之前；分母 = 首接的有效人工场次
// - 复问率：记到**原来接待的那个人**（前一场 A 的末接客服）——用户在 A 问了 x、隔 6~36h 又在 B 问 x，复问算 A 的接待人，
//   不算 B 的；分母 = 末接场次。复问算在 A 所在的周：后一场 B（复问=是）的「复问自」指向 A，A 若是仅人工就记到它的末接客服头上
// repeatedUrls = 全表里「被复问过」的前一场会话地址集合（跨周：本周的会话可能被下周的会话复问，靠全量 rows 算）
function agentStats(manualRows, repeatedUrls) {
  const by = {};
  const slot = (k) => by[k] || (by[k] = { visits: 0, first: 0, firstEff: 0, direct: 0, last: 0, repeated: 0 });
  const team = { visits: 0, first: 0, firstEff: 0, direct: 0, last: 0, repeated: 0 };
  for (const r of manualRows) {
    const all = r.csAll.length ? r.csAll : (r.csFirst ? [r.csFirst] : []);
    const wasRepeated = repeatedUrls.has(r.url);
    for (const a of all) { slot(a).visits++; team.visits++; }
    if (r.csFirst) {
      const f = slot(r.csFirst); f.first++; team.first++;
      if (r.nat === "有效") { f.firstEff++; team.firstEff++; if (r.way === "直接转") { f.direct++; team.direct++; } }
    }
    if (r.csLast) {
      const l = slot(r.csLast); l.last++; team.last++;
      if (wasRepeated) { l.repeated++; team.repeated++; }
    }
  }
  const fin = (name, x) => ({
    name, ...x,
    directRate: x.firstEff ? Number(((x.direct / x.firstEff) * 100).toFixed(1)) : null,
    repeatRate: x.last ? Number(((x.repeated / x.last) * 100).toFixed(1)) : null,
  });
  return {
    team: fin("团队合计", team),
    agents: Object.entries(by).map(([n, x]) => fin(n, x)).sort((a, b) => b.visits - a.visits),
  };
}

function buildWeekly(rows) {
  // 被复问过的前一场：复问=是 的行的「复问自」
  const repeatedUrls = new Set(rows.filter((r) => r.rep && r.repFrom).map((r) => r.repFrom));
  const grouped = {};
  for (const r of rows) {
    const day = (r.t || "").slice(0, 10);
    if (!day) continue;
    const w = isoWeek(day);
    if (!w) continue;
    (grouped[w] || (grouped[w] = [])).push(r);
  }

  const weekKeys = Object.keys(grouped).sort();
  const built = weekKeys.map((week) => {
    const all = grouped[week];
    const days = new Set(all.map((r) => r.t.slice(0, 10)));
    const manual = all.filter((r) => r.st === "仅人工");
    const jiri = all.filter((r) => r.st === "仅 Jiri");
    const effManual = manual.filter((r) => r.nat === "有效");
    const effJiri = jiri.filter((r) => r.nat === "有效");

    const eff = groupStats(effManual);
    const allManual = groupStats(manual);

    // 有效人工场景 × 工作量（占比按时长）
    const scenes = sceneWorkloadList(effManual);

    // 仅 Jiri 有效场景
    const jiriScenes = {};
    for (const r of effJiri) jiriScenes[r.scene] = (jiriScenes[r.scene] || 0) + 1;

    const direct = effManual.filter((r) => r.way === "直接转").length;
    const guide = scenes.find((s) => s.scene === GUIDE_SCENE);
    const guideSplit = guideSplitOf(effManual, guide ? guide.share : 0);
    // 客服接待评估：本周 + 累计到本周（复问样本小，累计才看得出差异）
    const agents = agentStats(manual, repeatedUrls);
    const cumManual = weekKeys.filter((k) => k <= week).flatMap((k) => grouped[k]).filter((r) => r.st === "仅人工");
    const agentsCum = agentStats(cumManual, repeatedUrls);

    return {
      week,
      dayCount: days.size,
      firstDay: [...days].sort()[0],
      lastDay: [...days].sort().pop(),
      ...overview(all),
      jiri: jiriStats(all, manual, effJiri),
      secondTransfer: {
        total: effManual.filter(isSecondTransfer).reduce((a, r) => a + receptions(r), 0),
        base: effManual.reduce((a, r) => a + receptions(r), 0),
        scenes: secondTransferByScene(effManual),
      },
      agentScene: agentSceneDuration(effManual),
      emotion: emotionStats(manual),
      agents, agentsCum, cumFromWeek: weekKeys[0],
      bizTypes: bizTypeStats(all),
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
        guideSplit,
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

  // 本周可能只跑到周四，环比要拿上周的周一~周四对齐着比，天数不同没法比
  built.forEach((w, i) => {
    if (i === 0) return;
    const prevKey = weekKeys[i - 1];
    const dows = new Set(grouped[weekKeys[i]].map((r) => dowOf(r.t.slice(0, 10))).filter((d) => d >= 0));
    const aligned = grouped[prevKey].filter((r) => dows.has(dowOf(r.t.slice(0, 10))));
    w.compare = {
      prevWeek: prevKey,
      dows: [...dows].sort((a, b) => a - b),
      truncated: aligned.length !== grouped[prevKey].length,
      prev: weekMetrics(aligned),
    };

    // 同比取 4 周前的同一批星期（数据不足一年，用 4 周前代替去年同周）
    const yoyIdx = i - 4;
    if (yoyIdx >= 0) {
      const yKey = weekKeys[yoyIdx];
      w.compare.yoyWeek = yKey;
      w.compare.yoy = weekMetrics(grouped[yKey].filter((r) => dows.has(dowOf(r.t.slice(0, 10)))));
    }
  });

  return built;
}

// ============== 业务闭环 ==============
// 适用会话 = 业务闭环 ∈ {是, 否, 待定}；「不适用」和空一律排除
//（非有效会话，或业务分型是「看不出用途」—— 读不出要办什么业务，没有闭环可测）
// 闭环率 = 是 ÷ 全部适用行（是 + 否 + 待定），下限口径。
// 上游判定：窗口内收到过数据立刻判「是」，不等 7 天满；只有「窗口没满且还没收到数据」才留待定。
// 所以待定只会变成是或否里的一种走向 —— 待定清零后这个公式自然等于最终闭环率，不用换算法。
const LOOP_OK = new Set(["是", "否", "待定"]);
const PENDING_LIMIT = 30; // 待定占比超过这条线，本周闭环率还会往上走

function loopRate(yes, applicable) {
  return applicable ? Number(((yes / applicable) * 100).toFixed(1)) : null;
}

function buildLoop(rows) {
  const app = rows.filter((r) => LOOP_OK.has(r.loop));
  const count = (rs, v) => rs.filter((r) => r.loop === v).length;

  const byWeek = {};
  for (const r of app) {
    const day = (r.t || "").slice(0, 10);
    const wk = day ? isoWeek(day) : "";
    if (!wk) continue;
    (byWeek[wk] || (byWeek[wk] = [])).push(r);
  }
  const weeks = Object.keys(byWeek).sort().map((week) => {
    const rs = byWeek[week];
    const yes = count(rs, "是");
    const no = count(rs, "否");
    const pending = count(rs, "待定");
    const pendingRate = rs.length ? Number(((pending / rs.length) * 100).toFixed(1)) : 0;
    return {
      week, applicable: rs.length, yes, no, pending, pendingRate,
      rate: loopRate(yes, rs.length),
      unsettled: pendingRate > PENDING_LIMIT,
    };
  });

  // 按业务分型：同一个下限口径，全部适用行都进分母（含待定）
  const byType = {};
  for (const r of app) {
    const t = r.biz || "未标注";
    (byType[t] || (byType[t] = [])).push(r);
  }
  const types = Object.entries(byType).map(([type, rs]) => ({
    type,
    sessions: rs.length,
    yes: count(rs, "是"),
    no: count(rs, "否"),
    pending: count(rs, "待定"),
    rate: loopRate(count(rs, "是"), rs.length),
    small: rs.length < 10,
  })).sort((a, b) => (a.small === b.small ? b.sessions - a.sessions : a.small ? 1 : -1));

  const yes = count(app, "是");
  const no = count(app, "否");
  const pending = count(app, "待定");
  return {
    weeks, types,
    overall: {
      applicable: app.length, yes, no, pending,
      settled: app.length - pending,
      rate: loopRate(yes, app.length),
    },
  };
}

// ============== 缓存 ==============

async function readMeta(env) {
  return (await env.CACHE.get(K_META, { type: "json" })) || null;
}

// 最近一次成功落地的数据是哪一版。刷新失败 / 进行中时，页面上的数据仍是这一版。
function lastOkOf(meta) {
  if (!meta) return null;
  if (meta.status === "ok" && meta.updatedAt) return { updatedAt: meta.updatedAt, checkedAt: meta.checkedAt || meta.updatedAt, total: meta.total };
  return meta.lastOk || null;
}

// ============== 明细分块存储（2026-10-21） ==============
// 教训：明细原来整份放在一个 KV 值里。3 万条精简明细逼近 KV 单值上限 25 MiB，
// 2026-10-20 凌晨起每次写入都失败，筛选查询一直读 10-19 那份旧明细，10-19 之后的会话全看不到；
// 而页面照常显示「数据更新于 …」，因为写失败只记在 meta 里、前端没展示。
// 现在按会话月份分块（每块最多 ENTRY_PART_ROWS 条），K_ENTRIES 只放清单：
//   { stamp, total, parts: [{ key, n }] }
// 块的键里带内容指纹：内容没变的块键不变、不重写（老月份基本不动，每次刷新通常只写当月一块）；
// 内容变了就是新键，清单最后才切过去——任何一块写失败，读的人看到的仍是完整的旧版本，不会新旧混读。
const K_ENTRY_PART = "hive:entries:v8:part:";
const ENTRY_PART_ROWS = 6000;
const ENTRY_PART_MAX_BYTES = 20 * 1024 * 1024;   // 离 25 MiB 上限留余量，超了直接报错而不是等 KV 拒写

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// rows 已按时间倒序：同一个月连在一起，月内再按条数切
function splitEntries(rows) {
  const parts = [];
  let cur = null;
  for (const r of rows) {
    const m = (r.t || "").slice(0, 7) || "none";
    if (!cur || cur.m !== m || cur.rows.length >= ENTRY_PART_ROWS) {
      cur = { m, idx: cur && cur.m === m ? cur.idx + 1 : 0, rows: [] };
      parts.push(cur);
    }
    cur.rows.push(r);
  }
  return parts;
}

let entriesMemo = null;   // 同一个 isolate 里按清单 stamp 记住解析好的明细，省掉每次请求解析几十 MB

async function writeEntries(env, rows, extra) {
  const prev = (await env.CACHE.get(K_ENTRIES, { type: "json" })) || {};
  const had = new Set((prev.parts || []).map((p) => p.key));
  const enc = new TextEncoder();
  const parts = splitEntries(rows).map((p) => {
    const body = JSON.stringify(p.rows);
    const bytes = enc.encode(body).length;
    if (bytes > ENTRY_PART_MAX_BYTES) {
      throw new Error(`明细分块 ${p.m}#${p.idx} 有 ${(bytes / 1048576).toFixed(1)} MB，超过单块上限，需调小 ENTRY_PART_ROWS`);
    }
    return { key: K_ENTRY_PART + p.m + ":" + p.idx + ":" + fnv1a(body), n: p.rows.length, body };
  });
  const toWrite = parts.filter((p) => !had.has(p.key));
  await Promise.all(toWrite.map((p) => env.CACHE.put(p.key, p.body)));   // 任何一块失败都整体抛出，清单不切
  const stamp = new Date().toISOString();
  await env.CACHE.put(K_ENTRIES, JSON.stringify({ ...(extra || {}), stamp, total: rows.length, parts: parts.map(({ key, n }) => ({ key, n })) }));
  // 新清单里不再用的旧块删掉（正在读旧清单的请求缺块时会重读一次清单，见 readEntries）
  const keep = new Set(parts.map((p) => p.key));
  await Promise.allSettled((prev.parts || []).filter((p) => !keep.has(p.key)).map((p) => env.CACHE.delete(p.key)));
  entriesMemo = { stamp, rows };
  return { parts: parts.length, written: toWrite.length };
}

async function readManifest(env) {
  const man = await env.CACHE.get(K_ENTRIES, { type: "json" });
  return man && Array.isArray(man.parts) ? man : null;
}

async function readEntries(env) {
  for (let 第几次 = 0; 第几次 < 2; 第几次++) {
    const man = await env.CACHE.get(K_ENTRIES, { type: "json" });
    if (!man || !Array.isArray(man.parts)) return null;
    if (entriesMemo && entriesMemo.stamp === man.stamp) return entriesMemo.rows;
    const chunks = await Promise.all(man.parts.map((p) => env.CACHE.get(p.key, { type: "json" })));
    if (chunks.some((c) => !Array.isArray(c))) continue;   // 刚好赶上换版删旧块：重读一次清单
    const rows = [].concat(...chunks);
    entriesMemo = { stamp: man.stamp, rows };
    return rows;
  }
  return null;
}

// mode："auto"（定时 / 缓存缺失）按需全量或增量；"full"（手动「重新拉取数据」）强制全量。
// meta.updatedAt 是「明细最后一次变化」的时间，也是查询缓存的数据版本——增量没拉到改动就不变，查询缓存继续命中；
// meta.checkedAt 是最近一次同步完成的时间，页面「数据更新于」显示它。
async function refreshCache(env, mode = "auto") {
  const startedAt = Date.now();
  const prevMeta = await readMeta(env);
  const lastOk = lastOkOf(prevMeta);
  await env.CACHE.put(
    K_META,
    JSON.stringify({ status: "running", startedAt, startedAtIso: new Date(startedAt).toISOString(), lastOk })
  );

  try {
    const man = await readManifest(env);
    const 今天 = bjTime(startedAt).slice(0, 10);
    let 全量 = mode === "full" || !man || !man.cursor || !man.fullAt ||
      (bjTime(Date.parse(man.fullAt)).slice(0, 10) < 今天 && Number(bjTime(startedAt).slice(11, 13)) >= FULL_SYNC_HOUR);
    const cursor = new Date(startedAt - SYNC_OVERLAP_MS).toISOString();

    let rows, reportedTotal, changed, fullAt, old = null, inc = null;
    if (!全量) {
      [old, inc] = await Promise.all([readEntries(env), fetchUpdatedSince(env, Date.parse(man.cursor))]);
      if (!inc) 全量 = true;   // 改动太多，走全量
    }
    if (全量) {
      const r = await fetchAllEntries(env);
      rows = r.rows;
      reportedTotal = r.total;
      changed = rows.length;
      fullAt = new Date(startedAt).toISOString();
    } else {
      if (!old) throw new Error("读不到已存明细，下次改走全量");
      fullAt = man.fullAt;
      reportedTotal = null;
      // 只算真正有变化的：增量窗口和上次有重叠，同一条记录内容没变就不算改动
      const bySn = new Map(old.map((r) => [r.sn, r]));
      changed = 0;
      for (const r of inc.rows) {
        const was = bySn.get(r.sn);
        if (!was || JSON.stringify(was) !== JSON.stringify(r)) { bySn.set(r.sn, r); changed++; }
      }
      rows = changed ? [...bySn.values()] : old;
    }

    let 分块 = { parts: man ? man.parts.length : 0, written: 0 };
    let 失败键 = [];
    let updatedAt = lastOk && lastOk.updatedAt;
    if (全量 || changed || !updatedAt) {
      rows.sort((a, b) => (b.t || "").localeCompare(a.t || ""));
      // 明细是唯一的事实来源：先写明细，写成了才写派生的 stats / weekly / loop。
      // 明细写不进去就整次算失败、派生键也不动，免得「派生是新的、明细是旧的」。
      分块 = await writeEntries(env, rows, { cursor, fullAt });
      const 派生键 = [
        [K_STATS, buildStats(rows)],
        [K_WEEKLY, buildWeekly(rows)],
        [K_LOOP, buildLoop(rows)],
      ];
      const 结果 = await Promise.allSettled(派生键.map(([k, v]) => env.CACHE.put(k, JSON.stringify(v))));
      失败键 = 派生键.map(([k]) => k).filter((k, i) => 结果[i].status === "rejected");
      // 派生键写失败就删掉旧值，读的时候从新明细现算（见「派生」），不留和明细对不上的旧值
      await Promise.allSettled(失败键.map((k) => env.CACHE.delete(k)));
      updatedAt = new Date().toISOString();
    } else {
      // 没有改动：明细不重写，只把游标往前挪
      await env.CACHE.put(K_ENTRIES, JSON.stringify({ ...man, cursor }));
    }
    const meta = {
      status: "ok",
      mode: 全量 ? "full" : "incr",
      updatedAt,
      checkedAt: new Date().toISOString(),
      fullAt,
      total: rows.length,
      changed,
      ...(reportedTotal !== null ? { reportedTotal } : {}),
      parts: 分块.parts,
      partsWritten: 分块.written,
      tookMs: Date.now() - startedAt,
      ...(失败键.length ? { warn: `派生缓存写入失败，已改为现算：${失败键.join("、")}` } : {}),
    };
    await env.CACHE.put(K_META, JSON.stringify(meta));
    console.log("[refresh]", meta.status, JSON.stringify(meta));
    return meta;
  } catch (err) {
    const meta = {
      status: "error",
      error: err.message,
      failedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
      lastOk,   // 页面上的数据停在这一版
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

// 当前区间前的等长区间。只在用户明确选择了时间范围时返回，避免把“全部时间”
// 错当成可比较的周期。
function previousRange(range) {
  if (!range?.from || !range?.to) return null;
  const from = new Date(range.from + "T00:00:00Z");
  const to = new Date(range.to + "T00:00:00Z");
  if (isNaN(from) || isNaN(to) || to < from) return null;
  const days = Math.floor((to - from) / 86400000) + 1;
  return {
    from: iso(shift(from, -days)),
    to: iso(shift(from, -1)),
  };
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

// 条带用的全序列日桶：维度筛选照套，日期放宽到「最近 52 周 ∪ 筛选区间」，这样默认窗口永远落在序列里、
// 窗口合计和筛选后的总数一致。每天只留主图要的三样（会话数、人工时长、设备），约 60 字节一天。
function buildSeries(rows, q, range) {
  const floor = shiftDay(todayInShanghai(), -(SERIES_DAYS - 1));
  const from = range && range.from && range.from < floor ? range.from : floor;
  const byDay = {};
  for (const r of applyFilters(rows, q, { from, to: "9999-12-31" })) {
    const day = (r.t || "").slice(0, 10);
    if (!day) continue;
    const b = byDay[day] || (byDay[day] = { total: 0, dur: 0, dev: {} });
    b.total++;
    b.dev[r.dev] = (b.dev[r.dev] || 0) + 1;
    if (typeof r.dur === "number" && r.dur > 0) b.dur += r.dur;
  }
  return { from, byDay };
}

// ============== 筛选结果记忆缓存 ==============
// 时间下拉默认就是「过去 14 天」，所以**每一次**看板加载都带筛选参数、都走明细路径：
// 读全量明细 → JSON.parse → applyFilters → buildStats 两次（当前区间 + 上一等长区间）。
// 预聚合的 K_STATS 只有用户主动选「全部时间」时才命中，等于常年不生效。
// 这里按「数据版本 + 归一化后的筛选条件」记一份结果，同一版数据的相同筛选只算一次。

// 键里放**换算后**的 from/to，不是原始的 range=14 ——「过去 14 天」跨过零点就是另一个区间，
// 只按原始参数缓存会在午夜前后发错数据。
async function queryCacheKey(q, dataVersion, range) {
  const norm = FILTER_KEYS.map((k) => k + "=" + (q.get(k) || "")).join("&") +
    "|resolved=" + (range.from || "") + ".." + (range.to || "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return K_QUERY_PREFIX + dataVersion + ":" + hex.slice(0, 32);
}

// 没有 updatedAt 就没有可靠的失效依据，这时干脆不缓存
// 刷新失败或进行中时，明细仍是 lastOk 那一版（明细写入是整版切换的），照样可以按它缓存
function dataVersionOf(meta) {
  const ok = lastOkOf(meta);
  return ok && ok.updatedAt ? ok.updatedAt : "";
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

// stats / weekly / loop 都是从明细 K_ENTRIES 现算出来的，实测各 0.1～0.2 秒。
// 所以这三个键缺失时不该干等后台刷新：只要明细还在，就当场算、顺手回写。
// 这样换缓存键（bump vN）不再让页面卡在「正在构建」，后台刷新死掉也不至于整页没数。
async function 派生(env, ctx, key, build) {
  const rows = await readEntries(env);
  if (!rows) return null;
  const value = build(rows);
  ctx.waitUntil(
    env.CACHE.put(key, JSON.stringify(value))
      .catch((err) => console.error("[derive] put failed:", key, err.message))
  );
  return value;
}

// 明细也没有，才真的只能等后台拉数。顺便把 meta 原样带出去，前端好显示到底卡在哪。
async function 构建中(env, ctx, meta) {
  kickoff(env, ctx, meta);
  return json({ success: true, building: true, meta: await readMeta(env) });
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

// ============== 页面 ==============

// 插进 HTML 的值一律转义。这里的 user 必然来自 AUTH_USERS，外部改不了，
// 但把「安全」建立在「上游恰好可信」上迟早出事，转义是零成本的。
function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function renderPage(env, user) {
  // 2026-10 改版后图表全部是 DOM / SVG（和 Design 原型同一套画法），不再加载 Chart.js
  const [cssUrl, jsUrl, fontUrl] = await Promise.all([
    env.ASSETS.url("/hive.css"),
    env.ASSETS.url("/hive.js"),
    // 数字与拉丁字母用自托管的 Urbanist（只含拉丁子集，约 28KB）；中文仍走系统字体。
    // 不引 Google Fonts：国内访问不稳定。
    env.ASSETS.url("/urbanist-latin.woff2"),
  ]);

  return new Response(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>hive 服务看板</title>
<style>@font-face{font-family:"Urbanist";font-style:normal;font-weight:400 700;font-display:swap;src:url("${fontUrl}") format("woff2");unicode-range:U+0000-00FF,U+2000-206F,U+2191,U+2193,U+2212}</style>
<link rel="stylesheet" href="${cssUrl}">
</head>
<body class="is-analysis">
<div class="app">
<aside class="side" aria-label="主导航">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"></path></svg></span>
    <span class="brand-text"><b>hive</b><small>服务看板</small></span>
  </div>
  <button type="button" class="menu-btn" id="menuBtn" aria-label="打开菜单" aria-expanded="false" aria-controls="sideBody"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg></button>
  <div class="side-body" id="sideBody">
  <div class="drawer-head"><span>菜单</span><button type="button" class="menu-close" id="menuClose" aria-label="关闭菜单"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>
  <nav class="side-nav" aria-label="页面">
    <div class="nav-group">
      <div class="nav-group-head"><span>分析</span><small>随筛选变化</small></div>
      <button type="button" class="tab nav-item active" data-tab="overview" data-kind="analysis" data-desc="会话量、AI 独立率与人工投入的整体走势"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"></path></svg><span>总览</span></button>
      <button type="button" class="tab nav-item" data-tab="volume" data-kind="analysis" data-desc="量有多少、谁来的、从哪个入口来"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M10 20V5M15 20v-7M20 20V9"></path></svg><span>接待量与来源</span></button>
      <button type="button" class="tab nav-item" data-tab="ai" data-kind="analysis" data-desc="Jiri 自己接住了多少、哪里接不住、用户有没有被迫再问一遍"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.6 2.6M14.9 14.9l2.6 2.6M6.5 17.5l2.6-2.6M14.9 9.1l2.6-2.6"></path></svg><span>AI 表现</span></button>
      <button type="button" class="tab nav-item" data-tab="service" data-kind="analysis" data-desc="人工花了多少时间、什么时候最忙、为什么转人工，以及每位客服接待得怎样"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2M4.5 14a2 2 0 0 0 2 2h1v-5h-1a2 2 0 0 0-2 2zM19.5 14a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2zM16.5 16v1a3 3 0 0 1-3 3H12"></path></svg><span>人工服务</span></button>
      <button type="button" class="tab nav-item" data-tab="business" data-kind="analysis" data-desc="用户在问什么业务、是哪种套餐的用户、小金商户处在哪个阶段"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8zM3.5 12.5l8.5 4.5 8.5-4.5M3.5 16.5l8.5 4.5 8.5-4.5"></path></svg><span>业务与套餐</span></button>
    </div>
    <div class="nav-group">
      <div class="nav-group-head"><span>报告</span><small>固定口径</small></div>
      <button type="button" class="tab nav-item" data-tab="weekly" data-kind="report" data-desc="按自然周固定统计，不受顶部筛选影响"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4"></path></svg><span>周报</span></button>
      <button type="button" class="tab nav-item" data-tab="loop" data-kind="report" data-desc="咨询后 7 天内，用户的对口表单有没有真正收到数据"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9M18 3.5v4h-4M6 20.5v-4h4"></path></svg><span>业务闭环</span></button>
    </div>
  </nav>
  <div class="side-foot">
    <span class="side-updated" id="updatedAt">—</span>
    <button type="button" class="btn" id="refreshBtn">重新拉取数据</button>
    <div class="side-user"><span class="user-chip" title="当前登录账号">${escHtml(user)}</span><button type="button" class="btn-ghost" id="logoutBtn">退出</button></div>
  </div>
  </div>
</aside>
<div class="menu-backdrop" id="menuBackdrop" aria-hidden="true"></div>

<main class="main">
  <header class="page-head">
    <div class="page-title">
      <div class="crumb" id="pageCrumb">分析 / 总览</div>
      <h1 id="pageTitle">总览</h1>
      <p id="pageDesc">会话量、AI 独立率与人工投入的整体走势</p>
    </div>
    <div class="page-tools">
      <span class="live-chip" id="liveChip"><i aria-hidden="true"></i>随筛选变化</span>
      <span class="match-info" id="matchInfo"></span>
      <div class="report-bar" id="reportBar">
        <label>统计周 <select id="wkSelect"></select></label>
        <span class="report-hint" id="wkHint"></span>
        <button type="button" class="btn-ghost notes-toggle" id="notesToggle" aria-pressed="false">显示口径说明</button>
        <button type="button" class="btn-ghost notes-toggle" id="exportBtn">导出</button>
      </div>
    </div>
  </header>

  <div id="banner" class="banner" hidden></div>

  <div class="filter-sentinel" id="filterSentinel" aria-hidden="true"></div>
  <div class="sticky-top" id="stickyTop">
  <section class="filterbar" id="filterbar" aria-label="筛选条件">
    <button type="button" class="filter-toggle" id="filterToggle" aria-expanded="false" aria-controls="filterRow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"></path></svg><span id="filterSummary">筛选</span><i aria-hidden="true"></i></button>
    <div class="filter-row" id="filterRow">
      <label class="f-label">时间
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
      </label>
      <label class="f-label">从 <input type="date" id="fFrom" title="起始日期"></label>
      <label class="f-label">至 <input type="date" id="fTo" title="截止日期"></label>
      <span class="filter-sep" aria-hidden="true"></span>
      <label class="f-label">设备 <select id="fDevice" data-dim="device"></select></label>
      <label class="f-label">业务场景 <select id="fScene" data-dim="scene"></select></label>
      <label class="f-label">会话性质 <select id="fNature" data-dim="nature"></select></label>
      <button type="button" class="btn-ghost reset-btn" id="resetBtn">重置</button>
    </div>
  </section>
  </div>

  <!-- ============ 分析 · 总览 ============ -->
  <section class="panel active" id="panel-overview">
    <section class="cards" id="cards"></section>
    <section class="chart-card hero-card" aria-label="会话接待分布">
      <div class="hero-head">
        <div class="hero-title"><h3>会话接待分布</h3><div class="hero-big" id="heroTotal">—</div><div class="hero-caption" id="heroCaption"></div><div class="lens-state" id="lensState" aria-live="polite"></div></div>
        <div class="hero-right">
          <div class="seg" id="granRecept" role="tablist" aria-label="聚合粒度"></div>
          <div class="legend"><span><i style="background:#4A494F"></i>会话量</span><span><i class="band"></i><span id="heroLegendCur">近 7 天</span></span><span><i class="ln" style="background:#0B0B0C;height:2.5px"></i>人工接待时长（右轴）</span></div>
        </div>
      </div>
      <div id="heroRecept"></div>
      <!-- 区间条带（Range Lens）：整条序列一根一天，窗口默认 = 顶部筛选的时间；拖中间平移、拖两端改宽度、点空白处跳过去、双击看全部 -->
      <div class="lens" id="heroLens" hidden>
        <div class="lens-strip" id="lensStrip" tabindex="0" role="slider" aria-label="查看区间：左右键平移，上下键放宽收窄，Esc 回到筛选">
          <div class="lens-track"><div class="lens-bars dim" id="lensDim"></div></div>
          <div class="lens-slab" id="lensSlab"></div>
          <div class="lens-bars lit" id="lensLit"></div>
          <div class="lens-win" id="lensWin"><i class="lens-h l glass-light"><b></b></i><i class="lens-h r glass-light"><b></b></i></div>
        </div>
        <div class="lens-x" id="lensX"></div>
      </div>
    </section>
    <div class="flex-row">
      <section class="chart-card" style="flex:1 1 300px" aria-label="设备构成">
        <div class="chart-head between"><h3>设备构成</h3><a href="#volume" class="more-link" id="devLink">来源详情 →</a></div>
        <div class="dev-stack" id="devStack"></div>
      </section>
      <section class="chart-card" style="flex:2 1 600px" aria-label="接待人数与企业数">
        <div class="chart-head between"><h3>接待人数与企业数</h3><span class="chart-hint">最近 24 周 · 不随筛选</span></div>
        <div class="bignums">
          <div><b id="ovUniqUsers">—</b><span><i style="background:#0B0B0C"></i>接待人数</span></div>
          <div><b id="ovUniqOrgs">—</b><span><i style="background:#AAA9AB"></i>接待企业数</span></div>
        </div>
        <div class="pair-bars" id="ovUniqBars"></div>
        <p class="chart-foot">按周去重，各周不可相加；总数为 24 周去重</p>
      </section>
    </div>
  </section>

  <!-- ============ 分析 · 接待量与来源 ============ -->
  <section class="panel" id="panel-volume">
    <section class="chart-card hero-card" aria-label="会话接待分布（按设备）">
      <div class="hero-head">
        <div class="hero-title"><h3>会话接待分布 · 按设备</h3><div class="hero-big sm" id="volDistTotal">—</div><div class="hero-caption">最近 24 周 · 不随筛选</div>
          <div class="legend"><span><i style="background:#0B0B0C"></i>pc</span><span><i style="background:#AAA9AB"></i>mobile</span><span><i style="background:#DBDADD"></i>未知</span></div></div>
        <div class="seg" id="granDist" role="tablist" aria-label="聚合粒度"></div>
      </div>
      <div id="volDist"></div>
    </section>
    <section class="chart-card hero-card" aria-label="接待人数与企业数">
      <div class="hero-head">
        <div class="hero-title"><h3>接待人数与企业数</h3>
          <div class="bignums lg">
            <div><b id="volUniqUsers">—</b><span><i style="background:#0B0B0C"></i>接待人数 · user_id 去重</span></div>
            <div><b id="volUniqOrgs">—</b><span><i style="background:#AAA9AB"></i>接待企业数 · billing_account_id 去重</span></div>
          </div></div>
        <div class="hero-right"><div class="seg" id="granUniq" role="tablist" aria-label="聚合粒度"></div><span class="hint-pill">最近 24 周 · 不随筛选 · 各周期独立去重，不可相加；总数为 24 周去重</span></div>
      </div>
      <div id="volUniq"></div>
    </section>
    <section class="chart-card" aria-label="渠道来源">
      <div class="chart-head between"><h3>渠道来源 · 每周会话数</h3><span class="chart-hint" id="hintWeekChannel"></span></div>
      <div class="multiples" id="chanGrid"></div>
    </section>
    <section class="chart-card" aria-label="渠道 × 会话性质">
      <div class="chart-head between"><h3>渠道 × 会话性质</h3><span class="chart-hint">颜色越深会话越多</span></div>
      <div class="table-wrapper flat"><table class="heat-table" id="tblChannelNature"></table></div>
    </section>
    <div class="grid two">
      <section class="chart-card" aria-label="设备 × 会话性质">
        <div class="chart-head between"><h3>设备 × 会话性质</h3><span class="chart-hint">颜色越深会话越多</span></div>
        <div class="table-wrapper flat"><table class="heat-table" id="tblDeviceNature"></table></div>
      </section>
      <section class="chart-card" aria-label="入口媒介 Top 12">
        <div class="chart-head between"><h3>入口媒介 Top 12</h3><span class="chart-hint">会话数</span></div>
        <ol class="medium-list" id="mediumList"></ol>
      </section>
    </div>
    <section class="chart-card" aria-label="入口媒介 · 最近 9 周">
      <div class="chart-head between top"><div class="hero-title"><h3>入口媒介 · 最近 9 周</h3><span class="chart-sub">每格 = 该媒介当周会话数 · 不随筛选 · 悬停看明细</span></div><span class="heat-legend"><span>少</span><i style="background:#E4E3E7"></i><i style="background:#BDBCC2"></i><i style="background:#8D8C93"></i><i style="background:#4A4A50"></i><i style="background:#0B0B0C"></i><span>多 · 空白 = 0</span></span></div>
      <div class="heat-scroll"><div class="heat-grid wide-label" id="mediumWeeks" role="img" aria-label="入口媒介 × 最近 9 周的会话数热力图"></div></div>
    </section>
  </section>

  <!-- ============ 分析 · AI 表现 ============ -->
  <section class="panel" id="panel-ai">
    <div class="grid two">
      <section class="chart-card" aria-label="最后接待对象">
        <div class="chart-head between"><h3>AI 独立率 · 最后接待对象</h3><span class="pill" id="aiRatePill">—</span></div>
        <div class="big-kpi"><b id="aiRateBig">—</b><span id="aiRateCaption"></span></div>
        <div class="units" id="aiUnits" aria-hidden="true"></div>
        <div class="legend lg" id="aiRateLegend"></div>
      </section>
      <section class="chart-card" aria-label="人工接待会话 Jiri 能否解答">
        <div class="chart-head between"><h3>转到人工的会话，Jiri 本来能否解答</h3><span class="chart-hint" id="canAnswerTotal"></span></div>
        <div class="tri-cols" id="canAnswerCols"></div>
        <div class="stack" id="canAnswerBar" style="height:18px" aria-hidden="true"></div>
      </section>
    </div>
    <section class="chart-card" aria-label="复问率">
      <div class="hero-head">
        <div class="hero-title"><h3>复问率 · 每周</h3><div class="big-kpi"><b class="mid" id="repeatBig">—</b><span id="repeatPill"></span></div><div class="hero-caption">同一用户隔 6～36 小时就同一问题再次进线的会话占比 · 最近 24 周 · 不随筛选</div></div>
        <span class="legend"><span><i class="dash"></i>警戒线 7%</span></span>
      </div>
      <div class="repeat-bars" id="repeatBars"></div>
      <div class="dc-x per" id="repeatAxis"></div>
    </section>
    <section class="chart-card" aria-label="人工有效、秒转与 Jiri 可解答">
      <div class="chart-head between"><h3>人工有效 · 秒转 · Jiri 可解答</h3><span class="chart-hint">三个指标量纲不同，分开画，不共用一根轴</span></div>
      <div class="trio-grid" id="trioCards"></div>
    </section>
    <section class="chart-card" aria-label="复问明细">
      <div class="chart-head between"><h3 id="repeatsHead">复问明细</h3><button type="button" class="more-link" id="repeatsMore" hidden>查看全部 →</button></div>
      <div class="table-wrapper flat"><div class="rt" id="tblRepeats"></div></div>
    </section>
  </section>

  <!-- ============ 分析 · 人工服务 ============ -->
  <section class="panel" id="panel-service">
    <section class="cards" id="serviceCards"></section>
    <div class="group-head"><span>01</span><h2>工作量与忙闲</h2><small>人工花了多少时间、什么时候最忙</small></div>
    <section class="chart-card" aria-label="每日人工接待时长与转人工次数">
      <div class="chart-head between top">
        <div class="hero-title"><h3 id="dailyServiceTitle">每日人工接待时长与转人工次数</h3><span class="chart-sub">连续无人工接待的日期合并成一格</span></div>
        <div class="legend"><span><i style="background:#AAA9AB"></i>人工时长（小时）</span><span><i class="ln" style="background:#0B0B0C"></i>转人工次数（右轴）</span></div>
      </div>
      <div id="dailyService"></div>
    </section>
    <div class="grid two">
      <section class="chart-card" aria-label="24 小时服务节奏">
        <div class="chart-head between top"><div class="hero-title"><h3>服务节奏 · 人工会话数</h3><span class="chart-sub">09:30～18:30，每格 15 分钟</span></div><span class="heat-legend"><span>少</span><i style="background:#E4E3E7"></i><i style="background:#BDBCC2"></i><i style="background:#8D8C93"></i><i style="background:#4A4A50"></i><i style="background:#0B0B0C"></i><span>多 · 空白 = 0</span></span></div>
        <div class="heat-scroll"><div class="heat-grid" id="hourlyGrid" role="img" aria-label="过去 7 天 × 15 分钟格的人工会话数热力图"></div></div>
      </section>
      <section class="chart-card service-busy-card" aria-label="人工服务忙闲分布">
        <div class="chart-head between top">
          <div class="hero-title"><h3>人工服务忙闲 · 15 分钟</h3><span class="chart-sub" id="manualBusySub">昨天 · 09:30～18:30 同时在线人工会话数</span></div>
        </div>
        <div class="busy-bars" id="manualBusyBars"></div>
        <div class="busy-axis" id="manualBusyAxis"></div>
        <div class="legend"><span><i style="background:#DBDADD"></i>空闲</span><span><i style="background:#8E8D93"></i>正常</span><span><i style="background:#0B0B0C"></i>超出容量</span></div>
      </section>
    </div>
    <section class="chart-card" aria-label="会话时长（按周）">
      <div class="chart-head between top">
        <div class="hero-title"><h3>会话时长 · 按周</h3><span class="chart-sub">柱：各会话性质的人工时长；线：单会话平均时长</span></div>
        <div class="legend"><span><i style="background:#0B0B0C"></i>有效</span><span><i style="background:#8E8D93"></i>填表人</span><span><i style="background:#DBDADD"></i>其他</span><span><i class="ln thick" style="background:#75FB90"></i>平均时长（右轴）</span></div>
      </div>
      <div id="weekDur"></div>
    </section>

    <div class="group-head"><span>02</span><h2>为什么转人工</h2><small>转人工的方式与原因；绿色为可避免</small></div>
    <div class="grid two">
      <section class="chart-card" aria-label="转人工方式">
        <div class="chart-head"><h3>转人工方式</h3></div>
        <div class="tri-cols two" id="wayCols"></div>
        <div class="stack" id="wayBar" style="height:18px" aria-hidden="true"></div>
      </section>
      <section class="chart-card" aria-label="转人工原因分布">
        <div class="chart-head between"><h3>转人工原因分布</h3><span class="legend"><span><i style="background:#75FB90"></i><span id="reasonAvoidable">可避免</span></span></span></div>
        <div class="reason-list" id="reasonList"></div>
      </section>
    </div>

    <div class="group-head"><span>03</span><h2>客服表现</h2><small>每位客服的接待量、速度与用户情绪</small></div>
    <section class="chart-card" aria-label="客服接待评估 · 累计">
      <div class="chart-head between"><h3>客服接待评估 · 累计</h3><span class="chart-hint" id="agentHintCum"></span></div>
      <div class="table-wrapper flat"><table class="report-table even" id="tblAgentsCum"></table></div>
    </section>
    <section class="chart-card" aria-label="场景 × 客服 单次接待时长中位数">
      <div class="chart-head between top">
        <div class="hero-title"><h3>场景 × 客服 · 单次接待时长中位数</h3><span class="chart-sub">和同场景的全员中位数比：越深越慢，绿色为明显更快；— 表示样本不足 3 次</span></div>
        <span class="heat-legend"><span>快</span><i class="w" style="background:#75FB90"></i><i class="w" style="background:#F1F0F3"></i><i class="w" style="background:#AAA9AB"></i><i class="w" style="background:#3A3A40"></i><span>慢</span></span>
      </div>
      <div class="heat-scroll"><div id="agentSceneHeat"></div></div>
    </section>
    <section class="chart-card" aria-label="用户情绪">
      <div class="chart-head between top">
        <div class="hero-title"><h3>用户情绪 · 按客服</h3><span class="chart-sub">负向场景取该客服负向会话最多的场景；比例为占其接待次数</span></div>
        <div class="legend"><span><i style="background:#0B0B0C"></i>负向</span><span><i style="background:#75FB90"></i>正向</span><span><i style="background:#ECEBEF"></i>中性</span></div>
      </div>
      <div class="heat-scroll"><div class="em" id="emotionAgents"></div></div>
    </section>
    <section class="chart-card" aria-label="情绪会话明细">
      <div class="chart-head between"><h3>情绪会话明细</h3>
        <div class="seg" id="emoTabs" role="tablist" aria-label="情绪类型"><button type="button" role="tab" data-mode="neg" aria-pressed="true">负向会话</button><button type="button" role="tab" data-mode="pos" aria-pressed="false">正向会话</button></div>
      </div>
      <div class="heat-scroll"><div class="ed" id="emoDetail"></div></div>
    </section>
  </section>

  <!-- ============ 分析 · 业务与套餐 ============ -->
  <section class="panel" id="panel-business">
    <div class="grid">
      <div class="chart-card">
        <div class="chart-head between"><h3>会话性质</h3><span class="chart-hint" id="totalNature2"></span></div>
        <div class="rank" id="rankNature"></div>
      </div>
      <div class="chart-card">
        <div class="chart-head between"><h3>当前套餐分布</h3><span class="chart-hint">套餐为空归入免费版</span></div>
        <div class="rank" id="rankPlan"></div>
      </div>
      <div class="chart-card">
        <div class="chart-head between"><h3>小金商户分类</h3><span class="chart-hint" id="totalXj"></span></div>
        <div class="rank" id="rankXj"></div>
      </div>
      <div class="chart-card wide">
        <div class="chart-head between"><h3>业务场景分布 · 有效会话</h3><span class="chart-hint">柱高 = 会话数；柱下依次为占比、Jiri 独立解决率、场景</span></div>
        <div class="vbars" id="sceneBars"></div>
      </div>
      <div class="chart-card wide">
        <div class="chart-head between"><h3>业务场景 × 套餐 · 有效会话</h3><span class="chart-hint">按行看：这个场景主要是哪类套餐的用户在问</span></div>
        <div class="table-wrapper flat"><table class="heat-table" id="crossTable"></table></div>
      </div>
    </div>
  </section>

  <!-- ============ 报告 · 周报 ============ -->
  <section class="panel" id="panel-weekly">
    <nav class="toc" aria-label="周报目录">
      <a href="#wk1"><span>01</span>目标追踪</a><a href="#wk2"><span>02</span>JIRI（AI）接待现状</a><a href="#wk3"><span>03</span>周度接待概览</a><a href="#wk4"><span>04</span>人工接待现状</a><a href="#wk5"><span>05</span>有效人工场景 × 工作量</a><a href="#wk6"><span>06</span>仅 Jiri 有效场景</a><a href="#wk7"><span>07</span>客服接待评估</a>
    </nav>

    <div class="report-block" id="wk1">
      <h3><span>01</span>目标追踪</h3>
      <div id="wkGoals"></div>
    </div>

    <div class="report-block" id="wk2">
      <h3><span>02</span>JIRI（AI）接待现状<small>本周 vs 上周同期</small></h3>
      <div class="report-hint" id="jiriHint"></div>
      <div class="table-wrapper"><table class="report-table even" id="tblJiri"></table></div>
      <div class="note kou" id="jiriNote"></div>
    </div>

    <div class="report-block" id="wk3">
      <h3><span>03</span>周度接待概览<small>到所选周为止的最近 5 周</small></h3>
      <div class="table-wrapper"><table class="report-table even" id="tblOverview"></table></div>
    </div>

    <div class="report-block" id="wk4">
      <h3><span>04</span>人工接待现状</h3>
      <div class="table-wrapper"><table class="report-table even" id="tblManual"></table></div>
      <div class="report-summary" id="manualSummary"></div>
      <div class="note kou" id="manualNote"></div>
    </div>

    <div class="report-block" id="wk5">
      <h3><span>05</span>有效人工场景 × 工作量<small>占比按时长 · 全表按接待次数</small></h3>
      <div class="table-wrapper"><table class="report-table even" id="tblScenes"></table></div>
      <div class="note kou">全表按 <b>接待次数</b>（「转人工会话接待次数」，一场会话转了几次人工就记几次），不用场次。
      末三列「秒转·可解答 / 占比 / 占比环比」= 有效人工里「转人工方式 = 直接转」且「Jiri 是否能解答 = 能」的接待次数、占本行接待次数的比、以及与上周同期的差。
      <b>注意两种环比的单位不同</b>：时长环比 / 时长同比是分钟的<b>相对变化（%）</b>；占比环比是两个百分比之间的差，单位是<b>百分点</b>（49% 对上周 33% 记 +16.0，不是 +16%）。——
      即用户没给 Jiri 机会、而 Jiri 本来答得了的那批。与「可避免转人工」（四类可避免原因 ÷ 全部转人工）和逐场读原文的「不愿沟通率」是三个不同的数。</div>
    </div>

    <div class="report-block" id="wk6">
      <h3><span>06</span>仅 Jiri 有效场景</h3>
      <div class="table-wrapper"><table class="report-table even" id="tblJiriScenes"></table></div>
    </div>

    <div class="report-block" id="wk7">
      <h3><span>07</span>客服接待评估<small id="agentHint">只看仅人工</small></h3>
      <div class="sub-block">
        <div class="sub-head"><i>A</i><b>接待量 · 秒转 · 复问</b><p>每位客服本周接了多少、首接的会话里有多少被「直接转」（秒转）、末接后有多少用户 6～36 小时内又来问同一件事（复问）。第一行是团队合计。</p></div>
        <div class="table-wrapper flat"><table class="report-table even" id="tblAgents"></table></div>
        <div class="note kou" id="agentNote"></div>
      </div>
      <div class="sub-block">
        <div class="sub-head"><i>B</i><b>接待速度 · 场景 × 客服</b><p>格内是该客服在该场景的单次接待时长中位数 / 接待次数；胶囊是与最右列「全员中位线」的差：绿＝更快，黑＝更慢；空白＝本周没接这类。</p></div>
        <div class="table-wrapper flat"><table class="report-table even" id="tblAgentSceneWk"></table></div>
      </div>
      <div class="sub-block">
        <div class="sub-head"><i>C</i><b>用户情绪 · 客服 × 场景</b><p>只列出现负向或正向情绪的组合；负向比、正向比的分母是该组合的接待次数。最后一行是全部合计。</p></div>
        <div class="table-wrapper flat"><table class="report-table even" id="tblEmotionWk"></table></div>
      </div>
      <div class="sub-block">
        <div class="sub-head"><i>D</i><b>情绪会话明细</b><p id="negHintWk">C 表对应的具体会话，负向在前、按时间倒序，点开可看原文。</p></div>
        <div class="table-wrapper flat"><table class="report-table even" id="tblEmotionNegWk"></table></div>
      </div>
    </div>
  </section>

  <!-- ============ 报告 · 业务闭环 ============ -->
  <section class="panel" id="panel-loop">
    <div class="grid">
      <div class="chart-card wide">
        <div class="loop-hero">
          <div class="loop-kpi" id="loopKpi"></div>
          <div class="loop-legend">
            <span><i class="sw sw-yes"></i>是（已收到数据）</span>
            <span><i class="sw sw-no"></i>否（窗口满仍未收到）</span>
            <span><i class="sw sw-pending"></i>待定（窗口未满、尚未收到）</span>
            <small id="hintLoopWeek"></small>
          </div>
        </div>
        <div class="loop-bars" id="loopWeeks"></div>
      </div>
      <div class="chart-card wide">
        <div class="chart-head between"><h3 id="loopTypeTitle">按业务分型</h3><span class="chart-hint" id="hintLoopType"></span></div>
        <div class="loop-types" id="loopTypes"></div>
      </div>
    </div>
  </section>

  <footer class="footer"><p>Powered by WDL</p></footer>
</main>
</div>
<script defer src="${jsUrl}"></script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ============== 登录与会话 ==============
// AUTH_USERS secret 格式："user1:pass1,user2:pass2"。线上必须配置；
// 缺失时拒绝所有请求，避免会话质量数据意外公开。
// 因为用 "," 分隔、":" 拆账号密码，并且逐项 trim()，所以**口令不能包含逗号、冒号或首尾空格**。
// 登录后发一个 HMAC 签名的 Cookie 当会话，避免每次都弹浏览器原生对话框；
// 签名密钥由 AUTH_USERS 派生 —— 改动账号即让所有旧会话失效。

const COOKIE_NAME = "hive_session";
const SESSION_DAYS = 7;

// 同一来源连续失败上限与窗口。KV 计数是最终一致的，短时突发仍可能多放几次进来；
// 这里挡的是「慢速穷举」，不是分布式爆破。
const LOGIN_FAIL_LIMIT = 8;
const LOGIN_FAIL_WINDOW_S = 900;
const K_LOGIN_FAIL_PREFIX = "hive:loginfail:v1:";

function userList(env) {
  return (env.AUTH_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function authEnabled(env) {
  return userList(env).length > 0;
}

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// 逐字节累积差异、不提前返回，避免用响应时间试探口令前缀
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 「user:pass」是否命中 AUTH_USERS。比的是 SHA-256 摘要（长度恒定 32 字节），
// 且匹配上也不 break —— 耗时只与账号条数有关，与口令内容无关。
async function matchesCredential(env, pair) {
  const list = userList(env);
  if (!list.length) return false;
  const target = await sha256Bytes(pair);
  let ok = false;
  for (const entry of list) {
    if (bytesEqual(await sha256Bytes(entry), target)) ok = true;
  }
  return ok;
}

// 边缘之后的头都可能被伪造；拿不到可信来源时退回 "unknown"，
// 意味着这一桶是所有匿名来源共用的 —— 限流会更严，不会更松。
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Real-IP")
    || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "unknown";
}

async function loginFailures(env, ip) {
  return Number(await env.CACHE.get(K_LOGIN_FAIL_PREFIX + ip)) || 0;
}

function noteLoginFailure(env, ip, current) {
  return env.CACHE.put(K_LOGIN_FAIL_PREFIX + ip, String(current + 1), {
    expirationTtl: LOGIN_FAIL_WINDOW_S,
  });
}

function clearLoginFailures(env, ip) {
  return env.CACHE.delete(K_LOGIN_FAIL_PREFIX + ip);
}

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sessionKey(env) {
  const raw = new TextEncoder().encode("hive-session|" + (env.AUTH_USERS || ""));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(env, user) {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86400000 }))
  );
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + b64urlEncode(new Uint8Array(sig));
}

async function readSession(env, token) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const key = await sessionKey(env);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u || null;
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Basic Auth 仍然接受（方便 curl / 接口调试），但不再主动发起挑战
async function basicUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    return (await matchesCredential(env, decoded)) ? decoded.split(":")[0] : null;
  } catch {
    return null;
  }
}

function sessionCookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; Path=/hive; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function renderLogin(env, opts) {
  const o = opts || {};
  const cssUrl = await env.ASSETS.url("/hive.css");
  return new Response(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · hive 服务看板</title>
<link rel="stylesheet" href="${cssUrl}">
</head>
<body class="login-body">
<div class="login-wrap">
  <form class="login-card" id="loginForm">
    <div class="login-logo">hive</div>
    <h1>hive 服务看板</h1>
    <p class="login-sub">AI 会话质检与人工接待数据</p>

    <label class="login-field">
      <span>账号</span>
      <input type="text" id="loginUser" autocomplete="username" required autofocus>
    </label>
    <label class="login-field">
      <span>密码</span>
      <input type="password" id="loginPass" autocomplete="current-password" required>
    </label>

    <div class="login-error" id="loginError" hidden></div>
    <button type="submit" class="btn login-btn" id="loginBtn">登 录</button>
    <p class="login-foot">登录状态保留 ${SESSION_DAYS} 天 · Powered by WDL</p>
  </form>
</div>
<script>
const form = document.getElementById("loginForm");
const errEl = document.getElementById("loginError");
const btn = document.getElementById("loginBtn");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  btn.disabled = true;
  btn.textContent = "登录中…";
  try {
    const res = await fetch("/hive/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: document.getElementById("loginUser").value.trim(),
        pass: document.getElementById("loginPass").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) { location.href = "/hive/"; return; }
    errEl.textContent = data.error || "登录失败，请重试";
    errEl.hidden = false;
  } catch (err) {
    errEl.textContent = "网络异常：" + err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "登 录";
  }
});
</script>
</body>
</html>`,
    { status: o.status || 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

// ============== 路由 ==============

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 登录：校验账号密码，通过则下发会话 Cookie
    if (path === "/api/login") {
      if (request.method !== "POST") return json({ success: false, error: "use POST" }, 405);
      if (!authEnabled(env)) {
        return json({ success: false, error: "服务暂不可用，请联系管理员。" }, 503);
      }

      // 先看限流再解析 body：超限的请求不该有机会触发任何比对
      const ip = clientIp(request);
      const fails = await loginFailures(env, ip);
      if (fails >= LOGIN_FAIL_LIMIT) {
        return json({ success: false, error: "尝试过于频繁，请稍后再试。" }, 429);
      }

      let body = {};
      try { body = await request.json(); } catch { /* 忽略 */ }
      const name = String(body.user || "").trim();
      if (!(await matchesCredential(env, name + ":" + String(body.pass || "")))) {
        ctx.waitUntil(noteLoginFailure(env, ip, fails));
        return json({ success: false, error: "账号或密码不正确" }, 401);
      }
      ctx.waitUntil(clearLoginFailures(env, ip));
      const token = await signSession(env, name);
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": sessionCookie(token, SESSION_DAYS * 86400),
        },
      });
    }

    if (path === "/api/logout") {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": sessionCookie("", 0),
        },
      });
    }

    // 页面只认会话 Cookie；接口额外接受 Basic 头（方便 curl 调试）。
    // 浏览器会把曾经输入过的 Basic 凭证一直自动带上，如果页面也认 Basic，
    // 「退出」清掉 Cookie 后仍会被放进来，表现就是点了没反应。
    if (!authEnabled(env)) {
      if (path === "/") {
        return new Response("服务暂不可用，请联系管理员。", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return json({ success: false, error: "服务暂不可用，请联系管理员。" }, 503);
    }

    const session = await readSession(env, cookieValue(request, COOKIE_NAME));
    const user = session || (await basicUser(request, env));

    if (path === "/") {
      if (!session) return renderLogin(env);
      return renderPage(env, session);
    }
    if (!user) {
      return json({ success: false, error: "未登录", login: true }, 401);
    }

    // 最近 24 周（含本周）的固定口径 stats：接待量页的「按设备分布 / 接待人数与企业数 / 渠道来源」和总览的接待人数图用，不随筛选
    if (path === "/api/fixed") {
      const meta = await readMeta(env);
      const version = dataVersionOf(meta);
      const key = version ? K_FIXED_PREFIX + version : "";
      if (key) {
        const hit = await env.CACHE.get(key, { type: "json" });
        if (hit) return json({ ...hit, meta });
      }
      const rows = await readEntries(env);
      if (!rows) return 构建中(env, ctx, meta);
      const from = fixedWindowFrom();
      const st = buildStats(rows.filter((r) => (r.t || "").slice(0, 10) >= from));
      const payload = {
        success: true, from, weeks: FIXED_WEEKS,
        stats: { total: st.total, byDay: st.byDay, byWeek: st.byWeek, uniq: st.uniq, uniqAll: st.uniqAll, channel: st.channel, device: st.device },
      };
      if (key) ctx.waitUntil(env.CACHE.put(key, JSON.stringify(payload)).catch((err) => console.error("[fixed] put failed:", err.message)));
      return json({ ...payload, meta });
    }

    if (path === "/api/dashboard") {
      const q = url.searchParams;
      const hasFilter = FILTER_KEYS.some((k) => q.get(k));

      // 无筛选走预聚合缓存（几 KB，最快）；有筛选才读明细现算
      if (!hasFilter) {
        const [cached, meta] = await Promise.all([
          env.CACHE.get(K_STATS, { type: "json" }),
          readMeta(env),
        ]);
        const stats = cached || (await 派生(env, ctx, K_STATS, buildStats));
        if (!stats) return 构建中(env, ctx, meta);
        return json({
          success: true, stats, meta, filtered: false,
          matched: stats.total, fullTotal: stats.total,
          facets: facetsOf(stats), latestDay: latestDayOf(stats),
        });
      }

      const range = resolveRange(q);
      const meta = await readMeta(env);
      const version = dataVersionOf(meta);

      // 命中记忆缓存就直接返回，连明细都不用读
      const cacheKey = version ? await queryCacheKey(q, version, range) : "";
      if (cacheKey) {
        const hit = await env.CACHE.get(cacheKey, { type: "json" });
        if (hit) return json({ ...hit, meta });
      }

      const [rows, cachedFull] = await Promise.all([
        readEntries(env),
        env.CACHE.get(K_STATS, { type: "json" }),
      ]);
      if (!rows) return 构建中(env, ctx, meta);
      // 全量 stats 只用来出筛选项和最新一天；缓存键刚换过时它可能还没写，现算一份补上
      const full = cachedFull || buildStats(rows);
      const filtered = applyFilters(rows, q, range);
      const previous = previousRange(range);
      const payload = {
        success: true,
        stats: buildStats(filtered),
        filtered: true,
        matched: filtered.length,
        fullTotal: rows.length,
        facets: facetsOf(full),
        latestDay: latestDayOf(full),
        resolvedFrom: range.from,
        resolvedTo: range.to,
        series: buildSeries(rows, q, range),
        previous: previous
          ? { ...buildStats(applyFilters(rows, q, previous)), ...previous }
          : null,
      };
      // 写缓存不挡响应；写失败只是下次再算一遍，不影响正确性
      if (cacheKey) {
        ctx.waitUntil(
          env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: QUERY_CACHE_TTL_S })
            .catch((err) => console.error("[query-cache] put failed:", err.message))
        );
      }
      return json({ ...payload, meta });
    }

    if (path === "/api/loop") {
      const [cached, meta] = await Promise.all([
        env.CACHE.get(K_LOOP, { type: "json" }),
        readMeta(env),
      ]);
      const loop = cached || (await 派生(env, ctx, K_LOOP, buildLoop));
      if (!loop) return 构建中(env, ctx, meta);
      return json({ success: true, loop, meta });
    }

    if (path === "/api/weekly") {
      const [cached, meta] = await Promise.all([
        env.CACHE.get(K_WEEKLY, { type: "json" }),
        readMeta(env),
      ]);
      const weekly = cached || (await 派生(env, ctx, K_WEEKLY, buildWeekly));
      if (!weekly) return 构建中(env, ctx, meta);
      return json({ success: true, weeks: weekly, meta });
    }

    // 后台刷新：立即返回，进度写在 meta 里
    if (path === "/api/refresh") {
      if (request.method !== "POST") return json({ success: false, error: "use POST" }, 405);
      const meta = await readMeta(env);
      if (isRunning(meta)) return json({ success: true, alreadyRunning: true, meta }, 202);
      ctx.waitUntil(refreshCache(env, "full"));   // 手动拉取走全量：顺带兜住增量看不到的删除
      return json({ success: true, started: true }, 202);
    }

    if (path === "/api/status") return json({ success: true, meta: await readMeta(env) });


    return new Response("Not Found", { status: 404 });
  },
};

// 给 scripts/preview.mjs 和本地自测用：预览按线上同一套分块格式写明细
export { writeEntries, readEntries, refreshCache, fetchUpdatedSince, bjTime };
