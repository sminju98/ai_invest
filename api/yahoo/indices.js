const { sendJson, isSafeYahooSymbol, httpsGetText } = require("../_util");

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

async function fetchIndexMeta(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d&includePrePost=false&events=div%7Csplit`;
  const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
  if (r.status < 200 || r.status >= 300) {
    const e = new Error("Yahoo chart request failed");
    e.status = r.status;
    e.details = (r.body || "").slice(0, 1200);
    throw e;
  }
  const data = JSON.parse(r.body || "{}");
  const meta = data?.chart?.result?.[0]?.meta || {};
  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || null,
    longName: meta.longName || null,
    currency: meta.currency || null,
    regularMarketTime: meta.regularMarketTime || null,
    regularMarketPrice: meta.regularMarketPrice ?? null,
    previousClose: meta.previousClose ?? null,
    regularMarketChange: meta.regularMarketChange ?? null,
    regularMarketChangePercent: meta.regularMarketChangePercent ?? null
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const symbols = safeSymbolsList(q.symbols);
  if (!symbols) return sendJson(res, 400, { ok: false, error: "Invalid symbols" });

  const cacheKey = `indices|${symbols.join(",")}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 20_000) return sendJson(res, 200, { ...cached.data, cached: true });

  try {
    // 순차 호출(과도한 병렬로 429를 유발하지 않도록)
    const rows = [];
    for (const sym of symbols) rows.push(await fetchIndexMeta(sym));
    const out = { ok: true, source: "yahoo", asOf: new Date().toISOString(), rows };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo indices request error", status: e?.status || 502, details: String(e?.details || e?.message || e) });
  }
};


