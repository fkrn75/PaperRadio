/**
 * 검증용 샘플 PDF 생성기 (의존성 0 — 순수 Node).
 *
 * 왜 직접 만드는가: Phase 0 스파이크는 "pdf.js 워커가 뜨는가 / 텍스트 item 의 offset 이
 * 정합한가 / 여러 페이지 canvas 메모리가 버티는가"를 봐야 하는데, 그러려면 **여러 쪽 · 여러 줄**
 * 짜리 PDF 가 재현 가능하게 있어야 한다. 사용자 개인 PDF 를 쓰지 않으려는 목적도 있다.
 *
 * ⚠️ 한계: 내장 Type1 폰트(Helvetica)만 쓰므로 **본문은 영문/숫자**다. 한국어는 CID 폰트
 *    임베딩이 필요해 여기서 다루지 않는다 — 한국어 추출·청크 품질은 실제 한국어 PDF 로
 *    Phase 1 에서 검증한다. Phase 0 가 보려는 것(워커·offset 정합·렌더 메모리)에는 충분하다.
 *
 * 사용:
 *   node tools/make-sample-pdf.mjs 12 public/samples/sample.pdf
 *   node tools/make-sample-pdf.mjs 4 /tmp/two-col.pdf two-column   # 2단 조판 검증용
 */
import { writeFileSync } from 'node:fs'

const pageCount = Number(process.argv[2] ?? 12)
const outPath = process.argv[3] ?? 'public/samples/sample.pdf'
/** 'two-column' 이면 2단 조판 픽스처를 만든다(컬럼 분리 검증용). */
const layout = process.argv[4] ?? 'single'

/** 한 쪽에 들어갈 본문 줄들. 줄마다 별도 Tj → pdf.js 에서 별도 text item 이 된다. */
function linesFor(pageNo) {
  const body = [
    `Page ${pageNo} of ${pageCount} - PaperRadio extraction fixture.`,
    '',
    'This paragraph exists to verify that text items extracted by pdf.js',
    'can be concatenated into a single rawText string while preserving an',
    'exact character offset for every item. Each visual line below becomes',
    'one text item, which maps to one CleanPiece in the chunk pipeline.',
    '',
    'Numbers and units for the speak layer: 1,234 items, 56.7 kg, 89 %.',
    'A hyphenated word split across lines is a known extraction hazard: infor-',
    'mation should be rejoined without leaving a stray hyphen in rawText.',
    '',
    `Footer marker ${pageNo} -- headers and footers must be droppable.`,
  ]
  return body
}

/** 1단 배치: 왼쪽 여백에서 아래로. */
function singleColumnPlacements(pageNo) {
  const out = []
  let y = 780
  for (const text of linesFor(pageNo)) {
    if (text !== '') out.push({ text, x: 72, y })
    y -= 22
  }
  return out
}

/**
 * 2단 배치(컬럼 분리 검증용).
 *
 * 논문 구조를 흉내낸다 — 전폭 제목 → 2단 본문 → 전폭 주석 → 다시 2단.
 * 줄마다 번호를 박아 두었으므로, 추출 결과가
 *   제목 → Left 1..8 → Right 1..8 → 전폭 주석 → Left 9..12 → Right 9..12
 * 순이면 컬럼 분리가 제대로 된 것이다. y 로만 묶으면 Left 1, Right 1 이 한 줄로 붙는다.
 *
 * 좌단 60~290 / 우단 320~550 → 가운데 30pt 여백(A4 폭 595 의 약 5%)이 gutter 가 된다.
 */
function twoColumnPlacements(pageNo) {
  const out = []
  out.push({ text: `Page ${pageNo} - two column fixture title`, x: 60, y: 790, size: 15 })

  let y = 750
  for (let i = 1; i <= 8; i++) {
    out.push({ text: `Left column line ${i} on page ${pageNo}.`, x: 60, y })
    y -= 20
  }
  y = 750
  for (let i = 1; i <= 8; i++) {
    out.push({ text: `Right column line ${i} on page ${pageNo}.`, x: 320, y })
    y -= 20
  }

  out.push({ text: `Full width note on page ${pageNo} spanning both columns.`, x: 60, y: 560 })

  y = 530
  for (let i = 9; i <= 12; i++) {
    out.push({ text: `Left column line ${i} on page ${pageNo}.`, x: 60, y })
    y -= 20
  }
  y = 530
  for (let i = 9; i <= 12; i++) {
    out.push({ text: `Right column line ${i} on page ${pageNo}.`, x: 320, y })
    y -= 20
  }

  // 매 쪽 반복되는 꼬리말(머리말 제거 검증도 겸한다)
  out.push({ text: `Two column fixture -- page ${pageNo}`, x: 60, y: 40, size: 9 })
  return out
}

function placementsFor(pageNo) {
  return layout === 'two-column' ? twoColumnPlacements(pageNo) : singleColumnPlacements(pageNo)
}

// ── PDF 오브젝트 조립 ────────────────────────────────────────────
const objects = [] // 1-based: objects[i] = i+1 번 오브젝트의 본문 문자열

/** PDF 문자열 리터럴 이스케이프: \ ( ) 만 처리하면 ASCII 본문엔 충분하다. */
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const pageObjNums = []
// 1: Catalog, 2: Pages, 3: Font — 이후 페이지마다 [Page, Contents] 2개씩
const FIRST_PAGE_OBJ = 4
for (let p = 1; p <= pageCount; p++) {
  pageObjNums.push(FIRST_PAGE_OBJ + (p - 1) * 2)
}

objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
objects[1] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`
objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

for (let p = 1; p <= pageCount; p++) {
  const pageObj = FIRST_PAGE_OBJ + (p - 1) * 2
  const contentObj = pageObj + 1
  // 배치마다 개별 Tm/Tj → 배치 하나 = text item 하나
  let stream = 'BT\n'
  let curSize = 0
  for (const pl of placementsFor(p)) {
    const size = pl.size ?? 12
    if (size !== curSize) {
      stream += `/F1 ${size} Tf\n`
      curSize = size
    }
    stream += `1 0 0 1 ${pl.x} ${pl.y} Tm\n(${esc(pl.text)}) Tj\n`
  }
  stream += 'ET\n'

  objects[pageObj - 1] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`
  objects[contentObj - 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`
}

// ── 직렬화 + xref 오프셋 계산 ────────────────────────────────────
let pdf = '%PDF-1.4\n'
const offsets = []
for (let i = 0; i < objects.length; i++) {
  offsets[i] = Buffer.byteLength(pdf, 'latin1')
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
}
const xrefStart = Buffer.byteLength(pdf, 'latin1')
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

writeFileSync(outPath, Buffer.from(pdf, 'latin1'))
console.log(`${outPath} 생성 — ${pageCount}쪽, ${(Buffer.byteLength(pdf, 'latin1') / 1024).toFixed(1)}KB`)
