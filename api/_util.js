const https = require("node:https");

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendSseHeaders(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
}

function sseEvent(res, { event, data }) {
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});
  for (const line of String(payload).split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

async function readJsonBody(req) {
  const raw = await new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
  if (!raw) return {};
  return JSON.parse(raw);
}

function clampStr(v, maxLen) {
  return String(v || "").slice(0, maxLen);
}

function extractJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

function hasNumbers(text) {
  return /(\d+([.,]\d+)?|%|\$|usd|krw|원|달러|엔|€|£)/i.test(String(text || ""));
}

function hasDisallowedFinanceAdvice(text) {
  return /(매수|매도|추천|사라|팔아|롱|숏|목표가|손절|익절|수익률|수익|손실|투자\s*조언|포지션|진입|청산)/i.test(String(text || ""));
}

function hasDisallowedAnalysisWord(text) {
  return /(분석|리포트)/i.test(String(text || ""));
}

function extractAssistantTextFromChatCompletions(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (typeof msg?.content === "string") return msg.content;
  if (msg?.content && typeof msg.content === "object" && !Array.isArray(msg.content)) {
    const c = msg.content;
    if (typeof c?.text === "string") return c.text;
    if (typeof c?.text?.value === "string") return c.text.value;
    if (typeof c?.value === "string") return c.value;
  }
  if (typeof msg?.refusal === "string" && msg.refusal) return msg.refusal;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.text?.value === "string") return p.text.value;
        if (typeof p?.text?.text === "string") return p.text.text;
        if (typeof p?.text?.content === "string") return p.text.content;
        if (typeof p?.content === "string") return p.content;
        if (typeof p?.content?.value === "string") return p.content.value;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

async function httpsGetText(urlStr, headers = {}, { maxHeaderSize = 256 * 1024 } = {}) {
  const u = new URL(urlStr);
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "Accept-Encoding": "identity", ...headers },
        maxHeaderSize
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function tvSymbolToYahooSymbol(sym) {
  const s = String(sym || "").trim();
  if (!s) return "AAPL";
  const parts = s.split(":");
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_]{1,32}$/.test(sym);
}

function isSafeYahooInterval(v) {
  return /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/.test(v);
}

function isSafeYahooRange(v) {
  return /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/.test(v);
}

function normalizeOhlcv(text) {
  const raw = clampStr(text, 200_000).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out = [];
    for (const row of parsed.slice(0, 200)) {
      if (!row || typeof row !== "object") continue;
      const t = row.t ?? row.time ?? row.date ?? row.timestamp;
      const o = Number(row.o ?? row.open);
      const h = Number(row.h ?? row.high);
      const l = Number(row.l ?? row.low);
      const c = Number(row.c ?? row.close);
      const v = row.v ?? row.volume ?? null;
      const vN = v === null || v === undefined ? null : Number(v);
      if (!t || ![o, h, l, c].every((x) => Number.isFinite(x))) continue;
      out.push({ t: String(t), o, h, l, c, v: Number.isFinite(vN) ? vN : null });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function normalizeScreener(text) {
  const raw = clampStr(text, 200_000).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.slice(0, 50);
  } catch {
    return null;
  }
}

async function getYahooCrumbAndCookie(symbolForSession = "AAPL") {
  const now = Date.now();
  globalThis.__yahooCrumb ||= { ts: 0, crumb: "", cookie: "" };
  const cached = globalThis.__yahooCrumb;
  if (cached.crumb && cached.cookie && now - cached.ts < 6 * 60 * 60 * 1000) return cached;

  const pageUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(symbolForSession)}?p=${encodeURIComponent(symbolForSession)}`;
  const page = await httpsGetText(pageUrl, { "User-Agent": "Mozilla/5.0", "Accept": "text/html" });

  const setCookiesRaw = page.headers?.["set-cookie"];
  const setCookies = Array.isArray(setCookiesRaw) ? setCookiesRaw : setCookiesRaw ? [String(setCookiesRaw)] : [];
  const allowCookieKeys = new Set(["B", "A1", "A3", "A1S", "GUC", "cmp", "PRF"]);
  const cookie = setCookies
    .map((sc) => String(sc || "").split(";")[0].trim())
    .filter((kv) => kv.includes("="))
    .filter((kv) => allowCookieKeys.has(kv.split("=")[0]))
    .join("; ");

  if (!cookie) {
    const e = new Error("Failed to get Yahoo cookie");
    e.details = "cookie=missing";
    throw e;
  }

  const crumbResp = await httpsGetText("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/plain",
    "Cookie": cookie
  });
  const crumb = String(crumbResp.body || "").trim();
  if (!crumb || crumbResp.status < 200 || crumbResp.status >= 300) {
    const e = new Error("Failed to get Yahoo crumb");
    e.details = `status=${crumbResp.status}`;
    throw e;
  }

  const out = { ts: now, crumb, cookie };
  globalThis.__yahooCrumb = out;
  return out;
}

module.exports = {
  sendJson,
  sendSseHeaders,
  sseEvent,
  readJsonBody,
  clampStr,
  extractJsonObject,
  hasNumbers,
  hasDisallowedFinanceAdvice,
  hasDisallowedAnalysisWord,
  extractAssistantTextFromChatCompletions,
  httpsGetText,
  tvSymbolToYahooSymbol,
  isSafeYahooSymbol,
  isSafeYahooInterval,
  isSafeYahooRange,
  normalizeOhlcv,
  normalizeScreener,
  getYahooCrumbAndCookie
};


