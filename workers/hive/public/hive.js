// hive — AI 会话质检看板前端
// worker 挂在 /hive/ 下，所有请求必须带前缀
const BASE = "/hive";

// 2026-10 改版：黑白灰 + 品牌绿。绿色只给「达标 / AI 接住 / 上升 / 可避免」这类要被看见的东西，
// 其余一律用灰阶区分层级。见 DESIGN.md「色彩」。
const INK = "#0B0B0C";
const GREEN = "#75FB90";
const GRAYS = ["#0B0B0C", "#55545A", "#8D8C93", "#AAA9AB", "#C9C8CD", "#DBDADD", "#E9E8EC"];

const state = { stats: null, resolvedFrom: "", resolvedTo: "", facets: null, refreshing: false, polling: false, weeks: [], weeklyLoaded: false, latestDay: null, loop: null, loopLoaded: false, hourlyDay: null, tab: "overview" };

// 筛选项 → 接口参数名；选项值来自首次全量结果，筛选后不再改动
const DIM_SELECTS = {
  fDevice: { dim: "device", placeholder: "全部" },
  fScene: { dim: "scene", placeholder: "全部" },
  fNature: { dim: "nature", placeholder: "全部" },
};

// ============== 工具 ==============

function $(id) { return document.getElementById(id); }

function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

// 首屏先占位，避免大片空白
function renderSkeleton() {
  const labels = ["会话总数", "AI 独立率", "可避免转人工", "人工接待总时长", "接待轮次"];
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

function pct(n, d, digits) {
  return d ? ((n / d) * 100).toFixed(digits ?? 1) : "0";
}

// 统一走这里，401 和非 JSON 响应都给出可读的提示
async function api(path, init) {
  const res = await fetch(BASE + path, init);
  if (res.status === 401) {
    // 会话过期：直接回登录页，不用让用户自己刷新
    location.href = BASE + "/";
    throw new Error("登录状态已失效，正在跳转登录页…");
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

function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");   // 原型：千分位，不缩写成 K
  return n.toFixed(n < 10 ? 2 : 1);
}

// 分类固定配色，跨图表保持一致。只用灰阶：堆叠段之间有 2px 白缝，靠明度就分得开。
const COLOR_NATURE = {
  "有效": "#0B0B0C", "填表人": "#8D8C93", "无效": "#C9C8CD",
  "转接未应答": "#AAA9AB", "电话引导·发链接图片": "#55545A",
  "内部测试": "#DBDADD", "未标记": "#E9E8EC",
};
const COLOR_DEVICE = { pc: "#0B0B0C", mobile: "#AAA9AB", "未知": "#DBDADD" };

function colorFor(map, key, i) {
  return map[key] || GRAYS[(i + 2) % GRAYS.length];
}


// ============== 悬停：整列浅灰底 + 深色提示卡 ==============

// 悬停时给所在列铺一块浅灰圆角底（替代原来的竖向虚线），柱子画在它上面
function tipEl() {
  let el = document.getElementById("hive-glass-tooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "hive-glass-tooltip";
    el.className = "chart-glass-tooltip";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  return el;
}

function deltaClass(text) {
  return /▲|^\+/.test(text) ? "up" : /▼|^-/.test(text) ? "down" : "flat";
}

// 统一的悬停卡：标题 + 每个序列一行（柱=方块、线=短横）+ 底部合计（可带涨跌胶囊）+ 备注。
// rows: [{ name, value, color, line }]；foot: { name, value, delta }
function paintTip(title, rows, foot, notes) {
  const el = tipEl();
  el.replaceChildren();
  if (title) {
    const t = document.createElement("div");
    t.className = "chart-glass-tooltip-title";
    t.textContent = title;
    el.appendChild(t);
  }
  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "chart-glass-tooltip-row";
    const marker = document.createElement("span");
    marker.className = "chart-glass-tooltip-marker" + (r.line ? " is-line" : "");
    if (String(r.color).startsWith("repeating")) marker.style.background = r.color;
    else marker.style.backgroundColor = r.color;
    const name = document.createElement("span");
    name.textContent = r.name;
    const val = document.createElement("b");
    val.textContent = r.value;
    row.append(marker, name, val);
    el.appendChild(row);
  });
  if (foot) {
    const f = document.createElement("div");
    f.className = "chart-glass-tooltip-foot";
    const name = document.createElement("span");
    name.textContent = foot.name;
    f.appendChild(name);
    if (foot.delta) {
      const d = document.createElement("span");
      d.className = "dl " + deltaClass(foot.delta);
      d.textContent = foot.delta;
      f.appendChild(d);
    }
    const v = document.createElement("b");
    v.textContent = foot.value;
    f.appendChild(v);
    el.appendChild(f);
  }
  (notes || []).filter(Boolean).forEach((text) => {
    const n = document.createElement("div");
    n.className = "chart-glass-tooltip-note";
    n.textContent = text;
    el.appendChild(n);
  });
  return el;
}

// 放到锚点右侧；越过视口中线就翻到左侧，避免盖住鼠标正在看的那根柱子。
// 动效：已经显示着时，位置走弹簧过渡（hive.css 的 .chart-glass-tooltip.visible），换列时带着速度滑过去、中途换向也能接上；
// 从隐藏到出现那一下先瞬移到位、再淡入上浮，不会从上一次的位置飞过来
function placeTip(el, anchorX, anchorY) {
  const w = el.offsetWidth, h = el.offsetHeight;
  glassify(el, { radius: 16, bezel: 14, scale: 26, tail: "blur(10px) saturate(170%)" });
  let left = anchorX > window.innerWidth / 2 ? anchorX - w - 14 : anchorX + 14;
  left = Math.min(Math.max(12, left), window.innerWidth - w - 12);
  let top = anchorY - h / 2;
  top = Math.min(Math.max(12, top), window.innerHeight - h - 12);
  if (!el.classList.contains("visible")) {
    el.classList.add("jump");
    el.style.left = left + "px";
    el.style.top = top + "px";
    void el.offsetWidth;
    el.classList.remove("jump");
    el.classList.add("visible");
  } else {
    el.style.left = left + "px";
    el.style.top = top + "px";
  }
}

function hideTip() {
  const el = document.getElementById("hive-glass-tooltip");
  if (el) el.classList.remove("visible");
}

// DOM 图形（小倍数、闭环周柱、业务场景竖柱）的悬停卡：同一个元素、同一套样式
function bindDomTip(container, describe) {
  container.addEventListener("mousemove", (event) => {
    const col = event.target.closest("[data-tip]");
    if (!col || !container.contains(col)) { hideTip(); return; }
    const spec = describe(Number(col.dataset.tip), col);
    if (!spec) { hideTip(); return; }
    const el = paintTip(spec.title, spec.rows || [], spec.foot, spec.notes);
    const box = col.getBoundingClientRect();
    placeTip(el, box.left + box.width / 2, Math.max(box.top + 60, event.clientY));
  });
  container.addEventListener("mouseleave", hideTip);
}

// ============== DOM 柱线图（与 Design 原型同一套画法） ==============
// 原型里的柱线图不是 Chart.js，而是 flex 排的胶囊柱 + 一条 SVG 平滑曲线；悬停整列铺浅灰底，提示卡走 bindDomTip。
// 总览「会话接待分布」、接待量页的两张分布图、人工服务页的每日图 / 会话时长图全部用这一个函数。

// 单调三次插值（Fritsch–Carlson）的平滑折线：曲线不会在两个点之间冲过头——一串 0 旁边不会凹到 0 以下。
// pts = [[x, y], ...]，坐标已映射到 viewBox
function smoothPath(pts) {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return "M" + (pts[0][0] - 30).toFixed(1) + " " + pts[0][1].toFixed(1) + "L" + (pts[0][0] + 30).toFixed(1) + " " + pts[0][1].toFixed(1);
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); dy.push(pts[i + 1][1] - pts[i][1]); m.push(dx[i] ? dy[i] / dx[i] : 0); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!m[i]) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b);
    if (h > 3) { t[i] = 3 * a / h * m[i]; t[i + 1] = 3 * b / h * m[i]; }
  }
  let d = "M" + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += "C" + (pts[i][0] + h).toFixed(1) + " " + (pts[i][1] + t[i] * h).toFixed(1) + "," +
      (pts[i + 1][0] - h).toFixed(1) + " " + (pts[i + 1][1] - t[i + 1] * h).toFixed(1) + "," +
      pts[i + 1][0].toFixed(1) + " " + pts[i + 1][1].toFixed(1);
  }
  return d;
}

// ============== 动效（2026-10-15）：阻尼弹簧闭式解，不迭代、不用物理引擎 ==============
// CSS 侧用 linear() 采样同一条弹簧（hive.css 的 --spring-soft / --spring-snap）；这里给 JS 补间（折线变形、数字滚动）用。
// 系统开了「减少动态效果」时一律不动。
const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// 归一化弹簧：t ∈ [0,1] → 位移比例；zeta 阻尼比，k 决定在 t=1 前衰减几个时间常数
function springAt(t, zeta, k) {
  if (t >= 1) return 1;
  const w = k / zeta, wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}
const SPRING_SNAP = (t) => springAt(t, 0.86, 7);

// ============== 液态玻璃（2026-10-19，v2.2） ==============
// 只用在浮在内容上的控件：图表悬停卡（深色玻璃）、区间条带的两只把手（浅色玻璃）、吸顶筛选栏、手机抽屉。卡片本身仍然实心、无阴影。
// 材质 = 半透明底 + backdrop 模糊提饱和 + 边缘高光（CSS），Chromium 里再叠一层「边缘折射」：
// 按元素尺寸算一张位移图（圆角矩形的边缘带里，像素沿法线往里取样，越靠边越强），
// 用 SVG feDisplacementMap 作为 backdrop-filter 的第一步，透过玻璃看到的柱子在边缘会弯一下——这是液态玻璃和普通毛玻璃的区别。
// Safari / Firefox 不支持 backdrop-filter: url()，只用模糊；系统开了「减少透明度」时全部退回实色（CSS 里处理）。
const REDUCED_TRANSPARENCY = typeof matchMedia === "function" && matchMedia("(prefers-reduced-transparency: reduce)").matches;
const GLASS_REFRACT = !REDUCED_TRANSPARENCY && typeof document !== "undefined" &&
  !!(navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand)));
const glassCache = new Map();
let glassDefs = null;
// 圆角矩形的位移图：w × h、圆角 r、边缘带宽 bezel（px）；返回 filter id
function glassFilter(w, h, r, bezel, scale) {
  w = Math.max(4, Math.round(w)); h = Math.max(4, Math.round(h));
  // 位移图按屏幕像素密度画（Retina 上 2 倍），否则边缘会有锯齿
  const dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const key = w + "x" + h + "x" + r + "x" + bezel + "x" + scale + "@" + dpr;
  if (glassCache.has(key)) return glassCache.get(key);
  const W = w * dpr, Hh = h * dpr;
  const c = document.createElement("canvas");
  c.width = W; c.height = Hh;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, Hh);
  const rr = Math.min(r, w / 2, h / 2);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / dpr - w / 2, py = (y + 0.5) / dpr - h / 2;
      const qx = Math.abs(px) - (w / 2 - rr), qy = Math.abs(py) - (h / 2 - rr);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const sd = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rr;   // <0 在里面
      const d = -sd;                                                        // 离边多远
      let dx = 0, dy = 0;
      if (d >= 0 && d < bezel) {
        // 凸透镜式的边：越靠边折得越厉害（平方根曲线，边上陡、往里很快变平）
        const t = 1 - d / bezel;
        const mag = 1 - Math.sqrt(1 - t * t);
        let nx, ny;
        if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; nx = Math.sign(px) * qx / l; ny = Math.sign(py) * qy / l; }
        else if (qx > qy) { nx = Math.sign(px); ny = 0; }
        else { nx = 0; ny = Math.sign(py); }
        dx = -nx * mag; dy = -ny * mag;   // 往里取样：边缘把里面的东西「拉」出来
      }
      const i = (y * W + x) * 4;
      img.data[i] = Math.round(128 + dx * 127);
      img.data[i + 1] = Math.round(128 + dy * 127);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (!glassDefs) {
    glassDefs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glassDefs.setAttribute("width", "0"); glassDefs.setAttribute("height", "0");
    glassDefs.setAttribute("aria-hidden", "true");
    glassDefs.style.position = "absolute";
    document.body.appendChild(glassDefs);
  }
  const id = "hg" + glassCache.size;
  const NS = "http://www.w3.org/2000/svg";
  const f = document.createElementNS(NS, "filter");
  f.setAttribute("id", id);
  f.setAttribute("x", "0"); f.setAttribute("y", "0"); f.setAttribute("width", w); f.setAttribute("height", h);
  f.setAttribute("filterUnits", "userSpaceOnUse");
  f.setAttribute("color-interpolation-filters", "sRGB");
  const im = document.createElementNS(NS, "feImage");
  im.setAttribute("href", c.toDataURL());
  im.setAttribute("x", "0"); im.setAttribute("y", "0"); im.setAttribute("width", w); im.setAttribute("height", h);
  im.setAttribute("preserveAspectRatio", "none");
  im.setAttribute("result", "map");
  const dm = document.createElementNS(NS, "feDisplacementMap");
  dm.setAttribute("in", "SourceGraphic"); dm.setAttribute("in2", "map");
  dm.setAttribute("scale", scale);
  dm.setAttribute("xChannelSelector", "R"); dm.setAttribute("yChannelSelector", "G");
  f.append(im, dm);
  glassDefs.appendChild(f);
  glassCache.set(key, id);
  return id;
}
// ============== 悬停（2026-10-19，v2.2，按 Apple 指针交互的两种效果） ==============
// · 格子（热力格、矩阵、透视表、忙闲柱）= Lift：格子自己在原地略放大、浮起一层影子和白色高光边、字加粗；
//   离开的那格同时落回去，新格子同时抬起来——各管各的，不会有一块东西拖着内容满表跑。
// · 数据表的行、柱线图的列 = Highlight：一块玻璃托板垫在内容「后面」，在相邻的行 / 列之间滑过去；
//   行里的字原地略放大加深（按各列原来的对齐方向放大），列里的柱子照旧变黑。
// 弹簧一律临界阻尼（不回弹，Apple：悬停这种没有甩动的交互不加回弹），响应约 0.3 秒；进出场是缩放 + 淡入一起做。
// 只给鼠标（触屏没有悬停）；减少动态效果时直接到位，减少透明度时托板退回实色（CSS）。
const HOVER_CELL_SEL = ".heat-row > i, .busy-bars > i, .hm .cell, .heat-table tbody td:not(:first-child):not(.total)";
const HOVER_COL_SEL = ".dc-col, .pair-col, .rb-col, .col";
// 普通数据表（周报 / 客服评估 / 明细等）：整行（2026-10-19 用户定：要整条数据，不是单个格子）
function dataRow(target) {
  const tr = target.closest && target.closest("tbody tr");
  if (!tr) return null;
  const table = tr.closest("table");
  if (!table || table.classList.contains("heat-table") || !tr.cells.length) return null;
  return tr;
}
function initHoverGlass() {
  if (typeof matchMedia === "function" && !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  document.documentElement.classList.add("hover-glass");
  let cur = null, marks = [], plate = null;
  const unmark = () => { marks.forEach((m) => m.classList.remove("lifted", "row-lift", "xh")); marks = []; };
  // 十字定位：抬起的格子所在行的行名、所在列的列头一起加深加粗
  const crosshair = (el) => {
    const row = el.parentElement;
    if (!row) return;
    const k = Array.prototype.indexOf.call(row.children, el);
    const rowHead = row.firstElementChild;
    if (rowHead && rowHead !== el) marks.push(rowHead);
    let head = null;
    const table = el.closest("table");
    if (table) {
      const rows = table.tHead ? Array.from(table.tHead.rows) : [];
      const hr = rows.reverse().find((r) => r.cells.length === row.children.length);
      head = hr && hr.cells[k];
    } else if (el.closest(".heat-grid")) { const ax = el.closest(".heat-grid").querySelector(".heat-axis"); head = ax && ax.children[k]; }
    else if (el.closest(".hm")) { const hd = el.closest(".hm").querySelector(".hm-row.head"); head = hd && hd.children[k]; }
    if (head) marks.push(head);
  };
  // 托板：垫在某个容器里、内容后面；换了容器就在新容器里重新长出来
  const plateIn = (host) => {
    if (plate && plate.parentElement === host) return plate;
    if (plate) { const old = plate; old.classList.remove("on"); setTimeout(() => old.remove(), 200); }
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.classList.add("plate-host");
    plate = document.createElement("i");
    plate.className = "hover-plate";
    plate.setAttribute("aria-hidden", "true");
    host.prepend(plate);
    return plate;
  };
  const movePlate = (host, x, y, w, h, br) => {
    const p = plateIn(host);
    const first = !p.classList.contains("on");
    if (first) p.classList.add("jump");
    p.style.width = w + "px"; p.style.height = h + "px"; p.style.borderRadius = br + "px";
    p.style.transform = "translate(" + x + "px," + y + "px)";
    if (first) { void p.offsetWidth; p.classList.remove("jump"); p.classList.add("on"); }
  };
  const dropPlate = () => { if (plate) plate.classList.remove("on"); };
  const hide = () => { cur = null; unmark(); dropPlate(); };
  const place = (el) => {
    unmark();
    // 格子：原地抬起
    if (el.matches(HOVER_CELL_SEL)) {
      dropPlate();
      marks.push(el);
      el.classList.add("lifted");
      crosshair(el);
      marks.forEach((m) => { if (m !== el) m.classList.add("xh"); });
      return;
    }
    // 行：托板垫在表格后面滑过去，行里各格的字按对齐方向原地放大加深
    if (el.tagName === "TR") {
      const table = el.closest("table");
      const host = table.parentElement;
      const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
      Array.from(el.cells).forEach((td) => {
        if (td.$origin) return;
        const al = getComputedStyle(td).textAlign;
        td.$origin = al === "right" || al === "end" ? "right center" : al === "center" ? "center" : "left center";
        td.style.transformOrigin = td.$origin;
        // 格子里有横条（占比条之类）铺满整格时，整格放大会压到隔壁的字：只放大字，横条不动
        if (td.querySelector(".cbar, .track, .stack, .spark")) td.classList.add("lift-text-only");
      });
      marks.push(el);
      el.classList.add("row-lift");
      movePlate(host, r.left - hr.left + host.scrollLeft - 6, r.top - hr.top + host.scrollTop - 2, r.width + 12, r.height + 4, 12);
      return;
    }
    // 柱线图的列：托板垫在柱子后面滑过去
    const host = el.parentElement;
    const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
    movePlate(host, r.left - hr.left + 1, r.top - hr.top, r.width - 2, r.height, 10);
  };
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    const t = e.target.closest && (e.target.closest(HOVER_CELL_SEL) || e.target.closest(HOVER_COL_SEL) || dataRow(e.target));
    if (!t) { if (cur) hide(); return; }
    if (t === cur) return;
    cur = t;
    place(t);
  }, { passive: true });
  window.addEventListener("resize", hide);
  // 图重画后原来的格子没了，跟着收掉
  new MutationObserver(() => { if (cur && !cur.isConnected) hide(); if (plate && !plate.isConnected) plate = null; }).observe(document.body, { childList: true, subtree: true });
}

// 给元素挂上玻璃：玻璃本体是元素里垫在最底下的一层 .glass-g（底色 + backdrop 模糊 + 折射），高光和影子画在元素自己的 ::after 上。
// 分两层是因为 Chromium 里带 box-shadow 的元素，backdrop 折射的坐标原点会挪到影子外沿，折射就错位了。
// 折射只在 Chromium；其他浏览器只有 CSS 里的模糊。tail 是折射之后接着做的模糊 / 提饱和，和 CSS 保持一致。
function glassify(el, opts) {
  if (!el) return;
  let g = el.firstElementChild;
  if (!g || !g.classList.contains("glass-g")) { g = document.createElement("i"); g.className = "glass-g"; g.setAttribute("aria-hidden", "true"); el.prepend(g); }
  if (!GLASS_REFRACT) return;
  const o = opts || {};
  // 尺寸在过渡中时 offsetWidth 还是旧值，调用方知道目标尺寸就直接传进来
  const w = Math.round(o.w || el.offsetWidth), h = Math.round(o.h || el.offsetHeight);
  if (!w || !h) return;
  const sig = w + "x" + h + "x" + (o.scale || 20);
  if (g.$glass === sig) return;
  g.$glass = sig;
  const id = glassFilter(w, h, o.radius || 12, o.bezel || 10, o.scale || 20);
  g.style.backdropFilter = "url(#" + id + ") " + (o.tail || "");
}
// （以上为液态玻璃）   // 回弹 0.5%：数据变化时的形变
const EASE_OUT = (t) => 1 - Math.pow(1 - t, 3);
// 通用补间：每帧回调 f(进度 0..1)，返回取消函数；同一个对象上新补间会取消旧的
function tween(owner, key, ms, ease, f) {
  if (owner[key]) owner[key]();
  if (REDUCED_MOTION) { f(1); return; }
  let raf = 0, alive = true;
  const t0 = performance.now();
  const step = (now) => {
    if (!alive) return;
    const t = Math.min(1, (now - t0) / ms);
    f(ease(t));
    if (t < 1) raf = requestAnimationFrame(step); else owner[key] = null;
  };
  raf = requestAnimationFrame(step);
  owner[key] = () => { alive = false; cancelAnimationFrame(raf); };
}

// 数字滚动：el 的文本从上一次的值滚到 text（千分位、小数位跟随 text）；不是纯数字就直接换
function rollTo(el, text) {
  if (!el) return;
  const str = String(text);
  const m = str.match(/^(-?)([\d,]+)(\.\d+)?$/);
  if (!m || REDUCED_MOTION) { el.textContent = str; el.$val = m ? Number(str.replace(/,/g, "")) : null; return; }
  const to = Number(str.replace(/,/g, ""));
  const dec = m[3] ? m[3].length - 1 : 0;
  const comma = m[2].includes(",") || to >= 1000;
  const from = typeof el.$val === "number" ? el.$val : 0;
  el.$val = to;
  if (from === to) { el.textContent = str; return; }
  const fmt = (v) => { const fixed = v.toFixed(dec); if (!comma) return fixed; const [i, d] = fixed.split("."); return Number(i).toLocaleString("en-US") + (d ? "." + d : ""); };
  tween(el, "$roll", 620, EASE_OUT, (k) => { el.textContent = k >= 1 ? str : fmt(from + (to - from) * k); });
}
// 容器里所有 .card-value（或 sel 指定的元素）的第一个文本节点做数字滚动（innerHTML 刚换过，上一次的值存在容器上按序号对齐）
function rollCards(box, sel) {
  if (!box) return;
  const prev = box.$vals || [];
  const next = [];
  box.querySelectorAll(sel || ".card-value").forEach((v, i) => {
    const node = v.firstChild;
    if (!node || node.nodeType !== 3) { next.push(null); return; }
    const span = document.createElement("span");
    span.$val = prev[i];
    v.replaceChild(span, node);
    rollTo(span, node.textContent);
    next.push(span.$val);
  });
  box.$vals = next;
}

// 刚渲染出来的 DOM 小图（迷你柱、排名条、热力格……）按位置错开起跳：同一个父元素下的同类元素各自排队，总时长封顶 360ms
const STAGGER_SEL = ".spark i, .col .bar, .col .seg-stack, .loop-types > .loop-type, .rb-col i, .busy-bars > i, .units i, .pair-col i, .pair-one i, .track > i, .tr i, .cbar i b, .heat-row > i, .heat-table td, .hm-row > *, .goal-track .fill i";
function staggerIn(root) {
  if (!root || REDUCED_MOTION) return;
  const groups = new Map();
  root.querySelectorAll(STAGGER_SEL).forEach((el) => {
    const p = el.parentElement;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(el);
  });
  for (const list of groups.values()) {
    const step = Math.min(22, 360 / Math.max(1, list.length));
    list.forEach((el, i) => { el.style.animationDelay = Math.round(i * step) + "ms"; });
  }
}

