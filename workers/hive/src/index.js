// hive 服务看板 — 数据源：金数据表单 EQca39
const FORM_TOKEN = "EQca39";
const JSJ_BASE = `https://next.jinshuju.net/api/v1/forms/${FORM_TOKEN}/entries`;

// v6 在 manualBusy 里下发时段定义（起点/格宽/格数），前端不再硬编码。
// v3 的明细去掉了全链路无消费者的 sn/url/sm/inWindow/creator。
// v7 / v4（2026-09-17）：明细加回 url（会话地址）并新增 rep/repFrom（复问、复问自，读质检表 field_33/34），
// 日/周桶新增 rep（复问数），stats 新增 repeats 明细。weekly v2：目标追踪加 guideSplit（操作引导占比按 Jiri 能否解答拆分）；v3：加 jiri（JIRI 接待现状板块，读 field_35/36）；v4：加 agents/agentsCum（客服接待评估，读 field_37~39）；stats v8 / entries v5 / weekly v5（2026-09-18）：明细加 emo（field_40 用户情绪），新增 秒转·可解答、客服×场景时长、用户情绪三项。
// 旧 v3 明细没有这些字段，读到会把复问率画成全 0，所以三个键一起换，让首次访问后台重建。
// 保留旧版本键，不删除既有 KV，首次访问会安全地后台重建新缓存。
const K_STATS = "hive:stats:v8";
const K_ENTRIES = "hive:entries:v5";
const K_WEEKLY = "hive:weekly:v5";
const K_LOOP = "hive:loop:v1";
const K_META = "hive:meta:v1";
// 筛选结果记忆缓存：键里带 meta.updatedAt，数据一刷新自然失效；
// TTL 只用来回收过期键，不承担正确性。
const K_QUERY_PREFIX = "hive:q:v3:";
const QUERY_CACHE_TTL_S = 3600;

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

