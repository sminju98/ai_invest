const { sendJson, httpsGetText, clampStr } = require("../_util");

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isSafeQuery(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (s.length > 80) return false;
  // 너무 이상한 문자 방지(간단히)
  return !/[\u0000-\u001f<>]/.test(s);
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  const q = req.query || {};
  const query = clampStr(q.q || "stock market", 80).trim();
  const count = clampInt(q.count || q.newsCount || 12, 1, 20, 12);
  if (!isSafeQuery(query)) return sendJson(res, 400, { ok: false, error: "Invalid query" });

  const cacheKey = `news|${query}|${count}`;
  const now = Date.now();
  globalThis.__yahooCache ||= new Map();
  const cache = globalThis.__yahooCache;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < 30_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${encodeURIComponent(String(count))}`;

  try {
    const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
    if (r.status < 200 || r.status >= 300) {
      return sendJson(res, 502, { ok: false, error: "Yahoo news request failed", status: r.status, details: (r.body || "").slice(0, 2000) });
    }
    const data = JSON.parse(r.body || "{}");
    const news = Array.isArray(data?.news) ? data.news : [];

    // "오늘자" 근사: 최근 24시간
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
};


