const $ = (id) => document.getElementById(id);

// --- Chat persistence (localStorage) ---
const CHAT_STORAGE_KEY = "finance_agent_chat_v1";
const CHAT_STORAGE_MAX = 250;

// --- Firebase Auth + Firestore (optional) + Portfolio (fallback localStorage) ---
const PORTFOLIO_STORAGE_KEY = "goyo_ai_invest_portfolio_v1";
const CLOUD_SAVE_PREF_KEY = "goyo_ai_cloud_save_pref_v1";
const CLOUD_SESSION_KEY = "goyo_ai_cloud_chat_session_v1";
const CLOUD_SESSION_META_KEY = "goyo_ai_cloud_chat_session_meta_v1";
const CLOUD_SESSION_MODE_KEY = "goyo_ai_cloud_chat_session_mode_v1";
const CLOUD_AUTO_RESTORED_KEY = "goyo_ai_cloud_auto_restored_v1";

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

let portfolioState = loadJsonStorage(PORTFOLIO_STORAGE_KEY, { text: "" });
let cloudSavePref = loadJsonStorage(CLOUD_SAVE_PREF_KEY, { enabled: true });
if (typeof cloudSavePref?.enabled !== "boolean") cloudSavePref = { enabled: true };

function cloudSaveEnabled() {
  return !!cloudSavePref?.enabled;
}

function setCloudSaveEnabled(v) {
  cloudSavePref = { enabled: !!v };
  saveJsonStorage(CLOUD_SAVE_PREF_KEY, cloudSavePref);
}

function clampCloudText(s, max = 20_000) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) + "\n...(TRUNCATED)" : t;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadStructuredPortfolioCurrent() {
  if (!firebaseReady() || !firebaseSignedIn()) return null;
  const u = userDocRef();
  if (!u) return null;
  const snap = await u.collection("portfolios").doc("current").get();
  if (!snap.exists) return null;
  return snap.data() || null;
}

