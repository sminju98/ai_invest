// AI Navigator Intent 분류 테스트 예시
// 사용법: node test_navigate_intent.mjs

const testCases = [
  { userMessage: "AAPL 차트 보여줘", expectedIntent: "VIEW_CHART", expectedTicker: "AAPL" },
  { userMessage: "테슬라 주가 차트", expectedIntent: "VIEW_CHART", expectedTicker: "TSLA" },
  { userMessage: "마이크로소프트 기업 정보 알려줘", expectedIntent: "COMPANY_FUNDAMENTAL", expectedTicker: "MSFT" },
  { userMessage: "애플 재무제표", expectedIntent: "COMPANY_FUNDAMENTAL", expectedTicker: "AAPL" },
  { userMessage: "스크리너 화면 보여줘", expectedIntent: "SCREEN_STOCK", expectedTicker: null },
  { userMessage: "주식 스크리닝", expectedIntent: "SCREEN_STOCK", expectedTicker: null },
  { userMessage: "NVDA 투자 판단해줘", expectedIntent: "INVEST_DECISION", expectedTicker: "NVDA" },
  { userMessage: "구글 매수할까?", expectedIntent: "INVEST_DECISION", expectedTicker: "GOOGL" },
  { userMessage: "시장 개요 보여줘", expectedIntent: "MARKET_OVERVIEW", expectedTicker: null },
  { userMessage: "매크로 지수 확인", expectedIntent: "MARKET_OVERVIEW", expectedTicker: null }
];

console.log("AI Navigator Intent 분류 테스트 예시\n");
console.log("=".repeat(60));

testCases.forEach((testCase, index) => {
  console.log(`\n[테스트 ${index + 1}]`);
  console.log(`입력: "${testCase.userMessage}"`);
  console.log(`예상 Intent: ${testCase.expectedIntent}`);
  console.log(`예상 Ticker: ${testCase.expectedTicker || "null"}`);
  console.log(`\nAPI 호출 예시:`);
  console.log(`POST /api/navigate_intent`);
  console.log(`Body: { "userMessage": "${testCase.userMessage}" }`);
  console.log(`\n예상 응답:`);
  console.log(`{ "intent": "${testCase.expectedIntent}", "ticker": ${testCase.expectedTicker ? `"${testCase.expectedTicker}"` : "null"} }`);
  console.log(`\n프론트엔드 동작:`);
  
  if (testCase.expectedIntent === "VIEW_CHART") {
    console.log(`- 화면: 차트 화면으로 전환`);
    if (testCase.expectedTicker) {
      console.log(`- 심볼: ${testCase.expectedTicker}로 설정`);
    }
    console.log(`- 메시지: "차트를 보면서 설명할게요."`);
  } else if (testCase.expectedIntent === "COMPANY_FUNDAMENTAL") {
    console.log(`- 화면: 기업분석 화면으로 전환`);
    if (testCase.expectedTicker) {
      console.log(`- 심볼: ${testCase.expectedTicker}로 설정`);
    }
    console.log(`- 메시지: "기업 실적부터 볼게요."`);
  } else if (testCase.expectedIntent === "SCREEN_STOCK") {
    console.log(`- 화면: 스크리너 화면으로 전환`);
    console.log(`- 메시지: "스크리너 화면으로 이동할게요."`);
  } else if (testCase.expectedIntent === "INVEST_DECISION") {
    console.log(`- 화면: AI 종합 분석 화면으로 전환`);
    if (testCase.expectedTicker) {
      console.log(`- 심볼: ${testCase.expectedTicker}로 설정`);
    }
    console.log(`- 메시지: "종합 분석 화면으로 이동할게요."`);
  } else if (testCase.expectedIntent === "MARKET_OVERVIEW") {
    console.log(`- 화면: 매크로 화면으로 전환`);
    console.log(`- 메시지: "시장 개요 화면으로 이동할게요."`);
  }
  
  console.log("-".repeat(60));
});

console.log("\n\n구현 완료 사항:");
console.log("✓ Intent 분류 API: /api/navigate_intent");
console.log("✓ 프론트엔드 라우팅: app.js의 askExplain() 함수에 통합");
console.log("✓ 5가지 Intent 지원: VIEW_CHART, COMPANY_FUNDAMENTAL, SCREEN_STOCK, INVEST_DECISION, MARKET_OVERVIEW");
console.log("✓ 티커 자동 추출 및 심볼 필드 업데이트");
console.log("✓ UX 메시지 출력 (화면 이동 전 안내)");


