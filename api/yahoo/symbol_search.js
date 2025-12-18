const { sendJson, isSafeYahooSymbol, httpsGetText } = require("../_util");

function isSafeQuery(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (s.length > 80) return false;
  return !/[\u0000-\u001f<>]/.test(s);
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  const q = req.query || {};
  const query = String(q.q || "").trim().slice(0, 80);
  const count = Math.max(1, Math.min(20, Number(q.count || 12)));
  if (!isSafeQuery(query)) return sendJson(res, 400, { ok: false, error: "Invalid query" });

  const cacheKey = `symbol_search|${query}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 30_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${encodeURIComponent(String(count))}`;
  try {
    const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo symbol search failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }
    const data = JSON.parse(r.body || "{}");
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const items = quotes
      .map((qq) => ({
        symbol: String(qq?.symbol || "").trim(),
        name: String(qq?.shortname || qq?.longname || qq?.shortName || qq?.longName || "").trim(),
        exchDisp: String(qq?.exchDisp || qq?.exchange || "").trim(),
        quoteType: String(qq?.quoteType || "").trim()
      }))
      .filter((x) => x.symbol && isSafeYahooSymbol(x.symbol))
      .slice(0, count);
    const out = { ok: true, source: "yahoo", asOf: new Date().toISOString(), q: query, count, items };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo symbol search error", details: String(e?.message || e) });
  }
};


