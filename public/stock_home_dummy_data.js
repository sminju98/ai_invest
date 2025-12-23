// 종목홈 더미 데이터 예시
// 실제 API 연동 시 이 구조를 참고하세요

export const stockHomeDummyData = {
  // Apple Inc.
  AAPL: {
    companyName: "Apple Inc.",
    ticker: "AAPL",
    price: 175.43,
    changeRate: 2.34,
    aiStatus: "positive",
    aiSummary: "최근 실적 발표에서 예상을 상회하는 성장세를 보였으며, 시장 기대치를 충족하고 있습니다. iPhone 판매량 증가와 서비스 부문 성장이 두드러집니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "수익성이 안정적으로 유지되고 있으며, 영업이익률이 업계 평균을 상회합니다. 높은 마진율을 지속적으로 유지하고 있습니다.",
      stability: "재무 건전성이 양호하며, 부채 비율이 적정 수준을 유지하고 있습니다. 현금 보유량이 충분하여 안정적입니다.",
      growth: "매출 성장률이 지속적으로 개선되고 있으며, 신규 사업 영역에서도 성과를 보이고 있습니다. 특히 서비스 부문의 성장이 두드러집니다."
    },
    recentIssues: [
      { title: "2024년 4분기 실적 발표 - 예상 상회", sentiment: "positive" },
      { title: "신제품 iPhone 16 출시 발표", sentiment: "neutral" },
      { title: "주주환원 정책 확대 - 배당금 인상", sentiment: "positive" }
    ],
    updatedAt: new Date().toLocaleString("ko-KR")
  },

  // Tesla, Inc.
  TSLA: {
    companyName: "Tesla, Inc.",
    ticker: "TSLA",
    price: 248.50,
    changeRate: -1.23,
    aiStatus: "caution",
    aiSummary: "최근 배송량 증가에도 불구하고 마진 압박이 지속되고 있습니다. 경쟁 심화와 가격 경쟁으로 인한 부담이 있습니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "영업이익률이 하락 추세에 있으며, 가격 인하 전략으로 인한 마진 압박이 지속되고 있습니다.",
      stability: "재무 건전성은 양호하나, 현금 흐름 변동성이 있어 주의가 필요합니다.",
      growth: "배송량은 지속적으로 증가하고 있으나, 성장률 둔화 징후가 보입니다."
    },
    recentIssues: [
      { title: "3분기 배송량 발표 - 목표 달성", sentiment: "neutral" },
      { title: "신규 공장 건설 지연", sentiment: "negative" },
      { title: "자율주행 기술 업데이트", sentiment: "positive" }
    ],
    updatedAt: new Date().toLocaleString("ko-KR")
  },

  // Microsoft Corporation
  MSFT: {
    companyName: "Microsoft Corporation",
    ticker: "MSFT",
    price: 378.85,
    changeRate: 0.89,
    aiStatus: "positive",
    aiSummary: "클라우드 서비스 부문의 강세가 지속되고 있으며, AI 관련 투자 확대로 장기 성장 기대가 높습니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "클라우드 부문의 높은 수익성이 전체 수익성을 견인하고 있으며, 안정적인 수익 구조를 보이고 있습니다.",
      stability: "재무 건전성이 매우 양호하며, 현금 보유량과 부채 관리가 우수합니다.",
      growth: "Azure 클라우드 서비스와 AI 플랫폼의 성장이 두드러지며, 지속적인 성장 동력이 있습니다."
    },
    recentIssues: [
      { title: "Azure 클라우드 매출 급증", sentiment: "positive" },
      { title: "AI 플랫폼 Copilot 확대", sentiment: "positive" },
      { title: "분기 실적 발표 - 예상 상회", sentiment: "positive" }
    ],
    updatedAt: new Date().toLocaleString("ko-KR")
  },

  // NVIDIA Corporation
  NVDA: {
    companyName: "NVIDIA Corporation",
    ticker: "NVDA",
    price: 485.20,
    changeRate: 3.45,
    aiStatus: "positive",
    aiSummary: "AI 반도체 수요 급증으로 인한 강한 성장세가 지속되고 있으며, 데이터센터 부문의 호조가 두드러집니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "높은 마진율을 유지하고 있으며, 프리미엄 제품 포트폴리오로 수익성이 강화되고 있습니다.",
      stability: "재무 건전성이 양호하며, 현금 흐름이 개선되고 있습니다.",
      growth: "AI 반도체 시장의 급성장으로 인해 매출과 이익이 급증하고 있으며, 성장 동력이 매우 강합니다."
    },
    recentIssues: [
      { title: "AI 반도체 수요 급증 - 공급 부족", sentiment: "positive" },
      { title: "신규 GPU 출시 발표", sentiment: "positive" },
      { title: "데이터센터 매출 급증", sentiment: "positive" }
    ],
    updatedAt: new Date().toLocaleString("ko-KR")
  }
};

// 기본 더미 데이터 생성 함수
export function getStockHomeDummyData(ticker = "AAPL") {
  const data = stockHomeDummyData[ticker.toUpperCase()];
  if (data) return data;
  
  // 기본 데이터
  return {
    companyName: `${ticker} Inc.`,
    ticker: ticker,
    price: 100.00,
    changeRate: 0.00,
    aiStatus: "neutral",
    aiSummary: "종목 정보를 불러오는 중입니다.",
    chartData: [],
    fundamentalsSummary: {
      profitability: "데이터 로딩 중입니다.",
      stability: "데이터 로딩 중입니다.",
      growth: "데이터 로딩 중입니다."
    },
    recentIssues: [],
    updatedAt: new Date().toLocaleString("ko-KR")
  };
}


