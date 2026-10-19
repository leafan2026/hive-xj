// 仪表盘图表工具包 v2.2（配套 dashboard-kit.css）。v2.1 加入动效：弹簧长出 / 形变、悬停卡弹簧跟随、数字滚动、报告页入场；
// v2.2 加入液态玻璃（浮层材质 + Chromium 边缘折射）和 Apple 式悬停（格子 Lift、行 / 列 Highlight），页面里调一次 initHoverGlass()。从 hive 服务看板提炼，无任何第三方依赖，不用 Chart.js。
// 在页面里引入一次；所有柱线图用 domChart()，并列双柱用 pairChart()，悬停卡统一走 bindDomTip()。

// ============== 颜色 ==============
const INK = "#0B0B0C";
const GREEN = "#75FB90";
const GRAYS = ["#0B0B0C", "#55545A", "#8D8C93", "#AAA9AB", "#C9C8CD", "#DBDADD", "#E9E8EC"];   // 深 → 浅
const BAR_DARK = "#4A494F";   // 双泳道图的柱色
const HATCH = "repeating-linear-gradient(135deg, #AAA9AB 0 2px, #F1F0F3 2px 5px)";   // 待定 / 未质检

// 分类 → 固定颜色；没登记的分类按顺序拿灰阶。同一个值在任何图里永远同一个颜色。
function colorFor(map, key, i) { return map[key] || GRAYS[(i + 2) % GRAYS.length]; }

