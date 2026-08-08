/**
 * 디버그 모드 플래그.
 *
 * 프로덕션(배포본)에서도 폰에서 무슨 일이 일어나는지 보려면 화면 로그가 필요하다.
 * URL 에 `?debug=1` 이 한 번이라도 들어오면 localStorage 에 박아두고, 이후 새로고침/PWA
 * 재방문에도 유지한다. `?debug=0` 으로 끈다. import.meta.env.DEV 면 항상 켜진 것으로 본다.
 *
 * 주의: 이 모듈은 부작용 없는 순수 판별만 한다. URL→localStorage 반영은 main.ts 가 부팅 때 1회.
 */
const KEY = 'mr_debug'
const FORCE_WASM_KEY = 'mr_force_wasm'
const AUTO_RECOVER_KEY = 'mr_auto_recover'

/** URL 파라미터 1개를 localStorage 키에 반영(=1 켜기 / =0 끄기). */
function syncOne(q: URLSearchParams, param: string, key: string): void {
  const v = q.get(param)
  if (v === '1') localStorage.setItem(key, '1')
  else if (v === '0') localStorage.removeItem(key)
}

/** main.ts 부팅 시 1회 호출 — URL 의 ?debug/?wasm/?autorecover 를 localStorage 에 반영한다. */
export function syncDebugFlagFromUrl(): void {
  if (typeof location === 'undefined' || typeof localStorage === 'undefined') return
  const q = new URLSearchParams(location.search)
  syncOne(q, 'debug', KEY)
  syncOne(q, 'wasm', FORCE_WASM_KEY)
  syncOne(q, 'autorecover', AUTO_RECOVER_KEY)
}

/** URL(즉시) 또는 localStorage(유지)로 켜진 플래그인지 공통 판정. */
function flagOn(param: string, key: string): boolean {
  try {
    if (typeof location !== 'undefined') {
      const v = new URLSearchParams(location.search).get(param)
      if (v === '1') return true
      if (v === '0') return false
    }
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/**
 * ?wasm=1 — 처음부터 WASM(CPU) EP 로 로드(WebGPU 건너뜀).
 * 폰에서 WASM 합성이 실제로 소리를 내는지/속도를 직접 검증하는 디버그 스위치(자동복구의 전제 확인).
 */
export function isForceWasm(): boolean {
  return flagOn('wasm', FORCE_WASM_KEY)
}

/**
 * ?autorecover=1 — 합성 hang 감지 시 자동복구(워커 재생성+WASM) 활성화.
 * 기본 OFF: 폰 WASM 로드가 느리거나 hang 하면 복구 대기 중 재생이 영구 정지하는 역효과가 있어,
 * WASM viability(`?wasm=1`)를 먼저 검증한 뒤에만 켠다.
 */
export function isAutoRecover(): boolean {
  return flagOn('autorecover', AUTO_RECOVER_KEY)
}

/** 디버그 모드 여부(DEV 이거나 ?debug=1 로 켠 경우). */
export function isDebug(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