// 报告页（周报 / 业务闭环）的入场：区块按顺序错开上浮淡入，表格逐行淡入，里面的条形照常错开长出。
// 每次进入页面、切换统计周都会重放；数据还没到时面板挂 .pending（区块半透明呼吸），到了再统一入场，不再「先空白后突然蹦出来」
const REVEAL_SEL = ":scope > .toc, :scope > .report-block, :scope > .grid > *, :scope > .chart-card, :scope > .group-head";
function revealIn(root) {
  if (!root) return;
  root.classList.remove("pending");
  if (REDUCED_MOTION) return;
  const blocks = [...root.querySelectorAll(REVEAL_SEL)].filter((el) => !el.hidden);
  const rows = [];
  root.querySelectorAll("tbody").forEach((tb) => {
    const list = [...tb.rows];
    const step = Math.min(18, 300 / Math.max(1, list.length));
    list.forEach((r, i) => rows.push([r, Math.round(160 + i * step)]));
  });
  // 先统一清掉旧动画、只触发一次重排，再统一挂上，保证每次都能重放
  blocks.forEach((el) => { el.style.animation = "none"; });
  rows.forEach(([r]) => { r.style.animation = "none"; });
  void root.offsetHeight;
  blocks.forEach((el, i) => { el.style.animation = "dcRise 460ms var(--spring-snap) " + Math.min(i * 50, 360) + "ms both"; });
  rows.forEach(([r, d]) => { r.style.animation = "dcFadeOnly 300ms ease-out " + d + "ms both"; });
  staggerIn(root);
}
// 切换统计周：旧内容 120ms 淡出，换完再入场
function swapIn(root, render) {
  if (!root || REDUCED_MOTION) { render(); revealIn(root); return; }
  root.classList.add("swapping");
  setTimeout(() => { render(); root.classList.remove("swapping"); revealIn(root); }, 120);
}

// 1 / 2 / 2.5 / 5 / 10 × 10^n 的整刻度上限
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// 柱宽（2026-10-13 定）：不定死像素，一根 = 格宽 × 55%（并列双柱各 26%），再按粒度封顶；根数少自然粗、根数多自然细
const BAR_MAX = { day: 48, week: 48, month: 56, quarter: 64, year: 80 };
function barW(grain) { return { wPct: 55, wMax: BAR_MAX[grain] || 48 }; }
function pairW(grain) { return { wPct: 26, wMax: Math.round((BAR_MAX[grain] || 48) / 2) }; }
// 柱线双泳道（2026-10-13 用户定，总览「会话接待分布」）：柱子只占绘图区下面 58%，折线只在上面 32%（68%–100%），中间留 10% 空隙，永不交叉
const LANE_BAR = 58, LANE_LINE_FROM = 68, LANE_LINE = 32;
const BAR_DARK = "#4A494F";   // 泳道图柱色（深灰），悬停变墨色

/**
 * cfg:
 *   height      绘图区高度（px）
 *   bars        [{ segs: [{ v, color }], w, label, labelClass, bg(单段时), minH }]  每根柱；v 为同一量纲
 *   max         柱的量纲上限（默认取 niceMax(最大合计 × 1.1)）
 *   line        { values: [number|null], color, width, max }   右轴折线（可选）
 *   yTicks      [{ pos(0-100), label }]  左轴刻度 + 虚线（可选）
 *   hTicks      [{ pos, label }]           右轴刻度（可选）
 *   xLabels     [{ left(0-100), label }] 绝对定位的横轴标签；或 xPerBar: [string] 每柱一个
 *   band        { from, to, label }  当前周期：这几根柱背后铺一块浅底、左上角写「本周」
 *   lanes       true = 双泳道：柱子压到下面 LANE_BAR%，折线抬到上面 LANE_LINE_FROM% 起；yTicks / hTicks 的 pos 由调用方按泳道给
 *   line.dots   true = 折线每个点画一个圆点（白描边）
 *   hoverInk    true = 悬停列的柱子变墨色
 *   keys        [string] 每根柱的身份（通常是桶 key）。和上一次完全相同时走「形变」：柱高、折线、圆点从旧值弹到新值；
 *               否则（第一次画、换粒度、换区间）走「长出」：柱子从底部错开长出、折线从左往右画、圆点依次弹出
 *   tip(i)      → { title, rows, foot, notes }
 */
function domChart(el, cfg) {
  if (!el) return;
  const bars = cfg.bars || [];
  const n = bars.length;
  const H = cfg.height || 250;
  const totals = bars.map((b) => (b.segs || []).reduce((a, s) => a + (Number(s.v) || 0), 0));
  const max = cfg.max || niceMax(Math.max(...totals, 0) * 1.1);
  const line = cfg.line;
  const lineMax = line ? (line.max || niceMax(Math.max(...line.values.map((v) => Number(v) || 0), 0) * 1.15)) : 1;

  const yTicks = cfg.yTicks || [];
  const hTicks = cfg.hTicks || [];
  const laneBar = cfg.lanes ? LANE_BAR : 100, laneFrom = cfg.lanes ? LANE_LINE_FROM : 0, laneLine = cfg.lanes ? LANE_LINE : 100;
  const keys = cfg.keys || null;
  const prev = el.$dc || null;
  // instant：条带拖动 / 滑动时逐帧重画，既不长出也不形变（柱子跟着窗口走，上限由调用方逐帧缓动）
  const instant = !!cfg.instant;
  if (instant && el.$lineTween) { el.$lineTween(); el.$lineTween = null; }
  const morph = !instant && !REDUCED_MOTION && !!(keys && prev && prev.keys && prev.keys.length === keys.length && prev.keys.every((k, i) => k === keys[i]));
  const grow = !instant && !cfg.noGrow && !REDUCED_MOTION && !morph;
  // slide：内容比绘图区宽（R 倍）、整体左移 S（占内容宽的比例）——条带拖动时按小数天平移，不必每帧重画
  const slide = cfg.slide || null;
  const slideStyle = slide ? ' style="width:' + (slide.R * 100).toFixed(4) + "%;transform:translateX(" + (-slide.S * 100).toFixed(4) + '%)"' : "";
  const stagger = Math.min(22, 360 / Math.max(1, n));
  const heights = [];
  const cols = bars.map((b, i) => {
    const segs = (b.segs || []).filter((s) => Number(s.v) > 0);
    const h = Math.max(b.minH || 0, (totals[i] / max) * laneBar);
    heights.push(Math.max(b.dashed ? 4 : 0, h));
    // 形变：先按旧高度画出来，插入后再改成新高度，靠 CSS transition 弹过去；长出：CSS animation 从 0 长到自身高度
    const shownH = morph ? prev.heights[i] : heights[i];
    const motion = grow ? "animation-delay:" + Math.round(i * stagger) + "ms;" : "";
    const wStyle = b.wPct ? "width:" + b.wPct + "%;min-width:4px;max-width:" + (b.wMax || 48) + "px;" : "width:" + (b.w || 12) + "px;";
    const inner = segs.length > 1
      ? segs.slice().reverse().map((s) => '<i style="flex:' + Number(s.v) + " 1 0;background:" + s.color + '"></i>').join("")
      : "";
    const bg = segs.length === 1 ? segs[0].color : (b.bg || "transparent");
    return '<div class="dc-col" data-tip="' + i + '">' +
      (b.label !== undefined && b.label !== "" ? '<span class="dc-label' + (b.labelClass ? " " + b.labelClass : "") + '"' + (grow ? ' style="animation-delay:' + Math.round(200 + i * stagger) + 'ms"' : "") + ">" + escHtml(b.label) + "</span>" : "") +
      '<div class="dc-bar' + (inner ? " stacked" : "") + (b.dashed ? " dashed" : "") + '" style="' + wStyle + motion + "height:" + shownH.toFixed(2) + "%;" + (inner || b.dashed ? "" : "background:" + bg) + '">' + (b.dashed ? "" : inner) + "</div></div>";
  }).join("");

  let path = "", dots = "", pts = [], dotY = [];
  if (line && n) {
    const yOf = (v) => laneFrom + (Number(v) / lineMax) * laneLine;   // 0–100，自底向上
    line.values.forEach((v, i) => { if (v !== null && v !== undefined && isFinite(v)) pts.push([((i + 0.5) / n) * 1000, H - (yOf(v) / 100) * H]); });
    dotY = line.values.map((v) => (v !== null && v !== undefined && isFinite(v) ? yOf(v) : null));
    // 形变且点数没变：先画旧折线，插入后逐帧补间到新折线
    const lineMorph = morph && prev.pts && prev.pts.length === pts.length && prev.H === H;
    path = smoothPath(lineMorph ? prev.pts : pts);
    if (line.dots) dots = '<div class="dc-dots">' + dotY.map((y, i) => {
      if (y === null) return "<b></b>";
      const shown = morph && prev.dotY && prev.dotY[i] !== null && prev.dotY[i] !== undefined ? prev.dotY[i] : y;
      return '<b><i style="bottom:' + shown.toFixed(2) + "%;background:" + (line.color || INK) + (grow ? ";animation-delay:" + Math.round(140 + (620 * (i + 0.5)) / n) + "ms" : "") + '"></i></b>';
    }).join("") + "</div>";
  }

  const xAbs = cfg.xLabels ? '<div class="dc-x abs">' + cfg.xLabels.map((x) => '<span style="left:' + x.left + '%">' + escHtml(x.label) + "</span>").join("") + "</div>" : "";
  const xPer = cfg.xPerBar ? '<div class="dc-x per">' + cfg.xPerBar.map((x) => "<span" + (x === "今天" ? ' class="today"' : "") + ">" + escHtml(x) + "</span>").join("") + "</div>" : "";

  el.innerHTML =
    '<div class="dc' + (cfg.hoverInk ? " hover-ink" : "") + (grow ? " grow" : "") + (instant ? " instant" : "") + '">' +
    (yTicks.length ? '<div class="dc-y" style="height:' + H + 'px">' + yTicks.map((t) => '<span style="bottom:' + t.pos + '%">' + escHtml(t.label) + "</span>").join("") + "</div>" : "") +
    '<div class="dc-body"><div class="dc-plot" style="height:' + H + 'px">' +
    yTicks.map((t) => '<b class="dc-grid" style="bottom:' + t.pos + '%"></b>').join("") +
    (cfg.lanes ? hTicks.map((t) => '<b class="dc-grid light" style="bottom:' + t.pos + '%"></b>').join("") : "") +
    (cfg.capLine ? '<b class="dc-cap" style="bottom:' + cfg.capLine.pos + '%"></b>' + (cfg.capLine.label ? '<span class="dc-cap-label" style="bottom:' + cfg.capLine.pos + '%">' + escHtml(cfg.capLine.label) + "</span>" : "") : "") +
    (slide ? '<div class="dc-slide"' + slideStyle + ">" : "") +
    (cfg.band && n && cfg.band.to >= cfg.band.from ? '<div class="dc-band" style="left:' + ((cfg.band.from / n) * 100).toFixed(2) + "%;width:" + (((cfg.band.to - cfg.band.from + 1) / n) * 100).toFixed(2) + '%"><span>' + escHtml(cfg.band.label || "") + "</span></div>" : "") +
    '<div class="dc-cols">' + cols + "</div>" +
    (path ? '<svg class="dc-line" viewBox="0 0 1000 ' + H + '" preserveAspectRatio="none"><path d="' + path + '" fill="none" stroke="' + (line.color || INK) + '" stroke-width="' + (line.width || 2) + '" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path></svg>' : "") +
    dots +
    (slide ? "</div>" : "") +
    "</div>" + (slide ? '<div class="dc-xclip"><div class="dc-xslide"' + slideStyle + ">" + xAbs + xPer + "</div></div>" : xAbs + xPer) + "</div>" +
    (hTicks.length ? '<div class="dc-h" style="height:' + H + 'px">' + hTicks.map((t) => '<span style="bottom:' + t.pos + '%">' + escHtml(t.label) + "</span>").join("") + "</div>" : "") +
    "</div>";

  // 形变：插入后的下一帧把柱高、圆点改成新值（CSS transition 弹过去），折线逐帧补间
  if (morph) {
    const barEls = el.querySelectorAll(".dc-bar");
    const dotEls = el.querySelectorAll(".dc-dots i");
    void el.offsetHeight;   // 先让旧高度生效，transition 才有起点
    barEls.forEach((b, i) => { b.style.height = heights[i].toFixed(2) + "%"; });
    let di = 0;
    dotY.forEach((y) => { if (y === null) return; const d = dotEls[di++]; if (d) d.style.bottom = y.toFixed(2) + "%"; });
    const p = el.querySelector(".dc-line path");
    if (p && prev.pts && prev.pts.length === pts.length && prev.H === H) {
      const from = prev.pts;
      tween(el, "$lineTween", 520, SPRING_SNAP, (k) => {
        p.setAttribute("d", smoothPath(pts.map((q, i) => [q[0], from[i][1] + (q[1] - from[i][1]) * k])));
      });
    }
  }
  el.$dc = { keys, heights, pts, dotY, H };

  // 逐柱横轴标签太密（窄屏 / 柱多）时隔几根标一个，从最后一根往前数，保证最新的那根有标签
  if (cfg.xPerBar && n) {
    const axis = el.querySelector(".dc-x.per");
    const width = axis ? axis.clientWidth : 0;
    const step = width ? Math.ceil((n * 46) / width) : 1;
    // 有 xIndexBase 时按整条序列的下标对齐（从序列最后一天往前数），窗口平移时标签不会跳来跳去
    const pos = (i) => (cfg.xIndexBase !== undefined ? cfg.xIndexEnd - (cfg.xIndexBase + i) : n - 1 - i);
    if (step > 1) axis.querySelectorAll("span").forEach((sp, i) => { if (pos(i) % step && !sp.classList.contains("today")) sp.textContent = ""; });
  }
  if (cfg.tip) {
    el.$tip = cfg.tip;
    if (!el.dataset.bound) {
      el.dataset.bound = "1";
      bindDomTip(el, (i) => (el.$tip ? el.$tip(i) : null));
    }
  }
}

// 粒度页签（原型：下划线式，日 / 周 / 月 / 季 / 年）
const GRAIN_LIST = [["day", "日"], ["week", "周"], ["month", "月"], ["quarter", "季"], ["year", "年"]];

// 横轴标签：按天只标每月 1 号（和首根），按周隔一根标 W41，月 / 季 / 年逐根标
function xLabelsFor(buckets, grain) {
  const n = buckets.length;
  const out = [];
  if (!n) return out;
  if (grain === "day") {
    buckets.forEach((b, i) => { if (b.first.slice(8) === "01" || i === 0) out.push({ left: (((i + 0.5) / n) * 100).toFixed(2), label: Number(b.first.slice(5, 7)) + " 月" }); });
    return out;
  }
  const step = grain === "week" && n > 12 ? 2 : 1;
  buckets.forEach((b, i) => {
    if ((n - 1 - i) % step) return;
    const k = b.key;
    const label = grain === "week" ? "W" + Number(k.slice(5)) : grain === "month" ? Number(k.slice(5, 7)) + " 月" : grain === "quarter" ? k.slice(5) : k;
    out.push({ left: (((i + 0.5) / n) * 100).toFixed(2), label });
  });
  return out;
}

// 当前周期（2026-10-13 用户定，参考订单看板）：按天 = 最近 7 天铺一块浅底、写「近 7 天」；其他粒度 = 最后一个桶，写 本周 / 本月 / 本季 / 本年。
// 返回 { from, to, label }
function currentBand(buckets, grain) {
  const n = buckets.length;
  if (!n) return null;
  const LABEL = { week: "本周", month: "本月", quarter: "本季", year: "本年" };
  if (grain !== "day") return { from: n - 1, to: n - 1, label: LABEL[grain] || "" };
  return { from: Math.max(0, n - 7), to: n - 1, label: "近 7 天" };
}
const inBand = (band, i) => !!band && i >= band.from && i <= band.to;
// 还没过完的桶（含今天）画成虚线空心柱，横轴写「今天」；数据还会往上走，别和前面的实心柱比
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
const isOngoing = (b) => !!b && b.last === todayKey();

// 按天且不超过 31 天时横轴逐天写 MM-DD（太密时 domChart 自己隔几天标一个），今天写「今天」；其余粒度用 xLabelsFor
function axisFor(buckets, grain) {
  if (grain === "day" && buckets.length <= 31) return { xPerBar: buckets.map((b) => (isOngoing(b) ? "今天" : b.first.slice(5))) };
  return { xLabels: xLabelsFor(buckets, grain) };
}

const WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// 悬停卡标题：2026-10-05 周一 / W41 · 10-05 – 10-11（不完整）/ 2026 年 10 月 / 2026 Q4 / 2026 年
function bucketTitle(b, grain) {
  const md = (d) => d.slice(5);
  if (grain === "day") return b.first + " " + WD_CN[new Date(b.first + "T00:00:00Z").getUTCDay()];
  if (grain === "week") return "W" + Number(b.key.slice(5)) + " · " + md(b.first) + " – " + md(b.last) + (b.days < 7 ? "（不完整）" : "");
  if (grain === "month") return b.key.slice(0, 4) + " 年 " + Number(b.key.slice(5, 7)) + " 月";
  if (grain === "quarter") return b.key.replace("-Q", " Q");
  return b.key + " 年";
}

// 把 meta 里的状态、已跑多久、失败原因拼成一句人话。
function buildingText(meta) {
  const m = meta || {};
  if (m.status === "error") {
    return "上一次拉取数据失败：" + (m.error || "原因未知") + "。点右上角「重新拉取数据」重试。";
  }
  if (m.status === "running") {
    const 秒 = m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : 0;
    return 秒 > 120
      ? "上一次拉取已卡住 " + 秒 + " 秒，点「重新拉取数据」重新发起。"
      : progressText(m) + "，完成后自动显示。";
  }
  return "数据还没拉过，点右上角「重新拉取数据」。";
}

// 刷新进度（meta.phase / done / total 由后台每 0.7 秒左右写一次）
function progressText(m) {
  if (m.phase === "full" && m.total) {
    return "正在全量拉取：已拉 " + fmtNum(m.done || 0) + " / " + fmtNum(m.total) + " 条（" + Math.min(100, Math.round(((m.done || 0) / m.total) * 100)) + "%）";
  }
  if (m.phase === "list" && m.total) {
    return "正在核对全表序号（只拉编号）：" + fmtNum(m.done || 0) + " / " + fmtNum(m.total) + "（" + Math.min(100, Math.round(((m.done || 0) / m.total) * 100)) + "%）";
  }
  if (m.phase === "check") return "条数和金数据对不上，正在核对最近两周删掉的行";
  if (m.phase === "write") return "已拉完 " + fmtNum(m.total || 0) + " 条，正在重算图表";
  if (m.phase === "incr") return "正在拉取金数据上的新增和改动";
  return "正在准备拉取";
}
function progressPct(m) {
  if ((m.phase === "full" || m.phase === "list") && m.total) return Math.min(99, Math.round(((m.done || 0) / m.total) * 100)) + "%";
  if (m.phase === "write") return "99%";
  return "";
}

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
      if (meta.status === "running") banner(buildingText(meta), "info");   // 显示后台进度
    } catch (e) { /* 忽略单次轮询失败 */ }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

// ============== 筛选 ==============

function currentQuery() {
  const p = new URLSearchParams();
  const range = $("fRange").value;
  if (range && range !== "custom") {
    // 「近 N 天」交给服务端按数据里最新日期换算，前端不必先知道最新日期
    p.set("range", range);
  } else if (range === "custom") {
    const from = $("fFrom").value;
    const to = $("fTo").value;
    if (from) p.set("from", from);
    if (to) p.set("to", to);
  }
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    if ($(id).value) p.set(cfg.dim, $(id).value);
  }
  return p;
}

// 选项来自全量口径（facets），筛选后不跟着缩水
function fillFacets(facets) {
  if (state.facets || !facets) return;
  state.facets = true;
  for (const [id, cfg] of Object.entries(DIM_SELECTS)) {
    const el = $(id);
    const current = el.value;
    const options = [new Option(cfg.placeholder, "")];
    for (const [value, count] of sortedPairs(facets[cfg.dim])) {
      options.push(new Option(value + "（" + count + "）", value));
    }
    el.replaceChildren(...options);
    el.value = current;
  }
}

// 高亮生效中的筛选项
function markActive() {
  const ids = ["fRange", "fFrom", "fTo", ...Object.keys(DIM_SELECTS)];
  ids.forEach((id) => {
    const el = $(id);
    el.classList.toggle("active", !!el.value);
  });
  // 手机上筛选栏默认收起，只露一行摘要：时间范围 + 还有几项维度筛选
  const summary = $("filterSummary");
  if (summary) {
    const range = $("fRange");
    const rangeText = range.value === "custom"
      ? (($("fFrom").value || "…") + " ~ " + ($("fTo").value || "…"))
      : (range.options[range.selectedIndex] || {}).text || "全部时间";
    const dims = Object.keys(DIM_SELECTS).filter((id) => $(id).value).length;
    summary.textContent = rangeText + (dims ? " · " + dims + " 项筛选" : "");
  }
}

