import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadDotEnv(envPath) {
  try {
    const raw = await readFile(envPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore if no .env
  }
}

await loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
}

const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

function normalizeOpenAIModel(raw) {
  const v = String(raw || "").trim();
  if (!v) return "gpt-5.2";
  // 사용자가 "5.2"처럼 적는 경우를 허용
  if (v === "5.2") return "gpt-5.2";
  if (v === "gpt-5.2") return v;
  return v;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = normalizeOpenAIModel(process.env.OPENAI_MODEL);
const OPENAI_PORTFOLIO_MODEL = process.env.OPENAI_PORTFOLIO_MODEL || "gpt-4.1-mini";

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || "";
const PERPLEXITY_BASE_URL = (process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
}

function sseEvent(res, { event, data }) {
  if (event) res.write(`event: ${event}\n`);
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});
  // data는 줄 단위로 나눠서 전송(SSE 규칙)
  for (const line of String(payload).split("\n")) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

async function httpsGetText(urlStr, headers = {}) {
  const u = new URL(urlStr);
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "Accept-Encoding": "identity",
          ...headers
        },
        // Yahoo quoteSummary가 매우 큰 헤더를 주는 경우가 있어 상향
        maxHeaderSize: 256 * 1024
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readRequestBodyWithLimit(req, limitBytes) {
  const limit = Number(limitBytes) > 0 ? Number(limitBytes) : 1_000_000;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        const e = new Error("Body too large");
        e.code = "BODY_TOO_LARGE";
        e.limit = limit;
        reject(e);
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function safeJoinPublic(p) {
  const decoded = decodeURIComponent(p);
  const cleaned = decoded.split("?")[0].split("#")[0];
  const rel = cleaned === "/" ? "/index.html" : cleaned;
  const joined = path.join(PUBLIC_DIR, rel);
  const normalized = path.normalize(joined);
  if (!normalized.startsWith(PUBLIC_DIR)) return null;
  return normalized;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function clampStr(v, maxLen) {
  return String(v || "").slice(0, maxLen);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseOhlcvCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const tIdx = idx("time") >= 0 ? idx("time") : idx("date");
  const oIdx = idx("open");
  const hIdx = idx("high");
  const lIdx = idx("low");
  const cIdx = idx("close");
  const vIdx = idx("volume");
  if (tIdx < 0 || oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0) return null;

  const out = [];
  for (const line of lines.slice(1, 1 + 200)) {
    const cols = line.split(",").map((s) => s.trim());
    const t = cols[tIdx];
    const o = Number(cols[oIdx]);
    const h = Number(cols[hIdx]);
    const l = Number(cols[lIdx]);
    const c = Number(cols[cIdx]);
    const v = vIdx >= 0 ? Number(cols[vIdx]) : null;
    if (!t || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  return out.length ? out : null;
}

function normalizeOhlcv(text) {
  const raw = clampStr(text, 200_000).trim();
  if (!raw) return null;

  // JSON 우선
  const parsed = tryParseJson(raw);
  if (Array.isArray(parsed)) {
    const out = [];
    for (const row of parsed.slice(0, 200)) {
      if (!row || typeof row !== "object") continue;
      const t = row.t ?? row.time ?? row.date ?? row.timestamp;
      const o = row.o ?? row.open;
      const h = row.h ?? row.high;
      const l = row.l ?? row.low;
      const c = row.c ?? row.close;
      const v = row.v ?? row.volume ?? null;
      if (!t) continue;
      const oN = Number(o);
      const hN = Number(h);
      const lN = Number(l);
      const cN = Number(c);
      const vN = v === null || v === undefined ? null : Number(v);
      if (!Number.isFinite(oN) || !Number.isFinite(hN) || !Number.isFinite(lN) || !Number.isFinite(cN)) continue;
      out.push({ t: String(t), o: oN, h: hN, l: lN, c: cN, v: Number.isFinite(vN) ? vN : null });
    }
    return out.length ? out : null;
  }

  // CSV fallback
  return parseOhlcvCsv(raw);
}

function normalizeScreener(text) {
  const raw = clampStr(text, 200_000).trim();
  if (!raw) return null;
  const parsed = tryParseJson(raw);
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const row of parsed.slice(0, 50)) {
    if (!row || typeof row !== "object") continue;
    // 너무 큰 객체는 키 수 제한
    const keys = Object.keys(row).slice(0, 24);
    const slim = {};
    for (const k of keys) slim[k] = row[k];
    out.push(slim);
  }
  return out.length ? out : null;
}

function tvSymbolToYahooSymbol(sym) {
  const s = String(sym || "").trim();
  if (!s) return "AAPL";
  const parts = s.split(":");
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

function isSafeYahooSymbol(sym) {
  // Yahoo ticker는 대개 영숫자/특수기호(. ^ = - _) 정도만 허용
  return /^[A-Za-z0-9.\-^=_]{1,32}$/.test(sym);
}

function isSafeYahooInterval(v) {
  return /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/.test(v);
}

function isSafeYahooRange(v) {
  return /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/.test(v);
}

function isSafeYahooScreenerId(v) {
  return /^(largest_market_cap|most_actives|day_gainers|day_losers)$/.test(v);
}

function pickRaw(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v && "raw" in v) return v.raw;
  return v;
}

async function getYahooCrumbAndCookie(symbolForSession = "AAPL") {
  // 6시간 캐시
  const now = Date.now();
  globalThis.__yahooCrumb ||= { ts: 0, crumb: "", cookie: "" };
  const cached = globalThis.__yahooCrumb;
  if (cached.crumb && cached.cookie && now - cached.ts < 6 * 60 * 60 * 1000) return cached;

  // Yahoo 웹 페이지에서 crumb 추출(비공식/취약)
  const pageUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(symbolForSession)}?p=${encodeURIComponent(symbolForSession)}`;
  const page = await httpsGetText(pageUrl, { "User-Agent": "Mozilla/5.0", "Accept": "text/html" });

  // set-cookie에서 쿠키 수집(https 모듈은 set-cookie를 배열로 줌)
  const setCookiesRaw = page.headers?.["set-cookie"];
  const setCookies = Array.isArray(setCookiesRaw) ? setCookiesRaw : (setCookiesRaw ? [String(setCookiesRaw)] : []);
  const allowCookieKeys = new Set(["B", "A1", "A3", "A1S", "GUC", "cmp", "PRF"]);
  const cookie = setCookies
    .flatMap((sc) => String(sc || "").split(/\r?\n/))
    .map((sc) => sc.split(";")[0].trim())
    .filter((kv) => kv.includes("="))
    .filter((kv) => allowCookieKeys.has(kv.split("=")[0]))
    .join("; ");

  if (!cookie) {
    const e = new Error("Failed to get Yahoo crumb/cookie");
    e.details = `cookie=missing`;
    throw e;
  }

  // crumb는 getcrumb 엔드포인트로 얻는다(HTML 파싱보다 안정적)
  const crumbResp = await httpsGetText("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/plain",
    "Cookie": cookie
  });
  const crumb = String(crumbResp.body || "").trim();
  if (!crumb || crumbResp.status < 200 || crumbResp.status >= 300) {
    const e = new Error("Failed to get Yahoo crumb/cookie");
    e.details = `crumb=missing, cookie=ok`;
    throw e;
  }

  const out = { ts: now, crumb, cookie };
  globalThis.__yahooCrumb = out;
  return out;
}

async function handleYahooConsensus(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const symbolRaw = tvSymbolToYahooSymbol(url.searchParams.get("symbol") || "AAPL");
  if (!isSafeYahooSymbol(symbolRaw)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });

  const cacheKey = `consensus|${symbolRaw}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) {
    return sendJson(res, 200, { ...cached.data, cached: true });
  }

  const modules = "price,financialData,recommendationTrend,earningsTrend";
  const baseUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbolRaw)}`;
  const urlNoCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}`;

  try {
    const data = await (async () => {
      // 1) crumb 없이 시도
      const first = await httpsGetText(urlNoCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (first.status >= 200 && first.status < 300) return JSON.parse(first.body || "{}");
      const errText = first.body || "";

      // 2) Invalid Crumb(401)인 경우에만 crumb/cookie 획득 후 재시도
      if (first.status !== 401 || !/crumb/i.test(errText)) {
        const details = errText.slice(0, 2000);
        const e = new Error("Yahoo consensus request failed");
        e.status = first.status;
        e.details = details;
        throw e;
      }

      const { crumb, cookie } = await getYahooCrumbAndCookie(symbolRaw);
      const urlWithCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
      const second = await httpsGetText(urlWithCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Cookie": cookie });
      if (second.status < 200 || second.status >= 300) {
        const t = second.body || "";
        const e = new Error("Yahoo consensus request failed");
        e.status = second.status;
        e.details = t.slice(0, 2000);
        throw e;
      }
      return JSON.parse(second.body || "{}");
    })();

    const result = data?.quoteSummary?.result?.[0] || {};

    const price = result.price || {};
    const financialData = result.financialData || {};
    const recommendationTrend = result.recommendationTrend || {};
    const earningsTrend = result.earningsTrend || {};

    const recLatest = recommendationTrend?.trend?.[0] || null;
    const rec = recLatest
      ? {
          period: recLatest.period ?? null,
          strongBuy: pickRaw(recLatest.strongBuy) ?? null,
          buy: pickRaw(recLatest.buy) ?? null,
          hold: pickRaw(recLatest.hold) ?? null,
          sell: pickRaw(recLatest.sell) ?? null,
          strongSell: pickRaw(recLatest.strongSell) ?? null
        }
      : null;

    const target = {
      low: pickRaw(financialData.targetLowPrice) ?? null,
      avg: pickRaw(financialData.targetMeanPrice) ?? null,
      high: pickRaw(financialData.targetHighPrice) ?? null,
      analystCount: pickRaw(financialData.numberOfAnalystOpinions) ?? null,
      recommendationKey: financialData.recommendationKey ?? null,
      recommendationMean: pickRaw(financialData.recommendationMean) ?? null
    };

    // earningsTrend.trend: 여러 기간이 있으므로 0번째(대개 currentQtr)를 우선 사용
    const et0 = earningsTrend?.trend?.[0] || null;
    const earningsEstimate = et0?.earningsEstimate
      ? {
          period: et0.period ?? null,
          low: pickRaw(et0.earningsEstimate.low) ?? null,
          avg: pickRaw(et0.earningsEstimate.avg) ?? null,
          high: pickRaw(et0.earningsEstimate.high) ?? null,
          yearAgoEps: pickRaw(et0.earningsEstimate.yearAgoEps) ?? null
        }
      : null;

    const out = {
      ok: true,
      source: "yahoo",
      symbol: symbolRaw,
      asOf: new Date().toISOString(),
      price: {
        currency: price?.currency ?? null,
        regularMarketPrice: pickRaw(price?.regularMarketPrice) ?? null,
        shortName: price?.shortName ?? null
      },
      recommendation: rec,
      targetPrice: target,
      earningsEstimate
    };

    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    const status = Number(e?.status || 502);
    const details = String(e?.details || e?.message || e);
    const cause = e?.cause ? String(e.cause) : "";
    return sendJson(res, 502, { ok: false, error: "Yahoo consensus request error", status, details: cause ? `${details}\nCAUSE: ${cause}` : details });
  }
}

async function fetchYahooQuoteSummary(symbolRaw, modules) {
  const baseUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbolRaw)}`;
  const urlNoCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}`;
  const data = await (async () => {
    // 1) crumb 없이 시도
    const first = await httpsGetText(urlNoCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (first.status >= 200 && first.status < 300) return JSON.parse(first.body || "{}");
    const errText = first.body || "";

    // 2) Invalid Crumb(401)인 경우에만 crumb/cookie 획득 후 재시도
    if (first.status !== 401 || !/crumb/i.test(errText)) {
      const details = errText.slice(0, 2000);
      const e = new Error("Yahoo quoteSummary request failed");
      e.status = first.status;
      e.details = details;
      throw e;
    }

    const { crumb, cookie } = await getYahooCrumbAndCookie(symbolRaw);
    const urlWithCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
    const second = await httpsGetText(urlWithCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Cookie": cookie });
    if (second.status < 200 || second.status >= 300) {
      const t = second.body || "";
      const e = new Error("Yahoo quoteSummary request failed");
      e.status = second.status;
      e.details = t.slice(0, 2000);
      throw e;
    }
    return JSON.parse(second.body || "{}");
  })();

  return data?.quoteSummary?.result?.[0] || {};
}

function pickObj(obj, keys) {
  const o = obj && typeof obj === "object" ? obj : {};
  const out = {};
  for (const k of keys) out[k] = k in o ? o[k] : null;
  return out;
}

function slimQuarterlyStatements(list, maxRows = 6) {
  const rows = Array.isArray(list) ? list : [];
  return rows.slice(0, maxRows).map((r) => ({
    endDate: pickRaw(r?.endDate) ?? null,
    totalRevenue: pickRaw(r?.totalRevenue) ?? null,
    costOfRevenue: pickRaw(r?.costOfRevenue) ?? null,
    grossProfit: pickRaw(r?.grossProfit) ?? null,
    researchDevelopment: pickRaw(r?.researchDevelopment) ?? null,
    sellingGeneralAdministrative: pickRaw(r?.sellingGeneralAdministrative) ?? null,
    totalOperatingExpenses: pickRaw(r?.totalOperatingExpenses) ?? null,
    operatingIncome: pickRaw(r?.operatingIncome) ?? null,
    netIncome: pickRaw(r?.netIncome) ?? null,
    operatingCashflow: pickRaw(r?.totalCashFromOperatingActivities) ?? pickRaw(r?.operatingCashflow) ?? null,
    capitalExpenditures: pickRaw(r?.capitalExpenditures) ?? null,
    freeCashFlow: pickRaw(r?.freeCashFlow) ?? null,
    totalAssets: pickRaw(r?.totalAssets) ?? null,
    totalLiab: pickRaw(r?.totalLiab) ?? null,
    cash: pickRaw(r?.cash) ?? pickRaw(r?.cashAndCashEquivalents) ?? null,
    longTermDebt: pickRaw(r?.longTermDebt) ?? null
  }));
}

async function handleYahooFinancials(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const symbolRaw = tvSymbolToYahooSymbol(url.searchParams.get("symbol") || "AAPL");
  if (!isSafeYahooSymbol(symbolRaw)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });

  const cacheKey = `financials|${symbolRaw}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 60_000) return sendJson(res, 200, { ...cached.data, cached: true });

  // NOTE: Yahoo는 비공식이며 형식/정책이 바뀔 수 있음. 모듈도 최소한만 사용.
  const modules = [
    "price",
    "summaryProfile",
    "defaultKeyStatistics",
    "calendarEvents",
    "earnings",
    "earningsHistory",
    "incomeStatementHistoryQuarterly",
    "balanceSheetHistoryQuarterly",
    "cashflowStatementHistoryQuarterly"
  ].join(",");

  try {
    const result = await fetchYahooQuoteSummary(symbolRaw, modules);

    const price = result.price || {};
    const profile = result.summaryProfile || {};
    const keyStats = result.defaultKeyStatistics || {};
    const calendarEvents = result.calendarEvents || {};
    const earnings = result.earnings || {};
    const earningsHistory = result.earningsHistory || {};

    const isq = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const bsq = result.balanceSheetHistoryQuarterly?.balanceSheetStatements || [];
    const cfq = result.cashflowStatementHistoryQuarterly?.cashflowStatements || [];

    const out = {
      ok: true,
      source: "yahoo",
      symbol: symbolRaw,
      asOf: new Date().toISOString(),
      price: {
        shortName: price?.shortName ?? null,
        longName: price?.longName ?? null,
        exchangeName: price?.exchangeName ?? null,
        currency: price?.currency ?? null,
        marketState: price?.marketState ?? null,
        regularMarketPrice: pickRaw(price?.regularMarketPrice) ?? null,
        regularMarketTime: pickRaw(price?.regularMarketTime) ?? null
      },
      profile: pickObj(profile, [
        "sector",
        "industry",
        "country",
        "website",
        "longBusinessSummary",
        "fullTimeEmployees"
      ]),
      keyStats: pickObj(keyStats, [
        "marketCap",
        "enterpriseValue",
        "trailingPE",
        "forwardPE",
        "priceToBook",
        "beta",
        "sharesOutstanding"
      ]),
      calendarEvents: {
        earnings: Array.isArray(calendarEvents?.earnings?.earningsDate)
          ? calendarEvents.earnings.earningsDate.map((d) => pickRaw(d)).filter(Boolean).slice(0, 4)
          : []
      },
      earnings: {
        financialsChart: earnings?.financialsChart || null,
        earningsChart: earnings?.earningsChart || null
      },
      earningsHistory: Array.isArray(earningsHistory?.history)
        ? earningsHistory.history.slice(0, 8).map((h) => ({
            quarter: pickRaw(h?.quarter) ?? null,
            period: h?.period ?? null,
            epsActual: pickRaw(h?.epsActual) ?? null,
            epsEstimate: pickRaw(h?.epsEstimate) ?? null,
            epsDifference: pickRaw(h?.epsDifference) ?? null,
            surprisePercent: pickRaw(h?.surprisePercent) ?? null
          }))
        : [],
      statements: {
        incomeQuarterly: slimQuarterlyStatements(isq, 6),
        balanceQuarterly: slimQuarterlyStatements(bsq, 6),
        cashflowQuarterly: slimQuarterlyStatements(cfq, 6)
      }
    };

    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    const status = Number(e?.status || 502);
    const details = String(e?.details || e?.message || e);
    const cause = e?.cause ? String(e.cause) : "";
    return sendJson(res, 502, { ok: false, error: "Yahoo financials request error", status, details: cause ? `${details}\nCAUSE: ${cause}` : details });
  }
}

async function handleYahooScreener(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const scrId = String(url.searchParams.get("scrId") || "largest_market_cap");
  const count = Math.max(1, Math.min(50, Number(url.searchParams.get("count") || 25)));
  if (!isSafeYahooScreenerId(scrId)) return sendJson(res, 400, { ok: false, error: "Invalid scrId" });

  const cacheKey = `screener|${scrId}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) {
    return sendJson(res, 200, { ...cached.data, cached: true });
  }

  const yahooUrl = `${"https://query1.finance.yahoo.com"}/v1/finance/screener/predefined/saved?count=${encodeURIComponent(
    String(count)
  )}&scrIds=${encodeURIComponent(scrId)}`;

  try {
    const resp = await fetch(yahooUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "Yahoo screener request failed", status: resp.status, details: errText.slice(0, 2000) });
    }

    const data = await resp.json();
    const result = data?.finance?.result?.[0];
    const title = result?.title || scrId;
    const quotes = Array.isArray(result?.quotes) ? result.quotes : [];

    const rows = quotes.slice(0, count).map((q) => ({
      symbol: q?.symbol,
      name: q?.shortName || q?.longName || q?.displayName || "",
      exchange: q?.exchange || q?.fullExchangeName || "",
      price: q?.regularMarketPrice ?? null,
      changePct: q?.regularMarketChangePercent ?? null,
      marketCap: q?.marketCap ?? null,
      volume: q?.regularMarketVolume ?? null,
      currency: q?.currency || ""
    }));

    const out = { ok: true, source: "yahoo", scrId, title, count, rows };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo screener request error", details: String(e?.message || e) });
  }
}

