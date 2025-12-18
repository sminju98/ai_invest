const {
  sendSseHeaders,
  sseEvent,
  sendJson,
  readJsonBody,
  clampStr,
  extractJsonObject,
  hasNumbers,
  hasDisallowedFinanceAdvice,
  hasDisallowedAnalysisWord,
  extractAssistantTextFromChatCompletions
} = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || "";
const PERPLEXITY_BASE_URL = (process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-pro-preview";

async function perplexityGroundingJSON({ query, symbol, view }) {
  if (!PERPLEXITY_API_KEY) return { topics: [], sources: [], notes: "PERPLEXITY_API_KEY 미설정" };

  const system = [
    "당신은 금융 정보의 '자료 수집' 단계 에이전트입니다.",
    "목표: 실시간 웹에서 사용자의 질문과 관련된 공개 정보의 '존재 여부'와 '관점 분포'만 수집합니다.",
    "절대 금지: 숫자/퍼센트/가격/계산/사실 판정/결론/투자 조언.",
    "출력은 JSON만. 마크다운/설명/코드펜스 금지.",
    "",
    "출력 포맷:",
    "{",
    "  \"topics\": [\"관점1\", \"관점2\"],",
    "  \"sources\": [{\"title\":\"...\",\"url\":\"...\"}],",
    "  \"notes\": \"상충 관점 여부\"",
    "}"
  ].join("\n");

  const user = [`대상: ${symbol}`, `현재 화면: ${view}`, `질문: ${query}`].join("\n");

  const resp = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.0,
      max_tokens: 700
    })
  });

  if (!resp.ok) throw new Error(`Perplexity grounding failed: ${resp.status}`);
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text) || {};
  const topics = Array.isArray(json.topics) ? json.topics.map((x) => String(x)).slice(0, 12) : [];
  const sourcesRaw = Array.isArray(json.sources) ? json.sources : [];
  const sources = sourcesRaw
    .slice(0, 8)
    .map((s) => ({ title: String(s?.title || ""), url: String(s?.url || "") }))
    .filter((s) => s.url.startsWith("http"));
  const notes = String(json.notes || "");
  return { topics: topics.filter((x) => !hasNumbers(x)), sources, notes: hasNumbers(notes) ? "" : notes };
}

async function gptExplain({ symbol, interval, view, question, grounding, yahooOhlcv, yahooScreener, yahooConsensus }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

  const system = [
    "당신은 금융 정보를 '이해하기 쉽게 설명'하는 보조자입니다.",
    "",
    "절대 금지:",
    "- 투자 판단/추천/예측/단정",
    "- 수치/퍼센트/가격/단위 언급",
    "- 계산",
    "- '분석'이라는 단어 사용",
    "",
    "허용:",
    "- \"웹에서는 이런 관점이 언급된다\"",
    "- \"일반적으로 이런 맥락에서 설명된다\"",
    "- \"확인 체크리스트\"",
    "",
    "출력 형식(항상 한국어, 마크다운):",
    "## 요약",
    "## 웹에서 언급되는 관점(요약)",
    "## 이해를 돕는 맥락(일반론)",
    "## 확인 체크리스트(다음에 확인할 것)",
    "## 참고 링크"
  ].join("\n");

  const user = [
    `심볼: ${symbol}`,
    `타임프레임: ${interval}`,
    `현재 화면: ${view}`,
    "",
    `사용자 질문:\n${question}`,
    "",
    "자료 수집 결과(내부 참고):",
    JSON.stringify(grounding || {}, null, 2),
    "",
    "Yahoo 데이터(내부 참고):",
    `- OHLCV: ${yahooOhlcv ? "제공됨" : "없음"}`,
    `- Screener rows: ${yahooScreener ? "제공됨" : "없음"}`,
    `- Consensus: ${yahooConsensus ? "제공됨" : "없음"}`,
    "",
    "주의: 최종 출력에 숫자/퍼센트/가격/단위/목표가/EPS 등 수치를 포함하지 마세요."
  ].join("\n");

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.4,
      max_completion_tokens: 900
    })
  });
  if (!resp.ok) throw new Error(`GPT explain failed: ${resp.status}`);
  const data = await resp.json();
  return extractAssistantTextFromChatCompletions(data);
}

