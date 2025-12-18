const $ = (id) => document.getElementById(id);

function initFirebase() {
  const cfg = window.GOYO_FIREBASE_CONFIG || null;
  if (!cfg || !cfg.apiKey) throw new Error("Firebase 설정이 없습니다. public/firebase-config.js를 확인하세요.");
  if (!window.firebase) throw new Error("Firebase SDK 로드 실패");
  firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
  return { auth: firebase.auth(), db: firebase.firestore() };
}

function clampText(s, max = 80_000) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) + "\n...(TRUNCATED)" : t;
}

function tvToYahooSymbol(tv) {
  const s = String(tv || "").trim();
  if (!s) return "AAPL";
  const parts = s.split(":");
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function tickerDocId(symbol) {
  return encodeURIComponent(String(symbol || "").trim().toUpperCase());
}

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_/]{1,32}$/.test(String(sym || "").trim());
}

async function resolveTickerFromMaster(db, inputText) {
  const raw = String(inputText || "").trim();
  if (!raw) return { symbol: "", row: null };

  // TradingView format
  if (/^[A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32}$/.test(raw)) {
    const parts = raw.split(":");
    return { symbol: String(parts[1] || "").trim().toUpperCase(), row: null };
  }

  if (isSafeYahooSymbol(raw) && /[A-Za-z0-9]/.test(raw) && !/[가-힣\s]/.test(raw) && raw.length <= 12) {
    return { symbol: raw.toUpperCase(), row: null };
  }

  const q = normalizeKey(raw);
  if (!q) return { symbol: "", row: null };

  // 1) exact match via keys[]
  try {
    const snap = await db.collection("ticker_master").where("keys", "array-contains", q).limit(3).get();
    const doc = snap.docs?.[0] || null;
    const d = doc ? doc.data() : null;
    const sym = String(d?.symbol || "").trim().toUpperCase();
    if (sym) return { symbol: sym, row: d || null };
  } catch {
    // ignore
  }

  // 2) prefix fallback
  try {
    const snap = await db.collection("ticker_master").where("prefixes", "array-contains", q.slice(0, Math.min(10, q.length))).limit(8).get();
    const rows = snap.docs.map((d) => d.data());
    const scored = rows
      .map((r) => {
        const sym = String(r?.symbol || "").trim().toUpperCase();
        const keys = Array.isArray(r?.keys) ? r.keys : [];
        const score = keys.includes(q) ? 100 : 10;
        return { sym, r, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.sym) return { symbol: scored[0].sym, row: scored[0].r || null };
  } catch {
    // ignore
  }

  // 3) Yahoo fallback
  try {
    const qs = new URLSearchParams({ q: raw, count: "1" });
    const resp = await fetch(`/api/yahoo/symbol_search?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    const sym = String(data?.items?.[0]?.symbol || "").trim().toUpperCase();
    if (sym) {
      // cache minimal into ticker_master
      try {
        const ref = db.collection("ticker_master").doc(tickerDocId(sym));
        const nameEn = String(data?.items?.[0]?.name || "").trim();
        const base = {
          symbol: sym,
          name_en: nameEn,
          name_en_lc: normalizeKey(nameEn),
          name_ko: "",
          name_ko_lc: "",
          aliases_ko: [],
          aliases_en: nameEn ? [nameEn] : [],
          prefixes: Array.from(new Set([normalizeKey(sym), ...(nameEn ? [normalizeKey(nameEn).slice(0, 10)] : [])])).filter(Boolean),
          keys: Array.from(new Set([normalizeKey(sym), normalizeKey(sym.replace(/\\//g, "")), ...(nameEn ? [normalizeKey(nameEn)] : [])])).filter(Boolean),
          source: "yahoo_search",
          updatedAtClient: Date.now()
        };
        await ref.set(base, { merge: true });
      } catch {
        // ignore cache errors
      }
      return { symbol: sym, row: null };
    }
  } catch {
    // ignore
  }

  return { symbol: "", row: null };
}

async function fileToDataUrl(file) {
  const buf = await file.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `data:${file.type || "image/jpeg"};base64,${b64}`;
}

async function resizeToJpegDataUrl(file, { maxDim = 1280, quality = 0.78 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderThumbs(files, dataUrls) {
  const root = $("thumbs");
  root.innerHTML = "";
  for (let i = 0; i < dataUrls.length; i++) {
    const d = dataUrls[i];
    const name = files[i]?.name || `image_${i + 1}`;
    const wrap = document.createElement("div");
    wrap.style.width = "120px";
    wrap.style.border = "1px solid var(--border)";
    wrap.style.borderRadius = "12px";
    wrap.style.overflow = "hidden";
    wrap.style.background = "rgba(255,255,255,0.02)";
    const img = document.createElement("img");
    img.src = d;
    img.style.width = "120px";
    img.style.height = "90px";
    img.style.objectFit = "cover";
    const cap = document.createElement("div");
    cap.textContent = name;
    cap.style.fontSize = "11px";
    cap.style.color = "var(--muted)";
    cap.style.padding = "6px 8px";
    cap.style.whiteSpace = "nowrap";
    cap.style.overflow = "hidden";
    cap.style.textOverflow = "ellipsis";
    wrap.appendChild(img);
    wrap.appendChild(cap);
    root.appendChild(wrap);
  }
}

function normalizePositionRow(r) {
  const symbol = String(r?.symbol || "").trim().toUpperCase();
  const name = String(r?.name || "").trim();
  const qty = Number(r?.qty);
  const avgPrice = r?.avgPrice === null || r?.avgPrice === undefined || r?.avgPrice === "" ? null : Number(r.avgPrice);
  const currency = String(r?.currency || "").trim().toUpperCase() || null;
  return {
    symbol,
    name,
    qty: Number.isFinite(qty) ? qty : null,
    avgPrice: Number.isFinite(avgPrice) ? avgPrice : null,
    currency
  };
}

function renderEditableTable(rows, quotesBySymbol = {}) {
  const wrap = $("tableWrap");
  const table = document.createElement("table");
  table.className = "macroTable";
  table.style.width = "100%";
  table.innerHTML =
    "<thead><tr>" +
    "<th>티커</th><th>종목명</th><th>수량</th><th>매수가</th><th>통화</th><th>현재가(Yahoo)</th><th>평가액(참고)</th><th></th>" +
    "</tr></thead>";
  const tbody = document.createElement("tbody");

  const makeInput = (value, onChange, placeholder = "") => {
    const input = document.createElement("input");
    input.className = "modal__input";
    input.style.height = "34px";
    input.style.borderRadius = "10px";
    input.style.padding = "0 10px";
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.addEventListener("change", () => onChange(input.value));
    return input;
  };

  const fmt = (n) => (Number.isFinite(Number(n)) ? String(n) : "-");
  const fmtMoney = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "-";
    return x.toLocaleString();
  };

  rows.forEach((row, idx) => {
    const q = quotesBySymbol[row.symbol] || null;
    const last = q?.regularMarketPrice ?? null;
    const value = Number.isFinite(Number(row.qty)) && Number.isFinite(Number(last)) ? Number(row.qty) * Number(last) : null;

    const tr = document.createElement("tr");

    const tdSymbol = document.createElement("td");
    tdSymbol.appendChild(
      makeInput(row.symbol, (v) => (row.symbol = String(v || "").trim().toUpperCase()), "AAPL")
    );
    const tdName = document.createElement("td");
    tdName.appendChild(makeInput(row.name, (v) => (row.name = String(v || "").trim()), "Apple Inc."));
    const tdQty = document.createElement("td");
    tdQty.appendChild(makeInput(row.qty ?? "", (v) => (row.qty = v === "" ? null : Number(v)), "10"));
    const tdAvg = document.createElement("td");
    tdAvg.appendChild(makeInput(row.avgPrice ?? "", (v) => (row.avgPrice = v === "" ? null : Number(v)), "150"));
    const tdCur = document.createElement("td");
    tdCur.appendChild(makeInput(row.currency ?? "", (v) => (row.currency = String(v || "").trim().toUpperCase()), "USD"));

    const tdLast = document.createElement("td");
    tdLast.textContent = fmtMoney(last);
    const tdVal = document.createElement("td");
    tdVal.textContent = value === null ? "-" : fmtMoney(value);

    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn--ghost btn--compact";
    delBtn.type = "button";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      rows.splice(idx, 1);
      renderEditableTable(rows, quotesBySymbol);
      $("save").disabled = !rows.length;
      $("refreshQuotes").disabled = !rows.length;
    });
    tdDel.appendChild(delBtn);

    tr.appendChild(tdSymbol);
    tr.appendChild(tdName);
    tr.appendChild(tdQty);
    tr.appendChild(tdAvg);
    tr.appendChild(tdCur);
    tr.appendChild(tdLast);
    tr.appendChild(tdVal);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  // totals (by currency) - based on Yahoo quote currency/price when available
  const totalsByCur = new Map();
  for (const row of rows) {
    const q = quotesBySymbol[String(row.symbol || "").toUpperCase()] || null;
    const cur = String(q?.currency || row.currency || "").trim() || "-";
    const qty = Number(row.qty);
    const last = q?.regularMarketPrice ?? null;
    const value = Number.isFinite(qty) && Number.isFinite(Number(last)) ? qty * Number(last) : null;
    if (!Number.isFinite(Number(value))) continue;
    totalsByCur.set(cur, (totalsByCur.get(cur) || 0) + Number(value));
  }

  const totalsEl = document.createElement("div");
  totalsEl.className = "modal__note";
  totalsEl.style.marginTop = "10px";
  if (!totalsByCur.size) {
    totalsEl.textContent = "합계 자산(평가액): -";
  } else {
    const lines = Array.from(totalsByCur.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([cur, total]) => `합계 자산(평가액): ${Number(total).toLocaleString()} ${cur}`);
    totalsEl.textContent = lines.join(" · ");
  }

  const addBtn = document.createElement("button");
  addBtn.className = "btn btn--ghost";
  addBtn.type = "button";
  addBtn.textContent = "행 추가";
  addBtn.addEventListener("click", () => {
    rows.push({ symbol: "", name: "", qty: null, avgPrice: null, currency: null });
    renderEditableTable(rows, quotesBySymbol);
    $("save").disabled = !rows.length;
    $("refreshQuotes").disabled = !rows.length;
  });

  wrap.innerHTML = "";
  wrap.appendChild(table);
  wrap.appendChild(document.createElement("div")).style.height = "10px";
  wrap.appendChild(totalsEl);
  wrap.appendChild(document.createElement("div")).style.height = "10px";
  wrap.appendChild(addBtn);
}

async function fetchYahooQuotes(symbols) {
  const qs = new URLSearchParams({ symbols: symbols.join(",") });
  const resp = await fetch(`/api/yahoo/quotes?${qs.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) throw new Error(data?.error || resp.statusText || "Yahoo quotes error");
  return data;
}

async function loadSavedPortfolio(db, user) {
  const ref = db.collection("users").doc(user.uid).collection("portfolios").doc("current");
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

async function savePortfolio(db, user, payload) {
  const ref = db.collection("users").doc(user.uid).collection("portfolios").doc("current");
  await ref.set(
    {
      ...payload,
      uid: user.uid,
      email: user.email || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

function renderSavedPortfolio(saved) {
  const el = $("savedWrap");
  if (!saved) {
    el.textContent = "저장된 포트폴리오가 없습니다.";
    return;
  }
  const positions = Array.isArray(saved.positions) ? saved.positions : [];
  el.textContent =
    `updatedAt: ${saved.updatedAt?.toDate ? saved.updatedAt.toDate().toLocaleString() : "-"}\n` +
    positions
      .slice(0, 80)
      .map((p) => `- ${p.symbol} · qty=${p.qty}${p.avgPrice != null ? ` · avg=${p.avgPrice}` : ""}`)
      .join("\n");
}

async function main() {
  const { auth, db } = initFirebase();
  const next = "/portfolio.html";

  let currentUser = null;
  let extractedRows = [];
  let latestQuotes = {};
  let lastImagesMeta = [];

  $("extract").addEventListener("click", async () => {
    if (!currentUser) return;
    const files = Array.from($("images").files || []);
    if (!files.length) {
      $("hint").textContent = "이미지 1장 이상 업로드해주세요.";
      return;
    }

    $("extract").disabled = true;
    $("save").disabled = true;
    $("refreshQuotes").disabled = true;
    $("hint").textContent = "이미지 전처리(리사이즈/압축) 중…";

    try {
      // 리사이즈/압축 후 dataURL 생성(요청 바디 제한 대응)
      const dataUrls = [];
      lastImagesMeta = [];
      for (const f of files.slice(0, 5)) {
        const d = await resizeToJpegDataUrl(f, { maxDim: 1280, quality: 0.78 });
        dataUrls.push(d);
        lastImagesMeta.push({ name: f.name, type: f.type, size: f.size });
      }
      renderThumbs(files.slice(0, 5), dataUrls);

      $("hint").textContent = "Vision LLM으로 종목/수량/매수가 인식 중…";
      const symbol = tvToYahooSymbol(localStorage.getItem("last_symbol") || "NASDAQ:AAPL");
      const resp = await fetch("/api/portfolio_extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: dataUrls,
          hint_symbol: symbol
        })
      });
      const out = await resp.json().catch(() => ({}));
      if (!resp.ok || !out?.ok) throw new Error(out?.error || "extract failed");

      extractedRows = (Array.isArray(out.positions) ? out.positions : []).map(normalizePositionRow).filter((r) => r.symbol);
      if (!extractedRows.length) {
        $("hint").textContent = "추출 결과가 비어 있습니다. 이미지 품질/확대/다른 캡처로 다시 시도해보세요.";
        renderEditableTable([]);
        return;
      }

      $("hint").textContent = `추출 완료: ${extractedRows.length}개 행 (검토/수정 후 저장하세요)`;

      // 시세 연동
      const symbols = Array.from(new Set(extractedRows.map((r) => r.symbol).filter(Boolean))).slice(0, 30);
      const q = await fetchYahooQuotes(symbols);
      latestQuotes = {};
      for (const row of q.quotes || []) latestQuotes[String(row.symbol || "").toUpperCase()] = row;

      renderEditableTable(extractedRows, latestQuotes);
      $("save").disabled = false;
      $("refreshQuotes").disabled = false;
    } catch (e) {
      $("hint").textContent = `오류: ${e?.message || e}`;
    } finally {
      $("extract").disabled = false;
    }
  });

  $("refreshQuotes").addEventListener("click", async () => {
    try {
      const symbols = Array.from(new Set(extractedRows.map((r) => String(r.symbol || "").trim().toUpperCase()).filter(Boolean))).slice(0, 30);
      if (!symbols.length) return;
      $("hint").textContent = "실시간 시세 불러오는 중…";
      const q = await fetchYahooQuotes(symbols);
      latestQuotes = {};
      for (const row of q.quotes || []) latestQuotes[String(row.symbol || "").toUpperCase()] = row;
      renderEditableTable(extractedRows, latestQuotes);
      $("hint").textContent = "시세 갱신 완료";
    } catch (e) {
      $("hint").textContent = `시세 갱신 실패: ${e?.message || e}`;
    }
  });

  $("save").addEventListener("click", async () => {
    if (!currentUser) return;
    let positions = extractedRows
      .map(normalizePositionRow)
      .filter((r) => r.symbol && Number.isFinite(Number(r.qty)));
    if (!positions.length) {
      $("hint").textContent = "저장할 포지션이 없습니다(티커/수량 확인).";
      return;
    }
    $("save").disabled = true;
    $("hint").textContent = "저장 중…";
    try {
      // Resolve symbols via ticker_master (티커/영문/한글/별칭 모두 지원)
      const resolved = [];
      for (const p of positions) {
        const raw = String(p.symbol || "").trim();
        if (!raw) continue;
        if (isSafeYahooSymbol(raw) && !/[가-힣\\s]/.test(raw) && raw.length <= 12) {
          resolved.push({ ...p, symbol: raw.toUpperCase() });
          continue;
        }
        const r = await resolveTickerFromMaster(db, raw);
        if (!r.symbol) {
          $("hint").textContent = `심볼을 찾지 못했어요: "${raw}"\\n티커(AAPL)로 수정 후 다시 저장해 주세요.`;
          $("save").disabled = false;
          return;
        }
        const name =
          String(p.name || "").trim() ||
          (r.row?.name_ko ? `${String(r.row.name_ko).trim()}${r.row?.name_en ? " / " + String(r.row.name_en).trim() : ""}` : String(r.row?.name_en || "").trim());
        resolved.push({ ...p, symbol: r.symbol, name });
      }

      positions = resolved.filter((r) => r.symbol && Number.isFinite(Number(r.qty)));
      extractedRows = positions.map((p) => ({ ...p })); // keep UI in sync

      await savePortfolio(db, currentUser, {
        positions,
        source: "vision_upload",
        imagesMeta: lastImagesMeta,
        note: ""
      });
      $("hint").textContent = "저장 완료";
      const saved = await loadSavedPortfolio(db, currentUser);
      renderSavedPortfolio(saved);
    } catch (e) {
      const msg = String(e?.message || e);
      // Firestore rules 문제일 때 UX 가이드
      if (/permission|insufficient|PERMISSION_DENIED|missing or insufficient/i.test(msg)) {
        $("hint").textContent =
          "저장 실패: Firestore 권한(보안 규칙) 때문에 차단되었습니다.\n" +
          "Firebase Console → Firestore Database → Rules에서 아래가 포함되어야 합니다:\n" +
          "match /users/{uid}/portfolios/{pid} { allow read, write: if request.auth.uid == uid; }\n" +
          "(README의 Firestore 규칙 섹션 참고)";
      } else {
        $("hint").textContent = `저장 실패: ${msg}`;
      }
    } finally {
      $("save").disabled = false;
    }
  });

  $("logout").addEventListener("click", async () => {
    await auth.signOut();
  });

  auth.onAuthStateChanged(async (user) => {
    currentUser = user || null;
    if (!user) {
      const nextParam = encodeURIComponent(next);
      location.href = `/login.html?next=${nextParam}`;
      return;
    }
    $("userBadge").textContent = `${user.email || "(이메일 없음)"} · uid: ${user.uid}`;
    try {
      const saved = await loadSavedPortfolio(db, user);
      renderSavedPortfolio(saved);
    } catch {
      // ignore
    }
  });
}

main();


