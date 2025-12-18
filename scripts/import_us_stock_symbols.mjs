/**
 * US-Stock-Symbols → Firestore ticker_master import
 *
 * Source: https://github.com/rreichel3/US-Stock-Symbols
 *
 * Usage:
 *   node scripts/import_us_stock_symbols.mjs --limit 5000
 *   node scripts/import_us_stock_symbols.mjs --limit 200 --enrich --resume
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT_PATH=/abs/path/to/serviceAccount.json
 *   (or) FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *
 *   OPENAI_API_KEY=... (required if --enrich)
 *   OPENAI_BASE_URL=https://api.openai.com/v1 (optional)
 *   OPENAI_TICKER_ENRICH_MODEL=gpt-4.1-mini (optional)
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import admin from "firebase-admin";

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getArg = (name, fallback = null) => {
  const idx = argv.findIndex((a) => a === `--${name}`);
  if (idx < 0) return fallback;
  return argv[idx + 1] ?? fallback;
};

const LIMIT = Number(getArg("limit", "0")) || 0;
const ENRICH = hasFlag("--enrich");
const RESUME = hasFlag("--resume");
const DRY_RUN = hasFlag("--dry-run");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_TICKER_ENRICH_MODEL = process.env.OPENAI_TICKER_ENRICH_MODEL || "gpt-4.1-mini";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readServiceAccount() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (json) return JSON.parse(json);
  if (p) return JSON.parse(fs.readFileSync(p, "utf8"));
  die("Missing FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH");
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function makeKeys({ symbol, name_en, name_ko, aliases_en, aliases_ko }) {
  const out = new Set();
  const sym = String(symbol || "").trim().toUpperCase();
  if (sym) {
    out.add(normalizeKey(sym));
    out.add(normalizeKey(sym.replace(/\//g, "")));
  }
  if (name_en) out.add(normalizeKey(name_en));
  if (name_ko) out.add(normalizeKey(name_ko));
  for (const a of Array.isArray(aliases_en) ? aliases_en : []) out.add(normalizeKey(a));
  for (const a of Array.isArray(aliases_ko) ? aliases_ko : []) out.add(normalizeKey(a));
  return Array.from(out).filter(Boolean).slice(0, 80);
}

function buildEnglishAliases(nameEn) {
  const s = String(nameEn || "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const stripped = s
    .replace(/\s+(Common Stock|Ordinary Shares|American Depositary Shares|Depositary Shares|Class\s+[A-Z]\s+Common Stock|Class\s+[A-Z]\s+Ordinary Shares)\s*$/i, "")
    .trim();
  if (stripped && stripped !== s) out.add(stripped);
  const stripped2 = stripped.replace(/\b(Inc\.?|Incorporated|Corporation|Corp\.?|Ltd\.?|Limited|PLC|S\.A\.|N\.V\.)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  if (stripped2 && stripped2 !== stripped) out.add(stripped2);
  return Array.from(out).slice(0, 6);
}

function makePrefixes(terms) {
  const out = new Set();
  for (const t of terms.map((x) => normalizeKey(x)).filter(Boolean)) {
    const max = Math.min(10, t.length);
    for (let i = 1; i <= max; i++) out.add(t.slice(0, i));
  }
  return Array.from(out).slice(0, 140);
}

function tickerDocId(symbol) {
  // Firestore doc id cannot contain "/"
  return encodeURIComponent(String(symbol || "").trim().toUpperCase());
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "GOYO-AI-Invest" } });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${url}`);
  return await resp.json();
}

async function fetchDataset() {
  const base = "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main";
  // Prefer a true "all" file if it ever exists in the repo (currently it doesn't).
  const allCandidates = [
    `${base}/all/all_full_ticker.json`,
    `${base}/all/all_full_tickers.json`,
    `${base}/all/all_ticker.json`,
    `${base}/all/all_tickers.json`
  ];

  const results = [];
  for (const url of allCandidates) {
    try {
      const data = await fetchJson(url);
      if (Array.isArray(data)) return { mode: "single", url, rows: data };
      // Some files might wrap rows
      if (Array.isArray(data?.data)) return { mode: "single", url, rows: data.data };
    } catch {
      // try next
    }
  }

  // Fallback: merge three exchanges if single "all" not found
  const exUrls = [
    { exch: "NASDAQ", url: `${base}/nasdaq/nasdaq_full_tickers.json` },
    { exch: "NYSE", url: `${base}/nyse/nyse_full_tickers.json` },
    { exch: "AMEX", url: `${base}/amex/amex_full_tickers.json` }
  ];
  for (const ex of exUrls) {
    try {
      const data = await fetchJson(ex.url);
      const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      for (const r of rows) results.push({ ...r, __exchange: ex.exch });
    } catch {
      // ignore individual exchange failures; we'll error if nothing loads
    }
  }
  if (!results.length) throw new Error("No dataset files found (US-Stock-Symbols)");
  return { mode: "merged", url: exUrls.map((x) => x.url).join(","), rows: results };
}

function extractSymbolAndName(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const pick = (cands) => {
    for (const k of cands) {
      const kk = keys.find((x) => x.toLowerCase() === k.toLowerCase());
      if (kk && row[kk]) return row[kk];
    }
    return null;
  };
  const symbol = String(pick(["symbol", "ticker", "act symbol", "Symbol", "Ticker"]) || "").trim();
  const name = String(pick(["name", "security name", "company name", "Company Name", "securityName", "Security Name"]) || "").trim();
  const exchange = String(pick(["exchange", "Exchange", "exchangeName"]) || row.__exchange || "").trim();
  return symbol && name ? { symbol, name, exchange } : null;
}

async function openAiEnrich({ symbol, name_en }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing (required for --enrich)");
  const system = [
    "너는 미국/글로벌 상장사의 '종목 마스터' 보강 에이전트다.",
    "입력: 티커(symbol)와 영문 종목명(name_en).",
    "출력: 한국어 표기(name_ko) + 한국어/영문 별칭(alias) 후보를 만들어준다.",
    "규칙: 과도한 별칭 생성 금지(짧고 실사용 중심), 출력은 JSON만.",
    "{ \"name_ko\":\"...\", \"aliases_ko\":[\"...\"], \"aliases_en\":[\"...\"] }"
  ].join("\n");
  const user = JSON.stringify({ symbol, name_en }, null, 2);
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_TICKER_ENRICH_MODEL,
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
    throw new Error(`enrich failed: ${resp.status} ${t.slice(0, 500)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("enrich JSON parse failed");
  return JSON.parse(text.slice(start, end + 1));
}

async function main() {
  const sa = readServiceAccount();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const cursorFile = path.join(process.cwd(), ".local", "ticker_import_cursor.json");
  let cursor = { done: 0, lastSymbol: "" };
  if (RESUME && fs.existsSync(cursorFile)) {
    try {
      cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    } catch {
      cursor = { done: 0, lastSymbol: "" };
    }
  }

  const { url, rows } = await fetchDataset();
  console.log(`Loaded dataset rows=${rows.length} from ${url}`);

  const items = [];
  for (const r of rows) {
    const x = extractSymbolAndName(r);
    if (!x) continue;
    const sym = String(x.symbol).trim().toUpperCase();
    if (!sym) continue;
    items.push({ symbol: sym, name_en: x.name, exchange: x.exchange || "" });
  }

  // stable order
  items.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const startIdx = cursor.done || 0;
  const max = LIMIT > 0 ? Math.min(items.length, startIdx + LIMIT) : items.length;
  console.log(`Import range: [${startIdx}, ${max}) enrich=${ENRICH} dryRun=${DRY_RUN}`);

  let done = startIdx;
  for (let i = startIdx; i < max; i++) {
    const it = items[i];
    const doc = db.collection("ticker_master").doc(tickerDocId(it.symbol));
    const base = {
      symbol: it.symbol,
      name_en: it.name_en,
      name_en_lc: normalizeKey(it.name_en),
      name_ko: "",
      name_ko_lc: "",
      aliases_ko: [],
      aliases_en: buildEnglishAliases(it.name_en),
      exchange: it.exchange || "",
      tvSymbol: it.exchange ? `${String(it.exchange).toUpperCase()}:${it.symbol}` : `NASDAQ:${it.symbol}`,
      source: "us-stock-symbols",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtClient: Date.now()
    };
    const enAliases = buildEnglishAliases(it.name_en);
    base.aliases_en = enAliases;
    base.prefixes = makePrefixes([it.symbol, String(it.symbol || "").replace(/\//g, ""), it.name_en, ...enAliases]);
    base.keys = makeKeys({ symbol: it.symbol, name_en: it.name_en, name_ko: "", aliases_en: enAliases, aliases_ko: [] });

    let patch = base;
    if (ENRICH) {
      try {
        const e = await openAiEnrich({ symbol: it.symbol, name_en: it.name_en });
        const nameKo = String(e?.name_ko || "").trim();
        const aliasesKo = Array.isArray(e?.aliases_ko) ? e.aliases_ko.map((x) => String(x).trim()).filter(Boolean) : [];
        const aliasesEn = Array.isArray(e?.aliases_en) ? e.aliases_en.map((x) => String(x).trim()).filter(Boolean) : [];
        const extraPrefixes = makePrefixes([nameKo, ...aliasesKo, ...aliasesEn]);
        patch = {
          ...base,
          name_ko: nameKo,
          name_ko_lc: normalizeKey(nameKo),
          aliases_ko: aliasesKo.slice(0, 12),
          aliases_en: Array.from(new Set([...buildEnglishAliases(it.name_en), ...aliasesEn])).slice(0, 12),
          prefixes: Array.from(new Set([...(base.prefixes || []), ...extraPrefixes])).slice(0, 140)
        };
        patch.keys = makeKeys({
          symbol: it.symbol,
          name_en: it.name_en,
          name_ko: patch.name_ko,
          aliases_en: patch.aliases_en,
          aliases_ko: patch.aliases_ko
        });
      } catch (e) {
        patch = { ...base, enrichError: String(e?.message || e).slice(0, 500) };
      }
    }

    if (!DRY_RUN) await doc.set(patch, { merge: true });
    done = i + 1;

    if (done % 200 === 0 || done === max) {
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      fs.writeFileSync(cursorFile, JSON.stringify({ done, lastSymbol: it.symbol }, null, 2));
      console.log(`Progress: ${done}/${max} last=${it.symbol}`);
    }
  }

  console.log("Done.");
}

main().catch((e) => die(String(e?.stack || e?.message || e)));


