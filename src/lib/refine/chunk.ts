/**
 * FN-03 · 문장 청크 분할
 *
 * 정제 블록을 재생·합성·북마크의 최소 단위인 청크로 나눈다.
 * 핵심 불변식(MUST): 모든 speech 청크에 대해
 *   normalizeForCompare(rawText.slice(c.startOffset, c.endOffset)) === normalizeForCompare(c.text)
 *
 * 매핑 전략:
 *  정제 블록의 "조각(pieces)"으로 [정제텍스트 char 위치 → 원문 offset] 맵을 만든다.
 *  block.text 를 Intl.Segmenter('ko','sentence')로 문장 분리한 뒤,
 *  각 문장의 [cleanStart, cleanEnd) 를 맵으로 되짚어 원문 [srcStart, srcEnd) 를 복원한다.
 *  (한 문장이 여러 조각에 걸치면 첫 조각 start ~ 마지막 조각 end 로 잡힘 → 불변식 성립)
 */
import type { CleanBlock, Chunk, ChunkOptions } from '../types.ts'
import { DEFAULT_CHUNK_OPTIONS } from '../types.ts'
import type { CleanBlockEx, CleanPiece } from './blocks.ts'
import { toSpoken } from './speak.ts'

// ─────────────────────────────────────────────────────────────
// 조각 확보 (CleanBlockEx 면 그대로, 아니면 블록 전체를 단일 조각으로)
// ─────────────────────────────────────────────────────────────

function hasPieces(b: CleanBlock): b is CleanBlockEx {
  return Array.isArray((b as CleanBlockEx).pieces) && (b as CleanBlockEx).pieces.length > 0
}

/**
 * blocks 가 plain CleanBlock[](pieces 없음)일 때 단일 조각으로 보강한다.
 *
 * PaperRadio 에서 정상 경로는 PDF 추출기가 **항상 item 단위 pieces 를 채워 넘기는** 것이라
 * 이 폴백은 거의 타지 않는다. 폴백을 타면 조각이 블록 하나뿐이라 블록 내부가 선형 보간되어
 * 하이라이트 정밀도가 문단 단위로 떨어진다(불변식은 정규화 비교라 여전히 성립).
 *
 * ⚠️ MarkdownRadio 는 여기서 rawText 를 remark 로 재정제해 조각을 복원했지만, PaperRadio 의
 *    rawText 는 마크다운이 아니므로 그 경로를 의도적으로 들어냈다.
 */
