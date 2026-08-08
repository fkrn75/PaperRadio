/**
 * PDF 파일 → 저장 가능한 문서(StoredDocument) 로 만드는 고수준 흐름.
 *
 *   File ──▶ pdf.js 로 열기 ──▶ 페이지별 텍스트 item ──▶ extractPdfDocument()
 *        ──▶ buildChunks() ──▶ StoredDocument + 원본 Blob 저장
 *
 * ⚠️ 원본 Blob 을 반드시 함께 저장한다. 정독뷰가 원본 페이지를 canvas 로 다시 그려야 하고,
 *    텍스트 레이어 offset 도 같은 원본에서 재생성하기 때문이다.
 */
import type { PdfPageInput } from './extract.ts'
import { extractPdfDocument, EXTRACT_VERSION } from './extract.ts'
import { openPdf } from './loader.ts'
import { buildChunks, REFINE_VERSION } from '../refine/index.ts'
import { savePdfBlob, saveDocument } from '../db/idb.ts'
import { genId } from '../stores/id.ts'
import type { ChunkOptions, StoredDocument } from '../types.ts'

/** 가져오기 진행 상황. 136쪽 문서는 페이지 순회에 체감 시간이 걸려 표시가 필요하다. */
export interface ImportProgress {
  phase: 'opening' | 'extracting' | 'chunking' | 'saving'
  /** phase==='extracting' 일 때 현재/전체 쪽. */
  page?: number
  pageCount?: number
}

export interface ImportOptions {
  onProgress?: (p: ImportProgress) => void
  chunk?: ChunkOptions
}

/** 파일명에서 확장자를 떼어 기본 제목을 만든다. */
function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, '').trim() || '제목 없는 문서'
}

/**
 * PDF 를 읽어 문서를 만들고 IndexedDB 에 저장한다.
 *
 * 스캔본(텍스트 레이어 없음)이어도 **실패로 처리하지 않는다** — 청크가 0개인 "보기 전용"
 * 문서로 저장한다. 원본 페이지는 정상적으로 렌더되므로 읽을 수는 있기 때문이다.
 */
export async function importPdfFile(file: File, opts: ImportOptions = {}): Promise<StoredDocument> {
  const { onProgress } = opts
  onProgress?.({ phase: 'opening' })

  // ⚠️ pdf.js 는 넘긴 ArrayBuffer 를 transfer 해 detach 시킨다. 원본은 File(Blob) 로 따로
  //    보관하므로, 파싱에는 복제본을 넘긴다.
  const buf = await file.arrayBuffer()
  const { doc: pdf, close } = await openPdf(buf.slice(0))

  // 문서 제목: PDF 메타데이터의 Title 이 쓸 만하면 우선, 아니면 파일명.
  let title = titleFromFileName(file.name)
  try {
    const meta = (await pdf.getMetadata()) as { info?: { Title?: unknown } }
    const t = typeof meta.info?.Title === 'string' ? meta.info.Title.trim() : ''
    // 제작 도구가 넣은 무의미한 제목(파일 경로·"untitled" 등)은 걸러낸다.
    if (t && t.length >= 2 && !/^untitled$/i.test(t) && !/\.(pdf|docx?|hwp)$/i.test(t)) title = t
  } catch {
    /* 메타데이터가 없어도 무방 — 파일명을 쓴다 */
  }

  // ── 페이지별 텍스트 item 수집 ──
  const pages: PdfPageInput[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress?.({ phase: 'extracting', page: p, pageCount: pdf.numPages })
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    // items 에는 텍스트가 아닌 마크 항목(TextMarkedContent)도 섞여 온다 → str 유무로 걸러낸다.
    // PdfTextItem 은 pdf.js TextItem 의 부분집합이라 좁히기만 하면 안전하다.
    const items: PdfPageInput['items'] = []
    for (const it of tc.items) {
      if (typeof (it as { str?: unknown }).str === 'string') items.push(it as PdfPageInput['items'][number])
    }
    pages.push({ page: p, width: vp.width, height: vp.height, items })
  }

  onProgress?.({ phase: 'chunking' })
  const ex = extractPdfDocument(pages)
  const { chunks } = buildChunks(ex.blocks, ex.rawText, { chunk: opts.chunk })

  const now = Date.now()
  const doc: StoredDocument = {
    id: genId(),
    title,
    rawText: ex.rawText,
    chunks,
    refineVersion: REFINE_VERSION,
    pdf: {
      fileName: file.name,
      fileSize: file.size,
      pageCount: pdf.numPages,
      pageRanges: ex.pageRanges,
      runningHeads: ex.runningHeads,
      emptyPages: ex.emptyPages,
      extractVersion: EXTRACT_VERSION,
    },
    createdAt: now,
    updatedAt: now,
  }

  onProgress?.({ phase: 'saving' })
  // 원본 먼저 — 문서만 저장되고 원본이 없으면 정독뷰가 아무것도 못 그린다.
  await savePdfBlob(doc.id, file)
  await saveDocument(doc)

  // 가져오기가 끝나면 문서를 닫는다 — 대용량 PDF 를 연달아 추가할 때 자원이 쌓이지 않게.
  void close()
  return doc
}

/** 이 문서가 "보기 전용"인가 — 텍스트 레이어가 없어 낭독할 내용이 없는 스캔본. */
export function isViewOnly(doc: StoredDocument): boolean {
  return !doc.chunks || doc.chunks.filter((c) => c.kind === 'speech').length === 0
}