async function gptVerifier({ draft }) {
  if (!OPENAI_API_KEY) return { verdict: "WARN", violations: [], suggestion: "OPENAI_API_KEY 없음" };
  const system = [
    "출력 검증기다. 아래 텍스트가 정책을 위반하는지 검사하고 JSON만 출력해라.",
    "검사:",
    "- 투자 판단/조언/추천/예측/단정",
    "- '분석' 단어",
    "- 숫자/퍼센트/가격/단위",
    "",
    "출력(JSON): {\"verdict\":\"PASS|WARN|FAIL\",\"violations\":[...],\"suggestion\":\"...\"}"
  ].join("\n");
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: draft }
      ],
      temperature: 0.0,
      max_completion_tokens: 500
    })
  });
  if (!resp.ok) return { verdict: "WARN", violations: [], suggestion: "verifier 호출 실패" };
  const data = await resp.json();
  return extractJsonObject(extractAssistantTextFromChatCompletions(data)) || { verdict: "WARN", violations: [], suggestion: "verifier parse 실패" };
}

async function geminiVerifier({ draft }) {
  if (!GEMINI_API_KEY) {
    return {
      has_numbers: hasNumbers(draft),
      risk_phrases: [
        ...(hasDisallowedFinanceAdvice(draft) ? ["finance_advice_like"] : []),
        ...(hasDisallowedAnalysisWord(draft) ? ["analysis_word"] : [])
      ],
      format_issues: []
    };
  }
  const prompt = [
    "너는 출력 검증기다. 다음 텍스트를 검사하고 JSON만 출력해라.",
    "{ \"has_numbers\": true/false, \"risk_phrases\": [\"...\"], \"format_issues\": [\"...\"] }",
    "텍스트:",
    draft
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 400 }
    })
  });
  if (!resp.ok) return { has_numbers: true, risk_phrases: ["gemini_call_failed"], format_issues: [String(resp.status)] };
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
  return extractJsonObject(text) || { has_numbers: true, risk_phrases: ["gemini_parse_failed"], format_issues: [] };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method Not Allowed" });

  sendSseHeaders(res);
  try {
    const payload = await readJsonBody(req);
    const symbol = clampStr(payload.symbol || "NASDAQ:AAPL", 64);
    const interval = clampStr(payload.interval || "D", 16);
    const view = clampStr(payload.view || "chart", 16);
    const question = clampStr(payload.question || "", 2000);
    const ohlcv = clampStr(payload.ohlcv || "", 200_000);
    const screener = clampStr(payload.screener || "", 200_000);
    const consensus = clampStr(payload.consensus || "", 12_000);

    sseEvent(res, { event: "status", data: { stage: "start" } });
    sseEvent(res, { event: "status", data: { stage: "grounding" } });
    const grounding = await perplexityGroundingJSON({ query: question, symbol, view }).catch(() => ({ topics: [], sources: [], notes: "" }));

    const maxAttempts = 3;
    let draft = "";
    let verifier = null;
    let gem = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      sseEvent(res, { event: "status", data: { stage: "explain", attempt } });
      draft = await gptExplain({ symbol, interval, view, question, grounding, yahooOhlcv: ohlcv, yahooScreener: screener, yahooConsensus: consensus });
      sseEvent(res, { event: "status", data: { stage: "verify", attempt } });

      const localFail = hasNumbers(draft) || hasDisallowedFinanceAdvice(draft) || hasDisallowedAnalysisWord(draft);
      if (localFail && attempt < maxAttempts) continue;

      verifier = await gptVerifier({ draft });
      gem = await geminiVerifier({ draft });
      const verdict = String(verifier?.verdict || "WARN").toUpperCase();
      const fail = verdict === "FAIL" || gem?.has_numbers === true || hasDisallowedFinanceAdvice(draft) || hasDisallowedAnalysisWord(draft);
      if (!fail) break;
      if (attempt === maxAttempts) break;
    }

    if (hasNumbers(draft) || hasDisallowedFinanceAdvice(draft) || hasDisallowedAnalysisWord(draft)) {
      draft =
        "## 요약\n" +
        "요청하신 내용을 ‘공개 웹 정보 탐색·요약’ 범위에서 안전하게 설명하려 했지만, 출력 규칙을 만족하는 형태로 정리하지 못했습니다.\n\n" +
        "## 다음 단계\n" +
        "- 질문을 ‘원인/맥락/관점’ 중심으로 다시 적어주세요(수치 표현 없이).\n\n" +
        "## 참고 링크\n" +
        (Array.isArray(grounding?.sources) && grounding.sources.length ? grounding.sources.slice(0, 5).map((s) => `- ${s.url}`).join("\n") : "- (자료 수집 결과 없음)");
    }

    const disclaimer = "\n\n---\n본 서비스는 금융 데이터를 제공하거나 투자 판단을 하지 않으며, 공개 웹 정보를 탐색·요약하는 도구입니다.\n";
    const finalText = `${draft}${disclaimer}`;
    sseEvent(res, { event: "final", data: { answer: finalText } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  } catch (e) {
    sseEvent(res, { event: "error", data: { error: "chat_stream_failed", details: String(e?.message || e) } });
    sseEvent(res, { event: "done", data: {} });
    res.end();
  }
};


