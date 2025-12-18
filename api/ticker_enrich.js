const { sendJson, extractAssistantTextFromChatCompletions, extractJsonObject, clampStr } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_]{1,32}$/.test(String(sym || "").trim());
}

async function readJsonBody(req, limitBytes = 1_000_000) {
  const raw = await new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > limitBytes) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
  if (!raw) return {};
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON", details: String(e?.message || e) });
  }

  const symbol = clampStr(payload.symbol || "", 16).trim().toUpperCase();
  const nameEn = clampStr(payload.name_en || payload.name || "", 160).trim();
  if (!symbol || !isSafeYahooSymbol(symbol)) return sendJson(res, 400, { ok: false, error: "Invalid symbol" });
  if (!nameEn) return sendJson(res, 400, { ok: false, error: "Missing name_en" });

  const system = [
    "너는 미국/글로벌 상장사의 '종목 마스터' 보강 에이전트다.",
    "입력: 티커(symbol)와 영문 종목명(name_en).",
    "출력: 한국어 표기(name_ko) + 한국어/영문 별칭(alias) 후보를 만들어준다.",
    "",
    "규칙:",
    "- 사실 확정 금지. 번역/표기는 관용적으로 쓰이는 수준으로만 제안한다.",
    "- 과도한 별칭 생성 금지(짧고 실사용 중심).",
    "- 출력은 JSON만(설명/마크다운/코드펜스 금지).",
    "",
    "출력 포맷:",
    "{",
    "  \"name_ko\": \"...\",",
    "  \"aliases_ko\": [\"...\"],",
    "  \"aliases_en\": [\"...\"]",
    "}"
  ].join("\n");

  const user = JSON.stringify({ symbol, name_en: nameEn }, null, 2);

  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.2,
        max_completion_tokens: 400
      })
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "ticker_enrich_failed", details: `${resp.status} ${t.slice(0, 800)}` });
    }
    const data = await resp.json();
    const text = extractAssistantTextFromChatCompletions(data);
    const json = extractJsonObject(text);
    if (!json) return sendJson(res, 502, { ok: false, error: "ticker_enrich_parse_failed", details: text.slice(0, 800) });

    return sendJson(res, 200, {
      ok: true,
      symbol,
      name_en: nameEn,
      name_ko: String(json?.name_ko || "").trim(),
      aliases_ko: Array.isArray(json?.aliases_ko) ? json.aliases_ko.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [],
      aliases_en: Array.isArray(json?.aliases_en) ? json.aliases_en.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []
    });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "ticker_enrich_error", details: String(e?.message || e) });
  }
};


