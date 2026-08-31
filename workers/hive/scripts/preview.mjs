import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import worker from "../src/index.js";

const port = Number(process.env.PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// 仅用于本地界面验收的合成数据；不包含任何生产会话或凭证。
const rows = [
  { t: `${day(0)}T09:00:00Z`, st: "仅 Jiri", jiri: "能", ch: "gd_next", dev: "pc", med: "网页", plan: "免费版", cat: "无关", nat: "有效", scene: "操作引导/功能咨询", dur: 180, turns: 2, way: "", reason: "", uid: "u1", baid: "b1" },
  { t: `${day(-1)}T10:00:00Z`, st: "仅人工", jiri: "不能", ch: "gd_app", dev: "mobile", med: "应用", plan: "企业高级版", cat: "无关", nat: "有效", scene: "故障/技术", dur: 480, turns: 3, way: "直接转", reason: "可自助", uid: "u2", baid: "b2" },
  { t: `${day(-3)}T11:00:00Z`, st: "仅 Jiri", jiri: "能", ch: "gd_next", dev: "mobile", med: "网页", plan: "免费版", cat: "无关", nat: "填表人", scene: "操作引导/功能咨询", dur: 120, turns: 1, way: "", reason: "", uid: "u3", baid: "b3" },
  { t: `${day(-16)}T14:00:00Z`, st: "仅 Jiri", jiri: "能", ch: "gd_next", dev: "pc", med: "网页", plan: "免费版", cat: "无关", nat: "有效", scene: "操作引导/功能咨询", dur: 90, turns: 1, way: "", reason: "", uid: "u4", baid: "b4" },
];

const fullStats = {
  channel: { gd_next: 3, gd_app: 1 }, device: { pc: 2, mobile: 2 },
  status: { "仅 Jiri": 3, "仅人工": 1 }, nature: { "有效": 3, "填表人": 1 },
  scene: { "操作引导/功能咨询": 3, "故障/技术": 1 }, plan: { "免费版": 3, "企业高级版": 1 },
  daily: Object.fromEntries(rows.map((row) => [row.t.slice(0, 10), 1])),
};

const cache = {
  async get(key) {
    if (key === "hive:entries:v2") return rows;
    if (key === "hive:stats:v2") return fullStats;
    if (key === "hive:weekly:v1") return [];
    if (key === "hive:loop:v1") return { weeks: [], types: [], overall: { applicable: 0, yes: 0, no: 0, pending: 0, rate: null } };
    if (key === "hive:meta:v1") return { status: "ok", updatedAt: new Date().toISOString(), total: rows.length };
    return null;
  },
  async put() {},
};

const env = {
  AUTH_USERS: "preview:preview",
  CACHE: cache,
  ASSETS: { url: async (path) => `${origin}/assets${path}` },
};

const assetTypes = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const incoming = new URL(req.url || "/", origin);
    if (incoming.pathname.startsWith("/assets/")) {
      const name = incoming.pathname.slice("/assets/".length);
      if (!new Set(["hive.css", "hive.js", "chart.min.js"]).has(name)) {
        res.writeHead(404).end("Not Found");
        return;
      }
      const content = await readFile(join("public", name));
      res.writeHead(200, { "content-type": assetTypes[extname(name)] || "application/octet-stream" }).end(content);
      return;
    }

    const workerUrl = new URL(incoming);
    workerUrl.pathname = incoming.pathname.replace(/^\/hive(?=\/|$)/, "") || "/";
    let response;
    let previewCookie = "";
    if (incoming.pathname === "/hive/preview") {
      const login = await worker.fetch(new Request(`${origin}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "preview", pass: "preview" }),
      }), env, { waitUntil() {} });
      previewCookie = login.headers.get("set-cookie") || "";
      response = await worker.fetch(new Request(`${origin}/`, { headers: { cookie: previewCookie } }), env, { waitUntil() {} });
    } else {
      const init = { method: req.method, headers: req.headers };
      if (!/^(GET|HEAD)$/i.test(req.method || "GET")) init.body = await bodyOf(req);
      response = await worker.fetch(new Request(workerUrl, init), env, { waitUntil() {} });
    }
    const headers = Object.fromEntries(response.headers);
    if (previewCookie) headers["set-cookie"] = previewCookie;
    res.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`Preview error: ${error.message}`);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`本地预览已启动：${origin}/hive/`);
  console.log("演示账号：preview；密码：preview");
});
