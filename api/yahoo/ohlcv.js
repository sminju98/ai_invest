const {
  sendJson,
  tvSymbolToYahooSymbol,
  isSafeYahooSymbol,
  isSafeYahooInterval,
  isSafeYahooRange,
  httpsGetText
} = require("../_util");

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const symbol = tvSymbolToYahooSymbol(q.symbol || "AAPL");
  const interval = String(q.interval || "1d");
  const range = String(q.range || "6mo");

  if (!isSafeYahooSymbol(symbol)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });
  if (!isSafeYahooInterval(interval)) return sendJson(res, 400, { ok: false, error: "Invalid interval" });
  if (!isSafeYahooRange(range)) return sendJson(res, 400, { ok: false, error: "Invalid range" });

  const cacheKey = `ohlcv|${symbol}|${interval}|${range}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const yahooUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false&events=div%7Csplit`;

  try {
    const r = await httpsGetText(yahooUrl, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
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
    for (let i = 0; i < ts.length && candles.length < 200; i++) {
      const o = opens[i],
        h = highs[i],
        l = lows[i],
        c = closes[i];
      const v = vols[i];
      if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
      candles.push({ t: new Date(ts[i] * 1000).toISOString(), o, h, l, c, v: typeof v === "number" && Number.isFinite(v) ? v : null });
    }
    const out = { ok: true, source: "yahoo", symbol, interval, range, candles };
    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo request error", details: String(e?.message || e) });
  }
};