async function applyFilledPaperOrderToPortfolio(order) {
  if (!firebaseSignedIn() || !firebaseReady()) {
    addMessage("system", "포트폴리오 반영을 위해 로그인이 필요합니다. (마이페이지/포트폴리오에서 확인 가능)", "error");
    return { ok: false, reason: "not_signed_in" };
  }
  const status = String(order?.status || "").toUpperCase();
  if (status !== "FILLED") return { ok: false, reason: "not_filled" };

  const symbol = String(order?.symbol || "").trim().toUpperCase();
  const side = String(order?.side || "").toUpperCase();
  const qty = Number(order?.qty);
  if (!symbol || !Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_order" };

  const fillPrice = typeof order?.filledPrice === "number" && Number.isFinite(order.filledPrice) ? Number(order.filledPrice) : null;
  const fillCurrency = order?.filledCurrency ? String(order.filledCurrency).toUpperCase() : null;

  const u = userDocRef();
  if (!u) return { ok: false, reason: "no_user_doc" };
  const ref = u.collection("portfolios").doc("current");

  let result = null;
  await fbState.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() || {} : {};
    const positions = Array.isArray(cur.positions) ? cur.positions.map((p) => ({ ...p })) : [];
    const idx = positions.findIndex((p) => String(p?.symbol || "").toUpperCase() === symbol);

    const old = idx >= 0 ? positions[idx] : { symbol, name: "", qty: 0, avgPrice: null, currency: fillCurrency || null };
    const oldQty = Number(old?.qty);
    const oldAvg = old?.avgPrice === null || old?.avgPrice === undefined ? null : Number(old.avgPrice);
    const safeOldQty = Number.isFinite(oldQty) && oldQty > 0 ? oldQty : 0;

    if (side === "BUY") {
      const newQty = safeOldQty + qty;
      let newAvg = oldAvg;
      if (fillPrice != null) {
        if (Number.isFinite(oldAvg) && safeOldQty > 0) {
          newAvg = (safeOldQty * oldAvg + qty * fillPrice) / newQty;
        } else {
          newAvg = fillPrice;
        }
      }
      const next = {
        ...old,
        symbol,
        qty: newQty,
        avgPrice: newAvg == null ? null : Number(newAvg),
        currency: (old?.currency || fillCurrency || null) ? String(old?.currency || fillCurrency).toUpperCase() : null
      };
      if (idx >= 0) positions[idx] = next;
      else positions.push(next);
      result = { action: "BUY", symbol, oldQty: safeOldQty, newQty, avgPrice: next.avgPrice, currency: next.currency };
    } else if (side === "SELL") {
      const newQty = Math.max(0, safeOldQty - qty);
      if (idx < 0 || safeOldQty <= 0) {
        result = { action: "SELL", symbol, oldQty: 0, newQty: 0, warning: "no_position" };
      } else if (newQty === 0) {
        positions.splice(idx, 1);
        result = { action: "SELL", symbol, oldQty: safeOldQty, newQty: 0, removed: true };
      } else {
        positions[idx] = { ...old, qty: newQty };
        result = { action: "SELL", symbol, oldQty: safeOldQty, newQty };
      }
    } else {
      result = { action: "UNKNOWN", symbol, oldQty: safeOldQty, newQty: safeOldQty };
    }

    tx.set(
      ref,
      {
        positions,
        source: "paper_order",
        lastTrade: {
          id: String(order?.id || ""),
          symbol,
          side,
          qty,
          filledPrice: fillPrice,
          filledCurrency: fillCurrency,
          filledAt: order?.filledAt || null
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  if (result) {
    addMessage(
      "system",
      result.action === "BUY"
        ? `포트폴리오 반영: ${result.symbol} 매수 ${qty}주 (보유 ${result.oldQty} → ${result.newQty})`
        : result.action === "SELL"
          ? `포트폴리오 반영: ${result.symbol} 매도 ${qty}주 (보유 ${result.oldQty} → ${result.newQty})`
          : `포트폴리오 반영: 처리 불가`
    );
  }
  return { ok: true, result };
}

async function refreshMyPageQuotes() {
  const el = $("mypageQuotes");
  if (!el) return;
  if (!firebaseSignedIn() || !firebaseReady()) {
    el.textContent = "로그인이 필요합니다.";
    return;
  }
  try {
    el.textContent = "실시간 시세 불러오는 중…";
    const saved = await loadStructuredPortfolioCurrent();
    const positions = Array.isArray(saved?.positions) ? saved.positions : [];
    const symbols = Array.from(new Set(positions.map((p) => String(p?.symbol || "").trim().toUpperCase()).filter(Boolean))).slice(0, 25);
    if (!symbols.length) {
      el.textContent = "저장된 구조화 포트폴리오가 없습니다. (포트폴리오 페이지에서 저장해 주세요)";
      return;
    }
    const qs = new URLSearchParams({ symbols: symbols.join(",") });
    const resp = await fetch(`/api/yahoo/quotes?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) throw new Error(data?.error || resp.statusText || "quotes error");
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const bySym = new Map(quotes.map((q) => [String(q?.symbol || "").toUpperCase(), q]));

    const rows = symbols.map((sym) => {
      const q = bySym.get(sym) || {};
      const price = q?.regularMarketPrice ?? null;
      const cur = q?.currency || "";
      const p = positions.find((x) => String(x?.symbol || "").toUpperCase() === sym) || {};
      const qty = Number(p?.qty);
      const value = Number.isFinite(qty) && Number.isFinite(Number(price)) ? qty * Number(price) : null;
      return {
        sym,
        name: q?.shortName || p?.name || "",
        qty: Number.isFinite(qty) ? qty : null,
        cur,
        price,
        value
      };
    });

    const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "-");
    el.innerHTML =
      `<div class="macroNewsMeta" style="margin: 2px 0 8px; font-weight: 700;">업데이트: ${escapeHtml(
        new Date(data.asOf || Date.now()).toLocaleString()
      )}</div>` +
      `<table class="macroTable">` +
      `<thead><tr><th>티커</th><th>이름</th><th>수량</th><th>현재가</th><th>평가액(참고)</th></tr></thead>` +
      `<tbody>` +
      rows
        .map((r) => {
          const price = r.price == null ? "-" : `${fmt(r.price)} ${escapeHtml(r.cur)}`;
          const value = r.value == null ? "-" : `${fmt(r.value)} ${escapeHtml(r.cur)}`;
          return `<tr><td>${escapeHtml(r.sym)}</td><td>${escapeHtml(r.name)}</td><td>${r.qty ?? "-"}</td><td>${price}</td><td>${value}</td></tr>`;
        })
        .join("") +
      `</tbody></table>`;
  } catch (e) {
    el.textContent = `시세 갱신 실패: ${String(e?.message || e)}`;
  }
}

async function refreshMyPageStructuredPortfolio() {
  const el = $("mypageStructuredPortfolio");
  if (!el) return;
  if (!firebaseSignedIn() || !firebaseReady()) {
    el.textContent = "로그인이 필요합니다.";
    return;
  }
  try {
    el.textContent = "불러오는 중…";
    const saved = await loadStructuredPortfolioCurrent();
    const positions = Array.isArray(saved?.positions) ? saved.positions : [];
    if (!positions.length) {
      el.textContent = "저장된 포지션이 없습니다. '포트폴리오 입력(사진 업로드)'로 등록해 주세요.";
      return;
    }
    const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "-");
    el.innerHTML =
      `<table class="macroTable">` +
      `<thead><tr><th>티커</th><th>종목명</th><th>수량</th><th>매수가</th><th>통화</th></tr></thead>` +
      `<tbody>` +
      positions
        .slice(0, 60)
        .map((p) => {
          const sym = escapeHtml(String(p?.symbol || ""));
          const name = escapeHtml(String(p?.name || ""));
          const qty = Number.isFinite(Number(p?.qty)) ? fmt(p.qty) : "-";
          const avg = p?.avgPrice == null ? "-" : fmt(p.avgPrice);
          const cur = escapeHtml(String(p?.currency || ""));
          return `<tr><td>${sym}</td><td>${name}</td><td>${qty}</td><td>${avg}</td><td>${cur}</td></tr>`;
        })
        .join("") +
      `</tbody></table>`;
  } catch (e) {
    el.textContent = `불러오기 실패: ${String(e?.message || e)}`;
  }
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

function currentYahooSymbol() {
  try {
    return tvSymbolToYahooSymbol(String($("symbol")?.value || "NASDAQ:AAPL"));
  } catch {
    return "AAPL";
  }
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
  // day_symbol default
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

function getOrCreateCloudSessionId() {
  const existing = String(localStorage.getItem(CLOUD_SESSION_KEY) || "").trim();
  const meta = readSessionMeta();
  const mode = getSessionMode();
  const day = todayKey();
  const symbol = currentYahooSymbol();

  // 자동 회전(하루/종목 모드에서 조건이 바뀌면 새 세션)
  const needRotate =
    !existing ||
    !meta ||
    meta.mode !== mode ||
    (mode === "day" && meta.day !== day) ||
    (mode === "day_symbol" && (meta.day !== day || String(meta.symbol || "").toUpperCase() !== String(symbol || "").toUpperCase())) ||
    (mode === "symbol" && String(meta.symbol || "").toUpperCase() !== String(symbol || "").toUpperCase());

  if (needRotate) {
    // 종목/하루 기준은 자동으로 생성, 주제 기준은 기존 유지(사용자가 새 세션 버튼으로 생성)
    if (mode === "topic" && existing) return existing;
    return startNewCloudSession({ reason: "auto_rotate" }).sessionId;
  }
  return existing;
}

const fbState = {
  enabled: false,
  initError: null,
  app: null,
  auth: null,
  db: null,
  analytics: null,
  user: null
};

function userDocRef() {
  if (!firebaseReady() || !firebaseSignedIn()) return null;
  return fbState.db.collection("users").doc(fbState.user.uid);
}

function chatSessionRef() {
  const u = userDocRef();
  if (!u) return null;
  const sid = getOrCreateCloudSessionId();
  return u.collection("chat_sessions").doc(sid);
}

function chatMessageRef(msgId) {
  const sess = chatSessionRef();
  if (!sess) return null;
  return sess.collection("messages").doc(String(msgId || ""));
}

async function ensureChatSessionDoc() {
  const sess = chatSessionRef();
  if (!sess) return;
  const meta = readSessionMeta() || null;
  await sess.set(
    {
      sessionId: sess.id,
      uid: fbState.user.uid,
      email: fbState.user.email || "",
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      app: "AI Invest",
      userAgent: navigator.userAgent || "",
      mode: meta?.mode || getSessionMode(),
      day: meta?.day || todayKey(),
      symbol: meta?.symbol || currentYahooSymbol(),
      topic: meta?.topic || "",
      title: meta?.topic ? String(meta.topic).slice(0, 40) : ""
    },
    { merge: true }
  );
}

async function upsertCloudMessage(msgId, patch) {
  if (!firebaseReady() || !firebaseSignedIn()) return;
  if (!cloudSaveEnabled()) return;
  const ref = chatMessageRef(msgId);
  const sess = chatSessionRef();
  if (!ref || !sess) return;

  const data = {
    ...patch,
    msgId: String(msgId || ""),
    sessionId: sess.id,
    uid: fbState.user.uid,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  // 최초 생성 시 createdAt이 없으면 함께 세팅
  if (!("createdAt" in data)) data.createdAt = firebase.firestore.FieldValue.serverTimestamp();

  await ref.set(data, { merge: true });
  await sess.set({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function restoreChatFromCloud({ limit = 120 } = {}) {
  if (!firebaseReady() || !firebaseSignedIn()) return { ok: false, reason: "not_signed_in" };
  if (!cloudSaveEnabled()) return { ok: false, reason: "disabled" };

  const sess = chatSessionRef();
  if (!sess) return { ok: false, reason: "no_session" };

  const snap = await sess.collection("messages").orderBy("clientTs", "asc").limit(limit).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!rows.length) return { ok: true, restored: 0 };

  // 화면/로컬을 클라우드로 교체(중복 저장 방지)
  $("messages").innerHTML = "";
  chatStore = [];
  saveChatStore(chatStore);

  for (const m of rows) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const item = addMessage(role, String(m.content || ""), m.variant || role, { skipPersist: true, skipCloud: true });
    if (item) item.dataset.msgId = m.msgId || m.id || item.dataset.msgId;
  }
  addMessage("system", `클라우드 채팅 기록을 불러왔습니다. (${rows.length}개)`, "system", { skipCloud: true });
  return { ok: true, restored: rows.length };
}

async function pickLatestSessionAndRestore({ limit = 160 } = {}) {
  if (!firebaseReady() || !firebaseSignedIn()) return { ok: false, reason: "not_signed_in" };
  if (!cloudSaveEnabled()) return { ok: false, reason: "disabled" };
  const u = userDocRef();
  if (!u) return { ok: false, reason: "no_user" };

  // 최신 세션 1개 선택
  let snap;
  try {
    snap = await u.collection("chat_sessions").orderBy("updatedAt", "desc").limit(1).get();
  } catch {
    // updatedAt가 없는 경우를 대비(초기)
    snap = await u.collection("chat_sessions").orderBy("createdAt", "desc").limit(1).get();
  }

  const doc = snap.docs[0];
  if (!doc) return { ok: true, restored: 0 };
  const data = doc.data() || {};
  const sid = doc.id;

  localStorage.setItem(CLOUD_SESSION_KEY, sid);
  writeSessionMeta({
    sessionId: sid,
    mode: String(data.mode || getSessionMode()),
    day: String(data.day || ""),
    symbol: String(data.symbol || ""),
    topic: String(data.topic || ""),
    reason: "auto_restore_latest",
    createdAtClient: Date.now()
  });

  return await restoreChatFromCloud({ limit });
}

function getFirebaseConfig() {
  return window.GOYO_FIREBASE_CONFIG || null;
}

function firebaseReady() {
  return !!(fbState.enabled && fbState.auth && fbState.db);
}

function firebaseSignedIn() {
  return !!fbState.user;
}

function initFirebaseIfPossible() {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.apiKey) {
    fbState.enabled = false;
    return false;
  }
  if (!window.firebase) {
    fbState.enabled = false;
    fbState.initError = new Error("Firebase SDK가 로드되지 않았습니다.");
    return false;
  }
  try {
    fbState.app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
    fbState.auth = firebase.auth();
    fbState.db = firebase.firestore();
    // Analytics는 환경(확장/차단/로컬)에서 실패할 수 있어 optional 처리
    try {
      fbState.analytics = firebase.analytics ? firebase.analytics() : null;
    } catch {
      fbState.analytics = null;
    }
    fbState.enabled = true;
    return true;
  } catch (e) {
    fbState.enabled = false;
    fbState.initError = e;
    return false;
  }
}

function logAnalyticEvent(name, params) {
  try {
    if (!fbState.analytics) return;
    const n = String(name || "").trim();
    if (!n) return;
    fbState.analytics.logEvent(n, params && typeof params === "object" ? params : undefined);
  } catch {
    // ignore
  }
}

async function signInWithGoogle() {
  if (!firebaseReady()) {
    setModalHint("loginHint", "Firebase 설정이 필요합니다. `public/firebase-config.js`를 확인해주세요.");
    return;
  }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await fbState.auth.signInWithPopup(provider);
    hideModal("loginModal");
    logAnalyticEvent("login", { method: "google" });
    addMessage("system", "Google로 로그인했습니다.");
  } catch (e) {
    // 팝업 차단/환경 이슈 → redirect 폴백
    const msg = String(e?.message || e);
    if (/popup|blocked|cancelled|closed/i.test(msg)) {
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await fbState.auth.signInWithRedirect(provider);
        return;
      } catch (e2) {
        setModalHint("loginHint", `Google 로그인 실패: ${e2?.message || e2}`);
        return;
      }
    }
    setModalHint("loginHint", `Google 로그인 실패: ${msg}`);
  }
}

function renderTopAuthUI() {
  const authPageBtn = $("authPageBtn");
  const logoutBtn = $("logoutBtn");
  const mypageBtn = $("mypageBtn");

  if (!authPageBtn || !logoutBtn || !mypageBtn) return;

  if (firebaseSignedIn()) {
    authPageBtn.style.display = "none";
    logoutBtn.style.display = "";
    logoutBtn.textContent = `로그아웃 (${fbState.user.email || "사용자"})`;
    mypageBtn.style.display = "";
    mypageBtn.disabled = false;
  } else {
    authPageBtn.style.display = "";
    logoutBtn.style.display = "none";
    mypageBtn.style.display = "none";
    mypageBtn.disabled = true;
  }
}

async function ensureUserDoc() {
  if (!firebaseReady() || !firebaseSignedIn()) return;
  const ref = fbState.db.collection("users").doc(fbState.user.uid);
  await ref.set(
    {
      uid: fbState.user.uid,
      email: fbState.user.email || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function loadPortfolioFromCloud() {
  if (!firebaseReady() || !firebaseSignedIn()) return null;
  const ref = fbState.db.collection("users").doc(fbState.user.uid);
  const snap = await ref.get();
  const text = snap.exists ? String(snap.data()?.portfolioText || "") : "";
  portfolioState = { text };
  saveJsonStorage(PORTFOLIO_STORAGE_KEY, portfolioState);
  return text;
}

async function savePortfolioToCloud(text) {
  if (!firebaseReady() || !firebaseSignedIn()) return false;
  const ref = fbState.db.collection("users").doc(fbState.user.uid);
  await ref.set(
    {
      portfolioText: String(text || ""),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return true;
}

function showModal(id) {
  const el = $(id);
  if (!el) return;
  el.style.display = "block";
}

function hideModal(id) {
  const el = $(id);
  if (!el) return;
  el.style.display = "none";
}

function initModalClose(modalId) {
  const modal = $(modalId);
  if (!modal) return;
  modal.addEventListener("click", (e) => {
    if (e?.target?.dataset?.modalClose) hideModal(modalId);
  });
}

function setModalHint(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(text || "");
}

function setMyPageAccount() {
  const el = $("mypageAccount");
  if (!el) return;
  if (firebaseSignedIn()) el.textContent = `${fbState.user.email || "(이메일 없음)"} · uid: ${fbState.user.uid}`;
  else el.textContent = "로그인이 필요합니다.";
}

function setMyPagePortfolioText(text) {
  const t = $("mypagePortfolio");
  if (!t) return;
  t.value = String(text || "");
}

function getMyPagePortfolioText() {
  return String($("mypagePortfolio")?.value || "");
}

function openMyPage() {
  location.href = "/mypage.html";
}

function openLoginModal() {
  // (deprecated) 모달 로그인 제거됨 → 로그인 페이지로 이동
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.href = `/login.html?next=${next}`;
}

function openSignupModal() {
  // (deprecated) 모달 회원가입 제거됨 → 로그인 페이지로 이동(회원가입 탭에서 진행)
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.href = `/login.html?next=${next}`;
}

function loadChatStore() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatStore(items) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(items.slice(-CHAT_STORAGE_MAX)));
  } catch {
    // ignore (quota / disabled)
  }
}

let chatStore = loadChatStore();

function makeMsgId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

function shouldPersistRole(role) {
  // "llm 분석 내용"을 재접속 시 복원하기 위해 user/assistant만 저장
  return role === "user" || role === "assistant";
}

function upsertChatItem(id, patch) {
  const idx = chatStore.findIndex((x) => x && x.id === id);
  if (idx >= 0) chatStore[idx] = { ...chatStore[idx], ...patch };
  else chatStore.push({ id, ...patch });
  saveChatStore(chatStore);
}

function updatePersistedMessage(elOrId, content) {
  const id = typeof elOrId === "string" ? elOrId : elOrId?.dataset?.msgId;
  if (!id) return;
  const item = chatStore.find((x) => x && x.id === id);
  if (!item) return;
  if (!shouldPersistRole(item.role)) return;
  const next = String(content || "");
  upsertChatItem(id, { content: next, ts: item.ts || Date.now() });
  // cloud: 스트리밍 중에는 호출하지 않고, 최종 텍스트 시점에만 호출되는 구조를 유지
  upsertCloudMessage(id, {
    role: item.role,
    variant: item.variant || item.role,
    content: clampCloudText(next),
    clientTs: item.ts || Date.now(),
    ctx: {
      symbol: String($("symbol")?.value || ""),
      interval: String($("interval")?.value || ""),
      view: String(window.leftView || "")
    }
  }).catch(() => {});
}

// --- Symbol quick search (top 100) ---
// NOTE: tvSymbol은 TradingView 입력 형식(예: NASDAQ:AAPL)
const MAJOR_SYMBOLS_100 = [
  // Mega / Tech
  { tvSymbol: "NASDAQ:AAPL", ticker: "AAPL", name: "Apple" },
  { tvSymbol: "NASDAQ:MSFT", ticker: "MSFT", name: "Microsoft" },
  { tvSymbol: "NASDAQ:NVDA", ticker: "NVDA", name: "NVIDIA" },
  { tvSymbol: "NASDAQ:AMZN", ticker: "AMZN", name: "Amazon" },
  { tvSymbol: "NASDAQ:GOOGL", ticker: "GOOGL", name: "Alphabet (Class A)" },
  { tvSymbol: "NASDAQ:GOOG", ticker: "GOOG", name: "Alphabet (Class C)" },
  { tvSymbol: "NASDAQ:META", ticker: "META", name: "Meta Platforms" },
  { tvSymbol: "NASDAQ:TSLA", ticker: "TSLA", name: "Tesla" },
  { tvSymbol: "NASDAQ:AVGO", ticker: "AVGO", name: "Broadcom" },
  { tvSymbol: "NYSE:ORCL", ticker: "ORCL", name: "Oracle" },
  { tvSymbol: "NASDAQ:ADBE", ticker: "ADBE", name: "Adobe" },
  { tvSymbol: "NASDAQ:CRM", ticker: "CRM", name: "Salesforce" },
  { tvSymbol: "NASDAQ:INTC", ticker: "INTC", name: "Intel" },
  { tvSymbol: "NASDAQ:AMD", ticker: "AMD", name: "Advanced Micro Devices" },
  { tvSymbol: "NASDAQ:QCOM", ticker: "QCOM", name: "Qualcomm" },
  { tvSymbol: "NYSE:IBM", ticker: "IBM", name: "IBM" },
  { tvSymbol: "NYSE:NOW", ticker: "NOW", name: "ServiceNow" },
  { tvSymbol: "NYSE:PLTR", ticker: "PLTR", name: "Palantir" },
  { tvSymbol: "NYSE:SNOW", ticker: "SNOW", name: "Snowflake" },
  { tvSymbol: "NASDAQ:MU", ticker: "MU", name: "Micron" },
  { tvSymbol: "NASDAQ:AMAT", ticker: "AMAT", name: "Applied Materials" },
  { tvSymbol: "NASDAQ:LRCX", ticker: "LRCX", name: "Lam Research" },
  { tvSymbol: "NASDAQ:ASML", ticker: "ASML", name: "ASML" },
  { tvSymbol: "NASDAQ:ARM", ticker: "ARM", name: "Arm" },

  // Finance
  { tvSymbol: "NYSE:BRK.B", ticker: "BRK.B", name: "Berkshire Hathaway (B)" },
  { tvSymbol: "NYSE:JPM", ticker: "JPM", name: "JPMorgan Chase" },
  { tvSymbol: "NYSE:BAC", ticker: "BAC", name: "Bank of America" },
  { tvSymbol: "NYSE:WFC", ticker: "WFC", name: "Wells Fargo" },
  { tvSymbol: "NYSE:GS", ticker: "GS", name: "Goldman Sachs" },
  { tvSymbol: "NYSE:MS", ticker: "MS", name: "Morgan Stanley" },
  { tvSymbol: "NYSE:C", ticker: "C", name: "Citigroup" },
  { tvSymbol: "NYSE:V", ticker: "V", name: "Visa" },
  { tvSymbol: "NYSE:MA", ticker: "MA", name: "Mastercard" },
  { tvSymbol: "NYSE:AXP", ticker: "AXP", name: "American Express" },
  { tvSymbol: "NYSE:BLK", ticker: "BLK", name: "BlackRock" },
  { tvSymbol: "NYSE:SPGI", ticker: "SPGI", name: "S&P Global" },

  // Health
  { tvSymbol: "NYSE:UNH", ticker: "UNH", name: "UnitedHealth" },
  { tvSymbol: "NYSE:JNJ", ticker: "JNJ", name: "Johnson & Johnson" },
  { tvSymbol: "NYSE:LLY", ticker: "LLY", name: "Eli Lilly" },
  { tvSymbol: "NYSE:PFE", ticker: "PFE", name: "Pfizer" },
  { tvSymbol: "NYSE:MRK", ticker: "MRK", name: "Merck" },
  { tvSymbol: "NYSE:ABBV", ticker: "ABBV", name: "AbbVie" },
  { tvSymbol: "NYSE:TMO", ticker: "TMO", name: "Thermo Fisher" },
  { tvSymbol: "NYSE:ABT", ticker: "ABT", name: "Abbott" },

  // Consumer / Retail
  { tvSymbol: "NYSE:WMT", ticker: "WMT", name: "Walmart" },
  { tvSymbol: "NYSE:COST", ticker: "COST", name: "Costco" },
  { tvSymbol: "NYSE:HD", ticker: "HD", name: "Home Depot" },
  { tvSymbol: "NYSE:NKE", ticker: "NKE", name: "Nike" },
  { tvSymbol: "NASDAQ:SBUX", ticker: "SBUX", name: "Starbucks" },
  { tvSymbol: "NYSE:DIS", ticker: "DIS", name: "Disney" },
  { tvSymbol: "NYSE:MCD", ticker: "MCD", name: "McDonald's" },
  { tvSymbol: "NASDAQ:BKNG", ticker: "BKNG", name: "Booking" },

  // Energy / Industrials / Materials
  { tvSymbol: "NYSE:XOM", ticker: "XOM", name: "Exxon Mobil" },
  { tvSymbol: "NYSE:CVX", ticker: "CVX", name: "Chevron" },
  { tvSymbol: "NYSE:COP", ticker: "COP", name: "ConocoPhillips" },
  { tvSymbol: "NYSE:SLB", ticker: "SLB", name: "SLB" },
  { tvSymbol: "NYSE:CAT", ticker: "CAT", name: "Caterpillar" },
  { tvSymbol: "NYSE:BA", ticker: "BA", name: "Boeing" },
  { tvSymbol: "NYSE:GE", ticker: "GE", name: "GE Aerospace" },
  { tvSymbol: "NYSE:HON", ticker: "HON", name: "Honeywell" },
  { tvSymbol: "NYSE:UNP", ticker: "UNP", name: "Union Pacific" },
  { tvSymbol: "NYSE:UPS", ticker: "UPS", name: "UPS" },
  { tvSymbol: "NYSE:DE", ticker: "DE", name: "Deere" },
  { tvSymbol: "NYSE:LMT", ticker: "LMT", name: "Lockheed Martin" },
  { tvSymbol: "NYSE:RTX", ticker: "RTX", name: "RTX" },

  // Telecom / Utilities / Real estate
  { tvSymbol: "NYSE:T", ticker: "T", name: "AT&T" },
  { tvSymbol: "NASDAQ:VZ", ticker: "VZ", name: "Verizon" },
  { tvSymbol: "NYSE:NEE", ticker: "NEE", name: "NextEra Energy" },
  { tvSymbol: "NYSE:DUK", ticker: "DUK", name: "Duke Energy" },
  { tvSymbol: "NYSE:SO", ticker: "SO", name: "Southern Company" },
  { tvSymbol: "NYSE:AMT", ticker: "AMT", name: "American Tower" },
  { tvSymbol: "NYSE:PLD", ticker: "PLD", name: "Prologis" },

  // Banks / Payments extras
  { tvSymbol: "NYSE:PYPL", ticker: "PYPL", name: "PayPal" },
  { tvSymbol: "NYSE:SQ", ticker: "SQ", name: "Block" },

  // AI / Semis / Internet extras
  { tvSymbol: "NASDAQ:SMCI", ticker: "SMCI", name: "Super Micro Computer" },
  { tvSymbol: "NASDAQ:CSCO", ticker: "CSCO", name: "Cisco" },
  { tvSymbol: "NASDAQ:SHOP", ticker: "SHOP", name: "Shopify" },
  { tvSymbol: "NYSE:UBER", ticker: "UBER", name: "Uber" },
  { tvSymbol: "NASDAQ:ABNB", ticker: "ABNB", name: "Airbnb" },
  { tvSymbol: "NASDAQ:NFLX", ticker: "NFLX", name: "Netflix" },
  { tvSymbol: "NYSE:PM", ticker: "PM", name: "Philip Morris" },
  { tvSymbol: "NYSE:KO", ticker: "KO", name: "Coca-Cola" },
  { tvSymbol: "NYSE:PEP", ticker: "PEP", name: "PepsiCo" },
  { tvSymbol: "NYSE:PG", ticker: "PG", name: "Procter & Gamble" },

  // ETFs (macro/market staples)
  { tvSymbol: "AMEX:SPY", ticker: "SPY", name: "SPDR S&P 500 ETF" },
  { tvSymbol: "NASDAQ:QQQ", ticker: "QQQ", name: "Invesco QQQ" },
  { tvSymbol: "AMEX:DIA", ticker: "DIA", name: "SPDR Dow Jones ETF" },
  { tvSymbol: "AMEX:IWM", ticker: "IWM", name: "iShares Russell 2000" },
  { tvSymbol: "AMEX:VTI", ticker: "VTI", name: "Vanguard Total Stock Market" },
  { tvSymbol: "AMEX:XLK", ticker: "XLK", name: "Technology Select Sector" },
  { tvSymbol: "AMEX:XLF", ticker: "XLF", name: "Financial Select Sector" },
  { tvSymbol: "AMEX:XLV", ticker: "XLV", name: "Health Care Select Sector" },
  { tvSymbol: "AMEX:XLE", ticker: "XLE", name: "Energy Select Sector" },
  { tvSymbol: "AMEX:GLD", ticker: "GLD", name: "SPDR Gold Shares" },
  { tvSymbol: "AMEX:TLT", ticker: "TLT", name: "iShares 20+ Year Treasury" },
  { tvSymbol: "AMEX:IEF", ticker: "IEF", name: "iShares 7-10 Year Treasury" },
  { tvSymbol: "AMEX:HYG", ticker: "HYG", name: "iShares High Yield Corporate Bond" },
  { tvSymbol: "AMEX:LQD", ticker: "LQD", name: "iShares Investment Grade Corporate Bond" },

  // Remaining big names to reach ~100
  { tvSymbol: "NYSE:CVS", ticker: "CVS", name: "CVS Health" },
  { tvSymbol: "NYSE:LOW", ticker: "LOW", name: "Lowe's" },
  { tvSymbol: "NYSE:BK", ticker: "BK", name: "Bank of New York Mellon" },
  { tvSymbol: "NYSE:SCHW", ticker: "SCHW", name: "Charles Schwab" },
  { tvSymbol: "NYSE:ADP", ticker: "ADP", name: "ADP" },
  { tvSymbol: "NYSE:INTU", ticker: "INTU", name: "Intuit" },
  { tvSymbol: "NYSE:TXN", ticker: "TXN", name: "Texas Instruments" },
  { tvSymbol: "NASDAQ:ISRG", ticker: "ISRG", name: "Intuitive Surgical" },
  { tvSymbol: "NYSE:MDT", ticker: "MDT", name: "Medtronic" },
  { tvSymbol: "NYSE:BAH", ticker: "BAH", name: "Booz Allen Hamilton" },
  { tvSymbol: "NYSE:SPOT", ticker: "SPOT", name: "Spotify" },
  { tvSymbol: "NYSE:FDX", ticker: "FDX", name: "FedEx" },
  { tvSymbol: "NYSE:MMM", ticker: "MMM", name: "3M" },
  { tvSymbol: "NYSE:CSX", ticker: "CSX", name: "CSX" },
  { tvSymbol: "NYSE:GM", ticker: "GM", name: "General Motors" },
  { tvSymbol: "NYSE:F", ticker: "F", name: "Ford" },
  { tvSymbol: "NYSE:DD", ticker: "DD", name: "DuPont" },
  { tvSymbol: "NYSE:LIN", ticker: "LIN", name: "Linde" },
  { tvSymbol: "NYSE:SHW", ticker: "SHW", name: "Sherwin-Williams" },
  { tvSymbol: "NYSE:AMGN", ticker: "AMGN", name: "Amgen" },
  { tvSymbol: "NYSE:GILD", ticker: "GILD", name: "Gilead Sciences" },
  { tvSymbol: "NYSE:RTX", ticker: "RTX", name: "RTX" }
].slice(0, 100);

function initSymbolAutocomplete() {
  const input = $("symbol");
  const box = $("symbolPicker");
  if (!input || !box) return;

  function normalizeKey(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function makePrefixes(terms) {
    const out = new Set();
    for (const t of terms.map((x) => normalizeKey(x)).filter(Boolean)) {
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

  async function searchTickerMaster(query) {
    if (!firebaseReady()) return [];
    const q = normalizeKey(query);
    if (!q) return [];
    try {
      // 1) 전역 ticker_master 우선
      const globalRef = fbState.db.collection("ticker_master");
      const g = await globalRef.where("prefixes", "array-contains", q).limit(20).get();
      const globalRows = g.docs.map((d) => ({ id: d.id, ...d.data() }));

      // 2) 로그인된 경우, 유저별 오버레이도 병합(선택 사항)
      let userRows = [];
      if (firebaseSignedIn()) {
        try {
          const userRef = fbState.db.collection("users").doc(fbState.user.uid).collection("ticker_master");
          const u = await userRef.where("prefixes", "array-contains", q).limit(20).get();
          userRows = u.docs.map((d) => ({ id: d.id, ...d.data(), _user: true }));
        } catch {
          userRows = [];
        }
      }

      // merge unique by symbol
      const seen = new Set();
      const merged = [];
      for (const r of [...userRows, ...globalRows]) {
        const key = String(r?.symbol || r?.id || "").toUpperCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
        if (merged.length >= 20) break;
      }
      return merged;
    } catch {
      return [];
    }
  }

  async function yahooSymbolSearch(query) {
    const qs = new URLSearchParams({ q: String(query || "").trim(), count: "12" });
    const resp = await fetch(`/api/yahoo/symbol_search?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) return [];
    return Array.isArray(data.items) ? data.items : [];
  }

  async function enrichTicker(symbol, nameEn) {
    const resp = await fetch("/api/ticker_enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, name_en: nameEn })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) return null;
    return data;
  }

  async function upsertTickerMasterFromYahooHit(hit) {
    if (!firebaseReady()) return;
    const symbol = String(hit?.symbol || "").trim().toUpperCase();
    const nameEn = String(hit?.name || "").trim();
    if (!symbol || !nameEn) return;

    const tickerDocId = (sym) => encodeURIComponent(String(sym || "").trim().toUpperCase());

    const base = {
      symbol,
      name_en: nameEn,
      name_en_lc: normalizeKey(nameEn),
      name_ko: "",
      name_ko_lc: "",
      aliases_ko: [],
      aliases_en: [],
      exch: String(hit?.exchDisp || ""),
      source: "yahoo_search",
      updatedAtClient: Date.now()
    };

    const prefixes = makePrefixes([symbol, symbol.replace(/\//g, ""), nameEn]);
    const keys = makeKeys({ symbol, name_en: nameEn, name_ko: "", aliases_en: [], aliases_ko: [] });
    // 기본은 전역 ticker_master에 저장(권한이 막히면 유저 컬렉션으로 폴백)
    const globalRef = fbState.db.collection("ticker_master").doc(tickerDocId(symbol));
    let ref = globalRef;
    try {
      await globalRef.set(
        {
          ...base,
          tvSymbol: `NASDAQ:${symbol}`,
          prefixes,
          keys
        },
        { merge: true }
      );
    } catch {
      if (!firebaseSignedIn()) return;
      ref = fbState.db.collection("users").doc(fbState.user.uid).collection("ticker_master").doc(tickerDocId(symbol));
      await ref.set({ ...base, tvSymbol: `NASDAQ:${symbol}`, prefixes, keys }, { merge: true });
    }

    const enriched = await enrichTicker(symbol, nameEn);
    if (enriched) {
      const nameKo = String(enriched.name_ko || "").trim();
      const aliasesKo = Array.isArray(enriched.aliases_ko) ? enriched.aliases_ko : [];
      const aliasesEn = Array.isArray(enriched.aliases_en) ? enriched.aliases_en : [];
      const morePrefixes = makePrefixes([symbol, nameEn, nameKo, ...aliasesKo, ...aliasesEn]);
      const keys2 = makeKeys({
        symbol,
        name_en: nameEn,
        name_ko: nameKo,
        aliases_en: aliasesEn.slice(0, 12),
        aliases_ko: aliasesKo.slice(0, 12)
      });
      await ref.set(
        {
          name_ko: nameKo,
          name_ko_lc: normalizeKey(nameKo),
          aliases_ko: aliasesKo.slice(0, 12),
          aliases_en: aliasesEn.slice(0, 12),
          prefixes: Array.from(new Set([...prefixes, ...morePrefixes])).slice(0, 140),
          keys: keys2,
          updatedAtClient: Date.now()
        },
        { merge: true }
      );
    }
  }

  async function maybeEnrichTickerMasterRow(row) {
    if (!firebaseReady()) return;
    const symbol = String(row?.symbol || row?.id || "").trim().toUpperCase();
    const nameEn = String(row?.name_en || "").trim();
    const hasKo = String(row?.name_ko || "").trim();
    if (!symbol || !nameEn) return;
    if (hasKo) return; // already enriched

    const tickerDocId = (sym) => encodeURIComponent(String(sym || "").trim().toUpperCase());

    const prefixes = makePrefixes([symbol, symbol.replace(/\//g, ""), nameEn]);
    const keys = makeKeys({ symbol, name_en: nameEn, name_ko: "", aliases_en: [], aliases_ko: [] });

    // try global first, then user overlay
    const globalRef = fbState.db.collection("ticker_master").doc(tickerDocId(symbol));
    let ref = globalRef;
    try {
      await globalRef.set(
        {
          symbol,
          name_en: nameEn,
          name_en_lc: normalizeKey(nameEn),
          prefixes,
          keys,
          updatedAtClient: Date.now()
        },
        { merge: true }
      );
    } catch {
      if (!firebaseSignedIn()) return;
      ref = fbState.db.collection("users").doc(fbState.user.uid).collection("ticker_master").doc(tickerDocId(symbol));
      await ref.set(
        {
          symbol,
          name_en: nameEn,
          name_en_lc: normalizeKey(nameEn),
          prefixes,
          keys,
          updatedAtClient: Date.now()
        },
        { merge: true }
      );
    }

    const enriched = await enrichTicker(symbol, nameEn);
    if (!enriched) return;

    const nameKo = String(enriched.name_ko || "").trim();
    const aliasesKo = Array.isArray(enriched.aliases_ko) ? enriched.aliases_ko : [];
    const aliasesEn = Array.isArray(enriched.aliases_en) ? enriched.aliases_en : [];
    const morePrefixes = makePrefixes([symbol, nameEn, nameKo, ...aliasesKo, ...aliasesEn]);
    const keys2 = makeKeys({
      symbol,
      name_en: nameEn,
      name_ko: nameKo,
      aliases_en: aliasesEn.slice(0, 12),
      aliases_ko: aliasesKo.slice(0, 12)
    });
    await ref.set(
      {
        name_ko: nameKo,
        name_ko_lc: normalizeKey(nameKo),
        aliases_ko: aliasesKo.slice(0, 12),
        aliases_en: aliasesEn.slice(0, 12),
        prefixes: Array.from(new Set([...prefixes, ...morePrefixes])).slice(0, 140),
        keys: keys2,
        updatedAtClient: Date.now()
      },
      { merge: true }
    );
  }

  let activeIndex = -1;
  let lastItems = [];
  let blurTimer = null;

  function show() {
    box.style.display = "block";
  }
  function hide() {
    box.style.display = "none";
    activeIndex = -1;
  }
  function render(items) {
    lastItems = items;
    activeIndex = items.length ? 0 : -1;
    if (!items.length) {
      box.innerHTML = `<div class="symbolPicker__empty">검색 결과가 없습니다. (티커 또는 회사명)</div>`;
      return;
    }
    box.innerHTML = items
      .slice(0, 12)
      .map((it, idx) => {
        const active = idx === activeIndex ? " is-active" : "";
        return `<div class="symbolPicker__item${active}" data-idx="${idx}"><div class="symbolPicker__ticker">${it.ticker}</div><div class="symbolPicker__name">${it.name}</div></div>`;
      })
      .join("");
  }
  function filter(q) {
    const s = String(q || "").trim().toLowerCase();
    // 한 글자만 입력해도 바로 추천
    if (!s) return MAJOR_SYMBOLS_100.slice(0, 12);
    const out = MAJOR_SYMBOLS_100.filter((it) => {
      return String(it.ticker).toLowerCase().includes(s) || String(it.name).toLowerCase().includes(s) || String(it.tvSymbol).toLowerCase().includes(s);
    });
    return out;
  }

  async function filterAsync(q) {
    const s = String(q || "").trim();
    const base = filter(s);
    if (!s) return base.slice(0, 12);

    const dbRows = await searchTickerMaster(s);
    const dbItems = dbRows.map((r) => ({
      _db: r,
      tvSymbol: r?.tvSymbol || (r?.exchange ? `${String(r.exchange).toUpperCase()}:${r.symbol}` : `NASDAQ:${r.symbol}`),
      ticker: r.symbol,
      name: r.name_ko ? `${r.name_ko}${r.name_en ? " / " + r.name_en : ""}` : r.name_en || r.symbol
    }));

    const yahooHits = dbItems.length ? [] : await yahooSymbolSearch(s);
    const yahooItems = yahooHits.map((h) => ({
      _yahoo: h,
      tvSymbol: `NASDAQ:${String(h.symbol || "").trim()}`,
      ticker: String(h.symbol || "").trim(),
      name: String(h.name || "").trim()
    }));

    const seen = new Set();
    const merged = [];
    for (const it of [...dbItems, ...base, ...yahooItems]) {
      const key = String(it?.ticker || "").toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
      if (merged.length >= 12) break;
    }
    return merged;
  }
  function select(it) {
    if (!it) return;
    input.value = it.tvSymbol;
    hide();
    // 자동완성 선택 시 심볼 변경 적용
    if (typeof window.applySymbolChange === "function") {
      window.applySymbolChange();
    }
    if (it._yahoo) upsertTickerMasterFromYahooHit(it._yahoo).catch(() => {});
    if (it._db) maybeEnrichTickerMasterRow(it._db).catch(() => {});
  }
  function syncActive() {
    const nodes = box.querySelectorAll(".symbolPicker__item");
    nodes.forEach((n) => n.classList.remove("is-active"));
    const active = box.querySelector(`.symbolPicker__item[data-idx="${activeIndex}"]`);
    if (active) active.classList.add("is-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  let renderSeq = 0;
  let debounceTimer = null;

  function scheduleRender(v) {
    const mySeq = ++renderSeq;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterAsync(v).then((items) => {
        if (mySeq !== renderSeq) return;
        render(items);
      });
    }, 160);
  }

  input.addEventListener("focus", () => {
    if (blurTimer) clearTimeout(blurTimer);
    show();
    scheduleRender(input.value);
  });
  input.addEventListener("blur", () => {
    blurTimer = setTimeout(() => hide(), 160);
  });
  input.addEventListener("input", () => {
    show();
    scheduleRender(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (box.style.display === "none") return;
    const max = Math.min(12, lastItems.length) - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (max < 0) return;
      activeIndex = Math.min(max, activeIndex + 1);
      syncActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (max < 0) return;
      activeIndex = Math.max(0, activeIndex - 1);
      syncActive();
    } else if (e.key === "Enter") {
      if (lastItems.length && activeIndex >= 0) {
        e.preventDefault();
        select(lastItems[activeIndex]);
      }
    } else if (e.key === "Escape") {
      hide();
    }
  });

  box.addEventListener("mousedown", (e) => {
    // blur 전에 선택되게 mousedown
    const item = e.target?.closest?.(".symbolPicker__item");
    if (!item) return;
    const idx = Number(item.getAttribute("data-idx"));
    if (!Number.isFinite(idx)) return;
    select(lastItems[idx]);
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function addMessage(role, content, variant, opts = {}) {
  const { skipPersist, skipCloud } = opts || {};
  const messages = $("messages");
  const msgId = makeMsgId();
  const item = el("div", { className: `msg msg--${variant || role}` }, [
    el("div", { className: "msg__role", text: role === "user" ? "사용자" : role === "assistant" ? "해설" : "시스템" }),
    el("div", { className: "msg__content", text: content })
  ]);
  item.dataset.msgId = msgId;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;

  if (!skipPersist && shouldPersistRole(role)) {
    upsertChatItem(msgId, { role, variant: variant || role, content: String(content || ""), ts: Date.now() });
  }

  if (!skipCloud && shouldPersistRole(role)) {
    upsertCloudMessage(msgId, {
      role,
      variant: variant || role,
      content: clampCloudText(String(content || "")),
      clientTs: Date.now(),
      ctx: {
        symbol: String($("symbol")?.value || ""),
        interval: String($("interval")?.value || ""),
        view: String(window.leftView || "")
      }
    }).catch(() => {});
  }

  return item;
}

let orderModeOn = false;
let pendingOrder = null; // { symbol, side, type, qty, limitPrice }
let pendingOrderMeta = null; // optional: { kis?: { CANO, ACNT_PRDT_CD } }

function normalizeToYahooSymbolForOrder(tvSymbol) {
  // TradingView 심볼(NASDAQ:AAPL) -> AAPL (Yahoo 심볼로 변환)
  return tvSymbolToYahooSymbol(tvSymbol || "");
}

function isSafeYahooSymbol(sym) {
  return /^[A-Za-z0-9.\-^=_/]{1,32}$/.test(String(sym || "").trim());
}

async function resolveTickerFromMaster(inputText) {
  // resolve: 티커/영문/한글/별칭 -> Yahoo symbol (e.g., AAPL)
  const raw = String(inputText || "").trim();
  if (!raw) return "";

  // TradingView form
  if (/^[A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32}$/.test(raw)) return normalizeToYahooSymbolForOrder(raw);

  // already ticker-like
  if (isSafeYahooSymbol(raw) && /[A-Za-z0-9]/.test(raw) && !/[가-힣\s]/.test(raw) && raw.length <= 12) return raw.toUpperCase();

  const normalizeKey = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

  const q = normalizeKey(raw);
  if (!q) return "";

  // 1) Firestore exact match via keys[]
  if (firebaseReady()) {
    try {
      const snap = await fbState.db.collection("ticker_master").where("keys", "array-contains", q).limit(3).get();
      const doc = snap.docs?.[0] || null;
      const d = doc ? doc.data() : null;
      const sym = String(d?.symbol || "").trim().toUpperCase();
      if (sym) return sym;
    } catch {
      // ignore
    }

    // 2) fallback: prefix search and simple scoring
    try {
      const s2 = await fbState.db.collection("ticker_master").where("prefixes", "array-contains", q.slice(0, Math.min(10, q.length))).limit(8).get();
      const rows = s2.docs.map((d) => d.data());
      const scored = rows
        .map((r) => {
          const sym = String(r?.symbol || "").trim().toUpperCase();
          const nameEn = String(r?.name_en_lc || "");
          const nameKo = String(r?.name_ko_lc || "");
          const keys = Array.isArray(r?.keys) ? r.keys : [];
          let score = 0;
          if (keys.includes(q)) score += 100;
          if (nameKo === q) score += 70;
          if (nameEn === q) score += 60;
          if (String(r?.symbol || "").toUpperCase() === raw.toUpperCase()) score += 80;
          if (sym && q && normalizeKey(sym).startsWith(q)) score += 30;
          return { sym, score };
        })
        .sort((a, b) => b.score - a.score);
      if (scored[0]?.sym) return scored[0].sym;
    } catch {
      // ignore
    }
  }

  // 3) Yahoo fallback (best-effort)
  try {
    const qs = new URLSearchParams({ q: raw, count: "1" });
    const resp = await fetch(`/api/yahoo/symbol_search?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    const sym = String(data?.items?.[0]?.symbol || "").trim().toUpperCase();
    if (sym) return sym;
  } catch {
    // ignore
  }

  // 4) 마지막 fallback: 기존 major map
  return resolveMajorTickerFromToken(raw);
}

const __orderTickerCache = new Map(); // key: normalized input -> resolved symbol or ""

async function resolveTickerForOrderValidated(inputText) {
  // 주문에서는 "ticker_master에 존재"하거나 "Yahoo 검색으로 존재가 확인"되는 경우만 허용
  const raw = String(inputText || "").trim();
  if (!raw) return "";

  const normalizeKeyLocal = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

  const cacheKey = normalizeKeyLocal(raw);
  if (cacheKey && __orderTickerCache.has(cacheKey)) return __orderTickerCache.get(cacheKey) || "";

  // TradingView form -> ticker candidate
  let candidate = raw;
  if (/^[A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32}$/.test(raw)) candidate = normalizeToYahooSymbolForOrder(raw);
  candidate = String(candidate || "").trim();

  // 1) DB 우선: ticker_master에서 symbol== 또는 keys[]로 확인
  if (firebaseReady()) {
    // 1-a) 티커 형태면 symbol == 로 먼저 확인 (keys가 아직 없는 문서도 통과)
    if (isSafeYahooSymbol(candidate) && /[A-Za-z0-9]/.test(candidate) && !/[가-힣\\s]/.test(candidate) && candidate.length <= 16) {
      const sym = candidate.toUpperCase();
      try {
        const snap = await fbState.db.collection("ticker_master").where("symbol", "==", sym).limit(1).get();
        const doc = snap.docs?.[0] || null;
        const d = doc ? doc.data() : null;
        const out = String(d?.symbol || "").trim().toUpperCase();
        if (out) {
          __orderTickerCache.set(cacheKey, out);
          return out;
        }
      } catch {
        // ignore
      }
    }

    // 1-b) keys[] exact match (한글명/영문명/별칭)
    const q = normalizeKeyLocal(raw);
    if (q) {
      try {
        const snap = await fbState.db.collection("ticker_master").where("keys", "array-contains", q).limit(1).get();
        const doc = snap.docs?.[0] || null;
        const d = doc ? doc.data() : null;
        const out = String(d?.symbol || "").trim().toUpperCase();
        if (out) {
          __orderTickerCache.set(cacheKey, out);
          return out;
        }
      } catch {
        // ignore
      }
    }
  }

  // 2) Yahoo 검증 폴백: 검색 결과가 0이면 "없는 종목"으로 간주하고 주문 차단
  try {
    const qs = new URLSearchParams({ q: raw, count: "6" });
    const resp = await fetch(`/api/yahoo/symbol_search?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    const items = Array.isArray(data?.items) ? data.items : [];
    const safeItems = items
      .map((x) => ({
        symbol: String(x?.symbol || "").trim().toUpperCase(),
        name: String(x?.name || "").trim(),
        quoteType: String(x?.quoteType || "").trim()
      }))
      .filter((x) => x.symbol)
      // 주문은 "실제 주식/ETF"만 허용(숫자-only 심볼/기타 타입 제외)
      .filter((x) => /[A-Z]/.test(x.symbol))
      .filter((x) => !/^[0-9]+$/.test(x.symbol))
      .filter((x) => !x.quoteType || /EQUITY|ETF/i.test(x.quoteType));

    if (safeItems.length) {
      // 티커를 직접 입력한 경우에는 가능한 한 정확히 같은 심볼을 우선 선택
      const candUpper = String(candidate || "").trim().toUpperCase();
      const exact = candUpper ? safeItems.find((x) => x.symbol === candUpper) : null;
      const picked = exact || safeItems[0];
      const out = String(picked?.symbol || "").trim().toUpperCase();
      if (out && /[A-Z]/.test(out) && !/^[0-9]+$/.test(out)) {
        __orderTickerCache.set(cacheKey, out);
        return out;
      }
    }
  } catch {
    // ignore
  }

  __orderTickerCache.set(cacheKey, "");
  return "";
}

function resolveMajorTickerFromToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return "";
  const u = raw.toUpperCase();

  // 0) 한글 별칭(자주 쓰는 것만 우선)
  const ko = raw.replace(/\s+/g, "");
  const koMap = {
    "애플": "AAPL",
    "마이크로소프트": "MSFT",
    "마소": "MSFT",
    "엔비디아": "NVDA",
    "엔비": "NVDA",
    "구글": "GOOGL",
    "알파벳": "GOOGL",
    "아마존": "AMZN",
    "메타": "META",
    "페북": "META",
    "테슬라": "TSLA",
    "브로드컴": "AVGO",
    "브로드": "AVGO",
    "오라클": "ORCL",
    "넷플릭스": "NFLX",
    "넷플": "NFLX",
    "코스트코": "COST",
    "월마트": "WMT",
    "JP모건": "JPM",
    "제이피모건": "JPM",
    "버크셔": "BRK.B",
    "버크셔해서웨이": "BRK.B"
  };
  if (koMap[ko]) return koMap[ko];

  // 1) 정확히 티커 매칭
  const exact = MAJOR_SYMBOLS_100.find((it) => String(it.ticker || "").toUpperCase() === u);
  if (exact) return exact.ticker;

  // 2) 회사명 매칭(예: APPLE -> Apple)
  const lower = raw.toLowerCase();
  const byName = MAJOR_SYMBOLS_100.find((it) => String(it.name || "").toLowerCase() === lower);
  if (byName) return byName.ticker;

  // 3) 포함 매칭(짧은 입력에서 잘못 매칭될 수 있어 길이 3 이상만)
  if (lower.length >= 3) {
    const contains = MAJOR_SYMBOLS_100.find((it) => String(it.name || "").toLowerCase().includes(lower));
    if (contains) return contains.ticker;
  }

  return raw;
}

function detectOrderSide(text) {
  const t = String(text || "");
  const buyRe = /(매수|buy|롱|산다|살게|살래|사줘|사줄|사고|구매)/i;
  const sellRe = /(매도|sell|숏|판다|팔게|팔래|팔아|파는|처분)/i;
  const buy = buyRe.test(t);
  const sell = sellRe.test(t);
  if (buy && !sell) return "BUY";
  if (sell && !buy) return "SELL";
  if (buy && sell) {
    // 둘 다 나오면 마지막으로 등장한 쪽을 우선(대충)
    const b = t.search(buyRe);
    const s = t.search(sellRe);
    return s > b ? "SELL" : "BUY";
  }
  return null;
}

function extractOrderSymbolCandidates(text, fallbackYahooSymbol) {
  const t = String(text || "");
  const out = [];

  // TradingView form first
  const tvMatch = t.match(/([A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32})/);
  if (tvMatch) out.push(tvMatch[1]);

  // Ticker-like tokens (exclude pure numbers / interval tokens)
  const bad = new Set(["D", "W", "M", "1D", "1W", "1M", "USD", "KRW", "BUY", "SELL", "MARKET", "LIMIT"]);
  const tokRe = /\b([A-Z0-9.\-^=_]{1,12})\b/g;
  for (const m of t.matchAll(tokRe)) {
    const cand = String(m[1] || "").trim();
    if (!cand) continue;
    if (bad.has(cand.toUpperCase())) continue;
    if (!/[A-Za-z]/.test(cand)) continue; // 숫자-only 차단
    out.push(cand);
  }

  // Korean/English word tokens (skip common stopwords)
  const stop = new Set([
    "오늘",
    "지금",
    "방금",
    "주식",
    "종목",
    "티커",
    "매수",
    "매도",
    "주문",
    "사줘",
    "사자",
    "살게",
    "산다",
    "사고",
    "팔아",
    "팔게",
    "판다",
    "처분",
    "개",
    "주",
    "달러",
    "원"
  ]);
  const wordRe = /([A-Za-z가-힣]{2,})/g;
  for (const m of t.matchAll(wordRe)) {
    const w = String(m[1] || "").trim();
    if (!w) continue;
    if (stop.has(w)) continue;
    if (/^(buy|sell|market|limit)$/i.test(w)) continue;
    out.push(w);
  }

  if (fallbackYahooSymbol) out.push(String(fallbackYahooSymbol).trim());

  // unique preserve order
  const seen = new Set();
  const uniq = [];
  for (const x of out) {
    const k = String(x || "").trim();
    if (!k) continue;
    const kk = k.toUpperCase();
    if (seen.has(kk)) continue;
    seen.add(kk);
    uniq.push(k);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

function looksLikeNaturalOrder(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const hasSide = !!detectOrderSide(t);
  const qtyMatch = t.match(/(\d+)\s*(주|shares?)/i);
  const hasQty = !!qtyMatch;
  // 한글/영문 종목명 또는 티커가 있을 법한 토큰
  const hasToken =
    /[A-Za-z]{2,}/.test(t) || /[가-힣]{2,}/.test(t) || /[A-Z]{1,5}\b/.test(t) || /[A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32}/.test(t);
  return hasSide && hasQty && hasToken;
}

function extractJsonObjectFromText(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
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

function parseKisOrderTemplateText(text, fallbackYahooSymbol) {
  // 1) JSON 템플릿을 넣는 경우
  const obj = extractJsonObjectFromText(text);
  if (obj && typeof obj === "object") {
    const symbol = String(obj.PDNO || obj.symbol || obj.ticker || fallbackYahooSymbol || "").trim();
    const sideRaw = String(obj.SIDE || obj.side || "").toUpperCase().trim();
    const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;

    const qtyRaw = obj.ORD_QTY ?? obj.qty ?? obj.QTY ?? null;
    const qty = qtyRaw === null || qtyRaw === undefined ? null : Number(qtyRaw);

    const typeRaw = String(obj.ORDER_TYPE || obj.type || "").toUpperCase().trim();
    let type = typeRaw === "LIMIT" ? "LIMIT" : typeRaw === "MARKET" ? "MARKET" : "";
    const unprRaw = obj.OVRS_ORD_UNPR ?? obj.limitPrice ?? obj.LIMIT_PRICE ?? null;
    const unpr = unprRaw === null || unprRaw === undefined ? null : Number(unprRaw);

    if (!type) type = Number.isFinite(unpr) && unpr > 0 ? "LIMIT" : "MARKET";

    const missing = [];
    if (!symbol) missing.push("PDNO(티커)");
    if (!side) missing.push("SIDE(BUY/SELL)");
    if (!(Number.isFinite(qty) && qty > 0)) missing.push("ORD_QTY(수량)");
    if (type === "LIMIT" && !(Number.isFinite(unpr) && unpr > 0)) missing.push("OVRS_ORD_UNPR(지정가)");
    if (missing.length) return { ok: false, reason: "missing", missing };

    return { ok: true, order: { symbol, side, type, qty: Math.floor(qty), limitPrice: type === "LIMIT" ? unpr : null } };
  }

  // 2) 사용자가 "주식 주문하기" 템플릿(불릿) 형태로 채워서 보내는 경우
  const t = String(text || "");
  const canoM = t.match(/CANO\s*:\s*([0-9]{4,})/i);
  const acntM = t.match(/ACNT_PRDT_CD\s*:\s*([0-9]{1,4})/i);
  const sideM = t.match(/SIDE\s*:\s*(BUY|SELL)/i);
  const qtyM = t.match(/ORD_QTY\s*:\s*(\d+)/i);
  const unprM = t.match(/OVRS_ORD_UNPR\s*:\s*(\d+(?:[.,]\d+)?)/i);

  const CANO = canoM ? String(canoM[1]).trim() : "";
  const ACNT_PRDT_CD = acntM ? String(acntM[1]).trim() : "";
  const side = sideM ? String(sideM[1]).toUpperCase() : null;
  const qty = qtyM ? Number(qtyM[1]) : null;
  const unpr = unprM ? Number(String(unprM[1]).replace(/,/g, "")) : null;
  const type = Number.isFinite(unpr) && unpr > 0 ? "LIMIT" : "MARKET";

  const symbol = String(fallbackYahooSymbol || "").trim();

  const missing = [];
  if (!symbol) missing.push("PDNO(티커)");
  if (!side) missing.push("SIDE(BUY/SELL)");
  if (!(Number.isFinite(qty) && qty > 0)) missing.push("ORD_QTY(수량)");
  if (type === "LIMIT" && !(Number.isFinite(unpr) && unpr > 0)) missing.push("OVRS_ORD_UNPR(지정가)");
  if (missing.length) return { ok: false, reason: "missing", missing };

  return {
    ok: true,
    order: { symbol, side, type, qty: Math.floor(qty), limitPrice: type === "LIMIT" ? unpr : null },
    kis: { CANO, ACNT_PRDT_CD }
  };
}

function parseOrderText(text, fallbackYahooSymbol) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "empty" };

  let side = detectOrderSide(t);

  const qtyMatch = t.match(/(\d+)\s*(주|shares?)/i);
  const qty = qtyMatch ? Number(qtyMatch[1]) : null;

  let type = /(지정가|limit)/i.test(t) ? "LIMIT" : "MARKET";
  let limitPrice = null;
  if (type === "LIMIT") {
    const p = t.match(/(\d+([.,]\d+)?)(\s*(달러|원|usd|krw))?/i);
    if (p) limitPrice = Number(String(p[1]).replace(/,/g, ""));
  }

  // 심볼 추출: NASDAQ:AAPL 또는 AAPL / TSLA / 005930.KS 등
  let symbol = null;
  const tvMatch = t.match(/([A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32})/);
  if (tvMatch) symbol = normalizeToYahooSymbolForOrder(tvMatch[1]);
  if (!symbol) {
    // ticker-like token (but still exclude numeric-only)
    const symMatch = t.match(/\b([A-Z0-9.\-^=_]{1,12})\b/);
    if (symMatch) {
      const candidate = symMatch[1];
      if (/[A-Za-z]/.test(candidate)) {
      // BUY/SELL 같은 단어는 제외
      if (!/^(buy|sell|market|limit)$/i.test(candidate)) symbol = resolveMajorTickerFromToken(candidate);
      }
    }
  }
  // 회사명(영문/한글)로 들어오는 경우를 보강
  if (!symbol) {
    const words = Array.from(t.matchAll(/([A-Za-z가-힣]{2,})/g)).map((m) => String(m[1] || "").trim()).filter(Boolean);
    for (const w of words) {
      if (/^(buy|sell|market|limit)$/i.test(w)) continue;
      // common stopwords
      if (["오늘", "지금", "주식", "종목", "티커", "매수", "매도", "주문"].includes(w)) continue;
      symbol = resolveMajorTickerFromToken(w);
      if (symbol) break;
    }
  }
  if (!symbol) symbol = fallbackYahooSymbol;

  const missing = [];
  if (!side) missing.push("매수/매도");
  if (!qty || !Number.isFinite(qty) || qty <= 0) missing.push("수량(몇 주)");
  if (!symbol) missing.push("심볼");
  if (type === "LIMIT" && !(Number.isFinite(limitPrice) && limitPrice > 0)) missing.push("지정가 가격");

  if (missing.length) return { ok: false, reason: "missing", missing };
  return { ok: true, order: { symbol, side, type, qty: Math.floor(qty), limitPrice: type === "LIMIT" ? limitPrice : null } };
}

function setOrderMode(on) {
  orderModeOn = !!on;
  const bar = $("orderBar");
  const btn = $("orderMode");
  const execTop = $("orderExecute");
  if (bar) bar.style.display = orderModeOn ? "flex" : "none";
  if (btn) btn.classList.toggle("is-active", orderModeOn);
  if (execTop) execTop.style.display = orderModeOn ? "inline-flex" : "none";

  if (!orderModeOn) {
    pendingOrder = null;
    const exec = $("orderExecute");
    if (exec) exec.disabled = true;
  }
}

function setPendingOrder(order) {
  pendingOrder = order || null;
  const exec = $("orderExecute");
  if (exec) exec.disabled = !pendingOrder;
}

function formatOrderSummary(order, meta) {
  if (!order) return "";
  const lines = [];
  lines.push(`심볼: ${order.symbol}`);
  lines.push(`방향: ${order.side === "BUY" ? "매수" : "매도"}`);
  lines.push(`타입: ${order.type}`);
  lines.push(`수량: ${order.qty}주`);
  if (order.type === "LIMIT") lines.push(`지정가: ${order.limitPrice}`);
  const kis = meta?.kis || null;
  if (kis?.CANO) lines.push(`CANO: ${kis.CANO}`);
  if (kis?.ACNT_PRDT_CD) lines.push(`ACNT_PRDT_CD: ${kis.ACNT_PRDT_CD}`);
  return lines.join("\n");
}

function showOrderConfirmModal() {
  if (!pendingOrder) return;
  const modal = $("orderConfirmModal");
  const pre = $("orderConfirmText");
  const yes = $("orderConfirmYes");
  if (!modal || !pre || !yes) return;
  pre.textContent = formatOrderSummary(pendingOrder, pendingOrderMeta);
  modal.style.display = "block";
  // focus confirm for fast keyboard flow
  setTimeout(() => yes.focus(), 0);
}

function hideOrderConfirmModal() {
  const modal = $("orderConfirmModal");
  if (!modal) return;
  modal.style.display = "none";
}

async function executePaperOrder() {
  if (!pendingOrder) return;
  const o = pendingOrder;
  hideOrderConfirmModal();
  setPendingOrder(null);
  pendingOrderMeta = null;

  addMessage("system", `가상 주문 전송 중… (${o.symbol} ${o.qty}주 ${o.side === "BUY" ? "매수" : "매도"})`);
  try {
    const resp = await fetch("/api/order_simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) {
      addMessage("system", `가상 주문 실패: ${data?.error || resp.statusText}\n${data?.details || ""}`.trim(), "error");
      return;
    }
    const order = data.order || {};
    const market = data.market || null;
    const fillLine =
      order?.status === "FILLED" && typeof order?.filledPrice === "number"
        ? `- 체결가(참고, Yahoo): ${order.filledPrice}${order.filledCurrency ? " " + order.filledCurrency : ""}`
        : market && typeof market.price === "number"
          ? `- 참고 시세(Yahoo): ${market.price}${market.currency ? " " + market.currency : ""}`
          : "";
    addMessage(
      "assistant",
      [
        "가상 주문 결과",
        `- ID: ${order.id}`,
        `- 심볼: ${order.symbol}`,
        `- 방향: ${order.side === "BUY" ? "매수" : "매도"}`,
        `- 타입: ${order.type}`,
        `- 수량: ${order.qty}주`,
        `- 상태: ${order.status}`,
        fillLine,
        "",
        data.disclaimer || ""
      ].join("\n")
    );

    // 주문 체결(FILLED) 시 포트폴리오에 반영
    try {
      await applyFilledPaperOrderToPortfolio(order);
    } catch {
      // ignore
    }
  } catch (e) {
    addMessage("system", `가상 주문 오류: ${String(e?.message || e)}`, "error");
  }
}

function isNewsQuery(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  // 웹 검색/출처가 필요한 질문 → Perplexity 리서치로 라우팅
  return (
    t.includes("뉴스") ||
    t.includes("기사") ||
    t.includes("이슈") ||
    t.includes("속보") ||
    t.includes("헤드라인") ||
    t.includes("일정") ||
    t.includes("캘린더") ||
    t.includes("캘린더에서") ||
    t.includes("경제 캘린더") ||
    t.includes("경제캘린더") ||
    t.includes("경제지표") ||
    t.includes("발표 일정") ||
    t.includes("발표일") ||
    t.includes("실적") ||
    t.includes("실적발표") ||
    t.includes("실적 발표") ||
    t.includes("news") ||
    t.includes("headline") ||
    t.includes("breaking") ||
    t.includes("calendar") ||
    t.includes("economic calendar") ||
    t.includes("earnings") ||
    t.includes("earnings date") ||
    t.includes("schedule") ||
    t.includes("루머") ||
    t.includes("rumor") ||
    t.includes("왜 올랐") ||
    t.includes("왜 내렸") ||
    t.includes("무슨 일") ||
    t.includes("무슨일") ||
    t.includes("what happened") ||
    t.includes("catalyst") ||
    t.includes("촉매")
  );
}

async function runPerplexityResearch({ symbol, query, setAssistant }) {
  setAssistant("뉴스/이슈를 검색 중… (Perplexity)\n");

  const resp = await fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, query, userNotes: "" })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) {
    setAssistant(`오류: ${data?.error || resp.statusText}\n${data?.details || ""}`.trim());
    return;
  }

  let out = String(data.answer || "");
  const cits = Array.isArray(data.citations) ? data.citations : [];
  if (cits.length) out += "\n\n## 출처\n" + cits.slice(0, 10).map((u) => `- ${u}`).join("\n");
  setAssistant(out || "(빈 응답)");
  return { answer: String(data.answer || ""), citations: cits.slice(0, 10) };
}

function clearMessages() {
  $("messages").innerHTML = "";
  chatStore = [];
  try {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function buildWidgetConfig({ symbol, interval }) {
  return {
    allow_symbol_change: true,
    calendar: false,
    details: false,
    hide_side_toolbar: true,
    hide_top_toolbar: false,
    hide_legend: false,
    hide_volume: false,
    hotlist: false,
    interval,
    locale: "en",
    save_image: true,
    style: "1",
    symbol,
    theme: "dark",
    timezone: "Etc/UTC",
    backgroundColor: "#0F0F0F",
    gridColor: "rgba(242, 242, 242, 0.06)",
    watchlist: [],
    withdateranges: false,
    compareSymbols: [],
    studies: [],
    autosize: true
  };
}

function buildScreenerConfig() {
  return {
    market: "america",
    showToolbar: true,
    defaultColumn: "overview",
    defaultScreen: "most_capitalized",
    isTransparent: false,
    locale: "kr",
    colorTheme: "dark",
    width: "100%",
    height: 550
  };
}

function buildCalendarConfig() {
  return {
    colorTheme: "dark",
    isTransparent: false,
    locale: "kr",
    countryFilter: "us",
    importanceFilter: "-1,0,1",
    width: 400,
    height: 550
  };
}

function tvSymbolToYahooSymbol(tvSymbol) {
  const s = String(tvSymbol || "").trim();
  if (!s) return "AAPL";
  // 예: NASDAQ:AAPL -> AAPL
  const parts = s.split(":");
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
}

function tvIntervalToYahooInterval(tvInterval) {
  const v = String(tvInterval || "D").trim();
  if (v === "D") return "1d";
  if (v === "W") return "1wk";
  if (v === "M") return "1mo";
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n <= 1) return "1m";
    if (n <= 5) return "5m";
    if (n <= 15) return "15m";
    if (n <= 30) return "30m";
    if (n <= 60) return "60m";
    return "1h";
  }
  return "1d";
}

function getYahooRangeCandidates(yahooInterval) {
  const v = String(yahooInterval || "1d");
  // intraday는 야후 제약이 많아서 너무 긴 range부터 때리면 계속 실패할 수 있음
  if (v.endsWith("m") || v === "1h" || v === "60m") {
    // 가능한 한 길게 -> 짧게
    return ["1mo", "5d", "1d"];
  }
  if (v === "1d" || v === "5d") return ["max", "10y", "5y", "2y", "1y", "6mo", "3mo", "1mo", "5d", "1d"];
  if (v === "1wk") return ["max", "10y", "5y", "2y", "1y", "6mo", "3mo", "1mo"];
  if (v === "1mo" || v === "3mo") return ["max", "10y", "5y", "2y", "1y"];
  return ["6mo", "3mo", "1mo", "5d", "1d"];
}

function setYahooStatus(text) {
  const el = $("yahooStatus");
  if (el) el.textContent = text;
}

async function fetchYahooOhlcvOnce({ yahooSymbol, yahooInterval, range }) {
  const qs = new URLSearchParams({ symbol: yahooSymbol, interval: yahooInterval, range });
  const resp = await fetch(`/api/yahoo/ohlcv?${qs.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) {
    const err = new Error(data?.error || resp.statusText || "Yahoo error");
    err.details = data?.details || "";
    err.status = data?.status || resp.status;
    throw err;
  }
  return data;
}

let lastYahooErrorKey = "";
let latestOhlcvText = "";
let latestScreenerText = "";
let latestConsensusText = "";
let lastConsensusAt = 0;
let screenerTimer = null;
let lastScreenerAt = 0;

async function loadYahooConsensus() {
  const tvSymbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const yahooSymbol = tvSymbolToYahooSymbol(tvSymbol);
  try {
    const resp = await fetch(`/api/yahoo/consensus?symbol=${encodeURIComponent(yahooSymbol)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) {
      // UI를 시끄럽게 하지 않기 위해 시스템 메시지는 생략(필요하면 나중에 토글)
      return false;
    }
    latestConsensusText = JSON.stringify(data, null, 2);
    lastConsensusAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function loadYahooScreener() {
  setYahooStatus("자동(30초) · 스크리너 불러오는 중…");
  try {
    const resp = await fetch("/api/yahoo/screener?scrId=largest_market_cap&count=25");
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) {
      addMessage("system", `스크리너 불러오기 오류: ${data?.error || resp.statusText}\n${data?.details || ""}`.trim(), "error");
      setYahooStatus("자동(30초) · 스크리너 실패");
      return false;
    }
    latestScreenerText = JSON.stringify(data.rows || [], null, 2);
    lastScreenerAt = Date.now();
    setYahooStatus(`자동(30초) · 스크리너: ${data.title || data.scrId}${data.cached ? " · cached" : ""}`);
    return true;
  } catch (e) {
    addMessage("system", `스크리너 불러오기 실패: ${String(e?.message || e)}`, "error");
    setYahooStatus("자동(30초) · 스크리너 오류");
    return false;
  }
}

async function loadYahooOhlcv() {
  const tvSymbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const tvInterval = $("interval").value || "D";
  const yahooSymbol = tvSymbolToYahooSymbol(tvSymbol);
  const yahooInterval = tvIntervalToYahooInterval(tvInterval);
  const ranges = getYahooRangeCandidates(yahooInterval);

  setYahooStatus(`자동(30초) · 시도 중… (${yahooInterval})`);

  try {
    let data = null;
    let usedRange = "";
    let lastErr = null;

    for (const r of ranges) {
      try {
        data = await fetchYahooOhlcvOnce({ yahooSymbol, yahooInterval, range: r });
        usedRange = r;
        break;
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    if (!data) {
      const key = `${yahooSymbol}|${yahooInterval}|${String(lastErr?.status || "")}|${String(lastErr?.message || "")}`;
      // 같은 오류를 30초마다 스팸하지 않도록 변경될 때만 메시지
      if (key !== lastYahooErrorKey) {
        lastYahooErrorKey = key;
        addMessage("system", `야후 불러오기 실패: ${lastErr?.message || "Unknown"}\n${lastErr?.details || ""}`.trim(), "error");
      }
      setYahooStatus(`자동(30초) · 실패 (${yahooInterval})`);
      return;
    }

    lastYahooErrorKey = "";
    const out = JSON.stringify(data.candles || [], null, 2);
    latestOhlcvText = out;
    setYahooStatus(`자동(30초) · ${data.symbol} ${data.interval} · range=${usedRange}${data.cached ? " · cached" : ""}`);
  } catch (e) {
    setYahooStatus(`자동(30초) · 오류 (${yahooInterval})`);
    const key = `${yahooSymbol}|${yahooInterval}|${String(e?.status || "")}|${String(e?.message || "")}`;
    if (key !== lastYahooErrorKey) {
      lastYahooErrorKey = key;
      addMessage("system", `야후 불러오기 오류: ${String(e?.message || e)}\n${e?.details || ""}`.trim(), "error");
    }
  }
}

let yahooTimer = null;
let tvRemountTimer = null;
let leftView = "chart"; // "chart" | "company" | "macro" | "screener" | "aiAnalysis"
let calendarCollapsed = false;
let macroTimer = null;
let lastMacroAt = 0;
let insightTimer = null;
let lastInsightAt = 0;
let latestMacroIndices = null;
let latestMacroNews = null;

const MACRO_SYMBOLS = [
  // 지수
  { symbol: "^GSPC", label: "S&P 500", group: "지수" },
  { symbol: "^DJI", label: "Dow Jones Industrial Average", group: "지수" },
  { symbol: "^IXIC", label: "NASDAQ Composite", group: "지수" },
  { symbol: "^RUT", label: "Russell 2000", group: "지수" },
  { symbol: "^FTSE", label: "FTSE 100", group: "지수" },
  { symbol: "^N225", label: "Nikkei 225", group: "지수" },
  { symbol: "^TX60", label: "S&P/TSX 60", group: "지수" },
  { symbol: "^VIX", label: "VIX", group: "지수" },
  // 통화
  { symbol: "DX-Y.NYB", label: "달러인덱스", group: "통화" },
  { symbol: "EURUSD=X", label: "EURUSD", group: "통화" },
  { symbol: "JPY=X", label: "USDJPY", group: "통화" }, // 야후 표기 관례(USDJPY=X의 단축 심볼로도 종종 존재)
  { symbol: "USDKRW=X", label: "USDKRW", group: "통화" },
  // 원자재
  { symbol: "GC=F", label: "Gold", group: "원자재" },
  { symbol: "SI=F", label: "Silver", group: "원자재" },
  { symbol: "CL=F", label: "Crude Oil", group: "원자재" },
  { symbol: "NG=F", label: "Nat Gas", group: "원자재" },
  // 선물(지수)
  { symbol: "ES=F", label: "S&P Fut", group: "선물" },
  { symbol: "NQ=F", label: "Nasdaq Fut", group: "선물" },
  { symbol: "YM=F", label: "Dow Fut", group: "선물" },
  // 채권(수익률 인덱스)
  { symbol: "^IRX", label: "US 13W", group: "채권" },
  { symbol: "^FVX", label: "US 5Y", group: "채권" },
  { symbol: "^TNX", label: "US 10Y", group: "채권" },
  { symbol: "^TYX", label: "US 30Y", group: "채권" }
];

function formatNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  try {
    return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return String(x);
  }
}

function formatPct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  const v = (x * 100);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function formatEpoch(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  try {
    return new Date(s * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function setYahooLast(text) {
  const el = $("yahooLast");
  if (el) el.textContent = text;
}

function scheduleTvRemount(delayMs = 250) {
  if (tvRemountTimer) clearTimeout(tvRemountTimer);
  tvRemountTimer = setTimeout(() => {
    if (leftView === "screener") mountTradingViewScreener();
    else if (leftView === "company") mountTradingViewCompany();
    else mountTradingViewChart();
  }, delayMs);
}

function clearYahooTimer() {
  if (yahooTimer) {
    clearInterval(yahooTimer);
    yahooTimer = null;
  }
}

function startYahooAutoPoll(seconds) {
  clearYahooTimer();
  if (!seconds || seconds <= 0) return;
  // 즉시 1회 로드
  loadYahooOhlcv().finally(() => setYahooLast(new Date().toLocaleString()));
  yahooTimer = setInterval(async () => {
    await loadYahooOhlcv();
    setYahooLast(new Date().toLocaleString());
  }, seconds * 1000);
}

function setLeftView(view, reason) {
  const v = view === "company" ? "company" : view === "macro" ? "macro" : view === "screener" ? "screener" : view === "aiAnalysis" ? "aiAnalysis" : view === "stockHome" ? "stockHome" : "chart";
  if (leftView === v) return;
  leftView = v;

  const btnChart = $("viewChart");
  const btnCompany = $("viewCompany");
  const btnMacro = $("viewMacro");
  const btnScreener = $("viewScreener");
  const btnAiAnalysis = $("viewAiAnalysis");
  const btnStockHome = $("viewStockHome");
  
  if (btnChart && btnScreener && btnCompany && btnMacro && btnAiAnalysis && btnStockHome) {
    const isChart = v === "chart";
    const isCompany = v === "company";
    const isMacro = v === "macro";
    const isScreener = v === "screener";
    const isAiAnalysis = v === "aiAnalysis";
    const isStockHome = v === "stockHome";
    
    btnChart.classList.toggle("is-active", isChart);
    btnCompany.classList.toggle("is-active", isCompany);
    btnMacro.classList.toggle("is-active", isMacro);
    btnScreener.classList.toggle("is-active", isScreener);
    btnAiAnalysis.classList.toggle("is-active", isAiAnalysis);
    btnStockHome.classList.toggle("is-active", isStockHome);
    
    btnChart.setAttribute("aria-selected", String(isChart));
    btnCompany.setAttribute("aria-selected", String(isCompany));
    btnMacro.setAttribute("aria-selected", String(isMacro));
    btnScreener.setAttribute("aria-selected", String(isScreener));
    btnAiAnalysis.setAttribute("aria-selected", String(isAiAnalysis));
    btnStockHome.setAttribute("aria-selected", String(isStockHome));
  } else {
    console.warn("탭 버튼을 찾을 수 없습니다:", { btnChart, btnCompany, btnMacro, btnScreener, btnAiAnalysis, btnStockHome });
  }

  if (v === "chart") mountTradingViewChart();
  else if (v === "company") mountTradingViewCompany();
  else if (v === "macro") mountMacro();
  else if (v === "aiAnalysis") mountAiAnalysis();
  else if (v === "stockHome") mountStockHome();
  else mountTradingViewScreener();
  updateCalendarToggleUI();
  updateLeftControlsUI();

  // macro 화면일 때는 60초마다 갱신
  if (v === "macro") {
    if (macroTimer) clearInterval(macroTimer);
    loadMacro().finally(() => setYahooLast(new Date().toLocaleString()));
    macroTimer = setInterval(async () => {
      await loadMacro();
      setYahooLast(new Date().toLocaleString());
    }, 60_000);

    // Market Insight는 5분마다 갱신
    if (insightTimer) clearInterval(insightTimer);
    loadMarketInsight().finally(() => setYahooLast(new Date().toLocaleString()));
    insightTimer = setInterval(async () => {
      await loadMarketInsight();
      setYahooLast(new Date().toLocaleString());
    }, 300_000);
  } else {
    if (macroTimer) {
      clearInterval(macroTimer);
      macroTimer = null;
    }
    if (insightTimer) {
      clearInterval(insightTimer);
      insightTimer = null;
    }
  }

  // 스크리너 화면일 때는 스크리너 데이터도 30초마다 갱신
  if (v === "screener") {
    if (screenerTimer) clearInterval(screenerTimer);
    loadYahooScreener().finally(() => setYahooLast(new Date().toLocaleString()));
    screenerTimer = setInterval(async () => {
      await loadYahooScreener();
      setYahooLast(new Date().toLocaleString());
    }, 30_000);
  } else {
    if (screenerTimer) {
      clearInterval(screenerTimer);
      screenerTimer = null;
    }
  }

  if (reason) {
    const label = v === "chart" ? "차트" : v === "company" ? "기업분석" : v === "macro" ? "매크로" : v === "aiAnalysis" ? "AI 종합 분석" : v === "stockHome" ? "종목홈" : "스크리너";
    addMessage("system", `왼쪽 화면을 '${label}'로 전환했습니다. (${reason})`);
  }
}

function mountTradingViewChart() {
  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const interval = $("interval").value || "D";
  const root = $("leftWidgetRoot");
  if (!root) return;

  root.innerHTML = `
    <div class="tradingview-widget-container" style="height: 100%; width: 100%">
      <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
      <div class="tradingview-widget-copyright">
        <a href="https://www.tradingview.com/" rel="noopener nofollow" target="_blank">
          <span class="blue-text">${symbol} chart</span>
        </a>
        <span class="trademark"> by TradingView</span>
      </div>
    </div>
  `;

  const container = root.querySelector(".tradingview-widget-container");
  if (!container) return;

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.async = true;
  script.dataset.tvEmbed = "chart";
  script.textContent = JSON.stringify(buildWidgetConfig({ symbol, interval }), null, 2);
  container.appendChild(script);
}

function mountTradingViewScreener() {
  const root = $("leftWidgetRoot");
  if (!root) return;

  const toggleBtn = $("toggleCalendar");
  if (toggleBtn) toggleBtn.style.display = "inline-flex";

  if (calendarCollapsed) {
    root.innerHTML = `
      <div class="screenerSplit screenerSplit--collapsed">
        <div class="screenerSplit__left">
          <div class="tradingview-widget-container" style="height: 100%; width: 100%">
            <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
            <div class="tradingview-widget-copyright">
              <a href="https://kr.tradingview.com/screener/" rel="noopener nofollow" target="_blank">
                <span class="blue-text">Track all markets on TradingView</span>
              </a>
              <span class="trademark"> by TradingView</span>
            </div>
          </div>
        </div>
      </div>
    `;

    const container = root.querySelector(".tradingview-widget-container");
    if (!container) return;
    const screenerScript = document.createElement("script");
    screenerScript.type = "text/javascript";
    screenerScript.src = "https://s3.tradingview.com/external-embedding/embed-widget-screener.js";
    screenerScript.async = true;
    screenerScript.dataset.tvEmbed = "screener";
    screenerScript.textContent = JSON.stringify(buildScreenerConfig(), null, 2);
    container.appendChild(screenerScript);
    return;
  }

  root.innerHTML = `
    <div class="screenerSplit">
      <div class="screenerSplit__left">
        <div class="tradingview-widget-container" style="height: 100%; width: 100%">
          <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://kr.tradingview.com/screener/" rel="noopener nofollow" target="_blank">
              <span class="blue-text">Track all markets on TradingView</span>
            </a>
            <span class="trademark"> by TradingView</span>
          </div>
        </div>
      </div>
      <div class="screenerSplit__right">
        <div class="tradingview-widget-container" style="height: 100%; width: 100%">
          <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://kr.tradingview.com/economic-calendar/" rel="noopener nofollow" target="_blank">
              <span class="blue-text">Economic Calendar</span>
            </a>
            <span class="trademark"> by TradingView</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const containers = root.querySelectorAll(".tradingview-widget-container");
  if (!containers || containers.length < 2) return;

  // 1) Screener
  const screenerScript = document.createElement("script");
  screenerScript.type = "text/javascript";
  screenerScript.src = "https://s3.tradingview.com/external-embedding/embed-widget-screener.js";
  screenerScript.async = true;
  screenerScript.dataset.tvEmbed = "screener";
  screenerScript.textContent = JSON.stringify(buildScreenerConfig(), null, 2);
  containers[0].appendChild(screenerScript);

  // 2) Economic calendar
  const calScript = document.createElement("script");
  calScript.type = "text/javascript";
  calScript.src = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
  calScript.async = true;
  calScript.dataset.tvEmbed = "calendar";
  calScript.textContent = JSON.stringify(buildCalendarConfig(), null, 2);
  containers[1].appendChild(calScript);
}

function buildFinancialsConfig(symbol) {
  return {
    symbol,
    colorTheme: "dark",
    displayMode: "regular",
    isTransparent: false,
    locale: "kr",
    width: 400,
    height: 550
  };
}

function buildProfileConfig(symbol) {
  return {
    symbol,
    colorTheme: "dark",
    isTransparent: false,
    locale: "kr",
    width: 400,
    height: 550
  };
}

function buildTimelineConfig(symbol) {
  return {
    displayMode: "regular",
    feedMode: "symbol",
    symbol,
    colorTheme: "dark",
    isTransparent: false,
    locale: "kr",
    width: 400,
    height: 550
  };
}

function mountTradingViewCompany() {
  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const root = $("leftWidgetRoot");
  if (!root) return;

  const toggleBtn = $("toggleCalendar");
  if (toggleBtn) toggleBtn.style.display = "none";

  root.innerHTML = `
    <div class="companyStrip">
      <div class="companyPanel">
        <div class="tradingview-widget-container" style="height: 100%; width: 100%">
          <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://kr.tradingview.com/symbols/${encodeURIComponent(symbol.replace(":", "-"))}/financials-overview/" rel="noopener nofollow" target="_blank">
              <span class="blue-text">Financials</span>
            </a>
          </div>
        </div>
      </div>
      <div class="companyPanel">
        <div class="tradingview-widget-container" style="height: 100%; width: 100%">
          <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://kr.tradingview.com/symbols/${encodeURIComponent(symbol.replace(":", "-"))}/" rel="noopener nofollow" target="_blank">
              <span class="blue-text">Profile</span>
            </a>
          </div>
        </div>
      </div>
      <div class="companyPanel">
        <div class="tradingview-widget-container" style="height: 100%; width: 100%">
          <div class="tradingview-widget-container__widget" style="height: calc(100% - 32px); width: 100%"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://kr.tradingview.com/news/top-providers/tradingview/" rel="noopener nofollow" target="_blank">
              <span class="blue-text">News</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  `;

  const containers = root.querySelectorAll(".tradingview-widget-container");
  if (!containers || containers.length < 3) return;

  const s1 = document.createElement("script");
  s1.type = "text/javascript";
  s1.src = "https://s3.tradingview.com/external-embedding/embed-widget-financials.js";
  s1.async = true;
  s1.dataset.tvEmbed = "financials";
  s1.textContent = JSON.stringify(buildFinancialsConfig(symbol), null, 2);
  containers[0].appendChild(s1);

  const s2 = document.createElement("script");
  s2.type = "text/javascript";
  s2.src = "https://s3.tradingview.com/external-embedding/embed-widget-symbol-profile.js";
  s2.async = true;
  s2.dataset.tvEmbed = "profile";
  s2.textContent = JSON.stringify(buildProfileConfig(symbol), null, 2);
  containers[1].appendChild(s2);

  const s3 = document.createElement("script");
  s3.type = "text/javascript";
  s3.src = "https://s3.tradingview.com/external-embedding/embed-widget-timeline.js";
  s3.async = true;
  s3.dataset.tvEmbed = "timeline";
  s3.textContent = JSON.stringify(buildTimelineConfig(symbol), null, 2);
  containers[2].appendChild(s3);
}

function updateCalendarToggleUI() {
  const btn = $("toggleCalendar");
  if (!btn) return;
  if (leftView !== "screener") {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "inline-flex";
  btn.textContent = calendarCollapsed ? "캘린더 펼치기" : "캘린더 접기";
}

function updateLeftControlsUI() {
  const box = $("leftControls");
  if (!box) return;
  // 심볼/간격/새로고침은 모든 탭에서 표시
  box.style.display = "flex";
}

async function fetchYahooIndices() {
  const symbols = MACRO_SYMBOLS.map((x) => x.symbol).join(",");
  const qs = new URLSearchParams({ symbols });
  const resp = await fetch(`/api/yahoo/indices?${qs.toString()}`);
  const data = await resp.json().catch(() => ({}));
  
  // 일부 심볼이 실패해도 성공한 것들은 사용
  if (data?.ok && Array.isArray(data.rows)) {
    if (data.errors && data.errors.length > 0) {
      console.warn("[매크로] 일부 지수 데이터를 불러오지 못했습니다:", data.errors.map(e => `${e.symbol} (${e.error})`).join(", "));
    }
    return data;
  }
  
  // 전체 실패인 경우에만 에러
  if (!resp.ok || !data?.ok) {
    const err = new Error(data?.error || resp.statusText || "Yahoo error");
    err.details = data?.details || "";
    throw err;
  }
  
  return data;
}

async function fetchYahooMacroNews() {
  // "today major news"에 맞게, Yahoo에서 news가 잘 붙는 쿼리 사용
  const qs = new URLSearchParams({ q: "nasdaq", count: "12" });
  const resp = await fetch(`/api/yahoo/news?${qs.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) {
    const err = new Error(data?.error || resp.statusText || "Yahoo error");
    err.details = data?.details || "";
    throw err;
  }
  return data;
}

async function loadMacro() {
  // 너무 자주 스팸 방지(뷰 전환 직후 연속 호출 대비)
  if (lastMacroAt && Date.now() - lastMacroAt < 1500) return;
  lastMacroAt = Date.now();

  const root = $("leftWidgetRoot");
  if (!root) return;
  const idxTopEl = root.querySelector("[data-macro='indicesTop']");
  const idxEl = root.querySelector("[data-macro='indices']");
  const newsEl = root.querySelector("[data-macro='news']");
  const badgeEl = root.querySelector("[data-macro='badge']");

  try {
    if (badgeEl) badgeEl.textContent = "불러오는 중…";
    let indices, news;
    try {
      [indices, news] = await Promise.all([fetchYahooIndices(), fetchYahooMacroNews()]);
    } catch (e) {
      console.error("[매크로] 데이터 불러오기 실패:", e);
      // 일부 실패해도 계속 진행
      indices = indices || { rows: [], errors: [] };
      news = news || { items: [] };
    }
    latestMacroIndices = Array.isArray(indices?.rows) ? indices.rows : [];
    latestMacroNews = Array.isArray(news?.items) ? news.items : [];
    
    // 일부 심볼 실패 경고
    if (indices?.errors && indices.errors.length > 0) {
      console.warn("[매크로] 일부 지수 데이터를 불러오지 못했습니다:", indices.errors.map(e => `${e.symbol} (${e.error})`).join(", "));
    }

      const rows = Array.isArray(indices?.rows) ? indices.rows : [];
      const bySymbol = new Map(rows.map((r) => [String(r?.symbol || ""), r]));

    // 지수를 맨 위에 크게 표시
    if (idxTopEl) {
      const indexItems = MACRO_SYMBOLS.filter((s) => s.group === "지수")
        .map((s) => ({ ...s, row: bySymbol.get(s.symbol) || null }))
        .filter((x) => x.row);
      
      if (indexItems.length > 0) {
        const indexLines = indexItems
          .map(({ label, row }) => {
            const price = formatNum(row.regularMarketPrice);
            const changeValue = Number(row.regularMarketChange);
            const change = changeValue > 0 ? `+${formatNum(changeValue)}` : formatNum(changeValue);
            const pct = formatPct(row.regularMarketChangePercent);
            const signClass = changeValue > 0 ? "pos" : changeValue < 0 ? "neg" : "";
            return `
              <div style="margin-bottom: 12px;">
                <div style="font-size: 14px; font-weight: 600; margin-bottom: 4px; color: var(--text);">${label}</div>
                <div style="font-size: 20px; font-weight: 700; margin-bottom: 2px; color: var(--text);">${price}</div>
                <div class="${signClass}" style="font-size: 14px; font-weight: 600;">${change} (${pct})</div>
              </div>
            `;
          })
          .join("");
        idxTopEl.innerHTML = `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px;">${indexLines}</div>`;
      } else {
        idxTopEl.textContent = "지수 데이터를 불러오는 중…";
      }
    }

    // 나머지 지표는 시장 지표 패널에 표시 (지수 제외)
    if (idxEl) {
      const groups = ["통화", "원자재", "선물", "채권"];

      const html = groups
        .map((g) => {
          const items = MACRO_SYMBOLS.filter((s) => s.group === g)
            .map((s) => ({ ...s, row: bySymbol.get(s.symbol) || null }))
            .filter((x) => x.row);
          if (!items.length) return "";
          
          return (
            `<div class="macroNewsMeta" style="margin: 2px 0 8px; font-weight: 700;">${g}</div>` +
            `<table class="macroTable">` +
            `<thead><tr><th>항목</th><th>값</th><th>변화</th></tr></thead>` +
            `<tbody>` +
            items
              .map(({ label, row }) => {
                const price = formatNum(row.regularMarketPrice);
                const change = formatNum(row.regularMarketChange);
                const pct = formatPct(row.regularMarketChangePercent);
                const signClass = Number(row.regularMarketChange) > 0 ? "pos" : Number(row.regularMarketChange) < 0 ? "neg" : "";
                return `<tr><td>${label}</td><td>${price}</td><td class="${signClass}">${change} (${pct})</td></tr>`;
              })
              .join("") +
            `</tbody></table>` +
            `<div style="height: 10px"></div>`
          );
        })
        .filter(Boolean)
        .join("");

      idxEl.innerHTML = html || "데이터 없음";
    }

    if (newsEl) {
      const items = Array.isArray(news?.items) ? news.items : [];
      if (!items.length) {
        newsEl.textContent = "오늘자 뉴스가 없습니다.";
      } else {
        newsEl.innerHTML = items
          .slice(0, 12)
          .map((n) => {
            const title = String(n.title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const link = String(n.link || "");
            const pub = String(n.publisher || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const t = n.providerPublishTime ? formatEpoch(n.providerPublishTime) : "";
            const meta = [pub, t].filter(Boolean).join(" · ");
            return `<div class="macroNewsItem"><a href="${link}" target="_blank" rel="noopener noreferrer">${title || "(제목 없음)"}</a><div class="macroNewsMeta">${meta}</div></div>`;
          })
          .join("");
      }
    }

    if (badgeEl) badgeEl.textContent = `Yahoo · ${indices?.cached ? "cached" : "live"}`;
  } catch (e) {
    if (badgeEl) badgeEl.textContent = "오류";
    addMessage("system", `매크로 불러오기 실패: ${String(e?.message || e)}\n${e?.details || ""}`.trim(), "error");
  }
}

async function fetchMarketInsight({ indices, news, force }) {
  const resp = await fetch("/api/market_insight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locale: "ko",
      force: !!force,
      indices: Array.isArray(indices) ? indices : [],
      news: Array.isArray(news) ? news : []
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.ok) {
    const err = new Error(data?.error || resp.statusText || "Insight error");
    err.details = data?.details || "";
    throw err;
  }
  return data;
}

async function loadRecentMarketInsight() {
  if (!firebaseSignedIn() || !firebaseReady() || !cloudSaveEnabled()) return null;
  try {
    const u = userDocRef();
    if (!u) return null;
    // 5분 이내 최신 Market Insight 확인
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const snap = await u.collection("insights")
      .where("type", "==", "market_insight")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : (data.createdAt ? new Date(data.createdAt) : new Date(data.asOf || Date.now()));
    if (createdAt < fiveMinutesAgo) return null;
    console.log("[Market Insight] DB에서 5분 이내 데이터 발견:", {
      createdAt: createdAt.toISOString(),
      age: Math.round((Date.now() - createdAt.getTime()) / 1000),
      seconds: "초"
    });
    return {
      insight: data.insight || "",
      asOf: data.asOf || createdAt.toISOString(),
      cached: true,
      mode: data.mode || "openai"
    };
  } catch (e) {
    console.error("[Market Insight] DB 조회 실패:", e);
    return null;
  }
}

async function loadMarketInsight({ force } = {}) {
  if (!force && lastInsightAt && Date.now() - lastInsightAt < 1500) return;
  lastInsightAt = Date.now();

  const root = $("leftWidgetRoot");
  if (!root) return;
  const el = root.querySelector("[data-macro='insight']");
  const metaEl = root.querySelector("[data-macro='insightMeta']");
  if (!el) return;

  try {
    // 5분 이내 최근 결과 확인 (force가 아닐 때만)
    if (!force) {
      const recent = await loadRecentMarketInsight();
      if (recent) {
        console.log("[Market Insight] DB 캐시 사용, 서버 호출 건너뜀");
        const mode = recent.mode || "openai";
        const modeText = mode === "openai" ? "GPT" : mode === "fallback" ? "Fallback" : mode === "mock" ? "Mock" : "Unknown";
        el.textContent = String(recent.insight || "").trim() || "(빈 응답)";
        if (metaEl) metaEl.textContent = `${modeText} · DB cached · ${new Date(recent.asOf || Date.now()).toLocaleString()}`;
        return;
      }
    }

    el.textContent = "Market Insight 생성 중…";
    if (metaEl) metaEl.textContent = "GPT · 생성 중…";

    // Insight는 최신 macro 데이터 기반으로(없으면 로딩 유도)
    if (!latestMacroIndices || !latestMacroNews) {
      await loadMacro();
    }

    const out = await fetchMarketInsight({ indices: latestMacroIndices || [], news: latestMacroNews || [], force: !!force });
    
    // mode에 따라 메타 정보 표시
    const mode = out.mode || "unknown";
    const modeText = mode === "openai" ? "GPT" : mode === "fallback" ? "Fallback" : mode === "mock" ? "Mock" : "Unknown";
    const statusText = out.cached ? "cached" : "updated";
    
    el.textContent = String(out.insight || "").trim() || "(빈 응답)";
    if (metaEl) {
      if (mode === "fallback" && out.error) {
        metaEl.textContent = `${modeText} · ${statusText} · ${new Date(out.asOf || Date.now()).toLocaleString()} (오류: ${out.errorStatus || "알 수 없음"})`;
        console.warn("[Market Insight] Fallback 모드:", out.error, out.details);
      } else {
        metaEl.textContent = `${modeText} · ${statusText} · ${new Date(out.asOf || Date.now()).toLocaleString()}`;
      }
    }

    // cloud save: Market Insight가 새로 생성/갱신될 때마다 저장 (cached가 아닐 때만)
    if (!out.cached && firebaseSignedIn() && firebaseReady() && cloudSaveEnabled()) {
      try {
        const u = userDocRef();
        if (u) {
          const slimIndices = (Array.isArray(latestMacroIndices) ? latestMacroIndices : []).slice(0, 30).map((r) => ({
            symbol: r?.symbol || "",
            shortName: r?.shortName || "",
            currency: r?.currency || "",
            regularMarketPrice: r?.regularMarketPrice ?? null,
            regularMarketChangePercent: r?.regularMarketChangePercent ?? null,
            regularMarketTime: r?.regularMarketTime ?? null
          }));
          const slimNews = (Array.isArray(latestMacroNews) ? latestMacroNews : []).slice(0, 20).map((n) => ({
            title: n?.title || "",
            link: n?.link || "",
            publisher: n?.publisher || "",
            providerPublishTime: n?.providerPublishTime || null
          }));
          await u.collection("insights").add({
            type: "market_insight",
            asOf: out.asOf || new Date().toISOString(),
            mode: out.mode || "openai",
            cached: false,
            force: !!force,
            insight: clampCloudText(String(out.insight || ""), 40_000),
            indices: slimIndices,
            news: slimNews,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          console.log("[Market Insight] DB에 새 데이터 저장 완료");
        }
      } catch (e) {
        console.error("[Market Insight] DB 저장 실패:", e);
      }
    } else if (out.cached) {
      console.log("[Market Insight] 캐시된 데이터이므로 DB 저장 건너뜀");
    }
  } catch (e) {
    el.textContent = `Market Insight 오류: ${String(e?.message || e)}\n${e?.details || ""}`.trim();
    if (metaEl) metaEl.textContent = "오류";
  }
}

function mountMacro() {
  const root = $("leftWidgetRoot");
  if (!root) return;

  const toggleBtn = $("toggleCalendar");
  if (toggleBtn) toggleBtn.style.display = "none";

  root.innerHTML = `
    <div class="macroGrid">
      <div class="macroPanel macroPanel--span" style="grid-column: 1 / -1;">
        <div class="macroPanel__head">
          <div class="macroPanel__title">주요 지수</div>
        </div>
        <div class="macroPanel__body" data-macro="indicesTop" style="font-size: 16px; padding: 16px; line-height: 1.8;">불러오는 중…</div>
      </div>
      <div class="macroPanel macroPanel--span">
        <div class="macroPanel__head">
          <div class="macroPanel__title">Market Insight</div>
          <div style="display:flex; gap:10px; align-items:center;">
            <div class="macroPill" data-macro="insightMeta">대기</div>
            <button class="btn btn--ghost btn--compact" type="button" id="insightRefresh">새로고침</button>
          </div>
        </div>
        <div class="macroPanel__body macroInsight" data-macro="insight">대기 중…</div>
      </div>
      <div class="macroPanel">
        <div class="macroPanel__head">
          <div class="macroPanel__title">시장 지표</div>
          <div class="macroPill" data-macro="badge">대기</div>
        </div>
        <div class="macroPanel__body" data-macro="indices">불러오는 중…</div>
      </div>
      <div class="macroPanel">
        <div class="macroPanel__head">
          <div class="macroPanel__title">오늘 주요 뉴스(Yahoo)</div>
          <button class="btn btn--ghost btn--compact" type="button" id="macroRefresh">새로고침</button>
        </div>
        <div class="macroPanel__body" data-macro="news">불러오는 중…</div>
      </div>
    </div>
  `;

  $("macroRefresh")?.addEventListener("click", () => loadMacro());
  $("insightRefresh")?.addEventListener("click", () => loadMarketInsight({ force: true }));
  loadMacro();
  loadMarketInsight();
}

// 종목홈 더미 데이터
function getStockHomeDummyData(ticker = "AAPL") {
  return {
    companyName: ticker === "AAPL" ? "Apple Inc." : ticker === "TSLA" ? "Tesla, Inc." : "Company Name",
    ticker: ticker,
    price: 175.43,
    changeRate: 2.34,
    aiStatus: "positive",
    aiSummary: "최근 실적 발표에서 예상을 상회하는 성장세를 보였으며, 시장 기대치를 충족하고 있습니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "수익성이 안정적으로 유지되고 있으며, 영업이익률이 업계 평균을 상회합니다.",
      stability: "재무 건전성이 양호하며, 부채 비율이 적정 수준을 유지하고 있습니다.",
      growth: "매출 성장률이 지속적으로 개선되고 있으며, 신규 사업 영역에서도 성과를 보이고 있습니다."
    },
    recentIssues: [
      { title: "2024년 4분기 실적 발표", sentiment: "positive" },
      { title: "신제품 출시 발표", sentiment: "neutral" },
      { title: "주주환원 정책 확대", sentiment: "positive" }
    ],
    updatedAt: new Date().toLocaleString("ko-KR")
  };
}

// 종목홈 컴포넌트: 헤더
function renderStockHomeHeader(data) {
  return `
    <div class="stockHome__header">
      <div class="stockHome__headerTop">
        <div class="stockHome__companyName">${escapeHtml(data.companyName)}</div>
        <div class="stockHome__ticker">${escapeHtml(data.ticker)}</div>
      </div>
    </div>
  `;
}

// 종목홈 컴포넌트: AI 상태 카드
function renderStockHomeAiStatus(data) {
  const statusConfig = {
    positive: { label: "긍정", class: "stockHome__status--positive", icon: "✓" },
    neutral: { label: "중립", class: "stockHome__status--neutral", icon: "○" },
    caution: { label: "주의", class: "stockHome__status--caution", icon: "⚠" }
  };
  const config = statusConfig[data.aiStatus] || statusConfig.neutral;
  
  return `
    <div class="stockHome__card stockHome__card--aiStatus">
      <div class="stockHome__cardHead">
        <div class="stockHome__cardTitle">AI 종합 상태</div>
        <div class="stockHome__status ${config.class}">
          <span class="stockHome__statusIcon">${config.icon}</span>
          <span class="stockHome__statusLabel">${config.label}</span>
        </div>
      </div>
      <div class="stockHome__cardBody">
        <div class="stockHome__summary">${escapeHtml(data.aiSummary)}</div>
        <div class="stockHome__updated">업데이트: ${escapeHtml(data.updatedAt)}</div>
      </div>
    </div>
  `;
}

// 종목홈 컴포넌트: 차트 스냅샷 (헤더 바로 아래 배치)
function renderStockHomeChart(data) {
  // 티커를 Yahoo 심볼 형식으로 변환
  const ticker = data.ticker || "AAPL";
  const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
  
  return `
    <div class="stockHome__chartContainer" id="stockHomeChartContainer">
      <tv-mini-chart symbol="${escapeHtml(yahooSymbol)}"></tv-mini-chart>
    </div>
  `;
}

// 종목홈 컴포넌트: 기업 상태 요약
function renderStockHomeFundamentals(data) {
  return `
    <div class="stockHome__card stockHome__card--fundamentals">
      <div class="stockHome__cardHead">
        <div class="stockHome__cardTitle">기업 상태 요약</div>
      </div>
      <div class="stockHome__cardBody">
        <div class="stockHome__fundamentalsGrid">
          <div class="stockHome__fundamentalItem">
            <div class="stockHome__fundamentalLabel">수익성</div>
            <div class="stockHome__fundamentalText">${escapeHtml(data.fundamentalsSummary.profitability)}</div>
          </div>
          <div class="stockHome__fundamentalItem">
            <div class="stockHome__fundamentalLabel">안정성</div>
            <div class="stockHome__fundamentalText">${escapeHtml(data.fundamentalsSummary.stability)}</div>
          </div>
          <div class="stockHome__fundamentalItem">
            <div class="stockHome__fundamentalLabel">성장성</div>
            <div class="stockHome__fundamentalText">${escapeHtml(data.fundamentalsSummary.growth)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// 종목홈 컴포넌트: 뉴스/공시 상태
function renderStockHomeIssues(data) {
  const news = Array.isArray(data.news) ? data.news : [];
  const filings = Array.isArray(data.filings) ? data.filings : [];
  
  // 뉴스 항목 생성
  const newsHtml = news.slice(0, 5).map(item => {
    const title = item.title || item.headline || "";
    const link = item.link || item.url || "";
    let dateStr = "";
    if (item.publishTime) {
      // Unix timestamp (초 단위)
      dateStr = new Date(item.publishTime * 1000).toLocaleDateString("ko-KR");
    } else if (item.providerPublishTime) {
      // Unix timestamp (초 단위)
      dateStr = new Date(item.providerPublishTime * 1000).toLocaleDateString("ko-KR");
    }
    return `
      <div class="stockHome__issueItem">
        <div class="stockHome__issueType">뉴스</div>
        <div style="flex: 1;">
          <div class="stockHome__issueTitle">
            ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>` : escapeHtml(title)}
          </div>
          ${dateStr ? `<div class="stockHome__issueDate">${dateStr}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");
  
  // 공시 항목 생성
  const filingsHtml = filings.slice(0, 5).map(item => {
    const form = item.form || "";
    const filingDate = item.filingDate || "";
    const description = item.description || "";
    let dateStr = "";
    if (filingDate) {
      // YYYY-MM-DD 형식
      dateStr = new Date(filingDate).toLocaleDateString("ko-KR");
    }
    const title = description || `${form} 공시`;
    return `
      <div class="stockHome__issueItem">
        <div class="stockHome__issueType stockHome__issueType--filing">공시</div>
        <div style="flex: 1;">
          <div class="stockHome__issueTitle">${escapeHtml(title)}</div>
          ${dateStr ? `<div class="stockHome__issueDate">${dateStr}</div>` : ""}
        </div>
      </div>
    `;
  }).join("");
  
  const allIssuesHtml = newsHtml + filingsHtml;
  
  if (!allIssuesHtml) {
    return `
      <div class="stockHome__card stockHome__card--issues">
        <div class="stockHome__cardHead">
          <div class="stockHome__cardTitle">최근 이슈</div>
        </div>
        <div class="stockHome__cardBody">
          <div class="stockHome__issuesList">
            <div style="padding: 20px; text-align: center; color: var(--muted);">최근 뉴스나 공시가 없습니다.</div>
          </div>
        </div>
      </div>
    `;
  }
  
  return `
    <div class="stockHome__card stockHome__card--issues">
      <div class="stockHome__cardHead">
        <div class="stockHome__cardTitle">최근 이슈</div>
      </div>
      <div class="stockHome__cardBody">
        <div class="stockHome__issuesList">
          ${allIssuesHtml}
        </div>
      </div>
    </div>
  `;
}

// 종목홈 메인 함수
async function mountStockHome() {
  const root = $("leftWidgetRoot");
  if (!root) return;

  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const ticker = symbol.includes(":") ? symbol.split(":")[1] : symbol;
  
  // 로딩 표시
  root.innerHTML = `
    <div class="stockHome">
      <div style="padding: 20px; text-align: center;">시세를 불러오는 중...</div>
    </div>
  `;

  try {
    // 실제 API에서 시세 가져오기
    const qs = new URLSearchParams({ symbols: ticker });
    const resp = await fetch(`/api/yahoo/quotes?${qs.toString()}`);
    const data = await resp.json().catch(() => ({}));
    
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.error || resp.statusText || "quotes error");
    }
    
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    const quote = quotes[0] || {};
    
    // 더미 데이터를 기반으로 시세 데이터 병합
    const stockData = getStockHomeDummyData(ticker);
    
    // 실제 시세 데이터로 업데이트
    if (quote.regularMarketPrice != null) {
      stockData.price = quote.regularMarketPrice;
    }
    if (quote.regularMarketChangePercent != null) {
      stockData.changeRate = quote.regularMarketChangePercent;
    }
    if (quote.shortName) {
      stockData.companyName = quote.shortName;
    }
    stockData.ticker = ticker;
    stockData.updatedAt = new Date().toLocaleString("ko-KR");

    // 뉴스와 공시 데이터 가져오기
    let news = [];
    let filings = [];
    
    try {
      // 뉴스 가져오기
      const newsResp = await fetch(`/api/yahoo/news?q=${encodeURIComponent(ticker)}&count=5`);
      if (newsResp.ok) {
        const newsData = await newsResp.json().catch(() => ({}));
        if (newsData?.ok && Array.isArray(newsData.news)) {
          news = newsData.news;
        }
      }
    } catch (e) {
      console.warn("[종목홈] 뉴스 로딩 실패:", e);
    }
    
    try {
      // 공시 가져오기
      const filingsResp = await fetch(`/api/sec/filings?symbol=${encodeURIComponent(ticker)}`);
      if (filingsResp.ok) {
        const filingsData = await filingsResp.json().catch(() => ({}));
        if (filingsData?.ok && filingsData.filings && Array.isArray(filingsData.filings)) {
          filings = filingsData.filings;
        }
      }
    } catch (e) {
      console.warn("[종목홈] 공시 로딩 실패:", e);
    }
    
    stockData.news = news;
    stockData.filings = filings;

    root.innerHTML = `
      <div class="stockHome">
        ${renderStockHomeHeader(stockData)}
        ${renderStockHomeChart(stockData)}
        ${renderStockHomeAiStatus(stockData)}
        ${renderStockHomeFundamentals(stockData)}
        ${renderStockHomeIssues(stockData)}
      </div>
    `;
  } catch (e) {
    console.error("[종목홈] 시세 로딩 실패:", e);
    // 에러 시 더미 데이터로 표시
    const stockData = getStockHomeDummyData(ticker);
    root.innerHTML = `
      <div class="stockHome">
        ${renderStockHomeHeader(stockData)}
        ${renderStockHomeChart(stockData)}
        ${renderStockHomeAiStatus(stockData)}
        ${renderStockHomeFundamentals(stockData)}
        ${renderStockHomeIssues(stockData)}
      </div>
    `;
  }
}

let aiAnalysisAbortController = null;

async function loadRecentAiAnalysis(symbol) {
  if (!firebaseSignedIn() || !firebaseReady() || !cloudSaveEnabled()) return null;
  try {
    const u = userDocRef();
    if (!u) return null;
    // 5분 이내 최신 AI 종합분석 확인
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const symbolRaw = symbol.replace(/NASDAQ:|NYSE:|AMEX:/i, "").trim();
    const snap = await u.collection("judge_runs")
      .where("symbol", "==", symbolRaw)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
    if (createdAt < fiveMinutesAgo) return null;
    return {
      run_id: data.run_id || doc.id,
      final: data.final || "",
      signals: data.signals || null,
      story: data.story || "",
      marketCheck: data.marketCheck || null,
      peerAdjust: data.peerAdjust || null,
      rag_meta: data.rag_meta || null,
      verifier: data.verifier || null,
      createdAt: createdAt.toISOString()
    };
  } catch {
    return null;
  }
}

async function loadRecentPortfolioAnalysis() {
  if (!firebaseSignedIn() || !firebaseReady() || !cloudSaveEnabled()) return null;
  try {
    const u = userDocRef();
    if (!u) return null;
    // 최근 1일 내 포트폴리오 분석 확인
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const snap = await u.collection("portfolio_analyses")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const data = doc.data();
    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
    if (createdAt < oneDayAgo) return null;
    return {
      id: doc.id,
      answer: data.answer || "",
      positions: data.positions || [],
      memo: data.memo || "",
      createdAt: createdAt.toISOString()
    };
  } catch (e) {
    console.error("[Portfolio Analysis] DB 조회 실패:", e);
    return null;
  }
}

async function loadAndDisplayRecentPortfolioAnalysis() {
  const recent = await loadRecentPortfolioAnalysis();
  if (!recent) return;

  const cardsEl = $("aiAnalysisCards");
  if (!cardsEl) return;

  // 포트폴리오 분석 카드 추가
  const portfolioCard = document.createElement("div");
  portfolioCard.className = "aiAnalysisCard";
  portfolioCard.setAttribute("data-card", "portfolio");
  portfolioCard.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="font-size: 16px; font-weight: 700;">포트폴리오 분석</div>
      <div class="aiAnalysisStatus status-done">완료</div>
    </div>
    <div style="font-size: 12px; color: #999; margin-bottom: 8px;">
      ${new Date(recent.createdAt).toLocaleString()} · 최근 1일 내 분석
    </div>
    <div class="aiAnalysisSummary" style="white-space: pre-wrap;">${escapeHtml(recent.answer || "(분석 결과 없음)")}</div>
  `;

  // 카드 목록의 맨 위에 추가
  cardsEl.insertBefore(portfolioCard, cardsEl.firstChild);
}

async function restoreAiAnalysisFromRecent(recent) {
  if (!recent) return false;
  const cardsEl = $("aiAnalysisCards");
  const finalEl = $("aiAnalysisFinal");
  const finalContentEl = $("aiAnalysisFinalContent");
  if (!cardsEl || !finalEl || !finalContentEl) return false;

  // 카드 데이터 복원
  const cardData = {
    macro: { title: "매크로", status: "완료", content: "", summary: "" },
    screener: { title: "스크리너", status: "완료", content: "", summary: "" },
    chart: { title: "차트", status: "완료", content: "", summary: "" },
    company: { title: "기업분석", status: "완료", content: "", summary: "" },
    news: { title: "최근 이슈", status: "완료", content: "", summary: "" },
    peers: { title: "관련주", status: "완료", content: "", summary: "" }
  };

  const signals = recent.signals || {};
  if (signals.market_signal) {
    cardData.chart.summary = signals.market_signal;
  }
  if (signals.financial_signal) {
    cardData.company.summary = signals.financial_signal;
  }
  if (signals.event_signal) {
    cardData.news.summary = signals.event_signal;
  }
  if (signals.peer_signal) {
    cardData.peers.summary = signals.peer_signal;
  }

  // 차트와 기업분석 카드는 독립 분석 이벤트에서 업데이트됨
  // const story = recent.story || "";
  // const marketCheck = recent.marketCheck || {};
  // if (marketCheck.reason) {
  //   cardData.chart.content = `시장 검증: ${marketCheck.agreement || ""}\n${marketCheck.reason || ""}`;
  //   if (story) {
  //     cardData.chart.content += `\n\n[스토리]\n${story}`;
  //   }
  // }

  const peerAdjust = recent.peerAdjust || {};
  if (peerAdjust.adjustment) {
    cardData.peers.content = `비교군 보정:\n${peerAdjust.adjustment || ""}\n\n산업 대비:\n${peerAdjust.industry_vs_company || ""}`;
  }

  // 카드 렌더링
  cardsEl.innerHTML = Object.entries(cardData)
    .map(([key, data]) => {
      const statusClass = data.status === "완료" ? "status-done" : "status-waiting";
      return `
        <div class="aiAnalysisCard" data-card="${key}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 16px; font-weight: 700;">${data.title}</div>
            <div class="aiAnalysisStatus ${statusClass}">
              ${data.status}
            </div>
          </div>
          ${data.summary ? `<div class="aiAnalysisSummary">${escapeHtml(data.summary)}</div>` : ""}
          ${data.content ? `<div class="aiAnalysisContent">${escapeHtml(data.content)}</div>` : ""}
        </div>
      `;
    })
    .join("");

  // 최종 판단 표시
  if (recent.final) {
    finalEl.style.display = "block";
    finalContentEl.textContent = recent.final;
  }

  return true;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function mountAiAnalysis() {
  const root = $("leftWidgetRoot");
  if (!root) return;

  const toggleBtn = $("toggleCalendar");
  if (toggleBtn) toggleBtn.style.display = "none";

  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";

  root.innerHTML = `
    <div class="aiAnalysisContainer" style="padding: 16px; height: 100%; overflow-y: auto;">
      <div style="margin-bottom: 16px;">
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">AI 종합 분석</div>
        <div style="font-size: 14px; color: #666; margin-bottom: 16px;">
          매크로, 스크리너, 차트, 기업분석, 최근 이슈, 관련주를 종합적으로 평가합니다.
        </div>
        <button id="aiAnalysisStart" class="btn" type="button" style="margin-bottom: 16px;">분석 시작</button>
        <button id="aiAnalysisStop" class="btn btn--ghost" type="button" style="margin-bottom: 16px; display: none;">분석 중지</button>
      </div>
      <div id="aiAnalysisCards" class="aiAnalysisCards" style="display: grid; gap: 16px;">
        <!-- 카드들이 여기에 동적으로 추가됩니다 -->
      </div>
      <div id="aiAnalysisFinal" class="aiAnalysisFinal" style="margin-top: 24px; display: none;">
        <div style="font-size: 16px; font-weight: 700; margin-bottom: 12px; color: var(--text);">조건부 종합 판단</div>
        <div id="aiAnalysisFinalContent" style="color: var(--text);"></div>
        <div id="aiAnalysisRawData" style="margin-top: 16px; display: none;">
          <button id="aiAnalysisRawDataToggle" class="btn btn--ghost" style="margin-bottom: 8px; font-size: 12px;">원문 수치 데이터 보기</button>
          <div id="aiAnalysisRawDataContent" style="display: none; padding: 12px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; font-family: monospace; white-space: pre-wrap; overflow-x: auto; max-height: 400px; overflow-y: auto;"></div>
        </div>
      </div>
    </div>
  `;

  // 5분 이내 최근 결과 확인 및 복원
  const recent = await loadRecentAiAnalysis(symbol);
  if (recent) {
    const restored = await restoreAiAnalysisFromRecent(recent);
    if (restored) {
      const startBtn = $("aiAnalysisStart");
      if (startBtn) {
        startBtn.textContent = "새로 분석하기";
      }
    }
  }

  // 최근 1일 내 포트폴리오 분석 결과 확인 및 표시
  await loadAndDisplayRecentPortfolioAnalysis();

  $("aiAnalysisStart")?.addEventListener("click", () => startAiAnalysis());
  $("aiAnalysisStop")?.addEventListener("click", () => stopAiAnalysis());
}

function stopAiAnalysis() {
  if (aiAnalysisAbortController) {
    aiAnalysisAbortController.abort();
    aiAnalysisAbortController = null;
  }
  const startBtn = $("aiAnalysisStart");
  const stopBtn = $("aiAnalysisStop");
  if (startBtn) startBtn.style.display = "inline-flex";
  if (stopBtn) stopBtn.style.display = "none";
}

async function startAiAnalysis() {
  // 항상 현재 심볼 필드의 값을 사용
  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  
  // 5분 이내 최근 결과 확인 (강제 재분석이 아닐 때만)
  const recent = await loadRecentAiAnalysis(symbol);
  if (recent) {
    const restored = await restoreAiAnalysisFromRecent(recent);
    if (restored) {
      const startBtn = $("aiAnalysisStart");
      if (startBtn) {
        startBtn.textContent = "새로 분석하기";
      }
      // 사용자가 "새로 분석하기"를 명시적으로 클릭할 때만 진행
      return;
    }
  }
  
  let question = "";
  
  // AI 종합 분석 뷰일 때는 모든 데이터를 수집해야 함
  if (leftView === "aiAnalysis") {
    // 매크로 데이터 로드
    if (!latestMacroIndices || !latestMacroNews || latestMacroIndices.length === 0 || latestMacroNews.length === 0 || !lastMacroAt || Date.now() - lastMacroAt > 60_000) {
      await loadMacro();
    }
    // 스크리너 데이터 로드
    if (!latestScreenerText || !lastScreenerAt || Date.now() - lastScreenerAt > 35_000) {
      await loadYahooScreener();
    }
    // 데이터 로드 확인
    if ((!latestMacroIndices || latestMacroIndices.length === 0) && (!latestMacroNews || latestMacroNews.length === 0)) {
      console.warn("매크로 데이터가 없습니다.", { latestMacroIndices, latestMacroNews });
    }
    if (!latestScreenerText || latestScreenerText.trim().length === 0) {
      console.warn("스크리너 데이터가 없습니다.", { latestScreenerText });
    }
    question = ""; // AI 종합 분석은 question 없이 모든 데이터를 수집
  } else if (leftView === "macro") {
    // 매크로 데이터가 없거나 오래되었으면 먼저 로드
    if (!latestMacroIndices || !latestMacroNews || latestMacroIndices.length === 0 || latestMacroNews.length === 0) {
      await loadMacro();
    }
    const macroData = {
      indices: latestMacroIndices || [],
      news: latestMacroNews || []
    };
    if (macroData.indices.length === 0 && macroData.news.length === 0) {
      addMessage("system", "매크로 데이터를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.", "error");
      return;
    }
    question = `현재 매크로 환경을 분석해주세요. 시장 지표: ${JSON.stringify(macroData.indices).slice(0, 500)}... 주요 뉴스: ${JSON.stringify(macroData.news).slice(0, 500)}...`;
  } else if (leftView === "screener") {
    // 스크리너 데이터가 없거나 오래되었으면 먼저 로드
    if (!latestScreenerText || !lastScreenerAt || Date.now() - lastScreenerAt > 35_000) {
      const loaded = await loadYahooScreener();
      if (!loaded) {
        addMessage("system", "스크리너 데이터를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.", "error");
        return;
      }
    }
    const screenerData = latestScreenerText || "";
    if (!screenerData || screenerData.trim().length === 0) {
      addMessage("system", "스크리너 데이터가 없습니다. 잠시 후 다시 시도해주세요.", "error");
      return;
    }
    question = `스크리너 데이터를 기반으로 시장 상황을 분석해주세요. 스크리너: ${screenerData.slice(0, 1000)}...`;
  }
  
  const cardsEl = $("aiAnalysisCards");
  const finalEl = $("aiAnalysisFinal");
  const finalContentEl = $("aiAnalysisFinalContent");
  const startBtn = $("aiAnalysisStart");
  const stopBtn = $("aiAnalysisStop");

  if (!cardsEl || !finalEl || !finalContentEl) return;

  // 기존 분석 중지
  stopAiAnalysis();

  // UI 초기화
  cardsEl.innerHTML = "";
  finalEl.style.display = "none";
  finalContentEl.textContent = "";
  if (startBtn) startBtn.style.display = "none";
  if (stopBtn) stopBtn.style.display = "inline-flex";

  // 카드 초기 상태 - 현재 뷰에 따라 적절한 카드 활성화
  const cardData = {
    macro: { title: "매크로", status: (leftView === "macro" || leftView === "aiAnalysis") ? "분석 중..." : "대기 중...", content: "", summary: "" },
    screener: { title: "스크리너", status: (leftView === "screener" || leftView === "aiAnalysis") ? "분석 중..." : "대기 중...", content: "", summary: "" },
    chart: { title: "차트", status: (leftView === "chart" || leftView === "aiAnalysis") ? "분석 중..." : "대기 중...", content: "", summary: "" },
    company: { title: "기업분석", status: (leftView === "company" || leftView === "aiAnalysis") ? "분석 중..." : "대기 중...", content: "", summary: "" },
    consensus: { title: "컨센서스", status: leftView === "aiAnalysis" ? "분석 중..." : "대기 중...", content: "", summary: "" },
    news: { title: "최근 이슈", status: leftView === "aiAnalysis" ? "분석 중..." : "대기 중...", content: "", summary: "" },
    peers: { title: "관련주", status: leftView === "aiAnalysis" ? "분석 중..." : "대기 중...", content: "", summary: "" },
    filings: { title: "공시", status: leftView === "aiAnalysis" ? "분석 중..." : "대기 중...", content: "", summary: "" }
  };

  function renderCards() {
    cardsEl.innerHTML = Object.entries(cardData)
      .map(([key, data]) => {
        const statusClass = data.status === "완료" ? "status-done" : data.status === "분석 중..." ? "status-progress" : "status-waiting";
        return `
          <div class="aiAnalysisCard" data-card="${key}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <div style="font-size: 16px; font-weight: 700;">${data.title}</div>
              <div class="aiAnalysisStatus ${statusClass}">
                ${data.status}
              </div>
            </div>
            ${data.summary ? `<div class="aiAnalysisSummary">${escapeHtml(data.summary)}</div>` : ""}
            ${data.content ? `<div class="aiAnalysisContent">${escapeHtml(data.content)}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  renderCards();

  // AbortController 생성
  aiAnalysisAbortController = new AbortController();

  try {
    // AI 종합 분석일 때는 매크로와 스크리너 데이터도 함께 전송
    const payload = { symbol, question };
    if (leftView === "aiAnalysis") {
      payload.macroIndices = latestMacroIndices || [];
      payload.macroNews = latestMacroNews || [];
      payload.screener = latestScreenerText || "";
    }
    
    const resp = await fetch("/api/judge_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: aiAnalysisAbortController.signal
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      addMessage("system", `오류: ${resp.status} ${resp.statusText}\n${text}`.trim(), "error");
      return;
    }

    if (!resp.body) {
      addMessage("system", "오류: 스트리밍 바디가 없습니다.", "error");
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        const dataRaw = dataLines.join("\n");
        let data;
        try {
          data = dataRaw ? JSON.parse(dataRaw) : {};
        } catch {
          data = { raw: dataRaw };
        }

        // 디버깅: 모든 이벤트 로그
        console.log("AI 분석 이벤트:", eventName, data);

        if (eventName === "status") {
          const stage = String(data?.stage || "");
          console.log("상태 단계:", stage);
          // 단계별로 카드 상태 업데이트
          if (stage === "collect") {
            cardData.macro.status = "분석 중...";
            cardData.screener.status = "분석 중...";
            cardData.chart.status = "분석 중...";
            cardData.company.status = "분석 중...";
            cardData.news.status = "분석 중...";
            cardData.peers.status = "분석 중...";
            renderCards();
          } else if (stage === "signal_extract") {
            console.log("신호 추출 단계 시작");
            cardData.macro.status = "분석 중...";
            cardData.screener.status = "분석 중...";
            cardData.chart.status = "분석 중...";
            cardData.company.status = "분석 중...";
            renderCards();
          } else if (stage === "story_link") {
            console.log("스토리 링크 단계");
          } else if (stage === "market_check") {
            console.log("시장 검증 단계");
          } else if (stage === "peer_adjust") {
            console.log("비교군 보정 단계");
          } else if (stage === "final_judgement") {
            console.log("최종 판단 단계");
          } else if (stage === "verify") {
            console.log("검증 단계");
          }
        } else if (eventName === "rag") {
          // RAG 데이터 수집 완료 - 각 파트별 데이터 요약 표시
          const ragMeta = data?.rag_meta || {};
          const docIds = Array.isArray(ragMeta.doc_ids) ? ragMeta.doc_ids : [];
          
          // doc_ids를 기반으로 각 파트별 데이터 존재 여부 확인
          const hasCompany = docIds.some(id => id.includes("company_profile") || id.includes("income_statement") || id.includes("balance_sheet") || id.includes("cashflow"));
          const hasNews = docIds.some(id => id.includes("news"));
          const hasChart = docIds.some(id => id.includes("market_behavior"));
          const hasPeers = docIds.some(id => id.includes("peer_comparison"));
          
          if (hasCompany) {
            cardData.company.status = "완료";
            cardData.company.content = "재무제표 및 기업 프로필 데이터 수집 완료";
          }
          if (hasNews) {
            cardData.news.status = "완료";
            cardData.news.content = "최근 뉴스 데이터 수집 완료";
          }
          if (hasChart) {
            cardData.chart.status = "완료";
            cardData.chart.content = "차트 및 시장 행동 데이터 수집 완료";
          }
          if (hasPeers) {
            cardData.peers.status = "완료";
            cardData.peers.content = "관련주 비교 데이터 수집 완료";
          }
          
          // 매크로와 스크리너 데이터 수집 확인
          if (leftView === "macro" || leftView === "aiAnalysis") {
            const hasMacroIndices = docIds.some(id => id.includes("macro/indices") || id.includes("macro_indices"));
            const hasMacroNews = docIds.some(id => id.includes("macro/news") || id.includes("macro_news"));
            const hasMacro = hasMacroIndices || hasMacroNews;
            console.log("RAG 이벤트 - 매크로 확인:", { hasMacro, hasMacroIndices, hasMacroNews, docIds, latestMacroIndices: latestMacroIndices?.length });
            if (hasMacro || (latestMacroIndices && latestMacroIndices.length > 0)) {
              cardData.macro.status = "완료";
              cardData.macro.content = `시장 지표 ${latestMacroIndices?.length || 0}개 수집 완료`;
            }
          }
          if (leftView === "screener" || leftView === "aiAnalysis") {
            const hasScreener = docIds.some(id => (id.includes("screener/market") || id.includes("screener")) && !id.includes("company"));
            console.log("RAG 이벤트 - 스크리너 확인:", { hasScreener, docIds, latestScreenerText: latestScreenerText?.length });
            if (hasScreener || (latestScreenerText && latestScreenerText.trim().length > 0)) {
              cardData.screener.status = "완료";
              cardData.screener.content = "스크리너 데이터 수집 완료";
            }
          }
          
          renderCards();
        } else if (eventName === "signal") {
          // 신호 추출 결과를 파트별로 분류
          console.log("신호 추출 완료:", data);
          const signals = data?.signals || {};
          if (data?.error) {
            console.error("신호 추출 에러:", data.error);
            addMessage("system", `신호 추출 중 오류가 발생했습니다: ${data.error}`, "error");
          }
          if (signals.market_signal) {
            cardData.chart.summary = signals.market_signal;
            cardData.chart.status = "완료";
          }
          if (signals.financial_signal) {
            cardData.company.summary = signals.financial_signal;
            cardData.company.status = "완료";
          }
          if (signals.event_signal) {
            cardData.news.summary = signals.event_signal;
            cardData.news.status = "완료";
          }
          if (signals.peer_signal) {
            cardData.peers.summary = signals.peer_signal;
            cardData.peers.status = "완료";
          }
          // 매크로와 스크리너 신호 처리
          if (leftView === "macro" || leftView === "aiAnalysis") {
            if (signals.macro_signal && signals.macro_signal.trim().length > 0) {
              cardData.macro.summary = signals.macro_signal;
              cardData.macro.status = "완료";
            } else if (cardData.macro.status === "분석 중..." && (latestMacroIndices?.length > 0 || latestMacroNews?.length > 0)) {
              // 신호가 없어도 데이터가 수집되었다면 완료로 표시
              cardData.macro.status = "완료";
              cardData.macro.summary = "매크로 데이터 분석 완료 (신호 추출 없음)";
            }
          }
          if (leftView === "screener" || leftView === "aiAnalysis") {
            if (signals.screener_signal && signals.screener_signal.trim().length > 0) {
              cardData.screener.summary = signals.screener_signal;
              cardData.screener.status = "완료";
            } else if (cardData.screener.status === "분석 중..." && latestScreenerText && latestScreenerText.trim().length > 0) {
              // 신호가 없어도 데이터가 수집되었다면 완료로 표시
              cardData.screener.status = "완료";
              cardData.screener.summary = "스크리너 데이터 분석 완료 (신호 추출 없음)";
            }
          }
          renderCards();
        } else if (eventName === "story") {
          // 스토리 링크 결과를 각 카드에 추가
          const story = String(data?.story || "");
          if (story) {
            cardData.chart.content += "\n\n" + story;
            cardData.company.content += "\n\n" + story;
            renderCards();
          }
        } else if (eventName === "market_check") {
          const marketCheck = data?.marketCheck || {};
          const story = data?.story || "";
          let content = `시장 검증: ${marketCheck.agreement || ""}\n${marketCheck.reason || ""}`;
          if (story && story.trim().length > 0 && !story.includes("스토리 생성 실패")) {
            content += `\n\n[스토리]\n${story}`;
          }
          cardData.chart.content = content;
          renderCards();
        } else if (eventName === "peer_adjust") {
          const peerAdjust = data?.peerAdjust || {};
          if (peerAdjust.adjustment) {
            cardData.peers.content = `비교군 보정:\n${peerAdjust.adjustment || ""}\n\n산업 대비:\n${peerAdjust.industry_vs_company || ""}`;
            renderCards();
          }
        } else if (eventName === "chart_card") {
          const card = data?.card;
          if (card) {
            cardData.chart.status = "완료";
            cardData.chart.summary = card.key_insight || "";
            cardData.chart.content = `가격 위치: ${card.price_position || ""}\n\n기술적 요약: ${card.technical_summary || ""}\n\n의미: ${card.what_it_means_for_judge || ""}`;
            renderCards();
          }
        } else if (eventName === "company_card") {
          const card = data?.card;
          if (card) {
            cardData.company.status = "완료";
            cardData.company.summary = card.key_insight || "";
            cardData.company.content = `재무 체력: ${card.financial_strength || ""}\n\n밸류에이션 요약: ${card.valuation_summary || ""}\n\n의미: ${card.what_it_means_for_judge || ""}`;
            renderCards();
          }
        } else if (eventName === "consensus_card") {
          const card = data?.card;
          if (card) {
            cardData.consensus.status = "완료";
            cardData.consensus.summary = card.key_insight || "";
            const directionBadge = card.consensus_direction === "POSITIVE" ? "긍정" : card.consensus_direction === "NEGATIVE" ? "부정" : card.consensus_direction === "MIXED" ? "혼재" : "중립";
            const pricingState = card.expectation_pricing_state === "NOT_PRICED_IN" ? "반영 안됨" : card.expectation_pricing_state === "PARTIALLY_PRICED" ? "부분 반영" : card.expectation_pricing_state === "MOSTLY_PRICED" ? "대부분 반영" : "과도 반영";
            cardData.consensus.content = `방향: ${directionBadge}\n가격 반영 상태: ${pricingState}\n분석가 일치도: ${card.analyst_agreement_level}\n\n의미: ${card.what_it_means_for_judge || ""}\n\n주의사항:\n${(card.cautions || []).map(c => `- ${c}`).join("\n")}`;
            renderCards();
          }
        } else if (eventName === "sec_filing_card") {
          const card = data?.card;
          if (card) {
            cardData.filings.status = "완료";
            cardData.filings.summary = card.oneLineSummary || "";
            const sentimentBadge = card.sentiment === "positive" ? "긍정" : card.sentiment === "caution" ? "주의" : "중립";
            cardData.filings.content = `감정: ${sentimentBadge}\n\n의미: ${card.meaning || ""}\n\n주의: ${card.risk || ""}\n\n판단: ${card.finalJudgement || ""}`;
            renderCards();
          }
        } else if (eventName === "final") {
          finalEl.style.display = "block";
          
          // JSON 스키마가 있으면 구조화하여 표시
          const json = data?.json;
          const rawData = data?.rawData;
          
          if (json && json.final_judgment) {
            // 구조화된 표시 생성
            const verdict = json.final_judgment.verdict || "WAIT";
            const confidence = json.final_judgment.confidence || "MEDIUM";
            const verdictText = {
              "WAIT": "관망",
              "BUY": "매수 고려",
              "ACCUMULATE": "누적 매수",
              "REDUCE": "감소",
              "AVOID": "회피"
            }[verdict] || verdict;
            const confidenceText = {
              "LOW": "낮음",
              "MEDIUM": "보통",
              "HIGH": "높음"
            }[confidence] || confidence;
            
            let html = `<div style="margin-bottom: 16px;">`;
            html += `<div style="font-size: 18px; font-weight: 700; margin-bottom: 8px;">AI 종합 판단: ${verdictText}</div>`;
            html += `<div style="font-size: 14px; color: var(--muted); margin-bottom: 12px;">확신도: ${confidenceText}</div>`;
            
            if (json.one_line_summary) {
              html += `<div style="margin-bottom: 16px; padding: 12px; background: rgba(255, 255, 255, 0.03); border-radius: 8px;">`;
              html += `<div style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">한 줄 요약</div>`;
              html += `<div style="font-size: 13px; line-height: 1.6;">${escapeHtml(json.one_line_summary)}</div>`;
              html += `</div>`;
            }
            
            if (json.decision_stack_reasoning) {
              html += `<div style="margin-bottom: 16px;">`;
              html += `<div style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">판단 근거</div>`;
              const reasoning = json.decision_stack_reasoning;
              if (reasoning.macro) html += `<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.02); border-radius: 6px;"><div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">시장 컨디션</div><div style="font-size: 13px; line-height: 1.5;">${escapeHtml(reasoning.macro)}</div></div>`;
              if (reasoning.quality) html += `<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.02); border-radius: 6px;"><div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">기업 체력</div><div style="font-size: 13px; line-height: 1.5;">${escapeHtml(reasoning.quality)}</div></div>`;
              if (reasoning.timing) html += `<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.02); border-radius: 6px;"><div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">가격 위치</div><div style="font-size: 13px; line-height: 1.5;">${escapeHtml(reasoning.timing)}</div></div>`;
              if (reasoning.catalyst_risk) html += `<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.02); border-radius: 6px;"><div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">뉴스/이벤트</div><div style="font-size: 13px; line-height: 1.5;">${escapeHtml(reasoning.catalyst_risk)}</div></div>`;
              if (reasoning.relative_choice) html += `<div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.02); border-radius: 6px;"><div style="font-size: 12px; color: var(--muted); margin-bottom: 4px;">대안 비교</div><div style="font-size: 13px; line-height: 1.5;">${escapeHtml(reasoning.relative_choice)}</div></div>`;
              html += `</div>`;
            }
            
            if (json.action_guidance) {
              html += `<div style="margin-bottom: 16px; padding: 12px; background: rgba(106, 168, 255, 0.1); border-radius: 8px; border: 1px solid rgba(106, 168, 255, 0.3);">`;
              html += `<div style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">지금 할 수 있는 선택지</div>`;
              html += `<div style="font-size: 13px; line-height: 1.6; margin-bottom: 8px;">${escapeHtml(json.action_guidance.recommended_action || "")}</div>`;
              if (Array.isArray(json.action_guidance.conditions) && json.action_guidance.conditions.length > 0) {
                html += `<div style="font-size: 12px; color: var(--muted); margin-top: 8px;">조건:</div>`;
                json.action_guidance.conditions.forEach(cond => {
                  html += `<div style="font-size: 12px; margin-left: 12px; margin-top: 4px;">• ${escapeHtml(cond)}</div>`;
                });
              }
              html += `</div>`;
            }
            
            if (Array.isArray(json.downside_scenarios) && json.downside_scenarios.length > 0) {
              html += `<div style="margin-bottom: 16px; padding: 12px; background: rgba(255, 106, 106, 0.08); border-radius: 8px; border: 1px solid rgba(255, 106, 106, 0.2);">`;
              html += `<div style="font-size: 14px; font-weight: 600; margin-bottom: 8px;">하방/실패 시나리오</div>`;
              json.downside_scenarios.forEach(scenario => {
                html += `<div style="font-size: 13px; line-height: 1.6; margin-bottom: 4px;">• ${escapeHtml(scenario)}</div>`;
              });
              html += `</div>`;
            }
            
            // 마크다운 요약도 표시
            if (json.markdown_summary) {
              html += `<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">`;
              html += `<div style="white-space: pre-wrap; line-height: 1.6; font-size: 13px;">${escapeHtml(json.markdown_summary)}</div>`;
              html += `</div>`;
            }
            
            html += `</div>`;
            finalContentEl.innerHTML = html;
          } else {
            // JSON이 없으면 마크다운만 표시
            finalContentEl.innerHTML = `<div style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(String(data?.answer || ""))}</div>`;
          }
          
          // 원문 수치 데이터 표시
          const rawDataEl = $("aiAnalysisRawData");
          const rawDataContentEl = $("aiAnalysisRawDataContent");
          const rawDataToggleBtn = $("aiAnalysisRawDataToggle");
          if (rawData && rawDataEl && rawDataContentEl && rawDataToggleBtn) {
            rawDataEl.style.display = "block";
            rawDataContentEl.textContent = JSON.stringify(rawData, null, 2);
            rawDataToggleBtn.addEventListener("click", () => {
              const isVisible = rawDataContentEl.style.display !== "none";
              rawDataContentEl.style.display = isVisible ? "none" : "block";
              rawDataToggleBtn.textContent = isVisible ? "원문 수치 데이터 보기" : "원문 수치 데이터 숨기";
            });
          }
          
          if (startBtn) startBtn.style.display = "inline-flex";
          if (stopBtn) stopBtn.style.display = "none";
          // 종합 판단이 표시되면 종합 분석 카드 제거
          renderCards();
        } else if (eventName === "error") {
          console.error("AI 분석 에러:", data);
          const errorMsg = `오류: ${data?.error || "error"}\n${data?.details || ""}`.trim();
          addMessage("system", errorMsg, "error");
          // 모든 카드를 에러 상태로 표시
          Object.keys(cardData).forEach(key => {
            if (cardData[key].status === "분석 중...") {
              cardData[key].status = "오류";
              cardData[key].content = "분석 중 오류가 발생했습니다.";
            }
          });
          renderCards();
          if (startBtn) startBtn.style.display = "inline-flex";
          if (stopBtn) stopBtn.style.display = "none";
        } else if (eventName === "done") {
          if (startBtn) startBtn.style.display = "inline-flex";
          if (stopBtn) stopBtn.style.display = "none";
          return;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      addMessage("system", "분석이 중지되었습니다.", "info");
    } else {
      addMessage("system", `요청 실패: ${String(e?.message || e)}`, "error");
    }
    if (startBtn) startBtn.style.display = "inline-flex";
    if (stopBtn) stopBtn.style.display = "none";
  } finally {
    aiAnalysisAbortController = null;
  }
}

// 채팅 입력에서 종목명/티커 감지 및 심볼 자동 업데이트
async function detectAndUpdateTickerFromQuestion(question) {
  if (!question || !question.trim()) return null;

  const text = String(question).trim();
  
  // 1) TradingView 형식 직접 매칭 (예: NASDAQ:AAPL)
  const tvMatch = text.match(/([A-Z]{2,10}:[A-Z0-9.\-^=_]{1,32})/i);
  if (tvMatch) {
    const tvSymbol = tvMatch[1];
    const parts = tvSymbol.split(":");
    if (parts.length === 2) {
      const ticker = parts[1].toUpperCase();
      const exchange = parts[0].toUpperCase();
      const yahooSymbol = `${exchange}:${ticker}`;
      $("symbol").value = yahooSymbol;
      return ticker;
    }
  }

  // 2) 티커 직접 매칭 (예: AAPL, TSLA)
  const tickerMatch = text.match(/\b([A-Z]{1,5})\b/);
  if (tickerMatch) {
    const candidate = tickerMatch[1].toUpperCase();
    // 일반 단어 제외
    const excludeWords = new Set(["BUY", "SELL", "MARKET", "LIMIT", "USD", "KRW", "D", "W", "M", "THE", "AND", "OR", "FOR", "TO", "OF", "IN", "ON", "AT"]);
    if (!excludeWords.has(candidate) && /^[A-Z]{1,5}$/.test(candidate)) {
      // 주요 티커인지 확인
      const majorTicker = resolveMajorTickerFromToken(candidate);
      if (majorTicker && majorTicker !== candidate) {
        // 한글/영문명에서 티커로 변환된 경우
        const yahooSymbol = `NASDAQ:${majorTicker}`;
        $("symbol").value = yahooSymbol;
        return majorTicker;
      } else if (majorTicker === candidate) {
        // 직접 티커인 경우
        const yahooSymbol = `NASDAQ:${candidate}`;
        $("symbol").value = yahooSymbol;
        return candidate;
      }
    }
  }

  // 3) 한글/영문 종목명 감지 (예: 애플, Apple, 테슬라, Tesla)
  const words = Array.from(text.matchAll(/([A-Za-z가-힣]{2,})/g)).map(m => String(m[1] || "").trim()).filter(Boolean);
  const stopWords = new Set([
    "오늘", "지금", "방금", "주식", "종목", "티커", "매수", "매도", "주문", "보여줘", "보여", "알려줘", "알려",
    "차트", "차트를", "정보", "정보를", "실적", "실적을", "뉴스", "뉴스를", "분석", "분석을",
    "show", "tell", "give", "me", "the", "chart", "info", "news", "analysis", "about", "for"
  ]);

  for (const word of words) {
    if (stopWords.has(word.toLowerCase())) continue;
    
    // 한글 약어 매핑 확인
    const resolvedTicker = resolveMajorTickerFromToken(word);
    if (resolvedTicker && resolvedTicker !== word) {
      const yahooSymbol = `NASDAQ:${resolvedTicker}`;
      $("symbol").value = yahooSymbol;
      return resolvedTicker;
    }
  }

  // 4) Firestore에서 종목명 검색 (비동기, 선택적)
  if (firebaseReady() && firebaseSignedIn()) {
    try {
      for (const word of words) {
        if (stopWords.has(word.toLowerCase())) continue;
        if (word.length < 2) continue;
        
        const normalized = word.trim().toLowerCase().replace(/\s+/g, "");
        const snap = await fbState.db.collection("ticker_master")
          .where("keys", "array-contains", normalized)
          .limit(1)
          .get();
        
        if (!snap.empty) {
          const doc = snap.docs[0];
          const data = doc.data();
          const ticker = String(data?.symbol || "").trim().toUpperCase();
          if (ticker) {
            const yahooSymbol = `NASDAQ:${ticker}`;
            $("symbol").value = yahooSymbol;
            return ticker;
          }
        }
      }
    } catch (e) {
      // Firestore 검색 실패 시 무시
      console.warn("종목명 Firestore 검색 실패:", e);
    }
  }

  return null;
}

async function askExplain() {
  let symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const interval = $("interval").value || "D";
  const question = $("question").value || "";
  const ohlcv = latestOhlcvText || "";
  let screener = "";
  let consensus = "";
  let routingData = null; // 빠른 라우팅 결과 저장

  if (!question.trim()) {
    addMessage("system", "질문/요청을 입력해 주세요.", "error");
    return;
  }

  // 1차: 빠른 라우팅 (Mini 모델로 즉시 의도 파악)
  try {
    const fastRoutingResp = await fetch("/api/fast_routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage: question })
    });

    if (fastRoutingResp.ok) {
      routingData = await fastRoutingResp.json();
      const { page, ticker, skipChat, directAnswer } = routingData || {};

      // 티커가 있으면 심볼 업데이트
      if (ticker) {
        const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
        $("symbol").value = yahooSymbol;
        symbol = yahooSymbol;
        console.log(`[빠른 라우팅] 종목 감지: ${ticker} → ${yahooSymbol}`);
      }

      // directAnswer가 true이면 단순 질문 → 탭 변경 없이 채팅으로 바로 답변
      if (directAnswer) {
        console.log(`[빠른 라우팅] 단순 질문 감지: ${question} → 채팅으로 바로 답변`);
        // 탭 변경 없이 채팅 로직 계속 진행
        // skipChat 체크는 하지 않고 채팅 응답 생성
      } else {
        // 페이지 라우팅 (탭 변경이 필요한 경우만)
        if (page && page !== "CURRENT_PAGE") {
          const pageMap = {
            "STOCK_HOME": "stockHome",
            "CHART": "chart",
            "COMPANY": "company",
            "NEWS": "macro", // 뉴스는 매크로 화면에 포함
            "SCREENER": "screener",
            "MACRO": "macro",
            "AI_ANALYSIS": "aiAnalysis"
          };
          const view = pageMap[page];
          if (view) {
            setLeftView(view, "빠른 라우팅");
            console.log(`[빠른 라우팅] 화면 이동: ${page} → ${view}`);
            
            // AI_ANALYSIS는 화면만 이동 (자동 실행하지 않음)
            if (page === "AI_ANALYSIS") {
              console.log(`[빠른 라우팅] 종합분석 화면으로 이동 (자동 실행 안 함)`);
              addMessage("assistant", "종합 분석 화면으로 이동했습니다. '종합 판단' 버튼을 클릭하면 분석을 시작합니다.");
              return; // 채팅 로직 건너뛰기
            }
          }
        }

        // skipChat이 true이면 채팅 로직 건너뛰기 (예: "주가 알려줘" → 종목홈만 보여주면 됨)
        if (skipChat) {
          console.log(`[빠른 라우팅] 채팅 스킵: ${question}`);
          return; // 채팅 응답 없이 종료
        }
      }
    }
  } catch (e) {
    // 빠른 라우팅 실패 시 기존 로직으로 진행
    console.warn("빠른 라우팅 실패:", e);
  }

  // 채팅 입력에서 종목명/티커 자동 감지 및 심볼 업데이트 (폴백)
  const detectedTicker = await detectAndUpdateTickerFromQuestion(question);
  if (detectedTicker) {
    symbol = $("symbol").value.trim(); // 업데이트된 심볼 사용
    console.log(`종목명 감지: ${detectedTicker} → ${symbol}`);
  }

  // AI Control Layer: Action 기반 제어
  try {
    const controlResp = await fetch("/api/ai_control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage: question })
    });

    if (controlResp.ok) {
      const actionData = await controlResp.json();
      const executed = await executeAiAction(actionData);
      if (executed) {
        // Action이 성공적으로 실행되었으면 기존 채팅 로직은 건너뛰기
        return;
      }
    }
  } catch (e) {
    // AI Control 실패 시 기존 로직으로 폴백
    console.warn("AI Control 실패:", e);
  }

  // 기존 AI Navigator: Intent 분류 및 화면 라우팅 (폴백)
  try {
    const intentResp = await fetch("/api/navigate_intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage: question })
    });

    if (intentResp.ok) {
      const intentData = await intentResp.json();
      const intent = intentData.intent;
      const ticker = intentData.ticker;

      // Intent에 따라 화면 전환 및 메시지 표시
      if (intent === "VIEW_CHART") {
        setLeftView("chart", "AI Navigator");
        if (ticker) {
          const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
          $("symbol").value = yahooSymbol;
          addMessage("assistant", `차트를 보면서 설명할게요. (${ticker})`);
        } else {
          addMessage("assistant", "차트를 보면서 설명할게요.");
        }
      } else if (intent === "COMPANY_FUNDAMENTAL") {
        setLeftView("company", "AI Navigator");
        if (ticker) {
          const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
          $("symbol").value = yahooSymbol;
          addMessage("assistant", `기업 실적부터 볼게요. (${ticker})`);
        } else {
          addMessage("assistant", "기업 실적부터 볼게요.");
        }
      } else if (intent === "SCREEN_STOCK") {
        setLeftView("screener", "AI Navigator");
        addMessage("assistant", "스크리너 화면으로 이동할게요.");
      } else if (intent === "INVEST_DECISION") {
        // INVEST_DECISION은 화면만 이동 (자동 실행 안 함)
        setLeftView("aiAnalysis", "AI Navigator");
        if (ticker) {
          const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
          $("symbol").value = yahooSymbol;
          addMessage("assistant", `종합 분석 화면으로 이동했습니다. (${ticker}) '종합 판단' 버튼을 클릭하면 분석을 시작합니다.`);
        } else {
          addMessage("assistant", "종합 분석 화면으로 이동했습니다. '종합 판단' 버튼을 클릭하면 분석을 시작합니다.");
        }
      } else if (intent === "MARKET_OVERVIEW") {
        setLeftView("macro", "AI Navigator");
        addMessage("assistant", "시장 개요 화면으로 이동할게요.");
      } else {
        // Intent 분류 실패 시
        addMessage("assistant", "어떤 분석을 볼지 알려주세요.");
      }

      // ticker가 있으면 symbol 업데이트
      if (ticker && intent !== null) {
        const currentSymbol = $("symbol").value.trim();
        if (!currentSymbol || currentSymbol === "NASDAQ:AAPL") {
          const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
          $("symbol").value = yahooSymbol;
        }
      }
    }
  } catch (e) {
    // Intent 분류 실패 시 무시하고 기존 로직 진행
    console.warn("Intent 분류 실패:", e);
  }

  function looksLikeKisTemplate(t) {
    const s = String(t || "");
    return /SIDE\s*:\s*(BUY|SELL)/i.test(s) && /ORD_QTY\s*:\s*\d+/i.test(s);
  }

  // 주문 문장(자연어/템플릿) 감지 시: 모달로 확인 후 실행
  if (orderModeOn || looksLikeKisTemplate(question) || looksLikeNaturalOrder(question)) {
    if (!orderModeOn) setOrderMode(true);
    const fallbackYahooSymbol = normalizeToYahooSymbolForOrder(symbol);
    const kisParsed = parseKisOrderTemplateText(question, fallbackYahooSymbol);
    const parsed = kisParsed.ok ? kisParsed : parseOrderText(question, fallbackYahooSymbol);
    addMessage("user", question);
    if (!parsed.ok) {
      if (parsed.reason === "missing") {
        addMessage(
          "system",
          `주문 정보가 부족해요: ${parsed.missing.join(", ")}\n예: "AAPL 10주 매수" 또는 KIS 템플릿 JSON에서 필수 항목을 채워주세요.`,
          "error"
        );
      } else {
        addMessage("system", "주문 문장을 이해하지 못했어요. 예: \"AAPL 10주 매수\" 또는 KIS 템플릿 JSON", "error");
      }
      return;
    }

    // 주문은 "DB에 있거나 Yahoo 검색으로 존재가 확인되는" 종목일 때만 허용 (완전 없는 종목은 주문 금지)
    try {
      const candidates = extractOrderSymbolCandidates(question, parsed.order.symbol);
      let resolved = "";
      for (const c of candidates) {
        resolved = await resolveTickerForOrderValidated(c);
        if (resolved) break;
      }
      if (!resolved) {
        addMessage(
          "system",
          [
            "주문 불가: 존재가 확인되는 종목만 가상 주문이 가능합니다. (DB 또는 Yahoo 검색 기준)",
            `- 입력: "${parsed.order.symbol}"`,
            "",
            "해결:",
            "- 상단 심볼 자동완성에서 종목을 먼저 검색/선택한 뒤 주문하거나",
            "- Yahoo에서 검색되는 티커/종목명으로 다시 입력해 주세요."
          ].join("\\n"),
          "error"
        );
        return;
      }
      parsed.order.symbol = resolved;
    } catch {
      // ignore
    }

    setPendingOrder(parsed.order);
    pendingOrderMeta = parsed.kis ? { kis: parsed.kis } : null;
    const o = parsed.order;
    const kisInfo = parsed.kis || {};
    addMessage(
      "assistant",
      [
        "가상 주문 미리보기",
        `- 심볼: ${o.symbol}`,
        `- 방향: ${o.side === "BUY" ? "매수" : "매도"}`,
        `- 타입: ${o.type}`,
        `- 수량: ${o.qty}주`,
        o.type === "LIMIT" ? `- 지정가: ${o.limitPrice}` : "",
        kisInfo?.CANO ? `- CANO: ${kisInfo.CANO} (가상 주문에는 미사용)` : "",
        kisInfo?.ACNT_PRDT_CD ? `- ACNT_PRDT_CD: ${kisInfo.ACNT_PRDT_CD} (가상 주문에는 미사용)` : "",
        "",
        "확인 모달이 뜨면 **확인 후 실행**을 누르면 주문이 처리됩니다."
      ]
        .filter(Boolean)
        .join("\n")
    );
    // 바로 확인 모달 표시
    showOrderConfirmModal();
    return;
  }

  // 채팅 내용에 따라 왼쪽 화면 자동 전환
  const q = question.toLowerCase();
  if (q.includes("스크리너") || q.includes("screener") || q.includes("포렉스") || q.includes("forex")) {
    setLeftView("screener", "채팅 키워드 감지");
  } else if (q.includes("기업분석") || q.includes("기업정보") || q.includes("회사") || q.includes("재무") || q.includes("프로필") || q.includes("symbol profile")) {
    setLeftView("company", "채팅 키워드 감지");
  } else if (
    q.includes("매크로") ||
    q.includes("macro") ||
    q.includes("지수") ||
    q.includes("인덱스") ||
    q.includes("index") ||
    q.includes("금리") ||
    q.includes("cpi") ||
    q.includes("fomc")
  ) {
    setLeftView("macro", "채팅 키워드 감지");
  } else if (q.includes("차트") || q.includes("chart") || q.includes("캔들") || q.includes("봉")) {
    setLeftView("chart", "채팅 키워드 감지");
  }

  // 매크로 관련 질문이면(또는 현재 매크로 화면이면) 최신 매크로 데이터를 로드
  if (leftView === "macro" || q.includes("매크로") || q.includes("macro") || q.includes("지수") || q.includes("인덱스") || q.includes("index") || q.includes("금리") || q.includes("cpi") || q.includes("fomc")) {
    // 데이터가 없거나 오래되었으면 1회 갱신 시도
    if (!latestMacroIndices || !latestMacroNews || latestMacroIndices.length === 0 || latestMacroNews.length === 0 || !lastMacroAt || Date.now() - lastMacroAt > 60_000) {
      await loadMacro();
      setYahooLast(new Date().toLocaleString());
    }
  }

  // 스크리너 관련 질문이면(또는 현재 스크리너 화면이면) 최신 스크리너 rows를 LLM에 전달
  if (leftView === "screener" || q.includes("스크리너") || q.includes("screener")) {
    // 너무 오래됐으면 1회 갱신 시도
    if (!lastScreenerAt || Date.now() - lastScreenerAt > 35_000) {
      await loadYahooScreener();
      setYahooLast(new Date().toLocaleString());
    }
    screener = latestScreenerText || "";
  }

  // 컨센서스는 질문 전송 시점에 최대 10분 이내면 재사용, 아니면 1회 갱신 시도
  if (!lastConsensusAt || Date.now() - lastConsensusAt > 10 * 60_000 || !latestConsensusText) {
    await loadYahooConsensus();
  }
  consensus = latestConsensusText || "";

  addMessage("user", `(${symbol}, ${interval})\n${question}`);

  const btn = $("ask");
  btn.disabled = true;
  btn.textContent = "생성 중...";

  const assistantEl = addMessage("assistant", "", "assistant");
  const assistantContentEl = assistantEl?.querySelector?.(".msg__content");
  let acc = "";

  function setAssistant(text) {
    if (!assistantContentEl) return;
    assistantContentEl.textContent = text;
    const messages = $("messages");
    messages.scrollTop = messages.scrollHeight;
  }

  try {
    // directAnswer 플래그 확인 (빠른 라우팅에서 설정됨)
    const isDirectAnswer = routingData?.directAnswer === true;
    
    // 모든 질문은 검증자 파이프라인(/api/chat_stream)을 통해 응답
    const resp = await fetch("/api/chat_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, interval, view: leftView, question, ohlcv, screener, consensus, directAnswer: isDirectAnswer })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      addMessage("system", `오류: ${resp.status} ${resp.statusText}\n${text}`.trim(), "error");
      return;
    }
    if (!resp.body) {
      addMessage("system", "오류: 스트리밍 바디가 없습니다.", "error");
      return;
    }

    // SSE 읽기: status는 UI에 짧게 표시, final은 점진 출력
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        const dataRaw = dataLines.join("\n");
        let data;
        try {
          data = dataRaw ? JSON.parse(dataRaw) : {};
        } catch {
          data = { raw: dataRaw };
        }

        if (eventName === "status") {
          const stage = data?.stage || "";
          const attempt = data?.attempt ? ` (재시도 ${data.attempt})` : "";
          if (stage) setAssistant(`진행 중: ${stage}${attempt}…`);
        } else if (eventName === "final") {
          const finalText = String(data?.answer || "");
          // 타이핑처럼 보이게 클라이언트에서 천천히 출력
          acc = "";
          // 저장은 최종 텍스트로 1회만(타이핑 중 연속 저장 방지)
          updatePersistedMessage(assistantEl, finalText);
          const chunkSize = 24;
          let i = 0;
          const timer = setInterval(() => {
            acc += finalText.slice(i, i + chunkSize);
            i += chunkSize;
            setAssistant(acc);
            if (i >= finalText.length) clearInterval(timer);
          }, 15);
        } else if (eventName === "error") {
          addMessage("system", `오류: ${data?.error || "error"}\n${data?.details || ""}`.trim(), "error");
        } else if (eventName === "done") {
          return;
        }
      }
    }
  } catch (e) {
    addMessage("system", `요청 실패: ${String(e?.message || e)}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "전송";
  }
}

// AI Control Layer: Action 실행 함수
async function executeAiAction(actionData) {
  const { action, target, entity, params, message } = actionData || {};
  
  // Action이 없으면 실행하지 않음
  if (!action) {
    console.warn("AI Control: action이 없습니다.", actionData);
    return false;
  }

  // Message 출력 (Action 실행 전)
  if (message) {
    addMessage("assistant", message);
  }

  try {
    // Entity가 있으면 종목 컨텍스트 업데이트
    if (entity && entity.ticker) {
      const ticker = entity.ticker;
      const yahooSymbol = ticker.includes(":") ? ticker : `NASDAQ:${ticker}`;
      $("symbol").value = yahooSymbol;
    }

    // Action에 따라 실행
    switch (action) {
      case "NAVIGATE":
        return await executeNavigateAction(target, entity, params);
      
      case "UPDATE_CHART":
        return await executeUpdateChartAction(target, entity, params);
      
      case "FETCH_DATA":
        return await executeFetchDataAction(target, entity, params);
      
      case "RUN_ANALYSIS":
        return await executeRunAnalysisAction(target, entity, params);
      
      default:
        console.warn("AI Control: 알 수 없는 action:", action);
        addMessage("system", "요청을 처리할 수 없어요.", "error");
        return false;
    }
  } catch (e) {
    console.error("AI Control 실행 실패:", e);
    addMessage("system", `요청 처리 중 오류가 발생했습니다: ${e?.message || e}`, "error");
    return false;
  }
}

// NAVIGATE Action 실행
async function executeNavigateAction(target, entity, params) {
  const targetMap = {
    "stock_home": "stockHome",
    "chart": "chart",
    "company": "company",
    "screener": "screener",
    "macro": "macro",
    "news": "macro", // 뉴스는 매크로 화면에 포함
    "decision": "aiAnalysis"
  };

  const view = targetMap[target];
  if (!view) {
    console.warn("AI Control: 알 수 없는 target:", target);
    addMessage("system", "이동할 화면을 찾을 수 없어요.", "error");
    return false;
  }

  setLeftView(view, "AI Control");
  return true;
}

// UPDATE_CHART Action 실행
async function executeUpdateChartAction(target, entity, params) {
  // 차트 화면으로 이동
  setLeftView("chart", "AI Control");
  
  // 차트 상태 업데이트 (params 기반)
  if (params.period) {
    // 기간 설정 (예: "6M" -> interval 변경)
    const periodMap = {
      "1M": "D",
      "3M": "D",
      "6M": "W",
      "1Y": "W",
      "2Y": "M"
    };
    const interval = periodMap[params.period] || $("interval").value || "D";
    $("interval").value = interval;
  }

  // 차트 재로딩
  if (typeof mountTradingViewChart === "function") {
    mountTradingViewChart();
  }

  // 지표/선 표시는 placeholder (실제 구현 시 TradingView 위젯 설정)
  if (params.indicators || params.draw) {
    console.log("AI Control: 차트 지표/선 설정 (placeholder):", { indicators: params.indicators, draw: params.draw });
    addMessage("system", "차트 지표와 선 표시 기능은 준비 중입니다.", "info");
  }

  return true;
}

// FETCH_DATA Action 실행
async function executeFetchDataAction(target, entity, params) {
  try {
    if (target === "news") {
      // 뉴스 데이터 호출
      if (entity && entity.ticker) {
        // 특정 종목 뉴스
        addMessage("system", `${entity.ticker} 관련 뉴스를 불러오는 중입니다...`, "info");
        // TODO: 실제 뉴스 API 호출
        // await fetchNewsForTicker(entity.ticker, params.range);
      } else {
        // 일반 뉴스 (매크로 화면)
        setLeftView("macro", "AI Control");
        if (typeof loadMacro === "function") {
          await loadMacro();
        }
      }
    } else if (target === "company") {
      // 기업 데이터 호출
      setLeftView("company", "AI Control");
      if (typeof mountTradingViewCompany === "function") {
        mountTradingViewCompany();
      }
    } else {
      // 기타 데이터 호출
      addMessage("system", `${target} 데이터를 불러오는 중입니다...`, "info");
    }
    return true;
  } catch (e) {
    console.error("FETCH_DATA 실행 실패:", e);
    addMessage("system", "데이터를 불러오는 중 오류가 발생했습니다.", "error");
    return false;
  }
}

// RUN_ANALYSIS Action 실행
async function executeRunAnalysisAction(target, entity, params) {
  if (target === "decision") {
    // 종합 판단 화면으로만 이동 (자동 실행 안 함)
    if (!entity || !entity.ticker) {
      addMessage("system", "어떤 종목을 분석할까요?", "error");
      return false;
    }

    // 종합 판단 화면으로 이동
    setLeftView("aiAnalysis", "AI Control");
    
    // 자동 실행하지 않고 안내만
    addMessage("assistant", `${entity.ticker} 종합 분석 화면으로 이동했습니다. '종합 판단' 버튼을 클릭하면 분석을 시작합니다.`);
    return true;
  } else {
    console.warn("AI Control: 알 수 없는 분석 target:", target);
    addMessage("system", "분석을 실행할 수 없어요.", "error");
    return false;
  }
}

async function runJudgement() {
  const symbol = $("symbol").value.trim() || "NASDAQ:AAPL";
  const questionRaw = String($("question")?.value || "").trim();
  const question = questionRaw || "위 종목을 인간 사고 구조(재무→이벤트→시장→비교군→조건부 종합)로 판단해줘.";

  // 주문 모드와 혼동 방지: 종합 판단은 주문 파서로 보내지 않는다.
  if (orderModeOn) {
    addMessage("system", "현재 가상 주문 모드입니다. 종합 판단을 하려면 주문 모드를 꺼주세요.", "error");
    return;
  }

  addMessage("user", `(종합 판단) ${symbol}\n${questionRaw || "(기본 요청)"}`);

  const judgeBtn = $("judge");
  const askBtn = $("ask");
  if (judgeBtn) judgeBtn.disabled = true;
  if (askBtn) askBtn.disabled = true;

  const assistantEl = addMessage("assistant", "", "assistant");
  const assistantContentEl = assistantEl?.querySelector?.(".msg__content");

  let progressLine = "";
  const sections = {
    run: "",
    rag: "",
    signal: "",
    story: "",
    market: "",
    peer: "",
    final: ""
  };

  const judgeRun = {
    run_id: "",
    input_hash: "",
    symbol,
    question: questionRaw || "",
    createdAtClient: Date.now(),
    rag_meta: null,
    rag_bundle: null,
    signals: null,
    story: null,
    marketCheck: null,
    peerAdjust: null,
    final: null,
    verifier: null
  };

  function render() {
    if (!assistantContentEl) return;
    const body = [sections.run, sections.rag, sections.signal, sections.story, sections.market, sections.peer, sections.final]
      .filter(Boolean)
      .join("\n\n");
    assistantContentEl.textContent = [progressLine, body].filter(Boolean).join("\n\n").trim();
    const messages = $("messages");
    messages.scrollTop = messages.scrollHeight;
  }

  try {
    const resp = await fetch("/api/judge_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, question })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      addMessage("system", `오류: ${resp.status} ${resp.statusText}\n${text}`.trim(), "error");
      return;
    }
    if (!resp.body) {
      addMessage("system", "오류: 스트리밍 바디가 없습니다.", "error");
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        const dataRaw = dataLines.join("\n");
        let data;
        try {
          data = dataRaw ? JSON.parse(dataRaw) : {};
        } catch {
          data = { raw: dataRaw };
        }

        if (eventName === "status") {
          const stage = String(data?.stage || "");
          const attempt = data?.attempt ? ` (재시도 ${data.attempt})` : "";
          progressLine = stage ? `진행 중: ${stage}${attempt}…` : "";
          if (data?.run_id) sections.run = `RUN: ${data.run_id} (prompt: ${data?.prompt_v || ""})`.trim();
          if (data?.run_id) judgeRun.run_id = String(data.run_id);
          render();
        } else if (eventName === "rag") {
          const runId = data?.run_id || "";
          const inputHash = data?.input_hash || "";
          const ids = Array.isArray(data?.rag_meta?.doc_ids) ? data.rag_meta.doc_ids : [];
          sections.rag = [
            "RAG 번들",
            `- run_id: ${runId}`,
            `- input_hash: ${inputHash}`,
            `- doc_ids: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? " ..." : ""}`
          ].join("\n");
          judgeRun.run_id = String(runId || judgeRun.run_id || "");
          judgeRun.input_hash = String(inputHash || "");
          judgeRun.rag_meta = data?.rag_meta || null;
          render();
        } else if (eventName === "rag_bundle") {
          // UI에는 노출하지 않고, 재현/저장용으로만 보관
          judgeRun.rag_bundle = data?.rag || null;
        } else if (eventName === "signal") {
          sections.signal = ["신호 추출(JSON)", JSON.stringify(data?.signals || {}, null, 2)].join("\n");
          judgeRun.signals = data?.signals || null;
          render();
        } else if (eventName === "story") {
          sections.story = ["스토리(원인–결과 가설)", String(data?.story || "")].join("\n");
          judgeRun.story = String(data?.story || "");
          render();
        } else if (eventName === "market_check") {
          sections.market = ["시장 검증", JSON.stringify(data?.marketCheck || {}, null, 2)].join("\n");
          judgeRun.marketCheck = data?.marketCheck || null;
          render();
        } else if (eventName === "peer_adjust") {
          sections.peer = ["비교군 보정", JSON.stringify(data?.peerAdjust || {}, null, 2)].join("\n");
          judgeRun.peerAdjust = data?.peerAdjust || null;
          render();
        } else if (eventName === "final") {
          progressLine = "";
          sections.final = ["조건부 종합 판단", String(data?.answer || "")].join("\n\n");
          judgeRun.final = String(data?.answer || "");
          judgeRun.verifier = data?.verifier || null;
          render();

          // cloud save: 종합 판단 결과 저장(유저별)
          if (firebaseSignedIn() && firebaseReady() && cloudSaveEnabled()) {
            try {
              const u = userDocRef();
              if (u && judgeRun.run_id) {
                await u
                  .collection("judge_runs")
                  .doc(String(judgeRun.run_id))
                  .set(
                    {
                      run_id: String(judgeRun.run_id),
                      input_hash: String(judgeRun.input_hash || ""),
                      symbol: String(judgeRun.symbol || ""),
                      question: String(judgeRun.question || ""),
                      rag_meta: judgeRun.rag_meta || null,
                      rag_bundle: judgeRun.rag_bundle || null,
                      signals: judgeRun.signals || null,
                      story: String(judgeRun.story || ""),
                      marketCheck: judgeRun.marketCheck || null,
                      peerAdjust: judgeRun.peerAdjust || null,
                      final: clampCloudText(String(judgeRun.final || ""), 80_000),
                      verifier: judgeRun.verifier || null,
                      createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    },
                    { merge: true }
                  );
                logAnalyticEvent("judge_run_saved");
              }
            } catch {
              // ignore
            }
          }
        } else if (eventName === "error") {
          progressLine = "";
          sections.final = `오류: ${data?.error || "error"}\n${data?.details || ""}`.trim();
          render();
        } else if (eventName === "done") {
          progressLine = "";
          render();
          return;
        }
      }
    }
  } catch (e) {
    addMessage("system", `요청 실패: ${String(e?.message || e)}`, "error");
  } finally {
    if (judgeBtn) judgeBtn.disabled = false;
    if (askBtn) askBtn.disabled = false;
  }
}

function init() {
  // 탭 버튼들이 존재하는지 확인
  const segmentedContainer = document.querySelector(".segmented");
  if (!segmentedContainer) {
    console.error("탭 컨테이너(.segmented)를 찾을 수 없습니다.");
  }
  
  initSymbolAutocomplete();
  $("reloadChart").addEventListener("click", () => {
    // 새로고침 버튼 클릭 시 현재 심볼 값으로 변경 적용
    if (typeof window.applySymbolChange === "function") {
      window.applySymbolChange();
    }
    if (leftView === "screener") mountTradingViewScreener();
    else if (leftView === "company") mountTradingViewCompany();
    else if (leftView === "macro") mountMacro();
    else if (leftView === "aiAnalysis") mountAiAnalysis();
    else if (leftView === "stockHome") mountStockHome();
    else mountTradingViewChart();
    addMessage("system", "왼쪽 화면을 새로고침했어요.");
  });
  // 탭 버튼 이벤트 리스너 설정
  const viewChartBtn = $("viewChart");
  const viewCompanyBtn = $("viewCompany");
  const viewMacroBtn = $("viewMacro");
  const viewScreenerBtn = $("viewScreener");
  const viewAiAnalysisBtn = $("viewAiAnalysis");
  const viewStockHomeBtn = $("viewStockHome");
  
  if (viewChartBtn) viewChartBtn.addEventListener("click", () => setLeftView("chart"));
  if (viewCompanyBtn) viewCompanyBtn.addEventListener("click", () => setLeftView("company"));
  if (viewMacroBtn) viewMacroBtn.addEventListener("click", () => setLeftView("macro"));
  if (viewScreenerBtn) viewScreenerBtn.addEventListener("click", () => setLeftView("screener"));
  if (viewAiAnalysisBtn) viewAiAnalysisBtn.addEventListener("click", () => setLeftView("aiAnalysis"));
  if (viewStockHomeBtn) viewStockHomeBtn.addEventListener("click", () => setLeftView("stockHome"));
  $("toggleCalendar")?.addEventListener("click", () => {
    if (leftView !== "screener") return;
    calendarCollapsed = !calendarCollapsed;
    mountTradingViewScreener();
    updateCalendarToggleUI();
  });
  // 수동 버튼 없이, 항상 30초 자동 갱신
  startYahooAutoPoll(30);
  setYahooStatus("자동(30초)");

  // 심볼/간격이 바뀌면 즉시 재로딩(그리고 계속 30초 폴링)
  const symbolEl = $("symbol");
  const intervalEl = $("interval");
  
  // localStorage에서 심볼/간격 값 복원
  try {
    const savedSymbol = localStorage.getItem("last_symbol");
    if (savedSymbol && symbolEl) {
      symbolEl.value = savedSymbol;
    }
    const savedInterval = localStorage.getItem("last_interval");
    if (savedInterval && intervalEl) {
      intervalEl.value = savedInterval;
    }
  } catch {}

  // 심볼 변경 핸들러 (Enter키, 새로고침 버튼, 자동완성 선택에서만 호출)
  window.applySymbolChange = function() {
    scheduleTvRemount(0);
    try {
      localStorage.setItem("last_symbol", String(symbolEl.value || ""));
      localStorage.setItem("last_interval", String(intervalEl.value || "D"));
    } catch {}
    loadYahooOhlcv().finally(() => setYahooLast(new Date().toLocaleString()));
    loadYahooConsensus();
    
    // 기업분석이나 AI 종합분석 뷰에서는 해당 심볼로 다시 마운트
    if (leftView === "company") {
      mountTradingViewCompany();
    } else if (leftView === "aiAnalysis") {
      mountAiAnalysis();
    }
  };

  // Enter 키를 눌렀을 때만 심볼 변경 적용
  symbolEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      window.applySymbolChange();
    }
  });

  // change 이벤트는 제거 (타이핑만으로는 변경되지 않도록)

  intervalEl?.addEventListener("change", () => {
    scheduleTvRemount(0);
    try {
      localStorage.setItem("last_interval", String(intervalEl.value || "D"));
    } catch {}
    loadYahooOhlcv().finally(() => setYahooLast(new Date().toLocaleString()));
    
    // 기업분석이나 AI 종합분석 뷰에서는 다시 마운트
    if (leftView === "company") {
      mountTradingViewCompany();
    } else if (leftView === "aiAnalysis") {
      mountAiAnalysis();
    }
  });

  $("ask").addEventListener("click", askExplain);
  $("judge")?.addEventListener("click", runJudgement);
  // "지우기" 버튼 제거됨

  // 가상 주문 모드 UI
  $("orderMode")?.addEventListener("click", () => {
    setOrderMode(!orderModeOn);
    if (orderModeOn) {
      const tvSym = ($("symbol")?.value || "NASDAQ:AAPL").trim();
      const ticker = tvSymbolToYahooSymbol(tvSym) || "AAPL";
      const exch = String(tvSym.split(":")[0] || "NASDAQ").toUpperCase();
      const ovrsExcg =
        exch.includes("NASDAQ") ? "NASD" : exch.includes("NYSE") ? "NYSE" : exch.includes("AMEX") || exch.includes("ARCA") ? "AMEX" : "NASD";

      const qEl = $("question");
      if (qEl) {
        qEl.value =
          "주식 주문하기\n" +
          "- CANO: 계좌 8자리\n" +
          "- ACNT_PRDT_CD: 계좌 상품코드 2자리\n" +
          "- SIDE: BUY 또는 SELL\n" +
          "- ORD_QTY: 수량\n" +
          "- (지정가면) OVRS_ORD_UNPR: 지정가";
        qEl.focus();
        qEl.setSelectionRange(qEl.value.length, qEl.value.length);
      }

      // 템플릿만 남기기(추가 설명 메시지 제거)
    } else {
      addMessage("system", "가상 주문 모드를 껐습니다.");
    }
  });
  $("orderCancel")?.addEventListener("click", () => {
    setPendingOrder(null);
    pendingOrderMeta = null;
    setOrderMode(false);
    addMessage("system", "가상 주문을 취소했습니다.");
  });
  $("orderExecute")?.addEventListener("click", showOrderConfirmModal);

  // modal bindings
  $("orderConfirmClose")?.addEventListener("click", hideOrderConfirmModal);
  $("orderConfirmNo")?.addEventListener("click", hideOrderConfirmModal);
  $("orderConfirmYes")?.addEventListener("click", executePaperOrder);
  $("orderConfirmModal")?.addEventListener("click", (e) => {
    if (e?.target?.dataset?.modalClose) hideOrderConfirmModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideOrderConfirmModal();
  });

  // Firebase auth (mypage는 별도 페이지)

  initFirebaseIfPossible();
  renderTopAuthUI();
  logAnalyticEvent("app_open");

  if (firebaseReady()) {
    fbState.auth.onAuthStateChanged(async (user) => {
      fbState.user = user || null;
      renderTopAuthUI();
      if (user) {
        try {
          await ensureUserDoc();

          // 로그인 시 최신 세션 자동 복원(1회만)
          if (cloudSaveEnabled() && !sessionStorage.getItem(CLOUD_AUTO_RESTORED_KEY)) {
            sessionStorage.setItem(CLOUD_AUTO_RESTORED_KEY, "1");
            await pickLatestSessionAndRestore({ limit: 160 });
          }

          await ensureChatSessionDoc();
          logAnalyticEvent("login", { method: user?.providerData?.[0]?.providerId || "unknown" });
        } catch (e) {
          addMessage("system", `Firestore 동기화 오류: ${e?.message || e}`);
        }
      }
    });
  }

  $("authPageBtn")?.addEventListener("click", () => {
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    location.href = `/login.html?next=${next}`;
  });
  $("logoutBtn")?.addEventListener("click", async () => {
    if (!firebaseReady()) return;
    await fbState.auth.signOut();
    fbState.user = null;
    renderTopAuthUI();
    logAnalyticEvent("logout");
    addMessage("system", "로그아웃했습니다.");
  });

  $("mypageBtn")?.addEventListener("click", () => {
    if (!firebaseSignedIn()) {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      location.href = `/login.html?next=${next}`;
      return;
    }
    openMyPage();
  });

  // Enter로 전송(Shift+Enter는 줄바꿈)
  $("question").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      askExplain();
    }
  });

  // 초기 화면 설정 전에 UI 업데이트
  updateLeftControlsUI();
  
  // 초기 화면: 매크로
  leftView = "";
  setLeftView("macro");
  
  // 탭 버튼들이 제대로 보이는지 확인
  const segmentedEl = document.querySelector(".segmented");
  if (segmentedEl) {
    segmentedEl.style.display = "inline-flex";
  }

  // 저장된 대화 복원(재접속/새로고침 시)
  if (Array.isArray(chatStore) && chatStore.length) {
    for (const m of chatStore) {
      if (!m || !m.role) continue;
      addMessage(m.role, String(m.content || ""), m.variant || m.role, { skipPersist: true });
    }
    addMessage("system", "이전 대화를 복원했습니다(브라우저 로컬 저장).");
  } else {
    addMessage(
      "system",
      "야후 OHLCV를 30초마다 자동으로 불러옵니다. 해설은 이 OHLCV(최대 200봉)와 질문을 기반으로 생성됩니다."
    );
  }
}

// DOM이 완전히 로드된 후 초기화
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}


