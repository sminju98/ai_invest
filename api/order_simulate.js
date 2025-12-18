const { sendJson, readJsonBody, clampStr, isSafeYahooSymbol, httpsGetText } = require("./_util");

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON", details: String(e?.message || e) });
  }

  const symbol = clampStr(payload.symbol || "", 32).trim();
  const side = String(payload.side || "").toUpperCase();
  const type = String(payload.type || "MARKET").toUpperCase();
  const qty = clampInt(payload.qty, 1, 1_000_000, 0);
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
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
        `?interval=1m&range=1d&includePrePost=false&events=div%7Csplit`;
      const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
      if (r.status < 200 || r.status >= 300) continue;
      try {
        const data = JSON.parse(r.body || "{}");
        const meta = data?.chart?.result?.[0]?.meta || {};
        const price = meta?.regularMarketPrice;
        if (typeof price === "number" && Number.isFinite(price)) {
          const out = { symbol: meta.symbol || sym, currency: meta.currency || null, regularMarketTime: meta.regularMarketTime || null, price };
          cache.set(yahooSymbol, { ts: now, data: out });
          return out;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  const quote = await fetchYahooLastPrice(symbol).catch(() => null);

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
      ? { source: "yahoo", symbol: quote.symbol, price: quote.price, currency: quote.currency, regularMarketTime: quote.regularMarketTime }
      : null
  });
};


