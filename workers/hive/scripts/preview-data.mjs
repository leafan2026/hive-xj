// 本地预览用的合成会话（确定性随机，不含任何生产数据或凭证）。
// 目的：让周报、业务闭环、客服评估、情绪表、忙闲图在预览里都有足够的行可看。
// 字段与 src/index.js 的 trim() 输出一致；行数与比例只求「看起来像」，不代表真实分布。

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, weighted) {
  const total = weighted.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of weighted) {
    x -= w;
    if (x <= 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

const pad = (n) => String(n).padStart(2, "0");

const NATURE = [["有效", 65], ["填表人", 12], ["无效", 10], ["转接未应答", 5], ["电话引导·发链接图片", 3], ["未标记", 3], ["内部测试", 2]];
const CHANNEL = [["gd_next", 46], ["gd4", 22], ["gd_app", 12], ["wechat_miniapp", 10], ["wechat_official", 6], ["trade_weixin_app", 4]];
const DEVICE = [["pc", 62], ["mobile", 34], ["未知", 4]];
const MEDIUM = [["网页", 30], ["表单编辑器", 14], ["数据页", 11], ["应用", 9], ["帮助中心", 8], ["小程序", 7], ["设置页", 5], ["收款页", 4], ["账单页", 3], ["模板中心", 3], ["公众号菜单", 2], ["短信链接", 2], ["企业微信", 1], ["其他", 1]];
const PLAN = [["免费版", 48], ["专业版", 19], ["企业基础版", 13], ["专业增强版", 8], ["企业协作版", 6], ["企业高级版", 4], ["商业合作版", 2]];
const XJ = [["无关", 93], ["A 潜在商户", 3], ["B 入驻中", 1.8], ["C 已通过未启动", 1], ["D 已启动新商户", 0.8], ["E 流失", 0.4]];
const SCENE = [["操作引导/功能咨询", 30], ["套餐购买/费用", 17], ["数据查看/导出", 13], ["故障/技术", 8], ["小金商户/在线收款", 7], ["账务", 5], ["实名认证/资质", 4.5], ["短信审核", 4], ["违规/申诉/举报", 3.5], ["AI建表/改表", 3], ["商户管理", 2], ["其他", 2]];
const REASON = [["AI答错/执行错", 20], ["必须真人", 18], ["AI能答没给机会", 14], ["没等答完/顺手转", 12], ["AI答不了(KB缺口)", 11], ["答对仍要人", 7], ["可自助", 5]];
const BIZ = [["收款", 26], ["报名", 20], ["预约", 14], ["信息收集", 16], ["考试测评", 9], ["订单", 8], ["其他", 7]];
const AGENTS = ["甲", "乙", "丙", "丁", "戊", "己"];
const HOUR_W = [0, 0, 0, 0, 0, 0, 0, 1, 3, 7, 10, 9, 5, 6, 10, 11, 8, 6, 3, 2, 1.5, 1, 0.5, 0.2];

export function synthRows({ days = 112, seed = 20261013, now = Date.now() } = {}) {
  const r = rng(seed);
  const rows = [];
  const lastByUser = new Map();
  let id = 1000;
  const today = new Date(now);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let d = days - 1; d >= 0; d--) {
    const dayMs = base - d * 86400000;
    const date = new Date(dayMs);
    const dow = date.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const n = weekend ? 30 + Math.round(r() * 20) : 105 + Math.round(r() * 45);
    for (let i = 0; i < n; i++) {
      const hour = Number(pick(r, HOUR_W.map((w, h) => [h, weekend ? w * 0.6 + 0.2 : w])));
      const minute = Math.floor(r() * 60);
      const t = date.toISOString().slice(0, 10) + "T" + pad(hour) + ":" + pad(minute) + ":00Z";
      const manual = r() < (weekend ? 0.03 : 0.12);
      const nat = pick(r, NATURE);
      const scene = pick(r, SCENE);
      const uid = "u" + Math.floor(r() * 4200);
      const url = "https://example.invalid/conversations/" + (id++);
      const prev = lastByUser.get(uid);
      const rep = !!prev && dayMs - prev.ms < 2 * 86400000 && r() < 0.35;
      const row = {
        t, url, uid, baid: "b" + Math.floor(Number(uid.slice(1)) * 0.6),
        ch: pick(r, CHANNEL), dev: pick(r, DEVICE), med: pick(r, MEDIUM),
        st: manual ? "仅人工" : "仅 Jiri",
        plan: pick(r, PLAN), nat, scene, cat: pick(r, XJ),
        jiri: manual ? pick(r, [["能", 35], ["部分", 25], ["不能", 30], ["未标记", 10]]) : pick(r, [["能", 72], ["部分", 14], ["不能", 6], ["未标记", 8]]),
        way: manual ? pick(r, [["直接转", 40], ["沟通后转", 60]]) : "",
        reason: manual ? pick(r, REASON) : "",
        dur: manual ? Math.round(90 + r() * r() * 1500) : null,
        turns: manual ? 1 + Math.floor(r() * r() * 3) : 1 + Math.floor(r() * 6),
        uturns: manual ? null : Math.floor(r() * r() * 9),
        rep, repFrom: rep ? prev.url : "",
        atJiri: manual && r() < 0.1,
        biz: "", onTarget: "", gotData: "", jiriBuilt: "", loop: "",
        csFirst: "", csLast: "", csAll: [], emo: "",
      };
      if (manual) {
        const first = AGENTS[Math.floor(r() * AGENTS.length)];
        const relay = r() < 0.15;
        const last = relay ? AGENTS[Math.floor(r() * AGENTS.length)] : first;
        row.csFirst = first;
        row.csLast = last;
        row.csAll = first === last ? [first] : [first, last];
        row.emo = pick(r, [["中性", 77], ["负向", 8], ["正向", 15]]);
      }
      // 业务闭环：约四成有效会话带业务分型；最近 7 天的部分会话结果还没定
      if (nat === "有效" && r() < 0.4) {
        row.biz = pick(r, BIZ);
        const fresh = d < 7;
        const got = r() < (fresh ? 0.55 : 0.82);
        row.gotData = got ? "是" : fresh ? "" : "否";
        row.onTarget = pick(r, [["是", 70], ["否", 20], ["待定", 10]]);
        row.jiriBuilt = r() < 0.3 ? "是" : "否";
        row.loop = r() < 0.08 ? "不适用" : got ? "是" : fresh ? "待定" : "否";
      }
      lastByUser.set(uid, { ms: dayMs, url });
      rows.push(row);
    }
  }
  return rows;
}
