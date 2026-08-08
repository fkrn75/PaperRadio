/**
 * pdf.js 지연 로더.
 *
 * pdfjs-dist 는 무겁고(코어 + 워커) PDF 문서를 열 때만 필요하므로 **동적 import** 로 가져온다.
 * vite.config 의 manualChunks 가 이를 단일 'pdf' 청크로 묶고, PWA globIgnores('**\/pdf-*.js')가
 * precache 에서 제외한다 → 앱 첫 설치가 가벼워진다.
 *
 * ⚠️ 워커 경로: pdf.js 는 자체 워커(pdf.worker.mjs)를 별도로 띄운다. Vite 에서는 `?url` 로
 *    정적 자산 URL 을 받아 GlobalWorkerOptions.workerSrc 에 넣는 방식이 안전하다.
 *    (Vite 의 `?worker` 파이프라인을 태우면 pdf.js 가 기대하는 로딩 방식과 어긋난다.)
 *    이 앱은 합성 워커(supertonic.worker.ts)도 함께 쓰므로 두 워커가 공존해야 한다.
 */
type PdfjsModule = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<PdfjsModule> | null = null

/** pdf.js 모듈을 1회만 로드하고 워커 경로를 설정한다(이후 호출은 캐시된 Promise). */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })()
  }
  return pdfjsPromise
}

/** pdf.js 의 문서 핸들. 모듈이 동적 import 라 타입을 이렇게 끌어온다. */
export type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>

export interface OpenedPdf {
  doc: PdfDocument
  /**
   * 문서와 관련 자원(워커 측 페이지 캐시 포함)을 해제한다.
   *
   * ⚠️ `PDFDocumentProxy` 자체에는 destroy 가 없다 — 해제는 **로딩 태스크**의 몫이라
   *    이렇게 함께 돌려준다. 정독뷰처럼 문서를 오래 열어두는 쪽은 반드시 호출할 것
   *    (안 하면 문서를 바꿔 열 때마다 워커 자원이 쌓인다).
   */
  close(): Promise<void>
}

/**
 * ArrayBuffer 로부터 PDF 문서를 연다.
 * ⚠️ pdf.js 는 넘긴 버퍼의 소유권을 가져가(transfer) 호출측 버퍼를 detach 시킬 수 있다.
 *    원본을 나중에 다시 쓸 거라면 호출측에서 slice() 로 복제해 넘길 것.
 */
export async function openPdf(data: ArrayBuffer): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data })
  const doc = await task.promise
  return { doc, close: () => task.destroy() }
}
