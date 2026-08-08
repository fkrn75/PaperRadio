/**
 * FN-03 불변식(MUST · 강제)
 *
 * 모든 kind==='speech' 청크에 대해:
 *   normalizeForCompare(rawText.slice(c.startOffset, c.endOffset)) === normalizeForCompare(c.text)
 *
 * 의미: 정제로 마커가 빠지므로 slice 와 text 의 엄격 동치는 불가능 → 마커·공백을 제거한
 * 정규화 후 비교한다. 진짜 중요한 건 (startOffset, endOffset) 쌍이 "그 문장이 원문에서
 * 차지하는 실제 범위"를 정확히 가리키는 것 — 북마크 점프·하이라이트의 정확성이 여기 달려있다.
 *
 * kind==='silence'(text==='')는 검사 대상에서 제외.
 */
import type { Chunk } from '../types.ts'

/**
 * 비교용 정규화: 마크다운 마커(#, *, _, ~, `, >, - 등)·링크/이미지 구문·연속 공백/개행을
 * 제거하고 trim 한다. 두 텍스트가 "같은 내용"인지 판정하는 데만 쓴다.
 */
export function normalizeForCompare(s: string): string {
  let t = s
  // 이미지 구문 → alt 텍스트만 남김: ![alt](url) → alt
  //  - readImageAlt 모드는 alt 를 읽으므로 양쪽(원문 slice·정제 text)에 alt 가 있어 일치.
  //  - 기본 모드(이미지 제거)는 청크가 "버려진 이미지 자리(gap)"를 가로지르지 않도록
  //    chunk.ts 가 그 지점에서 청크를 쪼개므로, slice 에 ![ ] 구문 자체가 들어오지 않는다.
  t = t.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
  // 링크 구문 → 표시 텍스트만: [text](url) → text, 참조형 [text][id] → text
  //  ⚠️ url 에 균형 괄호 1쌍 허용: javascript:alert(1)·위키 URL …_(bar) 등. [^)]* 면 첫 ) 에서
  //     끊겨 바깥 ) 가 남아 오탐(graceful 위반) 발생 → (?:[^()]|\([^()]*\))* 로 1단계 중첩 흡수.
  t = t.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
  // 각주 참조 제거
  t = t.replace(/\[\^[^\]]+\]/g, '')
  // 원문 bare URL 제거(autolink 는 정제에서 "링크"로 치환되므로, 양쪽에서 URL 을 지워 맞춘다)
  t = t.replace(/\bhttps?:\/\/[^\s)]+/gi, '')
  t = t.replace(/\bwww\.[^\s)]+/gi, '')
  t = t.replace(/\bmailto:[^\s)]+/gi, '')
  // HTML 태그 제거
  t = t.replace(/<[^>]*>/g, '')
  // autolink 치환어 "링크" 제거(대칭: text 엔 "링크"가, 원문엔 URL 이 있었음 → 둘 다 사라져 일치).
  //  실제 본문에 "링크"라는 낱말이 있어도 양쪽에 똑같이 있으므로 제거해도 비교는 안전.
  t = t.replace(/링크/g, '')
  // 마크다운 이스케이프 백슬래시 제거: `\*` `\_` `\[` `\.` 등 특수문자 앞의 백슬래시만 떼고 문자는 보존.
  //  사유: remark 는 이스케이프된 문자를 백슬래시를 "뺀" 평문으로 만들지만(정제 text=`*`),
  //  원문 slice 엔 `\*` 가 그대로라 백슬래시 때문에 어긋난다. 양쪽 대칭 정규화로 맞춘다.
  //  ⚠️ 일반 백슬래시(경로 C:\Users 등)는 보존 — CommonMark 이스케이프 대상(ASCII 구두점) 앞의 것만.
  t = t.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
  // 꺾쇠 제거: 오토링크 `<https://...>` 의 `<` `>` 가 정제 text("링크")엔 없어 어긋나므로 대칭 제거.
  //  (HTML 태그는 위에서 이미 제거했고, 남은 단독 꺾쇠만 정리.)
  t = t.replace(/[<>]/g, '')
  // 마크다운 마커 문자 제거: # * _ ~ ` > |
  t = t.replace(/[#*_~`>|]/g, '')
  // 표 셀 나열에서 정제가 끼워넣는 구분 쉼표(원문엔 | 였음). 본문 쉼표도 양쪽에 동일하므로 제거 안전.
  t = t.replace(/[,，、]/g, '')
  // 줄머리 리스트/구분선 마커 흔적 제거(토큰 단위로 보수적으로)
  t = t.replace(/(^|\s)[-+]\s+/g, '$1') // "- 항목" / "+ 항목"
  t = t.replace(/(^|\s)\d+\.\s+/g, '$1') // "1. 항목"
  t = t.replace(/-{3,}/g, '') // --- 구분선
  // 이모지 제거(정제 텍스트엔 없지만 원문 slice 엔 있을 수 있어 대칭화)
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu,
    '',
  )
  // 모든 공백류(스페이스·탭·개행) 제거(공백 위치 차이는 의미 없음)
  t = t.replace(/\s+/g, '')
  return t.trim()
}

