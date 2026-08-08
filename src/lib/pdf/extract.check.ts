/**
 * 추출 → 청크 → 불변식 회귀 검사 (Node 직접 실행).
 *
 * 프로덕션은 불변식 위반을 console.warn 으로만 알리고 넘어가므로(graceful), 깨져도
 * 앱은 멀쩡해 보인다. 회귀는 여기서 strict 로 잡는다.
 *
 * 사용: node --experimental-strip-types src/lib/pdf/extract.check.ts <pdf경로> [쪽수]
 */
import { readFileSync } from 'node:fs'
import { extractPdfDocument, detectGutter, type PdfPageInput, type IndexedItem } from './extract.ts'
import { buildChunks } from '../refine/index.ts'

const path = process.argv[2]
const maxPages = Number(process.argv[3] ?? 0) // 0 = 전체
if (!path) {
  console.error('사용: node --experimental-strip-types src/lib/pdf/extract.check.ts <pdf경로> [쪽수]')
  process.exit(1)
}

// pdf.js 는 Node 용 legacy 빌드를 쓴다(타입은 이 검사 스크립트 범위 밖이라 최소로만 좁힌다).
const { getDocument } = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
  getDocument: (o: unknown) => { promise: Promise<PdfDocLike> }
}
interface PdfDocLike {
  numPages: number
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number }
    getTextContent(): Promise<{ items: unknown[] }>
  }>
}

const bytes = readFileSync(path)
const pdf = await getDocument({
  data: new Uint8Array(bytes),
  useSystemFonts: false,
  disableFontFace: true,
}).promise

const total = maxPages > 0 ? Math.min(maxPages, pdf.numPages) : pdf.numPages
const pages: PdfPageInput[] = []
for (let p = 1; p <= total; p++) {
  const page = await pdf.getPage(p)
  const vp = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  pages.push({
    page: p,
    width: vp.width,
    height: vp.height,
    items: tc.items.filter((it): it is PdfPageInput['items'][number] => typeof (it as { str?: unknown }).str === 'string'),
  })
}

console.log('='.repeat(72))
console.log(`파일: ${path.split(/[\\/]/).pop()}`)
console.log(`쪽수: ${total}/${pdf.numPages}`)

const t0 = performance.now()
const res = extractPdfDocument(pages)
const tExtract = performance.now() - t0

console.log(`\n── 추출 ──`)
console.log(`  rawText ${res.rawText.length}자 · 블록 ${res.blocks.length}개 · ${tExtract.toFixed(0)}ms`)
console.log(`  머리말 패턴 top=${JSON.stringify(res.runningHeads.top)}`)
console.log(`  꼬리말 패턴 bottom=${JSON.stringify(res.runningHeads.bottom)}`)
if (res.emptyPages.length) {
  console.log(`  ⚠️ 텍스트 없는 쪽 ${res.emptyPages.length}개 → ${res.emptyPages.slice(0, 10).join(', ')}${res.emptyPages.length > 10 ? ' …' : ''}`)
}

// ── 머리말/꼬리말이 실제로 빠졌는지 (본문에 반복 잔재가 없어야 한다) ──
for (const pat of [...res.runningHeads.top, ...res.runningHeads.bottom]) {
  if (!pat) continue
  // 정규화 패턴이라 그대로는 못 찾는다 → 공백 제거본에서 등장 횟수를 센다.
  const flat = res.rawText.replace(/[\d\s]+/g, '')
  let n = 0
  let idx = flat.indexOf(pat)
  while (idx !== -1) {
    n++
    idx = flat.indexOf(pat, idx + 1)
  }
  const mark = n <= 2 ? '✅' : '⚠️'
  console.log(`  ${mark} 반복 패턴 "${pat.slice(0, 28)}" 잔존 ${n}회 (제거 전이면 쪽수만큼 나온다)`)
}

// ── 조판 판정 (2단이면 컬럼 분리가 걸려야 한다) ──
const twoCol: number[] = []
for (const p of pages) {
  const indexed: IndexedItem[] = []
  p.items.forEach((it, i) => {
    if (it.str !== '') indexed.push({ it, i })
  })
  if (detectGutter(indexed, p.width) !== null) twoCol.push(p.page)
}
console.log(`\n── 조판 ──`)
if (twoCol.length === 0) {
  console.log(`  1단으로 판정(전 쪽)`)
} else {
  console.log(`  2단 판정 ${twoCol.length}/${pages.length}쪽 → ${twoCol.slice(0, 12).join(', ')}${twoCol.length > 12 ? ' …' : ''}`)
  console.log(`  (좌단 전체 → 우단 전체 순으로 읽는다. 전폭 요소는 밴드 경계가 된다)`)
}

