const { sendJson, tvSymbolToYahooSymbol, isSafeYahooSymbol, httpsGetText, getYahooCrumbAndCookie } = require("../_util");

function pickRaw(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v && "raw" in v) return v.raw;
  return v;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const symbol = tvSymbolToYahooSymbol(q.symbol || "AAPL");
  if (!isSafeYahooSymbol(symbol)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });

  const cacheKey = `consensus|${symbol}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 15_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const modules = "price,financialData,recommendationTrend,earningsTrend";
  const baseUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`;
  const urlNoCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}`;

  try {
    // 1) crumb 없이 시도
    let r = await httpsGetText(urlNoCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });

    // 2) 401 Invalid Crumb면 crumb/cookie 획득 후 재시도
    if (!(r.status >= 200 && r.status < 300) && r.status === 401 && /crumb/i.test(r.body || "")) {
      const { crumb, cookie } = await getYahooCrumbAndCookie(symbol);
      const urlWithCrumb = `${baseUrl}?modules=${encodeURIComponent(modules)}&crumb=${encodeURIComponent(crumb)}`;
      r = await httpsGetText(urlWithCrumb, { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Cookie": cookie });
    }

    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo consensus request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }

    const data = JSON.parse(r.body || "{}");
    const result = data?.quoteSummary?.result?.[0] || {};
    const price = result.price || {};
    const financialData = result.financialData || {};
    const recommendationTrend = result.recommendationTrend || {};
    const earningsTrend = result.earningsTrend || {};

    const recLatest = recommendationTrend?.trend?.[0] || null;
    const recommendation = recLatest
      ? {
          period: recLatest.period ?? null,
          strongBuy: pickRaw(recLatest.strongBuy) ?? null,
          buy: pickRaw(recLatest.buy) ?? null,
          hold: pickRaw(recLatest.hold) ?? null,
          sell: pickRaw(recLatest.sell) ?? null,
          strongSell: pickRaw(recLatest.strongSell) ?? null
        }
      : null;

    const targetPrice = {
      low: pickRaw(financialData.targetLowPrice) ?? null,
      avg: pickRaw(financialData.targetMeanPrice) ?? null,
      high: pickRaw(financialData.targetHighPrice) ?? null,
      analystCount: pickRaw(financialData.numberOfAnalystOpinions) ?? null,
      recommendationKey: financialData.recommendationKey ?? null,
      recommendationMean: pickRaw(financialData.recommendationMean) ?? null
    };

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
      symbol,
      asOf: new Date().toISOString(),
      price: {
        currency: price?.currency ?? null,
        regularMarketPrice: pickRaw(price?.regularMarketPrice) ?? null,
        shortName: price?.shortName ?? null
      },
      recommendation,
      targetPrice,
      earningsEstimate
    };

    cache.set(cacheKey, { ts: now, data: out });
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "Yahoo consensus request error", details: String(e?.message || e) });
  }
};