// 精简条目：只留看板/周报要用的字段，控制 KV value 体积。
// 只保留有消费者的字段 —— 明细每多一个字段，筛选路径就要多解析 6600 次。
function trim(e) {
  return {
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
    dev: {}, ch: {}, nat: {},
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

const BUSY_START_MINUTE = 9 * 60 + 30;
const BUSY_END_MINUTE = 19 * 60;
const BUSY_SLOT_MINUTES = 15;
const BUSY_SLOT_COUNT = (BUSY_END_MINUTE - BUSY_START_MINUTE) / BUSY_SLOT_MINUTES;

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

function buildStats(rows) {
  const s = {
    total: rows.length,
    jiri: {}, way: {}, reason: {}, avoidable: 0, transferred: 0,
    daily: {}, channel: {}, device: {}, medium: {}, status: {},
    scene: {}, plan: {}, sceneByPlan: {}, xjCategory: {},
    nature: {}, durSum: 0, durCount: 0, turnsSum: 0,
    // 按天 / 按周的复合桶，供堆叠柱 + 双轴折线用
    byDay: {}, byWeek: {},
    // 最近 7 个自然日的逐小时服务节奏；小时以金数据记录的原始日历时间划分，
    // 与现有按天统计保持同一口径。
    hourly: { days: [], byDay: {} },
    // 最近 7 个自然日的人工服务忙闲图。时段定义随数据一起下发（slot），
    // 前端不再各写一份常量 —— 改窗口只需改这里。
    // active   = 该格内同时处于人工接待中的会话数，靠时长铺开，所以**只统计有时长的会话**；
    // incoming = 该格内新进入人工接待的会话数，不要求有时长。
    // 两个口径的分母因此不同，差额记在 noDuration 里，由前端如实说明。
    manualBusy: {
      days: [], byDay: {},
      slot: {
        startMinute: BUSY_START_MINUTE,
        endMinute: BUSY_END_MINUTE,
        slotMinutes: BUSY_SLOT_MINUTES,
        slotCount: BUSY_SLOT_COUNT,
      },
      noDuration: 0,
    },
    // 接待人数（user_id 去重）/ 接待企业数（billing_account_id 去重）。
    // 去重计数不能跨周期相加——一个用户在两天各来一次，按天是 2、按月是 1——
    // 所以每个粒度各自去重一次，不能让客户端从日粒度累加。
    uniq: {},
    // 全区间去重总数。各周期的去重数不能相加，所以「总计」必须单独算一份。
    uniqAll: { users: 0, orgs: 0 },
    // 交叉分布
    natureByDevice: {}, natureByChannel: {}, effectiveScene: {},
    // 复问明细（时间 / 本场会话地址 / 前一场会话地址），给「复问明细」表；只含 复问=是 的行，量很小
    repeats: [],
  };
  const durations = [];
  const latestRowDay = rows.map((r) => String(r.t || "").slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().pop();
  s.hourly.days = recentCalendarDays(latestRowDay);
  for (const day of s.hourly.days) {
    s.hourly.byDay[day] = Array.from({ length: 24 }, () => ({ jiri: 0, manual: 0, manualDur: 0 }));
  }
  s.manualBusy.days = [...s.hourly.days];
  for (const day of s.manualBusy.days) {
    s.manualBusy.byDay[day] = Array.from({ length: BUSY_SLOT_COUNT }, () => ({ active: 0, incoming: 0 }));
  }
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
    if (r.nat === "有效") tally(s.effectiveScene, r.scene);

    const day = r.t ? r.t.slice(0, 10) : "";
    const hourSlot = timestampDayMinute(r.t);
    if (hourSlot && s.hourly.byDay[hourSlot.day]) {
      const hourly = s.hourly.byDay[hourSlot.day][hourSlot.hour];
      if (r.st === "仅 Jiri") hourly.jiri++;
      if (r.st === "仅人工") {
        hourly.manual++;
        if (typeof r.dur === "number" && r.dur > 0) hourly.manualDur += r.dur;
      }
    }
    if (hourSlot && r.st === "仅人工" && s.manualBusy.byDay[hourSlot.day]) {
      const slots = s.manualBusy.byDay[hourSlot.day];
      const hasDuration = typeof r.dur === "number" && r.dur > 0;
      if (hourSlot.minute >= BUSY_START_MINUTE && hourSlot.minute < BUSY_END_MINUTE) {
        const incomingIndex = Math.floor((hourSlot.minute - BUSY_START_MINUTE) / BUSY_SLOT_MINUTES);
        slots[incomingIndex].incoming++;
        // 进了 incoming 却永远进不了 active 的会话，数出来让前端说清楚差额
        if (!hasDuration) s.manualBusy.noDuration++;
      }
      if (hasDuration) {
        const serviceEnd = Math.min(hourSlot.minute + r.dur / 60, BUSY_END_MINUTE);
        for (let index = 0; index < BUSY_SLOT_COUNT; index++) {
          const slotStart = BUSY_START_MINUTE + index * BUSY_SLOT_MINUTES;
          const slotEnd = slotStart + BUSY_SLOT_MINUTES;
          if (hourSlot.minute < slotEnd && serviceEnd > slotStart) slots[index].active++;
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
        if (typeof r.dur === "number" && r.dur > 0) { b.dur += r.dur; b.durCount++; }
        if (typeof r.turns === "number") b.turns += r.turns;
        if (r.way) b.transfer++;
        if (r.st === "仅 Jiri") b.aiOnly++;
        if (AVOIDABLE_REASONS.has(r.reason)) b.avoidable++;
        if (r.rep) b.rep++;
        if (r.st === "仅人工" && r.nat === "有效") {
          b.sjBase += receptions(r);
          if (isSecondTransfer(r)) b.sj += receptions(r);
        }
      }
      if (r.rep) s.repeats.push({ t: r.t, url: r.url, from: r.repFrom });
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
  s.repeats.sort((a, b) => (b.t || "").localeCompare(a.t || ""));
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
  const cell = (list) => (list.length
    ? { v: Number((median(list.map((x) => x.min * 60)) / 60).toFixed(1)), n: list.reduce((a, x) => a + x.cnt, 0) }
    : null);
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

// 用户情绪（2026-09-18 用户定）：三档直接显示。**三档计数覆盖该客服接的全部仅人工会话、不剔无效与填表人**；
// 「其中有效」另给一列作参照。归属取末接客服（谁收尾算谁，与复问一致）。第 27~28 周导出没这列，计入「无标注」。
function emotionStats(manual) {
  const byAgent = {};
  const teamScene = {};
  const blank = () => ({ total: 0, eff: 0, neg: 0, neu: 0, pos: 0, none: 0 });
  const add = (o, r) => {
    o.total++;
    if (r.nat === "有效") o.eff++;
    if (r.emo === "负向") o.neg++;
    else if (r.emo === "中性") o.neu++;
    else if (r.emo === "正向") o.pos++;
    else o.none++;
  };
  const team = blank();
  for (const r of manual) {
    add(team, r);
    if (r.csLast) add(byAgent[r.csLast] || (byAgent[r.csLast] = blank()), r);
    // 按场景只算有情绪标注的行，否则负向率会被没这列的老周稀释
    if (r.emo) add(teamScene[r.scene] || (teamScene[r.scene] = blank()), r);
  }
  const rate = (o) => {
    const d = o.neg + o.neu + o.pos;
    return d ? Number(((o.neg / d) * 100).toFixed(1)) : null;
  };
  return {
    team: { name: "合计", ...team },
    agents: Object.entries(byAgent).map(([name, o]) => ({ name, ...o })).sort((a, b) => b.total - a.total),
    scenes: Object.entries(teamScene).map(([name, o]) => ({ name, ...o, negRate: rate(o) }))
      .sort((a, b) => b.neg - a.neg || b.total - a.total),
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
    team: fin("团队基线", team),
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
      env.CACHE.put(K_LOOP, JSON.stringify(buildLoop(rows))),
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
function dataVersionOf(meta) {
  return meta && meta.status === "ok" && meta.updatedAt ? meta.updatedAt : "";
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

// 插进 HTML 的值一律转义。这里的 user 必然来自 AUTH_USERS，外部改不了，
// 但把「安全」建立在「上游恰好可信」上迟早出事，转义是零成本的。
function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function renderPage(env, user) {
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
      <span class="user-chip" title="当前登录账号">${escHtml(user)}</span>
      <button class="btn-ghost" id="logoutBtn">退出</button>
    </div>
  </div>
</header>

<main class="main">
  <div id="banner" class="banner" hidden></div>

  <div class="filter-sentinel" id="filterSentinel" aria-hidden="true"></div>
  <div class="sticky-top" id="stickyTop">
  <section class="filterbar" id="filterbar">
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
  <nav class="tabs">
    <button class="tab active" data-tab="weekly">周报</button>
    <button class="tab" data-tab="service">服务概览</button>
    <button class="tab" data-tab="trend">会话量趋势与来源</button>
    <button class="tab" data-tab="scene">业务场景与套餐</button>
    <button class="tab" data-tab="loop">业务闭环</button>
  </nav>
  </div>

  <section class="cards" id="cards"></section>

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
      <h3>二、JIRI（AI）接待现状</h3>
      <div class="table-wrapper"><table class="report-table" id="tblJiri"></table></div>
      <div class="note" id="jiriNote"></div>
    </div>

    <div class="report-block">
      <h3>三、周度接待概览</h3>
      <div class="table-wrapper"><table class="report-table" id="tblOverview"></table></div>
    </div>

    <div class="report-block">
      <h3>四、人工接待现状</h3>
      <div class="table-wrapper"><table class="report-table" id="tblManual"></table></div>
      <div class="note" id="manualNote"></div>
    </div>

    <div class="report-block">
      <h3>五、有效人工场景 × 工作量（占比按时长）</h3>
      <div class="table-wrapper"><table class="report-table" id="tblScenes"></table></div>
      <div class="note"><span class="dim-note">全表按 <b>接待次数</b>（「转人工会话接待次数」，一场会话转了几次人工就记几次），不用场次。
      末三列「秒转·可解答 / 占比 / 占比环比」= 有效人工里「转人工方式 = 直接转」且「Jiri 是否能解答 = 能」的接待次数、占本行接待次数的比、以及与上周同期的百分点差——
      即用户没给 Jiri 机会、而 Jiri 本来答得了的那批。与「可避免转人工」（四类可避免原因 ÷ 全部转人工）和逐场读原文的「不愿沟通率」是三个不同的数。</span></div>
    </div>

    <div class="report-block">
      <h3>六、仅 Jiri 有效场景</h3>
      <div class="table-wrapper"><table class="report-table" id="tblJiriScenes"></table></div>
    </div>

    <div class="report-block">
      <h3>七、客服接待评估（只看仅人工）</h3>
      <div class="report-hint" id="agentHint" style="margin-bottom:10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblAgents"></table></div>
      <div class="report-hint" id="agentHintCum" style="margin:18px 0 10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblAgentsCum"></table></div>
      <div class="note" id="agentNote"></div>
      <div class="report-hint" id="asHintWk" style="margin:18px 0 10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblAgentSceneWk"></table></div>
      <div class="report-hint" id="emoHintWk" style="margin:18px 0 10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblEmotionWk"></table></div>
      <div class="note" id="emoNoteWk"></div>
    </div>


  </section>

  <section class="panel" id="panel-service">
    <div class="grid">
      <div class="chart-card"><h3>人工接待会话 Jiri 能否解答</h3><canvas id="chartJiri"></canvas></div>
      <div class="chart-card"><h3>转人工方式</h3><canvas id="chartWay"></canvas></div>
      <div class="chart-card"><h3>最后接待对象（仅人工 / 仅 Jiri）</h3><canvas id="chartStatus"></canvas></div>
      <div class="chart-card wide"><h3>转人工原因分布</h3><canvas id="chartReason"></canvas></div>
    </div>
    <div class="note" id="noteAvoidable"></div>

    <div class="report-block">
      <h3>场景 × 客服 · 单次接待时长中位数</h3>
      <div class="report-hint" id="asHint" style="margin-bottom:10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblAgentScene"></table></div>
      <div class="note" id="asNote"></div>
    </div>

    <div class="report-block">
      <h3>用户情绪</h3>
      <div class="report-hint" id="emoHint" style="margin-bottom:10px"></div>
      <div class="table-wrapper"><table class="report-table" id="tblEmotion"></table></div>
      <div class="report-hint" style="margin:18px 0 10px">按业务场景（只算有情绪标注的会话）</div>
      <div class="table-wrapper"><table class="report-table" id="tblEmotionScene"></table></div>
      <div class="note" id="emoNote"></div>
    </div>
  

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
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>24 小时服务节奏</h3>
          <span class="chart-total" id="totalHourlyService"></span>
          <div class="hourly-day-tabs" id="hourlyDayTabs" aria-label="选择统计日期"></div>
        </div>
        <canvas id="chartHourlyService"></canvas>
        <div class="note dim-note" id="hourlyServiceNote"></div>
      </div>
      <div class="chart-card wide service-busy-card">
        <div class="chart-head">
          <div>
            <h3>人工服务忙闲分布</h3>
            <span class="chart-total" id="manualBusyHint"></span>
          </div>
          <div class="manual-busy-modes" id="manualBusyModes" aria-label="选择人工服务统计方式">
            <button type="button" data-mode="active" aria-pressed="true">同时服务人数</button>
            <button type="button" data-mode="incoming" aria-pressed="false">新转人工人数</button>
          </div>
        </div>
        <div class="manual-busy-layout">
          <div class="manual-busy-grid" id="manualBusyGrid" aria-label="最近七天人工服务忙闲分布"></div>
        </div>
        <div class="manual-busy-footer">
          <p class="manual-busy-summary" id="manualBusySummary" aria-live="polite"></p>
          <div class="manual-busy-legend"><span>少</span><i class="busy-level-1"></i><i class="busy-level-2"></i><i class="busy-level-3"></i><i class="busy-level-4"></i><i class="busy-level-5"></i><span>多</span></div>
        </div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-loop">
    <div class="grid">
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>业务闭环 · 每周趋势</h3>
          <span class="chart-total" id="totalLoopWeek"></span>
          <span class="chart-hint" id="hintLoopWeek"></span>
        </div>
        <canvas id="chartLoopWeek"></canvas>
        <div class="note" id="loopWeekNote"></div>
      </div>
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>业务闭环 · 按业务分型</h3>
          <span class="chart-total" id="totalLoopType"></span>
          <span class="chart-hint" id="hintLoopType"></span>
        </div>
        <canvas id="chartLoopType"></canvas>
        <div class="note" id="loopTypeNote"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-trend">
    <div class="grid">
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>会话接待分布</h3>
          <select id="granRecept" class="chart-grain" title="聚合粒度">
            <option value="day">按天</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
            <option value="quarter">按季度</option>
            <option value="year">按年</option>
          </select>
          <span class="chart-total" id="totalDayRecept"></span>
        </div>
        <canvas id="chartDayRecept"></canvas>
      </div>
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>复问率</h3>
          <select id="granRepeat" class="chart-grain" title="聚合粒度">
            <option value="day">按天</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
            <option value="quarter">按季度</option>
            <option value="year">按年</option>
          </select>
          <span class="chart-total" id="totalRepeat"></span>
          <span class="chart-hint">复问 = 同一用户隔 6～36 小时再进线、且问的是同一件事；复问率 = 复问会话数 ÷ 会话数</span>
        </div>
        <canvas id="chartRepeat"></canvas>
      </div>
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>人工有效·秒转·jiri 可解答</h3>
          <select id="granSecond" class="chart-grain" title="聚合粒度">
            <option value="day">按天</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
            <option value="quarter">按季度</option>
            <option value="year">按年</option>
          </select>
          <span class="chart-total" id="totalSecond"></span>
          <span class="chart-hint">用户直接要人工、而 Jiri 本来答得了的接待次数；分母 = 有效人工接待次数</span>
        </div>
        <canvas id="chartSecond"></canvas>
      </div>
      <div class="chart-card wide tall">
        <div class="chart-head">
          <h3>接待人数与企业数</h3>
          <select id="granUniq" class="chart-grain" title="聚合粒度">
            <option value="day">按天</option>
            <option value="week">按周</option>
            <option value="month">按月</option>
            <option value="quarter">按季度</option>
            <option value="year">按年</option>
          </select>
          <span class="chart-total" id="totalReceptUniq"></span>
          <span class="chart-hint" id="hintReceptUniq"></span>
        </div>
        <canvas id="chartReceptUniq"></canvas>
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
    <div class="report-block">
      <h3>复问明细</h3>
      <div class="table-wrapper"><table class="report-table" id="tblRepeats"></table></div>
      <div class="note" id="repeatsNote"></div>
    </div>
  </section>

  <section class="panel" id="panel-scene">
    <div class="grid">
      <div class="chart-card">
        <div class="chart-head"><h3>会话性质</h3><span class="chart-total" id="totalNature2"></span></div>
        <canvas id="chartNature2"></canvas>
      </div>
      <div class="chart-card"><h3>当前套餐分布</h3><canvas id="chartPlan"></canvas></div>
      <div class="chart-card">
        <div class="chart-head"><h3>小金商户分类</h3><span class="chart-total" id="totalXj"></span></div>
        <canvas id="chartXj"></canvas>
      </div>
      <div class="chart-card wide"><h3>业务场景分布（有效会话）</h3><canvas id="chartScene"></canvas></div>
      <div class="chart-card wide">
        <h3>业务场景 × 套餐（有效会话）</h3>
        <div class="table-wrapper compact"><table id="crossTable"></table></div>
      </div>
    </div>
  </section>

</main>

<footer class="footer"><p>Powered by WDL</p></footer>
<script defer src="${chartUrl}"></script>
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

      const range = resolveRange(q);
      const meta = await readMeta(env);
      const version = dataVersionOf(meta);

      // 命中记忆缓存就直接返回，连明细都不用读
      const cacheKey = version ? await queryCacheKey(q, version, range) : "";
      if (cacheKey) {
        const hit = await env.CACHE.get(cacheKey, { type: "json" });
        if (hit) return json({ ...hit, meta });
      }

      const [rows, full] = await Promise.all([
        env.CACHE.get(K_ENTRIES, { type: "json" }),
        env.CACHE.get(K_STATS, { type: "json" }),
      ]);
      if (!rows) {
        kickoff(env, ctx, meta);
        return json({ success: true, building: true, meta: await readMeta(env) });
      }
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
      const [loop, meta] = await Promise.all([
        env.CACHE.get(K_LOOP, { type: "json" }),
        readMeta(env),
      ]);
      if (!loop) {
        kickoff(env, ctx, meta);
        return json({ success: true, building: true, meta: await readMeta(env) });
      }
      return json({ success: true, loop, meta });
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

    // 后台刷新：立即返回，进度写在 meta 里
    if (path === "/api/refresh") {
      if (request.method !== "POST") return json({ success: false, error: "use POST" }, 405);
      const meta = await readMeta(env);
      if (isRunning(meta)) return json({ success: true, alreadyRunning: true, meta }, 202);
      ctx.waitUntil(refreshCache(env));
      return json({ success: true, started: true }, 202);
    }

    if (path === "/api/status") return json({ success: true, meta: await readMeta(env) });


    return new Response("Not Found", { status: 404 });
  },
};
