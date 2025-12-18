const { sendJson, isSafeYahooSymbol, httpsGetText } = require("../_util");

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const raw = String(q.symbols || "").trim();
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

  try {
    // v7/finance/quote는 401이 나는 케이스가 있어, v8/finance/chart meta로 우회
    const quotes = [];
    for (const symbol of list) {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=1d&range=5d&includePrePost=false&events=div%7Csplit`;
      const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (r.status < 200 || r.status >= 300) {
        return sendJson(res, 502, { ok: false, error: "Yahoo quotes request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
      }
      const data = JSON.parse(r.body || "{}");
      const meta = data?.chart?.result?.[0]?.meta || {};
      quotes.push({
        symbol: meta.symbol || symbol,
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
};


