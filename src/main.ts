import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { syncDebugFlagFromUrl, isDebug } from './lib/debug/flag'

// 모바일(안드로이드 등)에서는 콘솔을 보기 어려우므로 화면 하단에 로그 오버레이를 띄운다.
// dev 는 항상, 프로덕션은 URL 에 `?debug=1` 을 한 번 넣으면(이후 localStorage 로 유지) 켜진다.
// → 폰 배포본에서 PDF 렌더/합성이 어디서 멈추는지 화면에서 바로 읽을 수 있다.
syncDebugFlagFromUrl()
if (isDebug()) {
  void import('./lib/debug/overlay').then((m) => m.installDebugOverlay())
}

// dev 전용: 자동화 브라우저는 문서가 항상 hidden 이라 rAF 가 멈춘다 → pdf.js 렌더가 영원히
// 대기해 검증이 불가능해진다. 개발 중에만 setTimeout 으로 대체한다(프로덕션 동작은 무변경).
if (import.meta.env.DEV) {
  void import('./lib/debug/rafShim').then((m) => m.installRafShimForHiddenDoc())
}

mount(App, {
  target: document.getElementById('app')!,
})