function extractAssistantTextFromChatCompletions(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;

  // 1) Most common: string content
  if (typeof msg?.content === "string") return msg.content;

  // 1.5) Some may return object content
  if (msg?.content && typeof msg.content === "object" && !Array.isArray(msg.content)) {
    const c = msg.content;
    if (typeof c?.text === "string") return c.text;
    if (typeof c?.text?.value === "string") return c.text.value;
    if (typeof c?.value === "string") return c.value;
  }

  // 2) Some models may return refusal separately
  if (typeof msg?.refusal === "string" && msg.refusal) return msg.refusal;

  // 3) Some may return array-of-parts content
  if (Array.isArray(msg?.content)) {
    const parts = msg.content
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
      .filter(Boolean);
    return parts.join("");
  }

  // 4) Legacy
  if (typeof choice?.text === "string") return choice.text;

  // 5) Responses API-like fallback
  if (typeof data?.output_text === "string") return data.output_text;

  return "";
}

function extractDeltaFromChatCompletionsChunk(data) {
  const choice = data?.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.text?.value === "string") return p.text.value;
        if (typeof p?.text?.text === "string") return p.text.text;
        if (typeof p?.text?.content === "string") return p.text.content;
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof delta.refusal === "string" && delta.refusal) return delta.refusal;
  return "";
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
  // 숫자/퍼센트/통화/단위 등
  return /(\d+([.,]\d+)?|%|\$|usd|krw|원|달러|엔|€|£)/i.test(String(text || ""));
}

function hasDisallowedFinanceAdvice(text) {
  const t = String(text || "");
  // 추천/매수/매도/롱/숏/목표가/손절/수익률 등 “판단” 느낌을 강하게 주는 표현
  return /(매수|매도|추천|사라|팔아|롱|숏|목표가|손절|익절|수익률|수익|손실|투자\s*조언|포지션|진입|청산)/i.test(t);
}

function hasDisallowedAnalysisWord(text) {
  // UX 제약: “분석”이라는 용어 금지
  return /(분석|리포트|리서치\s*리포트)/i.test(String(text || ""));
}

