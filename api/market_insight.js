const { sendJson, readJsonBody, clampStr, extractAssistantTextFromChatCompletions } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function buildFallbackInsight({ news }) {
  const topNews = (news || [])
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  // 5분 캐시(서버리스 warm 상태에서만 유효하지만 호출 폭을 줄여줌)
  globalThis.__insightCache ||= { ts: 0, data: null };
  const now = Date.now();
  const cached = globalThis.__insightCache;
  // NOTE: payload를 읽기 전에는 force를 판단할 수 없으므로, 캐시 체크는 payload 이후로 이동

  let payload = {};
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON", details: String(e?.message || e) });
  }
  const doForce = payload?.force === true;
  if (!doForce && cached.data && now - cached.ts < 300_000) return sendJson(res, 200, { ...cached.data, cached: true });

  const indices = Array.isArray(payload.indices) ? payload.indices.slice(0, 12) : [];
  const news = Array.isArray(payload.news) ? payload.news.slice(0, 20) : [];
  const locale = clampStr(payload.locale || "ko", 8);

  if (!OPENAI_API_KEY) {
    const out = {
      ok: true,
      mode: "mock",
      model: OPENAI_MODEL,
      asOf: new Date().toISOString(),
      insight:
        "## 오늘의 Market Insight\n" +
        "- 현재는 **OPENAI_API_KEY가 설정되지 않아** 예시 요약을 표시합니다.\n\n" +
        "### 체크포인트\n" +
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
    "출력(항상 한국어, 마크다운):",
    "## 오늘의 Market Insight",
    "### 상황 요약(지표/헤드라인 기반)",
    "### 주요 이슈(3~6개)",
    "### 해설(왜 중요할 수 있나)",
    "### 오늘의 관찰 포인트(체크리스트)",
    "### 단기 시나리오(조건부, 단정 금지)",
    "### 체크포인트(오늘 확인할 것)",
    "### 리스크/불확실성"
  ].join("\n");

  const compactIndices = indices.map((r) => ({
    symbol: r?.symbol,
    shortName: r?.shortName || r?.longName,
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
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.35, max_completion_tokens })
    });
    if (!resp.ok) throw new Error(`OpenAI request failed: ${resp.status}`);
    const data = await resp.json();
    return extractAssistantTextFromChatCompletions(data);
  }

  try {
    let insight = await callOpenAI([
      { role: "system", content: system },
      { role: "user", content: input }
    ]);
    let mode = "openai";
    if (!String(insight || "").trim()) {
      mode = "fallback";
      insight = buildFallbackInsight({ news: compactNews });
    } else {
      insight = String(insight || "").trim() + "\n\n---\n본 서비스는 투자 판단을 하지 않습니다.";
    }

    const out = { ok: true, mode, model: OPENAI_MODEL, asOf: new Date().toISOString(), insight };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  } catch (e) {
    const out = {
      ok: true,
      mode: "fallback",
      model: OPENAI_MODEL,
      asOf: new Date().toISOString(),
      error: "Market insight failed",
      details: String(e?.message || e),
      insight: buildFallbackInsight({ news: compactNews })
    };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  }
};


