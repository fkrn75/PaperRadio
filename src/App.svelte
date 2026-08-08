<script lang="ts">
  /**
   * Phase 0 스파이크 — 본 구현 전에 "가장 불확실한 것"만 실측한다.
   *
   * 검증 항목:
   *  1) pdf.js 워커가 뜨고 PDF 를 열 수 있는가 (Vite worker.format:'es' 환경)
   *  2) 합성 워커(supertonic.worker)와 pdf 워커가 **공존**하는가
   *  3) getTextContent 의 item 이 CleanPiece(plain/srcStart/srcEnd)에 1:1 대응 가능한가
   *  4) 페이지 canvas 렌더 메모리 — 여러 장을 띄우면 어디서 무너지는가
   *
   * ⚠️ 이 화면은 검증용 임시 UI다. Phase 1 부터 실제 앱 구조로 대체된다.
   */
  import { openPdf } from './lib/pdf/loader'

  type Line = { t: string; kind: 'info' | 'ok' | 'err' }
  let lines = $state<Line[]>([])
  const log = (t: string, kind: Line['kind'] = 'info') => {
    lines = [...lines, { t, kind }]
    console.log(`[spike] ${t}`)
  }

  let pdfDoc = $state<Awaited<ReturnType<typeof openPdf>> | null>(null)
  let fileName = $state('')
  let pageCount = $state(0)
  let busy = $state(false)
  let pagesHost = $state<HTMLDivElement>()
  let renderedCanvases: HTMLCanvasElement[] = []

  /** JS 힙 사용량(Chrome 계열만 노출). canvas 는 네이티브/GPU 라 여기 안 잡힐 수 있어 참고용. */
  function heapMB(): string {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return m ? `${(m.usedJSHeapSize / 1048576).toFixed(1)}MB` : 'n/a'
  }

  async function openBuffer(buf: ArrayBuffer, name: string): Promise<void> {
    busy = true
    releaseAll()
    lines = []
    fileName = name
    try {
      log(`파일: ${name} (${(buf.byteLength / 1048576).toFixed(2)}MB)`)
      const t0 = performance.now()
      // ⚠️ pdf.js 는 넘긴 버퍼를 transfer 해 detach 시킨다 → 원본 보관용으로 복제해 넘긴다.
      pdfDoc = await openPdf(buf.slice(0))
      pageCount = pdfDoc.numPages
      log(`✅ ① pdf.js 워커 동작 — ${pageCount}쪽, ${(performance.now() - t0).toFixed(0)}ms`, 'ok')
      await inspectText(1)
    } catch (err) {
      log(`❌ PDF 열기 실패: ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      busy = false
    }
  }

  async function onPick(e: Event): Promise<void> {
    const file = (e.currentTarget as HTMLInputElement).files?.[0]
    if (!file) return
    await openBuffer(await file.arrayBuffer(), file.name)
  }

  /** 재현 가능한 검증용 — tools/make-sample-pdf.mjs 로 만든 12쪽 픽스처. */
  async function loadSample(): Promise<void> {
    try {
      const res = await fetch('/samples/sample.pdf')
      await openBuffer(await res.arrayBuffer(), 'sample.pdf (픽스처)')
    } catch (err) {
      log(`❌ 샘플 로드 실패: ${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  /** ③ 텍스트 item 구조 확인 — CleanPiece 대응 가능성 판단 */
  async function inspectText(pageNo: number): Promise<void> {
    if (!pdfDoc) return
    const page = await pdfDoc.getPage(pageNo)
    const tc = await page.getTextContent()
    const items = tc.items.filter((it): it is Extract<typeof it, { str: string }> => 'str' in it)
    if (items.length === 0) {
      log(`⚠️ ${pageNo}쪽 텍스트 item 0개 — 스캔본(이미지)일 가능성. 보기 전용 대상.`, 'err')
      return
    }
    // rawText 조립 시뮬레이션: item 을 이어붙이며 각 item 의 [srcStart, srcEnd) 를 기록
    let raw = ''
    const pieces: { plain: string; srcStart: number; srcEnd: number }[] = []
    for (const it of items) {
      const srcStart = raw.length
      raw += it.str
      pieces.push({ plain: it.str, srcStart, srcEnd: raw.length })
      if ((it as { hasEOL?: boolean }).hasEOL) raw += '\n'
    }
    // 불변식 예행: 모든 piece 가 raw.slice 와 정확히 일치해야 한다
    const bad = pieces.filter((p) => raw.slice(p.srcStart, p.srcEnd) !== p.plain).length
    log(`✅ ③ ${pageNo}쪽 텍스트 item ${items.length}개 → ${raw.length}자 조립`, 'ok')
    log(`   offset 정합 ${bad === 0 ? 'OK (전건 일치)' : `❌ 불일치 ${bad}건`}`, bad === 0 ? 'ok' : 'err')
    log(`   첫 item transform: [${items[0].transform.map((n: number) => n.toFixed(1)).join(', ')}]`)
    log(`   미리보기: ${raw.slice(0, 90).replace(/\n/g, '⏎')}…`)
  }

  /** ④ 페이지 렌더 — DPR 캡 적용. count 장을 연속 렌더해 메모리를 관찰한다. */
  async function renderPages(count: number): Promise<void> {
    if (!pdfDoc || !pagesHost) return
    busy = true
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const n = Math.min(count, pdfDoc.numPages)
    log(`④ ${n}쪽 렌더 시작 (DPR 캡 ${dpr}) — 힙 ${heapMB()}`)
    const t0 = performance.now()
    try {
      for (let i = 1; i <= n; i++) {
        const page = await pdfDoc.getPage(i)
        const viewport = page.getViewport({ scale: dpr })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
        pagesHost.appendChild(canvas)
        renderedCanvases.push(canvas)
        await page.render({ canvas, viewport }).promise
      }
      const mb = renderedCanvases.reduce((s, c) => s + (c.width * c.height * 4) / 1048576, 0)
      log(`✅ ④ ${n}쪽 렌더 완료 — ${(performance.now() - t0).toFixed(0)}ms`, 'ok')
      log(`   canvas 픽셀 메모리 추정 ${mb.toFixed(1)}MB · 힙 ${heapMB()}`)
    } catch (err) {
      log(`❌ 렌더 실패: ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      busy = false
    }
  }

  /** 가상화 예행: canvas.width=0 으로 픽셀 버퍼를 즉시 반환시킨다. */
  function releaseAll(): void {
    for (const c of renderedCanvases) {
      c.width = 0
      c.height = 0
      c.remove()
    }
    if (renderedCanvases.length > 0) log(`🧹 canvas ${renderedCanvases.length}장 해제 — 힙 ${heapMB()}`)
    renderedCanvases = []
  }

  /** ② 합성 워커 공존 — pdf 워커가 떠 있는 상태에서 supertonic 워커를 생성해 본다. */
  let synthWorker: Worker | null = null
  function spawnSynthWorker(): void {
    try {
      if (synthWorker) {
        synthWorker.terminate()
        synthWorker = null
      }
      synthWorker = new Worker(new URL('./lib/engine/supertonic.worker.ts', import.meta.url), {
        type: 'module',
      })
      synthWorker.onerror = (e) => log(`❌ ② 합성 워커 오류: ${e.message}`, 'err')
      synthWorker.onmessage = (e) => log(`   합성 워커 응답: ${JSON.stringify(e.data).slice(0, 80)}`)
      log(`✅ ② 합성 워커 생성 성공 — pdf 워커와 공존 (동시 ${pdfDoc ? 2 : 1}개)`, 'ok')
    } catch (err) {
      log(`❌ ② 합성 워커 생성 실패: ${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }
</script>

<main>
  <header>
    <h1>PaperRadio <span class="tag">Phase 0 스파이크</span></h1>
    <p class="sub">본 구현 전 리스크 실측 — pdf 워커 · 합성 워커 공존 · 텍스트 offset · 렌더 메모리</p>
  </header>

  <div class="row">
    <button class="btn primary" onclick={loadSample} disabled={busy}>샘플 PDF 열기</button>
    <label class="btn">
      PDF 선택
      <input type="file" accept=".pdf,application/pdf" onchange={onPick} hidden disabled={busy} />
    </label>
    <button class="btn" onclick={spawnSynthWorker} disabled={busy}>② 합성 워커 생성</button>
    <button class="btn" onclick={() => renderPages(1)} disabled={!pdfDoc || busy}>④ 1쪽 렌더</button>
    <button class="btn" onclick={() => renderPages(10)} disabled={!pdfDoc || busy}>④ 10쪽 렌더</button>
    <button class="btn" onclick={releaseAll} disabled={busy}>🧹 해제</button>
  </div>

  {#if fileName}
    <p class="meta">{fileName} · {pageCount}쪽</p>
  {/if}

  <section class="log">
    {#each lines as l (l)}
      <div class={l.kind}>{l.t}</div>
    {:else}
      <div class="info">PDF 를 선택하면 검증이 시작됩니다.</div>
    {/each}
  </section>

  <div class="pages" bind:this={pagesHost}></div>
</main>

<style>
  main {
    max-width: 860px;
    margin: 0 auto;
    padding: 1.25rem 1rem 4rem;
  }
  header {
    margin-bottom: 1rem;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0 0 0.25rem;
  }
  .tag {
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--surface, #eef2fb);
    color: var(--muted, #4a5568);
    vertical-align: middle;
  }
  .sub {
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted, #4a5568);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 1rem 0;
  }
  .btn {
    font: inherit;
    font-size: 0.88rem;
    padding: 0.45rem 0.85rem;
    border-radius: 8px;
    border: 1px solid var(--border, #e3e7ef);
    background: var(--surface, #fff);
    color: var(--text, #1c2230);
    cursor: pointer;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.primary {
    background: #2b4c8c;
    border-color: #2b4c8c;
    color: #fff;
  }
  .meta {
    font-size: 0.85rem;
    color: var(--muted, #4a5568);
    margin: 0 0 0.5rem;
  }
  .log {
    font: 12px/1.6 ui-monospace, monospace;
    background: var(--surface, #f4f6fa);
    border: 1px solid var(--border, #e3e7ef);
    border-radius: 8px;
    padding: 0.7rem 0.85rem;
    white-space: pre-wrap;
    word-break: break-all;
    min-height: 6rem;
  }
  .log .ok {
    color: #1f7a4d;
  }
  .log .err {
    color: #c0392b;
  }
  .log .info {
    color: var(--muted, #4a5568);
  }
  .pages {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .pages :global(canvas) {
    border: 1px solid var(--border, #e3e7ef);
    border-radius: 4px;
    background: #fff;
  }
</style>