async function perplexityGroundingJSON({ query, symbol, view }) {
  if (!PERPLEXITY_API_KEY) {
    return { topics: [], sources: [], notes: "PERPLEXITY_API_KEY 미설정으로 자료 수집 생략" };
  }

  const system = [
    "당신은 금융 정보의 '자료 수집' 단계 에이전트입니다.",
    "목표: 실시간 웹에서 사용자의 질문과 관련된 공개 정보의 '존재 여부'와 '관점 분포'만 수집합니다.",
    "절대 금지: 숫자/퍼센트/가격/계산/사실 판정/결론/투자 조언.",
    "출력은 JSON만. 마크다운/설명/코드펜스 금지.",
    "",
    "출력 포맷:",
    "{",
    "  \"topics\": [\"관점1\", \"관점2\"],",
    "  \"sources\": [{\"title\":\"...\",\"url\":\"...\"}],",
    "  \"notes\": \"상충 관점 여부\"",
    "}"
  ].join("\n");

  const user = [
    `대상: ${symbol}`,
    `현재 화면: ${view}`,
    `질문: ${query}`,
    "",
    "요구사항: 숫자/퍼센트/가격을 쓰지 말고, 관점과 출처 링크만 JSON으로 반환."
  ].join("\n");

  const resp = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_tokens: 700
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Perplexity grounding failed: ${resp.status} ${t.slice(0, 500)}`);
  }
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text) || {};

  // 스키마 정리
  const topics = Array.isArray(json.topics) ? json.topics.map((x) => String(x)).slice(0, 12) : [];
  const sourcesRaw = Array.isArray(json.sources) ? json.sources : [];
  const sources = sourcesRaw
    .slice(0, 8)
    .map((s) => ({ title: String(s?.title || ""), url: String(s?.url || "") }))
    .filter((s) => s.url.startsWith("http"));
  const notes = String(json.notes || "");

  // 방어: 자료 수집 단계에서 숫자 금지
  return {
    topics: topics.filter((x) => !hasNumbers(x)),
    sources,
    notes: hasNumbers(notes) ? "" : notes
  };
}

async function gptExplain({ symbol, interval, view, question, yahooOhlcv, yahooScreener, yahooConsensus, grounding }) {
  const system = [
    "당신은 금융 정보를 '이해하기 쉽게 설명'하는 보조자입니다.",
    "역할: 공개 웹 정보(자료 수집 결과)와 정형 데이터(Yahoo)를 바탕으로 사용자의 이해를 돕는 구조화된 설명을 제공합니다.",
    "",
    "절대 금지:",
    "- 투자 판단/추천/예측/단정",
    "- 수치/퍼센트/가격/목표가/EPS 등 숫자 언급",
    "- 계산",
    "- '분석'이라는 단어 사용",
    "",
    "허용:",
    "- \"웹에서는 이런 관점이 언급된다\"",
    "- \"일반적으로 이런 맥락에서 설명된다\"",
    "- \"확인할 체크리스트\"",
    "",
    "출력 형식(항상 한국어, 마크다운):",
    "## 요약",
    "## 웹에서 언급되는 관점(요약)",
    "## 이해를 돕는 맥락(일반론)",
    "## 확인 체크리스트(다음에 확인할 것)",
    "## 참고 링크"
  ].join("\n");

  const user = [
    `심볼: ${symbol}`,
    `타임프레임: ${interval}`,
    `현재 화면: ${view}`,
    "",
    `사용자 질문:\n${question}`,
    "",
    "자료 수집 결과(내부 참고):",
    JSON.stringify(grounding || {}, null, 2),
    "",
    "Yahoo 데이터(내부 참고, 숫자를 '말로' 출력하지 말 것):",
    `- OHLCV: ${yahooOhlcv ? "제공됨" : "없음"}`,
    `- Screener rows: ${yahooScreener ? "제공됨" : "없음"}`,
    `- Consensus: ${yahooConsensus ? "제공됨" : "없음"}`,
    "",
    "주의: 최종 출력에 숫자/퍼센트/가격/목표가/EPS를 포함하지 마세요."
  ].join("\n");

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.4,
      max_completion_tokens: 900
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`GPT explain failed: ${resp.status} ${t.slice(0, 500)}`);
  }
  const data = await resp.json();
  return extractAssistantTextFromChatCompletions(data);
}

async function gptVerifier({ draft }) {
  const system = [
    "당신은 출력 검증기입니다. 아래 텍스트가 정책을 위반하는지 검사합니다.",
    "검사 항목:",
    "- 투자 판단/조언/추천/예측/단정 여부",
    "- '분석' 단어 사용 여부",
    "- 숫자/퍼센트/가격/단위 언급 여부",
    "",
    "출력은 JSON만. 형식:",
    "{",
    "  \"verdict\": \"PASS\" | \"WARN\" | \"FAIL\",",
    "  \"violations\": [{\"type\":\"...\",\"sentence\":\"...\",\"reason\":\"...\"}],",
    "  \"suggestion\": \"...\"",
    "}"
  ].join("\n");

  const user = `검증 대상 텍스트:\n${draft}`;

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_completion_tokens: 600
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { verdict: "WARN", violations: [], suggestion: `검증기 호출 실패: ${resp.status}`.trim(), _raw: t.slice(0, 500) };
  }
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  return extractJsonObject(text) || { verdict: "WARN", violations: [], suggestion: "검증기 JSON 파싱 실패" };
}

async function geminiVerifier({ draft }) {
  // Gemini 키가 없으면 정규식 기반으로 대체
  if (!GEMINI_API_KEY) {
    return {
      has_numbers: hasNumbers(draft),
      risk_phrases: [
        ...(hasDisallowedFinanceAdvice(draft) ? ["finance_advice_like"] : []),
        ...(hasDisallowedAnalysisWord(draft) ? ["analysis_word"] : [])
      ],
      format_issues: []
    };
  }

  const prompt = [
    "너는 출력 검증기다. 다음 텍스트를 검사하고 JSON만 출력해라.",
    "검사:",
    "- 숫자/퍼센트/통화/단위가 등장하는지",
    "- 투자 판단/조언/추천/예측처럼 보이는 문구",
    "- '분석' 용어 사용",
    "",
    "출력(JSON):",
    "{",
    "  \"has_numbers\": true/false,",
    "  \"risk_phrases\": [\"...\"],",
    "  \"format_issues\": [\"...\"]",
    "}",
    "",
    "텍스트:",
    draft
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 400 }
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { has_numbers: true, risk_phrases: ["gemini_call_failed"], format_issues: [String(resp.status)] , _raw: t.slice(0,500)};
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
  return extractJsonObject(text) || { has_numbers: true, risk_phrases: ["gemini_parse_failed"], format_issues: [] };
}

// ----------------------------
// "인간 사고 모사" 종합 판단 파이프라인 (RAG 기반, 다단계)
// ----------------------------

const JUDGE_PROMPT_V = "judge_v1.0";

function safeJsonForPrompt(obj, maxLen) {
  const t = JSON.stringify(obj ?? {}, null, 2);
  return t.length > maxLen ? t.slice(0, maxLen) + "\n...TRUNCATED..." : t;
}

function deriveMarketBehaviorFromCandles(candles) {
  const rows = Array.isArray(candles) ? candles : [];
  if (rows.length < 10) return { label: "데이터 부족", notes: "캔들 수가 충분하지 않습니다.", stats: null };
  const closes = rows.map((r) => Number(r?.c)).filter((x) => Number.isFinite(x));
  if (closes.length < 10) return { label: "데이터 부족", notes: "종가 데이터가 부족합니다.", stats: null };

  const first = closes[0];
  const last = closes[closes.length - 1];
  const pct = first ? (last - first) / first : 0;

  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!a) continue;
    rets.push((b - a) / a);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const varr = rets.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (rets.length || 1);
  const vol = Math.sqrt(varr);

  let trend = "횡보";
  if (pct > 0.04) trend = "상승";
  if (pct < -0.04) trend = "하락";

  let volLabel = "보통";
  if (vol > 0.03) volLabel = "높음";
  if (vol < 0.012) volLabel = "낮음";

  return {
    label: `${trend} 추세 / 변동성 ${volLabel}`,
    notes: "최근 캔들 기반의 간단 요약(정규화된 시장 신호).",
    stats: { trendPctApprox: pct, volApprox: vol, n: closes.length }
  };
}

function buildRagBundle({ symbolRaw, financials, news, ohlcv, peers }) {
  const docs = [];
  const nowIso = new Date().toISOString();

  // Financial doc (quarterly)
  if (financials?.ok) {
    docs.push({
      doc_id: `${symbolRaw}/profile/current`,
      symbol: symbolRaw,
      type: "company_profile",
      period: "current",
      source: "yahoo",
      asOf: financials.asOf || nowIso,
      payload: {
        price: financials.price,
        profile: financials.profile,
        keyStats: financials.keyStats
      }
    });
    docs.push({
      doc_id: `${symbolRaw}/income_statement/quarterly`,
      symbol: symbolRaw,
      type: "income_statement",
      period: "quarterly_recent",
      source: "yahoo",
      asOf: financials.asOf || nowIso,
      payload: financials.statements?.incomeQuarterly || []
    });
    docs.push({
      doc_id: `${symbolRaw}/balance_sheet/quarterly`,
      symbol: symbolRaw,
      type: "balance_sheet",
      period: "quarterly_recent",
      source: "yahoo",
      asOf: financials.asOf || nowIso,
      payload: financials.statements?.balanceQuarterly || []
    });
    docs.push({
      doc_id: `${symbolRaw}/cashflow/quarterly`,
      symbol: symbolRaw,
      type: "cashflow",
      period: "quarterly_recent",
      source: "yahoo",
      asOf: financials.asOf || nowIso,
      payload: financials.statements?.cashflowQuarterly || []
    });
    docs.push({
      doc_id: `${symbolRaw}/earnings_event/recent`,
      symbol: symbolRaw,
      type: "earnings_event",
      period: "recent",
      source: "yahoo",
      asOf: financials.asOf || nowIso,
      payload: {
        calendarEvents: financials.calendarEvents || {},
        earningsHistory: financials.earningsHistory || []
      }
    });
  }

  // News doc
  if (news?.ok) {
    docs.push({
      doc_id: `${symbolRaw}/news/recent`,
      symbol: symbolRaw,
      type: "news",
      period: "recent",
      source: "yahoo",
      asOf: news.asOf || nowIso,
      payload: (Array.isArray(news.items) ? news.items : []).slice(0, 16)
    });
  }

  // Market behavior doc
  if (ohlcv?.ok) {
    const mb = deriveMarketBehaviorFromCandles(ohlcv.candles);
    docs.push({
      doc_id: `${symbolRaw}/market_behavior/recent`,
      symbol: symbolRaw,
      type: "market_behavior",
      period: `${ohlcv.range || "recent"}_${ohlcv.interval || ""}`.trim(),
      source: "yahoo",
      asOf: nowIso,
      payload: { summary: mb, candles: (Array.isArray(ohlcv.candles) ? ohlcv.candles : []).slice(-120) }
    });
  }

  // Peer comparison doc
  if (peers?.ok) {
    docs.push({
      doc_id: `${symbolRaw}/peer_comparison/industry`,
      symbol: symbolRaw,
      type: "peer_comparison",
      period: "current",
      source: "yahoo",
      asOf: peers.asOf || nowIso,
      payload: { peers: peers.peers || [], quotes: peers.quotes || [] }
    });
  }

  return {
    rag_version: "rag_v1.0",
    symbol: symbolRaw,
    asOf: nowIso,
    docs
  };
}

function minimizeRagBundleForStorage(rag) {
  const base = rag && typeof rag === "object" ? rag : { docs: [] };
  const docs = Array.isArray(base.docs) ? base.docs : [];
  const slim = docs.map((d) => {
    if (!d || typeof d !== "object") return d;
    if (d.type === "market_behavior") {
      const p = d.payload || {};
      const candles = Array.isArray(p?.candles) ? p.candles : [];
      return { ...d, payload: { summary: p?.summary || null, candles: candles.slice(-80) } };
    }
    if (d.type === "news") {
      const items = Array.isArray(d.payload) ? d.payload : Array.isArray(d.payload?.items) ? d.payload.items : [];
      return { ...d, payload: items.slice(0, 20) };
    }
    if (d.type === "peer_comparison") {
      const peers = d.payload?.peers || [];
      const quotes = Array.isArray(d.payload?.quotes) ? d.payload.quotes : [];
      return { ...d, payload: { peers: Array.isArray(peers) ? peers.slice(0, 8) : [], quotes: quotes.slice(0, 12) } };
    }
    // statements/profile는 그대로(이미 slim)
    return d;
  });
  return { ...base, docs: slim };
}

async function fetchYahooOhlcvSlim(symbolRaw, interval = "1d", range = "6mo") {
  const yahooUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolRaw)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false&events=div%7Csplit`;
  const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
  if (r.status < 200 || r.status >= 300) {
    const e = new Error("Yahoo OHLCV request failed");
    e.status = r.status;
    e.details = (r.body || "").slice(0, 2000);
    throw e;
  }
  const data = JSON.parse(r.body || "{}");
  const result = data?.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const vols = quote.volume || [];

  const candles = [];
  for (let i = 0; i < ts.length && candles.length < 220; i++) {
    const t = ts[i];
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    const v = vols[i];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    const iso = new Date(t * 1000).toISOString();
    candles.push({ t: iso, o, h, l, c, v: typeof v === "number" && Number.isFinite(v) ? v : null });
  }
  return { ok: true, source: "yahoo", symbol: symbolRaw, interval, range, candles };
}

async function fetchYahooNewsSlim(symbolRaw, count = 12) {
  const query = symbolRaw;
  const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${encodeURIComponent(String(count))}`;
  const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
  if (r.status < 200 || r.status >= 300) {
    const e = new Error("Yahoo news request failed");
    e.status = r.status;
    e.details = (r.body || "").slice(0, 2000);
    throw e;
  }
  const data = JSON.parse(r.body || "{}");
  const news = Array.isArray(data?.news) ? data.news : [];
  const items = news
    .map((n) => ({
      title: n?.title || "",
      link: n?.link || "",
      publisher: n?.publisher || n?.provider?.displayName || "",
      providerPublishTime: n?.providerPublishTime || null
    }))
    .filter((n) => n.link && String(n.link).startsWith("http"))
    .slice(0, count);
  return { ok: true, source: "yahoo", asOf: new Date().toISOString(), items };
}

function peersForSymbol(symbolRaw) {
  const map = {
    AAPL: ["MSFT", "GOOGL", "AMZN", "META"],
    MSFT: ["AAPL", "GOOGL", "AMZN", "ORCL"],
    NVDA: ["AMD", "INTC", "AVGO", "QCOM"],
    TSLA: ["GM", "F", "RIVN", "NIO"],
    AMZN: ["WMT", "COST", "MSFT", "GOOGL"],
    META: ["GOOGL", "SNAP", "PINS", "TTD"]
  };
  const base = String(symbolRaw || "").toUpperCase();
  const peers = map[base] || [];
  return peers.filter((x) => isSafeYahooSymbol(x)).slice(0, 8);
}

async function fetchYahooQuotes(symbols) {
  const list = Array.isArray(symbols) ? symbols.filter(Boolean).slice(0, 12) : [];
  if (!list.length) return [];
  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(list.join(","))}`;
  const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
  if (r.status < 200 || r.status >= 300) return [];
  const data = JSON.parse(r.body || "{}");
  const rows = Array.isArray(data?.quoteResponse?.result) ? data.quoteResponse.result : [];
  return rows.map((q) => ({
    symbol: q?.symbol || "",
    shortName: q?.shortName || q?.longName || "",
    currency: q?.currency || "",
    regularMarketPrice: q?.regularMarketPrice ?? null,
    regularMarketChangePercent: q?.regularMarketChangePercent ?? null,
    marketCap: q?.marketCap ?? null
  }));
}

async function fetchPeersBundle(symbolRaw) {
  const peers = peersForSymbol(symbolRaw);
  const quotes = await fetchYahooQuotes([symbolRaw, ...peers]);
  return { ok: true, source: "yahoo", asOf: new Date().toISOString(), peers, quotes };
}

async function gptSignalExtraction({ symbolRaw, question, rag }) {
  const system = [
    "너는 '신호 추출(Signal Extraction)' 에이전트다.",
    "입력으로 주어지는 RAG 문서(재무/이벤트/시장/비교)를 읽고, 사람이 인지할 만한 '신호'만 추출한다.",
    "",
    "규칙:",
    "- 단정 금지. 변화/대비/특이점은 '가능성이 있다/해석될 수 있다' 형태로 쓴다.",
    "- 투자 조언/매수·매도/목표가/수익 예측 금지.",
    "- 출력은 JSON만(설명/마크다운/코드펜스 금지).",
    "",
    "출력 포맷(키 고정):",
    "{",
    "  \"financial_signal\": \"...\",",
    "  \"event_signal\": \"...\",",
    "  \"market_signal\": \"...\",",
    "  \"peer_signal\": \"...\"",
    "}"
  ].join("\n");

  const user = [
    `대상: ${symbolRaw}`,
    `질문(옵션): ${String(question || "").slice(0, 800)}`,
    "",
    "RAG 문서(요약/정규화):",
    safeJsonForPrompt(rag, 120_000)
  ].join("\n");

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_completion_tokens: 700
    })
  });
  if (!resp.ok) throw new Error(`GPT signal extraction failed: ${resp.status}`);
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  if (!json) throw new Error("Signal extraction JSON parse failed");
  return {
    financial_signal: String(json.financial_signal || ""),
    event_signal: String(json.event_signal || ""),
    market_signal: String(json.market_signal || ""),
    peer_signal: String(json.peer_signal || "")
  };
}

async function gptStoryLinking({ symbolRaw, signals }) {
  const system = [
    "너는 '스토리 생성(Cause–Effect Linking)' 에이전트다.",
    "신호 간의 원인-결과 가설을 '조건부/가능성' 언어로 연결한다.",
    "",
    "규칙:",
    "- 단정 금지, 투자 조언 금지.",
    "- 수익 예측/목표가/매수·매도 금지.",
    "",
    "출력(한국어, 텍스트):",
    "- 3~6개의 가설을 bullet로",
    "- 각 bullet은 '재무 결과 ↔ 이벤트/맥락' 연결이 포함되게"
  ].join("\n");
  const user = `대상: ${symbolRaw}\n신호 JSON:\n${JSON.stringify(signals, null, 2)}`;
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.35,
      max_completion_tokens: 650
    })
  });
  if (!resp.ok) throw new Error(`GPT story linking failed: ${resp.status}`);
  const data = await resp.json();
  return extractAssistantTextFromChatCompletions(data);
}

async function gptMarketAgreement({ symbolRaw, signals, story }) {
  const system = [
    "너는 '시장 검증(Market Agreement Check)' 에이전트다.",
    "시장 신호(차트/변동성/반응)가 스토리에 동의하는지 검증한다.",
    "",
    "출력은 JSON만:",
    "{",
    "  \"agreement\": \"동의\" | \"부분 동의\" | \"불일치\",",
    "  \"reason\": \"...\"",
    "}"
  ].join("\n");
  const user = [
    `대상: ${symbolRaw}`,
    "시장 신호:",
    String(signals?.market_signal || ""),
    "",
    "스토리:",
    String(story || "")
  ].join("\n");
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_completion_tokens: 450
    })
  });
  if (!resp.ok) throw new Error(`GPT market agreement failed: ${resp.status}`);
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  return (
    json || {
      agreement: "부분 동의",
      reason: "JSON 파싱 실패로 보수적으로 처리"
    }
  );
}

