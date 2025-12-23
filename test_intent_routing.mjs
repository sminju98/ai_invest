// Intent Classification & Routing Engine 테스트 케이스
// 사용법: node test_intent_routing.mjs

const testCases = [
  {
    userMessage: "애플 지지선 보여줘",
    expected: {
      scope: "STOCK",
      target: { stockSymbol: "AAPL", stockName: "Apple" },
      page: "CHART",
      actions: ["DRAW_SUPPORT_RESISTANCE"],
      responseStrategy: "EXPLAIN_AFTER_ACTION",
      confidence: 0.92
    }
  },
  {
    userMessage: "테슬라 최근 뉴스",
    expected: {
      scope: "STOCK",
      target: { stockSymbol: "TSLA", stockName: "Tesla" },
      page: "NEWS",
      actions: ["FETCH_LATEST_NEWS"],
      responseStrategy: "EXPLAIN_AFTER_ACTION",
      confidence: 0.88
    }
  },
  {
    userMessage: "오늘 시장 어때?",
    expected: {
      scope: "MARKET",
      target: { stockSymbol: null, stockName: null },
      page: "MARKET_INSIGHT",
      actions: ["RECOMPUTE_INSIGHT"],
      responseStrategy: "EXPLAIN_AFTER_ACTION",
      confidence: 0.85
    }
  },
  {
    userMessage: "NVDA와 MSFT 비교해줘",
    expected: {
      scope: "STOCK",
      target: { stockSymbol: null, stockName: null },
      page: "COMPARE",
      actions: ["COMPARE_STOCKS"],
      responseStrategy: "EXPLAIN_AFTER_ACTION",
      confidence: 0.90
    }
  },
  {
    userMessage: "안녕하세요",
    expected: {
      scope: "GENERAL",
      target: { stockSymbol: null, stockName: null },
      page: "CURRENT_PAGE",
      actions: ["NONE"],
      responseStrategy: "SMALL_TALK",
      confidence: 0.95
    }
  }
];

console.log("Intent Classification & Routing Engine 테스트 케이스\n");
console.log("=".repeat(80));

testCases.forEach((testCase, index) => {
  console.log(`\n[테스트 ${index + 1}]`);
  console.log(`입력: "${testCase.userMessage}"`);
  console.log(`\n예상 결과:`);
  console.log(JSON.stringify(testCase.expected, null, 2));
  
  console.log(`\nAPI 호출 예시:`);
  console.log(`POST /api/intent_routing`);
  console.log(`Body: { "userMessage": "${testCase.userMessage}" }`);
  
  console.log(`\n프론트엔드 처리 로직:`);
  const { scope, target, page, actions, responseStrategy, confidence } = testCase.expected;
  
  console.log(`1. Scope: ${scope}`);
  if (scope === "STOCK") {
    console.log(`   → 종목 중심 분석`);
  } else if (scope === "MARKET") {
    console.log(`   → 시장 전반 분석`);
  } else {
    console.log(`   → 일반 대화/도움말`);
  }
  
  console.log(`2. Target:`);
  if (target.stockSymbol) {
    console.log(`   → 종목: ${target.stockSymbol} (${target.stockName || ""})`);
    console.log(`   → $("symbol").value = "NASDAQ:${target.stockSymbol}"`);
  } else {
    console.log(`   → 종목 없음 (시장 전반 또는 일반)`);
  }
  
  console.log(`3. Page Routing: ${page}`);
  const pageMap = {
    "STOCK_HOME": "종목홈",
    "CHART": "차트",
    "NEWS": "뉴스",
    "FILING": "공시",
    "MARKET_INSIGHT": "시장 인사이트",
    "COMPARE": "비교",
    "HELP": "도움말",
    "CURRENT_PAGE": "현재 페이지 유지"
  };
  console.log(`   → ${pageMap[page]} 화면으로 이동`);
  
  console.log(`4. Actions: ${actions.join(", ")}`);
  actions.forEach(action => {
    if (action === "DRAW_SUPPORT_RESISTANCE") {
      console.log(`   → 지지선/저항선 그리기`);
    } else if (action === "DRAW_TRENDLINE") {
      console.log(`   → 추세선 그리기`);
    } else if (action === "FETCH_LATEST_NEWS") {
      console.log(`   → 최신 뉴스 가져오기`);
    } else if (action === "COMPARE_STOCKS") {
      console.log(`   → 종목 비교 실행`);
    } else if (action === "RECOMPUTE_INSIGHT") {
      console.log(`   → 시장 인사이트 재계산`);
    }
  });
  
  console.log(`5. Response Strategy: ${responseStrategy}`);
  if (responseStrategy === "EXPLAIN_ONLY") {
    console.log(`   → 설명만 제공 (기능 실행 없음)`);
  } else if (responseStrategy === "EXPLAIN_AFTER_ACTION") {
    console.log(`   → 기능 실행 후 결과 해설`);
  } else if (responseStrategy === "ASK_CLARIFICATION") {
    console.log(`   → 정보 부족, 되묻기`);
  } else {
    console.log(`   → 일반 대화`);
  }
  
  console.log(`6. Confidence: ${confidence}`);
  if (confidence < 0.6) {
    console.log(`   ⚠️ 낮은 신뢰도 → ASK_CLARIFICATION 권장`);
  }
  
  console.log("-".repeat(80));
});

console.log("\n\n구현 완료 사항:");
console.log("✓ Intent Routing API: /api/intent_routing");
console.log("✓ 5가지 결정 요소: Scope, Target, Page, Actions, Response Strategy");
console.log("✓ JSON 스키마 검증 및 정규화");
console.log("✓ Confidence 기반 자동 조정");
console.log("✓ LLM 기반 분류 (temperature: 0.2)");

console.log("\n\nJSON 스키마:");
console.log(JSON.stringify({
  scope: "STOCK | MARKET | GENERAL",
  target: {
    stockSymbol: "AAPL | null",
    stockName: "Apple | null"
  },
  page: "STOCK_HOME | CHART | NEWS | FILING | MARKET_INSIGHT | COMPARE | HELP | CURRENT_PAGE",
  actions: ["DRAW_SUPPORT_RESISTANCE | FETCH_LATEST_NEWS | NONE | ..."],
  responseStrategy: "EXPLAIN_ONLY | EXPLAIN_AFTER_ACTION | ASK_CLARIFICATION | SMALL_TALK",
  confidence: 0.0
}, null, 2));


