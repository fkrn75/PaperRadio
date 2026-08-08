/**
 * offset ↔ 청크/페이지 변환.
 *
 * 정독뷰(원본 페이지)와 재생(문장 청크)을 잇는 다리다. 양쪽 다 rawText 의 문자 offset 을
 * 좌표계로 쓰기 때문에, 이 파일의 함수들만 있으면 두 층이 서로를 몰라도 연결된다.
 */
import type { Chunk, PdfPageRange } from './types.ts'

/**
 * 원문 offset 이 속한 청크 인덱스. 없으면 -1.
 *
 * 청크는 startOffset 오름차순이라 이분 탐색이 가능하다 — 긴 문서(136쪽 = 청크 1,500개)에서
 * 클릭 한 번마다 전체를 훑지 않도록 한다.
 */
export function chunkIndexForOffset(chunks: Chunk[], offset: number): number {
  let lo = 0
  let hi = chunks.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = chunks[mid]
    if (offset < c.startOffset) {
      hi = mid - 1
    } else if (offset >= c.endOffset) {
      lo = mid + 1
    } else {
      // 무음 청크는 위치의 주인이 아니다 → 앞뒤에서 실제 문장을 찾는다.
      if (c.kind !== 'silence') return c.index
      best = mid
      break
    }
  }
  if (best < 0) return -1
  for (let i = best; i < chunks.length; i++) if (chunks[i].kind !== 'silence') return chunks[i].index
  for (let i = best; i >= 0; i--) if (chunks[i].kind !== 'silence') return chunks[i].index
  return -1
}

/** 원문 offset 이 속한 페이지 번호(1-based). 없으면 0. */
export function pageForOffset(ranges: PdfPageRange[], offset: number): number {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (offset < r.start) hi = mid - 1
    else if (offset >= r.end) lo = mid + 1
    else return r.page
  }
  return 0
}

/** 청크가 시작하는 페이지 번호(1-based). 없으면 0. */
export function pageForChunk(ranges: PdfPageRange[], chunks: Chunk[], chunkIndex: number): number {
  const c = chunks[chunkIndex]
  if (!c) return 0
  return pageForOffset(ranges, c.startOffset)
}