async function gptPeerAdjustment({ symbolRaw, signals, story }) {
  const system = [
    "너는 '비교군 보정(Relative Adjustment)' 에이전트다.",
    "동종/유사 기업과 산업 맥락으로 해석이 과도하거나 왜곡되지 않게 보정한다.",
    "",
    "규칙:",
    "- 우열 판단 금지(누가 더 좋다/나쁘다 금지).",
    "- 투자 조언/매수·매도 금지.",
    "",
    "출력은 JSON만:",
    "{",
    "  \"adjustment\": \"...\",",
    "  \"industry_vs_company\": \"...\"",
    "}"
  ].join("\n");
  const user = [
    `대상: ${symbolRaw}`,
    "비교 신호:",
    String(signals?.peer_signal || ""),
    "",
    "스토리:",
    String(story || "")
  ].join("\n");
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.25,
      max_completion_tokens: 500
    })
  });
  if (!resp.ok) throw new Error(`GPT peer adjustment failed: ${resp.status}`);
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  return (
    json || {
      adjustment: String(text || ""),
      industry_vs_company: ""
    }
  );
}

async function gptFinalJudgement({ symbolRaw, signals, story, marketCheck, peerAdjust, rag, feedback }) {
  const system = [
    "너는 '조건부 종합 판단(Final Judgement)' 에이전트다.",
    "인간이 기업을 판단하는 사고 순서를 따른다: 재무→이벤트→시장(동의/불일치)→비교군 보정→조건부 종합.",
    "",
    "금지:",
    "- 매수/매도/추천/목표가/수익률 예측",
    "- 단정(확정적 표현) 남발",
    "",
    "출력 구조(한국어, 마크다운):",
    "1. 기업 현재 상황 요약",
    "2. 신호 간 일관성 / 충돌 지점",
    "3. 긍정적으로 해석될 수 있는 요소",
    "4. 주의가 필요한 요소",
    "5. 조건부 종합 판단(어떤 조건이 충족/변하면 해석이 바뀌는지)",
    "",
    "반드시 마지막에 고지 문구를 그대로 포함:",
    "“본 서비스는 정보 제공 및 이해 보조 목적의 AI 시스템이며,",
    "투자 권유 또는 재무 자문을 제공하지 않습니다.",
    "AI의 판단은 오류를 포함할 수 있습니다.”"
  ].join("\n");

  const user = [
    `대상: ${symbolRaw}`,
    feedback ? `\n[검증 피드백]\n${feedback}\n` : "",
    "\n[신호 JSON]\n",
    JSON.stringify(signals, null, 2),
    "\n[스토리]\n",
    String(story || ""),
    "\n[시장 검증]\n",
    JSON.stringify(marketCheck, null, 2),
    "\n[비교군 보정]\n",
    JSON.stringify(peerAdjust, null, 2),
    "\n[RAG(참고)]\n",
    safeJsonForPrompt({ doc_ids: (rag?.docs || []).map((d) => d.doc_id), asOf: rag?.asOf }, 8000)
  ].join("\n");

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.35,
      max_completion_tokens: 1100
    })
  });
  if (!resp.ok) throw new Error(`GPT final judgement failed: ${resp.status}`);
  const data = await resp.json();
  return extractAssistantTextFromChatCompletions(data);
}

async function gptPolicyVerifierJudgement({ draft }) {
  const system = [
    "너는 정책 검증기다. 아래 텍스트가 투자 조언/확신 과잉/규정 위반인지 검사한다.",
    "검사 항목:",
    "- 매수/매도/추천/목표가/수익 예측/확정적 문장",
    "- 오해 소지가 큰 법적/의학적/확정적 조언",
    "",
    "출력은 JSON만:",
    "{",
    "  \"verdict\": \"PASS\"|\"FAIL\",",
    "  \"reasons\": [\"...\"],",
    "  \"rewrite_hint\": \"...\"",
    "}"
  ].join("\n");
  const user = `검증 대상 텍스트:\n${draft}`;
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_completion_tokens: 450
    })
  });
  if (!resp.ok) return { verdict: "FAIL", reasons: ["policy_verifier_call_failed"], rewrite_hint: "출력 재작성 필요" };
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  return extractJsonObject(text) || { verdict: "FAIL", reasons: ["policy_verifier_parse_failed"], rewrite_hint: "출력 재작성 필요" };
}

async function geminiJudgementVerifier({ draft }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: true,
      numeric_or_period_issues: [],
      logic_direction_issues: [],
      notes: "GEMINI_API_KEY 미설정으로 Gemini 검증 생략"
    };
  }

  const prompt = [
    "너는 검증기다. 다음 텍스트에서 '수치/기간/논리 방향' 오류 가능성을 찾고 JSON만 출력해라.",
    "체크:",
    "- 기간 혼동(분기/연간, 과거/현재 혼동)",
    "- 숫자 연결 오류(증가/감소 방향 착각, 비교 기준 누락)",
    "- 논리 비약(원인-결과 단정)",
    "",
    "출력(JSON):",
    "{",
    "  \"ok\": true/false,",
    "  \"numeric_or_period_issues\": [\"...\"],",
    "  \"logic_direction_issues\": [\"...\"],",
    "  \"notes\": \"...\"",
    "}",
    "",
    "텍스트:",
    draft
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 450 }
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return { ok: false, numeric_or_period_issues: ["gemini_call_failed"], logic_direction_issues: [], notes: String(resp.status), _raw: t.slice(0, 500) };
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
  return extractJsonObject(text) || { ok: false, numeric_or_period_issues: ["gemini_parse_failed"], logic_direction_issues: [], notes: "" };
}

async function handleJudgeStream(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });
  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const symbolTv = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
  const symbolRaw = tvSymbolToYahooSymbol(symbolTv);
  if (!isSafeYahooSymbol(symbolRaw)) return sendJson(res, 400, { error: "Invalid symbol" });
  const question = clampStr(payload.question || "", 2000);

  sendSseHeaders(res);
  const run_id = `judge_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;

  try {
    sseEvent(res, { event: "status", data: { stage: "start", run_id, prompt_v: JUDGE_PROMPT_V } });

    // 0) 데이터 수집/정규화(RAG Bundle)
    sseEvent(res, { event: "status", data: { stage: "collect" } });
    const [financials, news, ohlcv, peers] = await Promise.all([
      (async () => {
        const f = await (async () => {
          const modules = [
            "price",
            "summaryProfile",
            "defaultKeyStatistics",
            "calendarEvents",
            "earnings",
            "earningsHistory",
            "incomeStatementHistoryQuarterly",
            "balanceSheetHistoryQuarterly",
            "cashflowStatementHistoryQuarterly"
          ].join(",");
          const result = await fetchYahooQuoteSummary(symbolRaw, modules);
          // reuse handler shaping by calling internal logic through handleYahooFinancials is messy → create a mini out
          const shaped = {
            ok: true,
            symbol: symbolRaw,
            asOf: new Date().toISOString(),
            price: {
              shortName: result?.price?.shortName ?? null,
              longName: result?.price?.longName ?? null,
              exchangeName: result?.price?.exchangeName ?? null,
              currency: result?.price?.currency ?? null,
              marketState: result?.price?.marketState ?? null,
              regularMarketPrice: pickRaw(result?.price?.regularMarketPrice) ?? null,
              regularMarketTime: pickRaw(result?.price?.regularMarketTime) ?? null
            },
            profile: pickObj(result?.summaryProfile || {}, [
              "sector",
              "industry",
              "country",
              "website",
              "longBusinessSummary",
              "fullTimeEmployees"
            ]),
            keyStats: pickObj(result?.defaultKeyStatistics || {}, [
              "marketCap",
              "enterpriseValue",
              "trailingPE",
              "forwardPE",
              "priceToBook",
              "beta",
              "sharesOutstanding"
            ]),
            calendarEvents: {
              earnings: Array.isArray(result?.calendarEvents?.earnings?.earningsDate)
                ? result.calendarEvents.earnings.earningsDate.map((d) => pickRaw(d)).filter(Boolean).slice(0, 4)
                : []
            },
            earningsHistory: Array.isArray(result?.earningsHistory?.history)
              ? result.earningsHistory.history.slice(0, 8).map((h) => ({
                  quarter: pickRaw(h?.quarter) ?? null,
                  period: h?.period ?? null,
                  epsActual: pickRaw(h?.epsActual) ?? null,
                  epsEstimate: pickRaw(h?.epsEstimate) ?? null,
                  surprisePercent: pickRaw(h?.surprisePercent) ?? null
                }))
              : [],
            statements: {
              incomeQuarterly: slimQuarterlyStatements(result?.incomeStatementHistoryQuarterly?.incomeStatementHistory || [], 6),
              balanceQuarterly: slimQuarterlyStatements(result?.balanceSheetHistoryQuarterly?.balanceSheetStatements || [], 6),
              cashflowQuarterly: slimQuarterlyStatements(result?.cashflowStatementHistoryQuarterly?.cashflowStatements || [], 6)
            }
          };
          return shaped;
        })();
        return f;
      })(),
      fetchYahooNewsSlim(symbolRaw, 12),
      fetchYahooOhlcvSlim(symbolRaw, "1d", "6mo"),
      fetchPeersBundle(symbolRaw)
    ]);

    const rag = buildRagBundle({ symbolRaw, financials, news, ohlcv, peers });
    const input_hash = sha256Hex(JSON.stringify({ symbolRaw, question, rag_version: rag.rag_version, docs: rag.docs.map((d) => ({ id: d.doc_id, type: d.type, asOf: d.asOf })) }));
    sseEvent(res, { event: "rag", data: { run_id, input_hash, rag_meta: { symbol: rag.symbol, asOf: rag.asOf, doc_ids: rag.docs.map((d) => d.doc_id) } } });
    // 클라이언트/DB 저장용(재현 가능성 ↑). UI에는 노출하지 않도록 클라이언트에서 별도 처리.
    sseEvent(res, { event: "rag_bundle", data: { rag: minimizeRagBundleForStorage(rag) } });

    if (!OPENAI_API_KEY) {
      sseEvent(res, {
        event: "final",
        data: {
          run_id,
          input_hash,
          answer:
            "현재 서버에 OPENAI_API_KEY가 설정되지 않아 종합 판단 파이프라인을 실행할 수 없습니다.\n\n" +
            "다음 단계:\n- .env 또는 환경변수에 OPENAI_API_KEY를 설정한 뒤 다시 시도해주세요.\n\n" +
            "“본 서비스는 정보 제공 및 이해 보조 목적의 AI 시스템이며,\n투자 권유 또는 재무 자문을 제공하지 않습니다.\nAI의 판단은 오류를 포함할 수 있습니다.”"
        }
      });
      sseEvent(res, { event: "done", data: {} });
      return res.end();
    }

    // 1) 신호 추출
    sseEvent(res, { event: "status", data: { stage: "signal_extract" } });
    const signals = await gptSignalExtraction({ symbolRaw, question, rag });
    sseEvent(res, { event: "signal", data: { signals } });

    // 2) 스토리 생성
    sseEvent(res, { event: "status", data: { stage: "story_link" } });
    const story = await gptStoryLinking({ symbolRaw, signals });
    sseEvent(res, { event: "story", data: { story } });

    // 3) 시장 검증
    sseEvent(res, { event: "status", data: { stage: "market_check" } });
    const marketCheck = await gptMarketAgreement({ symbolRaw, signals, story });
    sseEvent(res, { event: "market_check", data: { marketCheck } });

    // 4) 비교군 보정
    sseEvent(res, { event: "status", data: { stage: "peer_adjust" } });
    const peerAdjust = await gptPeerAdjustment({ symbolRaw, signals, story });
    sseEvent(res, { event: "peer_adjust", data: { peerAdjust } });

    // 5) 조건부 종합 판단 + 검증/재시도
    const maxAttempts = 3;
    let finalText = "";
    let policy = null;
    let gem = null;
    let feedback = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      sseEvent(res, { event: "status", data: { stage: "final_judgement", attempt } });
      finalText = await gptFinalJudgement({ symbolRaw, signals, story, marketCheck, peerAdjust, rag, feedback });

      sseEvent(res, { event: "status", data: { stage: "verify", attempt } });
      policy = await gptPolicyVerifierJudgement({ draft: finalText });
      gem = await geminiJudgementVerifier({ draft: finalText });

      const policyFail = String(policy?.verdict || "FAIL").toUpperCase() !== "PASS";
      const gemFail = gem?.ok === false && ((gem?.numeric_or_period_issues || []).length || (gem?.logic_direction_issues || []).length);

      if (!policyFail && !gemFail) break;
      if (attempt === maxAttempts) break;
      feedback = [
        policyFail ? `- 정책 위반 가능: ${JSON.stringify(policy?.reasons || [])}\n  힌트: ${policy?.rewrite_hint || ""}` : "",
        gemFail
          ? `- Gemini 검증 이슈:\n  수치/기간: ${(gem.numeric_or_period_issues || []).join(" | ")}\n  논리: ${(gem.logic_direction_issues || []).join(" | ")}`
          : ""
      ]
        .filter(Boolean)
        .join("\n");
    }

    sseEvent(res, { event: "final", data: { run_id, input_hash, answer: finalText, verifier: { policy, gemini: gem } } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "judge_stream_failed", details: String(e?.details || e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  }
}

async function gptVisionPortfolioExtract({ images, hintSymbol }) {
  const system = [
    "너는 포트폴리오 캡처 이미지에서 보유 종목 정보를 추출하는 에이전트다.",
    "목표: 이미지 내 텍스트(OCR) + 표/리스트 구조를 해석해, 종목/수량/매수가(가능하면 통화)만 구조화한다.",
    "",
    "중요 규칙:",
    "- 절대 추측하지 말 것(보이지 않으면 null).",
    "- 수익률/평가금액 등은 참고로 보이더라도 positions에는 넣지 말 것(필드는 최소화).",
    "- 종목명만 있고 티커가 없으면, 가능한 경우에만 ticker를 추정하되 confidence를 낮추고 notes에 근거를 남길 것.",
    "- 한국어/영어, 증권앱/엑셀/메모/손글씨 등 다양한 형식을 고려.",
    "",
    "출력은 JSON만(마크다운/설명/코드펜스 금지).",
    "포맷:",
    "{",
    "  \"positions\": [",
    "    {\"symbol\":\"AAPL\",\"name\":\"Apple\",\"qty\":10,\"avgPrice\":150.5,\"currency\":\"USD\",\"confidence\":0.8,\"notes\":\"...\"}",
    "  ],",
    "  \"warnings\": [\"...\"]",
    "}"
  ].join("\n");

  const content = [
    { type: "text", text: `힌트(선택): 사용자가 보고 있던 대표 심볼=${hintSymbol || ""}. 이 힌트는 참고만 하고, 이미지가 우선이다.` },
    ...images.map((dataUrl) => ({
      type: "image_url",
      image_url: { url: dataUrl }
    }))
  ];

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content }
      ],
      temperature: 0.0,
      max_completion_tokens: 900
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI vision failed: ${resp.status} ${t.slice(0, 500)}`);
  }
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  if (!json) throw new Error("Vision JSON parse failed");
  return json;
}