function ensurePieces(blocks: CleanBlock[]): CleanBlockEx[] {
  if (blocks.every(hasPieces)) return blocks as CleanBlockEx[]
  return blocks.map((b) => {
    if (hasPieces(b)) return b
    return {
      ...b,
      pieces: [{ plain: b.text, srcStart: b.startOffset, srcEnd: b.endOffset }],
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 정제텍스트 char → 원문 offset 매핑
// ─────────────────────────────────────────────────────────────

/**
 * 블록의 조각들로부터 정제텍스트 각 문자 위치에 대응하는 원문 offset 배열을 만든다.
 * startMap[i] = 정제텍스트 i번째 문자의 원문 시작 offset
 * endMap[i]   = 정제텍스트 i번째 문자의 원문 끝 offset(exclusive)
 * 한 조각 내부에서는 plain 길이에 맞춰 [srcStart..srcEnd] 를 선형 보간한다.
 */
interface OffsetMap {
  text: string
  startMap: number[] // 길이 = text.length, i번째 문자의 원문 시작 offset
  endMap: number[] // 길이 = text.length, i번째 문자의 원문 끝 offset(exclusive)
  /**
   * gapBefore[i] = 정제텍스트 (i-1)번째와 i번째 문자 "사이"에 원문에서 버려진(정제가 제거한)
   * 내용의 길이. 단순 공백 한두 칸이 아니라 이미지/각주/URL 등 실제 내용이 빠진 자리를 뜻한다.
   * 한 청크가 이 큰 gap 을 가로지르면, 그 청크의 slice 는 버려진 내용을 포함하게 되어
   * 불변식(정규화 비교)이 깨질 수 있으므로 청크를 그 지점에서 쪼갠다.
   */
  gapBefore: number[] // 길이 = text.length
}

function buildOffsetMap(pieces: CleanPiece[]): OffsetMap {
  let text = ''
  const startMap: number[] = []
  const endMap: number[] = []
  const gapBefore: number[] = []
  let prevSrcEnd: number | null = null
  for (const p of pieces) {
    const n = p.plain.length
    if (n === 0) continue
    const span = p.srcEnd - p.srcStart
    for (let i = 0; i < n; i++) {
      // 조각 내 i번째 문자의 원문 위치를 선형 보간(정수).
      const s = p.srcStart + Math.floor((span * i) / n)
      const e = p.srcStart + Math.floor((span * (i + 1)) / n)
      startMap.push(s)
      endMap.push(Math.max(e, s)) // 최소 s 보장
      // 조각의 첫 문자 앞에는, 직전 조각 끝~이번 조각 시작 사이의 원문 gap 이 존재할 수 있다.
      if (i === 0) {
        const gap = prevSrcEnd == null ? 0 : Math.max(0, p.srcStart - prevSrcEnd)
        gapBefore.push(gap)
      } else {
        gapBefore.push(0)
      }
    }
    text += p.plain
    prevSrcEnd = p.srcEnd
  }
  return { text, startMap, endMap, gapBefore }
}

/**
 * gap 임계값: 이보다 큰 원문 gap 은 "버려진 실제 내용"으로 보고 청크 경계로 삼는다.
 * 공백 1~2칸(마커 제거로 생기는 좁은 틈)은 무시한다.
 */
const GAP_BREAK_THRESHOLD = 3

/**
 * 짧은 청크 병합 허용 최대 gap(원문 문자수). 이보다 사이가 벌어지면(=버려진/건너뛴 내용이
 * 끼면) 병합하지 않는다. 같은/이웃 문단의 좁은 틈(문장 사이 ". ", 문단 사이 "\n\n",
 * 리스트마커 "- "/"1. ", 인용마커 "> " 정도)만 허용하고, 코드블록·표·구분선처럼
 * 정규화로 환원되지 않는 큰 덩어리(또는 그 펜스/구분 문자)는 막아 불변식을 지킨다.
 */
const MERGE_MAX_GAP = 3

/**
 * 문장 [start,end) 를, 내부에 큰 원문 gap 이 있으면 그 지점에서 더 잘게 쪼갠다.
 * (예: 기본 모드에서 문장 중간 이미지가 제거되어 생긴 자리)
 */
function splitAtGaps(
  start: number,
  end: number,
  gapBefore: number[],
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let segStart = start
  for (let i = start + 1; i < end; i++) {
    if (gapBefore[i] >= GAP_BREAK_THRESHOLD) {
      out.push({ start: segStart, end: i })
      segStart = i
    }
  }
  out.push({ start: segStart, end })
  return out
}

// ─────────────────────────────────────────────────────────────
// 문장 분리 + 길이 보정
// ─────────────────────────────────────────────────────────────

let _segmenter: Intl.Segmenter | null = null
function getSegmenter(): Intl.Segmenter | null {
  if (_segmenter) return _segmenter
  // 일부 환경에 Intl.Segmenter 가 없을 수 있으니 가드.
  const IntlAny = Intl as unknown as { Segmenter?: typeof Intl.Segmenter }
  if (typeof IntlAny.Segmenter !== 'function') return null
  _segmenter = new IntlAny.Segmenter('ko', { granularity: 'sentence' })
  return _segmenter
}

/** 정제텍스트를 문장 경계 [start,end) 들로 분리. Segmenter 없으면 정규식 폴백. */
function segmentSentences(text: string): Array<{ start: number; end: number }> {
  const seg = getSegmenter()
  const out: Array<{ start: number; end: number }> = []
  if (seg) {
    for (const s of seg.segment(text)) {
      const start = s.index
      const end = s.index + s.segment.length
      if (end > start) out.push({ start, end })
    }
    return out
  }
  // 폴백: 종결부호(.!?。…) + 공백 기준. 약어 보호는 best-effort 불가.
  const re = /[^.!?。…\n]*[.!?。…]+[)\]"'」』]*\s*|[^.!?。…\n]+$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (end > start) out.push({ start, end })
    if (m.index === re.lastIndex) re.lastIndex++ // 무한루프 가드
  }
  if (out.length === 0 && text.length > 0) out.push({ start: 0, end: text.length })
  return out
}

/**
 * maxChars 초과 문장을 쉼표/접속사/공백에서 강제 분할.
 * 사유: 합성 지연·메모리 + Chrome speechSynthesis 15초 침묵 버그(긴 발화 중단) 회피.
 * 반환: 원래 [start,end) 를 더 작은 [start,end) 들로 쪼갠 배열.
 */
function splitLong(
  text: string,
  start: number,
  end: number,
  maxChars: number,
): Array<{ start: number; end: number }> {
  if (end - start <= maxChars) return [{ start, end }]
  const out: Array<{ start: number; end: number }> = []
  let cur = start
  while (end - cur > maxChars) {
    const window = text.slice(cur, cur + maxChars)
    // 분할 우선순위: 쉼표류 > 접속사 앞 공백 > 마지막 공백 > 하드 컷
    let cut = findLastBreak(window)
    if (cut <= 0) cut = maxChars // 마땅한 분할점 없으면 하드 컷
    const abs = cur + cut
    out.push({ start: cur, end: abs })
    cur = abs
  }
  if (cur < end) out.push({ start: cur, end })
  return out
}

/** 윈도우 문자열 안에서 가장 뒤쪽의 자연스러운 분할 지점(상대 인덱스, exclusive)을 찾는다. */
function findLastBreak(window: string): number {
  // 쉼표·중점·세미콜론 등 뒤(그 다음 위치까지 포함)
  const punct = /[,，、;；·]/g
  let last = -1
  let m: RegExpExecArray | null
  while ((m = punct.exec(window)) !== null) last = m.index + 1
  if (last > 0) {
    // 분할점 뒤 공백은 다음 청크 앞에 두지 않도록 흡수
    let p = last
    while (p < window.length && window[p] === ' ') p++
    return p
  }
  // 한국어 접속사 앞 공백
  const conj = /\s(그리고|그러나|하지만|또는|그래서|그러므로|따라서|그런데|또한|즉)\b/g
  last = -1
  while ((m = conj.exec(window)) !== null) last = m.index // 접속사 앞 공백 위치에서 끊음
  if (last > 0) return last + 1 // 공백 다음(접속사부터 다음 청크)
  // 마지막 공백
  const lastSpace = window.lastIndexOf(' ')
  if (lastSpace > 0) return lastSpace + 1
  return -1
}

// ─────────────────────────────────────────────────────────────
// (A) 의미 단위 절 분할 (clauseBreak)
// ─────────────────────────────────────────────────────────────

/**
 * 과분할 방지 임계: 분할로 생기는 양쪽 조각이 모두 이 값 이상이어야 경계를 인정한다.
 */
const MIN_CLAUSE_CHARS = 8

/**
 * 접속부사 직전 분할 패턴.
 * ⚠️ 형태소 분석 없이 안전한 경계만 — 연결어미(~고/~며/~서/~면)·주어부(~은/는/이/가) 분할은
 * 오탐("학교"의 '고', "서울"의 '서', "면접"의 '면') 위험이 있으므로 이번엔 적용하지 않는다.
 * TODO(형태소 분석 도입 시): 연결어미·주어부 경계 분할 추가.
 */
const CLAUSE_CONJ_RE =
  /(?<=[^\s])\s+(그리고|그러나|하지만|그런데|또한|따라서|그래서|그러므로|즉|또는|및)(?=[\s가-힣])/g

/**
 * 문장 [start, end) 를 쉼표류 및 접속부사 앞에서 추가 분할한다.
 * - 쉼표(, ， 、)는 앞 절 끝에 포함: "예를 들어, 이것은" → "예를 들어," + "이것은"
 * - 접속부사 직전 공백 위치에서 분할: "A 그리고 B" → "A" + "그리고 B"
 * - 과분할 방지: 양쪽 조각이 모두 MIN_CLAUSE_CHARS 이상일 때만 분할 유효.
 * 반환 값은 원문 절대 인덱스(start~end 범위) 기준.
 */
function splitClauses(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const segment = text.slice(start, end)
  const cuts: number[] = [] // segment 내 상대 인덱스

  // ① 쉼표류 직후 분할 — 쉼표는 앞 절에 포함.
  const punctRe = /[,，、]/g
  let pm: RegExpExecArray | null
  while ((pm = punctRe.exec(segment)) !== null) {
    const afterPunct = pm.index + 1
    // 쉼표 직후 공백은 다음 절 앞에 두지 않도록 건너뛴다.
    let skipWs = afterPunct
    while (skipWs < segment.length && segment[skipWs] === ' ') skipWs++
    if (skipWs < segment.length) cuts.push(skipWs)
  }

  // ② 접속부사 직전 분할.
  CLAUSE_CONJ_RE.lastIndex = 0
  let cm: RegExpExecArray | null
  while ((cm = CLAUSE_CONJ_RE.exec(segment)) !== null) {
    // cm.index 는 공백 직전(앞 절 마지막 글자 다음). 공백을 포함해 앞 절에서 끊는다.
    if (cm.index > 0) cuts.push(cm.index)
  }

  if (cuts.length === 0) return [{ start, end }]

  // 중복 제거 + 오름차순 정렬.
  const sortedCuts = [...new Set(cuts)].sort((a, b) => a - b)

  // 과분할 방지: 각 경계에서 누적 prevCut 기준 왼쪽 조각 + 오른쪽 조각(끝까지) 길이 확인.
  const validCuts: number[] = []
  let prevCut = 0
  for (const cut of sortedCuts) {
    const leftLen = cut - prevCut
    const rightLen = segment.length - cut
    if (leftLen >= MIN_CLAUSE_CHARS && rightLen >= MIN_CLAUSE_CHARS) {
      validCuts.push(cut)
      prevCut = cut
    }
  }

  if (validCuts.length === 0) return [{ start, end }]

  // 유효한 컷으로 조각 생성 (원문 절대 인덱스로 변환).
  const out: Array<{ start: number; end: number }> = []
  let cur = start
  for (const cut of validCuts) {
    const absEnd = start + cut
    if (absEnd > cur) out.push({ start: cur, end: absEnd })
    cur = absEnd
  }
  if (cur < end) out.push({ start: cur, end })
  return out
}

// ─────────────────────────────────────────────────────────────
// (B) 강조 구간 분리 (emphasisSlowdown)
// ─────────────────────────────────────────────────────────────

/** splitByEmphasis 의 서브 세그먼트 반환 타입 */
interface SubSeg {
  start: number // 정제텍스트 char 인덱스 (cleanStart~cleanEnd 범위 내)
  end: number
  rateScale?: number // 있으면 강조 청크(속도 배율)
}

/**
 * 문장 구간 [cleanStart, cleanEnd) 를 block.emphasisRanges 와 교차해
 * 강조 구간을 독립 서브 세그먼트로 분리한다.
 *
 * 원문 offset 불변식 유지:
 *   각 SubSeg 의 text = cleanText.slice(sub.start, sub.end) 이고,
 *   startOffset/endOffset 은 startMap/endMap 으로 복원.
 *   강조 마커(**)는 정제 단계에서 이미 piece gap 으로 처리되었으므로
 *   offset 이 원문 마커 범위를 자연히 포함 → 정규화 비교 불변식 통과.
 */
function splitByEmphasis(
  cleanStart: number,
  cleanEnd: number,
  emphasisRanges: Array<{ start: number; end: number; kind: 'strong' | 'emphasis' }>,
  emphasisRate: number,
): SubSeg[] {
  // 현재 구간과 교차하는 강조 범위만 필터. start 오름차순은 refiner 보장이지만 방어적 정렬.
  const overlapping = emphasisRanges
    .filter((r) => r.end > cleanStart && r.start < cleanEnd)
    .sort((a, b) => a.start - b.start)

  if (overlapping.length === 0) return [{ start: cleanStart, end: cleanEnd }]

  const out: SubSeg[] = []
  let cur = cleanStart

  for (const r of overlapping) {
    const emphStart = Math.max(r.start, cleanStart)
    const emphEnd = Math.min(r.end, cleanEnd)

    // 강조 앞 일반 구간
    if (emphStart > cur) {
      out.push({ start: cur, end: emphStart })
    }
    // 강조 구간: strong=0.8, emphasis=emphasisRate(기본 0.85)
    if (emphEnd > emphStart) {
      const scale = r.kind === 'strong' ? 0.8 : emphasisRate
      out.push({ start: emphStart, end: emphEnd, rateScale: scale })
    }
    cur = emphEnd
  }

  // 마지막 강조 뒤 일반 구간
  if (cur < cleanEnd) {
    out.push({ start: cur, end: cleanEnd })
  }

  return out
}

// ─────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────

/**
 * 정제 블록 배열을 청크 배열로 변환한다.
 * @param blocks 추출기 결과(CleanBlockEx 권장 — pieces 포함 시 조각 단위로 정밀 매핑)
 */
export function chunkify(blocks: CleanBlock[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const exBlocks = ensurePieces(blocks)

  // 1) 블록별로 문장 → (원문 범위, 텍스트) 후보를 만든다. 무음 마커도 자리표시.
  type Cand =
    | {
        kind: 'speech'
        text: string
        startOffset: number
        endOffset: number
        isHeading: boolean
        spokenText?: string
        rateScale?: number // 강조 청크 속도 배율 (emphasisSlowdown)
        isClauseBound?: boolean // 절 분할로 생성된 청크 — 병합 금지 마커
        isEmphasis?: boolean // 강조 청크 — 병합 금지 마커
      }
    | { kind: 'silence' }
    | { kind: 'annotation'; text: string; spokenText: string; startOffset: number; endOffset: number }

  const cands: Cand[] = []

  for (const block of exBlocks) {
    // 다이어그램 등 annotation 블록: 문장 분리 없이 통째로 annotation 후보.
    if (block.isAnnotation) {
      cands.push({
        kind: 'annotation',
        text: block.text,
        spokenText: block.spokenText ?? block.text,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      })
      continue
    }
    // 표 header 행 등 spokenText 가 지정된 블록: 문장 분리 없이 1 speech 청크로(헤더 결합 발음 보존).
    if (block.spokenText !== undefined) {
      cands.push({
        kind: 'speech',
        text: block.text,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        isHeading: block.isHeading,
        spokenText: block.spokenText,
      })
      continue
    }
    const map = buildOffsetMap(block.pieces)
    const cleanText = map.text
    if (cleanText.trim() === '') {
      continue
    }

    // emphasisRanges: refiner 가 채운 정제텍스트 char 인덱스 기준 강조 구간.
    const emphasisRanges =
      opts.emphasisSlowdown && (block as CleanBlockEx).emphasisRanges
        ? (block as CleanBlockEx).emphasisRanges!
        : []

    // 문장 분리 → gap 경계 분할 → (A) 절 분할 → (B) 강조 분리 → 길이 보정
    for (const sent of segmentSentences(cleanText)) {
      for (const g of splitAtGaps(sent.start, sent.end, map.gapBefore)) {
        // (A) clauseBreak: 쉼표류·접속부사 경계에서 추가 분할.
        const clauseSegs = opts.clauseBreak
          ? splitClauses(cleanText, g.start, g.end)
          : [{ start: g.start, end: g.end }]
        // 절이 2개 이상으로 나뉘었으면 각 조각을 절 경계 청크로 표시.
        const hadClauseSplit = clauseSegs.length > 1

        for (const clause of clauseSegs) {
          // (B) emphasisSlowdown: 강조 구간을 독립 서브 세그먼트로 분리.
          const rawSubSegs =
            emphasisRanges.length > 0
              ? splitByEmphasis(clause.start, clause.end, emphasisRanges, opts.emphasisRate)
              : [{ start: clause.start, end: clause.end, rateScale: undefined as number | undefined }]

          // 강조 분리로 생긴 부호·공백만의 일반 세그먼트(예: 강조 직후 ",")는
          // 직전 세그먼트 끝에 흡수해 무의미한 1글자 청크를 막는다(발화 끊김 방지).
          const subSegs: Array<{ start: number; end: number; rateScale?: number }> = []
          for (const sub of rawSubSegs) {
            const segText = cleanText.slice(sub.start, sub.end)
            const hasWord = /[\p{L}\p{N}]/u.test(segText) // 한글·영문·숫자 등 의미 글자 유무
            if (sub.rateScale === undefined && !hasWord && subSegs.length > 0) {
              subSegs[subSegs.length - 1].end = sub.end
            } else {
              subSegs.push({ start: sub.start, end: sub.end, rateScale: sub.rateScale })
            }
          }

          for (const sub of subSegs) {
            // maxChars 초과 강제 분할(길이 보정). 강조·절 분할 후에도 여전히 긴 경우 대비.
            for (const piece of splitLong(cleanText, sub.start, sub.end, opts.maxChars)) {
              // 앞뒤 공백 trim — 텍스트만, 원문 offset 은 trim 된 실제 문자에 맞춤.
              let cs = piece.start
              let ce = piece.end
              while (cs < ce && /\s/.test(cleanText[cs])) cs++
              while (ce > cs && /\s/.test(cleanText[ce - 1])) ce--
              if (ce <= cs) continue

              const text = cleanText.slice(cs, ce)
              // 빈/공백만 강조 구간은 스킵(이모지 제거 등 극단적 정제 후 발생 가능).
              if (text.trim() === '') continue

              const startOffset = map.startMap[cs]
              const endOffset = map.endMap[ce - 1]
              const isEmphasisChunk = sub.rateScale !== undefined

              cands.push({
                kind: 'speech',
                text,
                startOffset,
                endOffset,
                isHeading: block.isHeading,
                rateScale: isEmphasisChunk ? sub.rateScale : undefined,
                // 절 분할 또는 강조 분리로 생긴 청크는 모두 병합 금지 대상.
                isClauseBound: hadClauseSplit || isEmphasisChunk,
                isEmphasis: isEmphasisChunk,
              })
            }
          }
        }
      }
    }

    // 헤더 뒤 무음 청크 삽입(옵션).
    if (opts.silenceAfterHeading && block.isHeading) {
      cands.push({ kind: 'silence' })
    }
  }

  // 2) 너무 짧은 speech 청크 병합(헤더는 단독 유지 가능). silence 는 경계로 취급.
  //    ⚠️ 핵심: 병합은 두 청크가 원문에서 "거의 붙어 있을 때만"(gap <= MERGE_MAX_GAP) 한다.
  //    추가 제약:
  //    - 절 분할(isClauseBound) 또는 강조(isEmphasis)로 생긴 청크는 병합 금지.
  //    - rateScale 이 다른 청크끼리는 병합 금지(강조 속도 정보 손실 방지).
  const merged: Cand[] = []
  for (const c of cands) {
    if (c.kind === 'silence') {
      merged.push(c)
      continue
    }
    // annotation 은 병합 대상 아님(경계처럼 단독 유지).
    if (c.kind === 'annotation') {
      merged.push(c)
      continue
    }
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    const tooShort = c.text.length < opts.minChars
    const gap = prev && prev.kind === 'speech' ? c.startOffset - prev.endOffset : Infinity

    // 절 분할·강조로 생성된 청크는 병합 금지.
    const cNoMerge = c.isClauseBound || c.isEmphasis
    const prevNoMerge =
      prev && prev.kind === 'speech' && (prev.isClauseBound || prev.isEmphasis)

    if (
      tooShort &&
      !c.isHeading &&
      !cNoMerge &&
      prev &&
      prev.kind === 'speech' &&
      !prev.isHeading &&
      !prevNoMerge &&
      c.startOffset >= prev.endOffset &&
      gap <= MERGE_MAX_GAP &&
      // rateScale 다르면 병합 금지 — 속도 배율이 섞이면 안 됨.
      c.rateScale === prev.rateScale
    ) {
      // 이전 speech 와 병합: 텍스트는 공백으로 잇고, 원문 범위는 [prev.start, c.end] 로 확장.
      prev.text = (prev.text + ' ' + c.text).replace(/\s+/g, ' ').trim()
      prev.endOffset = Math.max(prev.endOffset, c.endOffset)
    } else {
      merged.push(c)
    }
  }

  // 3) 인덱스 부여 + Chunk 생성. silence 는 헤더 무음.
  const chunks: Chunk[] = []
  let index = 0
  for (const c of merged) {
    if (c.kind === 'silence') {
      chunks.push({
        index: index++,
        text: '',
        startOffset: 0,
        endOffset: 0,
        kind: 'silence',
        silenceMs: opts.headingSilenceMs,
      })
    } else if (c.kind === 'annotation') {
      chunks.push({
        index: index++,
        text: c.text,
        spokenText: c.spokenText,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        kind: 'annotation',
      })
    } else {
      // 발음 텍스트(spokenText): 합성 전용. 변환 결과가 원문과 다를 때만 채운다.
      //  - text 와 같으면 undefined → 엔진이 text 로 폴백(불필요한 필드 방지).
      //  - ⚠️ 빈 문자열('')은 절대 넣지 않는다(엔진이 ''를 '무음/스킵' 신호로 보기 때문).
      //  - 표 header 등 c.spokenText 가 지정됐으면 그걸 베이스로(숫자도 toSpoken 적용).
      //  - (C) 절 분할·강조 분리로 쪼갠 Cand 에도 동일하게 toSpoken 을 적용한다.
      const base = c.spokenText !== undefined ? c.spokenText : c.text
      const spoken = toSpoken(base)
      chunks.push({
        index: index++,
        text: c.text,
        spokenText: spoken && spoken !== c.text ? spoken : undefined,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        kind: 'speech',
        isHeading: c.isHeading || undefined,
        rateScale: c.rateScale,
      })
    }
  }

  return chunks
}
