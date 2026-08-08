/**
 * dev 전용 — 숨겨진 문서(document.hidden)에서도 requestAnimationFrame 이 돌게 하는 shim.
 *
 * 왜 필요한가:
 *   pdf.js 의 페이지 렌더는 `intent:'print'` 가 아닌 이상 rAF 로 다음 청크를 스케줄한다
 *   (pdf.mjs: `useRequestAnimationFrame: !intentPrint`). 그런데 자동화 브라우저(preview)는
 *   문서가 항상 `hidden` 상태라 rAF 콜백이 실행되지 않는다 → `page.render().promise` 가
 *   영원히 pending 이 되어 **렌더 검증 자체가 불가능**해진다.
 *
 * 프로덕션에는 넣지 않는 이유:
 *   실제 사용자의 백그라운드 탭에서 렌더가 멈추는 것은 **정상이자 바람직한 동작**이다
 *   (보이지도 않는 페이지에 CPU/배터리를 쓰지 않는다). 탭으로 돌아오면 rAF 가 재개되어
 *   렌더가 그대로 이어진다. 그래서 이 shim 은 개발 중 자동 검증 편의만을 위한 것이다.
 *
 * ⚠️ import.meta.env.DEV 가드 아래에서만 호출할 것(main.ts).
 */
export function installRafShimForHiddenDoc(): void {
  if (typeof window === 'undefined') return
  const w = window as Window & { __rafShimInstalled?: boolean }
  if (w.__rafShimInstalled) return
  w.__rafShimInstalled = true

  const origRaf = window.requestAnimationFrame.bind(window)
  const origCancel = window.cancelAnimationFrame.bind(window)

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    // 보이는 상태면 원래 동작 그대로(프레임 동기화 유지).
    if (!document.hidden) return origRaf(cb)
    // 숨김 상태에서만 매크로태스크로 대체 — rAF 가 정지된 환경에서 진행을 보장한다.
    return setTimeout(() => cb(performance.now()), 0) as unknown as number
  }

  // id 공간이 섞이므로 양쪽 모두에 취소를 시도한다(잘못된 id 는 조용히 무시된다).
  window.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id)
    origCancel(id)
  }

  console.log('[dev] rAF shim 설치 — document.hidden 상태에서도 pdf.js 렌더가 진행됩니다')
}