function normalizeExtractedPositions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const r of list) {
    const symbol = String(r?.symbol || "").trim().toUpperCase();
    if (!symbol) continue;
    if (!isSafeYahooSymbol(symbol)) continue;
    const qty = r?.qty === null || r?.qty === undefined || r?.qty === "" ? null : Number(r.qty);
    const avg = r?.avgPrice === null || r?.avgPrice === undefined || r?.avgPrice === "" ? null : Number(r.avgPrice);
    out.push({
      symbol,
      name: String(r?.name || "").trim(),
      qty: Number.isFinite(qty) ? qty : null,
      avgPrice: Number.isFinite(avg) ? avg : null,
      currency: r?.currency ? String(r.currency).trim().toUpperCase() : null,
      confidence: typeof r?.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : null,
      notes: String(r?.notes || "").trim()
    });
  }
  return out.slice(0, 120);
}

async function handlePortfolioExtract(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

  let payload;
  try {
    const raw = await readRequestBodyWithLimit(req, 8_000_000);
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    const msg = String(e?.message || e);
    return sendJson(res, 400, { ok: false, error: "Invalid request", details: msg });
  }

  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) return sendJson(res, 400, { ok: false, error: "No images" });
  if (images.length > 5) return sendJson(res, 400, { ok: false, error: "Too many images (max 5)" });

  const sanitized = images
    .map((x) => String(x || ""))
    .filter((x) => x.startsWith("data:image/"))
    .map((x) => (x.length > 2_000_000 ? x.slice(0, 2_000_000) : x));
  if (!sanitized.length) return sendJson(res, 400, { ok: false, error: "Invalid image format" });

  const hintSymbol = clampStr(payload.hint_symbol || "", 16);

  try {
    const out = await gptVisionPortfolioExtract({ images: sanitized, hintSymbol });
    const positions = normalizeExtractedPositions(out?.positions || []);
    const warnings = Array.isArray(out?.warnings) ? out.warnings.map((x) => String(x)).slice(0, 12) : [];
    return sendJson(res, 200, { ok: true, model: OPENAI_VISION_MODEL, positions, warnings });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "portfolio_extract_failed", details: String(e?.message || e) });
  }
}

async function handleChatStream(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
  const interval = clampStr(payload.interval || "D", 16);
  const view = clampStr(payload.view || "chart", 16);
  const question = clampStr(payload.question || "", 2000);
  const ohlcv = clampStr(payload.ohlcv || "", 200_000);
  const screener = clampStr(payload.screener || "", 200_000);
  const consensus = clampStr(payload.consensus || "", 12_000);

  sendSseHeaders(res);
  try {
    sseEvent(res, { event: "status", data: { stage: "start" } });

    // 1) 자료 수집(Perplexity)
    sseEvent(res, { event: "status", data: { stage: "grounding" } });
    let grounding = { topics: [], sources: [], notes: "" };
    try {
      grounding = await perplexityGroundingJSON({ query: question, symbol, view });
    } catch {
      grounding = { topics: [], sources: [], notes: "자료 수집 실패(무시)" };
    }

    // 2) 설명(GPT) + 3) 검증(Verifier) + 재시도
    const maxAttempts = 3;
    let draft = "";
    let verifier = null;
    let gem = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      sseEvent(res, { event: "status", data: { stage: "explain", attempt } });
      draft = await gptExplain({
        symbol,
        interval,
        view,
        question,
        yahooOhlcv: ohlcv,
        yahooScreener: screener,
        yahooConsensus: consensus,
        grounding
      });

      sseEvent(res, { event: "status", data: { stage: "verify", attempt } });

      // 빠른 로컬 가드레일(비용 절감)
      const localFail = hasNumbers(draft) || hasDisallowedFinanceAdvice(draft) || hasDisallowedAnalysisWord(draft);
      if (localFail && attempt < maxAttempts) {
        draft = ""; // 버리고 재시도
        continue;
      }

      verifier = await gptVerifier({ draft });
      gem = await geminiVerifier({ draft });

      const verdict = String(verifier?.verdict || "WARN").toUpperCase();
      const fail =
        verdict === "FAIL" ||
        gem?.has_numbers === true ||
        hasDisallowedFinanceAdvice(draft) ||
        hasDisallowedAnalysisWord(draft);

      if (!fail) break;
      if (attempt === maxAttempts) break;
    }

    // 최종 출력은 숫자/조언/분석 단어가 남아있으면 강제로 FAIL-safe(짧은 안내)
    if (hasNumbers(draft) || hasDisallowedFinanceAdvice(draft) || hasDisallowedAnalysisWord(draft)) {
      draft =
        "## 요약\n" +
        "요청하신 내용을 ‘공개 웹 정보 탐색·요약’ 범위에서 안전하게 설명하려 했지만, 출력 규칙(수치/투자판단/표현 제한)을 만족하는 형태로 정리하지 못했습니다.\n\n" +
        "## 다음 단계\n" +
        "- 질문을 ‘원인/맥락/관점’ 중심으로 다시 적어주세요(가격/목표가/수익률 같은 수치 표현 없이).\n" +
        "- 원하시면 ‘어떤 관점들이 언급되는지’와 ‘확인 체크리스트’ 형태로만 요약해드릴 수 있어요.\n\n" +
        "## 참고 링크\n" +
        (Array.isArray(grounding?.sources) && grounding.sources.length
          ? grounding.sources.slice(0, 5).map((s) => `- ${s.url}`).join("\n")
          : "- (자료 수집 결과 없음)");
    }

    // 최종 출력에 고지 문구 강제 포함
    const disclaimer =
      "\n\n---\n본 서비스는 금융 데이터를 제공하거나 투자 판단을 하지 않으며, 공개 웹 정보를 탐색·요약하는 도구입니다.\n";
    const finalText = `${draft}${disclaimer}`;

    sseEvent(res, { event: "final", data: { answer: finalText, grounding: { sources: grounding?.sources || [] } } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "chat_stream_failed", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  }
}

async function handleExplainStream(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
  const interval = clampStr(payload.interval || "D", 16);
  const view = clampStr(payload.view || "chart", 16);
  const userNotes = clampStr(payload.userNotes || "", 4000);
  const question = clampStr(payload.question || "", 2000);
  const ohlcvNorm = normalizeOhlcv(payload.ohlcv || "");
  const screenerNorm = normalizeScreener(payload.screener || "");
  const consensus = clampStr(payload.consensus || "", 12000);
  const researchAnswer = clampStr(payload.researchAnswer || "", 6000);
  const researchCitations = Array.isArray(payload.researchCitations) ? payload.researchCitations.slice(0, 10).map(String) : [];

  const system = [
    "당신은 트레이딩 해설 보조자입니다.",
    "사용자가 제공한 심볼/타임프레임/메모 및 (선택) OHLCV/스크리너 데이터를 바탕으로 교육 목적의 설명을 제공합니다.",
    "OHLCV가 없으면 수치 기반 단정은 피하고, 필요한 정보는 질문으로 되묻습니다.",
    "OHLCV가 있으면 간단한 추세/변동성/레벨 후보를 데이터 기반으로 설명하되, 예측을 단정하지 않습니다.",
    "투자 조언이 아니며, 리스크 관리(손절/포지션 사이징/시나리오) 관점에서 답합니다.",
    "",
    "출력 형식(항상 한국어, 마크다운):",
    "## 요약",
    "## 현재 구도(추세/변동성/모멘텀 가정)",
    "## 확인할 레벨(지지/저항 후보) — '추정'임을 명시",
    "## 가능한 시나리오(상승/하락/횡보)와 확인 신호",
    "## 리스크/주의사항",
    "## 사용자에게 되묻는 질문(부족한 정보 3개 이내)"
  ].join("\n");

  const input = [
    `심볼: ${symbol}`,
    `타임프레임(TradingView interval): ${interval}`,
    `현재 화면: ${view}`,
    userNotes ? `사용자 메모/관찰:\n${userNotes}` : "사용자 메모/관찰: (없음)",
    researchAnswer ? `Perplexity 리서치 요약(참고용):\n${researchAnswer}` : "Perplexity 리서치 요약: (없음)",
    researchCitations.length ? `Perplexity 출처(citations):\n- ${researchCitations.join("\n- ")}` : "Perplexity 출처(citations): (없음)",
    consensus ? `컨센서스(Yahoo, 참고용):\n${consensus}` : "컨센서스(Yahoo): (없음)",
    ohlcvNorm ? `OHLCV(최대 200봉):\n${JSON.stringify(ohlcvNorm, null, 2)}` : "OHLCV: (없음/파싱 실패)",
    screenerNorm ? `스크리너(최대 50행):\n${JSON.stringify(screenerNorm, null, 2)}` : "스크리너: (없음/파싱 실패)",
    question ? `요청/질문:\n${question}` : "요청/질문: (없음)"
  ].join("\n\n");

  // SSE 시작
  sendSseHeaders(res);
  sseEvent(res, { event: "meta", data: { symbol, interval, openai_enabled: Boolean(OPENAI_API_KEY), model: OPENAI_MODEL } });

  // OpenAI가 없으면 (스트리밍은) Perplexity 단발로 내려줌
  if (!OPENAI_API_KEY) {
    try {
      const out = await tryPerplexityExplain({ system, input });
      sseEvent(res, { event: "final", data: { mode: out?.mode || "perplexity", model: out?.model, answer: out?.answer || "", citations: out?.citations || [] } });
      sseEvent(res, { event: "done", data: {} });
      return res.end();
    } catch (e) {
      sseEvent(res, { event: "error", data: { error: "OpenAI disabled and Perplexity failed", details: String(e?.details || e?.message || e) } });
      sseEvent(res, { event: "done", data: {} });
      return res.end();
    }
  }

  // OpenAI 스트리밍
  let resp;
  try {
    resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ],
        temperature: 0.4,
        max_completion_tokens: 900,
        stream: true
      })
    });
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "LLM request error", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => "");
    sseEvent(res, { event: "error", data: { error: "LLM request failed", status: resp.status, details: errText.slice(0, 2000) } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let full = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE는 이벤트 사이가 \n\n
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n").map((l) => l.trimEnd());
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          if (dataStr === "[DONE]") {
            sseEvent(res, { event: "final", data: { mode: "openai", model: OPENAI_MODEL, answer: full } });
            sseEvent(res, { event: "done", data: {} });
            res.end();
            return;
          }
          let jsonChunk;
          try {
            jsonChunk = JSON.parse(dataStr);
          } catch {
            continue;
          }
          const delta = extractDeltaFromChatCompletionsChunk(jsonChunk);
          if (delta) {
            full += delta;
            sseEvent(res, { event: "delta", data: { delta } });
          }
        }
      }
    }
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "Stream error", details: String(e?.message || e) } });
  }

  // 스트림이 DONE 없이 끝난 경우
  if (full.trim()) {
    sseEvent(res, { event: "final", data: { mode: "openai", model: OPENAI_MODEL, answer: full } });
  } else {
    // OpenAI가 빈 응답이면 Perplexity로 1회 폴백
    try {
      const out = await tryPerplexityExplain({ system, input });
      sseEvent(res, { event: "final", data: { mode: out?.mode || "perplexity", model: out?.model, answer: out?.answer || "", citations: out?.citations || [], fallback_from: "openai_empty_stream" } });
    } catch (e) {
      sseEvent(res, { event: "error", data: { error: "Empty completion from OpenAI", details: String(e?.details || e?.message || e) } });
    }
  }
  sseEvent(res, { event: "done", data: {} });
  res.end();
}

