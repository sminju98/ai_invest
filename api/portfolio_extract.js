const { sendJson, readJsonBody, extractAssistantTextFromChatCompletions, extractJsonObject } = require("./_util");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

async function readJsonBodyWithLimit(req, limitBytes) {
  const limit = Number(limitBytes) > 0 ? Number(limitBytes) : 1_000_000;
  const raw = await new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > limit) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
  if (!raw) return {};
  return JSON.parse(raw);
}

function isSafeSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_]{1,32}$/.test(String(sym || "").trim());
}

function normalizePositions(list) {
  const rows = Array.isArray(list) ? list : [];
  const out = [];
  for (const r of rows) {
    const symbol = String(r?.symbol || "").trim().toUpperCase();
    if (!symbol || !isSafeSymbol(symbol)) continue;
    const qty = r?.qty === null || r?.qty === undefined || r?.qty === "" ? null : Number(r.qty);
    const avg = r?.avgPrice === null || r?.avgPrice === undefined || r?.avgPrice === "" ? null : Number(r.avgPrice);
    out.push({
      symbol,
      name: String(r?.name || "").trim(),
      qty: Number.isFinite(qty) ? qty : null,
      avgPrice: Number.isFinite(avg) ? avg : null,
      currency: r?.currency ? String(r.currency).trim().toUpperCase() : null,
      confidence: typeof r?.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : null,
      notes: String(r?.notes || "").trim()
    });
  }
  return out.slice(0, 120);
}

async function callOpenAIVision({ images, hintSymbol }) {
  const system = [
    "너는 포트폴리오 캡처 이미지에서 보유 종목 정보를 추출하는 에이전트다.",
    "목표: 이미지 내 텍스트(OCR) + 표/리스트 구조를 해석해, 종목/수량/매수가(가능하면 통화)만 구조화한다.",
    "",
    "규칙:",
    "- 추측 금지(보이지 않으면 null).",
    "- positions에는 symbol/qty/avgPrice/currency/name만. 수익률/평가금액 등은 넣지 말 것.",
    "- 출력은 JSON만(마크다운/설명/코드펜스 금지).",
    "",
    "포맷:",
    "{",
    "  \"positions\": [{\"symbol\":\"AAPL\",\"name\":\"Apple\",\"qty\":10,\"avgPrice\":150.5,\"currency\":\"USD\",\"confidence\":0.8,\"notes\":\"...\"}],",
    "  \"warnings\": [\"...\"]",
    "}"
  ].join("\n");

  const content = [
    { type: "text", text: `힌트(선택): 대표 심볼=${hintSymbol || ""}. 힌트보다 이미지가 우선이다.` },
    ...images.map((dataUrl) => ({ type: "image_url", image_url: { url: dataUrl } }))
  ];

  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content }
      ],
      temperature: 0.0,
      max_completion_tokens: 900
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const e = new Error("OpenAI vision failed");
    e.details = `${resp.status} ${t.slice(0, 800)}`;
    throw e;
  }
  const data = await resp.json();
  const text = extractAssistantTextFromChatCompletions(data);
  const json = extractJsonObject(text);
  if (!json) throw new Error("Vision JSON parse failed");
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!OPENAI_API_KEY) return sendJson(res, 400, { ok: false, error: "OPENAI_API_KEY is not set" });

  let body;
  try {
    // 업로드 이미지 base64를 위해 한시적으로 상향
    body = await readJsonBodyWithLimit(req, 8_000_000);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON", details: String(e?.message || e) });
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return sendJson(res, 400, { ok: false, error: "No images" });
  if (images.length > 5) return sendJson(res, 400, { ok: false, error: "Too many images (max 5)" });

  const sanitized = images
    .map((x) => String(x || ""))
    .filter((x) => x.startsWith("data:image/"))
    .map((x) => (x.length > 2_000_000 ? x.slice(0, 2_000_000) : x));
  if (!sanitized.length) return sendJson(res, 400, { ok: false, error: "Invalid image format" });

  const hintSymbol = String(body.hint_symbol || "").trim().slice(0, 16);

  try {
    const out = await callOpenAIVision({ images: sanitized, hintSymbol });
    const positions = normalizePositions(out?.positions || []);
    const warnings = Array.isArray(out?.warnings) ? out.warnings.map((x) => String(x)).slice(0, 12) : [];
    return sendJson(res, 200, { ok: true, model: OPENAI_VISION_MODEL, positions, warnings });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: "portfolio_extract_failed", details: String(e?.details || e?.message || e) });
  }
};


