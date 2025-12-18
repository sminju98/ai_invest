const $ = (id) => document.getElementById(id);

function getFirebaseConfig() {
  return window.GOYO_FIREBASE_CONFIG || null;
}

function initFirebase() {
  const cfg = getFirebaseConfig();
  if (!cfg || !cfg.apiKey) throw new Error("Firebase 설정이 없습니다. public/firebase-config.js를 확인하세요.");
  if (!window.firebase) throw new Error("Firebase SDK 로드 실패");
  const app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();
  let analytics = null;
  try {
    analytics = firebase.analytics ? firebase.analytics() : null;
  } catch {
    analytics = null;
  }
  return { app, auth, db, analytics };
}

function logEventSafe(analytics, name, params) {
  try {
    if (!analytics) return;
    analytics.logEvent(String(name || ""), params && typeof params === "object" ? params : undefined);
  } catch {
    // ignore
  }
}

function getNextUrl() {
  const url = new URL(location.href);
  const next = url.searchParams.get("next");
  return next && next.startsWith("/") ? next : "/";
}

function setMode(mode) {
  const isSignup = mode === "signup";
  $("tabLogin")?.classList.toggle("is-active", !isSignup);
  $("tabSignup")?.classList.toggle("is-active", isSignup);
  $("tabLogin")?.setAttribute("aria-selected", String(!isSignup));
  $("tabSignup")?.setAttribute("aria-selected", String(isSignup));
  $("pw2Wrap").style.display = isSignup ? "block" : "none";
  $("password").setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
  $("submit").textContent = isSignup ? "회원가입" : "로그인";
  $("authHint").textContent = isSignup ? "회원가입 후 자동 로그인됩니다." : "이메일/비밀번호 또는 Google로 로그인할 수 있습니다.";
}

function showSignedIn(user) {
  $("authForms").style.display = "none";
  $("authSignedIn").style.display = "block";
  $("authUser").textContent = `${user.email || "(이메일 없음)"} · uid: ${user.uid}`;
}

function showSignedOut() {
  $("authSignedIn").style.display = "none";
  $("authForms").style.display = "block";
}

async function ensureUserDoc(db, user) {
  const ref = db.collection("users").doc(user.uid);
  await ref.set(
    {
      uid: user.uid,
      email: user.email || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function signInWithGoogle(auth, analytics) {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await auth.signInWithPopup(provider);
    logEventSafe(analytics, "login", { method: "google" });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/popup|blocked|cancelled|closed/i.test(msg)) {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await auth.signInWithRedirect(provider);
      return;
    }
    throw e;
  }
}

async function run() {
  let fb;
  try {
    fb = initFirebase();
  } catch (e) {
    $("authHint").textContent = `오류: ${e?.message || e}`;
    $("submit").disabled = true;
    $("google").disabled = true;
    return;
  }

  const { auth, db, analytics } = fb;
  logEventSafe(analytics, "app_open", { page: "login" });

  let mode = "login";
  setMode(mode);

  $("tabLogin")?.addEventListener("click", () => {
    mode = "login";
    setMode(mode);
  });
  $("tabSignup")?.addEventListener("click", () => {
    mode = "signup";
    setMode(mode);
  });

  $("google")?.addEventListener("click", async () => {
    $("authHint").textContent = "Google 로그인 중…";
    try {
      await signInWithGoogle(auth, analytics);
    } catch (e) {
      $("authHint").textContent = `Google 로그인 실패: ${e?.message || e}`;
    }
  });

  $("submit")?.addEventListener("click", async () => {
    const email = String($("email").value || "").trim();
    const pw = String($("password").value || "");
    const pw2 = String($("password2")?.value || "");
    if (!email || !pw) {
      $("authHint").textContent = "이메일과 비밀번호를 입력해주세요.";
      return;
    }
    try {
      $("submit").disabled = true;
      $("google").disabled = true;
      if (mode === "signup") {
        if (pw.length < 6) {
          $("authHint").textContent = "비밀번호는 6자 이상이어야 합니다.";
          return;
        }
        if (pw !== pw2) {
          $("authHint").textContent = "비밀번호 확인이 일치하지 않습니다.";
          return;
        }
        await auth.createUserWithEmailAndPassword(email, pw);
        logEventSafe(analytics, "sign_up", { method: "password" });
      } else {
        await auth.signInWithEmailAndPassword(email, pw);
        logEventSafe(analytics, "login", { method: "password" });
      }
    } catch (e) {
      $("authHint").textContent = `실패: ${e?.message || e}`;
    } finally {
      $("submit").disabled = false;
      $("google").disabled = false;
    }
  });

  $("logout")?.addEventListener("click", async () => {
    await auth.signOut();
    logEventSafe(analytics, "logout");
  });

  $("goNext")?.addEventListener("click", () => {
    location.href = getNextUrl();
  });

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      try {
        await ensureUserDoc(db, user);
      } catch {
        // ignore
      }
      showSignedIn(user);
      return;
    }
    showSignedOut();
  });
}

run();