async function tryPerplexityExplain({ system, input }) {
  if (!PERPLEXITY_API_KEY) return null;

  const resp = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input }
      ],
      temperature: 0.4,
      max_tokens: 900
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const e = new Error("Perplexity request failed");
    e.status = resp.status;
    e.details = errText.slice(0, 2000);
    throw e;
  }

  const data = await resp.json();
  const answer = extractAssistantTextFromChatCompletions(data);
  const citations = Array.isArray(data?.citations) ? data.citations : [];
  return { ok: true, mode: "perplexity", model: PERPLEXITY_MODEL, answer, citations };
}

async function handleYahooOhlcv(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const symbolRaw = tvSymbolToYahooSymbol(url.searchParams.get("symbol") || "AAPL");
  const interval = String(url.searchParams.get("interval") || "1d");
  const range = String(url.searchParams.get("range") || "6mo");

  if (!isSafeYahooSymbol(symbolRaw)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });
  if (!isSafeYahooInterval(interval)) return sendJson(res, 400, { ok: false, error: "Invalid interval" });
  if (!isSafeYahooRange(range)) return sendJson(res, 400, { ok: false, error: "Invalid range" });

  // 무료/비공식 엔드포인트 보호: 매우 짧은 캐시(동일 파라미터 연타 방지)
  const cacheKey = `${symbolRaw}|${interval}|${range}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) {
    return sendJson(res, 200, { ...cached.data, cached: true });
  }

  const yahooUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolRaw)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false&events=div%7Csplit`;

  try {
    const resp = await fetch(yahooUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "Yahoo request failed", status: resp.status, details: errText.slice(0, 2000) });
    }
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const vols = quote.volume || [];

    const candles = [];
    for (let i = 0; i < ts.length && candles.length < 200; i++) {
      const t = ts[i];
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      const v = vols[i];
      if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
      const iso = new Date(t * 1000).toISOString();
      candles.push({ t: iso, o, h, l, c, v: typeof v === "number" && Number.isFinite(v) ? v : null });
    }

    const out = { ok: true, source: "yahoo", symbol: symbolRaw, interval, range, candles };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo request error", details: String(e?.message || e) });
  }
}

function safeSymbolsList(raw) {
  const s = String(raw || "").trim();
  const list = (s || "^GSPC,^IXIC,^DJI,^VIX,^TNX")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 25);
  for (const sym of list) {
    if (!isSafeYahooSymbol(sym)) return null;
  }
  return list;
}

async function handleYahooIndices(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const symbols = safeSymbolsList(url.searchParams.get("symbols"));
  if (!symbols) return sendJson(res, 400, { ok: false, error: "Invalid symbols" });

  const cacheKey = `indices|${symbols.join(",")}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 20_000) return sendJson(res, 200, { ...cached.data, cached: true });

  try {
    const rows = [];
    for (const symbolRaw of symbols) {
      const yahooUrl =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolRaw)}` +
        `?interval=1d&range=5d&includePrePost=false&events=div%7Csplit`;
      const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (r.status < 200 || r.status >= 300) {
        return sendJson(res, 502, { ok: false, error: "Yahoo indices request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
      }
      const data = JSON.parse(r.body || "{}");
      const meta = data?.chart?.result?.[0]?.meta || {};
      rows.push({
        symbol: meta.symbol || symbolRaw,
        shortName: meta.shortName || null,
        longName: meta.longName || null,
        currency: meta.currency || null,
        regularMarketTime: meta.regularMarketTime || null,
        regularMarketPrice: meta.regularMarketPrice ?? null,
        previousClose: meta.previousClose ?? null,
        regularMarketChange: meta.regularMarketChange ?? null,
        regularMarketChangePercent: meta.regularMarketChangePercent ?? null
      });
    }
    const out = { ok: true, source: "yahoo", asOf: new Date().toISOString(), rows };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo indices request error", details: String(e?.message || e) });
  }
}

async function handleYahooQuotes(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = String(url.searchParams.get("symbols") || "").trim();
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);
  if (!list.length) return sendJson(res, 400, { ok: false, error: "Invalid symbols" });
  for (const sym of list) {
    if (!isSafeYahooSymbol(sym)) return sendJson(res, 400, { ok: false, error: "Invalid symbols" });
  }

  const cacheKey = `quotes|${list.join(",")}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) return sendJson(res, 200, { ...cached.data, cached: true });

  // NOTE: v7/finance/quote는 401이 나는 케이스가 있어, v8/finance/chart meta로 우회
  try {
    const quotes = [];
    for (const symbolRaw of list) {
      const yahooUrl =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolRaw)}` +
        `?interval=1d&range=5d&includePrePost=false&events=div%7Csplit`;
      const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (r.status < 200 || r.status >= 300) {
        return sendJson(res, 502, { ok: false, error: "Yahoo quotes request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
      }
      const data = JSON.parse(r.body || "{}");
      const meta = data?.chart?.result?.[0]?.meta || {};
      quotes.push({
        symbol: meta.symbol || symbolRaw,
        shortName: meta.shortName || meta.longName || "",
        currency: meta.currency || "",
        regularMarketPrice: meta.regularMarketPrice ?? null,
        regularMarketTime: meta.regularMarketTime || null,
        regularMarketChangePercent: meta.regularMarketChangePercent ?? null
      });
    }
    const out = { ok: true, source: "yahoo", asOf: new Date().toISOString(), quotes };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo quotes request error", details: String(e?.message || e) });
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isSafeQuery(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (s.length > 80) return false;
  return !/[\u0000-\u001f<>]/.test(s);
}

async function handleYahooNews(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  const query = clampStr(url.searchParams.get("q") || "stock market", 80).trim();
  const count = clampInt(url.searchParams.get("count") || url.searchParams.get("newsCount") || 12, 1, 20, 12);
  if (!isSafeQuery(query)) return sendJson(res, 400, { ok: false, error: "Invalid query" });

  const cacheKey = `news|${query}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 30_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${encodeURIComponent(
    String(count)
  )}`;

  try {
    const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo news request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }
    const data = JSON.parse(r.body || "{}");
    const news = Array.isArray(data?.news) ? data.news : [];
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    let items = news
      .map((n) => ({
        title: n?.title || "",
        link: n?.link || "",
        publisher: n?.publisher || n?.provider?.displayName || "",
        providerPublishTime: n?.providerPublishTime || null
      }))
      .filter((n) => n.link && String(n.link).startsWith("http"))
      .filter((n) => !n.providerPublishTime || Number(n.providerPublishTime) >= cutoff)
      .slice(0, count);

    // 특정 쿼리에서는 24시간 내 뉴스가 없을 수 있음 → 비어있으면 최신순 상위로 폴백
    if (!items.length && news.length) {
      items = news
        .map((n) => ({
          title: n?.title || "",
          link: n?.link || "",
          publisher: n?.publisher || n?.provider?.displayName || "",
          providerPublishTime: n?.providerPublishTime || null
        }))
        .filter((n) => n.link && String(n.link).startsWith("http"))
        .slice(0, count);
    }

    const out = { ok: true, source: "yahoo", q: query, asOf: new Date().toISOString(), items };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo news request error", details: String(e?.message || e) });
  }
}

async function handleYahooSymbolSearch(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const query = clampStr(url.searchParams.get("q") || "", 80).trim();
  const count = Math.max(1, Math.min(20, Number(url.searchParams.get("count") || 12)));
  if (!isSafeQuery(query)) return sendJson(res, 400, { ok: false, error: "Invalid query" });

  const cacheKey = `symbol_search|${query}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 30_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${encodeURIComponent(
    String(count)
  )}`;

  try {
    const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo symbol search failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }
    const data = JSON.parse(r.body || "{}");
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const items = quotes
      .map((q) => ({
        symbol: String(q?.symbol || "").trim(),
        name: String(q?.shortname || q?.longname || q?.shortName || q?.longName || "").trim(),
        exchDisp: String(q?.exchDisp || q?.exchange || "").trim(),
        quoteType: String(q?.quoteType || "").trim()
      }))
      .filter((x) => x.symbol && isSafeYahooSymbol(x.symbol))
      .filter((x) => !x.quoteType || /EQUITY|ETF|MUTUALFUND|CRYPTOCURRENCY|CURRENCY|INDEX/i.test(x.quoteType))
      .slice(0, count);

    const out = { ok: true, source: "yahoo", asOf: new Date().toISOString(), q: query, count, items };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo symbol search error", details: String(e?.message || e) });
  }
}

async function handleTickerEnrich(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "", 16).trim().toUpperCase();
  const nameEn = clampStr(payload.name_en || payload.name || "", 160).trim();
  if (!symbol || !isSafeYahooSymbol(symbol)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });
  if (!nameEn) return sendJson(res, 400, { ok: false, error: "Missing name_en" });

  const system = [
    "너는 미국/글로벌 상장사의 '종목 마스터' 보강 에이전트다.",
    "입력: 티커(symbol)와 영문 종목명(name_en).",
    "출력: 한국어 표기(name_ko) + 한국어/영문 별칭(alias) 후보를 만들어준다.",
    "",
    "규칙:",
    "- 사실 확정 금지. 번역/표기는 관용적으로 쓰이는 수준으로만 제안한다.",
    "- 과도한 별칭 생성 금지(짧고 실사용 중심).",
    "- 출력은 JSON만(설명/마크다운/코드펜스 금지).",
    "",
    "출력 포맷:",
    "{",
    "  \"name_ko\": \"...\",",
    "  \"aliases_ko\": [\"...\"],",
    "  \"aliases_en\": [\"...\"]",
    "}"
  ].join("\n");

  const user = JSON.stringify({ symbol, name_en: nameEn }, null, 2);

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_completion_tokens: 400
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return sendJson(res, 502, { ok: false, error: "ticker_enrich_failed", details: `${resp.status} ${t.slice(0, 800)}` });
  }

  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  if (!json) return sendJson(res, 502, { ok: false, error: "ticker_enrich_parse_failed", details: text.slice(0, 800) });

  const out = {
    ok: true,
    symbol,
    name_en: nameEn,
    name_ko: String(json?.name_ko || "").trim(),
    aliases_ko: Array.isArray(json?.aliases_ko) ? json.aliases_ko.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [],
    aliases_en: Array.isArray(json?.aliases_en) ? json.aliases_en.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []
  };

  return sendJson(res, 200, out);
}

function extractJsonArray(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
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

async function handleTickerEnrichBatch(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const itemsIn = Array.isArray(payload?.items) ? payload.items : [];
  const items = itemsIn
    .map((x) => ({
      symbol: clampStr(x?.symbol || "", 32).trim().toUpperCase(),
      name_en: clampStr(x?.name_en || x?.name || "", 160).trim()
    }))
    .filter((x) => x.symbol && isSafeYahooSymbol(x.symbol) && x.name_en)
    .slice(0, 60);

  if (!items.length) return sendJson(res, 400, { ok: false, error: "Missing items" });

  const system = [
    "너는 미국/글로벌 상장사의 '종목 마스터' 보강 에이전트다.",
    "입력: items 배열(각 항목은 symbol, name_en).",
    "출력: 각 symbol에 대해 한국어 표기(name_ko) + 한국어/영문 별칭(alias)을 생성한다.",
    "",
    "규칙:",
    "- 사실 확정/투자 조언 금지. 번역/표기는 관용적으로 쓰이는 수준으로만 제안한다.",
    "- 과도한 별칭 생성 금지(짧고 실사용 중심).",
    "- 출력은 JSON만(설명/마크다운/코드펜스 금지).",
    "- 반드시 입력 items와 같은 개수/순서로 배열을 반환한다.",
    "",
    "출력 포맷(JSON 배열):",
    "[",
    "  { \"symbol\":\"AAPL\", \"name_ko\":\"애플\", \"aliases_ko\":[\"애플\"], \"aliases_en\":[\"Apple\"] },",
    "  ...",
    "]"
  ].join("\n");

  const user = JSON.stringify({ items }, null, 2);

  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.2,
        max_completion_tokens: 1200
      })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_failed", provider: "openai", details: `${resp.status} ${t.slice(0, 1200)}` });
    }
    const data = await resp.json();
    const text = extractAssistantTextFromChatCompletions(data);
    const arr = extractJsonArray(text);
    if (!Array.isArray(arr)) return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_parse_failed", provider: "openai", details: text.slice(0, 1200) });
    const out = arr
      .map((x, idx) => ({
        symbol: items[idx]?.symbol || clampStr(x?.symbol || "", 32).trim().toUpperCase(),
        name_ko: String(x?.name_ko || "").trim(),
        aliases_ko: Array.isArray(x?.aliases_ko) ? x.aliases_ko.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : [],
        aliases_en: Array.isArray(x?.aliases_en) ? x.aliases_en.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : []
      }))
      .slice(0, items.length);
    return sendJson(res, 200, { ok: true, provider: "openai", model: "gpt-4.1-mini", items: out });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_error", provider: "openai", details: String(e?.message || e) });
  }
}

