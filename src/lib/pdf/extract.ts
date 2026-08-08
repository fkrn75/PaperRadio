/**
 * PDF → 낭독용 rawText + 블록 추출기.
 *
 * MarkdownRadio 의 `refineMarkdown()` 자리를 대신한다. 산출물(CleanBlockEx[])을 그대로
 * `chunkify()` 에 넘기면 문장 분리·offset 매핑·FN-03 불변식이 무수정으로 재사용된다.
 *
 * ───────────────────────────────────────────────────────────────
 * 좌표계가 셋이라는 점을 먼저 이해할 것:
 *
 *   ① PDF 내부      (page, item index)      pdf.js 가 주는 것
 *   ② rawText offset [start, end)           ★ 우리가 조립하는 SSOT. 불변식·북마크·청크가 사는 곳
 *   ③ DOM span      data-start/data-end      텍스트 레이어(하이라이트·클릭재생)
 *
 * ②는 **원본 PDF 바이트가 아니라 이 추출기가 만든 문자열**이다. 그래서 머리말을 버리거나
 * 줄을 병합해도 offset 이 어긋나지 않는다 — 버린 것은 애초에 rawText 에 없기 때문이다.
 * (MarkdownRadio 는 rawText 가 원본 파일로 고정이라 버린 자리가 gap 으로 남았지만, 여기선
 *  그 문제 자체가 사라진다.)
 *
 * 대신 **재현성**이 생명이다: 같은 PDF + 같은 EXTRACT_VERSION 이면 언제나 같은 rawText 가
 * 나와야 저장된 북마크가 유효하다. 그래서 이 모듈은 부수효과 없는 순수 함수로 두고,
 * 문서 전체를 봐야 정해지는 값(머리말 패턴)은 결과에 담아 두었다가 페이지 재추출 때 주입한다.
 * ───────────────────────────────────────────────────────────────
 */
import type { CleanBlock } from '../types.ts'
import type { CleanBlockEx, CleanPiece } from '../refine/blocks.ts'

/**
 * PDF → rawText 변환 로직의 버전.
 *
 * ⚠️ 이 값을 올리면 **offset 좌표계 자체가 달라져** 기존 북마크가 무효가 된다.
 * REFINE_VERSION(청크 단계)과 별개로 관리하는 이유가 이것이다. 추출 규칙(정렬·머리말 제거·
 * 줄 병합)을 바꿀 때마다 +1 하고, 저장된 문서는 재추출한다.
 *
 * 이력: 1 = 최초. y 정렬 · 머리말/꼬리말 제거 · 한국어 줄바꿈 무공백 병합 · 하이픈 분철 병합.
 */
export const EXTRACT_VERSION = 1

// ─────────────────────────────────────────────────────────────
// 입력 계약 (pdf.js 타입에 직접 의존하지 않는다 — 순수 함수·테스트 용이)
// ─────────────────────────────────────────────────────────────

