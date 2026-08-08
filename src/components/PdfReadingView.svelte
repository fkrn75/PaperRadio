<script lang="ts">
  /**
   * 정독뷰 — 원본 PDF 페이지를 그대로 렌더한다(연속 스크롤).
   *
   * 설계 요지
   *  1) **페이지 가상화가 필수.** A4 를 DPR 2 로 그리면 페이지당 약 7.6MB 다. 20쪽만 상주해도
   *     150MB 라 모바일에서 무너진다. 보이는 범위 밖 페이지는 `canvas.width = 0` 으로
   *     픽셀 버퍼를 즉시 반환한다(요소는 남겨 자리와 스크롤 위치를 유지).
   *  2) **렌더는 한 번에 하나씩.** 자매 프로젝트에서 모바일 GPU 가 동시 추론을 못 버티고
   *     멈추는 걸 겪었다. 페이지 렌더도 같은 위험이 있어 promise 체인으로 직렬화한다.
   *  3) **자리 예약.** pageRanges 에 담아 둔 페이지 크기로 aspect-ratio 를 미리 잡아,
   *     렌더 전후로 높이가 변하지 않게 한다(스크롤 튐 방지).
   *  4) **재생 중 페이지는 언로드하지 않는다.** canvas 를 해제하면 그 위에 얹을 텍스트 레이어와
   *     하이라이트도 사라진다(Phase 3 대비).
   */
  import { getPdfBlob } from '../lib/db/idb'
  import { openPdf, type PdfDocument } from '../lib/pdf/loader'
  import { computePageSpanOffsets, type PdfPageInput } from '../lib/pdf/extract'
  import { chunkIndexForOffset, pageForChunk } from '../lib/locate'
  import type { Chunk, PdfMeta } from '../lib/types'
  import ReadingControls from './ReadingControls.svelte'

  interface Props {
    docId: string
    pdf: PdfMeta
    /** offset 좌표계의 기준. 텍스트 레이어 span 위치를 복원하는 데 쓴다. */
    rawText: string
    chunks: Chunk[]
    /** 재생 중인 청크(하이라이트 대상). */
    currentChunkIndex?: number
    playing?: boolean
    onTogglePlay?: () => void
    /** 문장 클릭 → 그 청크로 이동. */
    onSeek?: (chunkIndex: number) => void
    /** 문장 더블클릭 → 그 청크부터 즉시 재생. */
    onSeekPlay?: (chunkIndex: number) => void
    repeatMode?: 'off' | 'one' | 'ab'
    abStart?: number | null
    abEnd?: number | null
    onToggleRepeatOne?: () => void
    onAbButton?: () => void
  }
  const {
    docId,
    pdf,
    rawText,
    chunks,
    currentChunkIndex,
    playing = false,
    onTogglePlay,
    onSeek,
    onSeekPlay,
    repeatMode = 'off',
    abStart = null,
    abEnd = null,
    onToggleRepeatOne,
    onAbButton,
  }: Props = $props()

  /** 재생 중인 페이지(1-based). 가상화에서 제외해 하이라이트가 사라지지 않게 한다. */
  const activePage = $derived(
    typeof currentChunkIndex === 'number' ? pageForChunk(pdf.pageRanges, chunks, currentChunkIndex) : 0,
  )

  /** 현재 재생 중인 청크가 원문에서 차지하는 범위(하이라이트 대상). */
  const currentRange = $derived.by(() => {
    if (typeof currentChunkIndex !== 'number') return null
    const c = chunks[currentChunkIndex]
    if (!c || c.kind === 'silence') return null
    return { start: c.startOffset, end: c.endOffset }
  })

  /** 뷰포트에서 이만큼 떨어진 페이지까지 미리 그린다. */
  const LOAD_MARGIN_PX = 600
  /** 이보다 더 멀어지면 해제. LOAD 보다 넉넉히 잡아 경계에서 떨림(로드↔해제 반복)을 막는다. */
  const UNLOAD_MARGIN_PX = 1500
  /** 모바일 DPR 3 을 그대로 쓰면 픽셀이 2.25배 된다. 2 로 상한. */
  const MAX_DPR = 2

  let container: HTMLDivElement | undefined = $state()
  let doc: PdfDocument | null = $state(null)
  /** 열려 있는 문서를 닫는 함수(워커 자원까지 반환). */
  let closeDoc: (() => Promise<void>) | null = null
  let loadError = $state('')
  let loading = $state(true)
  /** 현재 픽셀이 올라가 있는 페이지 번호들(디버깅·표시용). */
  let residentPages = $state<number[]>([])

  /** 페이지별 호스트 요소(1-based → 요소). */
  const hosts = new Map<number, HTMLDivElement>()
  /** 현재 렌더돼 있는 canvas. */
  const canvases = new Map<number, HTMLCanvasElement>()
  /** 페이지별 텍스트 레이어(투명 span 들). canvas 와 생애주기를 같이한다. */
  const textLayers = new Map<number, HTMLDivElement>()
  /** offset 복원에 실패한 페이지(재시도해도 같으므로 한 번만 시도). */
  const mappingFailed = new Set<number>()
  /** 지금 하이라이트된 span 들(다음 갱신 때 되돌린다). */
  let highlighted: HTMLElement[] = []
  /** 진행 중인 렌더 작업(빠른 스크롤 시 취소용). */
  const tasks = new Map<number, { cancel(): void }>()
  /** 렌더 직렬화 체인 — 동시에 여러 페이지를 그리지 않는다. */
  let renderChain: Promise<void> = Promise.resolve()
  let destroyed = false

  /** pageRanges 에 크기가 없는 옛 문서를 위한 대체 비율(A4). */
  const FALLBACK_RATIO = 842 / 595

  function ratioOf(page: number): number {
    const r = pdf.pageRanges.find((x) => x.page === page)
    if (r?.width && r?.height) return r.height / r.width
    return FALLBACK_RATIO
  }

  // ── 원본 PDF 열기 ──
  $effect(() => {
    let cancelled = false
    void (async () => {
      loading = true
      loadError = ''
      try {
        const blob = await getPdfBlob(docId)
        if (!blob) {
          loadError = '원본 PDF를 찾을 수 없습니다. 문서를 다시 추가해 주세요.'
          return
        }
        const buf = await blob.arrayBuffer()
        const opened = await openPdf(buf)
        if (cancelled) {
          void opened.close()
          return
        }
        doc = opened.doc
        closeDoc = opened.close
      } catch (e) {
        loadError = `원본을 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`
      } finally {
        if (!cancelled) loading = false
      }
    })()
    return () => {
      cancelled = true
    }
  })

  // ── 정리: 컴포넌트가 사라질 때 진행 중 렌더·픽셀·워커 자원을 모두 반환 ──
  $effect(() => {
    return () => {
      destroyed = true
      for (const t of tasks.values()) t.cancel()
      tasks.clear()
      for (const [, c] of canvases) {
        c.width = 0
        c.height = 0
        c.remove()
      }
      canvases.clear()
      for (const [, l] of textLayers) l.remove()
      textLayers.clear()
      highlighted = []
      if (clickTimer) clearTimeout(clickTimer)
      void closeDoc?.()
      closeDoc = null
    }
  })

  /** 한 페이지를 그린다. 이미 있으면 아무것도 하지 않는다. */
  async function renderPage(page: number): Promise<void> {
    const host = hosts.get(page)
    if (!doc || !host || destroyed || canvases.has(page)) return
    // 큐에서 대기하는 사이 화면 밖으로 나갔으면 그리지 않는다(빠른 스크롤).
    if (page !== activePage && isFarOutside(host)) return

    const p = await doc.getPage(page)
    // 레이아웃이 확정된 뒤에 폭을 읽는다. 탭 전환 직후처럼 아직 자리를 잡지 못한 시점에
    // clientWidth 를 읽으면 실제보다 작게 나와 그만큼 흐린 해상도로 굳어버린다(실측 -10%).
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (destroyed || canvases.has(page)) return

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const base = p.getViewport({ scale: 1 })
    const cssWidth = host.clientWidth || 1
    const cssScale = cssWidth / base.width
    const viewport = p.getViewport({ scale: cssScale * dpr })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    canvas.className = 'page-canvas'
    host.appendChild(canvas)
    canvases.set(page, canvas)

    const task = p.render({ canvas, viewport })
    tasks.set(page, task)
    try {
      await task.promise
      // 원본 위에 투명 텍스트를 얹는다 — 하이라이트와 클릭 재생의 실체.
      await buildTextLayer(page, p, cssScale, host)
      applyHighlight()
    } catch {
      // 취소(cancel)도 여기로 온다 — 흔적을 남기지 않고 되돌린다.
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      canvases.delete(page)
    } finally {
      tasks.delete(page)
      p.cleanup()
      residentPages = [...canvases.keys()].sort((a, b) => a - b)
    }
  }

  /**
   * 페이지 위에 투명 텍스트 레이어를 만든다. 각 span 에 rawText 기준 offset 을 심어,
   * "재생 위치 → 하이라이트"와 "클릭 → 재생"이 **좌표 계산 없이** 성립하게 한다.
   *
   * offset 복원에 실패하면(추출 규칙 변경 등) 레이어를 만들지 않는다 — 페이지 보기는
   * 그대로 유지되고 폐루프 기능만 조용히 빠진다(잘못된 위치로 점프하는 것보다 낫다).
   */
  async function buildTextLayer(
    page: number,
    p: Awaited<ReturnType<PdfDocument['getPage']>>,
    cssScale: number,
    host: HTMLElement,
  ): Promise<void> {
    if (textLayers.has(page) || mappingFailed.has(page) || chunks.length === 0) return
    const range = pdf.pageRanges.find((r) => r.page === page)
    if (!range) return

    const tc = await p.getTextContent()
    const items: PdfPageInput['items'] = []
    for (const it of tc.items) {
      if (typeof (it as { str?: unknown }).str === 'string') items.push(it as PdfPageInput['items'][number])
    }
    if (items.length === 0) return

    const base = p.getViewport({ scale: 1 })
    const offsets = computePageSpanOffsets(
      { page, items, width: base.width, height: base.height },
      rawText,
      range,
      pdf.runningHeads,
      pdf.bodySize ?? 0,
    )
    if (!offsets) {
      mappingFailed.add(page)
      return
    }

    const byItem = new Map(offsets.map((o) => [o.itemIndex, o]))
    const vp = p.getViewport({ scale: cssScale })
    const layer = document.createElement('div')
    layer.className = 'text-layer'

    items.forEach((it, i) => {
      const off = byItem.get(i)
      if (!off || it.str === '') return
      // PDF 좌표(아래가 0) → 화면 좌표. 얻은 y 는 글자 밑선이라 글자 높이만큼 올린다.
      const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5])
      const fs = (it.height || Math.abs(it.transform[3]) || 12) * cssScale
      const span = document.createElement('span')
      span.textContent = it.str
      span.dataset.start = String(off.start)
      span.dataset.end = String(off.end)
      span.style.cssText =
        `left:${vx.toFixed(2)}px;top:${(vy - fs).toFixed(2)}px;` +
        `font-size:${fs.toFixed(2)}px;min-width:${(it.width * cssScale).toFixed(2)}px`
      layer.appendChild(span)
    })

    host.appendChild(layer)
    textLayers.set(page, layer)
  }

  /** 렌더 요청을 직렬 큐에 넣는다(동시 렌더 금지). */
  function enqueue(page: number): void {
    renderChain = renderChain.then(() => renderPage(page)).catch(() => {})
  }

  /** 픽셀 버퍼 반환. 요소와 예약 높이는 유지해 스크롤이 흔들리지 않게 한다. */
  function releasePage(page: number): void {
    tasks.get(page)?.cancel()
    tasks.delete(page)
    const c = canvases.get(page)
    if (!c) return
    c.width = 0
    c.height = 0
    c.remove()
    canvases.delete(page)
    // 텍스트 레이어도 함께 — 원본 그림 없이 남으면 보이지 않는 클릭 영역만 떠다닌다.
    textLayers.get(page)?.remove()
    textLayers.delete(page)
    highlighted = highlighted.filter((el) => el.isConnected)
    residentPages = [...canvases.keys()].sort((a, b) => a - b)
  }

  /**
   * 재생 중인 청크에 걸치는 span 을 **모두** 칠한다.
   *
   * ⚠️ 한 문장이 여러 span 에 걸린다 — PDF 텍스트는 시각적 줄 단위로 쪼개져 있어서,
   * "가장 좁은 요소 하나"만 고르면 문장의 한 줄만 하이라이트된다.
   */
  function applyHighlight(): void {
    for (const el of highlighted) el.classList.remove('cur')
    highlighted = []
    const r = currentRange
    if (!r || !container) return
    const spans = container.querySelectorAll<HTMLElement>('.text-layer span[data-start]')
    for (const s of spans) {
      const st = Number(s.dataset.start)
      const en = Number(s.dataset.end)
      if (en > r.start && st < r.end) {
        s.classList.add('cur')
        highlighted.push(s)
      }
    }
  }

  // 재생 위치가 바뀌면 하이라이트를 갱신하고, 재생 중이면 화면이 따라간다.
  $effect(() => {
    void currentRange
    applyHighlight()
    if (!playing) return
    const first = highlighted[0]
    // block:'nearest' — 이미 보이면 움직이지 않는다(읽는 흐름을 덜 방해).
    first?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  // ── 클릭/더블클릭 재생 ──
  let clickTimer: ReturnType<typeof setTimeout> | null = null

  function seekFrom(el: HTMLElement): void {
    const idx = chunkIndexForOffset(chunks, Number(el.dataset.start))
    if (idx >= 0) onSeek?.(idx)
  }

  function handleClick(e: MouseEvent): void {
    if (e.detail > 1) return // 더블클릭의 첫 클릭은 무시
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-start]')
    if (!t) return
    if (clickTimer) clearTimeout(clickTimer)
    // 더블클릭과 겹치지 않게 잠깐 기다렸다가 이동한다.
    clickTimer = setTimeout(() => {
      clickTimer = null
      seekFrom(t)
    }, 250)
  }

  function handleDblClick(e: MouseEvent): void {
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = null
    }
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-start]')
    if (!t) return
    // 더블클릭이 만든 텍스트 선택을 지운다(투명 글자라 선택이 보이면 지저분하다).
    window.getSelection()?.removeAllRanges()
    const idx = chunkIndexForOffset(chunks, Number(t.dataset.start))
    if (idx >= 0) onSeekPlay?.(idx)
  }

  /** 언로드 마진 밖인가(히스테리시스의 바깥쪽 문턱). */
  function isFarOutside(el: HTMLElement): boolean {
    if (!container) return false
    const r = el.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    return r.bottom < c.top - UNLOAD_MARGIN_PX || r.top > c.bottom + UNLOAD_MARGIN_PX
  }

  // ── 가시성 관찰: 들어오면 그리고, 충분히 멀어지면 해제 ──
  $effect(() => {
    if (!container || !doc) return
    const root = container

    // IO 미지원 환경 안전망: 가상화를 끄면 대용량 문서에서 메모리가 터지므로,
    // 여기서는 앞쪽 몇 쪽만 그리고 나머지는 스크롤 이벤트로 처리한다.
    if (typeof IntersectionObserver === 'undefined') {
      for (let i = 1; i <= Math.min(3, pdf.pageCount); i++) enqueue(i)
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const page = Number((e.target as HTMLElement).dataset.page)
          if (!page) continue
          if (e.isIntersecting) enqueue(page)
          else if (page !== activePage && isFarOutside(e.target as HTMLElement)) releasePage(page)
        }
      },
      { root, rootMargin: `${LOAD_MARGIN_PX}px 0px`, threshold: 0 },
    )
    for (const el of hosts.values()) io.observe(el)
    return () => io.disconnect()
  })

  /**
   * 스크롤 안전망 — IntersectionObserver 가 놓친 언로드를 주기적으로 쓸어 담는다.
   *
   * 왜 필요한가: 북마크 점프나 페이지 이동처럼 **스크롤이 순간 이동**하면 중간 요소들이
   * 교차 이벤트를 제대로 내지 못해 화면 밖 페이지의 픽셀이 남는다(실측: 12쪽 문서를 끝까지
   * 점프했을 때 앞쪽 두 쪽이 남았다). 긴 문서에서 이 누수가 쌓이면 메모리가 위험하다.
   */
  $effect(() => {
    if (!container) return
    const root = container
    let pending = false
    const sweep = (): void => {
      pending = false
      for (const page of [...canvases.keys()]) {
        if (page === activePage) continue
        const host = hosts.get(page)
        if (host && isFarOutside(host)) releasePage(page)
      }
    }
    const onScroll = (): void => {
      if (pending) return
      pending = true
      setTimeout(sweep, 200) // 스크롤이 멎은 뒤 한 번만
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  })

  // ── 재생 중 페이지는 항상 살려 둔다 ──
  // canvas 를 해제하면 그 위의 텍스트 레이어·하이라이트도 함께 사라지기 때문이다.
  $effect(() => {
    if (activePage > 0 && doc && !canvases.has(activePage)) enqueue(activePage)
  })

  /**
   * 슬롯 폭 ↔ canvas 해상도 정합 감시.
   *
   * 컨테이너가 아니라 **각 페이지 슬롯**을 관찰한다. 그래야 창 크기 변경뿐 아니라,
   * 레이아웃이 늦게 잡혀 렌더 당시 폭이 실제보다 작았던 경우까지 함께 잡힌다
   * (실측: 탭 전환 직후 첫 렌더가 슬롯보다 10% 작은 해상도로 굳었다).
   * 어긋난 페이지만 골라 다시 그리므로 멀쩡한 페이지는 건드리지 않는다.
   */
  $effect(() => {
    if (!container) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stale = new Set<number>()

    const ro = new ResizeObserver((entries) => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      for (const e of entries) {
        const page = Number((e.target as HTMLElement).dataset.page)
        const c = canvases.get(page)
        if (!page || !c || !c.width) continue
        const expected = Math.floor(e.contentRect.width * dpr)
        // 5% 넘게 어긋날 때만 — 소수점 반올림 차이로 계속 다시 그리는 걸 막는다.
        if (expected > 0 && Math.abs(c.width - expected) > expected * 0.05) stale.add(page)
      }
      if (stale.size === 0) return
      if (timer) clearTimeout(timer)
      // 드래그 리사이즈 중 매 프레임 재렌더하지 않도록 잠깐 모은다.
      timer = setTimeout(() => {
        const pages = [...stale]
        stale.clear()
        for (const p of pages) releasePage(p)
        for (const p of pages) enqueue(p)
      }, 250)
    })
    for (const el of hosts.values()) ro.observe(el)
    return () => {
      if (timer) clearTimeout(timer)
      ro.disconnect()
    }
  })