// ============== 工具 ==============
function $(id) { return document.getElementById(id); }
function escHtml(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtNum(v) {   // 千分位，不缩写成 K；小数 < 10 保留 2 位，否则 1 位
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toFixed(n < 10 ? 2 : 1);
}
function pct(n, d, digits) { return d ? ((n / d) * 100).toFixed(digits ?? 1) : "0"; }
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
const SPRING_SNAP = (t) => springAt(t, 0.86, 7);   // 回弹 0.5%：数据变化时的形变
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
const STAGGER_SEL = ".spark i, .col .bar, .col .seg-stack, .rb-col i, .busy-bars > i, .units i, .pair-col i, .pair-one i, .track > i, .tr i, .cbar i b, .heat-row > i, .heat-table td, .hm-row > *, .fill i";
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

function niceMax(v) {   // 1 / 2 / 2.5 / 5 / 10 × 10^n 的整刻度上限
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// 涨跌文字：计数看相对变化（%），比率传 kind="pp" 看差值；返回 "▲ 4.2%" / "▼ 1.5pp" / "持平" / ""
function changeText(cur, prev, kind) {
  if (prev === null || prev === undefined || !isFinite(prev) || !isFinite(cur)) return "";
  if (kind === "pp") { const d = cur - prev; return Math.abs(d) < 0.05 ? "持平" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "pp"; }
  if (!prev) return "";
  const d = ((cur - prev) / prev) * 100;
  return Math.abs(d) < 0.05 ? "持平" : (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "%";
}
function deltaClass(text) { return /▲|^\+/.test(text) ? "up" : /▼|^-/.test(text) ? "down" : "flat"; }
function pillHtml(text) { return text ? '<span class="dl ' + deltaClass(text) + '">' + escHtml(text) + "</span>" : ""; }

// ============== 液态玻璃（2026-10-19，v2.2） ==============
// 只用在浮在内容上的控件：图表悬停卡（深色玻璃）、吸顶筛选栏、手机顶栏和抽屉、悬停托板。卡片本身仍然实心、无阴影。
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
const HOVER_CELL_SEL = ".heat-row > i, .heat-table tbody td:not(:first-child):not(.total)";
const HOVER_COL_SEL = ".dc-col, .pair-col";
// 普通数据表（周报 / 客服评估 / 明细等）：整行
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

// ============== 悬停提示卡：深色液态玻璃 ==============
function tipEl() {
  let el = document.getElementById("glass-tooltip");
  if (!el) { el = document.createElement("div"); el.id = "glass-tooltip"; el.className = "chart-glass-tooltip"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  return el;
}
// rows: [{ name, value, color, line }]；foot: { name, value, delta }；notes: [string]
function paintTip(title, rows, foot, notes) {
  const el = tipEl();
  el.replaceChildren();
  if (title) { const t = document.createElement("div"); t.className = "chart-glass-tooltip-title"; t.textContent = title; el.appendChild(t); }
  (rows || []).forEach((r) => {
    const row = document.createElement("div"); row.className = "chart-glass-tooltip-row";
    const m = document.createElement("span"); m.className = "chart-glass-tooltip-marker" + (r.line ? " is-line" : "");
    if (String(r.color).startsWith("repeating")) m.style.background = r.color; else m.style.backgroundColor = r.color;
    const name = document.createElement("span"); name.textContent = r.name;
    const val = document.createElement("b"); val.textContent = r.value;
    row.append(m, name, val); el.appendChild(row);
  });
  if (foot) {
    const f = document.createElement("div"); f.className = "chart-glass-tooltip-foot";
    const name = document.createElement("span"); name.textContent = foot.name; f.appendChild(name);
    if (foot.delta) { const d = document.createElement("span"); d.className = "dl " + deltaClass(foot.delta); d.textContent = foot.delta; f.appendChild(d); }
    const v = document.createElement("b"); v.textContent = foot.value; f.appendChild(v);
    el.appendChild(f);
  }
  (notes || []).filter(Boolean).forEach((text) => { const n = document.createElement("div"); n.className = "chart-glass-tooltip-note"; n.textContent = text; el.appendChild(n); });
  return el;
}
// 锚在列旁边；越过视口中线翻到左侧。显示中换位置走弹簧过渡（CSS）；从隐藏到出现先瞬移到位（.jump）再淡入，不会从上次的位置飞过来
function placeTip(el, x, y) {
  const w = el.offsetWidth, h = el.offsetHeight;
  glassify(el, { radius: 14, bezel: 14, scale: 26, tail: "blur(10px) saturate(170%)" });
  let left = x > window.innerWidth / 2 ? x - w - 14 : x + 14;
  left = Math.min(Math.max(12, left), window.innerWidth - w - 12);
  let top = y - h / 2;
  top = Math.min(Math.max(12, top), window.innerHeight - h - 12);
  if (!el.classList.contains("visible")) {
    el.classList.add("jump"); el.style.left = left + "px"; el.style.top = top + "px";
    void el.offsetWidth; el.classList.remove("jump"); el.classList.add("visible");
  } else { el.style.left = left + "px"; el.style.top = top + "px"; }
}
function hideTip() { const el = document.getElementById("glass-tooltip"); if (el) el.classList.remove("visible"); }
// 容器里带 data-tip="i" 的元素悬停时调 describe(i) → { title, rows, foot, notes }；返回 null 则不显示
function bindDomTip(container, describe) {
  container.addEventListener("mousemove", (event) => {
    const col = event.target.closest("[data-tip]");
    if (!col || !container.contains(col)) { hideTip(); return; }
    const spec = describe(Number(col.dataset.tip), col);
    if (!spec) { hideTip(); return; }
    const el = paintTip(spec.title, spec.rows, spec.foot, spec.notes);
    const box = col.getBoundingClientRect();
    placeTip(el, box.left + box.width / 2, Math.max(box.top + 60, event.clientY));
  });
  container.addEventListener("mouseleave", hideTip);
}

// ============== 柱线图 ==============

// 单调三次插值（Fritsch–Carlson）：曲线不会在两个点之间冲过头，一串 0 旁边不会凹到 0 以下
function smoothPath(pts) {
  const n = pts.length;
  if (!n) return "";
  if (n === 1) return "M" + (pts[0][0] - 30).toFixed(1) + " " + pts[0][1].toFixed(1) + "L" + (pts[0][0] + 30).toFixed(1) + " " + pts[0][1].toFixed(1);
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push(dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0); }
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
    d += "C" + (pts[i][0] + h).toFixed(1) + " " + (pts[i][1] + t[i] * h).toFixed(1) + "," + (pts[i + 1][0] - h).toFixed(1) + " " + (pts[i + 1][1] - t[i + 1] * h).toFixed(1) + "," + pts[i + 1][0].toFixed(1) + " " + pts[i + 1][1].toFixed(1);
  }
  return d;
}

// 柱宽：一根 = 格宽 × 55%（并列双柱各 26%），按粒度封顶；根数少自然粗、多自然细
const BAR_MAX = { day: 48, week: 48, month: 56, quarter: 64, year: 80 };
function barW(grain) { return { wPct: 55, wMax: BAR_MAX[grain] || 48 }; }
function pairW(grain) { return { wPct: 26, wMax: Math.round((BAR_MAX[grain] || 48) / 2) }; }
// 双泳道：柱子只占下面 58%，折线只在上面 32%（68%–100%），中间留 10% 空隙，永不交叉
const LANE_BAR = 58, LANE_LINE_FROM = 68, LANE_LINE = 32;

/**
 * domChart(el, cfg) —— 胶囊柱 + SVG 平滑曲线
 *   height    绘图区高度 px（默认 250；双泳道建议 340）
 *   bars      [{ segs: [{ v, color }], wPct, wMax | w(px), label, labelClass, dashed, minH }]  每根柱
 *   max       柱的量纲上限（默认 niceMax(最大合计 × 1.1)）
 *   line      { values: [number|null], color, width, max, dots }   右轴折线（可选）
 *   yTicks    [{ pos(0-100), label }] 左轴刻度 + 虚线；hTicks 同形右轴刻度（双泳道时 pos 由调用方按泳道给）
 *   xLabels   [{ left(0-100), label }] 绝对定位横轴；或 xPerBar: [string] 每柱一个（太密自动隔几根标）
 *   band      { from, to, label }  当前周期：这几根柱背后铺一块绿底、左上角写「本周」
 *   capLine   { pos, label }  警戒线
 *   lanes     true = 双泳道；hoverInk true = 悬停列的柱子变墨色
 *   keys      [string] 每根柱的身份（如 "week:2026W41"）。和上一次完全相同 → 形变（柱高 / 折线 / 圆点从旧值弹到新值）；
 *             否则（第一次画、换粒度、换区间）→ 长出（柱子从底部错开长出、折线从左往右画、圆点依次弹出）
 *   tip(i)    → { title, rows, foot, notes }
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
  const yTicks = cfg.yTicks || [], hTicks = cfg.hTicks || [];
  const laneBar = cfg.lanes ? LANE_BAR : 100, laneFrom = cfg.lanes ? LANE_LINE_FROM : 0, laneLine = cfg.lanes ? LANE_LINE : 100;
  const keys = cfg.keys || null;
  const prev = el.$dc || null;
  const morph = !REDUCED_MOTION && !!(keys && prev && prev.keys && prev.keys.length === keys.length && prev.keys.every((k, i) => k === keys[i]));
  const grow = !REDUCED_MOTION && !morph;
  const stagger = Math.min(22, 360 / Math.max(1, n));
  const heights = [];

  const cols = bars.map((b, i) => {
    const segs = (b.segs || []).filter((s) => Number(s.v) > 0);
    const h = Math.max(b.minH || 0, (totals[i] / max) * laneBar);
    heights.push(Math.max(b.dashed ? 4 : 0, h));
    const shownH = morph ? prev.heights[i] : heights[i];
    const motion = grow ? "animation-delay:" + Math.round(i * stagger) + "ms;" : "";
    const wStyle = b.wPct ? "width:" + b.wPct + "%;min-width:4px;max-width:" + (b.wMax || 48) + "px;" : "width:" + (b.w || 12) + "px;";
    const inner = segs.length > 1 ? segs.slice().reverse().map((s) => '<i style="flex:' + Number(s.v) + " 1 0;background:" + s.color + '"></i>').join("") : "";
    const bg = segs.length === 1 ? segs[0].color : (b.bg || "transparent");
    return '<div class="dc-col" data-tip="' + i + '">' +
      (b.label !== undefined && b.label !== "" ? '<span class="dc-label' + (b.labelClass ? " " + b.labelClass : "") + '"' + (grow ? ' style="animation-delay:' + Math.round(200 + i * stagger) + 'ms"' : "") + ">" + escHtml(b.label) + "</span>" : "") +
      '<div class="dc-bar' + (inner ? " stacked" : "") + (b.dashed ? " dashed" : "") + '" style="' + wStyle + motion + "height:" + shownH.toFixed(2) + "%;" + (inner || b.dashed ? "" : "background:" + bg) + '">' + (b.dashed ? "" : inner) + "</div></div>";
  }).join("");

  let path = "", dots = "", pts = [], dotY = [];
  if (line && n) {
    const yOf = (v) => laneFrom + (Number(v) / lineMax) * laneLine;
    line.values.forEach((v, i) => { if (v !== null && v !== undefined && isFinite(v)) pts.push([((i + 0.5) / n) * 1000, H - (yOf(v) / 100) * H]); });
    dotY = line.values.map((v) => (v !== null && v !== undefined && isFinite(v) ? yOf(v) : null));
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
    '<div class="dc' + (cfg.hoverInk ? " hover-ink" : "") + (grow ? " grow" : "") + '">' +
    (yTicks.length ? '<div class="dc-y" style="height:' + H + 'px">' + yTicks.map((t) => '<span style="bottom:' + t.pos + '%">' + escHtml(t.label) + "</span>").join("") + "</div>" : "") +
    '<div class="dc-body"><div class="dc-plot" style="height:' + H + 'px">' +
    yTicks.map((t) => '<b class="dc-grid" style="bottom:' + t.pos + '%"></b>').join("") +
    (cfg.lanes ? hTicks.map((t) => '<b class="dc-grid light" style="bottom:' + t.pos + '%"></b>').join("") : "") +
    (cfg.capLine ? '<b class="dc-cap" style="bottom:' + cfg.capLine.pos + '%"></b>' + (cfg.capLine.label ? '<span class="dc-cap-label" style="bottom:' + cfg.capLine.pos + '%">' + escHtml(cfg.capLine.label) + "</span>" : "") : "") +
    (cfg.band && n && cfg.band.to >= cfg.band.from ? '<div class="dc-band" style="left:' + ((cfg.band.from / n) * 100).toFixed(2) + "%;width:" + (((cfg.band.to - cfg.band.from + 1) / n) * 100).toFixed(2) + '%"><span>' + escHtml(cfg.band.label || "") + "</span></div>" : "") +
    '<div class="dc-cols">' + cols + "</div>" +
    (path ? '<svg class="dc-line" viewBox="0 0 1000 ' + H + '" preserveAspectRatio="none"><path d="' + path + '" fill="none" stroke="' + (line.color || INK) + '" stroke-width="' + (line.width || 2) + '" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path></svg>' : "") +
    dots +
    "</div>" + xAbs + xPer + "</div>" +
    (hTicks.length ? '<div class="dc-h" style="height:' + H + 'px">' + hTicks.map((t) => '<span style="bottom:' + t.pos + '%">' + escHtml(t.label) + "</span>").join("") + "</div>" : "") +
    "</div>";

  // 形变：插入后把柱高、圆点改成新值（CSS transition 弹过去），折线逐帧补间
  if (morph) {
    const barEls = el.querySelectorAll(".dc-bar"), dotEls = el.querySelectorAll(".dc-dots i");
    void el.offsetHeight;
    barEls.forEach((b, i) => { b.style.height = heights[i].toFixed(2) + "%"; });
    let di = 0;
    dotY.forEach((y) => { if (y === null) return; const d = dotEls[di++]; if (d) d.style.bottom = y.toFixed(2) + "%"; });
    const p = el.querySelector(".dc-line path");
    if (p && prev.pts && prev.pts.length === pts.length && prev.H === H) {
      const from = prev.pts;
      tween(el, "$lineTween", 520, SPRING_SNAP, (k) => { p.setAttribute("d", smoothPath(pts.map((q, i) => [q[0], from[i][1] + (q[1] - from[i][1]) * k]))); });
    }
  }
  el.$dc = { keys, heights, pts, dotY, H };

  thinPerBarLabels(el, n);
  if (cfg.tip) {
    el.$tip = cfg.tip;
    if (!el.dataset.bound) { el.dataset.bound = "1"; bindDomTip(el, (i) => (el.$tip ? el.$tip(i) : null)); }
  }
}

// 逐柱横轴标签太密时隔几根标一个，从最后一根往前数，保证最新的那根有标签；「今天」永远保留
function thinPerBarLabels(el, n) {
  const axis = el.querySelector(".dc-x.per");
  if (!axis || !n) return;
  const step = axis.clientWidth ? Math.ceil((n * 46) / axis.clientWidth) : 1;
  if (step > 1) axis.querySelectorAll("span").forEach((sp, i) => { if ((n - 1 - i) % step && !sp.classList.contains("today")) sp.textContent = ""; });
}

/**
 * pairChart(el, cfg) —— 并列双柱（彼此不构成整体的两个指标，如人数 vs 企业数）
 *   height, band, xLabels / xPerBar 同 domChart；grain 决定柱宽
 *   items [{ a, b, aLabel, bLabel }]，colors [colorA, colorB]，labels 是否标数（默认 ≤20 根时标）
 *   tip(i)
 */
function pairChart(el, cfg) {
  if (!el) return;
  const items = cfg.items || [];
  const n = items.length;
  const H = cfg.height || 200;
  const max = cfg.max || niceMax(Math.max(...items.map((x) => Math.max(Number(x.a) || 0, Number(x.b) || 0)), 0) * 1.15);
  const pw = pairW(cfg.grain);
  const wStyle = "width:" + pw.wPct + "%;min-width:3px;max-width:" + pw.wMax + "px";
  const showLabels = cfg.labels !== undefined ? cfg.labels : n <= 20;
  const [ca, cb] = cfg.colors || [INK, "#AAA9AB"];
  const one = (v, label, color, dim) => '<div class="pair-one" style="' + wStyle + '">' + (showLabels ? '<span class="dc-label' + (dim ? " dim" : "") + '">' + escHtml(label) + "</span>" : "") + '<i style="height:' + ((Number(v) || 0) / max * 100).toFixed(1) + "%;background:" + color + '"></i></div>';
  el.innerHTML =
    '<div class="dc"><div class="dc-body"><div class="dc-plot pair-plot" style="height:' + H + 'px">' +
    (cfg.band && n && cfg.band.to >= cfg.band.from ? '<div class="dc-band" style="left:' + ((cfg.band.from / n) * 100).toFixed(2) + "%;width:" + (((cfg.band.to - cfg.band.from + 1) / n) * 100).toFixed(2) + '%"><span>' + escHtml(cfg.band.label || "") + "</span></div>" : "") +
    '<div class="dc-cols">' + items.map((x, i) => '<div class="dc-col pair" data-tip="' + i + '">' + one(x.a, x.aLabel ?? fmtNum(x.a), ca, false) + one(x.b, x.bLabel ?? fmtNum(x.b), cb, true) + "</div>").join("") + "</div></div>" +
    (cfg.xPerBar ? '<div class="dc-x per">' + cfg.xPerBar.map((x) => "<span" + (x === "今天" ? ' class="today"' : "") + ">" + escHtml(x) + "</span>").join("") + "</div>"
      : '<div class="dc-x abs">' + (cfg.xLabels || []).map((x) => '<span style="left:' + x.left + '%">' + escHtml(x.label) + "</span>").join("") + "</div>") +
    "</div></div>";
  thinPerBarLabels(el, n);
  if (cfg.tip) {
    el.$tip = cfg.tip;
    if (!el.dataset.bound) { el.dataset.bound = "1"; bindDomTip(el, (i) => (el.$tip ? el.$tip(i) : null)); }
  }
}

// 占比条（一行胶囊分段）+ 图例行：items [{ label, value, color }]
function stackHtml(items, opts) {
  const o = opts || {};
  const sum = items.reduce((a, x) => a + x.value, 0);
  const segs = items.filter((x) => x.value > 0).map((x) => '<i style="flex:' + x.value + " 1 0;background:" + x.color + '" title="' + escHtml(x.label + "：" + fmtNum(x.value)) + '"></i>').join("");
  const rows = o.noLegend ? "" : '<div class="legend-rows">' + items.map((x) =>
    '<div class="legend-row"><span class="sw" style="background:' + x.color + '"></span><span>' + escHtml(x.label) + "</span><b>" + fmtNum(x.value) + "</b><small>" + pct(x.value, sum) + "%</small></div>").join("") + "</div>";
  return '<div class="stack">' + (segs || '<i style="flex:1;background:var(--soft)"></i>') + "</div>" + rows;
}

// 指标卡底部一排小柱：最近一根黑、其余浅灰
function sparkHtml(vals) {
  const max = Math.max(...vals, 1);
  return '<div class="spark" aria-hidden="true">' + vals.map((v, i) => '<i style="height:' + ((v / max) * 100).toFixed(1) + "%;background:" + (i === vals.length - 1 ? INK : "#DBDADD") + '"></i>').join("") + "</div>";
}

// 热力格颜色：ratio 0–1，0 留白、浅 → 深单色阶，过半改白字；返回 { bg, fg }
function cellTone(ratio) {
  if (!(ratio > 0)) return { bg: "transparent", fg: "var(--ink)" };
  const steps = ["#F1F0F3", "#DBDADD", "#C9C8CD", "#AAA9AB", "#8D8C93", "#55545A", "#0B0B0C"];
  const k = Math.min(steps.length - 1, Math.floor(ratio * steps.length));
  return { bg: steps[k], fg: k >= 4 ? "#fff" : "var(--ink)" };
}

// ============== 时间分桶 ==============
const GRAIN_LIST = [["day", "日"], ["week", "周"], ["month", "月"], ["quarter", "季"], ["year", "年"]];
const WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function isoWeekOf(day) {   // "2026-10-05" → "2026W41"
  const d = new Date(day + "T00:00:00Z");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return t.getUTCFullYear() + "W" + String(1 + Math.round((t - ft) / 604800000)).padStart(2, "0");
}
function periodKeyOf(day, grain) {
  switch (grain) {
    case "week": return isoWeekOf(day);
    case "month": return day.slice(0, 7);
    case "quarter": return day.slice(0, 4) + "-Q" + (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1);
    case "year": return day.slice(0, 4);
    default: return day;
  }
}
// 日桶 → 任意粒度：byDay = { "2026-10-05": { total: 12, dur: 300, dev: { pc: 8 } }, ... }
// 数值字段直接相加，对象字段按 key 相加；每个桶带 key / first / last / days。去重数不能这样加（见规范）。
function rollupDays(byDay, grain) {
  const order = [], map = {};
  const days = Object.keys(byDay || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const day of days) {
    const key = periodKeyOf(day, grain);
    if (!map[key]) { map[key] = { key, first: day, last: day, days: 0 }; order.push(key); }
    const t = map[key], b = byDay[day] || {};
    t.last = day; t.days++;
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === "number") t[k] = (t[k] || 0) + v;
      else if (v && typeof v === "object") { t[k] = t[k] || {}; for (const [kk, vv] of Object.entries(v)) t[k][kk] = (t[k][kk] || 0) + (Number(vv) || 0); }
    }
  }
  return { keys: order, buckets: order.map((k) => map[k]) };
}

