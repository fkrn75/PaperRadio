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

/**
 * ArrayBuffer 로부터 PDF 문서를 연다.
 * ⚠️ pdf.js 는 넘긴 버퍼의 소유권을 가져가(transfer) 호출측 버퍼를 detach 시킬 수 있다.
 *    원본을 나중에 다시 쓸 거라면 호출측에서 slice() 로 복제해 넘길 것.
 */
export async function openPdf(data: ArrayBuffer) {
  const pdfjs = await loadPdfjs()
  return pdfjs.getDocument({ data }).promise
}
