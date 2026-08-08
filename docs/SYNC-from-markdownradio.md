# MarkdownRadio 동기화 대상 파일

PaperRadio 는 **MarkdownRadio** 에서 검증된 TTS 엔진·청크 파이프라인을 **복사**해 출발했다.
모노레포/공유 패키지 대신 복사를 택한 이유는 배포(Cloudflare Pages)·빌드 설정을 단순하게 유지하기
위해서다. 대신 **어떤 파일이 남의 집에서 왔고, 어느 시점 것인지**를 여기에 기록해 갈라짐을 막는다.

## 복사 기준점

| 항목 | 값 |
|---|---|
| 원본 저장소 | `C:\Users\hong\MarkdownRadio` (github.com/fkrn75/MarkdownRadio) |
| 복사 시점 커밋 | `e6f7559` — "합성 직렬화로 동시 GPU 추론 hang 근본 차단(빠른 seek 무음 수정)" |
| 복사 일자 | 2026-08-08 |

## 동기화 대상 (원본이 바뀌면 이쪽도 확인할 것)

### 🔴 최우선 — 모바일 실기에서 비싸게 얻은 자산
원본에서 이 파일들이 바뀌면 **거의 항상 이쪽도 가져와야 한다**. 모바일 GPU 관련 수정이 특히 그렇다.

- `src/lib/engine/supertonic.worker.ts` — 합성 직렬화(`synthChain`)로 동시 GPU 추론 hang 차단
- `src/lib/engine/supertonicEngine.ts` — 합성 hang 자동복구(webgpu 워커 재생성 + 30s 타임아웃 가드)
- `src/lib/engine/supertonicProtocol.ts` — 워커 프로토콜
- `src/lib/engine/platform.ts` — 모바일 판정(고품질 step 8 상한)
- `src/lib/engine/modelCache.ts` — 모델 IndexedDB 캐시
- `src/lib/engine/webSpeechEngine.ts` · `index.ts`

> 알려진 하자와 처방은 MarkdownRadio 쪽 이력 참고:
> `c470d1a`(step 8 상한) → `e6f7559`(합성 직렬화) → `29ddcde`(자동복구).
> **모바일 GPU 는 두 합성을 동시에 못 돌린다** — 합성은 항상 1개씩.

### 🟡 청크·불변식·발음 규칙
로직 변경이 드물지만, 발음 규칙 개선은 양쪽에 반영할 가치가 있다.

- `src/lib/refine/chunk.ts` — 문장 분리 + 원문 offset 매핑
- `src/lib/refine/invariant.ts` — FN-03 offset 불변식 검사
- `src/lib/refine/speak*.ts` — 숫자·날짜·단위 읽기 변환
- `src/lib/types.ts` — 공통 계약(단, PaperRadio 는 PDF 필드가 추가돼 **분기됨**)

### ⚪ 참고만 (이쪽에서 독자 진화)
- `src/lib/db/idb.ts` — 스키마가 PDF 쪽으로 갈라짐
- `src/lib/stores/*` · `src/lib/debug/*` · `src/app.css`

## 의도적으로 가져오지 않은 것

| 파일 | 이유 |
|---|---|
| `src/lib/refine/refine.ts` | **마크다운(remark/mdast) 전용**. PaperRadio 는 이 자리를 `src/lib/pdf/extract.ts` 가 대신한다 |
| `src/lib/markdown.ts` · `MarkdownNode.svelte` | 마크다운 렌더 전용 |
| `mermaid` 의존성 (3.1MB) | 도식 렌더 — PDF 는 원본 canvas 로 그리므로 불필요 |
| `remark-parse` · `remark-gfm` · `unified` | 위와 동일 |

## 핵심 설계 대응

MarkdownRadio 의 파이프라인에서 **첫 단계만 갈아끼운 구조**다:

```
MarkdownRadio :  rawText ──refineMarkdown()──▶ CleanBlock[] ──chunkify()──▶ Chunk[]
PaperRadio    :  PDF     ──extractPdf()──────▶ CleanBlock[] ──chunkify()──▶ Chunk[]
                                                    ▲
                                    CleanPiece {plain, srcStart, srcEnd} 가
                                    PDF 텍스트 item 과 1:1 대응한다
```

그래서 `chunkify` 이하(문장 분리·offset 매핑·불변식·발음)는 **무수정 재사용**이다.