async function handleMarketInsight(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  // 5분 캐시(매크로 화면에서 5분마다 갱신 요구)
  globalThis.__insightCache ||= { ts: 0, data: null };
  const now = Date.now();
  const force = payload?.force === true;
  const cached = globalThis.__insightCache;
  if (!force && cached.data && now - cached.ts < 300_000) {
    return sendJson(res, 200, { ...cached.data, cached: true });
  }

  const indices = Array.isArray(payload.indices) ? payload.indices.slice(0, 12) : [];
  const news = Array.isArray(payload.news) ? payload.news.slice(0, 20) : [];
  const locale = clampStr(payload.locale || "ko", 8);

  // 키가 없으면 mock
  if (!OPENAI_API_KEY) {
    const out = {
      ok: true,
      mode: "mock",
      model: OPENAI_MODEL,
      asOf: new Date().toISOString(),
      insight:
        "## 오늘의 Market Insight\n" +
        "- 현재는 **OPENAI_API_KEY가 설정되지 않아** 예시 요약을 표시합니다.\n" +
        "- 지수/주요 뉴스의 흐름을 한 문단으로 정리하고, 확인할 체크포인트를 제시합니다.\n\n" +
        "## 체크포인트\n" +
        "- 주요 이벤트/발표 일정\n" +
        "- 변동성 확대 여부\n" +
        "- 섹터/대형주 중심의 수급 쏠림\n\n" +
        "---\n" +
        "본 서비스는 투자 판단을 하지 않습니다."
    };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  }

  const system = [
    "당신은 'Market Insight' 요약 작성자입니다.",
    "입력으로 제공되는 시장 지표(지수/통화/원자재/채권/선물)와 뉴스 헤드라인을 종합해 오늘의 시장 '상황 요약 + 해설'을 씁니다.",
    "",
    "절대 금지:",
    "- 투자 판단/추천/매수/매도/포지션/진입/청산 등 주문 유도(‘해야 한다’ 톤 금지)",
    "",
    "허용:",
    "- 수치/퍼센트/지표 값 언급(가능)",
    "- '전망'은 '가능한 시나리오/조건부'로만 표현(단정 금지)",
    "- \"현재 헤드라인에서 이런 쟁점이 부각\" 같은 관점 요약",
    "- '혼조/위험선호/위험회피' 같은 정성적 톤",
    "- 불확실성/상충 관점 명시",
    "- 오늘 확인할 체크포인트 제시(질문 형태 권장)",
    "",
    "출력(항상 한국어, 마크다운):",
    "## 오늘의 Market Insight",
    "### 상황 요약(지표/헤드라인 기반)",
    "### 주요 이슈(3~6개)",
    "### 해설(왜 중요할 수 있나)",
    "### 오늘의 관찰 포인트(체크리스트)",
    "### 단기 시나리오(조건부, 단정 금지)",
    "### 체크포인트(오늘 확인할 것)",
    "### 리스크/불확실성",
    "",
    "문체: 간결, 과장 금지, 단정 금지."
  ].join("\n");

  const compactIndices = indices.map((r) => ({
    symbol: r?.symbol,
    shortName: r?.shortName || r?.longName,
    // 값은 내부 참고용으로만 제공(출력 금지)
    regularMarketPrice: r?.regularMarketPrice ?? null,
    regularMarketChange: r?.regularMarketChange ?? null,
    regularMarketChangePercent: r?.regularMarketChangePercent ?? null
  }));
  const compactNews = news.map((n) => ({
    title: n?.title,
    link: n?.link,
    publisher: n?.publisher,
    providerPublishTime: n?.providerPublishTime ?? null
  }));

  const input = [
    `locale: ${locale}`,
    "",
    "indices (internal):",
    JSON.stringify(compactIndices, null, 2),
    "",
    "news (internal):",
    JSON.stringify(compactNews, null, 2),
    "",
    "주의: 투자 조언(매수/매도/추천)을 하지 마세요. 단정 대신 조건부로 설명하세요."
  ].join("\n");

  async function callOpenAI(messages, max_completion_tokens = 700) {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.35,
        max_completion_tokens
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const e = new Error("OpenAI request failed");
      e.status = resp.status;
      e.details = errText.slice(0, 2000);
      throw e;
    }
    const data = await resp.json();
    return extractAssistantTextFromChatCompletions(data);
  }

  function buildFallbackInsight({ indices: idx, news: nw }) {
    const topNews = (nw || [])
      .filter((n) => n && n.title)
      .slice(0, 6)
      .map((n) => `- ${String(n.title).trim()}`);
    return (
      "## 오늘의 Market Insight\n" +
      "### 상황 요약(지표/헤드라인 기반)\n" +
      "- GPT 호출이 불안정해 간단 요약으로 대체합니다.\n\n" +
      "### 주요 이슈(헤드라인 기반)\n" +
      (topNews.length ? topNews.join("\n") : "- (뉴스 없음)") +
      "\n\n" +
      "### 오늘의 관찰 포인트(체크리스트)\n" +
      "- 주가지수/채권수익률/달러/원자재의 방향성이 ‘정렬’되는지, ‘엇갈리는지’\n" +
      "- 헤드라인 키워드가 정책/물가/성장/실적/AI/지정학 중 어디로 쏠리는지\n" +
      "- 변동성 확대 신호가 있는지\n\n" +
      "---\n본 서비스는 투자 판단을 하지 않습니다."
    );
  }

  try {
    let insight = await callOpenAI([
      { role: "system", content: system },
      { role: "user", content: input }
    ]);

    let mode = "openai";
    if (!String(insight || "").trim()) {
      mode = "fallback";
      insight = buildFallbackInsight({ indices: compactIndices, news: compactNews });
    } else {
      insight = String(insight || "").trim() + "\n\n---\n본 서비스는 투자 판단을 하지 않습니다.";
    }

    const out = { ok: true, mode, model: OPENAI_MODEL, asOf: new Date().toISOString(), insight };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  } catch (e) {
    // 실패해도 UI가 깨지지 않도록 200 + fallback으로 반환
    const out = {
      ok: true,
      mode: "fallback",
      model: OPENAI_MODEL,
      asOf: new Date().toISOString(),
      error: "Market insight failed",
      details: String(e?.details || e?.message || e),
      insight: buildFallbackInsight({ indices: compactIndices, news: compactNews })
    };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  }
}

