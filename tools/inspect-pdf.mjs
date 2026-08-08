/**
 * PDF 텍스트 추출 진단기 (Node · 브라우저 없이).
 *
 * Phase 1 의 extract.ts 를 설계하려면 "실제 PDF 의 텍스트 item 이 어떤 모양인지"를 먼저
 * 알아야 한다. 특히 한국어 PDF 는 폰트/커닝 때문에 item 이 **글자 단위로 잘게 쪼개지는**
 * 경우가 있는데, 그러면 텍스트 레이어 span 이 수만 개가 되어 성능·하이라이트 설계가 달라진다.
 *
 * 확인 항목:
 *  - item 분절 단위(글자/어절/줄)와 개수
 *  - hasEOL 신뢰도(줄바꿈 판정에 쓸 수 있는가)
 *  - y 좌표 군집(줄 구조) · x 시작점 군집(2단 조판 여부)
 *  - rawText 조립 시 offset 정합
 *  - 하이픈 분철·머리말/꼬리말 후보
 *
 * 사용: node tools/inspect-pdf.mjs <파일경로> [페이지수=3]
 */
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const path = process.argv[2]
const maxPages = Number(process.argv[3] ?? 3)
if (!path) {
  console.error('사용: node tools/inspect-pdf.mjs <파일경로> [페이지수]')
  process.exit(1)
}

const data = new Uint8Array(readFileSync(path))
const pdf = await getDocument({ data, useSystemFonts: false, disableFontFace: true }).promise

console.log('='.repeat(70))
console.log(`파일: ${path.split(/[\\/]/).pop()}`)
console.log(`쪽수: ${pdf.numPages} · 크기: ${(data.byteLength / 1048576).toFixed(2)}MB`)

let totalItems = 0
let totalChars = 0
let emptyPages = 0

for (let p = 1; p <= Math.min(maxPages, pdf.numPages); p++) {
  const page = await pdf.getPage(p)
  const vp = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const items = tc.items.filter((it) => typeof it.str === 'string')
  totalItems += items.length
  if (items.length === 0) emptyPages++

  console.log('\n' + '─'.repeat(70))
  console.log(`[${p}쪽] ${vp.width.toFixed(0)}×${vp.height.toFixed(0)}pt · item ${items.length}개`)

  if (items.length === 0) {
    console.log('  ⚠️ 텍스트 item 0개 — 스캔본(이미지)일 가능성')
    continue
  }

  // ── item 분절 단위 통계 ──
  const lens = items.map((it) => it.str.length)
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length
  const eol = items.filter((it) => it.hasEOL).length
  const blank = items.filter((it) => it.str.trim() === '').length
  const one = lens.filter((n) => n <= 1).length
  console.log(
    `  분절: 평균 ${avg.toFixed(1)}자 · 최대 ${Math.max(...lens)}자 · ` +
      `1자이하 ${one}개(${((one / items.length) * 100).toFixed(0)}%) · 공백만 ${blank}개`,
  )
  console.log(`  hasEOL: ${eol}개 (${((eol / items.length) * 100).toFixed(0)}%)`)

  // ── 줄 구조: y 좌표 군집 / x 시작점(2단 조판 판별) ──
  const ys = [...new Set(items.map((it) => Math.round(it.transform[5])))].sort((a, b) => b - a)
  const xs = items.map((it) => Math.round(it.transform[4]))
  const xMin = Math.min(...xs)
  const xHalf = xs.filter((x) => x > vp.width / 2).length
  console.log(`  줄(y 군집): ${ys.length}개 · x 시작 최소 ${xMin} · 우측절반 시작 item ${xHalf}개`)
  if (xHalf > items.length * 0.25) {
    console.log(`  ⚠️ 우측 절반에서 시작하는 item 이 많음 — 2단 조판 가능성(컬럼 분리 필요)`)
  }

  // ── rawText 조립 + offset 정합 ──
  let raw = ''
  const pieces = []
  for (const it of items) {
    const srcStart = raw.length
    raw += it.str
    pieces.push({ plain: it.str, srcStart, srcEnd: raw.length })
    if (it.hasEOL) raw += '\n'
  }
  totalChars += raw.length
  const bad = pieces.filter((x) => raw.slice(x.srcStart, x.srcEnd) !== x.plain).length
  console.log(`  조립: ${raw.length}자 · offset 정합 ${bad === 0 ? '✅ 전건 일치' : `❌ 불일치 ${bad}건`}`)

  // ── 하이픈 분철 / 머리말·꼬리말 후보 ──
  const hyphenEnds = items.filter((it) => /[-‐‑–]\s*$/.test(it.str)).length
  if (hyphenEnds) console.log(`  하이픈으로 끝나는 item ${hyphenEnds}개 — 분철 병합 후보`)
  const topY = Math.max(...ys)
  const botY = Math.min(...ys)
  const head = items.filter((it) => Math.round(it.transform[5]) === topY).map((it) => it.str).join('')
  const foot = items.filter((it) => Math.round(it.transform[5]) === botY).map((it) => it.str).join('')
  console.log(`  최상단 줄: ${JSON.stringify(head.slice(0, 60))}`)
  console.log(`  최하단 줄: ${JSON.stringify(foot.slice(0, 60))}`)

  // ── item 원본 샘플(공백을 보려고 JSON 인용) ──
  console.log('  item 샘플(앞 12개):')
  for (const it of items.slice(0, 12)) {
    const x = Math.round(it.transform[4])
    const y = Math.round(it.transform[5])
    console.log(`    (${String(x).padStart(4)},${String(y).padStart(4)}) ${it.hasEOL ? '⏎' : ' '} ${JSON.stringify(it.str)}`)
  }
}

console.log('\n' + '='.repeat(70))
console.log(`요약: ${Math.min(maxPages, pdf.numPages)}쪽 검사 · item ${totalItems}개 · ${totalChars}자`)
if (emptyPages) console.log(`⚠️ 텍스트 없는 쪽 ${emptyPages}개 — 스캔본/이미지쪽`)
console.log(`item 밀도: 쪽당 평균 ${(totalItems / Math.min(maxPages, pdf.numPages)).toFixed(0)}개`)
