// GPT API 호출 테스트 스크립트
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env 파일 로드
async function loadDotEnv(envPath) {
  try {
    const raw = await readFile(envPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // ignore if no .env
  }
}

await loadDotEnv(path.join(__dirname, ".env"));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

console.log("=== GPT API 호출 테스트 ===\n");
console.log("환경 변수:");
console.log("- OPENAI_API_KEY 존재:", !!OPENAI_API_KEY);
console.log("- OPENAI_API_KEY 길이:", OPENAI_API_KEY ? OPENAI_API_KEY.length : 0);
console.log("- OPENAI_BASE_URL:", OPENAI_BASE_URL);
console.log("- OPENAI_MODEL:", OPENAI_MODEL);
console.log("");

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY가 설정되지 않았습니다!");
  process.exit(1);
}

async function testGPT() {
  console.log("테스트 1: 간단한 요청 (gpt-5.2)");
  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Say 'Hello' in Korean." }
        ],
        temperature: 0.7,
        max_tokens: 50
      })
    });

    console.log("응답 상태:", resp.status, resp.statusText);
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("❌ 실패:", errText);
      return false;
    }

    const data = await resp.json();
    console.log("✅ 성공!");
    console.log("응답:", JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error("❌ 예외 발생:", e.message);
    console.error("스택:", e.stack);
    return false;
  }
}

async function testGPTMini() {
  console.log("\n테스트 2: 간단한 요청 (gpt-5-mini)");
  try {
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Say 'Hello' in Korean." }
        ],
        temperature: 0.7,
        max_tokens: 50
      })
    });

    console.log("응답 상태:", resp.status, resp.statusText);
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("❌ 실패:", errText);
      return false;
    }

    const data = await resp.json();
    console.log("✅ 성공!");
    console.log("응답:", JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error("❌ 예외 발생:", e.message);
    console.error("스택:", e.stack);
    return false;
  }
}

async function testMarketInsightLike() {
  console.log("\n테스트 3: Market Insight 스타일 요청 (긴 프롬프트)");
  try {
    const system = "당신은 'Market Insight' 요약 작성자입니다.";
    const user = "지수와 뉴스 데이터를 요약해주세요.";
    
    const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.35,
        max_completion_tokens: 1200
      })
    });

    console.log("응답 상태:", resp.status, resp.statusText);
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("❌ 실패:", errText);
      return false;
    }

    const data = await resp.json();
    console.log("✅ 성공!");
    console.log("응답 구조:", {
      hasChoices: !!data.choices,
      choicesLength: data.choices?.length || 0,
      hasError: !!data.error
    });
    
    if (data.choices && data.choices[0]) {
      const content = data.choices[0].message?.content || "";
      console.log("응답 내용 길이:", content.length);
      console.log("응답 내용 미리보기:", content.slice(0, 200));
    }
    
    return true;
  } catch (e) {
    console.error("❌ 예외 발생:", e.message);
    console.error("스택:", e.stack);
    return false;
  }
}

// 테스트 실행
const results = [];
results.push(await testGPT());
results.push(await testGPTMini());
results.push(await testMarketInsightLike());

console.log("\n=== 테스트 결과 요약 ===");
console.log(`성공: ${results.filter(r => r).length}/${results.length}`);
if (results.every(r => r)) {
  console.log("✅ 모든 테스트 통과!");
  process.exit(0);
} else {
  console.log("❌ 일부 테스트 실패");
  process.exit(1);
}