/**
 * 청크 배열의 불변식 위반 목록을 수집한다(throw 하지 않음).
 * assertChunkInvariant(엄격·throw)와 buildChunks 의 graceful 경고가 공유하는 단일 검사 로직.
 * @returns 위반 메시지 배열(빈 배열이면 통과)
 */
export function collectChunkInvariantViolations(chunks: Chunk[], rawText: string): string[] {
  const errors: string[] = []
  let prevSpeechIndex = -1

  for (const c of chunks) {
    // index 연속성(speech/silence 포함 전체가 0..n-1 연속이어야 함)
    // (여기선 speech 불변식이 주목적이므로 index 는 경고성으로만 검사)
    // annotation(다이어그램 등): text 는 원문이 아닌 안내문이라 동치 검사 제외.
    //   offset 은 원문의 도표/표 범위를 가리키므로 유효성만 가볍게 본다.
    if (c.kind === 'annotation') {
      if (
        typeof c.startOffset !== 'number' ||
        typeof c.endOffset !== 'number' ||
        c.startOffset < 0 ||
        c.endOffset > rawText.length ||
        c.endOffset < c.startOffset
      ) {
        errors.push(`[index ${c.index}] annotation 오프셋 범위 불량: [${c.startOffset}, ${c.endOffset}]`)
      }
      continue
    }
    if (c.kind === 'silence') {
      if (c.text !== '') {
        errors.push(`[index ${c.index}] silence 청크인데 text 가 비어있지 않음: ${JSON.stringify(c.text)}`)
      }
      continue
    }

    // 1) 오프셋 범위 유효성
    if (
      typeof c.startOffset !== 'number' ||
      typeof c.endOffset !== 'number' ||
      c.startOffset < 0 ||
      c.endOffset > rawText.length ||
      c.endOffset < c.startOffset
    ) {
      errors.push(
        `[index ${c.index}] 오프셋 범위 불량: [${c.startOffset}, ${c.endOffset}] (rawText 길이 ${rawText.length}) text=${JSON.stringify(
          c.text.slice(0, 30),
        )}`,
      )
      continue
    }

    // 2) 핵심 동치: 정규화 후 slice === text
    const sliced = rawText.slice(c.startOffset, c.endOffset)
    const a = normalizeForCompare(sliced)
    const b = normalizeForCompare(c.text)
    if (a !== b) {
      errors.push(
        `[index ${c.index}] 불변식 위반:\n` +
          `   slice([${c.startOffset},${c.endOffset}]) = ${JSON.stringify(sliced)}\n` +
          `   → normalize = ${JSON.stringify(a)}\n` +
          `   text                = ${JSON.stringify(c.text)}\n` +
          `   → normalize = ${JSON.stringify(b)}`,
      )
    }

    // 3) speech 끼리 원문 순서가 단조 증가하는지(겹침/역행은 매핑 오류 신호) — 경고성
    if (c.startOffset < prevSpeechIndex) {
      errors.push(
        `[index ${c.index}] speech startOffset(${c.startOffset}) 이 이전 endOffset(${prevSpeechIndex}) 보다 앞섬(겹침/역행 의심)`,
      )
    }
    prevSpeechIndex = c.endOffset
  }

  return errors
}

/**
 * 청크 배열의 불변식을 검사한다. 위반 시 상세 메시지와 함께 throw.
 * (개발·테스트용 엄격 검사 진입점. 프로덕션 graceful 경로는 collectChunkInvariantViolations 를 직접 쓴다.)
 * @param chunks chunkify 결과
 * @param rawText 원문
 */
export function assertChunkInvariant(chunks: Chunk[], rawText: string): void {
  const errors = collectChunkInvariantViolations(chunks, rawText)
  if (errors.length > 0) {
    throw new Error(
      `청크 불변식 위반 ${errors.length}건 (FN-03):\n\n` + errors.join('\n\n') + '\n',
    )
  }
}