// 当前周期：按天 = 最近 7 根「近 7 天」，其他粒度 = 最后一根「本周 / 本月 / 本季 / 本年」
function currentBand(buckets, grain) {
  const n = buckets.length;
  if (!n) return null;
  const LABEL = { week: "本周", month: "本月", quarter: "本季", year: "本年" };
  if (grain !== "day") return { from: n - 1, to: n - 1, label: LABEL[grain] || "" };
  return { from: Math.max(0, n - 7), to: n - 1, label: "近 7 天" };
}
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
const isOngoing = (b) => !!b && b.last === todayKey();   // 还没过完的桶：虚线空心柱、横轴写「今天」

// 横轴：按天只标每月 1 号（和首根），按周 > 12 根隔一根标 W41，月 / 季 / 年逐根标
function xLabelsFor(buckets, grain) {
  const n = buckets.length, out = [];
  if (!n) return out;
  if (grain === "day") { buckets.forEach((b, i) => { if (b.first.slice(8) === "01" || i === 0) out.push({ left: (((i + 0.5) / n) * 100).toFixed(2), label: Number(b.first.slice(5, 7)) + " 月" }); }); return out; }
  const step = grain === "week" && n > 12 ? 2 : 1;
  buckets.forEach((b, i) => {
    if ((n - 1 - i) % step) return;
    const k = b.key;
    out.push({ left: (((i + 0.5) / n) * 100).toFixed(2), label: grain === "week" ? "W" + Number(k.slice(5)) : grain === "month" ? Number(k.slice(5, 7)) + " 月" : grain === "quarter" ? k.slice(5) : k });
  });
  return out;
}
// 按天 ≤ 31 天逐天写 MM-DD（今天写「今天」），其余用 xLabelsFor；直接展开进 domChart 的 cfg
function axisFor(buckets, grain) {
  if (grain === "day" && buckets.length <= 31) return { xPerBar: buckets.map((b) => (isOngoing(b) ? "今天" : b.first.slice(5))) };
  return { xLabels: xLabelsFor(buckets, grain) };
}
// 悬停卡标题：2026-10-05 周一 / W41 · 10-05 – 10-11（不完整）/ 2026 年 10 月 / 2026 Q4 / 2026 年
function bucketTitle(b, grain) {
  const md = (d) => d.slice(5);
  if (grain === "day") return b.first + " " + WD_CN[new Date(b.first + "T00:00:00Z").getUTCDay()];
  if (grain === "week") return "W" + Number(b.key.slice(5)) + " · " + md(b.first) + " – " + md(b.last) + (b.days < 7 ? "（不完整）" : "");
  if (grain === "month") return b.key.slice(0, 4) + " 年 " + Number(b.key.slice(5, 7)) + " 月";
  if (grain === "quarter") return b.key.replace("-Q", " Q");
  return b.key + " 年";
}

