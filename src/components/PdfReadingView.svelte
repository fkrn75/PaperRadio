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
  import type { PdfMeta } from '../lib/types'

  interface Props {
    docId: string
    pdf: PdfMeta
    /** 재생 중인 페이지(1-based). 가상화에서 제외해 하이라이트가 사라지지 않게 한다. */
    activePage?: number
  }
  const { docId, pdf, activePage = 0 }: Props = $props()

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
    const viewport = p.getViewport({ scale: (cssWidth / base.width) * dpr })

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
    residentPages = [...canvases.keys()].sort((a, b) => a - b)
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

<div class="reading" bind:this={container}>
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
