const $ = (id) => document.getElementById(id);

const CURSOR_KEY = "goyo_ai_ticker_master_import_cursor_v1";
const ENRICH_CURSOR_KEY = "goyo_ai_ticker_master_enrich_cursor_v1";

function loadCursor() {
  try {
    return JSON.parse(localStorage.getItem(CURSOR_KEY) || "null") || { done: 0, lastSymbol: "" };
  } catch {
    return { done: 0, lastSymbol: "" };
  }
}

function saveCursor(c) {
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify(c || { done: 0, lastSymbol: "" }));
  } catch {
    // ignore
  }
}

function loadEnrichCursor() {
  try {
    return JSON.parse(localStorage.getItem(ENRICH_CURSOR_KEY) || "null") || { done: 0, lastSymbol: "" };
  } catch {
    return { done: 0, lastSymbol: "" };
  }
}

function saveEnrichCursor(c) {
  try {
    localStorage.setItem(ENRICH_CURSOR_KEY, JSON.stringify(c || { done: 0, lastSymbol: "" }));
  } catch {
    // ignore
  }
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function makePrefixes(terms) {
  const out = new Set();
  for (const t of (terms || []).map((x) => normalizeKey(x)).filter(Boolean)) {
    const max = Math.min(10, t.length);
    for (let i = 1; i <= max; i++) out.add(t.slice(0, i));
  }
  return Array.from(out).slice(0, 140);
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

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "AI-Invest" } });
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

  for (const url of allCandidates) {
    try {
      const data = await fetchJson(url);
      const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
      if (rows && rows.length) return { url, rows };
    } catch {
      // try next
    }
  }

  // Merge three exchanges (repo canonical files)
  const exUrls = [
    { exch: "NASDAQ", url: `${base}/nasdaq/nasdaq_full_tickers.json` },
    { exch: "NYSE", url: `${base}/nyse/nyse_full_tickers.json` },
    { exch: "AMEX", url: `${base}/amex/amex_full_tickers.json` }
  ];
  const out = [];
  for (const ex of exUrls) {
    try {
      const data = await fetchJson(ex.url);
      const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      for (const r of rows) out.push({ ...r, __exchange: ex.exch });
    } catch {
      // ignore individual exchange failures; we'll error if nothing loads
    }
  }
  if (!out.length) throw new Error("No dataset files found (US-Stock-Symbols)");
  return { url: exUrls.map((x) => x.url).join(","), rows: out };
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

function mapExchange(ex) {
  const s = String(ex || "").toUpperCase();
  if (s.includes("NASDAQ")) return "NASDAQ";
  if (s.includes("NYSE")) return "NYSE";
  if (s.includes("AMEX") || s.includes("NYSEAMERICAN") || s.includes("NYSE AMERICAN")) return "AMEX";
  return s || "";
}

function tvSymbolFor(symbol, exchange) {
  const ex = mapExchange(exchange) || "NASDAQ";
  return `${ex}:${symbol}`;
}

function tickerDocId(symbol) {
  // Firestore doc id cannot contain "/"
  return encodeURIComponent(String(symbol || "").trim().toUpperCase());
}

function buildEnglishAliases(nameEn) {
  const s = String(nameEn || "").trim();
  if (!s) return [];
  const out = new Set([s]);
  // strip common suffixes
  const stripped = s
    .replace(/\s+(Common Stock|Ordinary Shares|American Depositary Shares|Depositary Shares|Class\s+[A-Z]\s+Common Stock|Class\s+[A-Z]\s+Ordinary Shares)\s*$/i, "")
    .trim();
  if (stripped && stripped !== s) out.add(stripped);
  // strip corporate suffix tokens
  const stripped2 = stripped.replace(/\b(Inc\.?|Incorporated|Corporation|Corp\.?|Ltd\.?|Limited|PLC|S\.A\.|N\.V\.)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  if (stripped2 && stripped2 !== stripped) out.add(stripped2);
  return Array.from(out).slice(0, 6);
}

async function callTickerEnrich({ symbol, name_en }) {
  const resp = await fetch("/api/ticker_enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, name_en })
  });
  if (!resp.ok) throw new Error(`ticker_enrich failed: ${resp.status}`);
  return await resp.json();
}

