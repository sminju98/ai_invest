const $ = (id) => document.getElementById(id);

// keep same keys as app.js for consistency
const CLOUD_SAVE_PREF_KEY = "goyo_ai_cloud_save_pref_v1";
const CLOUD_SESSION_KEY = "goyo_ai_cloud_chat_session_v1";
const CLOUD_SESSION_META_KEY = "goyo_ai_cloud_chat_session_meta_v1";
const CLOUD_SESSION_MODE_KEY = "goyo_ai_cloud_chat_session_mode_v1";

function loadJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function cloudSaveEnabled() {
  const pref = loadJsonStorage(CLOUD_SAVE_PREF_KEY, { enabled: true });
  return typeof pref?.enabled === "boolean" ? pref.enabled : true;
}

function setCloudSaveEnabled(v) {
  saveJsonStorage(CLOUD_SAVE_PREF_KEY, { enabled: !!v });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function getSessionMode() {
  const m = String(localStorage.getItem(CLOUD_SESSION_MODE_KEY) || "day_symbol");
  return ["day", "day_symbol", "symbol", "topic"].includes(m) ? m : "day_symbol";
}

function setSessionMode(m) {
  const v = ["day", "day_symbol", "symbol", "topic"].includes(m) ? m : "day_symbol";
  localStorage.setItem(CLOUD_SESSION_MODE_KEY, v);
}

function safeSlug(s, max = 24) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function tvSymbolToYahooSymbol(sym) {
  const s = String(sym || "").trim();
  if (!s) return "AAPL";
  const parts = s.split(":");
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

function currentYahooSymbol() {
  return tvSymbolToYahooSymbol(String(localStorage.getItem("last_symbol") || "NASDAQ:AAPL"));
}

function readSessionMeta() {
  return loadJsonStorage(CLOUD_SESSION_META_KEY, null);
}

function writeSessionMeta(meta) {
  saveJsonStorage(CLOUD_SESSION_META_KEY, meta || null);
}

function buildSessionId({ mode, day, symbol, topic }) {
  const d = day || todayKey();
  const sym = safeSlug(symbol || currentYahooSymbol(), 16).toUpperCase();
  if (mode === "day") return `d_${d}`;
  if (mode === "symbol") return `sym_${sym}`;
  if (mode === "topic") return `t_${d}_${safeSlug(topic || "topic", 20)}`;
  return `ds_${d}_${sym}`;
}

function startNewCloudSession({ reason, topic } = {}) {
  const mode = getSessionMode();
  const day = todayKey();
  const symbol = currentYahooSymbol();
  const sid = buildSessionId({ mode, day, symbol, topic });
  localStorage.setItem(CLOUD_SESSION_KEY, sid);
  const meta = {
    sessionId: sid,
    mode,
    day,
    symbol: symbol || "",
    topic: mode === "topic" ? String(topic || "").trim() : "",
    reason: String(reason || ""),
    createdAtClient: Date.now()
  };
  writeSessionMeta(meta);
  return meta;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initFirebase() {
  const cfg = window.GOYO_FIREBASE_CONFIG || null;
  if (!cfg || !cfg.apiKey) throw new Error("Firebase 설정이 없습니다. public/firebase-config.js를 확인하세요.");
  if (!window.firebase) throw new Error("Firebase SDK 로드 실패");
  firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();
  let analytics = null;
  try {
    analytics = firebase.analytics ? firebase.analytics() : null;
  } catch {
    analytics = null;
  }
  return { auth, db, analytics };
}

function logEventSafe(analytics, name, params) {
  try {
    if (!analytics) return;
    analytics.logEvent(String(name || ""), params && typeof params === "object" ? params : undefined);
  } catch {
    // ignore
  }
}

async function fetchYahooQuotes(symbols) {
  const qs = new URLSearchParams({ symbols: symbols.join(",") });
  const resp = await fetch(`/api/yahoo/quotes?${qs.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) throw new Error(data?.error || resp.statusText || "Yahoo quotes error");
  return data;
}

async function loadStructuredPortfolio(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("portfolios").doc("current").get();
  return snap.exists ? snap.data() : null;
}

function clampText(s, max = 60_000) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) + "\n...(TRUNCATED)" : t;
}

function parseSseChunks(text) {
  // minimal SSE parser chunk helper (server sends JSON in data lines)
  const events = [];
  const blocks = String(text || "").split("\n\n");
  for (const b of blocks) {
    const lines = b.split("\n");
    let ev = "";
    const dataLines = [];
    for (const ln of lines) {
      if (ln.startsWith("event:")) ev = ln.slice(6).trim();
      else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
    }
    if (!ev && !dataLines.length) continue;
    const dataStr = dataLines.join("\n");
    let data = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {
      // keep as string
    }
    events.push({ event: ev || "message", data });
  }
  return events;
}

function renderPortfolioTable(saved, quotes) {
  const el = $("portfolioTable");
  const positions = Array.isArray(saved?.positions) ? saved.positions : [];
  if (!positions.length) {
    el.textContent = "포트폴리오가 비어 있습니다. '포트폴리오 입력(사진 업로드)'로 등록해 주세요.";
    return;
  }

  const bySym = new Map((quotes || []).map((q) => [String(q?.symbol || "").toUpperCase(), q]));
  const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "-");

  const rows = positions
    .map((p) => {
      const sym = String(p?.symbol || "").toUpperCase();
      const q = bySym.get(sym) || {};
      const qty = Number(p?.qty);
      const last = q?.regularMarketPrice ?? null;
      const cur = q?.currency || p?.currency || "";
      const value = Number.isFinite(qty) && Number.isFinite(Number(last)) ? qty * Number(last) : null;
      return {
        sym,
        name: q?.shortName || p?.name || "",
        qty: Number.isFinite(qty) ? qty : null,
        avg: p?.avgPrice ?? null,
        cur,
        last,
        value
      };
    })
    .filter((r) => r.sym);

  // totals by currency
  const totalsByCur = new Map();
  for (const r of rows) {
    const cur = String(r.cur || "").trim() || "-";
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    totalsByCur.set(cur, (totalsByCur.get(cur) || 0) + v);
  }
  const totalRowsHtml = Array.from(totalsByCur.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([cur, total]) => {
      return (
        `<tr>` +
        `<td colspan="5"><b>합계 자산(평가액)</b></td>` +
        `<td><b>${fmt(total)}</b></td>` +
        `<td><b>${escapeHtml(cur)}</b></td>` +
        `</tr>`
      );
    })
    .join("");

  el.innerHTML =
    `<table class="macroTable">` +
    `<thead><tr><th>티커</th><th>이름</th><th>수량</th><th>매수가</th><th>현재가</th><th>평가액(참고)</th><th>통화</th></tr></thead>` +
    `<tbody>` +
    rows
      .map((r) => {
        const qty = r.qty == null ? "-" : fmt(r.qty);
        const avg = r.avg == null ? "-" : fmt(r.avg);
        const last = r.last == null ? "-" : fmt(r.last);
        const value = r.value == null ? "-" : fmt(r.value);
        return (
          `<tr>` +
          `<td>${escapeHtml(r.sym)}</td>` +
          `<td>${escapeHtml(r.name)}</td>` +
          `<td>${qty}</td>` +
          `<td>${avg}</td>` +
          `<td>${last}</td>` +
          `<td>${value}</td>` +
          `<td>${escapeHtml(r.cur)}</td>` +
          `</tr>`
        );
      })
      .join("") +
    `</tbody>` +
    (totalRowsHtml ? `<tfoot>${totalRowsHtml}</tfoot>` : "") +
    `</table>`;
}

async function restoreLatestSession(db, user) {
  const u = db.collection("users").doc(user.uid);
  let snap;
  try {
    snap = await u.collection("chat_sessions").orderBy("updatedAt", "desc").limit(1).get();
  } catch {
    snap = await u.collection("chat_sessions").orderBy("createdAt", "desc").limit(1).get();
  }
  const doc = snap.docs[0];
  if (!doc) return { ok: true, restored: 0 };
  const data = doc.data() || {};
  localStorage.setItem(CLOUD_SESSION_KEY, doc.id);
  writeSessionMeta({
    sessionId: doc.id,
    mode: String(data.mode || getSessionMode()),
    day: String(data.day || ""),
    symbol: String(data.symbol || ""),
    topic: String(data.topic || ""),
    reason: "manual_restore_latest",
    createdAtClient: Date.now()
  });
  return { ok: true, sessionId: doc.id };
}

function renderSessionMeta() {
  const meta = readSessionMeta();
  const sid = String(localStorage.getItem(CLOUD_SESSION_KEY) || meta?.sessionId || "-");
  const parts = [
    `현재 세션: ${sid}`,
    `모드: ${getSessionMode()}`,
    meta?.day ? `day: ${meta.day}` : "",
    meta?.symbol ? `symbol: ${meta.symbol}` : "",
    meta?.topic ? `topic: ${meta.topic}` : ""
  ].filter(Boolean);
  $("sessionMeta").textContent = parts.join(" · ");
}

async function main() {
  const { auth, db, analytics } = initFirebase();
  logEventSafe(analytics, "app_open", { page: "mypage" });

  $("cloudSave").checked = cloudSaveEnabled();
  $("sessionMode").value = getSessionMode();
  renderSessionMeta();

  $("cloudSave").addEventListener("change", (e) => {
    setCloudSaveEnabled(!!e?.target?.checked);
    $("hint").textContent = cloudSaveEnabled() ? "클라우드 기록 저장을 켰습니다." : "클라우드 기록 저장을 껐습니다.";
  });

  $("sessionMode").addEventListener("change", (e) => {
    const v = String(e?.target?.value || "day_symbol");
    setSessionMode(v);
    if (getSessionMode() !== "topic") startNewCloudSession({ reason: "mode_changed" });
    renderSessionMeta();
  });

  $("newSession").addEventListener("click", () => {
    const mode = getSessionMode();
    let topic = "";
    if (mode === "topic") {
      topic = prompt("새 세션 주제(예: AAPL 실적/경쟁/시장 반응)") || "";
      if (!String(topic).trim()) {
        $("hint").textContent = "주제 세션은 주제 입력이 필요합니다.";
        return;
      }
    }
    startNewCloudSession({ reason: "manual_new_session", topic });
    renderSessionMeta();
    $("hint").textContent = "새 세션을 시작했습니다.";
  });

  $("goPortfolioInput").addEventListener("click", () => {
    location.href = "/portfolio.html";
  });

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      const next = encodeURIComponent("/mypage.html");
      location.href = `/login.html?next=${next}`;
      return;
    }
    $("userBadge").textContent = `${user.email || "(이메일 없음)"} · uid: ${user.uid}`;

    $("logout").addEventListener("click", async () => {
      await auth.signOut();
      logEventSafe(analytics, "logout");
    });

    // memo load/save
    $("loadMemo").addEventListener("click", async () => {
      try {
        const snap = await db.collection("users").doc(user.uid).get();
        $("portfolioText").value = String(snap.data()?.portfolioText || "");
        $("hint").textContent = "메모를 불러왔습니다.";
      } catch (e) {
        $("hint").textContent = `메모 불러오기 실패: ${e?.message || e}`;
      }
    });
    $("saveMemo").addEventListener("click", async () => {
      try {
        await db.collection("users").doc(user.uid).set(
          {
            portfolioText: String($("portfolioText").value || ""),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        $("hint").textContent = "메모를 저장했습니다.";
      } catch (e) {
        $("hint").textContent = `메모 저장 실패: ${e?.message || e}`;
      }
    });

    // portfolio + quotes
    let lastSaved = null;
    let lastQuotes = [];
    let analysisAbort = null;

    async function refreshAll() {
      try {
        $("portfolioTable").textContent = "불러오는 중…";
        const saved = await loadStructuredPortfolio(db, user.uid);
        const positions = Array.isArray(saved?.positions) ? saved.positions : [];
        const symbols = Array.from(new Set(positions.map((p) => String(p?.symbol || "").toUpperCase()).filter(Boolean))).slice(0, 25);
        if (!symbols.length) {
          renderPortfolioTable(saved, []);
          lastSaved = saved;
          lastQuotes = [];
          return;
        }
        const q = await fetchYahooQuotes(symbols);
        renderPortfolioTable(saved, q.quotes || []);
        lastSaved = saved;
        lastQuotes = q.quotes || [];
        $("hint").textContent = `포트폴리오/시세 갱신 완료 (${new Date(q.asOf || Date.now()).toLocaleString()})`;
      } catch (e) {
        $("hint").textContent = `갱신 실패: ${e?.message || e}`;
      }
    }

    $("refreshPortfolio").addEventListener("click", refreshAll);
    $("refreshQuotes").addEventListener("click", refreshAll);
    await refreshAll();

    // portfolio analysis (SSE)
    const runBtn = $("runPortfolioAnalysis");
    const stopBtn = $("stopPortfolioAnalysis");
    const statusEl = $("portfolioAnalysisStatus");
    const outEl = $("portfolioAnalysisOut");

    async function runAnalysis() {
      if (!lastSaved || !Array.isArray(lastSaved?.positions) || !lastSaved.positions.length) {
        statusEl.textContent = "포트폴리오가 비어 있습니다.";
        outEl.textContent = "-";
        return;
      }
      if (analysisAbort) {
        try {
          analysisAbort.abort();
        } catch {
          // ignore
        }
      }
      analysisAbort = new AbortController();
      runBtn.disabled = true;
      stopBtn.disabled = false;
      statusEl.textContent = "분석 생성 중…";
      outEl.textContent = "";

      try {
        const memo = String($("portfolioText")?.value || "");
        const payload = {
          positions: lastSaved.positions,
          quotes: lastQuotes,
          memo: clampText(memo, 20_000),
          mode: "human_decision_structure",
          topN: 10
        };
        const resp = await fetch("/api/portfolio_analysis_stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: analysisAbort.signal
        });
        if (!resp.ok || !resp.body) {
          const t = await resp.text().catch(() => "");
          statusEl.textContent = `오류: ${resp.status}`;
          outEl.textContent = t || resp.statusText;
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const idx = buf.lastIndexOf("\n\n");
          if (idx < 0) continue;
          const chunk = buf.slice(0, idx + 2);
          buf = buf.slice(idx + 2);
          for (const ev of parseSseChunks(chunk)) {
            if (ev.event === "status") statusEl.textContent = String(ev.data?.stage || ev.data?.message || "진행 중…");
            if (ev.event === "final") {
              statusEl.textContent = "완료";
              outEl.textContent = String(ev.data?.answer || ev.data?.text || "").trim() || "-";
            }
            if (ev.event === "error") {
              statusEl.textContent = "오류";
              outEl.textContent = String(ev.data?.details || ev.data?.error || "").trim() || "오류";
            }
          }
        }
      } catch (e) {
        const msg = String(e?.name === "AbortError" ? "중지됨" : e?.message || e);
        statusEl.textContent = msg;
        if (e?.name === "AbortError") outEl.textContent = outEl.textContent || "(중지됨)";
      } finally {
        runBtn.disabled = false;
        stopBtn.disabled = true;
      }
    }

    runBtn?.addEventListener("click", runAnalysis);
    stopBtn?.addEventListener("click", () => {
      try {
        analysisAbort?.abort();
      } catch {
        // ignore
      }
    });

    // restore
    $("restoreLatest").addEventListener("click", async () => {
      try {
        const r = await restoreLatestSession(db, user);
        $("hint").textContent = r.sessionId ? `최신 세션으로 전환: ${r.sessionId}` : "최신 세션이 없습니다.";
        renderSessionMeta();
      } catch (e) {
        $("hint").textContent = `최신 세션 복원 실패: ${e?.message || e}`;
      }
    });
    $("restoreCurrent").addEventListener("click", () => {
      $("hint").textContent = "현재 세션 ID를 유지합니다. (홈에서 채팅 기록 불러오기 시 적용)";
      renderSessionMeta();
    });
  });
}

main();


