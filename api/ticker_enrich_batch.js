const { sendJson, extractAssistantTextFromChatCompletions, clampStr } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_]{1,32}$/.test(String(sym || "").trim());
}

async function readJsonBody(req, limitBytes = 2_000_000) {
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

function extractJsonArray(text) {
  const s = String(text || "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON", details: String(e?.message || e) });
  }

  const itemsIn = Array.isArray(payload?.items) ? payload.items : [];
  const items = itemsIn
    .map((x) => ({
      symbol: clampStr(x?.symbol || "", 32).trim().toUpperCase(),
      name_en: clampStr(x?.name_en || x?.name || "", 160).trim()
    }))
    .filter((x) => x.symbol && isSafeYahooSymbol(x.symbol) && x.name_en)
    .slice(0, 60);

  if (!items.length) return sendJson(res, 400, { ok: false, error: "Missing items" });

  const system = [
    "너는 미국/글로벌 상장사의 '종목 마스터' 보강 에이전트다.",
    "입력: items 배열(각 항목은 symbol, name_en).",
    "출력: 각 symbol에 대해 한국어 표기(name_ko) + 한국어/영문 별칭(alias)을 생성한다.",
    "",
    "규칙:",
    "- 사실 확정/투자 조언 금지. 번역/표기는 관용적으로 쓰이는 수준으로만 제안한다.",
    "- 과도한 별칭 생성 금지(짧고 실사용 중심).",
    "- 출력은 JSON만(설명/마크다운/코드펜스 금지).",
    "- 반드시 입력 items와 같은 개수/순서로 배열을 반환한다.",
    "",
    "출력 포맷(JSON 배열):",
    "[",
    "  { \"symbol\":\"AAPL\", \"name_ko\":\"애플\", \"aliases_ko\":[\"애플\"], \"aliases_en\":[\"Apple\"] },",
    "  ...",
    "]"
  ].join("\n");

  const user = JSON.stringify({ items }, null, 2);
  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

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
        max_completion_tokens: 1200
      })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_failed", provider: "openai", details: `${resp.status} ${t.slice(0, 1200)}` });
    }
    const data = await resp.json();
    const text = extractAssistantTextFromChatCompletions(data);
    const arr = extractJsonArray(text);
    if (!Array.isArray(arr)) return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_parse_failed", provider: "openai", details: String(text || "").slice(0, 1200) });
    const out = arr
      .map((x, idx) => ({
        symbol: items[idx]?.symbol || clampStr(x?.symbol || "", 32).trim().toUpperCase(),
        name_ko: String(x?.name_ko || "").trim(),
        aliases_ko: Array.isArray(x?.aliases_ko) ? x.aliases_ko.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : [],
        aliases_en: Array.isArray(x?.aliases_en) ? x.aliases_en.map((v) => String(v).trim()).filter(Boolean).slice(0, 12) : []
      }))
      .slice(0, items.length);
    return sendJson(res, 200, { ok: true, provider: "openai", model: "gpt-4.1-mini", items: out });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "ticker_enrich_batch_error", provider: "openai", details: String(e?.message || e) });
  }
};