async function callTickerEnrichBatch(items) {
  const resp = await fetch("/api/ticker_enrich_batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) throw new Error(`ticker_enrich_batch failed: ${data?.details || resp.status}`);
  return data;
}

function appendLog(line) {
  const el = $("log");
  const now = new Date().toISOString().slice(11, 19);
  el.textContent = `${now} ${line}\n` + el.textContent;
}

function setStatus(s) {
  $("status").textContent = String(s || "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function initFirebase() {
  const cfg = window.GOYO_FIREBASE_CONFIG || null;
  if (!cfg || !cfg.apiKey) throw new Error("Firebase 설정이 없습니다. public/firebase-config.js를 확인하세요.");
  if (!window.firebase) throw new Error("Firebase SDK 로드 실패");
  firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();
  return { auth, db };
}

async function requireLogin(auth) {
  return await new Promise((resolve, reject) => {
    const unsub = auth.onAuthStateChanged(
      (u) => {
        unsub();
        if (u) resolve(u);
        else reject(new Error("로그인이 필요합니다. /login.html 에서 로그인 후 다시 시도하세요."));
      },
      (e) => {
        unsub();
        reject(e);
      }
    );
  });
}

async function main() {
  const { auth, db } = initFirebase();

  $("logout").addEventListener("click", async () => {
    try {
      await auth.signOut();
      location.href = "/login.html?next=" + encodeURIComponent("/admin_ticker_import.html");
    } catch {
      // ignore
    }
  });

  let user = null;
  try {
    user = await requireLogin(auth);
    $("userBadge").textContent = `${user.email || user.uid}`;
  } catch (e) {
    $("userBadge").textContent = "로그인 필요";
    setStatus(String(e?.message || e));
    return;
  }

  const cursor = loadCursor();
  appendLog(`cursor loaded: done=${cursor.done} last=${cursor.lastSymbol || "-"}`);

  let stop = false;

  $("stop").addEventListener("click", () => {
    stop = true;
    $("stop").disabled = true;
    appendLog("stop requested");
  });

  $("reset").addEventListener("click", () => {
    saveCursor({ done: 0, lastSymbol: "" });
    saveEnrichCursor({ done: 0, lastSymbol: "" });
    appendLog("cursor reset");
    setStatus("커서를 초기화했습니다. 다시 시작하세요.");
  });

  async function loadItems() {
    setStatus("데이터셋 로딩 중…");
    const { url, rows } = await fetchDataset();
    appendLog(`dataset loaded: rows=${rows.length} from ${url}`);

    const items = [];
    for (const r of rows) {
      const x = extractSymbolAndName(r);
      if (!x) continue;
      const sym = String(x.symbol).trim().toUpperCase();
      if (!sym) continue;
      items.push({ symbol: sym, name_en: x.name, exchange: mapExchange(x.exchange) });
    }
    items.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return items;
  }

  async function enrichPass({ limit, resume, throttleMs, onlyMissing }) {
    stop = false;
    $("stop").disabled = false;
    $("start").disabled = true;
    $("enrichStart").disabled = true;

    try {
      const items = await loadItems();
      const c = resume ? loadEnrichCursor() : { done: 0, lastSymbol: "" };
      const startIdx = Math.max(0, Number(c.done || 0) || 0);
      const max = limit > 0 ? Math.min(items.length, startIdx + limit) : items.length;
      appendLog(`enrich-only range: [${startIdx}, ${max}) onlyMissing=${onlyMissing} throttle=${throttleMs}ms`);

      let done = startIdx;
      const batchN = 25;
      for (let i = startIdx; i < max; ) {
        if (stop) break;
        const chunkStart = i;
        const chunkEnd = Math.min(max, chunkStart + batchN);
        const chunk = items.slice(chunkStart, chunkEnd);

        // filter missing by doc reads (parallel)
        let toEnrich = chunk;
        if (onlyMissing) {
          try {
            const snaps = await Promise.all(
              chunk.map((it) => db.collection("ticker_master").doc(tickerDocId(it.symbol)).get().catch(() => null))
            );
            toEnrich = chunk.filter((it, idx) => {
              const snap = snaps[idx];
              const cur = snap && snap.exists ? snap.data() : null;
              return !(cur && String(cur?.name_ko || "").trim());
            });
          } catch {
            toEnrich = chunk;
          }
        }

        if (!toEnrich.length) {
          done = chunkEnd;
          saveEnrichCursor({ done, lastSymbol: chunk[chunk.length - 1]?.symbol || "" });
          setStatus(`보강 스킵: ${done}/${max}`);
          i = chunkEnd;
          continue;
        }

        setStatus(`보강(배치) 중… ${chunkStart + 1}–${chunkEnd} / ${max} (targets=${toEnrich.length})`);
        try {
          const batchResp = await callTickerEnrichBatch(toEnrich.map((it) => ({ symbol: it.symbol, name_en: it.name_en })));
          const returned = Array.isArray(batchResp?.items) ? batchResp.items : [];
          const bySym = new Map(returned.map((x) => [String(x?.symbol || "").toUpperCase(), x]));

          const writeBatch = db.batch();
          for (const it of toEnrich) {
            const e = bySym.get(String(it.symbol).toUpperCase()) || null;
            const nameKo = String(e?.name_ko || "").trim();
            const aliasesKo = Array.isArray(e?.aliases_ko) ? e.aliases_ko.map((x) => String(x).trim()).filter(Boolean) : [];
            const aliasesEn = Array.isArray(e?.aliases_en) ? e.aliases_en.map((x) => String(x).trim()).filter(Boolean) : [];
            const fallbackEnAliases = buildEnglishAliases(it.name_en);
            const allPrefixes = makePrefixes([
              it.symbol,
              String(it.symbol || "").replace(/\//g, ""),
              it.name_en,
              ...fallbackEnAliases,
              nameKo,
              ...aliasesKo,
              ...aliasesEn
            ]);
            const keys = makeKeys({
              symbol: it.symbol,
              name_en: it.name_en,
              name_ko: nameKo,
              aliases_en: Array.from(new Set([...fallbackEnAliases, ...aliasesEn])),
              aliases_ko: aliasesKo
            });

            const ref = db.collection("ticker_master").doc(tickerDocId(it.symbol));
            writeBatch.set(
              ref,
              {
                name_ko: nameKo,
                name_ko_lc: normalizeKey(nameKo),
                aliases_ko: aliasesKo.slice(0, 12),
                aliases_en: Array.from(new Set([...fallbackEnAliases, ...aliasesEn])).slice(0, 12),
                prefixes: allPrefixes,
                keys,
                updatedAtClient: Date.now(),
                enrich_provider: String(batchResp?.provider || ""),
                enrich_model: String(batchResp?.model || "")
              },
              { merge: true }
            );
          }
          await writeBatch.commit();
          appendLog(`enrich batch committed: provider=${batchResp?.provider || "?"} model=${batchResp?.model || "?"} n=${toEnrich.length}`);
        } catch (err) {
          appendLog(`enrich batch failed: ${String(err?.message || err).slice(0, 220)}`);
        }

        done = chunkEnd;
        saveEnrichCursor({ done, lastSymbol: chunk[chunk.length - 1]?.symbol || "" });
        setStatus(`진행: ${done}/${max} last=${chunk[chunk.length - 1]?.symbol || "-"}`);
        if (throttleMs) await sleep(throttleMs);
        i = chunkEnd;
      }

      if (stop) {
        setStatus(`중지됨. enrich cursor done=${loadEnrichCursor().done}`);
        appendLog("enrich stopped");
      } else {
        setStatus(`보강 완료! done=${loadEnrichCursor().done} / total=${items.length}`);
        appendLog("enrich completed");
      }
    } finally {
      $("start").disabled = false;
      $("enrichStart").disabled = false;
      $("stop").disabled = true;
    }
  }

  $("start").addEventListener("click", async () => {
    stop = false;
    $("stop").disabled = false;
    $("start").disabled = true;
    $("enrichStart").disabled = true;
    try {
      const limit = Math.max(0, Number($("limit").value || "0") || 0);
      const doResume = !!$("resume").checked;
      const doEnrich = !!$("enrich").checked;
      const onlyMissing = !!$("enrichOnlyMissing").checked;
      const throttleMs = Math.max(0, Number($("throttle").value || "0") || 0);

      const items = await loadItems();

      const c = doResume ? loadCursor() : { done: 0, lastSymbol: "" };
      const startIdx = Math.max(0, Number(c.done || 0) || 0);
      const max = limit > 0 ? Math.min(items.length, startIdx + limit) : items.length;

      appendLog(`import range: [${startIdx}, ${max}) enrich=${doEnrich} throttle=${throttleMs}ms`);

      const batchSize = 400; // < 500 (Firestore limit)
      let done = startIdx;

      for (let i = startIdx; i < max; ) {
        if (stop) break;

        const batch = db.batch();
        const chunkStart = i;
        const chunkEnd = Math.min(max, chunkStart + batchSize);

        for (let j = chunkStart; j < chunkEnd; j++) {
          const it = items[j];
          const ref = db.collection("ticker_master").doc(tickerDocId(it.symbol));
          const enAliases = buildEnglishAliases(it.name_en);
          const base = {
            symbol: it.symbol,
            name_en: it.name_en,
            name_en_lc: normalizeKey(it.name_en),
            name_ko: "",
            name_ko_lc: "",
            aliases_ko: [],
            aliases_en: enAliases,
            exchange: it.exchange || "",
            tvSymbol: tvSymbolFor(it.symbol, it.exchange),
            source: "us-stock-symbols",
            updatedAtClient: Date.now()
          };
          base.prefixes = makePrefixes([it.symbol, String(it.symbol || "").replace(/\//g, ""), it.name_en, ...enAliases]);
          base.keys = makeKeys({ symbol: it.symbol, name_en: it.name_en, name_ko: "", aliases_en: enAliases, aliases_ko: [] });
          batch.set(ref, base, { merge: true });
        }

        setStatus(`쓰기(배치) 중… ${chunkStart}–${chunkEnd - 1}`);
        await batch.commit();
        done = chunkEnd;
        saveCursor({ done, lastSymbol: items[done - 1]?.symbol || "" });
        appendLog(`batch committed: done=${done}/${max} last=${items[done - 1]?.symbol || "-"}`);

        // optional enrich phase for this chunk (sequential; expensive)
        if (doEnrich && !stop) {
          for (let j = chunkStart; j < chunkEnd; j++) {
            if (stop) break;
            const it = items[j];
            setStatus(`보강(GPT) 중… ${j + 1}/${max} ${it.symbol}`);
            try {
              if (onlyMissing) {
                try {
                  const ref0 = db.collection("ticker_master").doc(tickerDocId(it.symbol));
                  const snap0 = await ref0.get();
                  const cur0 = snap0.exists ? snap0.data() : null;
                  if (cur0 && String(cur0?.name_ko || "").trim()) {
                    if (throttleMs) await sleep(Math.min(40, throttleMs));
                    continue;
                  }
                } catch {
                  // ignore and proceed
                }
              }
              const e = await callTickerEnrich({ symbol: it.symbol, name_en: it.name_en });
              const nameKo = String(e?.name_ko || "").trim();
              const aliasesKo = Array.isArray(e?.aliases_ko) ? e.aliases_ko.map((x) => String(x).trim()).filter(Boolean) : [];
              const aliasesEn = Array.isArray(e?.aliases_en) ? e.aliases_en.map((x) => String(x).trim()).filter(Boolean) : [];
              const fallbackEnAliases = buildEnglishAliases(it.name_en);
              const allPrefixes = makePrefixes([it.symbol, String(it.symbol || "").replace(/\//g, ""), it.name_en, nameKo, ...aliasesKo, ...aliasesEn, ...fallbackEnAliases]);
              const keys = makeKeys({
                symbol: it.symbol,
                name_en: it.name_en,
                name_ko: nameKo,
                aliases_en: Array.from(new Set([...fallbackEnAliases, ...aliasesEn])),
                aliases_ko: aliasesKo
              });
              const ref = db.collection("ticker_master").doc(tickerDocId(it.symbol));
              await ref.set(
                {
                  name_ko: nameKo,
                  name_ko_lc: normalizeKey(nameKo),
                  aliases_ko: aliasesKo.slice(0, 12),
                  aliases_en: Array.from(new Set([...fallbackEnAliases, ...aliasesEn])).slice(0, 12),
                  prefixes: allPrefixes,
                  keys,
                  updatedAtClient: Date.now()
                },
                { merge: true }
              );
              if (throttleMs) await sleep(throttleMs);
            } catch (err) {
              appendLog(`enrich failed ${it.symbol}: ${String(err?.message || err).slice(0, 160)}`);
              if (throttleMs) await sleep(Math.min(800, throttleMs));
            }
          }
        }

        i = chunkEnd;
        setStatus(`진행: ${done}/${max} (last=${items[done - 1]?.symbol || "-"})`);
        await sleep(120);
      }

      if (stop) {
        setStatus(`중지됨. cursor done=${loadCursor().done}`);
        appendLog("stopped");
      } else {
        setStatus(`완료! done=${loadCursor().done} / total=${items.length}`);
        appendLog("completed");
      }
    } catch (e) {
      setStatus(`오류: ${String(e?.message || e)}`);
      appendLog(`error: ${String(e?.stack || e)}`.slice(0, 800));
    } finally {
      $("start").disabled = false;
      $("enrichStart").disabled = false;
      $("stop").disabled = true;
    }
  });

  $("enrichStart").addEventListener("click", async () => {
    const limit = Math.max(0, Number($("limit").value || "0") || 0);
    const resume = !!$("resume").checked;
    const throttleMs = Math.max(0, Number($("throttle").value || "0") || 0);
    const onlyMissing = !!$("enrichOnlyMissing").checked;
    // enrich-only always calls GPT
    await enrichPass({ limit, resume, throttleMs, onlyMissing });
  });
}

main().catch((e) => {
  setStatus(`초기화 오류: ${String(e?.message || e)}`);
});


