const { sendJson, readJsonBody, clampStr, extractAssistantTextFromChatCompletions } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

function buildFallbackInsight({ news, indices }) {
  const topNews = (news || [])
    .filter((n) => n && n.title)
    .slice(0, 6)
    .map((n) => `- ${String(n.title).trim()}`);
  const indexSummary = (indices || []).length > 0 
    ? `- 현재 ${indices.length}개의 지수 데이터가 수집되었습니다.`
    : "- 지수 데이터를 수집 중입니다.";
  return (
    "## 오늘의 Market Insight\n" +
    "### 상황 요약(지표/헤드라인 기반)\n" +
    indexSummary + "\n" +
    (topNews.length > 0 ? `- ${topNews.length}개의 주요 뉴스가 확인되었습니다.` : "- 뉴스 데이터를 수집 중입니다.") + "\n\n" +
    "### 주요 이슈(헤드라인 기반)\n" +
    (topNews.length ? topNews.join("\n") : "- 뉴스 데이터가 아직 수집되지 않았습니다. 잠시 후 새로고침해주세요.") +
    "\n\n" +
    "### 오늘의 관찰 포인트(체크리스트)\n" +
    "- 주가지수/채권수익률/달러/원자재의 방향성이 '정렬'되는지, '엇갈리는지'\n" +
    "- 헤드라인 키워드가 정책/물가/성장/실적/AI/지정학 중 어디로 쏠리는지\n" +
    "- 변동성 확대 신호가 있는지\n\n" +
    "---\n본 서비스는 AI 기반 투자 판단 및 조언을 제공합니다. 최종 투자 결정은 사용자 본인의 책임입니다."
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
    "당신은 'Market Insight' 시장 해설가입니다.",
    "입력으로 제공되는 시장 지표(지수/통화/원자재/채권/선물)와 뉴스 헤드라인을 바탕으로, 단순 요약이 아닌 **의미 해석과 해설**을 중심으로 작성합니다.",
    "",
    "핵심 원칙:",
    "- 숫자나 사실을 나열하는 것이 아니라, '왜 그런지', '무엇을 의미하는지'를 설명합니다.",
    "- 각 지표의 움직임이 시장에 어떤 신호를 주는지 해석합니다.",
    "- 뉴스 이슈의 배경과 시장에 미칠 수 있는 영향을 분석합니다.",
    "- 투자자 관점에서 '이것이 왜 중요한가'를 명확히 전달합니다.",
    "",
    "출력(항상 한국어, 마크다운):",
    "## 오늘의 Market Insight",
    "### 시장 해석",
    "지수와 주요 지표의 움직임을 분석하고, 이것이 시장에 어떤 의미인지 해설합니다. 단순 나열이 아닌 해석 중심으로 작성합니다.",
    "",
    "### 주요 이슈와 의미",
    "뉴스 헤드라인과 시장 이벤트를 나열하는 것이 아니라, 각 이슈가 왜 중요한지, 시장에 어떤 영향을 줄 수 있는지 해설합니다.",
    "",
    "### 시장 신호 해석",
    "지표들의 움직임이 함께 보여주는 시장의 방향성과 신호를 해석합니다. 예: '지수 상승 + 달러 강세 + 금리 하락'이 함께 나타날 때의 의미 등.",
    "",
    "### 관찰 포인트",
    "오늘 확인해야 할 주요 포인트를 나열하되, 각 포인트가 왜 중요한지 간단히 설명합니다.",
    "",
    "### 리스크와 불확실성",
    "현재 시장의 주요 리스크와 불확실성을 명시하고, 이것이 투자 결정에 어떤 영향을 줄 수 있는지 해설합니다.",
    "",
    "문체: 해설 위주로 작성. 숫자 나열보다는 의미 해석 중심. 투자 판단과 조언을 포함할 수 있습니다."
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
    "지표나 뉴스 데이터가 없거나 부족한 경우, 일반적인 시장 관찰 포인트를 제시하세요."
  ].join("\n");

  async function callOpenAI(messages, max_completion_tokens = 1200) {
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
      insight = buildFallbackInsight({ news: compactNews, indices: compactIndices });
    } else {
      insight = String(insight || "").trim() + "\n\n---\n본 서비스는 AI 기반 투자 판단 및 조언을 제공합니다. 최종 투자 결정은 사용자 본인의 책임입니다.";
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
      insight: buildFallbackInsight({ news: compactNews, indices: compactIndices })
    };
    globalThis.__insightCache = { ts: now, data: out };
    return sendJson(res, 200, out);
  }
};


