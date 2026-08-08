/**
 * 플랫폼 감지 유틸 — 엔진 내부 플랫폼 분기용(예: AudioContext resume 보장).
 *
 * iOS(아이폰/아이패드)는 사용자 제스처 없이는 AudioContext 가 suspended 로 시작하고,
 * iPadOS 13+ 는 데스크탑 Safari 처럼 위장(navigator.platform === 'MacIntel')하므로
 * maxTouchPoints 로 터치 기기를 구분한다.
 */

/** iOS(아이패드 포함) 감지 — AudioContext resume 보장 등 플랫폼 분기용 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/**
 * 모바일(안드로이드·iOS 등 폰/태블릿) 감지.
 * 무거운 GPU 추론(예: Supertonic 12스텝)이 모바일 GPU 워치독을 넘겨 hang 하는 것을 막기 위해
 * '안전 상한' 적용 등에 쓴다. 터치 데스크탑 오탐을 피하려 maxTouchPoints 단독이 아닌
 * userAgent(Android/Mobile 등)+iOS 로 판별한다.
 */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOS() || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}