</script>

{#if chunks.length > 0 && onTogglePlay}
  <ReadingControls
    {playing}
    {onTogglePlay}
    {repeatMode}
    {abStart}
    {abEnd}
    onToggleRepeatOne={onToggleRepeatOne ?? (() => {})}
    onAbButton={onAbButton ?? (() => {})}
    status={activePage ? `${activePage}쪽 재생 중` : ''}
  />
{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="reading" bind:this={container} onclick={handleClick} ondblclick={handleDblClick}>
  {#if loading}
    <p class="state">원본을 여는 중…</p>
  {:else if loadError}
    <p class="state err">{loadError}</p>
  {/if}

  {#each Array.from({ length: pdf.pageCount }, (_, i) => i + 1) as page (page)}
    <div
      class="page"
      class:active={page === activePage}
      data-page={page}
      style:aspect-ratio="1 / {ratioOf(page)}"
      bind:this={
        () => hosts.get(page) as HTMLDivElement,
        (el) => {
          if (el) hosts.set(page, el)
          else hosts.delete(page)
        }
      }
    >
      <span class="page-no">{page}</span>
    </div>
  {/each}
</div>

<p class="hint">
  {pdf.pageCount}쪽 · 화면에 보이는 페이지만 그립니다{residentPages.length
    ? ` (현재 ${residentPages.length}쪽 상주)`
    : ''}
</p>

<style>
  .reading {
    max-height: 70vh;
    overflow-y: auto;
    background: var(--surface, #f4f6fa);
    border: 1px solid var(--border, #e3e7ef);
    border-radius: 10px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overscroll-behavior: contain;
  }
  .page {
    position: relative;
    width: 100%;
    background: #fff;
    border: 1px solid var(--border, #e3e7ef);
    border-radius: 4px;
    overflow: hidden;
    /*
     * 렌더 전에도 자리를 차지하도록 aspect-ratio 로 높이를 예약한다(스크롤 튐 방지).
     * ⚠️ flex 아이템은 기본 flex-shrink:1 이라, 컨테이너(max-height:70vh)를 넘는 순간
     *    모든 페이지가 균등하게 짜부라진다(실측: 예약 높이가 29px 로 붕괴). 세로 스크롤을
     *    쓰려면 반드시 축소를 꺼야 한다.
     */
    flex: 0 0 auto;
  }
  .page.active {
    outline: 2px solid #2b4c8c;
    outline-offset: -1px;
  }
  .page-no {
    position: absolute;
    top: 0.4rem;
    right: 0.55rem;
    font-size: 0.7rem;
    color: var(--muted, #9aa3b2);
    pointer-events: none;
  }
  .page :global(canvas.page-canvas) {
    display: block;
    width: 100%;
    height: auto;
  }

  /*
   * 텍스트 레이어 — 원본 그림 위에 얹는 투명 글자.
   * 글자는 보이지 않고(색이 투명) 배경만 칠해 형광펜처럼 하이라이트한다.
   * 클릭 대상이기도 하므로 pointer-events 는 살려 둔다.
   */
  .page :global(.text-layer) {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
  }
  .page :global(.text-layer span) {
    position: absolute;
    white-space: pre;
    color: transparent;
    transform-origin: 0 0;
    cursor: pointer;
    border-radius: 2px;
    /* 클릭 판정을 조금 넉넉하게 — 글자 높이가 얇은 줄도 누르기 쉽게. */
    padding: 0.05em 0;
  }
  .page :global(.text-layer span.cur) {
    background: var(--highlight, rgba(255, 208, 0, 0.38));
  }
  .state {
    margin: 0;
    padding: 1rem;
    text-align: center;
    font-size: 0.88rem;
    color: var(--muted, #4a5568);
  }
  .state.err {
    color: #c0392b;
  }
  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--muted, #4a5568);
    text-align: right;
  }
</style>