/** pdf.js getTextContent().items 의 텍스트 항목에서 우리가 쓰는 필드만. */
export interface PdfTextItem {
  str: string
  /** [a, b, c, d, e, f] — e=x, f=y (PDF 좌표: y 는 아래가 0). */
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

/** 한 페이지의 입력. viewport 크기는 머리말/꼬리말 위치 판정에 쓴다. */
export interface PdfPageInput {
  /** 1-based 페이지 번호. */
  page: number
  items: PdfTextItem[]
  width: number
  height: number
}

// ─────────────────────────────────────────────────────────────
// 중간 표현: 줄(line)
// ─────────────────────────────────────────────────────────────

/** 같은 y 에 놓인 item 들을 묶은 시각적 한 줄. */
interface Line {
  /** 줄의 기준 y(PDF 좌표, 클수록 위쪽). */
  y: number
  /** 줄 왼쪽 끝 x. */
  x: number
  /** 줄 오른쪽 끝 x(마지막 item 의 x + width). "줄이 꽉 찼는가" 판정에 쓴다. */
  endX: number
  /** 이 줄의 대표 글자 크기(헤딩 판정용). */
  size: number
  /** x 오름차순으로 정렬된 item 들. */
  items: PdfTextItem[]
  /** items 의 str 을 이어붙인 줄 텍스트(가공 전). */
  text: string
}

/** 같은 줄로 볼 y 허용 오차(pt). 위첨자·커닝으로 미세하게 어긋나는 경우를 흡수한다. */
const LINE_Y_TOLERANCE = 2.5

/** 이 배수를 넘는 줄 간격은 문단(블록) 경계로 본다. */
const PARAGRAPH_GAP_RATIO = 1.6

/** 머리말/꼬리말 후보로 볼 페이지 상·하단 비율. */
const HEAD_ZONE = 0.08

/** running head 로 확정하려면 이 비율 이상의 페이지에서 반복돼야 한다. */
const HEAD_REPEAT_RATIO = 0.4

/**
 * 문서 전체를 봐야 정해지는 값. 페이지 단위 재추출(텍스트 레이어 offset 재생성) 때
 * 그대로 주입해 **같은 결과**를 얻기 위해 결과에 담아 저장한다.
 */
export interface RunningHeads {
  /** 정규화된 머리말 텍스트들(페이지 상단). */
  top: string[]
  /** 정규화된 꼬리말 텍스트들(페이지 하단). */
  bottom: string[]
}

export interface PdfPageRange {
  page: number
  /** 이 페이지 텍스트가 rawText 에서 차지하는 시작 offset. */
  start: number
  /** 끝 offset(exclusive). */
  end: number
}

export interface PdfExtractResult {
  /** offset 좌표계의 기준이 되는 낭독용 원문. 화면에 렌더되지 않는다(원본은 canvas 로 그린다). */
  rawText: string
  /** chunkify() 에 그대로 넘길 블록들. */
  blocks: CleanBlockEx[]
  /** 페이지 ↔ rawText 범위 대응(하이라이트 시 "이 청크가 몇 쪽인지" 판정용). */
  pageRanges: PdfPageRange[]
  /** 페이지 재추출 시 동일 결과를 얻기 위해 보관하는 머리말 패턴. */
  runningHeads: RunningHeads
  /** 텍스트가 하나도 없는 페이지(1-based) — 스캔본 판정에 쓴다. */
  emptyPages: number[]
  extractVersion: number
}

// ─────────────────────────────────────────────────────────────
// 작은 유틸
// ─────────────────────────────────────────────────────────────

/** 한글 음절/자모. 줄바꿈 병합 규칙의 핵심 판정자. */
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/

/** CJK 전반(한자·가나 포함) — 이들도 줄바꿈 시 공백을 넣지 않는다. */
const CJK = /[가-힣ㄱ-ㅎㅏ-ㅣ぀-ヿ㐀-䶿一-鿿]/

/** 줄 끝 하이픈(분철 후보). 영문 조판에서 단어가 잘릴 때 붙는다. */
const TRAILING_HYPHEN = /[-‐‑]$/

/** 머리말 비교용 정규화: 숫자(쪽번호)와 공백을 지워 "같은 머리말"인지 본다. */
function normalizeHead(s: string): string {
  return s.replace(/[\d\s]+/g, '').trim()
}

/**
 * 두 줄을 이을 때 사이에 넣을 문자를 정한다.
 *
 * ⚠️ 이 함수가 한국어 낭독 품질을 좌우한다. 한국어는 **단어 중간에서 줄바꿈**되므로
 * 공백을 넣으면 안 된다("…변화를 해석" + "한 뒤" → "해석한 뒤"). 반면 영문은 단어 단위로
 * 줄바꿈되므로 공백이 필요하다. 문장부호로 끝났으면 어느 쪽이든 공백이 자연스럽다.
 */
function joinerBetween(prev: string, next: string): string {
  if (prev === '' || next === '') return ''
  if (/\s$/.test(prev) || /^\s/.test(next)) return '' // 이미 공백이 있다
  const a = prev[prev.length - 1]
  const b = next[0]
  // 문장부호로 끝났으면 다음 내용은 새 낱말 — 공백.
  if (/[.!?,;:·…)\]}"'』」]/.test(a)) return ' '
  // 여는 부호로 시작하면 공백.
  if (/[([{"'『「]/.test(b)) return ' '
  // 양쪽 모두 CJK 면 붙인다(줄바꿈이 낱말 중간을 자른 것).
  if (CJK.test(a) && CJK.test(b)) return ''
  return ' '
}

// ─────────────────────────────────────────────────────────────
// 1) 페이지 → 줄 (페이지 독립 · 결정적)
// ─────────────────────────────────────────────────────────────

/**
 * 한 페이지의 item 들을 시각적 읽기 순서(위→아래, 왼→오른쪽)의 줄 목록으로 만든다.
 *
 * ⚠️ 실측 근거: pdf.js 의 item 순서는 **읽기 순서가 아니다**. 검사한 한국어 PDF 에서
 * 꼬리말("문서명 2")이 본문보다 먼저 나왔다. 순서를 믿고 이어붙이면 매 쪽 꼬리말이
 * 본문 앞에 낭독된다. 그래서 좌표로 다시 정렬한다.
 */
export function extractPageLines(input: PdfPageInput): Line[] {
  const usable = input.items.filter((it) => it.str !== '')
  if (usable.length === 0) return []

  // y 로 군집 → 줄. 부동소수 오차와 위첨자를 흡수하려고 허용 오차를 둔다.
  const buckets: Line[] = []
  for (const it of usable) {
    const y = it.transform[5]
    const x = it.transform[4]
    const size = Math.abs(it.transform[0]) || it.height
    const hit = buckets.find((b) => Math.abs(b.y - y) <= LINE_Y_TOLERANCE)
    if (hit) {
      hit.items.push(it)
      hit.x = Math.min(hit.x, x)
      hit.endX = Math.max(hit.endX, x + it.width)
      hit.size = Math.max(hit.size, size)
    } else {
      buckets.push({ y, x, endX: x + it.width, size, items: [it], text: '' })
    }
  }

  // 위 → 아래(y 내림차순), 줄 안에서는 왼 → 오른쪽(x 오름차순).
  buckets.sort((a, b) => b.y - a.y)
  for (const line of buckets) {
    line.items.sort((p, q) => p.transform[4] - q.transform[4])
    line.text = line.items.map((it) => it.str).join('')
  }
  return buckets.filter((l) => l.text.trim() !== '')
}

// ─────────────────────────────────────────────────────────────
// 2) 머리말/꼬리말 탐지 (문서 전체 필요)
// ─────────────────────────────────────────────────────────────

/**
 * 여러 쪽에서 반복되는 머리말·꼬리말을 찾는다.
 *
 * ⚠️ 왜 중요한가: 검사한 136쪽 문서는 모든 쪽 하단에 "문서명 + 쪽번호"가 있었다.
 * 제거하지 않으면 **136번 반복 낭독**된다.
 *
 * 판정은 두 조건을 함께 본다 — 위치(페이지 상·하단 8% 안)와 반복(숫자를 뺀 텍스트가
 * 40% 이상 쪽에서 동일). 위치만 보면 본문 첫/끝 줄을 지우고, 반복만 보면 같은 문장이
 * 우연히 반복되는 본문을 지운다.
 */
export function detectRunningHeads(pages: PdfPageInput[]): RunningHeads {
  const topCount = new Map<string, number>()
  const botCount = new Map<string, number>()

  for (const p of pages) {
    const lines = extractPageLines(p)
    if (lines.length < 2) continue // 표지처럼 줄이 적은 쪽은 판단하지 않는다
    const first = lines[0]
    const last = lines[lines.length - 1]
    if (first.y >= p.height * (1 - HEAD_ZONE)) {
      const k = normalizeHead(first.text)
      if (k) topCount.set(k, (topCount.get(k) ?? 0) + 1)
    }
    if (last.y <= p.height * HEAD_ZONE) {
      const k = normalizeHead(last.text)
      if (k) botCount.set(k, (botCount.get(k) ?? 0) + 1)
    }
  }

  const need = Math.max(2, Math.ceil(pages.length * HEAD_REPEAT_RATIO))
  const pick = (m: Map<string, number>): string[] =>
    [...m.entries()].filter(([, n]) => n >= need).map(([k]) => k)

  return { top: pick(topCount), bottom: pick(botCount) }
}

/** 이 줄이 제거 대상(머리말/꼬리말)인가. */
function isRunningHead(line: Line, page: PdfPageInput, heads: RunningHeads, isFirst: boolean, isLast: boolean): boolean {
  const key = normalizeHead(line.text)
  if (!key) return false
  if (isFirst && line.y >= page.height * (1 - HEAD_ZONE) && heads.top.includes(key)) return true
  if (isLast && line.y <= page.height * HEAD_ZONE && heads.bottom.includes(key)) return true
  return false
}

// ─────────────────────────────────────────────────────────────
// 3) 줄 → 문단(블록) + rawText 조립
// ─────────────────────────────────────────────────────────────

/** 조립 중인 블록 상태. */
interface Building {
  pieces: CleanPiece[]
  text: string
  start: number
  isHeading: boolean
  size: number
}

/**
 * 페이지들을 낭독용 rawText 와 블록 배열로 변환한다.
 *
 * @param pages 페이지별 텍스트 item(1-based page 포함)
 * @param heads 미리 탐지한 머리말 패턴. 생략하면 여기서 탐지한다.
 *   페이지 단위 재추출 시에는 **반드시 저장해 둔 값을 주입**해야 같은 offset 이 나온다.
 */
export function extractPdfDocument(pages: PdfPageInput[], heads?: RunningHeads): PdfExtractResult {
  const runningHeads = heads ?? detectRunningHeads(pages)

  let rawText = ''
  const blocks: CleanBlockEx[] = []
  const pageRanges: PdfPageRange[] = []
  const emptyPages: number[] = []

  // 본문 글자 크기의 중앙값 → 헤딩 판정 기준.
  const allSizes: number[] = []
  for (const p of pages) for (const l of extractPageLines(p)) allSizes.push(l.size)
  allSizes.sort((a, b) => a - b)
  const bodySize = allSizes.length ? allSizes[Math.floor(allSizes.length / 2)] : 12

  let building: Building | null = null

  /** 조립 중인 블록을 확정해 blocks 에 넣는다. */
  const flush = (): void => {
    if (!building || building.text.trim() === '') {
      building = null
      return
    }
    const b = building
    const lineStart = rawText.slice(0, b.start).split('\n').length - 1
    const block: CleanBlockEx = {
      text: b.text,
      isHeading: b.isHeading,
      headingLevel: b.isHeading ? (b.size >= bodySize * 1.6 ? 1 : 2) : undefined,
      sourceLineStart: lineStart,
      sourceLineEnd: rawText.split('\n').length - 1,
      startOffset: b.start,
      endOffset: b.start + b.text.length,
      pieces: b.pieces,
    }
    blocks.push(block)
    building = null
  }

  for (const page of pages) {
    const pageStart = rawText.length
    const lines = extractPageLines(page)
    if (lines.length === 0) emptyPages.push(page.page)

    // 문단 경계 판정 기준이 될 일반 줄 간격(같은 쪽 안에서만 의미 있다).
    const gaps: number[] = []
    for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y)
    gaps.sort((a, b) => a - b)
    const normalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0

    /**
     * 본문 우측 경계. "줄이 끝까지 찼는가"를 판정해 **넘침에 의한 줄바꿈**과
     * **의도적 줄바꿈**(제목·문단 끝)을 구분한다. 이 구분이 없으면 표지 제목 3줄이
     * "공연영상 기반쇼파일 역설계와VLM/VLA 연계" 처럼 한 덩어리로 뭉친다.
     * 이상치(꼬리말 등)에 흔들리지 않도록 최대값 대신 90 백분위수를 쓴다.
     */
    const edges = lines.map((l) => l.endX).sort((a, b) => a - b)
    const rightEdge = edges.length ? edges[Math.floor(edges.length * 0.9)] : page.width
    /**
     * "꽉 참" 판정 여유(≈ 한 글자 반).
     *
     * 한국어는 낱말 중간("…변화를 해석" + "한 뒤")과 어절 경계("…위험을" + "검토하기")
     * 양쪽에서 줄바꿈되는데, 텍스트만으로는 구분할 수 없다. 좌표가 유일한 단서지만
     * **좌표로도 완전히 갈리지는 않는다** — 조판기가 자간을 조정하면 줄 끝 위치가 들쭉날쭉해진다.
     *
     * 실측(34쪽 한국어 PDF)으로 확인한 trade-off:
     *   여유 0.5글자 → "해석한 뒤" ✅ 이지만 "어떻 게" 처럼 **낱말이 갈라지는** 새 오류 발생
     *   여유 1.5글자 → "어떻게" ✅, 대신 "위험을검토하기" 처럼 어절이 붙는 오류가 소수 남음
     * 검사한 문서는 낱말 중간 절단이 압도적으로 많아 **붙임 우선(1.5)** 이 오류가 적었다.
     * 낭독 품질로도 붙는 쪽이 낫다 — 한국어 TTS 는 붙은 어절은 무난히 읽지만 갈라진 낱말은
     * 어색하게 끊어 읽는다. 개선 여지는 extract.check.ts 의 "조사 뒤 붙음 의심" 지표로 추적한다.
     */
    const fillSlack = bodySize * 1.5

    /** 직전에 블록에 실제로 추가된 줄(머리말로 건너뛴 줄은 제외). */
    let prevLine: Line | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (isRunningHead(line, page, runningHeads, i === 0, i === lines.length - 1)) continue

      const isHeadingLine = line.size >= bodySize * 1.25
      const gapAbove = i > 0 ? lines[i - 1].y - line.y : 0
      // 문단 경계: 줄 간격이 벌어졌거나, 헤딩 여부가 바뀌었거나, 아직 블록이 없을 때.
      const breakHere =
        !building ||
        (normalGap > 0 && gapAbove > normalGap * PARAGRAPH_GAP_RATIO) ||
        building.isHeading !== isHeadingLine

      if (breakHere) {
        flush()
        // 블록 사이는 줄바꿈 2개 — 블록 경계는 chunkify 가 블록 단위로 처리하므로
        // 이 문자들은 어떤 블록에도 속하지 않는다(=버려진 자리가 아니라 구분자).
        if (rawText !== '') rawText += '\n\n'
        building = { pieces: [], text: '', start: rawText.length, isHeading: isHeadingLine, size: line.size }
        prevLine = null
      }

      const b = building!
      // 줄 사이 이음: 한국어는 붙이고 영문은 공백. 하이픈 분철은 하이픈을 떼고 붙인다.
      if (b.text !== '') {
        const prevPiece = b.pieces[b.pieces.length - 1]
        // 직전 줄이 우측 끝까지 찼다면 "넘쳐서 잘린 줄" → 낱말이 이어질 수 있다.
        // 짧게 끝났다면 제목/문단 끝의 의도적 줄바꿈 → 무조건 띄운다.
        const prevFilled = prevLine !== null && prevLine.endX >= rightEdge - fillSlack

        if (prevFilled && prevPiece && TRAILING_HYPHEN.test(prevPiece.plain) && !CJK.test(line.text[0] ?? '')) {
          // 분철: 이미 넣은 하이픈 1자를 rawText·piece·블록텍스트에서 함께 되돌린다.
          prevPiece.plain = prevPiece.plain.slice(0, -1)
          prevPiece.srcEnd -= 1
          b.text = b.text.slice(0, -1)
          rawText = rawText.slice(0, -1)
        } else {
          const j = prevFilled ? joinerBetween(b.text, line.text) : /\s$/.test(b.text) ? '' : ' '
          if (j !== '') {
            // ⚠️ 이음 문자도 **반드시 piece 로 넣는다**. CleanBlockEx 의 계약이
            //    "text === pieces 의 plain 연결" 이고, chunk.ts 는 pieces 로 텍스트를 재구성해
            //    문장을 나눈다(buildOffsetMap). piece 없이 text 에만 넣으면 청크 텍스트에서
            //    이 공백이 사라져 FN-03 불변식이 깨진다(실측으로 확인된 함정).
            const s = rawText.length
            rawText += j
            b.text += j
            b.pieces.push({ plain: j, srcStart: s, srcEnd: rawText.length })
          }
        }
      }

      // item 하나 = piece 하나. 이 대응이 나중에 텍스트 레이어 span ↔ offset 을 잇는다.
      for (const it of line.items) {
        if (it.str === '') continue
        const srcStart = rawText.length
        rawText += it.str
        b.text += it.str
        b.pieces.push({ plain: it.str, srcStart, srcEnd: rawText.length })
      }
      b.size = Math.max(b.size, line.size)
      prevLine = line
    }

    flush()
    pageRanges.push({ page: page.page, start: pageStart, end: rawText.length })
  }

  return { rawText, blocks, pageRanges, runningHeads, emptyPages, extractVersion: EXTRACT_VERSION }
}

/** 블록에서 CleanBlock 표면만 필요한 곳을 위한 헬퍼(타입 좁히기용). */
export function toCleanBlocks(blocks: CleanBlockEx[]): CleanBlock[] {
  return blocks
}