// ── 블록/조각 자체 정합성 (청크 이전 단계에서 이미 깨졌는지 확인) ──
console.log(`\n── 추출 정합성(블록·조각) ──`)
let badBlocks = 0
let badPieces = 0
for (const b of res.blocks) {
  if (res.rawText.slice(b.startOffset, b.endOffset) !== b.text) {
    if (badBlocks < 3) {
      console.log(`  ❌ 블록 불일치 [${b.startOffset},${b.endOffset})`)
      console.log(`     slice = ${JSON.stringify(res.rawText.slice(b.startOffset, b.endOffset).slice(0, 90))}`)
      console.log(`     text  = ${JSON.stringify(b.text.slice(0, 90))}`)
    }
    badBlocks++
  }
  for (const p of b.pieces) {
    if (res.rawText.slice(p.srcStart, p.srcEnd) !== p.plain) {
      if (badPieces < 3) {
        console.log(`  ❌ 조각 불일치 [${p.srcStart},${p.srcEnd}) slice=${JSON.stringify(res.rawText.slice(p.srcStart, p.srcEnd))} plain=${JSON.stringify(p.plain)}`)
      }
      badPieces++
    }
  }
}
console.log(`  블록 ${badBlocks === 0 ? '✅ 전건 일치' : `❌ 불일치 ${badBlocks}/${res.blocks.length}`}`)
console.log(`  조각 ${badPieces === 0 ? '✅ 전건 일치' : `❌ 불일치 ${badPieces}건`}`)

// ── 블록/청크 ──
const { chunks } = buildChunks(res.blocks, res.rawText, { strict: false })
const speech = chunks.filter((c) => c.kind === 'speech')
console.log(`\n── 청크 ──`)
console.log(`  전체 ${chunks.length}개 (speech ${speech.length} · silence ${chunks.length - speech.length})`)
const lens = speech.map((c) => c.text.length)
if (lens.length) {
  lens.sort((a, b) => a - b)
  console.log(`  길이: 중앙값 ${lens[Math.floor(lens.length / 2)]}자 · 최대 ${lens[lens.length - 1]}자 · 최소 ${lens[0]}자`)
}

console.log(`\n── rawText 앞부분 ──`)
console.log(
  res.rawText
    .slice(0, 420)
    .split('\n')
    .map((l) => '  │ ' + l)
    .join('\n'),
)

console.log(`\n── 첫 speech 청크 6개 ──`)
for (const c of speech.slice(0, 6)) {
  console.log(`  [${c.index}] ${JSON.stringify(c.text.slice(0, 68))}`)
}

// ── 불변식(strict) ──
console.log(`\n── FN-03 불변식 ──`)
try {
  buildChunks(res.blocks, res.rawText, { strict: true })
  console.log('  ✅ 통과 — 모든 speech 청크가 rawText.slice 와 정규화 동치')
} catch (e) {
  console.log('  ❌ 위반:\n' + String(e instanceof Error ? e.message : e).split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'))
  process.exitCode = 1
}

// ── 줄 병합 품질 ──
// 한국어는 낱말 중간(붙여야 함)과 어절 경계(띄어야 함) 양쪽에서 줄바꿈된다.
// 좌표 판정이 제대로 먹었는지 두 방향의 실제 사례를 직접 찾아 확인한다.
console.log(`\n── 줄 병합 점검 ──`)
for (const probe of process.argv.slice(4)) {
  const at = res.rawText.indexOf(probe)
  console.log(`  ${at >= 0 ? '✅' : '❌'} ${JSON.stringify(probe)} ${at >= 0 ? `발견(@${at})` : '없음'}`)
}
// 조사로 끝난 뒤 곧바로 다른 낱말이 붙은 흔적(띄어야 하는데 붙은 경우).
const glued = res.rawText.match(/[가-힣](?:을|를|은|는|이|가|에|의|와|과|로|도)[가-힣]{2,}/g) ?? []
const uniq = [...new Set(glued)]
console.log(`  조사 뒤 붙음 의심 ${glued.length}건 (예: ${uniq.slice(0, 8).map((s) => JSON.stringify(s.slice(0, 12))).join(', ')})`)
console.log('='.repeat(72))
