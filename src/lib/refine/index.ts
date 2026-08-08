/**
 * 청크 파이프라인 공개 진입점.
 *
 * MarkdownRadio 와의 차이: 그쪽 `buildChunks(rawText)` 는 내부에서 remark 정제까지 했지만,
 * PaperRadio 는 **정제(=PDF 추출)를 호출자가 먼저 수행**하고 그 결과 블록을 여기 넘긴다.
 *
 *   MarkdownRadio :  rawText ──refineMarkdown()──▶ CleanBlock[] ──chunkify()──▶ Chunk[]
 *   PaperRadio    :  PDF     ──extractPdf()──────▶ CleanBlock[] ──chunkify()──▶ Chunk[]
 *                                  (호출자)              (여기)
 *
 * 이렇게 나눈 이유: PDF 추출은 비동기(워커)이고 렌더 좌표까지 함께 만들어야 해서
 * 동기 함수인 청크 단계와 생애주기가 다르다.
 */
import type { CleanBlock, Chunk, ChunkOptions } from '../types.ts'
import { DEFAULT_CHUNK_OPTIONS } from '../types.ts'
import { chunkify } from './chunk.ts'
import { assertChunkInvariant, collectChunkInvariantViolations } from './invariant.ts'

// 하위 함수 re-export (UI/테스트가 개별 접근 가능)
export { chunkify } from './chunk.ts'
export type { CleanPiece, CleanBlockEx, EmphasisRange } from './blocks.ts'
export { normalizeForCompare, assertChunkInvariant, collectChunkInvariantViolations } from './invariant.ts'

/**
 * 청크·발음 로직의 버전. chunks 산출에 영향 주는 로직(발음 규칙·청크 분할·운율)을
 * 바꿀 때마다 +1 한다. StoredDocument.refineVersion 과 비교해, 코드가 업데이트되면
 * IndexedDB 에 캐시된 옛 chunks 를 버리고 자동 재생성한다.
 *
 * ⚠️ 이건 `rawText → chunks` 단계만 커버한다. `PDF → rawText` 단계는 별도로
 *    EXTRACT_VERSION(src/lib/pdf/extract.ts)이 관리한다 — 추출 로직이 바뀌면 offset 좌표계
 *    자체가 달라지므로 저장된 북마크까지 무효가 되기 때문이다.
 *
 * 이력: 1 = MarkdownRadio v3 상태(발음 규칙 + 문장 단위 낭독, clauseBreak·emphasisSlowdown OFF)를
 *           그대로 계승하며 PaperRadio 출발.
 */
export const REFINE_VERSION = 1

/**
 * 추출 블록을 청크로 변환하고 offset 불변식을 검증한다.
 * @param blocks 추출기(pdf/extract.ts) 결과 — pieces 를 포함한 CleanBlockEx 권장
 * @param rawText 추출기가 확정한 원문 문자열(offset 좌표계의 기준)
 * @param opts.chunk 청크 옵션(기본 DEFAULT_CHUNK_OPTIONS)
 * @param opts.strict 불변식 위반 처리 방식(기본 false).
 *   - false(프로덕션 기본): throw 하지 않고 console.warn 만 남기고 청크를 그대로 반환.
 *     → 북마크/하이라이트가 일부 어긋나도 앱은 살아남아 듣기가 가능하다(graceful degradation).
 *   - true(개발·테스트): 위반 시 즉시 throw(매핑 회귀 검출용).
 * @throws strict=true 이고 불변식 위반 시 Error(상세 메시지).
 */
export function buildChunks(
  blocks: CleanBlock[],
  rawText: string,
  opts?: { chunk?: ChunkOptions; strict?: boolean },
): { chunks: Chunk[] } {
  const chunkOpts = opts?.chunk ?? DEFAULT_CHUNK_OPTIONS
  const strict = opts?.strict ?? false

  const chunks = chunkify(blocks, chunkOpts)

  if (strict) {
    assertChunkInvariant(chunks, rawText)
  } else {
    const violations = collectChunkInvariantViolations(chunks, rawText)
    if (violations.length > 0) {
      // 콘솔 폭주를 막기 위해 요약 + 앞 3건 상세만.
      console.warn(
        `[paper-radio] 청크 불변식 위반 ${violations.length}건(graceful: 청크는 그대로 사용). ` +
          `북마크/하이라이트가 일부 어긋날 수 있습니다.\n` +
          violations.slice(0, 3).join('\n') +
          (violations.length > 3 ? `\n…외 ${violations.length - 3}건` : ''),
      )
    }
  }

  return { chunks }
}
