const { sendSseHeaders, sseEvent, sendJson, readJsonBody, clampStr, httpsGetText, extractAssistantTextFromChatCompletions } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_PORTFOLIO_MODEL || "gpt-4.1-mini";

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_/]{1,32}$/.test(String(sym || "").trim());
}

function normalizeSymbol(sym) {
  return String(sym || "").trim().toUpperCase();
}

async function fetchYahooNewsHeadlines(query, count = 3) {
  const q = clampStr(query || "", 80).trim();
  if (!q) return [];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=${encodeURIComponent(String(count))}`;
  const r = await httpsGetText(url, { "User-Agent": "Mozilla/5.0", "Accept": "application/json" });
  if (r.status < 200 || r.status >= 300) return [];
  const data = JSON.parse(r.body || "{}");
  const news = Array.isArray(data?.news) ? data.news : [];
  return news
    .slice(0, count)
    .map((n) => ({
      title: String(n?.title || "").trim(),
      link: String(n?.link || "").trim(),
      publisher: String(n?.publisher || n?.provider?.displayName || "").trim(),
      providerPublishTime: n?.providerPublishTime || null
    }))
    .filter((x) => x.title);
}

function computePortfolioView({ positions, quotes }) {
  const qBy = new Map((quotes || []).map((q) => [normalizeSymbol(q?.symbol), q]));
  const rows = [];
  for (const p of positions || []) {
    const sym = normalizeSymbol(p?.symbol);
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
  // weights per currency bucket (avoid cross-currency summing)
  const totalByCur = Object.fromEntries(Array.from(totals.entries()));
  const weighted = rows.map((r) => {
    const denom = totals.get(r.currency || "-") || 0;
    const w = denom && Number.isFinite(Number(r.value)) ? Number(r.value) / denom : null;
    return { ...r, weight: w };
  });

  return { rows: weighted, totalByCur };
}

async function callOpenAiPortfolio({ portfolio, memo, newsBySymbol }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

  const system = [
    "너는 금융 정보의 '이해 보조'용 포트폴리오 리뷰어다.",
    "목표: 사용자의 보유 포트폴리오를 사람이 판단하듯(재무→이벤트→시장 반응→비교/구성 보정→조건부 결론) 구조화해서 설명한다.",
    "",
    "필수 제약:",
    "- 투자 권유/추천/확신/수익 예측 금지",
    "- '사라/팔아/매수/매도' 같은 지시문 금지",
    "- 단정 금지: 항상 조건부/가정/확률적 표현",
    "",
    "가능:",
    "- 보유 비중/집중도/분산 관점의 '리스크 포인트'와 '보완 관점'을 제시",
    "- 사용자의 목표/기간/리스크 선호에 따라 달라질 수 있음을 명시",
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
    JSON.stringify(
      {
        portfolio,
        memo: String(memo || "").slice(0, 20_000),
        newsBySymbol
      },
      null,
      2
    ),
    "",
    "주의: 고지는 반드시 포함하되, 투자 지시문은 쓰지 마라."
  ].join("\n");

  async function callModel(model) {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
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
      throw new Error(`OpenAI request failed: ${resp.status} ${t.slice(0, 600)}`);
    }
    const data = await resp.json();
    return String(extractAssistantTextFromChatCompletions(data) || "").trim();
  }

  let text = await callModel(OPENAI_MODEL);
  if (!text) text = await callModel("gpt-4.1-mini");
  if (!text) throw new Error("LLM returned empty content");
  return text;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  sendSseHeaders(res);

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "invalid_json", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }

  const positionsIn = Array.isArray(payload?.positions) ? payload.positions : [];
  const positions = positionsIn
    .map((p) => ({
      symbol: normalizeSymbol(p?.symbol),
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
      symbol: normalizeSymbol(q?.symbol),
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

  try {
    sseEvent(res, { event: "status", data: { stage: "collect" } });

    const view = computePortfolioView({ positions, quotes });
    const top = [...view.rows]
      .filter((r) => Number.isFinite(Number(r.weight)))
      .sort((a, b) => Number(b.weight) - Number(a.weight))
      .slice(0, topN);

    const newsBySymbol = {};
    for (const r of top) {
      // lightweight news (best-effort)
      const items = await fetchYahooNewsHeadlines(r.symbol, 3).catch(() => []);
      newsBySymbol[r.symbol] = items;
    }

    sseEvent(res, { event: "status", data: { stage: "generate" } });

    const answer = await callOpenAiPortfolio({ portfolio: view, memo, newsBySymbol });
    sseEvent(res, { event: "final", data: { ok: true, model: OPENAI_MODEL, answer } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "portfolio_analysis_failed", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    return res.end();
  }
};