// 手机：侧边栏折成顶部一条（logo + 汉堡），菜单从右侧抽屉滑出；点导航、遮罩、×、Esc 都收回
function initMenu() {
  const btn = $("menuBtn"), close = $("menuClose"), backdrop = $("menuBackdrop");
  if (!btn) return;
  const set = (open) => {
    document.body.classList.toggle("menu-open", open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => set(!document.body.classList.contains("menu-open")));
  if (close) close.addEventListener("click", () => set(false));
  if (backdrop) backdrop.addEventListener("click", () => set(false));
  document.querySelectorAll(".nav-item").forEach((t) => t.addEventListener("click", () => set(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  const ft = $("filterToggle");
  if (ft) ft.addEventListener("click", () => {
    const open = !$("filterbar").classList.contains("open");
    $("filterbar").classList.toggle("open", open);
    ft.setAttribute("aria-expanded", String(open));
  });
}

function applyRangePreset() {
  const v = $("fRange").value;
  const from = $("fFrom");
  const to = $("fTo");
  if (v === "custom") {
    from.disabled = to.disabled = false;
  } else {
    // 预设区间由服务端换算，日期框只做回显
    from.disabled = to.disabled = true;
    if (v === "") { from.value = ""; to.value = ""; }
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
    // 固定口径的「最近 24 周」只拉一次（接待量页三张图 + 总览接待人数图用，不随筛选）；拉不到就退回筛选后的 stats
    const [json, fixed] = await Promise.all([
      api("/api/dashboard" + (qs ? "?" + qs : "")),
      state.fixed ? null : api("/api/fixed").catch(() => null),
    ]);
    if (fixed && fixed.success && fixed.stats) state.fixed = fixed.stats;
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      banner(buildingText(json.meta), (json.meta || {}).status === "error" ? "warn" : "info");
      pollUntilReady();
      return;
    }
    state.stats = json.stats;
    state.previous = json.previous || null;
    state.resolvedFrom = json.resolvedFrom || "";
    state.resolvedTo = json.resolvedTo || "";
    state.series = json.series || null;   // 条带的全序列（全部时间走预聚合时没有，前端用 stats.byDay）
    fillFacets(json.facets);
    if (json.latestDay) state.latestDay = json.latestDay;
    // 预设区间回显服务端换算出的起止日期
    if ($("fRange").value && $("fRange").value !== "custom") {
      $("fFrom").value = json.resolvedFrom || "";
      $("fTo").value = json.resolvedTo || "";
    }
    // 上一等长周期由 /api/dashboard 同一次响应带回（json.previous），不再单独发第二次请求。
    renderCards(json.stats, json.previous);
    renderCharts(json.stats);
    markActive();
    $("matchInfo").innerHTML = json.filtered
      ? "筛选后 <b>" + fmtNum(json.matched) + "</b> / " + fmtNum(json.fullTotal) + " 条会话"
      : "全部 <b>" + fmtNum(json.fullTotal || json.stats.total) + "</b> 条会话";
    // 「数据更新于」写的是页面上这份数据真正落地的时间：刷新失败 / 进行中时用 lastOk，
    // 不能用失败那次的时间——2026-10-20 明细写入失败了一天多，页面却照常显示刚刚更新过。
    const m = json.meta || {};
    const ok = m.status === "ok" ? m : (m.lastOk || {});
    const pad2 = (n) => String(n).padStart(2, "0");
    const hm = (iso) => { const t = new Date(iso); return pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()) + " " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()); };
    // 增量同步后 updatedAt 只在明细真有变化时才变；「数据更新于」显示最近一次同步完成的 checkedAt
    const synced = ok.checkedAt || ok.updatedAt;
    if (synced) {
      $("updatedAt").innerHTML = "<span>数据更新于 " + hm(synced) + "</span><span>共 " + fmtNum(ok.total) + " 条会话</span>";
    }
    if (m.status === "error") {
      banner("最近一次拉取数据失败（" + (m.failedAt ? hm(m.failedAt) : "时间未知") + "）：" + (m.error || "原因未知") +
        "。页面上的数据停在 " + (synced ? hm(synced) : "上一次成功拉取") + "，可点「重新拉取数据」重试。", "warn");
    } else {
      banner(
        json.stats.total === 0 ? "当前筛选条件下没有会话，放宽条件或点「重置筛选」。" : "",
        "info"
      );
    }
  } catch (err) {
    banner("看板数据加载失败：" + err.message);
  }
}

// 缓存最近一次渲染用的 stats：切聚合粒度只是换个分桶方式，
// 没必要重新打接口（顶部筛选变化时才 reload）。
let LAST_STATS = null;

// 渲染按页签拆开：隐藏面板里的 canvas 量不出尺寸，所以只画当前页，切页时再画。
const PANEL_RENDER = {
  overview: (s) => renderOverview(s),
  volume: (s) => renderVolume(s),
  ai: (s) => renderAIPanel(s),
  service: (s) => renderService(s),
  business: (s) => renderBusiness(s),
};

function renderCharts(s) {
  LAST_STATS = s;
  const fn = PANEL_RENDER[state.tab];
  if (fn) fn(s);
  staggerIn(document.querySelector(".panel.active"));
}

// 涨跌文字：计数看相对变化（%），比率看差值（pp）
function changeText(cur, prev, kind) {
  if (prev === null || prev === undefined || !isFinite(prev) || !isFinite(cur)) return "";
  if (kind === "pp") {
    const d = cur - prev;
    return Math.abs(d) < 0.05 ? "持平" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "pp";
  }
  if (!prev) return "";
  const d = ((cur - prev) / prev) * 100;
  return Math.abs(d) < 0.05 ? "持平" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "%";
}

function pillHtml(text) {
  return text ? '<span class="dl ' + deltaClass(text) + '">' + escHtml(text) + "</span>" : "";
}

const escAttr = escHtml;

// 一根分段胶囊条 + 图例行。items: [{ label, value, color }]
function stackHtml(items, opts) {
  const o = opts || {};
  const sum = items.reduce((a, x) => a + x.value, 0);
  const segs = items.filter((x) => x.value > 0).map((x) =>
    '<i style="flex:' + x.value + " 1 0;background:" + x.color + '" title="' + escAttr(x.label + "：" + x.value) + '"></i>'
  ).join("");
  const rows = o.noLegend ? "" : '<div class="legend-rows">' + items.map((x) =>
    '<div class="legend-row"><span class="sw" style="background:' + x.color + '"></span><span>' + escHtml(x.label) + "</span>" +
    "<b>" + fmtNum(x.value) + "</b><small>" + pct(x.value, sum) + "%</small></div>"
  ).join("") + "</div>";
  return '<div class="stack" style="height:' + (o.height || 14) + 'px">' + segs + "</div>" + rows;
}

// 单个决策指标 + 分段条：AI 表现 / 人工服务页的三张小卡共用
function decisionCard(id, label, value, total, items, caption) {
  const el = $(id);
  if (!el) return;
  el.innerHTML =
    '<div class="big-kpi"><b>' + pct(value, total) + "<small>%</small></b><span>" + escHtml(label) + "</span></div>" +
    '<div style="height:16px"></div>' + stackHtml(items) +
    (caption ? '<p class="chart-foot">' + caption + "</p>" : "");
}

// 桶里出现过的分类，按全量占比排序，保证堆叠顺序稳定
function bucketKeys(buckets, field, order) {
  const totals = {};
  for (const b of buckets) {
    for (const [k, v] of Object.entries(b[field] || {})) totals[k] = (totals[k] || 0) + v;
  }
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!order) return keys;
  return keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

function sortedKeys(obj, asc) {
  return Object.keys(obj || {}).filter((k) => /^\d{4}(-\d{2}-\d{2}|W\d{2})$/.test(k))
    .sort((a, b) => (asc === false ? b.localeCompare(a) : a.localeCompare(b)));
}

function setTotal(id, label, value) {
  const el = $(id);
  if (el) el.innerHTML = label + "<b>" + fmtNum(value) + "</b>";
}

// ISO 周键。必须和服务端 isoWeek()（src/index.js）算法一致，否则「按周」
// 会和「会话接待分布（按周）」那张图对不上。
function isoWeekOf(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  if (isNaN(d)) return "";
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return t.getUTCFullYear() + "W" + String(1 + Math.round((t - ft) / 604800000)).padStart(2, "0");
}

// "2026-08-04" → 该粒度下的周期键
function periodKeyOf(day, grain) {
  switch (grain) {
    case "week":    return isoWeekOf(day);
    case "month":   return day.slice(0, 7);
    case "quarter": return day.slice(0, 4) + "-Q" + (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1);
    case "year":    return day.slice(0, 4);
    default:        return day;
  }
}

// multiYear：范围跨了多个年份时，周标签要带上年份，否则 2025W22 和 2026W22
// 都会显示成「第 22 周」，两根柱子看不出区别。月/季/年本身已含年份。
function periodLabel(key, grain, multiYear) {
  switch (grain) {
    case "week":    return (multiYear ? key.slice(2, 4) + " 年" : "") + "第 " + Number(key.slice(5)) + " 周";
    case "quarter": return key.replace("-Q", " Q");
    case "month":
    case "year":    return key;
    default:        return key;   // 按天保持 2026-08-04 原样，和改动前一致
  }
}

// 与全员中位线的差：慢＝黑，快＝绿。这里比的是「人和基准」不是「本期和上期」，
// 所以文字直接写快/慢，不用 ▲▼，免得被读成环比。
function deltaPill(v, unit) {
  if (v === null || v === undefined) return "";
  const suffix = unit ? " " + unit : "";
  if (Math.abs(v) < 0.05) return '<span class="dl flat">持平</span>';
  return '<span class="dl ' + (v > 0 ? "down" : "up") + '">' + (v > 0 ? "慢 " : "快 ") + Math.abs(v).toFixed(1) + suffix + "</span>";
}

// 场景 × 客服 · 单次接待时长中位数：行=场景、列=客服（都不截断），每格两行「6.5分 / 20次」+ 与该行全员中位线差的胶囊
function renderAgentScene(id, hintId, noteId, data, hint) {
  const tbl = $(id);
  if (!tbl) return;
  if (hintId && $(hintId)) $(hintId).textContent = hint;
  if (data && !data.rows) {   // 旧形状缓存（转置前的 {cols, baseline, agents}），提示刷新而不是谎报"没有数据"
    tbl.innerHTML = '<tbody><tr><td>数据缓存是旧版本，点右上角「重新拉取数据」后本表才会出数</td></tr></tbody>';
    return;
  }
  if (!data || !data.rows.length) {
    tbl.innerHTML = '<tbody><tr><td>范围内没有可算单次时长的有效人工接待</td></tr></tbody>';
    if (noteId && $(noteId)) $(noteId).innerHTML = "";
    return;
  }
  const cell = (c) => (c
    ? '<td class="num"><div class="c2"><b>' + c.v + "分 / " + c.n + "次</b>" + deltaPill(c.d, "分") + "</div></td>"
    : '<td class="num"></td>');
  // 全员中位线放最右（2026-09-18 用户定）：左边先看各人，右边一列是这条场景的基准
  tbl.innerHTML =
    "<thead><tr><th>业务场景</th>" +
    data.agents.map((a) => '<th class="num">' + escHtml(a) + "</th>").join("") +
    '<th class="num">全员中位线</th></tr></thead><tbody>' +
    data.rows.map((r) =>
      "<tr><td>" + escHtml(r.scene) + "</td>" + r.cells.map(cell).join("") +
      '<td class="num"><div class="c2"><b>' + (r.base ? r.base.v + "分 / " + r.base.n + "次" : "—") + "</b></div></td>" +
      "</tr>").join("") +
    "</tbody>";
  if (noteId && $(noteId)) $(noteId).innerHTML =
    '<span class="dim-note">只看有效人工，单次时长 = 每场「人工时长 ÷ 接待次数」，格内取中位数；' +
    "括号里是<b>接待次数</b>（人工侧口径统一用接待次数，不用场次）；胶囊 = 该格中位数 − <b>该行全员中位线</b>" +
    "（把该场景全部会话合在一起取的中位数），黑 = 比中位线慢、绿 = 快。" +
    "<b>已排除 " + data.excludedMulti + " 场多客服接力的会话</b>——一个会话只有一个总时长，没法拆给几个人；其余按首接客服归属。" +
    "行 = 范围内出现过的全部场景、列 = 全部客服，都按接待次数降序，不截断；表格可横向滚动。</span>";
}

// 用户情绪 · 每个人的负向场景分布：行 = 客服 × 场景，只列有负向或正向的格子
// 负向 / 正向明细：把上表里那几个数字落到具体会话上，能直接点进去看原文
function renderEmoList(id, hintId, list) {
  const tbl = $(id);
  if (!tbl) return;
  const rows = Array.isArray(list) ? list : null;
  if (!rows) {              // 旧形状缓存没有 emoList
    tbl.innerHTML = '<tbody><tr><td>数据缓存是旧版本，点右上角「重新拉取数据」后本表才会出数</td></tr></tbody>';
    return;
  }
  const neg = rows.filter((r) => r.emo === "负向").length;
  if (hintId && $(hintId)) {
    $(hintId).textContent = "负向 / 正向会话明细（负向 " + neg + " 场、正向 " + (rows.length - neg) +
      " 场，负向在前，各自按时间倒序）；上面几张表按接待次数、本表按场次，一场转了几次人工就记几次，所以两处数字可能对不上";
  }
  const link = (u) => (u ? '<a href="' + escHtml(u) + '" target="_blank" rel="noopener">' + escHtml(u.replace(/^https?:\/\//, "")) + "</a>" : "—");
  const tag = (e) => '<span class="' + (e === "负向" ? "emo-neg" : "emo-pos") + '">' + escHtml(e) + "</span>";
  tbl.innerHTML =
    "<thead><tr><th>情绪</th><th>时间</th><th>会话地址</th><th>接待客服</th></tr></thead><tbody>" +
    (rows.length
      ? rows.map((r) =>
        "<tr><td>" + tag(r.emo) + "</td><td>" + escHtml(String(r.t || "").slice(0, 16).replace("T", " ")) + "</td><td>" + link(r.url) +
        "</td><td>" + escHtml(r.agent || "—") + "</td></tr>").join("")
      : '<tr><td colspan="4">范围内没有负向或正向情绪的人工会话</td></tr>') +
    "</tbody>";
}

function renderEmotion(id, sceneId, hintId, noteId, data, hint) {
  const tbl = $(id);
  if (!tbl) return;
  if (hintId && $(hintId)) $(hintId).textContent = hint;
  if (!data) return;
  if (!data.pairs) {          // 同上：旧形状缓存没有 pairs
    tbl.innerHTML = '<tbody><tr><td>数据缓存是旧版本，点右上角「重新拉取数据」后本表才会出数</td></tr></tbody>';
    return;
  }
  const pct = (v) => (v === null || v === undefined ? "—" : v + "%");
  tbl.innerHTML =
    '<thead><tr><th>姓名</th><th>场景</th><th class="num">接待次数</th>' +
    '<th class="num">负向</th><th class="num">负向比</th><th class="num">正向</th><th class="num">正向比</th></tr></thead><tbody>' +
    (data.pairs && data.pairs.length
      ? data.pairs.map((x) =>
        "<tr><td>" + escHtml(x.agent) + "</td><td>" + escHtml(x.scene) + '</td><td class="num">' + x.total +
        '</td><td class="num strong">' + x.neg + '</td><td class="num">' + pct(x.negRate) +
        '</td><td class="num strong pos">' + x.pos + '</td><td class="num">' + pct(x.posRate) + "</td></tr>").join("")
      : '<tr><td colspan="7">范围内没有负向或正向情绪的人工接待</td></tr>') +
    '<tr class="sum team"><td>合计</td><td>全部场景</td><td class="num">' + data.team.total +
    '</td><td class="num">' + data.team.neg + '</td><td class="num">' + pct(data.team.negRate) +
    '</td><td class="num">' + data.team.pos + '</td><td class="num">' + pct(data.team.posRate) + "</td></tr></tbody>";
  const st = $(sceneId);
  if (st) st.innerHTML =
    '<thead><tr><th>业务场景</th><th class="num">接待次数</th><th class="num">负向</th><th class="num">负向比</th>' +
    '<th class="num">中性</th><th class="num">正向</th></tr></thead><tbody>' +
    (data.scenes.length
      ? data.scenes.map((x) => "<tr><td>" + escHtml(x.name) + '</td><td class="num">' + x.total +
        '</td><td class="num strong">' + x.neg + '</td><td class="num">' + pct(x.negRate) +
        '</td><td class="num">' + x.neu + '</td><td class="num">' + x.pos + "</td></tr>").join("")
      : '<tr><td colspan="6">范围内没有带情绪标注的接待</td></tr>') + "</tbody>";
  // 2026-09-18 用户定：情绪表下方那段长口径说明不要了，口径仍留在 skills/统计口径.md
  if (noteId && $(noteId)) $(noteId).innerHTML = "";
}

// ============== 指标卡（总览） ==============

function renderCards(s, previous) {
  const d = s.derived;
  // 与上一等长周期的对比：整段求和后再算比率，不拿日均值相比（previous 由 /api/dashboard 同一次响应带回）
  const prevDay = previous?.byDay || null;
  const prevLabel = previous?.from ? "上一周期 " + previous.from + " ~ " + previous.to : "上一等长周期";
  const rate = (numerator, denominator) => (denominator > 0 ? (numerator / denominator) * 100 : 0);
  const sum = (byDay, f) => Object.values(byDay || {}).reduce((a, b) => a + (Number(f(b)) || 0), 0);
  const both = (f) => [sum(s.byDay, f), prevDay ? sum(prevDay, f) : null];
  const ratio = (fn, fd) => {
    const [n, p] = both(fn);
    const [dn, dp] = both(fd);
    return [rate(n, dn), p === null ? null : (dp ? rate(p, dp) : null)];
  };

  const [total, totalPrev] = both((b) => b.total);
  const [avd, avdPrev] = ratio((b) => b.avoidable, (b) => b.transfer);
  const [dur, durPrev] = both((b) => b.dur);
  const [turns, turnsPrev] = both((b) => b.turns);

  // 底部一排小柱：按周（区间不足 6 周时按天），最近一根黑色、其余浅灰 —— 原型 spark()
  const weekKeys = sortedKeys(s.byWeek);
  const sparkSrc = weekKeys.length >= 6 ? weekKeys.map((k) => s.byWeek[k]) : sortedKeys(s.byDay).map((k) => s.byDay[k]);
  const spark = (valueOf) => {
    const vals = sparkSrc.map((b) => { const v = valueOf(b || {}); return Number.isFinite(v) ? v : 0; });
    const max = Math.max(...vals, 1);
    return '<div class="spark" aria-hidden="true">' + vals.map((v, i) =>
      '<i style="height:' + ((v / max) * 100).toFixed(1) + "%;background:" + (i === vals.length - 1 ? INK : "#DBDADD") + '"></i>').join("") + "</div>";
  };
  const AI_TARGET = 85;
  const aiOk = Number(d.aiRate) >= AI_TARGET;

  const cards = [
    { label: "会话总数", value: fmtNum(s.total), pill: pillHtml(changeText(total, totalPrev)), sub: "有效会话 " + Math.round(Number(d.effectiveRate)) + "%", spark: spark((b) => Number(b.total) || 0), hint: "会话数走势" },
    { label: "AI 独立率", value: d.aiRate, unit: "%", pill: '<span class="pill ' + (aiOk ? "good" : "bad") + '">' + (aiOk ? "达标" : "未达标") + "</span>", sub: "目标 ≥ " + AI_TARGET + "%", spark: spark((b) => rate(b.aiOnly, b.total)), hint: "AI 独立率走势" },
    { label: "可避免转人工", value: d.avoidableRate, unit: "%", pill: pillHtml(changeText(avd, avdPrev, "pp")), sub: fmtNum(d.avoidableCount) + " / " + fmtNum(s.transferred) + " 次", spark: spark((b) => rate(b.avoidable, b.transfer)), hint: "可避免转人工占比走势" },
    { label: "人工接待总时长", value: d.durSumHours, unit: "小时", pill: pillHtml(changeText(dur, durPrev)), sub: "单次中位 " + fmtDuration(d.durMedian), spark: spark((b) => (Number(b.dur) || 0) / 3600), hint: "人工接待时长走势" },
    { label: "接待轮次", value: fmtNum(s.turnsSum), pill: pillHtml(changeText(turns, turnsPrev)), sub: "有时长记录 " + fmtNum(s.durCount) + " 次", spark: spark((b) => Number(b.turns) || 0), hint: "接待轮次走势" },
  ];

  $("cards").innerHTML = cards.map((c) =>
    '<div class="card" title="' + escHtml(c.hint + "；对比" + prevLabel) + '"><div class="card-label">' + c.label + "</div>" +
    '<div class="card-value">' + escHtml(c.value) + (c.unit ? "<small>" + c.unit + "</small>" : "") + "</div>" +
    '<div class="card-meta">' + (c.pill || "") + '<span class="card-sub">' + c.sub + "</span></div>" +
    c.spark + "</div>"
  ).join("");
  rollCards($("cards"));
  staggerIn($("cards"));
}

// ============== 日桶 → 任意粒度 ==============

// 把日桶按粒度合并；每个桶带 key / first / last / days，供横轴标签和悬停卡标题用
function rollupDays(byDay, grain) {
  const order = [];
  const map = {};
  const days = Object.keys(byDay || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const SUMS = ["total", "dur", "durCount", "transfer", "turns", "rep", "sj", "sjBase", "aiOnly", "avoidable", "manual", "effManual", "direct", "canA", "canBase"];
  for (const day of days) {
    const key = periodKeyOf(day, grain);
    if (!key) continue;
    if (!map[key]) {
      map[key] = { key, first: day, last: day, days: 0, dev: {}, ch: {}, nat: {}, natDur: {}, med: {} };
      SUMS.forEach((k) => { map[key][k] = 0; });
      order.push(key);
    }
    const t = map[key], b = byDay[day];
    t.last = day; t.days++;
    SUMS.forEach((k) => { t[k] += Number(b[k]) || 0; });
    for (const f of ["dev", "ch", "nat", "natDur", "med"]) {
      for (const [k, v] of Object.entries(b[f] || {})) t[f][k] = (t[f][k] || 0) + v;
    }
  }
  return { keys: order, buckets: order.map((k) => map[k]) };
}

let receptGrain = "day";
let distGrain = "week";
let uniqGrain = "week";

// 粒度页签：下划线式分段按钮。纯前端换分桶，不重新请求接口。
function initSeg(id, current, onPick) {
  const box = $(id);
  if (!box) return;
  box.replaceChildren(...GRAIN_LIST.map(([g, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.grain = g;
    b.textContent = label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-pressed", String(g === current));
    return b;
  }));
  box.addEventListener("click", (event) => {
    const b = event.target.closest("button[data-grain]");
    if (!b) return;
    box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset.grain);
  });
}

// 设备三段的悬停行（pc / mobile / 未知）+ 人工接待时长线
function deviceRows(b) {
  const dev = b.dev || {};
  return [
    { name: "pc", value: fmtNum(dev.pc || 0), color: COLOR_DEVICE.pc },
    { name: "mobile", value: fmtNum(dev.mobile || 0), color: COLOR_DEVICE.mobile },
    { name: "未知", value: fmtNum(b.total - (dev.pc || 0) - (dev.mobile || 0)), color: COLOR_DEVICE["未知"] },
    { name: "人工接待时长", value: (b.dur / 3600).toFixed(1) + " 小时", color: "#FFFFFF", line: true },
  ];
}

// ============== 总览 ==============

// ============== 区间条带（Range Lens，2026-10-16） ==============
// 主图看「窗口」那一段，下面的条带是整条序列（最近 52 周 ∪ 筛选区间，一根一天，维度筛选照套）。
// 窗口默认 = 顶部筛选的时间；人可以拖：拖中间平移、拖两端改宽度、点空白处跳过去、双击看全部 / 回到上一段、
// 键盘 ←→ 平移、↑↓ 放宽收窄、Esc 回到筛选。窗口只管这一张图，不写回筛选；离开筛选区间时窗口旁出现
// 「回到筛选」和「应用到全页」（后者才把窗口写进顶部筛选、整页重算）。
// 动效：手指 / 鼠标下直接跟手不加动画；松手按速度滑一段再用弹簧落到整天；程序改窗口（点空白、回到筛选、改筛选）弹簧滑过去。
// 主图在拖动和滑动时逐帧按整天窗口重画（domChart instant），纵轴上限逐帧缓动、不回弹。

const LENS_MIN_SPAN = 7;          // 窗口至少 7 天（筛选本身更短时以筛选为准）
const LENS_STEP = 7;              // 键盘一步 = 一周
const LENS_RUBBER_PX = 28;        // 拖出序列两端的橡皮筋上限
const ZERO_DAY = Object.freeze({ total: 0, dur: 0, dev: Object.freeze({}) });

const lens = {
  days: [], byDay: {}, n: 0, sig: "",
  a: 0, b: 0,                     // 窗口 [a, b)，以天为单位的浮点下标；画的时候取整
  def: null, prev: null,          // 默认窗口（= 筛选）、双击前的窗口
  drag: null, maxS: 0, maxH: 0, rkey: "", hkey: "", fsig2: "", easing: false, va: 0, vb: 0, lastT: 0, stateKey: "", ready: false, stripW: 0, fsig: "",
};

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const nextDay = (d) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
function lensMinSpan() { return Math.max(1, Math.min(LENS_MIN_SPAN, lens.def ? lens.def.b - lens.def.a : LENS_MIN_SPAN, lens.n)); }
function lensWhole() {
  const a = clampN(Math.round(lens.a), 0, Math.max(0, lens.n - 1));
  const b = clampN(Math.round(lens.b), a + 1, lens.n);
  return [a, b];
}
function lensDeviated() {
  if (!lens.def) return false;
  const [a, b] = lensWhole();
  return a !== lens.def.a || b !== lens.def.b;
}

// 由 /api/dashboard 的 series（没有时退回 stats.byDay = 全部时间）建整条序列：从起点到最后一天逐天补齐，空的天记 0
function syncLensSeries(s) {
  const src = state.series || { from: "", byDay: s.byDay || {} };
  const keys = Object.keys(src.byDay || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let first = src.from || keys[0] || state.resolvedFrom || "";
  let last = keys[keys.length - 1] || "";
  if (state.resolvedTo && state.resolvedTo > last) last = state.resolvedTo;
  if (state.resolvedFrom && (!first || state.resolvedFrom < first)) first = state.resolvedFrom;
  const days = [];
  if (first && last) for (let d = first; d <= last && days.length < 4000; d = nextDay(d)) days.push(d);
  const sig = days[0] + ".." + days[days.length - 1] + "|" + keys.length + "|" + keys.reduce((a, k) => a + src.byDay[k].total, 0);
  const oldDays = lens.days, oldA = lens.a, oldB = lens.b;
  lens.days = days; lens.byDay = src.byDay || {}; lens.n = days.length;
  // 默认窗口 = 筛选区间（全部时间 = 整条序列）
  const idx = (d, fallback) => { const i = days.indexOf(d); return i < 0 ? fallback : i; };
  const da = state.resolvedFrom ? idx(state.resolvedFrom, 0) : 0;
  const db = state.resolvedTo ? idx(state.resolvedTo, days.length - 1) + 1 : days.length;
  lens.def = { a: da, b: Math.max(da + 1, db) };
  // 旧窗口换算到新序列的下标（序列起点可能变了），好从旧位置滑到新默认
  let from = null;
  if (lens.ready && oldDays.length) {
    const oa = days.indexOf(oldDays[clampN(Math.round(oldA), 0, oldDays.length - 1)]);
    const ob = days.indexOf(oldDays[clampN(Math.round(oldB) - 1, 0, oldDays.length - 1)]);
    if (oa >= 0 && ob >= 0) from = { a: oa, b: ob + 1 };
  }
  const changed = sig !== lens.sig;
  lens.sig = sig;
  if (changed) paintLensStrip();
  // 只有顶部的时间变了才把窗口拉回默认；切页回来、只改维度筛选时保住人拖好的窗口
  const fsig = (state.resolvedFrom || "") + ".." + (state.resolvedTo || "");
  const reset = fsig !== lens.fsig;
  lens.fsig = fsig;
  if (reset) lens.prev = null;
  return { from, reset };
}

// 条带底图：上下两层一样的柱子（下层浅灰、上层深灰按窗口裁切）+ 月份刻度
function paintLensStrip() {
  const box = $("heroLens");
  if (!box) return;
  box.hidden = lens.n < 2;
  const vals = lens.days.map((d) => (lens.byDay[d] || ZERO_DAY).total);
  const max = Math.max(...vals, 1);
  const html = vals.map((v) => '<i style="height:' + Math.max(v ? 4 : 0, (v / max) * 100).toFixed(1) + '%"></i>').join("");
  $("lensDim").innerHTML = html;
  $("lensLit").innerHTML = html;
  const strip = $("lensStrip");
  const per = (strip.clientWidth || 800) / Math.max(1, lens.n);
  // 一天不到 3px 时柱子贴在一起、不倒圆角，整年读成一条剪影；宽了才留 1px 缝、两头圆
  strip.style.setProperty("--lens-gap", per >= 3 ? "1px" : "0px");
  strip.style.setProperty("--lens-r", per >= 3 ? "999px" : "0");
  // 两只把手是液态玻璃：经过柱子时边缘会把柱子折弯
  strip.querySelectorAll(".lens-h").forEach((h) => glassify(h, { radius: 11, bezel: 8, scale: 10, tail: "blur(0.6px) saturate(180%)" }));
  paintLensAxis();
}

function paintLensAxis() {
  const axis = $("lensX");
  if (!axis) return;
  const n = lens.n, days = lens.days;
  const width = axis.clientWidth || 800;
  const marks = [];
  if (n > 62) {
    days.forEach((d, i) => { if (d.slice(8) === "01") marks.push({ i, label: d.slice(5, 7) === "01" ? d.slice(0, 4) : Number(d.slice(5, 7)) + " 月", yr: d.slice(5, 7) === "01" }); });
  } else {
    days.forEach((d, i) => { if (new Date(d + "T00:00:00Z").getUTCDay() === 1) marks.push({ i, label: d.slice(5) }); });
  }
  // 太密就挑着标：年份先占位，其余按等距隔几个取一个，离已占位的标记不足 40px 的跳过
  const px = (m) => ((m.i + 0.5) / n) * width;
  const stride = Math.max(1, Math.ceil((marks.length * 44) / width));
  const kept = marks.filter((m) => m.yr);
  marks.forEach((m, k) => { if (!m.yr && k % stride === 0 && kept.every((o) => Math.abs(px(o) - px(m)) >= 40)) kept.push(m); });
  kept.sort((x, y) => x.i - y.i);
  axis.innerHTML = kept
    .map((m) => '<span class="' + (m.yr ? "yr" : "") + '" style="left:' + (((m.i + 0.5) / n) * 100).toFixed(2) + '%">' + m.label + "</span>").join("");
}

// 窗口位置 → 条带上的框 + 上层裁切
function placeLensWin() {
  const n = Math.max(1, lens.n);
  let a = (lens.a / n) * 100, b = (lens.b / n) * 100;
  // 窗口画出来至少 28px 宽（两只把手之间还要有能抓的中间），不够就以中心往两边撑开；数据窗口不变
  const sw = ($("lensStrip") || {}).clientWidth || 0;
  const minPct = sw ? (28 / sw) * 100 : 0;
  if (b - a < minPct) {
    const c = clampN((a + b) / 2, minPct / 2, 100 - minPct / 2);
    a = c - minPct / 2; b = c + minPct / 2;
  }
  const L = a.toFixed(3) + "%", W = Math.max(0, b - a).toFixed(3) + "%";
  const win = $("lensWin"), slab = $("lensSlab");
  if (win) { win.style.left = L; win.style.width = W; }
  if (slab) { slab.style.left = L; slab.style.width = W; }
  const lit = $("lensLit");
  if (lit) lit.style.clipPath = "inset(0 " + Math.max(0, 100 - b).toFixed(3) + "% 0 " + Math.max(0, a).toFixed(3) + "%)";
  const strip = $("lensStrip");
  const [wa, wb] = lensWhole();
  if (strip && lens.days[wa]) strip.setAttribute("aria-valuetext", lens.days[wa] + " 至 " + lens.days[wb - 1] + "，共 " + (wb - wa) + " 天");
}

// 会话接待分布（2026-10-13 用户定）：双泳道——深灰柱在下（悬停变黑），黑色实线 + 圆点在上（右轴小时），两者永不交叉；
// 当前周期铺 30% 品牌绿底带（只在窗口截到序列末尾时画，往回看的窗口没有「当前周期」）。
// mode：undefined = 正常（换粒度 / 换区间长出，同组桶形变）；"pan" = 拖动 / 滑动中的逐帧更新：
//   · 按天：窗口按小数天平移——多画两头露出半截的那天，整块内容按比例加宽、左移小数部分（只改 transform，不重画）；
//     跨过整天时才重画一次，重画前后每根柱子的位置一模一样，所以看起来是连续滑动。纵轴上限逐帧往目标靠、不回弹。
//   · 按周 / 月 / 季 / 年：一个桶要好几天才变，整天变化时重画，柱高靠 CSS 形变过渡（不重新长出）。
function lensDayBuckets(i0, i1, g) {
  const byDay = {};
  for (let i = i0; i < i1; i++) byDay[lens.days[i]] = lens.byDay[lens.days[i]] || ZERO_DAY;
  return rollupDays(byDay, g).buckets;
}

function drawReceptChart(s, mode) {
  if (!lens.n) return;
  const g = receptGrain, n = lens.n;
  const pan = mode === "pan";
  const sliding = pan && g === "day" && !REDUCED_MOTION;
  let i0, i1, slide = null;
  if (sliding) {
    let ca = lens.va, cb = lens.vb;
    // 橡皮筋只在条带上体现；主图把窗口推回序列内（跨度不变）
    if (ca < 0) { cb = Math.min(n, cb - ca); ca = 0; }
    if (cb > n) { ca = Math.max(0, ca - (cb - n)); cb = n; }
    if (cb - ca < 1) cb = Math.min(n, ca + 1);
    i0 = Math.floor(ca + 1e-6);
    i1 = Math.max(i0 + 1, Math.min(n, Math.ceil(cb - 1e-6)));
    slide = { R: (i1 - i0) / (cb - ca), S: (ca - i0) / (i1 - i0) };
  } else {
    [i0, i1] = lensWhole();
    if (!pan) { lens.va = lens.a; lens.vb = lens.b; }
  }
  const buckets = lensDayBuckets(i0, i1, g);
  const m = buckets.length;
  const tMaxS = niceMax(Math.max(...buckets.map((x) => x.total), 0) * 1.08);
  const tMaxH = niceMax(Math.max(...buckets.map((x) => x.dur / 3600), 0) * 1.15);
  // 滑动时上限逐帧往目标靠（临界阻尼，不回弹），柱子不会忽大忽小地跳
  if (sliding && lens.maxS) {
    lens.maxS += (tMaxS - lens.maxS) * 0.2;
    lens.maxH += (tMaxH - lens.maxH) * 0.2;
    if (Math.abs(lens.maxS - tMaxS) < tMaxS * 0.003) lens.maxS = tMaxS;
    if (Math.abs(lens.maxH - tMaxH) < tMaxH * 0.003) lens.maxH = tMaxH;
  } else { lens.maxS = tMaxS; lens.maxH = tMaxH; }
  const maxS = lens.maxS, maxH = lens.maxH;
  lens.easing = sliding && (maxS !== tMaxS || maxH !== tMaxH);
  const el = $("heroRecept");
  const rkey = g + ":" + i0 + ":" + i1 + ":" + maxS.toFixed(2) + ":" + maxH.toFixed(3);
  if (sliding && lens.rkey === rkey && el.querySelector(".dc-slide")) {
    // 同一批柱子：只挪 transform
    const w = (slide.R * 100).toFixed(4) + "%", t = "translateX(" + (-slide.S * 100).toFixed(4) + "%)";
    el.querySelectorAll(".dc-slide, .dc-xslide").forEach((x) => { x.style.width = w; x.style.transform = t; });
  } else {
    lens.rkey = sliding ? rkey : "";
    const band = i1 === n ? currentBand(buckets, g) : null;
    domChart(el, {
      height: 340, max: maxS, lanes: true, hoverInk: true, keys: buckets.map((x) => g + ":" + x.key),
      instant: sliding, noGrow: pan, slide, xIndexBase: sliding ? i0 : undefined, xIndexEnd: n - 1,
      bars: buckets.map((x) => ({ segs: [{ v: x.total, color: BAR_DARK }], ...barW(g), dashed: isOngoing(x) })),
      line: { values: buckets.map((x) => x.dur / 3600), color: INK, width: 2.5, max: maxH, dots: m <= 32 },
      yTicks: [0, 0.5, 1].map((p) => ({ pos: p * LANE_BAR, label: fmtNum(Math.round(maxS * p)) })),
      hTicks: [0, 0.5, 1].map((p) => ({ pos: LANE_LINE_FROM + p * LANE_LINE, label: (maxH * p).toFixed(maxH * p < 10 && p ? 1 : 0) + "h" })),
      band, ...axisFor(buckets, g),
      tip: (i) => {
        const x = buckets[i];
        if (!x) return null;
        const p = buckets[i - 1];
        return { title: bucketTitle(x, g), rows: deviceRows(x), foot: { name: "会话量", value: fmtNum(x.total), delta: p ? changeText(x.total, p.total) : "" }, notes: [isOngoing(x) ? "还没过完，读数还会往上走" : ""] };
      },
    });
    const lg = $("heroLegendCur");
    if (lg) { lg.textContent = band ? band.label : "当前周期"; lg.parentElement.style.display = band ? "" : "none"; }
  }
  // 大数字和日期按整天窗口算，整天变了才更新
  const [a, b] = lensWhole();
  const hkey = g + ":" + a + ":" + b + ":" + lens.sig;
  if (pan && hkey === lens.hkey) return;
  lens.hkey = hkey;
  let total = 0;
  for (let i = a; i < b; i++) total += (lens.byDay[lens.days[i]] || ZERO_DAY).total;
  const big = $("heroTotal");
  // 手底下的数字原地换（读得清），程序改窗口时才滚动
  if (pan && big) { if (big.$roll) big.$roll(); big.textContent = fmtNum(total); big.$val = total; }
  else rollTo(big, fmtNum(total));
  const cap = $("heroCaption");
  // 跨年或不在今年时日期带上年份，否则只写 MM-DD
  const da = lens.days[a], db = lens.days[b - 1];
  const fd = da.slice(0, 4) !== db.slice(0, 4) || db.slice(0, 4) !== todayKey().slice(0, 4) ? (d) => d : (d) => d.slice(5);
  if (cap) cap.textContent = "会话 · " + fd(da) + " 至 " + fd(db) + " · " + (b - a) + " 天 · 按" + (GRAIN_LIST.find((x) => x[0] === g) || ["", ""])[1] + "聚合，悬停柱子看明细";
  paintLensState();
}

function paintLensState() {
  const box = $("lensState");
  if (!box) return;
  const dev = lensDeviated();
  const key = dev ? "dev" : "follow";
  if (key === lens.stateKey) return;
  lens.stateKey = key;
  box.innerHTML = dev
    ? '<button type="button" class="btn-ghost" data-lens="reset">回到筛选</button><button type="button" class="btn-ghost" data-lens="apply">应用到全页</button>'
    : "跟随筛选 · 拖动下方条带可换一段看";
}

// 逐帧：窗口的整天区间变了，或纵轴上限还在往目标缓动，就重画主图；只挪框不重画
let lensRaf = 0;
function lensFrame() {
  placeLensWin();
  if (!lensRaf) lensRaf = requestAnimationFrame(lensStep);
}
// 条带上的框直接跟手；主图的视口（va / vb）用一阶临界阻尼追着框走（τ = 70ms，不回弹）。
// 条带 1px ≈ 主图几十 px（一年的条带看两周），鼠标按整像素动，主图如果直接跟会一格一格地跳；追一下就成了连续的滑动。
const LENS_FOLLOW_S = 0.07;
function lensStep(now) {
  lensRaf = 0;
  if (!LAST_STATS || state.tab !== "overview") { lens.va = lens.a; lens.vb = lens.b; lens.lastT = 0; return; }
  const dt = lens.lastT ? Math.min(0.05, (now - lens.lastT) / 1000) : 1 / 60;
  lens.lastT = now;
  const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt / LENS_FOLLOW_S);
  lens.va += (lens.a - lens.va) * k;
  lens.vb += (lens.b - lens.vb) * k;
  if (Math.abs(lens.a - lens.va) < 0.01) lens.va = lens.a;
  if (Math.abs(lens.b - lens.vb) < 0.01) lens.vb = lens.b;
  const following = lens.va !== lens.a || lens.vb !== lens.b;
  const sig = receptGrain + ":" + lens.va.toFixed(4) + ":" + lens.vb.toFixed(4) + ":" + lens.a.toFixed(3) + ":" + lens.b.toFixed(3);
  if (sig !== lens.fsig2 || lens.easing) { lens.fsig2 = sig; drawReceptChart(LAST_STATS, "pan"); }
  if (following || lens.easing) lensRaf = requestAnimationFrame(lensStep);
  else lens.lastT = 0;
}

// 程序改窗口：弹簧滑过去（REDUCED_MOTION 时 tween 直接落位）
function lensGlide(ta, tb, ms) {
  const a0 = lens.a, b0 = lens.b;
  tween(lens, "$glide", ms || 460, SPRING_SNAP, (k) => {
    lens.a = a0 + (ta - a0) * k;
    lens.b = b0 + (tb - b0) * k;
    if (k >= 1) { lens.a = ta; lens.b = tb; }
    lensFrame();
  });
}

// 夹回序列内、保住最小跨度，取整天。keep："span" 平移（跨度不变）/ "end" 拖左端（结束日不动）/ "start" 拖右端
function lensSnapTarget(a, b, keep) {
  const n = lens.n, min = lensMinSpan();
  if (keep === "span") {
    const span = clampN(Math.round(b - a), min, n);
    const ta = clampN(Math.round(a), 0, n - span);
    return [ta, ta + span];
  }
  let ta = clampN(Math.round(a), 0, n), tb = clampN(Math.round(b), 0, n);
  if (tb - ta < min) {
    if (keep === "end") { ta = Math.max(0, tb - min); tb = ta + min; }
    else { tb = Math.min(n, ta + min); ta = tb - min; }
  }
  return [ta, tb];
}

// 序列两端的橡皮筋：越拉越紧，最多出去 28px
function rubber(overDays, perPx) {
  const limit = LENS_RUBBER_PX / perPx;
  return limit * (1 - 1 / ((overDays * 0.55) / limit + 1));
}

function initLens() {
  const strip = $("lensStrip");
  if (!strip) return;
  const dayAt = (clientX) => {
    const r = strip.getBoundingClientRect();
    return ((clientX - r.left) / Math.max(1, r.width)) * lens.n;
  };
  const pxPerDay = () => strip.getBoundingClientRect().width / Math.max(1, lens.n);
  const partAt = (clientX) => {
    const r = strip.getBoundingClientRect();
    const per = r.width / Math.max(1, lens.n);
    let xa = lens.a * per, xb = lens.b * per;
    if (xb - xa < 28) { const c = clampN((xa + xb) / 2, 14, r.width - 14); xa = c - 14; xb = c + 14; }
    const x = clientX - r.left;
    const reach = Math.min(16, (xb - xa) / 3);
    if (x >= xa - 16 && x <= xa + reach) return "l";
    if (x <= xb + 16 && x >= xb - reach) return "r";
    if (x > xa && x < xb) return "move";
    return null;
  };

  strip.addEventListener("pointerdown", (e) => {
    if (!lens.n || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (lens.$glide) { lens.$glide(); lens.$glide = null; }
    hideTip();
    let part = partAt(e.clientX);
    if (!part) {
      // 点在窗口外：窗口先滑过去以手指为中心，接着当成拖中间
      const span = lens.b - lens.a;
      const c = dayAt(e.clientX);
      const [ta, tb] = lensSnapTarget(c - span / 2, c + span / 2, "span");
      lensGlide(ta, tb, 240);
      part = "move";
      lens.drag = { part, x0: e.clientX, a0: ta, b0: tb, moved: false, hist: [], jumped: true };
    } else {
      lens.drag = { part, x0: e.clientX, a0: lens.a, b0: lens.b, moved: false, hist: [], jumped: false };
    }
    strip.setPointerCapture(e.pointerId);
    $("lensWin").classList.add("held");
    $("lensSlab").classList.add("held");
    if (part === "l" || part === "r") strip.querySelector(".lens-h." + part).classList.add("on");
  });

  strip.addEventListener("pointermove", (e) => {
    const d = lens.drag;
    if (!d) {
      const p = partAt(e.clientX);
      strip.style.cursor = p === "l" || p === "r" ? "ew-resize" : p === "move" ? "grab" : "pointer";
      return;
    }
    const per = pxPerDay();
    const dx = (e.clientX - d.x0) / per;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    if (!d.moved && lens.$glide) { lens.$glide(); lens.$glide = null; }
    d.moved = true;
    d.hist.push([performance.now(), e.clientX]);
    if (d.hist.length > 6) d.hist.shift();
    const n = lens.n, min = lensMinSpan();
    if (d.part === "move") {
      const span = d.b0 - d.a0;
      let a = d.a0 + dx;
      if (a < 0) a = -rubber(-a, per);
      if (a + span > n) a = n - span + rubber(a + span - n, per);
      lens.a = a; lens.b = a + span;
    } else if (d.part === "l") {
      let a = Math.min(d.a0 + dx, d.b0 - min);
      if (a < 0) a = -rubber(-a, per);
      lens.a = a; lens.b = d.b0;
    } else {
      let b = Math.max(d.b0 + dx, d.a0 + min);
      if (b > n) b = n + rubber(b - n, per);
      lens.a = d.a0; lens.b = b;
    }
    lensFrame();
  });

  const end = () => {
    const d = lens.drag;
    if (!d) return;
    lens.drag = null;
    $("lensWin").classList.remove("held");
    $("lensSlab").classList.remove("held");
    strip.querySelectorAll(".lens-h.on").forEach((h) => h.classList.remove("on"));
    if (!d.moved) return;   // 只是点了一下：点在窗口外的那次已经在滑过去了
    // 松手：按最后几帧的速度往前滑一段（≈ 0.1 秒的距离），再弹簧落到整天
    let v = 0;
    const h = d.hist;
    if (h.length >= 2) {
      const [t0, x0] = h[0], [t1, x1] = h[h.length - 1];
      if (t1 - t0 > 0 && performance.now() - t1 < 80) v = (x1 - x0) / (t1 - t0);   // px/ms
    }
    const coast = (v * 99) / pxPerDay();
    let a = lens.a, b = lens.b;
    if (d.part === "move") { a += coast; b += coast; }
    else if (d.part === "l") a = Math.min(a + coast, b - lensMinSpan());
    else b = Math.max(b + coast, a + lensMinSpan());
    const [ta, tb] = lensSnapTarget(a, b, d.part === "move" ? "span" : d.part === "l" ? "end" : "start");
    lensGlide(ta, tb, 520);
  };
  strip.addEventListener("pointerup", end);
  strip.addEventListener("pointercancel", end);

  // 双击：看全部；再双击回到上一段
  strip.addEventListener("dblclick", () => {
    if (!lens.n) return;
    if (lens.prev) { const p = lens.prev; lens.prev = null; lensGlide(p.a, p.b); return; }
    const [a, b] = lensWhole();
    if (a === 0 && b === lens.n) return;
    lens.prev = { a, b };
    lensGlide(0, lens.n);
  });

  strip.addEventListener("keydown", (e) => {
    if (!lens.n) return;
    const [a, b] = lensWhole();
    let t = null;
    if (e.key === "ArrowLeft") t = lensSnapTarget(a - LENS_STEP, b - LENS_STEP, "span");
    else if (e.key === "ArrowRight") t = lensSnapTarget(a + LENS_STEP, b + LENS_STEP, "span");
    // 放宽 / 收窄都保住结束日：截到今天的窗口一直截到今天；顶到序列开头再放宽就往后长
    else if (e.key === "ArrowUp") t = a - LENS_STEP >= 0 ? lensSnapTarget(a - LENS_STEP, b, "end") : lensSnapTarget(0, b + (LENS_STEP - a), "start");
    else if (e.key === "ArrowDown") t = lensSnapTarget(a + LENS_STEP, b, "end");
    else if (e.key === "Escape" && lens.def) t = [lens.def.a, lens.def.b];
    else if (e.key === "Home") t = lensSnapTarget(0, b - a, "span");
    else if (e.key === "End") t = lensSnapTarget(lens.n - (b - a), lens.n, "span");
    if (!t) return;
    e.preventDefault();
    lensGlide(t[0], t[1], 320);
  });

  $("lensState").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lens]");
    if (!btn || !lens.def) return;
    if (btn.dataset.lens === "reset") { lens.prev = null; lensGlide(lens.def.a, lens.def.b); return; }
    // 应用到全页：窗口写进顶部「自定义」时间，整页按它重算
    const [a, b] = lensWhole();
    $("fRange").value = "custom";
    applyRangePreset();
    $("fFrom").value = lens.days[a];
    $("fTo").value = lens.days[b - 1];
    reload();
  });

  window.addEventListener("resize", () => { if (lens.n) { lens.stripW = $("lensStrip").clientWidth; paintLensStrip(); placeLensWin(); } });
}

// 总览渲染入口：同步序列 → 首次直接落位并正常画（长出）；改了筛选时间就从旧窗口滑到新默认；只改维度就原地形变
function renderReceptHero(s) {
  const { from, reset } = syncLensSeries(s);
  if (!lens.n) return;
  // 条带在隐藏的面板里量不出宽度：回到总览、或宽度变了就重铺一次（缝和刻度跟宽度走）
  const sw = $("lensStrip").clientWidth;
  if (sw && sw !== lens.stripW) { lens.stripW = sw; paintLensStrip(); }
  const def = lens.def;
  if (lens.$glide) { lens.$glide(); lens.$glide = null; }
  if (!lens.ready || !from || REDUCED_MOTION) {
    const keep = lens.ready && from && !reset;
    lens.a = keep ? from.a : def.a; lens.b = keep ? from.b : def.b; lens.ready = true;
    placeLensWin();
    drawReceptChart(s);
    return;
  }
  if (!reset || (from.a === def.a && from.b === def.b)) {
    lens.a = reset ? def.a : from.a; lens.b = reset ? def.b : from.b;
    placeLensWin();
    drawReceptChart(s);
    return;
  }
  lens.a = from.a; lens.b = from.b;
  placeLensWin();
  drawReceptChart(s, "pan");
  lensGlide(def.a, def.b);
}

// 接待人数与企业数（总览）：两个大数字 + 按周并列细柱，不带粒度切换
function drawOverviewUniq(s) {
  const by = (s.uniq && s.uniq.week) || {};
  const keys = Object.keys(by).sort();
  const all = s.uniqAll || { users: 0, orgs: 0 };
  rollTo($("ovUniqUsers"), fmtNum(all.users));
  rollTo($("ovUniqOrgs"), fmtNum(all.orgs));
  const box = $("ovUniqBars");
  if (!box) return;
  const max = Math.max(...keys.map((k) => by[k].users), 1);
  box.innerHTML = keys.map((k, i) =>
    '<div class="pair-col" data-tip="' + i + '"><i style="height:' + ((by[k].users / max) * 100).toFixed(1) + "%;background:" + INK + '"></i><i style="height:' + ((by[k].orgs / max) * 100).toFixed(1) + '%;background:#AAA9AB"></i></div>'
  ).join("");
  box.$tip = (i) => {
    const k = keys[i];
    if (!k) return null;
    const wb = (s.byWeek || {})[k] || { total: 0 };
    return {
      title: "W" + Number(k.slice(5)) + " · " + (wb.first ? "" : "") + "按周去重",
      rows: [{ name: "接待人数", value: fmtNum(by[k].users) + " 人", color: INK }, { name: "接待企业数", value: fmtNum(by[k].orgs) + " 家", color: "#AAA9AB" }],
      foot: { name: "人均会话", value: by[k].users ? (wb.total / by[k].users).toFixed(2) : "—" },
    };
  };
  if (!box.dataset.bound) { box.dataset.bound = "1"; bindDomTip(box, (i) => box.$tip(i)); }
}

function renderOverview(s) {
  renderReceptHero(s);
  const dev = s.device || {};
  const order = ["pc", "mobile", "未知"];
  const keys = Object.keys(dev).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const box = $("devStack");
  if (box) box.innerHTML = stackHtml(keys.map((k, i) => ({ label: k, value: dev[k], color: colorFor(COLOR_DEVICE, k, i) })));
  drawOverviewUniq(fixedStats(s));
}

// 不随筛选的那几张图用「最近 24 周」的固定 stats；没拉到时退回当前 stats
function fixedStats(s) { return state.fixed || s; }

// ============== 接待量与来源 ==============

// 会话接待分布 · 按设备：pc / mobile / 未知 三段堆叠胶囊柱，≤20 根时柱顶标合计
function drawVolumeDist(s) {
  const g = distGrain;
  const { buckets } = rollupDays(s.byDay, g);
  const maxS = niceMax(Math.max(...buckets.map((b) => b.total), 0) * 1.12);
  const showLabels = buckets.length <= 20;
  const band = currentBand(buckets, g);
  domChart($("volDist"), {
    height: 250, max: maxS, band, keys: buckets.map((b) => g + ":" + b.key),
    bars: buckets.map((b) => {
      const dev = b.dev || {};
      const pc = dev.pc || 0, mob = dev.mobile || 0, unk = Math.max(0, b.total - pc - mob);
      return { segs: [{ v: pc, color: COLOR_DEVICE.pc }, { v: mob, color: COLOR_DEVICE.mobile }, { v: unk, color: COLOR_DEVICE["未知"] }], ...barW(g), label: showLabels ? fmtNum(b.total) : "", dashed: isOngoing(b) };
    }),
    yTicks: [0, 0.5, 1].map((p) => ({ pos: p * 100, label: fmtNum(Math.round(maxS * p)) })),
    ...axisFor(buckets, g),
    tip: (i) => {
      const b = buckets[i];
      if (!b) return null;
      const p = buckets[i - 1];
      return { title: bucketTitle(b, g), rows: deviceRows(b), foot: { name: "合计", value: fmtNum(b.total), delta: p ? changeText(b.total, p.total) : "" } };
    },
  });
  const t = $("volDistTotal");
  rollTo(t, fmtNum(buckets.reduce((a, b) => a + b.total, 0)));
}

// 接待人数与企业数（接待量页）：并列双柱 + 粒度切换；去重数只能来自服务端 s.uniq[粒度]，客户端不能从日粒度累加
function drawVolumeUniq(s) {
  const g = uniqGrain;
  const by = (s.uniq && s.uniq[g]) || {};
  const keys = Object.keys(by).sort();
  const all = s.uniqAll || { users: 0, orgs: 0 };
  rollTo($("volUniqUsers"), fmtNum(all.users));
  rollTo($("volUniqOrgs"), fmtNum(all.orgs));
  const box = $("volUniq");
  if (!box) return;
  const { buckets } = rollupDays(s.byDay, g);
  const byKey = {};
  buckets.forEach((b) => { byKey[b.key] = b; });
  const max = niceMax(Math.max(...keys.map((k) => by[k].users), 0) * 1.15);
  const showLabels = keys.length <= 20;
  const pw = pairW(g);
  const wStyle = "width:" + pw.wPct + "%;min-width:3px;max-width:" + pw.wMax + "px";
  const n = keys.length;
  const bk = keys.map((k) => byKey[k] || { key: k, first: k, last: k, days: 1 });
  const band = currentBand(bk, g);
  const ax = axisFor(bk, g);
  box.innerHTML =
    '<div class="dc"><div class="dc-body"><div class="dc-plot pair-plot" style="height:200px">' +
    (band ? '<div class="dc-band" style="left:' + ((band.from / n) * 100).toFixed(2) + "%;width:" + (((band.to - band.from + 1) / n) * 100).toFixed(2) + '%"><span>' + band.label + "</span></div>" : "") +
    '<div class="dc-cols">' +
    keys.map((k, i) =>
      '<div class="dc-col pair" data-tip="' + i + '">' +
      '<div class="pair-one" style="' + wStyle + '">' + (showLabels ? '<span class="dc-label">' + fmtNum(by[k].users) + "</span>" : "") + '<i style="height:' + ((by[k].users / max) * 100).toFixed(1) + "%;background:" + INK + '"></i></div>' +
      '<div class="pair-one" style="' + wStyle + '">' + (showLabels ? '<span class="dc-label dim">' + fmtNum(by[k].orgs) + "</span>" : "") + '<i style="height:' + ((by[k].orgs / max) * 100).toFixed(1) + '%;background:#AAA9AB"></i></div></div>'
    ).join("") +
    "</div></div>" +
    (ax.xPerBar ? '<div class="dc-x per">' + ax.xPerBar.map((x) => "<span>" + escHtml(x) + "</span>").join("") + "</div>"
      : '<div class="dc-x abs">' + ax.xLabels.map((x) => '<span style="left:' + x.left + '%">' + escHtml(x.label) + "</span>").join("") + "</div>") +
    "</div></div>";
  if (ax.xPerBar) {
    const axis = box.querySelector(".dc-x.per");
    const step = axis && axis.clientWidth ? Math.ceil((n * 46) / axis.clientWidth) : 1;
    if (step > 1) axis.querySelectorAll("span").forEach((sp, i) => { if ((n - 1 - i) % step) sp.textContent = ""; });
  }
  box.$tip = (i) => {
    const k = keys[i];
    if (!k) return null;
    const b = byKey[k] || { key: k, first: k, last: k, days: 1, total: 0 };
    return {
      title: bucketTitle(b, g),
      rows: [{ name: "接待人数", value: fmtNum(by[k].users) + " 人", color: INK }, { name: "接待企业数", value: fmtNum(by[k].orgs) + " 家", color: "#AAA9AB" }],
      foot: { name: "会话数", value: fmtNum(b.total) },
    };
  };
  if (!box.dataset.bound) { box.dataset.bound = "1"; bindDomTip(box, (i) => box.$tip(i)); }
  if (n === 0) box.innerHTML = '<p class="chart-foot">范围内没有会话</p>';
}

// 入口媒介 Top 12：排名 + 名称 + 占最大值的条 + 会话数；前三名黑，其余中灰
function renderMediumList(s) {
  const box = $("mediumList");
  if (!box) return;
  const pairs = sortedPairs(s.medium, 12);
  const max = Math.max(...pairs.map((p) => p[1]), 1);
  box.innerHTML = pairs.map(([name, v], i) =>
    '<li><span class="rk">' + (i + 1) + '</span><span class="nm" title="' + escHtml(name) + '">' + escHtml(name) + '</span><span class="tr"><i style="width:' + ((v / max) * 100).toFixed(1) + "%;background:" + (i < 3 ? INK : "#AAA9AB") + '"></i></span><b>' + fmtNum(v) + "</b></li>"
  ).join("") || '<li class="empty">范围内没有会话</li>';
}

// 入口媒介 · 最近 9 周（2026-10-14 用户定）：媒介 × 周的热力矩阵，画法同人工服务页的「服务节奏」；
// 取固定口径数据里最近 9 个周桶（含本周），媒介按 9 周合计取前 12，颜色按整张矩阵的最大值分 5 档，0 留空白
function renderMediumWeeks(s) {
  const grid = $("mediumWeeks");
  if (!grid) return;
  const weeks = rollupDays(s.byDay, "week").buckets.slice(-9);
  if (!weeks.length || !weeks.some((w) => w.med && Object.keys(w.med).length)) {
    grid.innerHTML = '<p class="chart-foot">数据缓存是旧版本，点左下角「重新拉取数据」后本图才会出数</p>';
    return;
  }
  const sum = {};
  weeks.forEach((w) => { for (const [k, v] of Object.entries(w.med || {})) sum[k] = (sum[k] || 0) + v; });
  const mediums = sortedPairs(sum, 12).map((p) => p[0]);
  const cells = mediums.map((m) => weeks.map((w) => (w.med || {})[m] || 0));
  const max = Math.max(...cells.flat(), 0);
  const cols = weeks.length;
  const level = (n) => (n ? Math.min(5, Math.max(1, Math.ceil((n / max) * 5))) : 0);
  const wl = (w) => "W" + Number(w.key.slice(5));
  grid.style.setProperty("--heat-cols", cols);
  grid.innerHTML = mediums.map((m, r) =>
    '<div class="heat-row"><span title="' + escHtml(m) + '">' + escHtml(m) + "</span>" +
    cells[r].map((n, k) => { const lv = level(n); return '<i data-tip="' + (r * cols + k) + '" style="background:' + HEAT5[lv] + (lv >= 4 ? ";color:#fff" : "") + '">' + (n ? fmtNum(n) : "") + "</i>"; }).join("") + "</div>"
  ).join("") +
    '<div class="heat-row heat-axis"><span></span>' + weeks.map((w) => "<b" + (isOngoing(w) ? ' class="today"' : "") + ">" + wl(w) + (w.days < 7 ? "*" : "") + "</b>").join("") + "</div>";
  grid.$tip = (i) => {
    const r = Math.floor(i / cols), k = i % cols;
    const w = weeks[k], m = mediums[r];
    if (!w || !m) return null;
    const n = cells[r][k];
    return {
      title: m + " · " + bucketTitle(w, "week"),
      rows: [{ name: "会话", value: fmtNum(n) + " 场", color: n ? HEAT5[level(n)] : "#F1F0F3" }, { name: "占该周全部", value: pct(n, w.total) + "%", color: "#F1F0F3" }],
      foot: { name: "该媒介 " + cols + " 周合计", value: fmtNum(sum[m]) + " 场" },
      notes: [w.days < 7 ? "这一周还没过完（* 号）" : ""],
    };
  };
  if (!grid.dataset.bound) { grid.dataset.bound = "1"; bindDomTip(grid, (i) => grid.$tip(i)); }
}

// 热力表的列：会话性质取前 5 + 其他（和原型一致）
function natureCols(nature) {
  const all = sortedPairs(nature).map((p) => p[0]);
  return all.length > 6 ? { cols: all.slice(0, 5).concat(["其他"]), rest: all.slice(5) } : { cols: all, rest: [] };
}

function renderVolume(s) {
  drawVolumeDist(fixedStats(s));
  drawVolumeUniq(fixedStats(s));
  renderChannelMultiples(fixedStats(s));
  renderMediumWeeks(fixedStats(s));

  const { cols, rest } = natureCols(s.nature);
  const valueOf = (map) => (row, k) => {
    const src = map[row] || {};
    if (k !== "其他") return src[k] || 0;
    return rest.reduce((a, x) => a + (src[x] || 0), 0);
  };
  const channels = sortedPairs(s.channel).map((p) => p[0]);
  heatTable("tblChannelNature", channels, cols, valueOf(s.natureByChannel || {}), "渠道");
  const devices = sortedPairs(s.device).map((p) => p[0]);
  heatTable("tblDeviceNature", devices, cols, valueOf(s.natureByDevice || {}), "设备");
  renderMediumList(s);
}

// ============== AI 表现 ==============

const AI_TARGET = 85;

// 伪随机但固定的 100 根单位柱高度（原型用 62%~100% 的随机高度，纯装饰）
function unitHeights() {
  let a = 404;
  return Array.from({ length: 100 }, () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return 62 + (a % 3800) / 100;
  });
}

function renderAIPanel(s) {
  const status = s.status || {};
  const jiriOnly = status["仅 Jiri"] || 0;
  const manual = status["仅人工"] || 0;
  const all = jiriOnly + manual;
  const rateV = all ? (jiriOnly / all) * 100 : 0;
  const on = Math.round(rateV);
  const ok = rateV >= AI_TARGET;
  const pillEl = $("aiRatePill");
  if (pillEl) { pillEl.className = "pill " + (ok ? "good" : "bad"); pillEl.textContent = (ok ? "达标" : "未达标") + " · 目标 ≥ " + AI_TARGET + "%"; }
  const big = $("aiRateBig");
  if (big) big.innerHTML = pct(jiriOnly, all) + "<small>%</small>";
  const cap = $("aiRateCaption");
  if (cap) cap.textContent = "每 100 个会话，约 " + on + " 个由 Jiri 独立完成";
  const units = $("aiUnits");
  if (units) {
    const hs = unitHeights();
    units.innerHTML = hs.map((h, i) => '<i style="height:' + h.toFixed(1) + "%;background:" + (i < on ? GREEN : INK) + '"></i>').join("");
  }
  const lg = $("aiRateLegend");
  if (lg) lg.innerHTML = '<span><i style="background:' + GREEN + '"></i>仅 Jiri <b>' + fmtNum(jiriOnly) + "</b></span><span><i style=\"background:" + INK + '"></i>人工在线 <b>' + fmtNum(manual) + "</b></span>";

  // 转到人工的会话，Jiri 本来能否解答：能 / 部分 / 不能 三列 + 一根分段条
  const jiri = s.jiri || {};
  const can = jiri["能"] || 0, part = jiri["部分"] || 0, cannot = jiri["不能"] || 0;
  const base = can + part + cannot;
  const items = [["能", can, GREEN], ["部分", part, "#AAA9AB"], ["不能", cannot, INK]];
  const cols = $("canAnswerCols");
  if (cols) cols.innerHTML = items.map(([label, v, c]) =>
    '<div><span class="lg"><i style="background:' + c + '"></i>' + label + '</span><b class="big">' + pct(v, base) + "<small>%</small></b><span class=\"sub\">" + fmtNum(v) + " 次</span></div>"
  ).join("");
  const bar = $("canAnswerBar");
  if (bar) bar.innerHTML = items.filter((x) => x[1] > 0).map(([, v, c]) => '<i style="width:' + pct(v, base) + "%;background:" + c + '"></i>').join("");
  const tn = $("canAnswerTotal");
  if (tn) tn.textContent = fmtNum(s.transferred) + " 次转人工";

  drawRepeatWeekly(fixedStats(s));
  drawTrio(s);
  renderRepeatsTable(s);
}

const REPEAT_LIMIT = 7;   // 复问率警戒线（%）

// 复问率 · 每周（最近 24 周，不随筛选）：胶囊周柱 + 柱顶数值 + 7% 虚线警戒线；最近一周黑色、超线深灰、其余浅灰
function drawRepeatWeekly(s) {
  const { buckets } = rollupDays(s.byDay, "week");
  const vals = buckets.map((b) => (b.total ? (b.rep / b.total) * 100 : 0));
  const vMax = Math.max(REPEAT_LIMIT * 1.3, Math.max(...vals, 0) * 1.2);
  const n = vals.length;
  const box = $("repeatBars");
  if (box) {
    box.innerHTML =
      '<div class="dc-cap" style="bottom:' + ((REPEAT_LIMIT / vMax) * 100).toFixed(1) + '%"></div>' +
      vals.map((v, i) =>
        '<div class="rb-col" data-tip="' + i + '"><span class="dc-label' + (i === n - 1 ? "" : " dim") + '">' + v.toFixed(1) + '</span><i style="height:' + Math.max(1, (v / vMax) * 100).toFixed(1) + "%;background:" + (i === n - 1 ? INK : v >= REPEAT_LIMIT ? "#55545A" : "#D3D2D6") + '"></i></div>'
      ).join("");
    box.$tip = (i) => {
      const b = buckets[i];
      if (!b) return null;
      const p = buckets[i - 1];
      const pv = p && p.total ? (p.rep / p.total) * 100 : null;
      return { title: bucketTitle(b, "week"), rows: [{ name: "复问会话", value: fmtNum(b.rep) + " 场", color: i === n - 1 ? INK : "#D3D2D6" }, { name: "会话", value: fmtNum(b.total) + " 场", color: "#F1F0F3" }], foot: { name: "复问率", value: vals[i].toFixed(2) + "%", delta: pv === null ? "" : changeText(vals[i], pv, "pp") } };
    };
    if (!box.dataset.bound) { box.dataset.bound = "1"; bindDomTip(box, (i) => box.$tip(i)); }
  }
  const axis = $("repeatAxis");
  if (axis) axis.innerHTML = buckets.map((b) => "<span>W" + Number(b.key.slice(5)) + "</span>").join("");
  const cur = n ? vals[n - 1] : 0, prev = n > 1 ? vals[n - 2] : null;
  const big = $("repeatBig");
  if (big) big.innerHTML = cur.toFixed(1) + "<small>%</small>";
  const pill = $("repeatPill");
  if (pill) pill.innerHTML = prev === null ? "" : pillHtml(changeText(cur, prev, "pp"));
}

// 人工有效 · 秒转 · Jiri 可解答：三张迷你趋势卡（周粒度），量纲不同，分开画
function drawTrio(s) {
  const box = $("trioCards");
  if (!box) return;
  const { buckets } = rollupDays(s.byDay, "week");
  const series = (f) => buckets.map((b) => { const v = f(b); return Number.isFinite(v) ? v : null; });
  const r = (n, d) => (d ? (n / d) * 100 : NaN);
  const defs = [
    ["人工有效率", series((b) => r(b.effManual, b.manual)), "人工接待中被判定为有效会话的占比"],
    ["秒转率", series((b) => r(b.direct, b.effManual)), "有效人工里用户一进来就要人工（直接转）的占比"],
    ["Jiri 可解答率", series((b) => r(b.canA, b.canBase)), "转人工会话中 Jiri 本可解答的占比"],
  ];
  box.innerHTML = defs.map(([name, vals, note], k) => {
    const pts = vals.map((v, i) => [v, i]).filter((x) => x[0] !== null);
    const nums = pts.map((x) => x[0]);
    const mn = Math.min(...nums), mx = Math.max(...nums);
    const n = vals.length;
    const path = pts.length ? smoothPath(pts.map(([v, i]) => [(n > 1 ? i / (n - 1) : 0.5) * 300, 62 - ((v - mn) / (mx - mn || 1)) * 54])) : "";
    const last = nums.length ? nums[nums.length - 1] : null;
    const prev = nums.length > 1 ? nums[nums.length - 2] : null;
    const delta = last !== null && prev !== null ? changeText(last, prev, "pp") : "";
    return '<div class="trio" data-k="' + k + '"><span class="nm">' + name + '</span><div class="val"><b>' + (last === null ? "—" : last.toFixed(1) + "%") + "</b>" + pillHtml(delta) + "</div>" +
      '<svg viewBox="0 0 300 70" preserveAspectRatio="none" role="img" aria-label="' + name + " 近 " + n + ' 周走势">' + (path ? '<path d="' + path + 'L300 70L0 70Z" fill="#DBDADD" opacity=".55"></path><path d="' + path + '" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>' : "") + "</svg>" +
      '<span class="tn">' + note + "</span></div>";
  }).join("");
}

// 复问明细：一行一条复问链（首问 → 复问几次 → 最后谁接）；默认最近 8 条，可展开全部
function renderRepeatsTable(s) {
  const tbl = $("tblRepeats");
  if (!tbl) return;
  const all = Array.isArray(s.repeats) ? s.repeats : [];
  if (all.length && all[0].n === undefined) {
    tbl.innerHTML = '<div class="rt-row"><span>数据缓存是旧版本，点左下角「重新拉取数据」后本表才会出数</span></div>';
    return;
  }
  const expanded = !!state.repeatsAll;
  const rows = expanded ? all : all.slice(0, 8);
  const link = (u, text) => (u ? '<a href="' + escHtml(u) + '" target="_blank" rel="noopener">' + escHtml(text) + "</a>" : escHtml(text));
  const who = (st) => (st === "仅 Jiri" ? '<span class="pill good">仅 Jiri</span>' : '<span class="pill">人工</span>');
  tbl.innerHTML =
    '<div class="rt-head"><span>时间</span><span>业务场景</span><span>首次提问摘要</span><span class="num">复问</span><span class="num">最后接待</span></div>' +
    (rows.length
      ? rows.map((r) => '<div class="rt-row"><span class="dim">' + link(r.url, String(r.t || "").slice(5, 16).replace("T", " ")) + "</span><span>" + escHtml(r.scene || "—") +
        '</span><span class="ellipsis">' + link(r.from, r.q || "（无一句话总结）") + '</span><span class="num strong">' + r.n + ' 次</span><span class="num">' + who(r.who) + "</span></div>").join("")
      : '<div class="rt-row"><span>当前筛选范围内没有复问会话</span></div>');
  const head = $("repeatsHead");
  if (head) head.textContent = "复问明细 · " + (all.length > 8 && !expanded ? "最近 8 条" : all.length + " 条");
  const more = $("repeatsMore");
  if (more) {
    more.hidden = all.length <= 8;
    more.textContent = expanded ? "只看最近 8 条" : "查看全部 →";
  }
}

// ============== 分析页：人工服务 ==============

// 可避免的转人工原因（与服务端 AVOIDABLE_REASONS 一致，只用于着色）
const AVOIDABLE = new Set(["AI能答没给机会", "没等答完/顺手转", "可自助", "答对仍要人"]);

function mmss(sec) {
  const s = Math.round(Number(sec) || 0);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// 顶部五张指标卡：总时长（比上期）、单次中位、转人工次数、高峰时段、负向情绪
function renderServiceCards(s, previous) {
  const box = $("serviceCards");
  if (!box) return;
  const d = s.derived || {};
  const sum = (byDay, f) => Object.values(byDay || {}).reduce((a, b) => a + (Number(f(b)) || 0), 0);
  const prevDur = previous && previous.byDay ? sum(previous.byDay, (b) => b.dur) : null;
  const durPill = prevDur === null ? "" : pillHtml(changeText(sum(s.byDay, (b) => b.dur), prevDur));

  // 高峰时段：过去 7 天的 15 分钟格先并成 24 小时，再找最忙的连续两小时；最忙的两天写日期
  let peak = "—", peakSub = "";
  const hw = s.hourlyWeek;
  if (hw && hw.manual && Array.isArray(hw.days)) {
    const per = Math.max(1, Math.round(60 / (Number(hw.slotMinutes) || 60)));
    const byHour = Array.from({ length: 24 }, (_, h) => hw.manual.reduce((a, row) => { let t = 0; for (let k = h * per; k < (h + 1) * per; k++) t += row[k] || 0; return a + t; }, 0));
    let best = 0, bi = 0;
    for (let h = 0; h < 23; h++) { const v = byHour[h] + byHour[h + 1]; if (v > best) { best = v; bi = h; } }
    if (best > 0) peak = bi + "–" + (bi + 2);
    const byDay = hw.manual.map((row, i) => [i, row.reduce((a, v) => a + v, 0)]).sort((a, b) => b[1] - a[1]).filter((x) => x[1] > 0).slice(0, 2);
    if (byDay.length) peakSub = byDay.map((x) => hw.days[x[0]].slice(5)).join("、") + " 最忙";
  }
  const emo = (s.emotion || {}).team || {};
  const cards = [
    { label: "人工接待总时长", value: d.durSumHours, unit: "小时", pill: durPill, sub: prevDur === null ? "" : "比上期" },
    { label: "单次接待时长", value: mmss(d.durMedian), unit: "中位", sub: "平均 " + fmtDuration(d.durAvg) },
    { label: "转人工次数", value: fmtNum(s.transferred), unit: "次", sub: "其中可避免 " + fmtNum(d.avoidableCount) + " 次" },
    { label: "高峰时段", value: peak, unit: "点", sub: peakSub },
    { label: "用户负向情绪", value: emo.negRate === null || emo.negRate === undefined ? "—" : emo.negRate, unit: "%", sub: "人工接待中负向占比" },
  ];
  box.innerHTML = cards.map((c) =>
    '<div class="card"><div class="card-label">' + c.label + '</div><div class="card-value">' + escHtml(c.value) + (c.unit ? "<small>" + c.unit + "</small>" : "") + "</div>" +
    '<div class="card-meta">' + (c.pill || "") + '<span class="card-sub">' + escHtml(c.sub) + "</span></div></div>"
  ).join("");
  rollCards(box);
}

// 每日人工接待时长与转人工次数：灰色胶囊柱（小时，柱顶标数）+ 黑线转人工次数（右轴）；连续无人工接待的日期合并成一格「周末」
function drawDailyService(s) {
  const days = sortedKeys(s.byDay).slice(-30);
  const merged = [];
  for (const day of days) {
    const b = s.byDay[day];
    const empty = !b || (!(b.dur > 0) && !(b.transfer > 0));
    const last = merged[merged.length - 1];
    if (empty && last && last.empty) { last.to = day; last.n++; continue; }
    merged.push({ from: day, to: day, n: 1, empty, dur: b ? b.dur : 0, transfer: b ? b.transfer : 0 });
  }
  const dow = (d) => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
  const isWeekend = (m) => { for (let t = new Date(m.from + "T00:00:00Z"); t <= new Date(m.to + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 1)) { if (dow(t.toISOString().slice(0, 10)) < 5) return false; } return true; };
  const hMax = niceMax(Math.max(...merged.map((m) => m.dur / 3600), 0) * 1.1);
  const tMax = niceMax(Math.max(...merged.map((m) => m.transfer), 0) * 1.1);
  domChart($("dailyService"), {
    height: 220, max: hMax,
    bars: merged.map((m) => (m.empty
      ? { segs: [{ v: hMax * 0.02, color: "#ECEBEF" }], w: 30, label: "" }
      : { segs: [{ v: m.dur / 3600, color: "#AAA9AB" }], w: 12, label: (m.dur / 3600).toFixed(1), labelClass: "dim" })),
    line: { values: merged.map((m) => m.transfer), color: INK, width: 2, max: tMax },
    xPerBar: merged.map((m) => (m.empty && m.n > 1 ? (isWeekend(m) ? "周末" : m.from.slice(5) + "–" + m.to.slice(5)) : m.from.slice(5))),
    tip: (i) => {
      const m = merged[i];
      if (!m) return null;
      if (m.empty) return { title: m.from + (m.n > 1 ? " – " + m.to.slice(5) : "") + (isWeekend(m) ? " · 周末" : "") + " · 无人工接待", rows: [{ name: "转人工", value: "0 次", color: INK, line: true }], foot: { name: "人工接待时长", value: "0 小时" } };
      const p = merged.slice(0, i).reverse().find((x) => !x.empty);
      return { title: m.from + (p ? " · 对比 " + p.from.slice(5) : ""), rows: [{ name: "转人工", value: fmtNum(m.transfer) + " 次", color: INK, line: true }], foot: { name: "人工接待时长", value: (m.dur / 3600).toFixed(1) + " 小时", delta: p ? changeText(m.dur, p.dur) : "" } };
    },
  });
  const h = $("dailyServiceTitle");
  if (h) h.textContent = "每日人工接待时长与转人工次数 · 近 " + days.length + " 天";
}

// 会话时长 · 按周：有效 / 填表人 / 其他 三段堆叠（小时，柱顶标合计）+ 绿色单会话平均时长线（分钟，右轴）
function drawWeekDur(s) {
  const weeks = sortedKeys(s.byWeek);
  const wb = weeks.map((w) => s.byWeek[w]);
  const hrs = (b, k) => (((b.natDur || {})[k] || 0) / 3600);
  const other = (b) => Math.max(0, (b.dur - ((b.natDur || {})["有效"] || 0) - ((b.natDur || {})["填表人"] || 0)) / 3600);
  const avg = (b) => (b.durCount ? b.dur / b.durCount / 60 : null);
  const tMax = Math.max(...wb.map((b) => b.dur / 3600), 0) * 1.18 || 1;
  domChart($("weekDur"), {
    height: 210, max: tMax,
    bars: wb.map((b) => ({ segs: [{ v: hrs(b, "有效"), color: INK }, { v: hrs(b, "填表人"), color: "#8E8D93" }, { v: other(b), color: "#DBDADD" }], w: 22, label: (b.dur / 3600).toFixed(1) })),
    line: { values: wb.map(avg), color: GREEN, width: 3, max: Math.max(...wb.map((b) => avg(b) || 0), 1) * 1.3 },
    xPerBar: weeks.map((w) => "W" + Number(w.slice(5))),
    tip: (i) => {
      const b = wb[i];
      if (!b) return null;
      const p = wb[i - 1];
      return {
        title: "W" + Number(weeks[i].slice(5)) + " · 人工时长",
        rows: [
          { name: "有效", value: hrs(b, "有效").toFixed(1) + " 小时", color: INK },
          { name: "填表人", value: hrs(b, "填表人").toFixed(1) + " 小时", color: "#8E8D93" },
          { name: "其他", value: other(b).toFixed(1) + " 小时", color: "#DBDADD" },
          { name: "单会话平均", value: avg(b) === null ? "—" : avg(b).toFixed(1) + " 分钟", color: GREEN, line: true },
        ],
        foot: { name: "合计", value: (b.dur / 3600).toFixed(1) + " 小时", delta: p ? changeText(b.dur, p.dur) : "" },
      };
    },
  });
}

// 02 为什么转人工：方式两列大数字 + 分段条；原因横条（可避免为绿）
function renderWhyTransfer(s) {
  const way = s.way || {};
  const talk = way["沟通后转"] || 0, direct = way["直接转"] || 0;
  const all = talk + direct;
  const cols = $("wayCols");
  if (cols) cols.innerHTML =
    '<div><span class="lg"><i style="background:' + INK + '"></i>沟通后转</span><b class="big">' + pct(talk, all) + "<small>%</small></b><span class=\"sub\">" + fmtNum(talk) + " 次 · 先和 Jiri 聊过</span></div>" +
    '<div><span class="lg"><i style="background:#DBDADD;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)"></i>直接转</span><b class="big">' + pct(direct, all) + "<small>%</small></b><span class=\"sub\">" + fmtNum(direct) + " 次 · 一进来就要人工</span></div>";
  const bar = $("wayBar");
  if (bar) bar.innerHTML = (talk ? '<i style="width:' + pct(talk, all) + "%;background:" + INK + '"></i>' : "") + (direct ? '<i style="width:' + pct(direct, all) + '%;background:#DBDADD"></i>' : "");

  const reasons = sortedPairs(s.reason);
  const max = Math.max(...reasons.map((p) => p[1]), 1);
  const list = $("reasonList");
  if (list) list.innerHTML = reasons.map(([name, n]) =>
    '<div class="reason"><span title="' + escHtml(name) + '">' + escHtml(name) + '</span><span class="tr"><i style="width:' + ((n / max) * 100).toFixed(1) + "%;background:" + (AVOIDABLE.has(name) ? GREEN : "#D3D2D6") + '"></i></span><b>' + fmtNum(n) + "</b></div>"
  ).join("") || '<p class="chart-foot">范围内没有转人工</p>';
  const d = s.derived || {};
  const av = $("reasonAvoidable");
  if (av) av.textContent = "可避免，合计 " + d.avoidableRate + "%";
}

// 场景 × 客服 · 单次接待时长中位数（热力格）：和同场景全员中位比，≤0.8 绿、≤1.1 浅灰、≤1.35 中灰、更慢深灰；样本 < 3 次写 —
function cellTone(ratio) {
  if (ratio <= 0.8) return { bg: GREEN, fg: INK };
  if (ratio <= 1.1) return { bg: "#F1F0F3", fg: INK };
  if (ratio <= 1.35) return { bg: "#AAA9AB", fg: INK };
  return { bg: "#3A3A40", fg: "#FFFFFF" };
}

function renderAgentSceneHeat(data) {
  const box = $("agentSceneHeat");
  if (!box) return;
  if (!data || !data.rows || !data.rows.length) {
    box.innerHTML = '<p class="chart-foot">' + (data && !data.rows ? "数据缓存是旧版本，点左下角「重新拉取数据」后本表才会出数" : "范围内没有可算单次时长的有效人工接待") + "</p>";
    return;
  }
  const agents = data.agents;
  const tpl = "170px repeat(" + agents.length + ", minmax(0, 1fr)) 96px";
  const secOf = (c) => (c.sec !== undefined ? c.sec : c.v * 60);
  box.innerHTML =
    '<div class="hm" style="min-width:' + Math.max(600, 270 + agents.length * 96) + 'px">' +
    '<div class="hm-row head" style="grid-template-columns:' + tpl + '"><span>场景</span>' + agents.map((a) => "<span>" + escHtml(a) + "</span>").join("") + '<span class="med">全员中位</span></div>' +
    data.rows.map((r) => {
      const base = r.base ? secOf(r.base) : 0;
      return '<div class="hm-row" style="grid-template-columns:' + tpl + '"><span class="nm" title="' + escHtml(r.scene) + '">' + escHtml(r.scene) + "</span>" +
        r.cells.map((c, k) => {
          if (!c || c.n < 3) return '<span class="cell none" title="' + escHtml(agents[k] + "：样本不足") + '">—</span>';
          const sec = secOf(c);
          const t = cellTone(base ? sec / base : 1);
          return '<span class="cell" style="background:' + t.bg + ";color:" + t.fg + '" title="' + escHtml(agents[k] + " · " + r.scene + "：中位 " + mmss(sec) + "（全员 " + mmss(base) + "）· " + c.n + " 次") + '">' + mmss(sec) + "</span>";
        }).join("") +
        '<span class="cell med">' + (r.base ? mmss(base) : "—") + "</span></div>";
    }).join("") + "</div>";
}

// 用户情绪 · 按客服：每人一行（主要负向场景 / 接待次数 / 黑-灰-绿情绪构成条 / 负向 / 正向），按负向占比降序
function renderEmotionAgents(data) {
  const box = $("emotionAgents");
  if (!box) return;
  if (!data || !data.agents) {
    box.innerHTML = '<p class="chart-foot">数据缓存是旧版本，点左下角「重新拉取数据」后本表才会出数</p>';
    return;
  }
  const topScene = {};
  (data.pairs || []).forEach((p) => { if (p.neg > 0 && (!topScene[p.agent] || p.neg > topScene[p.agent].neg)) topScene[p.agent] = p; });
  const rows = data.agents.slice().sort((a, b) => (b.neg / (b.total || 1)) - (a.neg / (a.total || 1)));
  const pctOf = (n, t) => (t ? ((n / t) * 100).toFixed(1) : "0.0");
  box.innerHTML =
    '<div class="em-row head"><span>姓名</span><span>主要负向场景</span><span class="num">接待次数</span><span>情绪构成</span><span class="num">负向</span><span class="num">正向</span></div>' +
    (rows.length ? rows.map((a) =>
      '<div class="em-row"><span class="nm">' + escHtml(a.name) + '</span><span class="dim">' + escHtml(topScene[a.name] ? topScene[a.name].scene : "—") + '</span><span class="num strong">' + fmtNum(a.total) + "</span>" +
      '<span class="bar"><i style="width:' + pctOf(a.neg, a.total) + "%;background:" + INK + '"></i><i class="mid"></i><i style="width:' + pctOf(a.pos, a.total) + "%;background:" + GREEN + '"></i></span>' +
      '<span class="num"><b>' + a.neg + "</b> <small>(" + pctOf(a.neg, a.total) + "%)</small></span><span class=\"num\"><b>" + a.pos + "</b> <small>(" + pctOf(a.pos, a.total) + "%)</small></span></div>"
    ).join("") : '<div class="em-row"><span>范围内没有带客服标注的人工接待</span></div>');
}

// 情绪会话明细：负向 / 正向两个页签；一行 = 情绪胶囊 / 时间 / 一句话总结（链接到原文）/ 接待客服
function renderEmoDetail(list) {
  const box = $("emoDetail");
  if (!box) return;
  const rows = Array.isArray(list) ? list : null;
  if (!rows) { box.innerHTML = '<p class="chart-foot">数据缓存是旧版本，点左下角「重新拉取数据」后本表才会出数</p>'; return; }
  const mode = state.emoTab === "pos" ? "正向" : "负向";
  document.querySelectorAll("#emoTabs button[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.mode === "pos" ? "正向" : "负向") === mode)));
  const sel = rows.filter((r) => r.emo === mode);
  const link = (r) => {
    const text = r.q || (r.url ? r.url.replace(/^https?:\/\//, "") : "（无一句话总结）");
    return r.url ? '<a href="' + escHtml(r.url) + '" target="_blank" rel="noopener">' + escHtml(text) + " ↗</a>" : escHtml(text);
  };
  box.innerHTML =
    '<div class="ed-row head"><span>情绪</span><span>时间</span><span>会话</span><span class="num">接待客服</span></div>' +
    (sel.length ? sel.map((r) =>
      '<div class="ed-row"><span><span class="' + (mode === "负向" ? "emo-neg" : "emo-pos") + '">' + mode + '</span></span><span class="dim">' + escHtml(String(r.t || "").slice(5, 16).replace("T", " ")) + '</span><span class="ellipsis">' + link(r) + '</span><span class="num">' + escHtml(r.agent || "—") + "</span></div>"
    ).join("") : '<div class="ed-row"><span>范围内没有' + mode + '情绪的人工会话</span></div>');
}

function renderService(s) {
  renderServiceCards(s, state.previous);
  drawDailyService(s);
  drawHourlyWeek(s);
  drawManualBusy(s);
  drawWeekDur(s);
  renderWhyTransfer(s);
  renderAgentSceneHeat(s.agentScene);
  renderEmotionAgents(s.emotion);
  renderEmoDetail((s.emotion || {}).emoList);
  renderAgentsCum();
}

// 累计评估表来自 /api/weekly 的最新一周（第 27 周起累计），不随顶部筛选变化
async function renderAgentsCum() {
  if (!state.weeklyLoaded) await loadWeekly();
  const w = state.weeks.at(-1);
  if (!w) return;
  agentTable("tblAgentsCum", w.agentsCum);
  const hint = $("agentHintCum");
  if (hint) hint.textContent = "只看仅人工 · 第 " + Number(String(w.cumFromWeek || "").slice(5)) + " 周 ～ 第 " + Number(w.week.slice(5)) + " 周累计 · 复问样本小，看趋势用这张";
}

// 24 小时服务节奏：周一～周日 × 24 小时的人工会话数热力格。0 留空白，其余按最大值分 5 档，最深一档是主色。
const HEAT5 = ["transparent", "#E4E3E7", "#BDBCC2", "#8D8C93", "#4A4A50", "#0B0B0C"];

function drawHourlyWeek(s) {
  const grid = $("hourlyGrid");
  if (!grid) return;
  const hw = s.hourlyWeek;
  if (!hw || !hw.manual || !Array.isArray(hw.days)) {
    grid.innerHTML = '<p class="chart-foot">数据缓存是旧版本，点左下角「重新拉取数据」后本图才会出数</p>';
    return;
  }
  // 过去 7 个完整自然日（不含今天），一行一天、按日期排；只画 09:30～18:30（窗口随数据下发）
  const step = Number(hw.slotMinutes) || 60;
  const win = hw.window || { start: 0, end: 24 * 60 };
  const from = Math.floor(win.start / step), to = Math.ceil(win.end / step);
  const cols = to - from;
  const rows = hw.manual.map((row) => row.slice(from, to));
  const max = Math.max(...rows.flat(), 0);
  const dayLabel = (d) => d.slice(5) + "（" + WD_CN[new Date(d + "T00:00:00Z").getUTCDay()] + "）";
  grid.style.setProperty("--heat-cols", cols);
  grid.innerHTML = rows.map((row, d) =>
    '<div class="heat-row"><span>' + dayLabel(hw.days[d]) + "</span>" +
    row.map((n, k) => {
      const lv = n ? Math.min(5, Math.max(1, Math.ceil((n / max) * 5))) : 0;
      return '<i data-tip="' + (d * cols + k) + '" style="background:' + HEAT5[lv] + '"></i>';
    }).join("") + "</div>"
  ).join("") +
    // 横轴：整点处标小时数
    '<div class="heat-row heat-axis"><span></span>' + Array.from({ length: cols }, (_, k) => { const m = (from + k) * step; return "<b>" + (m % 60 === 0 ? m / 60 : "") + "</b>"; }).join("") + "</div>";
  // 悬停：深色卡片写「日期（周几） 时段 · 人工会话 N 场」，底部给当天合计
  grid.$tip = (i) => {
    const d = Math.floor(i / cols), k = i % cols;
    const n = (rows[d] || [])[k];
    if (n === undefined) return null;
    const m = (from + k) * step;
    const lv = n ? Math.min(5, Math.max(1, Math.ceil((n / max) * 5))) : 0;
    const dayTotal = (hw.manual[d] || []).reduce((a, b) => a + b, 0);
    return {
      title: dayLabel(hw.days[d]) + " " + minuteLabel(m) + " – " + minuteLabel(m + step),
      rows: [{ name: "人工会话", value: n + " 场", color: lv ? HEAT5[lv] : "#F1F0F3" }],
      foot: { name: "当天合计", value: dayTotal + " 场" },
    };
  };
  if (!grid.dataset.bound) { grid.dataset.bound = "1"; bindDomTip(grid, (i) => grid.$tip(i)); }
}

// 人工服务忙闲：全天 96 个 15 分钟格，格高 = 同时在线人工会话数（工作日 / 周末各自的日均），虚线是在岗容量
function minuteLabel(minute) {
  return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
}

function drawManualBusy(s) {
  const busy = s.manualBusy || {};
  const box = $("manualBusyBars");
  if (!box) return;
  if (!Array.isArray(busy.slots) || !busy.day) {
    box.innerHTML = '<p class="chart-foot">数据缓存是旧版本，点左下角「重新拉取数据」后本图才会出数</p>';
    return;
  }
  // 只看最近一个完整自然日（通常是昨天）
  const dayLabel = busy.day.slice(5) + "（" + WD_CN[new Date(busy.day + "T00:00:00Z").getUTCDay()] + "）";
  const sub = $("manualBusySub");
  if (sub) sub.textContent = dayLabel + " · 09:30～18:30 同时在线人工会话数";
  const cap = Number(busy.capacity) || 6;
  const step = Number(busy.slotMinutes) || 15;
  // 只画 09:30～18:30（窗口随数据下发）
  const win = busy.window || { start: 0, end: 24 * 60 };
  const from = Math.floor(win.start / step), to = Math.ceil(win.end / step);
  const vals = busy.slots.slice(from, to);
  const top = Math.max(cap * 1.5, Math.max(...vals, 0) * 1.1);
  const tone = (v) => (v === 0 ? "#ECEBEF" : v > cap ? INK : v > cap / 2 ? "#8E8D93" : "#DBDADD");
  box.innerHTML =
    '<div class="busy-cap" style="bottom:' + ((cap / top) * 100).toFixed(1) + '%"><span>在岗容量 ' + cap + "</span></div>" +
    vals.map((v, i) => '<i data-tip="' + i + '" style="height:' + Math.max(3, (v / top) * 100).toFixed(1) + "%;background:" + tone(v) + '"></i>').join("");
  // 横轴：窗口首尾 + 每 90 分钟一个刻度
  const axis = $("manualBusyAxis");
  if (axis) {
    const span = win.end - win.start;
    const ticks = [];
    for (let m = win.start; m <= win.end; m += 90) ticks.push(m);
    if (ticks[ticks.length - 1] !== win.end) ticks.push(win.end);
    axis.innerHTML = ticks.map((m) => '<span style="left:' + (((m - win.start) / span) * 100).toFixed(2) + '%">' + minuteLabel(m) + "</span>").join("");
  }
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    bindDomTip(box, (i) => {
      const b = (LAST_STATS || s).manualBusy || {};
      const w = b.window || { start: 0, end: 24 * 60 };
      const off = Math.floor(w.start / step);
      const cur = (b.slots || [])[off + i];
      if (cur === undefined) return null;
      const c = Number(b.capacity) || 6;
      const dl = b.day ? b.day.slice(5) + "（" + WD_CN[new Date(b.day + "T00:00:00Z").getUTCDay()] + "）" : "";
      return {
        title: dl + " " + minuteLabel((off + i) * step) + " – " + minuteLabel((off + i + 1) * step),
        rows: [{ name: "同时在线人工会话", value: String(cur) + " 场", color: tone(cur) }],
        foot: { name: "在岗容量", value: String(c) },
        notes: [cur > c ? "超出容量" : "", b.noDurationDay ? "当天另有 " + b.noDurationDay + " 场无时长记录未计入" : ""],
      };
    });
  }
}

// ============== 分析页：接待量与来源 ==============

// 浅 → 深的单色阶，用于热力格；过半后改白字
function heatCell(v, max) {
  if (!v) return '<td style="background:#FAFAFB;color:#AAA9AB">—</td>';
  const t = Math.pow(v / max, .8);
  const a = [244, 243, 246], z = [11, 11, 12];
  const c = a.map((x, i) => Math.round(x + (z[i] - x) * t));
  return '<td style="background:rgb(' + c.join(",") + ");color:" + (t > .5 ? "#fff" : INK) + '">' + fmtNum(v) + "</td>";
}

function heatTable(id, rowKeys, colKeys, valueOf, firstHead) {
  const tbl = $(id);
  if (!tbl) return;
  let max = 0;
  rowKeys.forEach((r) => colKeys.forEach((c) => { max = Math.max(max, valueOf(r, c) || 0); }));
  tbl.innerHTML = "<thead><tr><th>" + firstHead + "</th>" + colKeys.map((c) => "<th>" + escHtml(c) + "</th>").join("") +
    '<th style="text-align:right">合计</th></tr></thead><tbody>' +
    rowKeys.map((r) => {
      const vals = colKeys.map((c) => valueOf(r, c) || 0);
      return "<tr><td>" + escHtml(r) + "</td>" + vals.map((v) => heatCell(v, max)).join("") +
        '<td class="total">' + fmtNum(vals.reduce((a, v) => a + v, 0)) + "</td></tr>";
    }).join("") + "</tbody>";
}

// 每个渠道一张小图（小倍数）：比 6 色堆叠在一根柱上好读；柱上标数、柱下标周
function renderChannelMultiples(s) {
  const grid = $("chanGrid");
  if (!grid) return;
  const allWeeks = sortedKeys(s.byWeek);
  // 区间首尾常是半周：只画完整周（原型口径），避免最后一周只有 1 天把柱子压扁；范围内没有完整周时退回全部周
  const dayCount = {};
  sortedKeys(s.byDay).forEach((d) => { const w = isoWeekOf(d); dayCount[w] = (dayCount[w] || 0) + 1; });
  const full = (w) => (dayCount[w] || 0) >= 7;
  const fullWeeks = allWeeks.filter(full);
  const weeks = fullWeeks.length ? fullWeeks : allWeeks;
  const lastFull = fullWeeks.at(-1), prevFull = fullWeeks.at(-2);
  const channels = sortedPairs(s.channel);
  const total = channels.reduce((a, p) => a + p[1], 0);
  const label = (w) => "W" + Number(w.slice(5));
  const step = weeks.length > 12 ? 2 : 1;

  grid.innerHTML = channels.map(([name, count], ci) => {
    const vals = weeks.map((w) => (s.byWeek[w].ch || {})[name] || 0);
    const max = Math.max(...vals, 1);
    const last = lastFull ? (s.byWeek[lastFull].ch || {})[name] || 0 : 0;
    const prev = prevFull ? (s.byWeek[prevFull].ch || {})[name] || 0 : 0;
    const change = lastFull && prevFull ? changeText(last, prev) : "";
    return '<div class="mult" data-ch="' + ci + '">' +
      '<div class="mult-head"><div class="mult-name"><b>' + escHtml(name) + "</b><small>累计 " + fmtNum(count) + " · 占全部 " + pct(count, total) + "%</small></div>" +
      (lastFull ? '<div class="mult-last"><small>' + label(lastFull) + "</small><b>" + fmtNum(last) + "</b>" + pillHtml(change) + "</div>" : "") + "</div>" +
      '<div class="cols" style="height:132px">' + vals.map((v, i) => {
        const now = weeks[i] === lastFull;
        return '<div class="col" data-tip="' + i + '"><span class="v' + (now ? " strong" : "") + '">' + fmtNum(v) + "</span>" +
          '<span class="bar' + (now ? " now" : "") + '" style="height:' + ((v / max) * 78).toFixed(1) + "%;" + (full(weeks[i]) ? "" : "opacity:.45") + '"></span></div>';
      }).join("") + "</div>" +
      '<div class="axis">' + weeks.map((w, i) => "<span>" + ((weeks.length - 1 - i) % step === 0 ? label(w) : "") + "</span>").join("") + "</div></div>";
  }).join("");
  grid.querySelectorAll(".mult").forEach((card) => {
    const name = channels[Number(card.dataset.ch)][0];
    bindDomTip(card, (i) => {
      const w = weeks[i];
      const v = (s.byWeek[w].ch || {})[name] || 0;
      const p = i > 0 ? (s.byWeek[weeks[i - 1]].ch || {})[name] || 0 : null;
      return {
        title: name + " · " + label(w) + (full(w) ? "" : "（不完整）"),
        rows: [{ name: "占该周全部会话", value: pct(v, s.byWeek[w].total) + "%", color: weeks[i] === lastFull ? INK : "#C9C8CD" }],
        foot: { name: "会话", value: fmtNum(v), delta: p !== null ? changeText(v, p) : "" },
        notes: [p !== null ? "涨跌对比上一周" : ""],
      };
    });
  });
  const hint = $("hintWeekChannel");
  if (hint) hint.textContent = "最近 24 周 · 不随筛选 · " + (weeks.length ? label(weeks[0]) + " – " + label(weeks.at(-1)) : "") + (fullWeeks.length ? " · 只算完整周 · 黑色为最近一周" : " · 范围内没有完整周，浅色为不完整周");
}

// ============== 分析页：业务与套餐 ==============

// 排名条：第一名深色，其余中灰；「未知 / 未标记」一律浅灰，不抢注意力
function rankHtml(pairs, total, muted) {
  const max = Math.max(...pairs.map((p) => p[1]), 1);
  return pairs.map(([name, v], i) => {
    const color = (muted || []).includes(name) ? "#DBDADD" : i === 0 ? INK : "#8D8C93";
    return '<div><div class="rank-row-head"><span>' + escHtml(name) + "</span><span><b>" + fmtNum(v) + "</b><small>" + pct(v, total) + "%</small></span></div>" +
      '<div class="track"><i style="width:' + ((v / max) * 100).toFixed(1) + "%;background:" + color + '"></i></div></div>';
  }).join("");
}

function renderBusiness(s) {
  const nature = sortedPairs(s.nature);
  $("rankNature").innerHTML = rankHtml(nature, s.total, ["未标记"]);
  const tn = $("totalNature2");
  if (tn) tn.textContent = "全部 " + fmtNum(s.total);
  const plan = sortedPairs(s.plan);
  $("rankPlan").innerHTML = rankHtml(plan, plan.reduce((a, p) => a + p[1], 0));
  // 「无关」占九成以上，会把其他分类压成一条线，剔除后只看真正相关的会话
  const xj = sortedPairs(s.xjCategory).filter((p) => p[0] !== "无关");
  const xjTotal = xj.reduce((a, p) => a + p[1], 0);
  $("rankXj").innerHTML = xj.length ? rankHtml(xj, xjTotal) : '<p class="chart-foot">范围内没有小金商户相关会话</p>';
  const tx = $("totalXj");
  if (tx) tx.textContent = "无关 " + fmtNum((s.xjCategory || {})["无关"] || 0) + " 已排除";

  // 业务场景分布：竖向胶囊柱，柱下依次是占比、场景名（两行对齐在柱底）
  const scenes = sortedPairs(s.effectiveScene);
  const sceneTotal = scenes.reduce((a, p) => a + p[1], 0);
  const max = Math.max(...scenes.map((p) => p[1]), 1);
  const color = (name, i) => (name === "其他" || name === "未分类" ? "#DBDADD" : i < 3 ? INK : "#AAA9AB");
  // 柱下第二行：Jiri 独立解决率 = 该场景有效会话里仅 Jiri 接待的占比，≥ 90% 用绿
  const aiOf = (name) => { const a = (s.effectiveSceneAI || {})[name] || 0, t = (s.effectiveScene || {})[name] || 0; return t ? Math.round((a / t) * 100) : null; };
  const aiPill = (name) => { const r = aiOf(name); return r === null ? "" : '<span class="pill' + (r >= 90 ? " good" : "") + '">AI ' + r + "%</span>"; };
  const box = $("sceneBars");
  if (box) {
    box.innerHTML = '<div class="cols">' + scenes.map(([name, v], i) =>
      '<div class="col" data-tip="' + i + '"><span class="v strong">' + fmtNum(v) + '</span><span class="bar" style="height:' + ((v / max) * 86).toFixed(1) + "%;background:" + color(name, i) + '"></span></div>'
    ).join("") + "</div>" +
      '<div class="axis">' + scenes.map(([name, v]) => "<div><b>" + pct(v, sceneTotal) + "%</b>" + aiPill(name) + "<small>" + escHtml(name) + "</small></div>").join("") + "</div>";
    if (!box.dataset.bound) {
      box.dataset.bound = "1";
      bindDomTip(box, (i) => {
        const cur = sortedPairs((LAST_STATS || s).effectiveScene);
        const curTotal = cur.reduce((a, p) => a + p[1], 0);
        const x = cur[i];
        if (!x) return null;
        const ai = aiOf(x[0]);
        return { title: x[0], rows: [{ name: "有效会话", value: fmtNum(x[1]), color: color(x[0], i) }, { name: "Jiri 独立解决", value: ai === null ? "—" : ai + "%", color: ai !== null && ai >= 90 ? GREEN : "#D3D2D6" }], foot: { name: "占有效会话", value: pct(x[1], curTotal) + "%" } };
      });
    }
  }

  // 行列都按有效会话口径，避免出现全零的行/列；套餐按档位从低到高固定排序，不按数量排
  const planTotals = {};
  for (const row of Object.values(s.sceneByPlan || {})) {
    for (const [k, v] of Object.entries(row)) planTotals[k] = (planTotals[k] || 0) + v;
  }
  const PLAN_ORDER = ["免费版", "专业版", "专业增强版", "企业基础版", "企业协作版", "企业高级版", "商业合作版"];
  const plans = Object.keys(planTotals).sort((a, b) => {
    const ia = PLAN_ORDER.indexOf(a);
    const ib = PLAN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  heatTable("crossTable", scenes.map((p) => p[0]), plans, (sc, p) => (s.sceneByPlan[sc] || {})[p], "场景");
}

// ============== 业务闭环 ==============

async function loadLoop() {
  if (state.loopLoaded) return;
  try {
    const json = await api("/api/loop");
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      $("hintLoopWeek").textContent = buildingText(json.meta);
      return;
    }
    state.loop = json.loop;
    state.loopLoaded = true;
  } catch (err) {
    $("hintLoopWeek").textContent = "加载失败：" + err.message;
  }
}

const HATCH = "repeating-linear-gradient(135deg, #AAA9AB 0 2px, #F1F0F3 2px 5px)";

function renderLoop(loop) {
  const ws = loop.weeks || [];
  const o = loop.overall || {};
  const wkNo = (x) => Number(x.week.slice(5));
  const rateText = (r) => (r === null || r === undefined ? "—" : Number(r).toFixed(1));

  // 头部大数字：最近一个「待定不超过 30%」的周；全都未定时退回最后一周
  const settled = ws.filter((x) => !x.unsettled && x.rate !== null);
  const hero = settled.at(-1) || ws.at(-1);
  const kpi = $("loopKpi");
  if (kpi) {
    kpi.innerHTML = hero
      ? "<h3>闭环率 · 第 " + wkNo(hero) + " 周</h3>" +
        '<div class="rate"><b>' + rateText(hero.rate) + "<small>%</small></b>" +
        (hero.pending ? '<span class="dl flat">下限 · 只会上升</span>' : "") + "</div>" +
        "<span>是 " + hero.yes + " · 否 " + hero.no + " · 待定 " + hero.pending + "，适用 " + hero.applicable + " 场 · 全部周整体 " + rateText(o.rate) + "%</span>"
      : "<h3>闭环率</h3><span>暂无适用会话</span>";
    rollCards(kpi, ".rate b");
  }

  // 每周趋势：是 / 否 / 待定 三段胶囊（段间 2px），柱顶为闭环率；待定超 30% 的周加虚线框、读数变浅
  const box = $("loopWeeks");
  if (box) {
    const max = Math.max(...ws.map((x) => x.applicable), 1) * 1.08;
    box.innerHTML = '<div class="cols">' + ws.map((x, i) =>
      '<div class="col" data-tip="' + i + '">' +
      '<span class="rate' + (x.unsettled ? " low" : "") + '">' + rateText(x.rate) + (x.rate === null ? "" : "%") + "</span>" +
      '<span class="seg-stack' + (x.unsettled ? " unsettled" : "") + '" style="height:' + ((x.applicable / max) * 100).toFixed(1) + '%">' +
      (x.pending ? '<i style="flex:' + x.pending + " 1 0;background:" + HATCH + '"></i>' : "") +
      (x.no ? '<i style="flex:' + x.no + ' 1 0;background:#0B0B0C"></i>' : "") +
      (x.yes ? '<i style="flex:' + x.yes + " 1 0;background:" + GREEN + '"></i>' : "") +
      "</span></div>"
    ).join("") + "</div>" +
      '<div class="axis">' + ws.map((x) => "<span>W" + wkNo(x) + "</span>").join("") + "</div>";
    if (!box.dataset.bound) {
      box.dataset.bound = "1";
      bindDomTip(box, (i) => {
        const x = (state.loop?.weeks || [])[i];
        if (!x) return null;
        const prev = (state.loop?.weeks || [])[i - 1];
        const delta = prev && x.rate !== null && prev.rate !== null ? changeText(x.rate, prev.rate, "pp") : "";
        return {
          title: "第 " + wkNo(x) + " 周 · 适用 " + x.applicable + " 场",
          rows: [
            { name: "是", value: x.yes + " 场", color: GREEN },
            { name: "否", value: x.no + " 场", color: INK },
            { name: "待定", value: x.pending + " 场", color: HATCH },
          ],
          foot: { name: x.pending ? "闭环率（下限）" : "闭环率", value: rateText(x.rate) + "%", delta },
          notes: [x.unsettled ? "待定占比 " + x.pendingRate + "%，读数还会往上走" : ""],
        };
      });
    }
  }
  const un = ws.filter((x) => x.unsettled).map((x) => "W" + wkNo(x));
  $("hintLoopWeek").textContent = "柱顶为闭环率；" + (un.length ? "虚线框的周待定超过 30%，读数还会往上走" : "各周结果均已定");

  // 按业务分型：每行一根 是 / 否 / 待定 胶囊（按本分型的适用场次归一）+ 闭环率 + 场次
  const types = loop.types || [];
  const tbox = $("loopTypes");
  if (tbox) {
    tbox.innerHTML = types.length ? types.map((x) => {
      const n = x.yes + x.no + x.pending;
      return '<div class="loop-type' + (x.small ? " small" : "") + '"><span>' + escHtml(x.type) + (x.small ? "（样本少）" : "") + "</span>" +
        '<span class="stack">' +
        (x.yes ? '<i style="flex:' + x.yes + " 1 0;background:" + (x.small ? "#C9C8CD" : GREEN) + '"></i>' : "") +
        (x.no ? '<i style="flex:' + x.no + " 1 0;background:" + (x.small ? "#8D8C93" : INK) + '"></i>' : "") +
        (x.pending ? '<i style="flex:' + x.pending + " 1 0;background:" + HATCH + '"></i>' : "") +
        (n ? "" : '<i style="flex:1 1 0;background:#F1F0F3"></i>') +
        "</span><b>" + rateText(x.rate) + (x.rate === null ? "" : "%") + "</b><span>" + fmtNum(x.sessions) + "</span></div>";
    }).join("") : '<p class="chart-foot">暂无带业务分型的适用会话</p>';
  }
  const small = types.filter((x) => x.small);
  const rangeText = ws.length ? "第 " + wkNo(ws[0]) + " – " + wkNo(ws.at(-1)) + " 周" : "";
  const th = $("loopTypeTitle");
  if (th) th.textContent = "按业务分型" + (rangeText ? " · " + rangeText + "累计" : "");
  $("hintLoopType").textContent = (small.length ? "灰色为场次不足 10 的分型，仅作参考 · " : "") + "待定多的分型，闭环率是偏低的下限";
  const desc = $("pageDesc");
  if (desc && state.tab === "loop") desc.textContent = "咨询后 7 天内，用户的对口表单有没有真正收到数据" + (rangeText ? " · " + rangeText : "");
}

// ============== 周报 ==============

const DOW_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// [0,1,2,3] → 周一~周四；不连续则逐个列出
function sceneCount(pairs, scene) {
  const hit = (pairs || []).find((p) => p[0] === scene);
  return hit ? hit[1] : 0;
}

function dowLabel(dows) {
  if (!dows || !dows.length) return "同期";
  const names = dows.map((d) => DOW_CN[d] || "?");
  const contiguous = dows.every((d, k) => k === 0 || d === dows[k - 1] + 1);
  if (dows.length === 7) return "整周";
  return contiguous && dows.length > 1 ? names[0] + "~" + names[names.length - 1] : names.join("、");
}

function weekLabel(w) {
  return "第 " + Number(w.slice(5)) + " 周（" + w + "）";
}

// 颜色只看方向：涨＝红（up），跌＝绿（down）。不按「指标变好变坏」上色 ——
// 有些指标越小越好（时长、人工占比），但配色跟着语义翻转会让人读不准涨跌。
// 2026-10 改版：涨＝绿、跌＝黑、持平＝浅灰，只看方向不看好坏；箭头比正负号更容易一眼读出方向
function delta(cur, prev, unit) {
  if (prev === null || prev === undefined || prev === 0) return "";
  return ppPill(cur - prev, unit);
}

// 在胶囊文字前加前缀（原型：「环比 ▲ 2.7pp」整个在胶囊里）
function labelPill(html, prefix) {
  return html ? html.replace('">', '">' + prefix + " ") : "";
}

function ppPill(d, unit) {
  if (d === null || d === undefined || !isFinite(d)) return "";
  if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
  return '<span class="dl ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "▲ " : "▼ ") + Math.abs(Number(d.toFixed(1))) + (unit || "") + "</span>";
}

// 人工服务页的累计表也要用周报数据：并发调用共用同一个请求
let weeklyPromise = null;
function loadWeekly() {
  if (!weeklyPromise) weeklyPromise = fetchWeekly().finally(() => { if (!state.weeklyLoaded) weeklyPromise = null; });
  return weeklyPromise;
}

async function fetchWeekly() {
  try {
    const json = await api("/api/weekly");
    if (!json.success) throw new Error(json.error || "未知错误");
    if (json.building) {
      $("wkHint").textContent = buildingText(json.meta);
      return;
    }
    state.weeks = json.weeks || [];
    state.weeklyLoaded = true;
    if (!state.weeks.length) {
      $("wkHint").textContent = "暂无可展示的周报数据。";
      document.querySelectorAll("#panel-weekly .report-block").forEach((block) => { block.hidden = true; });
      return;
    }
    document.querySelectorAll("#panel-weekly .report-block").forEach((block) => { block.hidden = false; });

    const sel = $("wkSelect");
    sel.innerHTML = state.weeks.slice().reverse().map((w) =>
      '<option value="' + w.week + '">' + weekLabel(w.week) +
      (w.dayCount < 7 ? "（不完整）" : "") + "</option>"
    ).join("");
    // 默认本周：weeks 里只有有数据的周，所以最后一项就是本周；
    // 本周还没数据时最后一项自然是上周
    sel.value = state.weeks[state.weeks.length - 1].week;
    sel.addEventListener("change", () => swapIn($("panel-weekly"), () => renderWeekly(sel.value)));
    renderWeekly(sel.value);
  } catch (err) {
    $("wkHint").textContent = "周报加载失败：" + err.message;
  }
}

function renderWeekly(week) {
  const i = state.weeks.findIndex((w) => w.week === week);
  if (i < 0) return;
  const w = state.weeks[i];
  const p = i > 0 ? state.weeks[i - 1] : null;

  const hintText = w.firstDay + " ~ " + w.lastDay + "（" + w.dayCount + " 天）" +
    (w.dayCount < 7 ? " · 本周数据尚不完整" : "") +
    (p ? " · 对比第 " + Number(p.week.slice(5)) + " 周" : "");
  $("wkHint").textContent = "";
  if (state.tab === "weekly") {
    $("pageTitle").textContent = "周报 · 第 " + Number(w.week.slice(5)) + " 周";
    $("pageDesc").textContent = hintText;
    document.title = "周报 · 第 " + Number(w.week.slice(5)) + " 周 · hive 服务看板";
  }

  // 一、目标追踪：主目标（操作引导类人工时长占比）+ 按 Jiri 能否解答拆分 + 五个必须真人场景的单次中位数
  const g = w.goals;
  const pg = p ? p.goals : null;
  const okPill = (ok) => '<span class="pill ' + (ok ? "good" : "bad") + '">' + (ok ? "达成" : "未达成") + "</span>";
  const SPLIT_COLOR = { "能": GREEN, "部分": "#8D8C93", "不能": INK, "未标记": HATCH };
  // 排序固定：能 → 部分 → 不能 → 未质检，「不能」和「未质检」在最右
  const SPLIT_ORDER = ["能", "部分", "不能", "未标记"];
  const split = (g.guideSplit || []).filter((x) => x.sessions > 0 || x.pp > 0)
    .sort((x, y) => SPLIT_ORDER.indexOf(x.label) - SPLIT_ORDER.indexOf(y.label));
  // 刻度 0 ~ 2 倍目标：目标线正好落在中点
  const scaleMax = g.guideTarget * 2;
  const fillPct = Math.min(100, (g.guideShare / scaleMax) * 100);
  const splitCols = split.map((x) => {
    const prev = pg && pg.guideSplit ? pg.guideSplit.find((y) => y.label === x.label) : null;
    return '<div><span class="lbl"><i style="background:' + SPLIT_COLOR[x.label] + '"></i>' + (x.label === "未标记" ? "未质检" : x.label + "解答") + "</span>" +
      "<b>" + x.exact + "%</b><span>" + (prev ? labelPill(delta(x.exact, prev.exact, "pp"), "环比") : "") + "</span>" +
      "<small>" + x.sessions + " 场 · " + x.durMin + " 分钟</small></div>";
  }).join("");
  const must = g.mustHuman.map((m, k) => {
    const prev = pg ? pg.mustHuman[k] : null;
    const ok = m.value !== null && m.value <= m.target;
    const ratio = m.raw === null ? 0 : Math.min(100, (m.raw / (m.target * 2)) * 100);
    return '<div class="must-card"><div class="must-card-head"><b>' + escHtml(m.label) + "</b>" + (m.raw === null ? '<span class="pill">无接待</span>' : okPill(ok)) + "</div>" +
      '<span class="scene">' + escHtml(m.scene) + "</span>" +
      '<div class="val"><b>' + (m.raw === null ? "—" : Number(m.raw).toFixed(1)) + "</b><span>分 · 目标 ≤ " + m.target + "</span></div>" +
      '<div class="meter"><i style="width:' + ratio.toFixed(1) + "%;background:" + (ok ? GREEN : INK) + '"></i><s></s></div>' +
      '<div class="foot"><span>' + (m.receptions ? m.receptions + " 次接待" : "本周无接待") + "</span>" +
      (prev && prev.raw !== null && m.raw !== null ? delta(m.raw, prev.raw, " 分") : "") + "</div></div>";
  }).join("");
  $("wkGoals").innerHTML =
    '<div class="goal-hero"><div class="goal-main"><span>操作引导类人工时长占比</span>' +
    "<b>" + g.guideShare + "<small>%</small></b>" +
    '<div class="goal-meta"><span>目标 ≤ ' + g.guideTarget + "%</span>" + okPill(g.guideShare <= g.guideTarget) +
    (pg ? labelPill(delta(g.guideShare, pg.guideShare, "pp"), "环比") : "") + "</div></div>" +
    '<div class="goal-divider" aria-hidden="true"></div>' +
    '<div class="goal-split"><span>按 Jiri 能否解答拆分</span>' +
    '<div class="goal-track"><span class="target-label" style="left:50%">目标 ' + g.guideTarget + "%</span>" +
    '<div class="rail"><div class="fill" style="width:' + fillPct.toFixed(1) + '%">' +
    split.map((x) => '<i style="flex:' + Math.max(0.0001, Number(x.exact)) + " 1 0;background:" + SPLIT_COLOR[x.label] + '"></i>').join("") +
    '</div><span class="tick" style="left:50%"></span></div>' +
    '<div class="scale"><span>0%</span><span>' + scaleMax + "%</span></div></div>" +
    '<div class="goal-cols">' + splitCols + "</div></div></div>" +
    '<div class="goal-sub-title">必须真人场景 · 单次接待时长中位数</div>' +
    '<div class="must-cards">' + must + "</div>";

  // 二、JIRI（AI）接待现状：本周 / 上周同期（相同星期对齐）
  const j = w.jiri;
  const pj = w.compare ? w.compare.prev.jiri : null;
  const jscope = w.compare ? dowLabel(w.compare.dows) : "";
  if (j) {
    // 2026-10-13 改：不再用句子表，改成和 03 / 04 同款的数字表：指标 / 本周 / 占比 / 环比 / 上周同期
    const rate = (n, d) => (d ? (n / d) * 100 : 0);
    const jr = (label, n, d, pn, pd, sub) => {
      const cur = rate(n, d);
      const prev = pj ? rate(pn, pd) : null;
      return "<tr><td>" + label + (sub ? '<span class="cell-sub">' + sub + "</span>" : "") + '</td><td class="num strong">' + fmtNum(n) + '</td><td class="num">' + cur.toFixed(1) + "%</td>" +
        '<td class="num">' + (prev === null ? "—" : ppPill(cur - prev, "pp")) + '</td><td class="num dim-cell">' + (pj ? fmtNum(pn) + " / " + prev.toFixed(1) + "%" : "—") + "</td></tr>";
    };
    const P = pj || {};
    $("tblJiri").innerHTML =
      '<thead><tr><th>指标</th><th class="num">本周</th><th class="num">占比</th><th class="num">环比</th><th class="num">上周同期' + (jscope ? "（" + jscope + "）" : "") + "</th></tr></thead><tbody>" +
      jr("单轮", j.one, j.base, P.one, P.base) +
      jr("2 轮", j.two, j.base, P.two, P.base) +
      jr("深度咨询（≥3 轮）", j.deep, j.base, P.deep, P.base, "中位 " + j.deepMedian + " 轮" + (pj ? "（上周 " + pj.deepMedian + " 轮）" : "")) +
      jr("复问", j.repeat, j.total, P.repeat, P.total, "同一用户 6～36 小时内再问同一件事") +
      jr("填表人（AI 侧）", j.fillerAI, j.total, P.fillerAI, P.total, "含人工侧共 " + fmtNum(j.fillerAll) + " / " + rate(j.fillerAll, j.total).toFixed(1) + "%") +
      jr("人工会话中客服 @jiri", j.atJiri, j.manual, P.atJiri, P.manual) +
      "</tbody>";
    const hint = $("jiriHint");
    if (hint) hint.textContent = "轮次三行的分母 = 仅 Jiri 且有效 " + fmtNum(j.base) + " 场（另有 " + j.zero + " 场用户没说话、只有 Jiri 单方回复" +
      (j.unlabeled ? "，" + j.unlabeled + " 场还没算轮次" : "") + "）；复问、填表人的分母 = 剔内测的全部会话 " + fmtNum(j.total) + "；@jiri 的分母 = 剔内测的全部仅人工 " + fmtNum(j.manual) + "。";
    $("jiriNote").innerHTML =
      '<span class="dim-note">口径：用户轮次 = 客户说话的条数；复问 = 同一用户隔 6～36 小时再进线且一句话总结相似（质检表「复问」列）；@jiri 只算客服侧。上周同期按相同星期对齐。</span>';
  }

  // 三、周度接待概览：只看到所选周为止的最近 5 周，底部附同期对齐的环比
  const recent = state.weeks.slice(Math.max(0, i - 4), i + 1);
  const cmp = w.compare;
  const scope = cmp ? dowLabel(cmp.dows) : "";
  const num = (v) => '<td class="num">' + v + "</td>";
  // 单个百分比药丸
  const pct1 = (cur, prev) => {
    if (prev === null || prev === undefined || prev === 0) return '<span class="dl flat">—</span>';
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.05) return '<span class="dl flat">持平</span>';
    return '<span class="dl ' + (d > 0 ? "up" : "down") + '">' + (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "%</span>";
  };
  const ratio = (cur, prev) => num(pct1(cur, prev));
  // 环比与同比合并成一格，省掉两行同期原始值
  const dual = (cur, prev, yoy) =>
    '<td class="num dual">' +
    '<span class="dl-row"><i>环</i>' + pct1(cur, prev) + "</span>" +
    (yoy === null || yoy === undefined ? "" :
      '<span class="dl-row"><i>同</i>' + pct1(cur, yoy) + "</span>") +
    "</td>";

  let html =
    '<thead><tr><th>周</th><th class="num">会话总量</th><th class="num">对话人数</th><th class="num">人均会话</th>' +
    '<th class="num">AI 独立接待 / 独立率</th><th class="num">人工在线 / 占比</th><th class="num">填表人</th><th class="num">有效会话</th></tr></thead><tbody>' +
    recent.slice().reverse().map((x) =>
      "<tr" + (x.week === week ? ' class="hl"' : "") + "><td>第 " + Number(x.week.slice(5)) + " 周</td>" +
      num(x.total) + num(x.users) + num(x.perUser) +
      num(x.aiOnly + " / " + x.aiRate + "%") +
      num(x.manualOnline + " / " + x.manualRate + "%") +
      num(x.formFillers) + num(x.productSessions) + "</tr>"
    ).join("");

  if (cmp) {
    const p2 = cmp.prev;
    const y2 = cmp.yoy || null;
    const yNo = cmp.yoyWeek ? Number(cmp.yoyWeek.slice(5)) : null;
    const g = (k) => (y2 ? y2[k] : null);
    html +=
      '<tr class="sum"><td>环比 / 同比<span class="cmp-note">环＝上周同期（' + scope + "）" +
      (yNo ? " · 同＝第 " + yNo + " 周同期" : "") + "</span></td>" +
      dual(w.total, p2.total, g("total")) +
      dual(w.users, p2.users, g("users")) +
      dual(w.perUser, p2.perUser, g("perUser")) +
      dual(w.aiRate, p2.aiRate, g("aiRate")) +
      dual(w.manualRate, p2.manualRate, g("manualRate")) +
      dual(w.formFillers, p2.formFillers, g("formFillers")) +
      dual(w.productSessions, p2.productSessions, g("productSessions")) + "</tr>";
  }
  $("tblOverview").innerHTML = html + "</tbody>";

  // 四、人工接待现状：每个口径都给本周 / 上周同期 / 环比 / 4 周前同期 / 同比
  const d1 = (v) => Number(v).toFixed(1);
  const yoyNo = cmp && cmp.yoyWeek ? Number(cmp.yoyWeek.slice(5)) : null;

  const statCells = (g) =>
    num(g.receptions) + num(d1(g.durHours) + " h") + num(d1(g.medianMin) + " 分") +
    num(d1(g.avgMin) + " 分") + num(g.sessions) + num(g.users);

  // 2026-10-13 用户定：04 表不单起「环比 / 同比」行，胶囊直接放在数值右侧（环上同下）
  const KEYS = ["receptions", "durHours", "medianMin", "avgMin", "sessions", "users"];
  const FMT = { receptions: (v) => v, durHours: (v) => d1(v) + " h", medianMin: (v) => d1(v) + " 分", avgMin: (v) => d1(v) + " 分", sessions: (v) => v, users: (v) => v };
  const groupRows = (label, key) => {
    const a = w[key];
    const b = cmp ? cmp.prev[key] : null;
    const c = cmp && cmp.yoy ? cmp.yoy[key] : null;
    // 数值单独一列（和表头右对齐），胶囊另起一列挂在右边（环上同下）
    return "<tr><td><b>" + label + "</b></td>" + KEYS.map((k) =>
      '<td class="num">' + FMT[k](a[k]) + "</td>" +
      '<td class="cmpcol">' + (b ? '<span class="cmp"><span class="dl-row"><i>环</i>' + pct1(a[k], b[k]) + "</span>" +
        (c ? '<span class="dl-row"><i>同</i>' + pct1(a[k], c[k]) + "</span>" : "") + "</span>" : "") + "</td>").join("") + "</tr>";
  };
  const groupRowsWithCompare = (label, key) => {
    let out = "<tr><td><b>" + label + "</b></td>" + statCells(w[key]) + "</tr>";
    if (!cmp) return out;
    const a = w[key];
    const b = cmp.prev[key];
    const c = cmp.yoy ? cmp.yoy[key] : null;
    const g = (k) => (c ? c[k] : null);
    out += '<tr class="sum"><td>' + label + " · 环比 / 同比" +
      '<span class="cmp-note">环＝上周同期（' + scope + "）" +
      (yoyNo ? " · 同＝第 " + yoyNo + " 周同期" : "") + "</span></td>" +
      dual(a.receptions, b.receptions, g("receptions")) +
      dual(a.durHours, b.durHours, g("durHours")) +
      dual(a.medianMin, b.medianMin, g("medianMin")) +
      dual(a.avgMin, b.avgMin, g("avgMin")) +
      dual(a.sessions, b.sessions, g("sessions")) +
      dual(a.users, b.users, g("users")) + "</tr>";
    return out;
  };

  const cmpTh = '<th class="cmpcol"></th>';
  $("tblManual").innerHTML =
    '<colgroup><col style="width:17%">' + KEYS.map(() => "<col><col style=\"width:92px\">").join("") + "</colgroup>" +
    '<thead><tr><th>口径</th><th class="num">接待次数</th>' + cmpTh + '<th class="num">总工时</th>' + cmpTh +
    '<th class="num">单次中位</th>' + cmpTh + '<th class="num">单次平均</th>' + cmpTh + '<th class="num">会话数</th>' + cmpTh +
    '<th class="num">去重用户</th>' + cmpTh + "</tr></thead><tbody>" +
    groupRows("有效人工", "eff") + groupRows("全部仅人工", "allManual") + "</tbody>";

  const prevEff = cmp ? cmp.prev.eff : null;
  $("manualSummary").innerHTML =
    "有效人工 <b>" + w.eff.sessions + "</b> 场会话（去重用户 " + w.eff.users + " 人）/ <b>" +
    w.eff.receptions + "</b> 次接待，总工时 <b>" + w.eff.durHours + " h</b>" +
    (prevEff ? "（上周同期 " + prevEff.durHours + " h，" +
      (w.eff.durHours >= prevEff.durHours ? "+" : "") +
      Number((w.eff.durHours - prevEff.durHours).toFixed(1)) + " h）" : "") + "。<br>" +
    "不愿和 Jiri 沟通率 <b>" + w.directTransfer + " / " + w.eff.sessions + " = " + w.directRate + "%</b>" +
    (cmp ? "（上周同期 " + cmp.prev.directTransfer + " / " + cmp.prev.eff.sessions + "）" : "") +
    " —— 有效人工里「直接转」的场次占比。";
  $("manualNote").innerHTML =
    '<span class="dim-note">口径：有效人工 = 处理状态「仅人工」且会话性质「有效」；接待次数取「转人工会话接待次数」' +
    '（表单里「人工接待次数」两个字段全为空）；单次中位 = 每场「时长 ÷ 接待次数」的中位数。' +
    '环比对比上周同期，同比对比 4 周前同期，都按相同星期对齐。</span>';

  // 五、有效人工场景 × 工作量（2026-09-18 起把「秒转·可解答」三列并进来，同口径同单位：接待次数）
  const sceneVal = (src, scene, field) => {
    const hit = src && src.scenes ? src.scenes[scene] : null;
    return hit ? hit[field] : null;
  };
  const st = w.secondTransfer || { total: 0, base: 0, scenes: [] };
  const pst = cmp ? (cmp.prev.secondTransfer || null) : null;
  const stOf = (src, scene) => (src ? (src.scenes || []).find((x) => x.scene === scene) : null);
  const stCells = (scene) => {
    const cur = stOf(st, scene);
    const prev = stOf(pst, scene);
    if (!cur) return num("—") + num("—") + num("—");
    return '<td class="num strong">' + cur.hit + "</td>" + num(cur.rate + "%") +
      '<td class="num">' + (prev ? ppPill(cur.rate - prev.rate, "") : '<span class="dl flat">新</span>') + "</td>";
  };
  const shareMax = Math.max(...w.scenes.map((x) => Number(x.share) || 0), 1);
  const stRate = st.base ? Number(((st.total / st.base) * 100).toFixed(1)) : 0;
  const pstRate = pst && pst.base ? Number(((pst.total / pst.base) * 100).toFixed(1)) : null;
  $("tblScenes").innerHTML =
    '<colgroup><col style="width:15%"><col><col><col style="width:15%"><col><col><col><col><col><col><col></colgroup>' +
    '<thead><tr><th>场景</th><th class="num">接待次数</th><th class="num">总时长（分）</th>' +
    '<th class="num">占总时长</th><th class="num">单次中位</th><th class="num">单次平均</th>' +
    '<th class="num">时长环比（%）</th><th class="num">时长同比（%）</th>' +
    '<th class="num">秒转·可解答</th><th class="num">占比</th><th class="num">占比环比（百分点）</th></tr></thead><tbody>' +
    w.scenes.map((x) => {
      const isGuide = x.scene === "操作引导/功能咨询";
      return "<tr" + (isGuide ? ' class="warn-row"' : "") + "><td>" + escHtml(x.scene) + (isGuide ? '<span class="cell-sub">目标：占总时长 ≤ 10%</span>' : "") + "</td>" +
        num(x.receptions) + num(x.durMin) +
        '<td class="num strong"><span class="cbar"><i><b style="width:' + ((Number(x.share) / shareMax) * 100).toFixed(1) + "%;background:" + (isGuide ? INK : "#8D8C93") + '"></b></i><span>' + x.share + "%</span></span></td>" +
        num(Number(x.medianMin).toFixed(1)) + num(Number(x.avgMin).toFixed(1)) +
        (cmp ? ratio(x.durMin, sceneVal(cmp.prev, x.scene, "durMin")) : num("—")) +
        (cmp && cmp.yoy ? ratio(x.durMin, sceneVal(cmp.yoy, x.scene, "durMin")) : num("—")) +
        stCells(x.scene) + "</tr>";
    }).join("") +
    '<tr class="sum"><td>合计</td>' + num(w.eff.receptions) + num(w.eff.durMin) +
    num("100%") + num(Number(w.eff.medianMin).toFixed(1)) + num(Number(w.eff.avgMin).toFixed(1)) +
    (cmp ? ratio(w.eff.durMin, cmp.prev.eff.durMin) : num("—")) +
    (cmp && cmp.yoy ? ratio(w.eff.durMin, cmp.yoy.eff.durMin) : num("—")) +
    '<td class="num strong">' + st.total + "</td>" + num(stRate + "%") +
    '<td class="num">' + (pstRate === null ? "—" : ppPill(stRate - pstRate, "")) + "</td></tr></tbody>";

  // 六、仅 Jiri 有效场景
  const jsMax = Math.max(...w.jiriScenes.map((x) => x[1]), 1);
  $("tblJiriScenes").innerHTML =
    '<thead><tr><th>场景</th><th class="num">场次</th><th class="num">占比</th>' +
    '<th class="num">环比</th><th class="num">同比</th></tr></thead><tbody>' +
    w.jiriScenes.map((x) =>
      "<tr><td>" + escHtml(x[0]) + '</td><td class="num strong">' + x[1] + "</td>" +
      '<td class="num"><span class="cbar wide"><i><b style="width:' + ((x[1] / jsMax) * 100).toFixed(1) + "%;background:" + GREEN + '"></b></i><span>' + (w.jiriSceneTotal ? ((x[1] / w.jiriSceneTotal) * 100).toFixed(1) : 0) + "%</span></span></td>" +
      (cmp ? ratio(x[1], (cmp.prev.jiriScenes || {})[x[0]] || 0) : num("—")) +
      (cmp && cmp.yoy ? ratio(x[1], (cmp.yoy.jiriScenes || {})[x[0]] || 0) : num("—")) + "</tr>"
    ).join("") +
    '<tr class="sum"><td>合计</td>' + num(w.jiriSceneTotal) + num("100%") +
    (cmp ? ratio(w.jiriSceneTotal, cmp.prev.jiriSceneTotal) : num("—")) +
    (cmp && cmp.yoy ? ratio(w.jiriSceneTotal, cmp.yoy.jiriSceneTotal) : num("—")) + "</tr></tbody>";

  // 七、客服接待评估：跟随上方「统计周」
  renderAgents(w);
  const wkLabel = "第 " + Number(w.week.slice(5)) + " 周（" + w.firstDay + " ~ " + w.lastDay + "）";
  $("agentHint").textContent = "只看仅人工 · " + wkLabel + (w.dayCount < 7 ? " · 本周尚不完整" : "");
  renderAgentScene("tblAgentSceneWk", null, null, w.agentScene, "");
  renderEmotion("tblEmotionWk", null, null, null, w.emotion, "");
  renderEmoList("tblEmotionNegWk", null, (w.emotion || {}).emoList);
}

// 客服接待评估表：周报 07-A 用本周数据，人工服务页用累计数据（第 27 周起）。口径见 README「客服接待评估」
function agentTable(id, data) {
  const tbl = $(id);
  if (!tbl) return;
  const num = (v) => '<td class="num">' + (v === null || v === undefined ? "—" : v) + "</td>";
  const pctv = (v) => (v === null || v === undefined ? "—" : v + "%");
  const row = (x, cls) =>
    '<tr class="' + (cls || "") + '"><td>' + escHtml(x.name) + "</td>" +
    num(x.visits) + num(x.first) + num(x.direct + " / " + x.firstEff) + num(pctv(x.directRate)) +
    num(x.last) + num(x.repeated) + num(pctv(x.repeatRate)) + "</tr>";
  if (!data || !data.agents.length) {
    tbl.innerHTML = '<tbody><tr><td>没有带客服标注的人工会话</td></tr></tbody>';
    return;
  }
  tbl.innerHTML =
    "<thead><tr><th>客服</th><th class=\"num\">接待人次</th><th class=\"num\">首接场次</th><th class=\"num\">秒转 / 首接有效</th><th class=\"num\">秒转率</th>" +
    "<th class=\"num\">末接场次</th><th class=\"num\">复问</th><th class=\"num\">复问率</th></tr></thead><tbody>" +
    row(data.team, "hl team") + data.agents.map((x) => row(x)).join("") + "</tbody>";
}

function renderAgents(w) {
  agentTable("tblAgents", w.agents);
  const note = $("agentNote");
  if (note) note.innerHTML =
    "口径：只看处理状态「仅人工」。接待人次 = 一场里出现的每位客服各记 1；" +
    "秒转率 = 首接客服的有效人工场次里「直接转」的占比（秒转发生在任何客服接手之前，归首接）；" +
    "复问记到原来接待的人身上：用户在 A 场问了 x、隔 6～36 小时又在 B 场问 x，这 1 场复问算 A 的（末接）客服，不算 B 的；复问率 = 复问 ÷ 末接场次（人工侧相似度阈值 0.15）。" +
    "三人各接一段的会话中间那位只记人次。" +
    "复问记在被复问的那一场所在的周，本周的数会随下周的复问补进来而变。";
}

// ============== 交互 ==============

async function hardRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const btn = $("refreshBtn");
  btn.disabled = true;
  btn.textContent = "拉取中…";
  banner("正在拉取金数据上的新增和改动…", "info");
  try {
    const json = await api("/api/refresh", { method: "POST" });
    if (!json.success) throw new Error(json.error || "未知错误");
    await waitForRefresh(json.requestedAt || "", btn);
  } catch (err) {
    banner("刷新失败：" + err.message);
  } finally {
    state.refreshing = false;
    btn.disabled = false;
    btn.textContent = "重新拉取数据";
  }
}

// 等后台刷新落地（最多 2 分钟）。每秒查一次状态，按后台写的进度更新提示条和按钮；
// 只认「本次点击之后」完成的结果（checkedAt / failedAt ≥ requestedAt），不会把上一次的 ok 当成这次做完。
async function waitForRefresh(requestedAt, btn) {
  const after = (iso) => !requestedAt || (iso && iso >= requestedAt);
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const meta = (await api("/api/status")).meta || {};
      if (meta.status === "ok" && after(meta.checkedAt || meta.updatedAt)) {
        await loadDashboard();
        const 改动 = meta.mode === "full"
          ? "全量拉取 " + fmtNum(meta.total) + " 条" + (meta.fullReason ? "，原因：" + meta.fullReason : "")
          : meta.changed
            ? "拉到 " + fmtNum(meta.changed - (meta.deleted || 0)) + " 条新增或改动" + (meta.deleted ? "，同步删除 " + fmtNum(meta.deleted) + " 条" : "")
            : "金数据上没有新的改动";
        banner("同步完成：" + 改动 + "，用时 " + (meta.tookMs / 1000).toFixed(1) + " 秒。", "info");
        setTimeout(() => { if ($("banner").textContent.startsWith("同步完成")) banner(""); }, 5000);
        return;
      }
      if (meta.status === "error" && after(meta.failedAt)) {
        banner("数据拉取失败：" + (meta.error || "未知错误"));
        return;
      }
      if (meta.status === "running") {
        banner(progressText(meta) + "…", "info");
        const pct = progressPct(meta);
        if (btn) btn.textContent = "拉取中" + (pct ? " " + pct : "…");
      }
    } catch (e) { /* 忽略单次轮询失败 */ }
  }
  banner("拉取仍未完成，请稍后刷新页面查看。", "info");
}

// 侧边栏导航：两组（分析 / 报告）。分析页显示筛选栏，报告页隐藏（报告是固定口径，筛选对它不生效）。
// 当前页写进 URL hash，刷新和分享链接都能直接落到同一页。
const TAB_NAMES = ["overview", "volume", "ai", "service", "business", "weekly", "loop"];

function showTab(name) {
  const tab = TAB_NAMES.includes(name) ? name : "overview";
  state.tab = tab;
  const btn = document.querySelector('.nav-item[data-tab="' + tab + '"]');
  document.querySelectorAll(".nav-item").forEach((t) => {
    t.classList.toggle("active", t === btn);
    if (t === btn) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  });
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab));
  const report = btn && btn.dataset.kind === "report";
  document.body.classList.toggle("is-report", !!report);
  document.body.classList.toggle("is-analysis", !report);
  document.body.classList.toggle("is-weekly", tab === "weekly");
  const label = btn ? btn.querySelector("span").textContent : "";
  $("pageCrumb").textContent = (report ? "报告" : "分析") + " / " + label;
  $("pageTitle").textContent = label;
  $("pageDesc").textContent = btn ? btn.dataset.desc || "" : "";
  document.title = label + " · hive 服务看板";
  hideTip();
  if (tab === "weekly") {
    const panel = $("panel-weekly");
    if (!state.weeklyLoaded) panel.classList.add("pending");
    loadWeekly().then(() => {
      if (state.tab !== "weekly") return;
      if (state.weeklyLoaded && $("wkSelect").value) renderWeekly($("wkSelect").value);
      revealIn(panel);
    });
  } else if (tab === "loop") {
    const panel = $("panel-loop");
    if (!state.loopLoaded) panel.classList.add("pending");
    loadLoop().then(() => {
      if (state.tab !== "loop") return;
      if (state.loopLoaded && state.loop) renderLoop(state.loop);   // 已加载过也重画一次，让柱子重新长出
      revealIn(panel);
    });
  }
  // 隐藏面板里的 canvas 量不出尺寸：切到哪页就在下一帧画哪页。
  // 切页时让这一页的柱线图都重新「长出」一次（清掉形变用的上一帧记录），和其他 DOM 小图的入场保持一致
  else if (state.stats) {
    const panel = $("panel-" + tab);
    if (panel) panel.querySelectorAll(".dc").forEach((d) => { if (d.parentElement) d.parentElement.$dc = null; });
    requestAnimationFrame(() => renderCharts(state.stats));
  }
}

function initTabs() {
  document.querySelectorAll(".nav-item").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (location.hash !== "#" + tab.dataset.tab) history.replaceState(null, "", "#" + tab.dataset.tab);
      showTab(tab.dataset.tab);
      window.scrollTo({ top: 0 });
    });
  });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
  showTab(location.hash.slice(1));
}

