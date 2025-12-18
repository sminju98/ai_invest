const { sendJson, httpsGetText } = require("../_util");

function isSafeYahooScreenerId(v) {
  return /^(largest_market_cap|most_actives|day_gainers|day_losers)$/.test(String(v || ""));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const scrId = String(q.scrId || "largest_market_cap");
  const count = Math.max(1, Math.min(50, Number(q.count || 25)));
  if (!isSafeYahooScreenerId(scrId)) return sendJson(res, 400, { ok: false, error: "Invalid scrId" });

  const cacheKey = `screener|${scrId}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${encodeURIComponent(
    String(count)
  )}&scrIds=${encodeURIComponent(scrId)}`;

  try {
    const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo screener request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }
    const data = JSON.parse(r.body || "{}");
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
};



