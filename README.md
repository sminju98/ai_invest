# TradingView + LLM 해설 (로컬 데모)

왼쪽에 **TradingView Advanced Chart 위젯**, 오른쪽에 **LLM 해설/질의응답 패널**을 두는 2컬럼 데모입니다.

> 주의: 본 프로젝트는 **교육/정보 목적**이며 투자 조언이 아닙니다.

## 실행 방법

### 0) (중요) 키는 채팅/깃헙에 올리지 마세요

API 키를 메시지로 공유하면 **즉시 노출**됩니다. 이미 노출된 키는 해당 서비스 콘솔에서 **폐기/재발급**을 권장합니다.

### 1) 환경변수 설정(권장 2가지 중 택1)

#### A안) 터미널에서 1회 설정(가장 간단)

macOS(zsh) 기준:

```bash
cd "/Users/goyoai/금융 에이전트"
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
export PERPLEXITY_API_KEY="YOUR_PERPLEXITY_KEY"
```

이 터미널 창에서 이어서 `npm run dev`를 실행하면 됩니다.

#### B안) `.env` 파일로 설정(매번 export 안 해도 됨)

프로젝트 루트(`/Users/goyoai/금융 에이전트`)에 `.env` 파일을 만들고 아래처럼 넣으세요:

```bash
OPENAI_API_KEY="YOUR_OPENAI_KEY"
PERPLEXITY_API_KEY="YOUR_PERPLEXITY_KEY"
```

> 이 프로젝트의 `server.mjs`는 시작 시 `.env`를 자동으로 읽습니다.

### 2) (선택) OpenAI 키 설정

터미널에서:

```bash
export OPENAI_API_KEY="YOUR_KEY"
```

- 키가 없으면 `/api/explain`은 **더미 응답(mock)** 을 반환합니다.

### 2) 서버 실행

```bash
cd "/Users/goyoai/금융 에이전트"
npm run dev
```

브라우저에서 `http://localhost:8787` 로 접속합니다.

## GitHub + Vercel 배포(권장 흐름)

### 1) GitHub에 푸시

로컬에서:

```bash
cd "/Users/goyoai/금융 에이전트"
git init
git add .
git commit -m "Initial MVP"
```

그 다음 GitHub에서 새 repo를 만든 뒤(예: `finance-agent-mvp`), 원격을 추가하고 푸시:

```bash
git remote add origin git@github.com:YOUR_ID/finance-agent-mvp.git
git branch -M main
git push -u origin main
```

### 2) Vercel 배포

- Vercel 대시보드에서 **Import Git Repository**로 방금 repo 선택
- **Environment Variables**에 아래를 설정(필요한 것만):
  - `OPENAI_API_KEY`
  - `PERPLEXITY_API_KEY`
  - `GEMINI_API_KEY`
  - (선택) `OPENAI_MODEL` / `PERPLEXITY_MODEL` / `GEMINI_MODEL`
- Deploy

> Vercel에서는 `vercel.json`의 rewrite로 `/`가 `public/index.html`을 서빙하고, 서버리스 함수는 `/api/*`로 동작합니다.

## 가상(페이퍼) 주문 API

이 프로젝트의 “주문” 기능은 **실계좌 주문이 아닌 가상 주문(페이퍼)** 입니다.

- **Endpoint**: `POST /api/order_simulate`
- **Body 예시**:

```json
{
  "symbol": "AAPL",
  "side": "BUY",
  "type": "MARKET",
  "qty": 3
}
```

- **응답 예시**: `mode: "paper"` + `order.status`(MARKET은 `FILLED`, LIMIT은 `ACCEPTED`)


## (중요) Node가 설치되어 있지 않은 경우(이 프로젝트는 로컬 Node 포함)

현재 환경에 `node/npm`이 없을 수 있어서, 이 프로젝트는 **프로젝트 로컬에 Node를 내려받아 사용**할 수 있습니다.

- 설치 위치: `./.local/node/bin/node`
- 실행할 때는 아래처럼 `PATH`만 잡아주면 됩니다:

```bash
cd "/Users/goyoai/금융 에이전트"
export PATH="$PWD/.local/node/bin:$PATH"
node -v
npm -v
node server.mjs
```

## 사용법

- 상단에서 **심볼**(예: `NASDAQ:AAPL`)과 **간격**을 고른 뒤 **차트 새로고침**
- 오른쪽에서
  - (기본) 야후 OHLCV를 **30초마다 자동 갱신**하고 해설에 사용합니다.
  - (동작) 가능한 한 **긴 기간(range)** 부터 시도하고, 실패하면 더 **짧은 기간으로 줄여** 성공할 때까지 재시도합니다.
  - **질문/요청**: “추세/시나리오/확인 신호를 구조적으로 해설해줘” 같은 형태