// 筛选栏 + 页签吸顶状态：哨兵元素一滚出视口顶端，就给吸顶块加 .stuck（更重的投影）
function initStickyFilter() {
  const bar = $("stickyTop"), sentinel = $("filterSentinel");
  if (!bar || !sentinel || !window.IntersectionObserver) return;
  new IntersectionObserver(([entry]) => {
    bar.classList.toggle("stuck", !entry.isIntersecting && entry.boundingClientRect.top < 0);
  }, { threshold: 0 }).observe(sentinel);
}

function initActions() {
  $("refreshBtn").addEventListener("click", hardRefresh);

  const out = $("logoutBtn");
  if (out) out.addEventListener("click", async () => {
    out.disabled = true;
    out.textContent = "退出中…";
    try { await fetch(BASE + "/api/logout", { method: "POST" }); } catch (e) { /* 忽略 */ }
    // replace + 时间戳：不留历史记录，也绕开缓存
    location.replace(BASE + "/?t=" + Date.now());
  });

  // 维度下拉 + 质检状态：改动即重算
  Object.keys(DIM_SELECTS).forEach((id) => {
    $(id).addEventListener("change", reload);
  });

  // 聚合粒度：纯前端换分桶，不重新请求接口
  initSeg("granRecept", receptGrain, (g) => { receptGrain = g; if (LAST_STATS) drawReceptChart(LAST_STATS); });
  initLens();
  initHoverGlass();
  initSeg("granDist", distGrain, (g) => { distGrain = g; if (LAST_STATS) drawVolumeDist(fixedStats(LAST_STATS)); });
  initSeg("granUniq", uniqGrain, (g) => { uniqGrain = g; if (LAST_STATS) drawVolumeUniq(fixedStats(LAST_STATS)); });

  // 情绪会话明细：负向 / 正向页签
  const emoTabs = $("emoTabs");
  if (emoTabs) emoTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || !LAST_STATS) return;
    state.emoTab = button.dataset.mode === "pos" ? "pos" : "neg";
    renderEmoDetail((LAST_STATS.emotion || {}).emoList);
  });

  // 总览「来源详情 →」直接切到接待量页
  const devLink = $("devLink");
  if (devLink) devLink.addEventListener("click", (event) => { event.preventDefault(); location.hash = "#volume"; });

  // 周报「导出」：走浏览器打印（可存成 PDF），打印样式只留当前页
  const exportBtn = $("exportBtn");
  if (exportBtn) exportBtn.addEventListener("click", () => window.print());

  const more = $("repeatsMore");
  if (more) more.addEventListener("click", () => { state.repeatsAll = !state.repeatsAll; if (LAST_STATS) renderRepeatsTable(LAST_STATS); });

  // 周报口径说明默认收起：表格本身信息已全，说明只在需要时展开
  const notes = $("notesToggle");
  if (notes) notes.addEventListener("click", () => {
    const on = !document.body.classList.contains("show-kou");
    document.body.classList.toggle("show-kou", on);
    notes.setAttribute("aria-pressed", String(on));
    notes.textContent = on ? "隐藏口径说明" : "显示口径说明";
  });

  $("fRange").addEventListener("change", () => { applyRangePreset(); reload(); });
  $("fFrom").addEventListener("change", reload);
  $("fTo").addEventListener("change", reload);

  $("resetBtn").addEventListener("click", () => {
    ["fRange", ...Object.keys(DIM_SELECTS)].forEach((id) => { $(id).value = ""; });
    applyRangePreset();
    reload();
  });

  applyRangePreset();
}

const T0 = performance.now();

renderSkeleton();
initActions();
initMenu();
initStickyFilter();
initTabs();

loadDashboard().then(() => {
  try {
    // 把首屏耗时写在页脚，方便定位慢在网络还是接口
    const parts = ["数据 " + Math.round(performance.now() - T0) + " ms"];
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) parts.push("页面 " + Math.round(nav.responseEnd - nav.startTime) + " ms");
    const f = document.querySelector(".footer p");
    if (f) f.textContent = "Powered by WDL · " + parts.join(" · ");
  } catch (e) { /* 统计失败不影响看板 */ }
});