async function handleOrderSimulate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "", 32).trim();
  const side = String(payload.side || "").toUpperCase();
  const type = String(payload.type || "MARKET").toUpperCase();
  const qty = Math.max(0, Math.min(1_000_000, Math.floor(Number(payload.qty || 0))));
  const limitPrice = payload.limitPrice === null || payload.limitPrice === undefined ? null : Number(payload.limitPrice);

  if (!symbol || !isSafeYahooSymbol(symbol)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });
  if (!(side === "BUY" || side === "SELL")) return sendJson(res, 400, { ok: false, error: "Invalid side" });
  if (!(type === "MARKET" || type === "LIMIT")) return sendJson(res, 400, { ok: false, error: "Invalid type" });
  if (!qty) return sendJson(res, 400, { ok: false, error: "Invalid qty" });
  if (type === "LIMIT" && !(Number.isFinite(limitPrice) && limitPrice > 0)) {
    return sendJson(res, 400, { ok: false, error: "Invalid limitPrice" });
  }

  globalThis.__paperOrders ||= [];
  const id = `paper_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  async function fetchYahooLastPrice(yahooSymbol) {
    globalThis.__yahooQuoteCache ||= new Map();
    const cache = globalThis.__yahooQuoteCache;
    const now = Date.now();
    const cached = cache.get(yahooSymbol);
    if (cached && now - cached.ts < 10_000) return cached.data;

    const candidates = [yahooSymbol];
    if (yahooSymbol.includes(".")) candidates.push(yahooSymbol.replace(/\./g, "-"));

    for (const sym of candidates) {
      const yahooUrl =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
        `?interval=1m&range=1d&includePrePost=false&events=div%7Csplit`;
      const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (r.status < 200 || r.status >= 300) continue;
      try {
        const data = JSON.parse(r.body || "{}");
        const meta = data?.chart?.result?.[0]?.meta || {};
        const price = meta?.regularMarketPrice;
        if (typeof price === "number" && Number.isFinite(price)) {
          const out = {
            symbol: meta.symbol || sym,
            currency: meta.currency || null,
            regularMarketTime: meta.regularMarketTime || null,
            price
          };
          cache.set(yahooSymbol, { ts: now, data: out });
          return out;
        }
      } catch {
        // ignore parse errors
      }
    }
    return null;
  }

  const quote = await fetchYahooLastPrice(symbol).catch(() => null);

  // Fill simulation:
  // - MARKET: always filled (use Yahoo price as reference if available)
  // - LIMIT: filled only if limit crosses current Yahoo price (if available), otherwise accepted
  let status = "ACCEPTED";
  let filledQty = 0;
  let filledAt = null;
  let filledPrice = null;
  let filledCurrency = null;

  if (type === "MARKET") {
    status = "FILLED";
    filledQty = qty;
    filledAt = new Date().toISOString();
    if (quote?.price) {
      filledPrice = quote.price;
      filledCurrency = quote.currency || null;
    }
  } else {
    // LIMIT
    if (quote?.price && Number.isFinite(limitPrice)) {
      const px = quote.price;
      const crosses = side === "BUY" ? limitPrice >= px : limitPrice <= px;
      if (crosses) {
        status = "FILLED";
        filledQty = qty;
        filledAt = new Date().toISOString();
        filledPrice = px;
        filledCurrency = quote.currency || null;
      } else {
        status = "ACCEPTED";
        filledQty = 0;
      }
    } else {
      status = "ACCEPTED";
      filledQty = 0;
    }
  }

  const order = {
    id,
    createdAt,
    symbol,
    side,
    type,
    qty,
    limitPrice: type === "LIMIT" ? limitPrice : null,
    status,
    filledQty,
    filledAt,
    filledPrice,
    filledCurrency
  };
  globalThis.__paperOrders.unshift(order);
  globalThis.__paperOrders = globalThis.__paperOrders.slice(0, 200);

  return sendJson(res, 200, {
    ok: true,
    mode: "paper",
    disclaimer: "가상 주문(페이퍼)입니다. 실제 증권사 주문이 전송되지 않습니다.",
    order,
    market: quote
      ? {
          source: "yahoo",
          symbol: quote.symbol,
          price: quote.price,
          currency: quote.currency,
          regularMarketTime: quote.regularMarketTime
        }
      : null
  });
}

async function handleExplain(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
  const interval = clampStr(payload.interval || "D", 16);
  const view = clampStr(payload.view || "chart", 16);
  const userNotes = clampStr(payload.userNotes || "", 4000);
  const question = clampStr(payload.question || "", 2000);
  const ohlcvNorm = normalizeOhlcv(payload.ohlcv || "");
  const screenerNorm = normalizeScreener(payload.screener || "");
  const consensus = clampStr(payload.consensus || "", 12000);
  const researchAnswer = clampStr(payload.researchAnswer || "", 6000);
  const researchCitations = Array.isArray(payload.researchCitations) ? payload.researchCitations.slice(0, 10).map(String) : [];

  const system = [
    "당신은 트레이딩 해설 보조자입니다.",
    "사용자가 제공한 심볼/타임프레임/메모 및 (선택) OHLCV/스크리너 데이터를 바탕으로 교육 목적의 설명을 제공합니다.",
    "OHLCV가 없으면 수치 기반 단정은 피하고, 필요한 정보는 질문으로 되묻습니다.",
    "OHLCV가 있으면 간단한 추세/변동성/레벨 후보를 데이터 기반으로 설명하되, 예측을 단정하지 않습니다.",
    "투자 조언이 아니며, 리스크 관리(손절/포지션 사이징/시나리오) 관점에서 답합니다.",
    "",
    "출력 형식(항상 한국어, 마크다운):",
    "## 요약",
    "## 현재 구도(추세/변동성/모멘텀 가정)",
    "## 확인할 레벨(지지/저항 후보) — '추정'임을 명시",
    "## 가능한 시나리오(상승/하락/횡보)와 확인 신호",
    "## 리스크/주의사항",
    "## 사용자에게 되묻는 질문(부족한 정보 3개 이내)"
  ].join("\n");

  const inputParts = [
    `심볼: ${symbol}`,
    `타임프레임(TradingView interval): ${interval}`,
    `현재 화면: ${view}`,
    userNotes ? `사용자 메모/관찰:\n${userNotes}` : "사용자 메모/관찰: (없음)",
    researchAnswer ? `Perplexity 리서치 요약(참고용):\n${researchAnswer}` : "Perplexity 리서치 요약: (없음)",
    researchCitations.length ? `Perplexity 출처(citations):\n- ${researchCitations.join("\n- ")}` : "Perplexity 출처(citations): (없음)",
    consensus ? `컨센서스(Yahoo, 참고용):\n${consensus}` : "컨센서스(Yahoo): (없음)",
    ohlcvNorm ? `OHLCV(최대 200봉):\n${JSON.stringify(ohlcvNorm, null, 2)}` : "OHLCV: (없음/파싱 실패)",
    screenerNorm ? `스크리너(최대 50행):\n${JSON.stringify(screenerNorm, null, 2)}` : "스크리너: (없음/파싱 실패)",
    question ? `요청/질문:\n${question}` : "요청/질문: (없음)"
  ];
  const input = inputParts.join("\n\n");

  // OpenAI 키가 없으면 Perplexity로 자동 폴백(있을 때)
  if (!OPENAI_API_KEY) {
    if (!PERPLEXITY_API_KEY) {
      return sendJson(res, 200, {
        ok: true,
        mode: "mock",
        answer:
          "## 요약\n" +
          "현재는 **OPENAI_API_KEY가 설정되지 않아** 예시 응답을 반환합니다.\n\n" +
          "## 현재 구도(추세/변동성/모멘텀 가정)\n" +
          (ohlcvNorm
            ? `- **${symbol} / ${interval}**: OHLCV ${ohlcvNorm.length}봉을 받았어요. (여기서는 mock이라 계산은 생략)\n\n`
            : `- **${symbol} / ${interval}** 기준으로, 수치 데이터가 없으니 사용자의 관찰(고점/저점, 이동평균, 거래량 변화)을 알려주면 더 정확히 해설할 수 있어요.\n\n`) +
          "## 확인할 레벨(지지/저항 후보) — '추정'임을 명시\n" +
          "- **최근 스윙 고점/저점**, **갭**, **심리적 라운드 넘버**가 우선 후보입니다(추정).\n\n" +
          "## 가능한 시나리오(상승/하락/횡보)와 확인 신호\n" +
          "- **상승**: 직전 고점 돌파 후 눌림에서 지지 확인\n" +
          "- **하락**: 직전 저점 이탈 + 반등 시 저항 전환\n" +
          "- **횡보**: 레인지 상단/하단 반복 테스트\n\n" +
          "## 리스크/주의사항\n" +
          "- 데이터가 없으니 단정 금지. 포지션 사이징/손절 기준을 먼저 정하세요.\n\n" +
          "## 사용자에게 되묻는 질문(부족한 정보 3개 이내)\n" +
          "1) 최근 2~3개의 스윙 고점/저점 가격대가 어떻게 되나요?\n" +
          "2) 거래량은 추세 방향으로 동행하나요(증가/감소)?\n" +
          "3) 어떤 스타일인가요(단타/스윙/장기)와 리스크 허용폭은요?"
      });
    }

    try {
      const out = await tryPerplexityExplain({ system, input });
      return sendJson(res, 200, out);
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: "Perplexity request error", details: String(e?.details || e?.message || e) });
    }
  }

  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ],
        temperature: 0.4,
        max_completion_tokens: 800
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "LLM request failed", status: resp.status, details: errText.slice(0, 2000) });
    }

    const data = await resp.json();
    const answer = extractAssistantTextFromChatCompletions(data);
    if (!String(answer || "").trim()) {
      // OpenAI가 빈 응답이면 Perplexity로 재시도(있을 때)
      try {
        const out = await tryPerplexityExplain({ system, input });
        out.fallback_from = "openai_empty";
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: "Empty completion from OpenAI", details: String(e?.details || e?.message || e) });
      }
    }
    return sendJson(res, 200, { ok: true, mode: "openai", model: OPENAI_MODEL, answer });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "LLM request error", details: String(e?.message || e) });
  }
}

async function handleResearch(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  const symbol = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
  const query = clampStr(payload.query || payload.question || "", 2000).trim();
  const userNotes = clampStr(payload.userNotes || "", 2000);

  if (!query) return sendJson(res, 400, { ok: false, error: "query is required" });

  if (!PERPLEXITY_API_KEY) {
    return sendJson(res, 200, {
      ok: true,
      mode: "mock",
      answer:
        "## 리서치 요약\n" +
        "현재는 **PERPLEXITY_API_KEY가 설정되지 않아** 예시 응답을 반환합니다.\n\n" +
        "## 핵심 이슈(예시)\n" +
        `- ${symbol} 관련 뉴스/이슈를 요약하려면 Perplexity API 키를 설정하세요.\n\n` +
        "## 출처\n" +
        "- (mock) 실제 호출 시 citations(링크)이 함께 제공될 수 있습니다.\n",
      citations: []
    });
  }

  const system = [
    "당신은 금융 리서치 보조자입니다. 사용자의 질문에 대해 웹 기반 정보를 요약합니다.",
    "과장/추측을 피하고, 사실/해석/불확실성을 구분합니다.",
    "가능하면 최신 정보 위주로 요약하고, 중요한 주장에는 출처(citations)가 있으면 함께 제시합니다.",
    "항상 한국어로, 간결한 마크다운으로 답합니다.",
    "",
    "출력 형식:",
    "## 리서치 요약",
    "## 핵심 포인트(3~7개)",
    "## 촉매/리스크(불확실성 포함)",
    "## 차트 관점에 연결되는 체크리스트(3~6개)",
    "## 출처(있으면)"
  ].join("\n");

  const input = [
    `대상(심볼): ${symbol}`,
    userNotes ? `사용자 메모(선택):\n${userNotes}` : "사용자 메모(선택): (없음)",
    `질문:\n${query}`
  ].join("\n\n");

  try {
    const resp = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ],
        temperature: 0.2,
        max_tokens: 900
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "Perplexity request failed", status: resp.status, details: errText.slice(0, 2000) });
    }

    const data = await resp.json();
    const answer = data?.choices?.[0]?.message?.content || "";
    const citations = Array.isArray(data?.citations) ? data.citations : [];
    return sendJson(res, 200, { ok: true, mode: "perplexity", model: PERPLEXITY_MODEL, answer, citations });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Perplexity request error", details: String(e?.message || e) });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const filePath = safeJoinPublic(url.pathname);
  if (!filePath) return sendJson(res, 400, { error: "Bad path" });

  try {
    const s = await stat(filePath);
    if (!s.isFile()) return sendJson(res, 404, { error: "Not found" });
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": buf.length,
      "Cache-Control": "no-store"
    });
    res.end(buf);
  } catch {
    return sendJson(res, 404, { error: "Not found" });
  }
}

async function handlePortfolioAnalysisStream(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });
  sendSseHeaders(res);

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    sseEvent(res, { event: "error", data: { error: "invalid_json" } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  const positionsIn = Array.isArray(payload?.positions) ? payload.positions : [];
  const positions = positionsIn
    .map((p) => ({
      symbol: String(p?.symbol || "").trim().toUpperCase(),
      qty: p?.qty,
      avgPrice: p?.avgPrice ?? null,
      currency: String(p?.currency || "").trim(),
      name: String(p?.name || "").trim()
    }))
    .filter((p) => p.symbol && isSafeYahooSymbol(p.symbol))
    .slice(0, 60);

  const quotesIn = Array.isArray(payload?.quotes) ? payload.quotes : [];
  const quotes = quotesIn
    .map((q) => ({
      symbol: String(q?.symbol || "").trim().toUpperCase(),
      shortName: String(q?.shortName || q?.longName || "").trim(),
      currency: String(q?.currency || "").trim(),
      regularMarketPrice: q?.regularMarketPrice ?? null,
      regularMarketChangePercent: q?.regularMarketChangePercent ?? null
    }))
    .filter((q) => q.symbol && isSafeYahooSymbol(q.symbol))
    .slice(0, 80);

  if (!positions.length) {
    sseEvent(res, { event: "error", data: { error: "missing_positions", details: "positions is empty" } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  const memo = clampStr(payload?.memo || "", 20_000);
  const topN = Math.max(1, Math.min(12, Number(payload?.topN || 10)));

  if (!OPENAI_API_KEY) {
    sseEvent(res, { event: "final", data: { ok: true, model: OPENAI_MODEL, answer: "현재 서버에 OPENAI_API_KEY가 설정되지 않아 포트폴리오 분석을 실행할 수 없습니다.\n\n고지: 본 서비스는 정보 제공 및 이해 보조 목적이며 투자 권유 또는 재무 자문을 제공하지 않습니다." } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  function computePortfolioViewLocal({ positions, quotes }) {
    const qBy = new Map((quotes || []).map((q) => [String(q?.symbol || "").toUpperCase(), q]));
    const rows = [];
    for (const p of positions || []) {
      const sym = String(p?.symbol || "").toUpperCase();
      if (!sym) continue;
      const qty = Number(p?.qty);
      const q = qBy.get(sym) || {};
      const last = q?.regularMarketPrice ?? null;
      const cur = String(q?.currency || p?.currency || "").trim();
      const value = Number.isFinite(qty) && Number.isFinite(Number(last)) ? qty * Number(last) : null;
      rows.push({
        symbol: sym,
        name: String(q?.shortName || p?.name || "").trim(),
        qty: Number.isFinite(qty) ? qty : null,
        avgPrice: p?.avgPrice ?? null,
        currency: cur || "",
        last,
        changePct: q?.regularMarketChangePercent ?? null,
        value
      });
    }

    const totals = new Map();
    for (const r of rows) {
      const cur = r.currency || "-";
      const v = Number(r.value);
      if (!Number.isFinite(v)) continue;
      totals.set(cur, (totals.get(cur) || 0) + v);
    }
    const totalByCur = Object.fromEntries(Array.from(totals.entries()));
    const weighted = rows.map((r) => {
      const denom = totals.get(r.currency || "-") || 0;
      const w = denom && Number.isFinite(Number(r.value)) ? Number(r.value) / denom : null;
      return { ...r, weight: w };
    });
    return { rows: weighted, totalByCur };
  }

  async function fetchYahooNewsHeadlines(query, count = 3) {
    const q = clampStr(query || "", 80).trim();
    if (!q) return [];
    const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=${encodeURIComponent(String(count))}`;
    const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) return [];
    const data = JSON.parse(r.body || "{}");
    const news = Array.isArray(data?.news) ? data.news : [];
    return news
      .slice(0, count)
      .map((n) => ({
        title: n?.title || "",
        link: n?.link || "",
        publisher: n?.publisher || n?.provider?.displayName || "",
        providerPublishTime: n?.providerPublishTime || null
      }))
      .filter((x) => x.title);
  }

  try {
    sseEvent(res, { event: "status", data: { stage: "collect" } });
    const portfolio = computePortfolioViewLocal({ positions, quotes });
    const top = [...portfolio.rows]
      .filter((r) => Number.isFinite(Number(r.weight)))
      .sort((a, b) => Number(b.weight) - Number(a.weight))
      .slice(0, topN);

    const newsBySymbol = {};
    for (const r of top) {
      const items = await fetchYahooNewsHeadlines(r.symbol, 3).catch(() => []);
      newsBySymbol[r.symbol] = items;
    }

    sseEvent(res, { event: "status", data: { stage: "generate" } });

    const system = [
      "너는 금융 정보의 '이해 보조'용 포트폴리오 리뷰어다.",
      "목표: 사용자의 보유 포트폴리오를 사람이 판단하듯(재무→이벤트→시장 반응→비교/구성 보정→조건부 결론) 구조화해서 설명한다.",
      "",
      "필수 제약:",
      "- 투자 권유/추천/확신/수익 예측 금지",
      "- '사라/팔아/매수/매도' 같은 지시문 금지",
      "- 단정 금지: 항상 조건부/가정/확률적 표현",
      "",
      "출력(항상 한국어, 마크다운):",
      "## 포트폴리오 요약",
      "## 구성/집중도 체크",
      "## 종목별 신호(요약)",
      "## 최근 뉴스/이벤트(요약)",
      "## 일관성/충돌 지점(가설)",
      "## 보완 포인트(조건부, 일반론)",
      "## 다음 확인 체크리스트",
      "## 고지"
    ].join("\n");

    const user = [
      "입력 데이터(JSON, 내부 참고):",
      JSON.stringify({ portfolio, memo, newsBySymbol }, null, 2),
      "",
      "주의: 고지는 반드시 포함하되, 투자 지시문은 쓰지 마라."
    ].join("\n");

    async function callModel(model) {
      const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.3,
          max_completion_tokens: 1200
        })
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        const e = new Error("openai_failed");
        e.details = `${resp.status} ${t.slice(0, 800)}`;
        throw e;
      }
      const data = await resp.json();
      return String(extractAssistantTextFromChatCompletions(data) || "").trim();
    }

    let answer = "";
    let usedModel = OPENAI_PORTFOLIO_MODEL || OPENAI_MODEL;
    try {
      answer = await callModel(usedModel);
    } catch (e) {
      // fallback to a known-small model if primary fails
      usedModel = "gpt-4.1-mini";
      answer = await callModel(usedModel);
    }
    if (!answer) {
      sseEvent(res, { event: "error", data: { error: "empty_answer", details: "LLM returned empty content" } });
      sseEvent(res, { event: "done", data: {} });
      return res.end();
    }
    sseEvent(res, { event: "final", data: { ok: true, model: usedModel, answer } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "portfolio_analysis_failed", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // CORS (로컬 개발 편의)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") return res.end();

    if (url.pathname === "/api/yahoo/ohlcv") return await handleYahooOhlcv(req, res);
    if (url.pathname === "/api/yahoo/screener") return await handleYahooScreener(req, res);
    if (url.pathname === "/api/yahoo/consensus") return await handleYahooConsensus(req, res);
    if (url.pathname === "/api/yahoo/financials") return await handleYahooFinancials(req, res);
    if (url.pathname === "/api/yahoo/indices") return await handleYahooIndices(req, res);
    if (url.pathname === "/api/yahoo/quotes") return await handleYahooQuotes(req, res);
    if (url.pathname === "/api/yahoo/news") return await handleYahooNews(req, res);
    if (url.pathname === "/api/yahoo/symbol_search") return await handleYahooSymbolSearch(req, res);
    if (url.pathname === "/api/market_insight") return await handleMarketInsight(req, res);
    if (url.pathname === "/api/order_simulate") return await handleOrderSimulate(req, res);
    if (url.pathname === "/api/chat_stream") return await handleChatStream(req, res);
    if (url.pathname === "/api/judge_stream") return await handleJudgeStream(req, res);
    if (url.pathname === "/api/portfolio_extract") return await handlePortfolioExtract(req, res);
    if (url.pathname === "/api/ticker_enrich") return await handleTickerEnrich(req, res);
    if (url.pathname === "/api/ticker_enrich_batch") return await handleTickerEnrichBatch(req, res);
    if (url.pathname === "/api/portfolio_analysis_stream") return await handlePortfolioAnalysisStream(req, res);
    if (url.pathname === "/api/explain_stream") return await handleExplainStream(req, res);
    if (url.pathname === "/api/explain") return await handleExplain(req, res);
    if (url.pathname === "/api/research") return await handleResearch(req, res);
    return await serveStatic(req, res);
  } catch (e) {
    // SSE 등으로 이미 헤더를 보낸 경우에는 JSON으로 다시 응답하지 않는다.
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    return sendJson(res, 500, { error: "Server error", details: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`OpenAI: ${OPENAI_API_KEY ? "enabled" : "disabled (mock for /api/explain)"}`);
  console.log(`Perplexity: ${PERPLEXITY_API_KEY ? "enabled" : "disabled (mock for /api/research)"}`);
});