- **해설 생성** 버튼을 누르면 `/api/explain`을 호출합니다.

## 야후 파이낸스에서 데이터 가져오기(가능)

이 프로젝트는 `GET /api/yahoo/ohlcv`로 야후 파이낸스의 Chart API를 호출해 **OHLCV(최대 200봉)** 를 가져옵니다.

- 예시: `GET /api/yahoo/ohlcv?symbol=AAPL&interval=1d&range=6mo`
- 반환: `{ t, o, h, l, c, v }[]` 형태의 배열

주의:
- 야후는 공식 데이터 제공자 API가 아니라, **정책/레이트리밋/응답 형식이 바뀔 수 있습니다.** (MVP에는 OK, 운영/상용은 비권장)
- “실시간”은 보장되지 않습니다(종목/거래소에 따라 **지연/누락/정확도 차이**가 있을 수 있음).
- 무료로 쓸수록 **너무 자주 호출하면** 차단/오류가 날 수 있어요. MVP 권장:
  - **1분봉(`interval=1m`) + 30~60초 폴링** 정도
  - 동일 파라미터 연타 방지를 위해 서버가 **15초 캐시**를 적용합니다.
- 안정적인 운영이 필요하면 Polygon/Tiingo/Twelve Data/Alpha Vantage 같은 **정식 데이터 API** 사용을 권장합니다.

## Perplexity에서 “스크리너 데이터” 가져오기(조건부 가능)

Perplexity는 기본적으로 **웹 리서치/요약**에 강합니다.

- “스크리너처럼 정형 수치(가격/거래량/시총 등)를 정확히”는 웹 출처/시점/표준화 문제가 있어 **데이터 피드로는 비권장**입니다.
- 다만 “특정 조건에 맞는 종목 후보를 웹에서 찾아오고, JSON으로 정리” 같은 **리서치 보조** 용도는 가능합니다(항상 출처/검증 필요).

## 환경변수

- **`OPENAI_API_KEY`**: OpenAI API 키
- **`OPENAI_MODEL`**(선택): 기본값 `gpt-5.2` (또는 `5.2`라고 적어도 자동으로 `gpt-5.2`로 처리)
- **`OPENAI_BASE_URL`**(선택): 기본값 `https://api.openai.com/v1`
- **`PERPLEXITY_API_KEY`**: Perplexity API 키(리서치 기능)
- **`PERPLEXITY_MODEL`**(선택): 기본값 `sonar`
- **`PERPLEXITY_BASE_URL`**(선택): 기본값 `https://api.perplexity.ai`
- **`PORT`**(선택): 기본값 `8787`

## Firebase 회원가입/로그인 + Firestore(DB) 설정(마이페이지/포트폴리오 저장)

이 프로젝트는 우측 상단의 **회원가입/로그인/마이페이지** 기능을 위해 Firebase를 사용할 수 있습니다.

### 1) Firebase 콘솔에서 해야 할 것

- **프로젝트 생성**
- **Authentication**
  - Sign-in method에서 **Email/Password 활성화**
  - Sign-in method에서 **Google 활성화**
    - 지원 이메일을 설정(필수)
  - Settings → Authorized domains에 로컬/배포 도메인 추가
    - 로컬 개발: `localhost`
    - 배포(Vercel 등): `YOUR_DOMAIN`
- **Firestore Database**
  - Database 생성 (기본 모드/리전은 원하는 값으로)
- **Web 앱 추가**
  - 프로젝트 설정 → “내 앱”에서 **Web 앱 등록**
  - “Firebase SDK 설정 및 구성”에서 설정값 복사

### 2) 클라이언트 설정 파일 채우기

`public/firebase-config.js`에 아래 형태로 설정값을 넣어주세요:

```js
window.GOYO_FIREBASE_CONFIG = {
  apiKey: "xxxx",
  authDomain: "xxxx.firebaseapp.com",
  projectId: "xxxx",
  storageBucket: "xxxx.appspot.com",
  messagingSenderId: "xxxx",
  appId: "1:xxxx:web:xxxx"
};
```

> Firebase 설정이 없으면 **로그인/회원가입/Firestore 저장**은 비활성화되고, 포트폴리오는 **로컬 저장(폴백)** 으로 동작합니다.

### 3) Firestore 보안 규칙(권장)

사용자별로 `users/{uid}` 및 **하위 컬렉션**을 본인에게만 읽기/쓰기 허용:

