/**
 * dev 전용 화면 콘솔 오버레이.
 *
 * 모바일(안드로이드 크롬 등)은 데스크탑처럼 DevTools 콘솔을 보기 어렵다.
 * 이 모듈은 console.log/info/warn/error 와 전역 에러를 가로채 화면 하단에
 * 그대로 출력해, 원격 디버깅 없이도 폰에서 로그를 읽을 수 있게 한다.
 *
 * import.meta.env.DEV 일 때만 main.ts 에서 동적 import 하므로 프로덕션엔 포함되지 않는다.
 */
export function installDebugOverlay(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('__dbg_overlay')) return // 중복 설치 방지

  const box = document.createElement('div')
  box.id = '__dbg_overlay'
  // ⚠️ box 는 pointer-events:none — 로그가 화면 하단을 덮어도 클릭이 '밑의 앱(재생 버튼 등)'으로
  //    그대로 통과한다(로그창 때문에 컨트롤을 못 누르는 문제 방지). 아래 툴바 버튼만 auto 로 되살린다.
  box.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;max-height:42vh;overflow:auto;z-index:99999;' +
    'background:rgba(0,0,0,.85);color:#9f9;font:11px/1.45 ui-monospace,monospace;' +
    'padding:6px 8px;white-space:pre-wrap;word-break:break-all;border-top:1px solid #333;' +
    'pointer-events:none'

  // 상단 툴바(지우기/닫기). box 는 클릭 통과이지만 이 버튼들만 pointer-events:auto 로 탭 가능.
  const bar = document.createElement('div')
  bar.style.cssText =
    'position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;' +
    'gap:6px;margin-bottom:4px;color:#888'
  const label = document.createElement('span')
  label.textContent = '— debug log —'
  const btns = document.createElement('span')
  btns.style.cssText = 'display:flex;gap:6px'
  const mkBtn = (text: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = text
    b.style.cssText =
      'pointer-events:auto;background:#222;color:#ccc;border:1px solid #444;border-radius:4px;' +
      'font:11px ui-monospace,monospace;padding:3px 10px'
    return b
  }
  const clearBtn = mkBtn('지우기')
  clearBtn.onclick = () => box.querySelectorAll('.l').forEach((n) => n.remove())
  const hideBtn = mkBtn('✕ 닫기')
  hideBtn.onclick = () => box.remove() // 이 세션 동안 오버레이 제거(다시 보려면 새로고침)
  btns.append(clearBtn, hideBtn)
  bar.append(label, btns)
  box.appendChild(bar)
  document.body.appendChild(box)

  const add = (level: string, args: unknown[]): void => {
    const line = document.createElement('div')
    line.className = 'l'
    line.style.color = level === 'error' ? '#f77' : level === 'warn' ? '#fd6' : '#9f9'
    line.textContent =
      `[${level}] ` +
      args
        .map((a) => {
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a)
          } catch {
            return String(a)
          }
        })
        .join(' ')
    box.appendChild(line)
    box.scrollTop = box.scrollHeight
  }

  for (const lvl of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[lvl].bind(console)
    console[lvl] = (...args: unknown[]): void => {
      orig(...args)
      add(lvl, args)
    }
  }
  window.addEventListener('error', (e) => add('error', ['window.onerror:', e.message]))
  window.addEventListener('unhandledrejection', (e) =>
    add('error', ['unhandledrejection:', String((e as PromiseRejectionEvent).reason)]),
  )
}
