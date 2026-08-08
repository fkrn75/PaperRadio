/**
 * 정제 블록의 내부 구조 — 원문 오프셋을 잃지 않기 위한 "조각(piece)" 계약.
 *
 * MarkdownRadio 에서는 이 타입들이 refine.ts(remark/mdast 정제기) 안에 있었지만,
 * PaperRadio 는 정제기가 PDF 추출기(`src/lib/pdf/extract.ts`)로 바뀌었으므로
 * **파서 중립적인 자리**로 옮겨 둔다. chunk.ts 는 이 계약에만 의존한다.
 *
 * 핵심: 어떤 소스에서 왔든 `pieces` 만 정확하면 chunk.ts 의 문장 분리·offset 매핑·
 * FN-03 불변식이 그대로 성립한다.
 */
import type { CleanBlock } from '../types.ts'

/**
 * 정제된 평문 조각. plain 은 읽을 텍스트이고, srcStart..srcEnd 는 그 텍스트가 유래한
 * "원문(rawText)" 문자 범위(exclusive end)다.
 *
 * 한 문장이 여러 조각으로 쪼개질 때, 청크 단계에서 첫 조각의 srcStart ~ 마지막 조각의
 * srcEnd 로 원문 범위를 복원한다.
 *
 * ⚠️ plain/srcStart/srcEnd 는 이후 단계에서 절대 바꾸지 않는다(오프셋 불변식 무손상).
 *
 * PaperRadio 에서는 **PDF 텍스트 item 하나 = 조각 하나**로 대응한다.
 * getTextContent().items 의 각 item 이 그대로 조각이 되므로, 조각 경계가 곧 item 경계이고
 * 나중에 텍스트 레이어 span 과도 1:1로 이어진다(하이라이트·클릭재생의 토대).
 */
export interface CleanPiece {
  plain: string
  srcStart: number
  srcEnd: number
  /** 강조 유래 표시(마크다운 잔재). PDF 경로에서는 보통 쓰지 않는다. */
  isEmphasis?: 'strong' | 'emphasis'
  /**
   * 이 조각이 유래한 PDF 텍스트 item 의 인덱스(페이지 내 0-based).
   *
   * 정독뷰가 텍스트 레이어 span 에 offset 을 심을 때 **span ↔ 조각**을 잇는 열쇠다.
   * 줄 사이 이음 문자(공백)처럼 item 에서 오지 않은 조각에는 없다.
   */
  itemIndex?: number
}

/**
 * 블록 내 강조 구간(block.text 정제텍스트 char 인덱스 기준).
 * start: inclusive, end: exclusive.
 * ⚠️ 원문 오프셋(srcStart/srcEnd)이 아니다.
 */
export interface EmphasisRange {
  start: number
  end: number
  kind: 'strong' | 'emphasis'
}

/** 확장 블록: CleanBlock + 조각 배열(청크 매핑용). chunkify 가 사용한다. */
export interface CleanBlockEx extends CleanBlock {
  /** 이 블록을 구성하는 평문 조각들(원문 오프셋 보존). text 는 이들의 plain 연결과 동일. */
  pieces: CleanPiece[]
  /**
   * 블록 내 강조 구간 목록(정제텍스트 char 인덱스 기준).
   * chunk.ts 가 문장 교차 계산 후 chunk.rateScale 결정에 사용. 없으면 undefined.
   */
  emphasisRanges?: EmphasisRange[]
}