> 중요: Firestore Rules에서 `match /users/{uid}`는 **users 문서 자체만** 매칭됩니다.  
> `users/{uid}/portfolios/*` 같은 **하위 컬렉션 문서는 별도의 match가 필요**합니다(아래 규칙에 포함).

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 전역 티커 마스터(검색용)
    // - 운영에서는 "쓰기"를 admin/import 스크립트로만 제한하는 것을 권장합니다.
    match /ticker_master/{symbol} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;

      match /chat_sessions/{sid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
        match /messages/{mid} {
          allow read, write: if request.auth != null && request.auth.uid == uid;
        }
      }
      match /insights/{iid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /judge_runs/{rid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /portfolios/{pid} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /ticker_master/{symbol} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

### 4) 저장되는 데이터(현재)

- `users/{uid}`:
  - `email`, `uid`
  - `portfolioText` (마이페이지의 포트폴리오 메모)
  - `createdAt`, `updatedAt`

- `users/{uid}/portfolios/current`:
  - `positions`: [{ symbol, qty, avgPrice, currency, name }]
  - `source`: `"vision_upload"` 등
  - `imagesMeta`: 업로드 파일 메타(파일명/타입/사이즈)
  - `updatedAt`, `createdAt`

- `users/{uid}/ticker_master/{symbol}`:
  - `symbol`
  - `name_en`, `name_ko`
  - `aliases_en[]`, `aliases_ko[]`
  - `prefixes[]` (검색용 prefix 토큰)

- `ticker_master/{symbol}`:
  - (전역) 동일 스키마로 저장 가능. 자동완성은 우선 이 컬렉션을 조회합니다.

## (선택) 전종목 티커 마스터 벌크 적재

데이터 소스: [`rreichel3/US-Stock-Symbols`](https://github.com/rreichel3/US-Stock-Symbols) (NASDAQ/NYSE/AMEX 전체 목록, nightly 업데이트)

### 1) 의존성 설치

```bash
npm install
```

### 2) Firebase Admin 서비스 계정 준비

Firebase Console → Project Settings → Service accounts → “Generate new private key”

아래 중 하나로 환경변수를 설정:

- `FIREBASE_SERVICE_ACCOUNT_PATH`: 다운로드한 json 경로
- 또는 `FIREBASE_SERVICE_ACCOUNT_JSON`: json 내용을 그대로 문자열로

### 3) import 실행

- 영문 티커/이름만 적재(빠름):

```bash
npm run import:ticker_master -- --limit 5000
```

- GPT로 한글명/별칭 보강까지 포함(비용/시간 큼, 천천히 나눠 실행 권장):

```bash
export OPENAI_API_KEY="YOUR_KEY"
npm run import:ticker_master -- --limit 200 --enrich --resume
```

> `--resume`는 진행상황을 `.local/ticker_import_cursor.json`에 저장해서 이어서 실행합니다.

- `users/{uid}/chat_sessions/{sessionId}`:
  - `mode`: `day` | `day_symbol` | `symbol` | `topic`
  - `day`, `symbol`, `topic`, `updatedAt`

- `users/{uid}/chat_sessions/{sessionId}/messages/{msgId}`:
  - `role`: `user` | `assistant`
  - `content`, `clientTs`, `ctx(symbol/interval/view)`

- `users/{uid}/insights/{id}`:
  - Market Insight 생성 결과(생성 시점마다 저장)

- `users/{uid}/judge_runs/{run_id}`:
  - 종합 판단 run 결과 + 당시 RAG 번들(slim)

### 4.5) 채팅 세션 분리/자동 복원

- 세션 모드(마이페이지에서 선택):
  - **하루 기준**: 날짜가 바뀌면 자동으로 새 세션으로 저장
  - **하루+종목 기준(기본)**: 날짜 또는 종목이 바뀌면 자동으로 새 세션
  - **종목 기준**: 종목이 바뀌면 자동으로 새 세션
  - **주제 기준**: “새 세션 시작” 시 주제를 입력해서 새 세션 생성
- 로그인 성공 시, **Firestore에서 updatedAt이 가장 최신인 세션을 자동 복원(1회)** 합니다.

### 5) Analytics(선택)

- 이 프로젝트는 Firebase Web SDK(compat)로 **Analytics를 선택적으로 초기화**합니다.
- `public/firebase-config.js`에 `measurementId`가 있으면 동작할 수 있습니다.
- 환경(광고차단/브라우저 설정/로컬 http)에서 Analytics가 실패할 수 있으므로, 앱 동작에는 영향을 주지 않도록 try/catch 처리되어 있습니다.

## 구현 파일

- `public/index.html`: 2컬럼 UI
- `public/app.js`: TradingView 위젯 재주입 + 오른쪽 패널에서 API 호출
- `server.mjs`: 정적 파일 서빙 + `POST /api/explain` (키 없으면 mock)

## Perplexity 리서치(MVP)

오른쪽의 **리서치(Perplexity)** 섹션에서 질문을 입력하고 실행하면:

- 클라이언트 → `POST /api/research`
- 서버 → Perplexity `POST /chat/completions`
- 결과를 메시지 로그에 출력(+ 가능하면 citations 링크 첨부)



