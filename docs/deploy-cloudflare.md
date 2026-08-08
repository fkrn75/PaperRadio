# 배포 — Cloudflare Pages

리포: https://github.com/fkrn75/PaperRadio (public, `main`)

정적 SPA 라 빌드 산출물(`dist`)만 올리면 된다. `main` 에 push 하면 자동 배포되도록 GitHub 연동을 쓴다.

## 빌드 설정값

Cloudflare Pages 프로젝트 생성 시 입력할 값:

| 항목 | 값 |
|---|---|
| Production branch | `main` |
| Framework preset | `Vite` (없으면 `None`) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` |
| 환경변수 | `NODE_VERSION` = `20` |

> `.nvmrc`(20)를 두었으므로 대부분 환경변수 없이도 잡히지만, 빌드가 Node 버전으로 실패하면
> 위 환경변수를 명시한다.

## 연결 절차 (대시보드)

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. GitHub 계정(`fkrn75`) 인증 → 리포 **`PaperRadio`** 선택
3. 위 빌드 설정값 입력 → **Save and Deploy**
4. 배포되면 `https://paperradio.pages.dev` 형태의 URL 이 나온다
5. 이후 `main` 에 push 할 때마다 자동 빌드·배포

> Wrangler CLI(`npx wrangler pages deploy dist`)로도 올릴 수 있지만 브라우저 OAuth 가 필요해
> 자동화 환경에서는 쓰기 어렵다. GitHub 연동이 실질적으로 유일한 무인 경로다.

## ⚠️ 반드시 확인할 것

### 1. COOP/COEP 헤더 (`public/_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
```

**지우면 안 된다.** onnxruntime-web 의 멀티스레드 WASM 은 SharedArrayBuffer 를 쓰는데,
교차출처 격리가 없으면 SAB 가 비활성화되어 추론이 **빈 버퍼(무음)** 를 낸다(안드로이드 실측).
`credentialless` 를 쓰는 이유는 HuggingFace 등 cross-origin 모델 리소스를 CORP 헤더 없이도
받기 위해서다.

배포 후 브라우저 콘솔에서 확인:

```js
crossOriginIsolated // true 여야 한다
```

### 2. 자동 배포가 멈추는 함정

push 했는데 배포본이 그대로라면, GitHub App **"Cloudflare Workers and Pages"** 의
Repository access 에 이 리포가 빠져 있을 가능성이 높다(자매 프로젝트에서 실제로 겪었다).
GitHub → Settings → Applications → Cloudflare Workers and Pages → Repository access 에
`PaperRadio` 를 추가한다.

확인 방법 — 배포본을 직접 찍어 본다:

```bash
curl -sI https://paperradio.pages.dev | head -5
```

### 3. PWA 캐시 때문에 옛 화면이 보일 때

Service Worker 가 앱 셸을 캐시하므로 새 배포가 즉시 반영되지 않을 수 있다.
- 확인은 **시크릿 창**에서 (SW 가 없어 항상 새 빌드를 받는다)
- 평소 탭은 새로고침 2~3회 또는 사이트 데이터 삭제

## 캐시 정책 (vite.config.ts)

precache 는 앱 셸(약 290KB)만 담는다. 다음은 의도적으로 제외한다:

- `**/*.{onnx,bin,wasm,mjs,data}` — TTS 모델 가중치(수백 MB). `modelCache.ts` 가 IndexedDB 로
  자체 캐시하므로 SW 가 손대면 중복 저장·용량 폭증이 일어난다.
- `**/pdf-*.js` — pdf.js 청크(433KB). PDF 를 열 때만 동적 로드되므로 첫 설치를 가볍게 유지한다.

## 남은 일

- [ ] 아이콘 교체 — 현재 `public/icons/*` 는 자매 프로젝트(MarkdownRadio)의 것을 그대로 쓰고 있다.
      PaperRadio 전용 아이콘을 만들어 바꿀 것.
