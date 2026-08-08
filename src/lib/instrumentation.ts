/**
 * FN-13 · 계측 (Instrumentation)
 *
 * "흘려듣기 후 실제로 돌아와 정독하는가"(복귀율)를 측정하기 위한 로컬 계측.
 * 03-functional-spec.md FN-13 이 이벤트·지표 정의의 단일 출처(SSOT)다.
 *
 * 핵심 규칙(MUST):
 *  - 저장은 localStorage 의 ring buffer(상한 초과 시 오래된 이벤트부터 폐기).
 *  - sessionId 는 마지막 이벤트로부터 gap > 30분이면 새로 절단.
 *  - 서버 전송 절대 없음 — 모든 이벤트는 로컬에만 머문다.
 *
 * 타입(EventType / InstrumentationEvent)은 types.ts(계약, SSOT)에만 의존한다.
 */

import type { EventType, InstrumentationEvent } from './types'

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────
/** localStorage 키 */
const STORAGE_KEY = 'mdr_events'
/** ring buffer 상한(초과 시 앞에서 폐기) */
const MAX_EVENTS = 2000
/** 세션 절단 gap(ms) — 30분 */
const SESSION_GAP_MS = 30 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// 환경 안전 헬퍼 (Vite SPA지만 테스트/SSR 환경 대비 방어적으로)
// ─────────────────────────────────────────────────────────────
/** localStorage 가 실제로 쓸 수 있는지(프라이빗 모드·SSR 대비) */
function getStore(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // 일부 브라우저는 접근 자체에서 throw
    return null
  }
}

/** 현재 탭이 보이는 상태인지 — document 부재 시 true(보수적) */
function isVisible(): boolean {
  try {
    if (typeof document === 'undefined') return true
    return document.visibilityState === 'visible'
  } catch {
    return true
  }
}

/** 충돌 적은 임의 식별자(sessionId 용). crypto 우선, 폴백은 ts+난수 */
function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* noop — 폴백으로 진행 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ─────────────────────────────────────────────────────────────
// 저장(ring buffer) 읽기/쓰기
// ─────────────────────────────────────────────────────────────
/** localStorage 에서 이벤트 배열을 읽어온다(손상 시 빈 배열) */
function readRaw(): InstrumentationEvent[] {
  const store = getStore()
  if (!store) return []
  const json = store.getItem(STORAGE_KEY)
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as InstrumentationEvent[]) : []
  } catch {
    // 손상된 데이터는 버린다(계측은 best-effort)
    return []
  }
}

/** 이벤트 배열을 ring buffer 상한 적용 후 저장. 쿼터 초과 시 절반으로 줄여 재시도 */
function writeRaw(events: InstrumentationEvent[]): void {
  const store = getStore()
  if (!store) return
  // 상한 초과분은 앞(오래된 것)부터 폐기
  let trimmed = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(trimmed))
      return
    } catch {
      // QuotaExceededError 등 — 오래된 절반을 더 버리고 재시도
      if (trimmed.length <= 1) return
      trimmed = trimmed.slice(Math.floor(trimmed.length / 2))
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 세션 절단
// ─────────────────────────────────────────────────────────────
/**
 * 새 이벤트의 sessionId 를 결정한다.
 * 마지막 이벤트와의 ts gap 이 30분을 초과하면(또는 첫 이벤트면) 새 세션을 연다.
 */
function resolveSessionId(events: InstrumentationEvent[], now: number): string {
  const last = events.length > 0 ? events[events.length - 1] : undefined
  if (!last) return genId()
  if (now - last.ts > SESSION_GAP_MS) return genId()
  return last.sessionId
}

// ─────────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────────
/**
 * 계측 이벤트 1건을 적재한다(FN-13 envelope 완성).
 * type 만 다르고 envelope(ts/sessionId/visible)는 여기서 채운다.
 *
 * @param type    이벤트 8종 중 하나
 * @param payload docId(필수)·docHash(필수)·chunkIndex(청크 관련 이벤트)
 */
export function logEvent(
  type: EventType,
  payload: { docId: string; docHash: string; chunkIndex?: number },
): void {
  const now = Date.now()
  const events = readRaw()
  const sessionId = resolveSessionId(events, now)

  const ev: InstrumentationEvent = {
    type,
    ts: now,
    sessionId,
    docId: payload.docId,
    docHash: payload.docHash,
    visible: isVisible(),
  }
  // chunkIndex 는 있을 때만 포함(envelope 의 선택 필드)
  if (typeof payload.chunkIndex === 'number') {
    ev.chunkIndex = payload.chunkIndex
  }

  events.push(ev)
  writeRaw(events)
}

/** 적재된 모든 이벤트(시간순) */
export function getEvents(): InstrumentationEvent[] {
  return readRaw()
}

/** 모든 계측 이벤트 삭제(테스트·설정의 "계측 초기화"용) */
export function clearEvents(): void {
  const store = getStore()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    /* noop */
  }
}

