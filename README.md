# PaperRadio

**PDF를 원본 그대로 보면서, 온디바이스 TTS로 듣는 웹앱.**

▶ **https://paperradio.pages.dev**

논문·보고서·전자책 PDF를 올리면 조판·표·수식·그림이 살아 있는 원본 페이지를 그대로 보면서
본문을 낭독으로 들을 수 있습니다. 서버로 텍스트를 보내지 않고 **브라우저 안에서** 음성을 만듭니다.

> 마크다운/텍스트를 대상으로 하는 자매 프로젝트 [MarkdownRadio](https://github.com/fkrn75/MarkdownRadio)에서
> 검증된 TTS 엔진과 청크 파이프라인을 가져왔습니다.

## 왜 "원본 그대로"인가

PDF에서 텍스트만 뽑아 다시 흘려보내면(리플로우) 2단 조판이 뒤섞이고 표·수식이 무너집니다.
PaperRadio는 화면을 **pdf.js가 원본 페이지 그대로** 그리므로 어떤 PDF든 정상으로 보이고,
추출 품질은 *듣기에만* 영향을 줍니다. 스캔본조차 읽기(보기)는 완벽합니다.

덤으로 낭독용 텍스트가 화면에 렌더되지 않기 때문에, 머리말 제거·줄 병합 같은 정리를
자유롭게 할 수 있습니다.

## 구조

```
PDF ─┬─▶ 보기 : pdf.js canvas + 텍스트 레이어  ──▶ 원본 페이지 그대로
     │
     └─▶ 읽기 : 텍스트 추출 → rawText(SSOT) ──▶ 문장 청크 → TTS
                        ↕
        텍스트 레이어 span 에 문자 offset 을 심어 두 층을 잇는다
        (재생 위치 하이라이트 · 문장 클릭 재생)
```

좌표계가 셋입니다.

| | |
|---|---|
| ① PDF 내부 | `(page, item index)` — pdf.js가 주는 것 |
| ② **rawText offset** | `[start, end)` — 추출기가 만드는 **단일 진실**. 청크·북마크·하이라이트가 사는 곳 |
| ③ DOM span | `data-start` / `data-end` — 텍스트 레이어 |

②는 원본 PDF 바이트가 아니라 추출기가 조립한 문자열이라, 머리말을 버려도 offset이 어긋나지 않습니다.
대신 **재현성**이 생명입니다 — 같은 PDF + 같은 `EXTRACT_VERSION`이면 언제나 같은 rawText가 나와야
저장된 북마크가 유효합니다.

## 한국어 PDF에서 배운 것

실제 한국어 PDF(34쪽·136쪽)를 뜯어보고 반영한 규칙들입니다.

- **pdf.js의 item 순서는 읽기 순서가 아니다.** 검사한 문서는 꼬리말이 본문보다 먼저 나왔습니다.
  순서대로 이으면 매 쪽 꼬리말이 본문 앞에 낭독됩니다 → 좌표로 재정렬합니다.
- **머리말/꼬리말은 쪽수만큼 반복된다.** 136쪽이면 136번 낭독됩니다 → 위치와 반복 패턴을
  함께 보고 제거합니다.
- **한국어는 낱말 중간에서도 줄바꿈된다.** `"…변화를 해석"` + `"한 뒤"`에 영문 규칙(공백)을 쓰면
  `"해석 한 뒤"`가 됩니다. 줄이 우측 끝까지 찼는지(좌표)로 넘침과 의도적 줄바꿈을 구분합니다.

## 기술 스택

Vite 6 · Svelte 5(runes) · TypeScript · pdf.js · onnxruntime-web(WebGPU) · IndexedDB · PWA

무거운 것들은 전부 지연 로드합니다. pdf.js는 별도 청크로 분리되고 모델은 IndexedDB에 자체
캐시되므로, PWA 첫 설치는 앱 셸(약 270KB)만 받습니다.

## 개발

```bash
npm install
npm run dev          # 개발 서버
npm run check        # 타입 검사
npm run build        # 프로덕션 빌드
```

검증 도구:

```bash
npm run test:extract <pdf경로>        # 추출 → 청크 → offset 불변식(strict) 회귀 검사
node tools/inspect-pdf.mjs <pdf경로>  # 새 PDF의 텍스트 item 구조 진단
node tools/make-sample-pdf.mjs        # 의존성 없는 검증용 PDF 픽스처 생성
```

> 프로덕션은 불변식 위반을 경고만 하고 넘어갑니다(앱을 죽이지 않기 위해). 회귀는
> `test:extract`가 `strict` 모드로 잡습니다.

## 문서

| | |
|---|---|
| [기능명세](docs/functional-spec.md) | 구현된 동작과 그 근거. 실측으로 잡은 함정 목록 포함 |
| [배포](docs/deploy-cloudflare.md) | Cloudflare Pages 설정·절차 |
| [엔진 동기화](docs/SYNC-from-markdownradio.md) | MarkdownRadio 에서 가져온 파일과 갱신 기준 |

## 진행 상황

- [x] PDF 입력 → 텍스트 추출 → 문장 청크 → **재생**
- [x] 원본 페이지 렌더 + 페이지 가상화
- [x] 정독뷰 폐루프 — 재생 위치 하이라이트 · 문장 클릭/더블클릭 재생
- [x] 재생 컨트롤(재생·한 문서 반복·구간 반복) + 북마크 목록·점프
- [x] 페이지 넘김 모드 + 재생 따라가기 토글
- [x] 스캔본 "보기 전용" 처리
- [x] 논문 2단 조판 컬럼 분리 — 좌단 전체 → 우단 전체 순으로 읽는다
- [ ] 스캔본 OCR

## 라이선스

개인 프로젝트입니다.