// 粒度页签：下划线式分段按钮，纯前端换分桶
function initSeg(box, current, onPick) {
  if (!box) return;
  box.replaceChildren(...GRAIN_LIST.map(([g, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.grain = g; b.textContent = label; b.setAttribute("role", "tab"); b.setAttribute("aria-pressed", String(g === current));
    return b;
  }));
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-grain]");
    if (!b) return;
    box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset.grain);
  });
}

// ============== 手机抽屉菜单 + 筛选栏折叠 ==============
// 需要的标记：#menuBtn（汉堡）、#menuClose、#menuBackdrop、.side-body（抽屉）、#filterToggle + .filterbar
function initMenu() {
  const btn = $("menuBtn"), close = $("menuClose"), backdrop = $("menuBackdrop");
  if (btn) {
    const set = (open) => { document.body.classList.toggle("menu-open", open); btn.setAttribute("aria-expanded", String(open)); };
    btn.addEventListener("click", () => set(!document.body.classList.contains("menu-open")));
    if (close) close.addEventListener("click", () => set(false));
    if (backdrop) backdrop.addEventListener("click", () => set(false));
    document.querySelectorAll(".nav-item").forEach((t) => t.addEventListener("click", () => set(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  }
  const ft = $("filterToggle"), fb = document.querySelector(".filterbar");
  if (ft && fb) ft.addEventListener("click", () => { const open = !fb.classList.contains("open"); fb.classList.toggle("open", open); ft.setAttribute("aria-expanded", String(open)); });
}
