// AI Control Layer 테스트 케이스
// 사용법: node test_ai_control.mjs

const testCases = [
  {
    userMessage: "애플 차트 보여줘",
    expectedAction: {
      action: "NAVIGATE",
      target: "chart",
      entity: { companyName: "Apple Inc", ticker: "AAPL" },
      params: {},
      message: "애플 차트를 보면서 설명할게요."
    }
  },
  {
    userMessage: "테슬라 종목홈",
    expectedAction: {
      action: "NAVIGATE",
      target: "stock_home",
      entity: { companyName: "Tesla, Inc.", ticker: "TSLA" },
      params: {},
      message: "테슬라 종목홈으로 이동할게요."
    }
  },
  {
    userMessage: "마이크로소프트 기업 정보",
    expectedAction: {
      action: "NAVIGATE",
      target: "company",
      entity: { companyName: "Microsoft Corporation", ticker: "MSFT" },
      params: {},
      message: "마이크로소프트 기업 정보를 보여드릴게요."
    }
  },
  {
    userMessage: "NVDA 6개월 차트에 지지선 저항선 표시해줘",
    expectedAction: {
      action: "UPDATE_CHART",
      target: "chart",
      entity: { companyName: "NVIDIA Corporation", ticker: "NVDA" },
      params: {
        period: "6M",
        draw: ["support", "resistance"]
      },
      message: "NVDA 6개월 차트에 지지선과 저항선을 표시할게요."
    }
  },
  {
    userMessage: "애플 최근 뉴스 보여줘",
    expectedAction: {
      action: "FETCH_DATA",
      target: "news",
      entity: { companyName: "Apple Inc", ticker: "AAPL" },
      params: { range: "7D" },
      message: "애플 최근 뉴스를 불러올게요."
    }
  },
  {
    userMessage: "구글 매수할까?",
    expectedAction: {
      action: "RUN_ANALYSIS",
      target: "decision",
      entity: { companyName: "Alphabet Inc.", ticker: "GOOGL" },
      params: {},
      message: "구글 매수 여부를 종합 판단해볼게요."
    }
  },
  {
    userMessage: "스크리너 보여줘",
    expectedAction: {
      action: "NAVIGATE",
      target: "screener",
      entity: null,
      params: {},
      message: "스크리너 화면으로 이동할게요."
    }
  },
  {
    userMessage: "시장 개요",
    expectedAction: {
      action: "NAVIGATE",
      target: "macro",
      entity: null,
      params: {},
      message: "시장 개요 화면으로 이동할게요."
    }
  }
];

console.log("AI Control Layer 테스트 케이스\n");
console.log("=".repeat(80));

testCases.forEach((testCase, index) => {
  console.log(`\n[테스트 ${index + 1}]`);
  console.log(`입력: "${testCase.userMessage}"`);
  console.log(`\n예상 Action:`);
  console.log(JSON.stringify(testCase.expectedAction, null, 2));
  
  console.log(`\nAPI 호출 예시:`);
  console.log(`POST /api/ai_control`);
  console.log(`Body: { "userMessage": "${testCase.userMessage}" }`);
  
  console.log(`\n프론트엔드 실행 로직:`);
  const { action, target, entity, params, message } = testCase.expectedAction;
  
  if (action === "NAVIGATE") {
    console.log(`- executeNavigateAction("${target}", ${entity ? JSON.stringify(entity) : "null"}, ${JSON.stringify(params)})`);
    const targetMap = {
      "stock_home": "stockHome",
      "chart": "chart",
      "company": "company",
      "screener": "screener",
      "macro": "macro",
      "news": "macro",
      "decision": "aiAnalysis"
    };
    console.log(`- setLeftView("${targetMap[target]}", "AI Control")`);
    if (entity && entity.ticker) {
      console.log(`- $("symbol").value = "NASDAQ:${entity.ticker}"`);
    }
  } else if (action === "UPDATE_CHART") {
    console.log(`- executeUpdateChartAction("${target}", ${entity ? JSON.stringify(entity) : "null"}, ${JSON.stringify(params)})`);
    console.log(`- setLeftView("chart", "AI Control")`);
    if (entity && entity.ticker) {
      console.log(`- $("symbol").value = "NASDAQ:${entity.ticker}"`);
    }
    if (params.period) {
      console.log(`- $("interval").value = "${params.period === "6M" ? "W" : "D"}"`);
    }
    console.log(`- mountTradingViewChart()`);
  } else if (action === "FETCH_DATA") {
    console.log(`- executeFetchDataAction("${target}", ${entity ? JSON.stringify(entity) : "null"}, ${JSON.stringify(params)})`);
    if (target === "news") {
      if (entity && entity.ticker) {
        console.log(`- fetchNewsForTicker("${entity.ticker}", "${params.range || "7D"}")`);
      } else {
        console.log(`- setLeftView("macro", "AI Control")`);
        console.log(`- loadMacro()`);
      }
    }
  } else if (action === "RUN_ANALYSIS") {
    console.log(`- executeRunAnalysisAction("${target}", ${entity ? JSON.stringify(entity) : "null"}, ${JSON.stringify(params)})`);
    if (target === "decision") {
      console.log(`- setLeftView("aiAnalysis", "AI Control")`);
      if (entity && entity.ticker) {
        console.log(`- $("symbol").value = "NASDAQ:${entity.ticker}"`);
        console.log(`- runJudgement() 실행 안내`);
      }
    }
  }
  
  console.log(`- addMessage("assistant", "${message}")`);
  console.log("-".repeat(80));
});

console.log("\n\n구현 완료 사항:");
console.log("✓ AI Control API: /api/ai_control");
console.log("✓ Action 실행 로직: executeAiAction()");
console.log("✓ 4가지 Action 지원: NAVIGATE, UPDATE_CHART, FETCH_DATA, RUN_ANALYSIS");
console.log("✓ Entity 인식: 종목명/티커 자동 추출");
console.log("✓ 안전 장치: 알 수 없는 action/target 무시, 실패 시 폴백");
console.log("✓ UX: Action 실행 전 message 출력");

console.log("\n\nAction Schema:");
console.log(JSON.stringify({
  action: "NAVIGATE | UPDATE_CHART | FETCH_DATA | RUN_ANALYSIS",
  target: "stock_home | chart | company | screener | macro | news | decision",
  entity: {
    companyName: "string",
    ticker: "string"
  } | null,
  params: {},
  message: "사용자에게 보여줄 한 줄 설명"
}, null, 2));