// ─────────────────────────────────────────────────────────────
// 복귀율 지표 (FN-13)
// ─────────────────────────────────────────────────────────────
/**
 * 복귀율 = (bookmark_add 가 있던 세션 중, 이후 같은 docHash 에서
 *           bookmark_click 또는 해당 청크 근방 read_scroll 로 돌아온 세션 수)
 *          / (bookmark_add 가 있던 세션 수)
 *
 * 설계 메모:
 *  - "이후"는 같은 세션 내에서 bookmark_add 보다 ts 가 큰 복귀 이벤트로 판정한다.
 *  - bookmark_click 은 명시적 복귀 신호이므로 docHash 만 같으면 인정.
 *  - read_scroll 은 패시브 신호라 "해당 청크 근방"으로 제한한다
 *    (북마크된 chunkIndex ± NEAR_CHUNKS 이내). chunkIndex 가 없으면 인정하지 않는다.
 *  - manual_seek 은 점수화에 넣지 않는다(FN-13 명시).
 *  - 한 세션은 bookmark_add 여부로 1회만 분모에 집계(세션 단위 비율).
 */
const NEAR_CHUNKS = 2

export function computeReturnRate(): {
  rate: number
  sessionsWithBookmark: number
  returnedSessions: number
} {
  const events = readRaw()

  // 세션별로 그룹핑(시간순 보존)
  const bySession = new Map<string, InstrumentationEvent[]>()
  for (const ev of events) {
    const arr = bySession.get(ev.sessionId)
    if (arr) arr.push(ev)
    else bySession.set(ev.sessionId, [ev])
  }

  let sessionsWithBookmark = 0
  let returnedSessions = 0

  for (const sessionEvents of bySession.values()) {
    // 이 세션의 bookmark_add 들(복귀 판정의 기준점)
    const adds = sessionEvents.filter((e) => e.type === 'bookmark_add')
    if (adds.length === 0) continue
    sessionsWithBookmark++

    // 같은 세션 안에서, 어떤 add 이후에 같은 docHash 로 돌아온 흔적이 있는가?
    const returned = sessionEvents.some((e) => {
      if (e.type !== 'bookmark_click' && e.type !== 'read_scroll') return false
      // add 보다 나중에 발생한, 같은 문서(docHash)에 대한 복귀여야 한다
      return adds.some((add) => {
        if (e.ts < add.ts) return false
        if (e.docHash !== add.docHash) return false
        if (e.type === 'bookmark_click') return true
        // read_scroll: 북마크 청크 근방만 인정
        if (typeof e.chunkIndex !== 'number' || typeof add.chunkIndex !== 'number') return false
        return Math.abs(e.chunkIndex - add.chunkIndex) <= NEAR_CHUNKS
      })
    })

    if (returned) returnedSessions++
  }

  const rate = sessionsWithBookmark === 0 ? 0 : returnedSessions / sessionsWithBookmark
  return { rate, sessionsWithBookmark, returnedSessions }
}

// ─────────────────────────────────────────────────────────────
// 경량 해시 (docHash 용)
// ─────────────────────────────────────────────────────────────
/**
 * FNV-1a 32bit 해시 → 8자리 hex 문자열.
 * 암호학적 용도가 아니라 "같은 원문 재오픈 식별"용이라 충돌만 충분히 낮으면 된다.
 */
export function hashText(s: string): string {
  let h = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // FNV prime(16777619) 곱 — 32bit 오버플로우를 의도해 >>> 0 로 묶는다
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
