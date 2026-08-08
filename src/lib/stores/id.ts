/**
 * 충돌이 충분히 낮은 임의 식별자 생성기(문서/북마크 id 용).
 * crypto.randomUUID 우선, 미지원 환경은 ts+난수 폴백.
 */
export function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* noop — 폴백으로 진행 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
