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
 * 사용: node tools/make-sample-pdf.mjs [페이지수] > public/samples/sample.pdf
 *   또는 node tools/make-sample-pdf.mjs 12 public/samples/sample.pdf
 */
import { writeFileSync } from 'node:fs'

const pageCount = Number(process.argv[2] ?? 12)
const outPath = process.argv[3] ?? 'public/samples/sample.pdf'

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
  // 각 줄을 개별 Td/Tj 로 배치 → 줄 = text item
  let y = 780
  let stream = 'BT\n/F1 12 Tf\n'
  for (const line of linesFor(p)) {
    if (line !== '') stream += `1 0 0 1 72 ${y} Tm\n(${esc(line)}) Tj\n`
    y -= 22
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
