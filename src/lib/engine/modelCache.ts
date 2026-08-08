/**
 * Supertonic 모델 캐시 (엔진 전용 IndexedDB 헬퍼)
 *
 * 최초 1회 HF(Hugging Face)에서 ONNX/JSON 모델을 fetch → IndexedDB 에 ArrayBuffer 로 저장,
 * 이후엔 캐시에서 즉시 로드한다(약 263MB 재다운로드 방지).
 *
 * ⚠️ 격리 원칙: 앱 본체의 db/idb.ts(documents/bookmarks/settings DB)와 절대 충돌하지 않도록
 *   별도 DB('markdown-radio-models')를 사용한다. store 도 'models' 하나만 둔다.
 *
 * 키 규약: `${repo}@${revision}/${path}` (예: "Supertone/supertonic@main/onnx/vocoder.onnx")
 *   → 모델 버전(repo/revision)이 바뀌면 키도 달라져 자동으로 새로 받는다.
 */

import { openDB, type IDBPDatabase } from 'idb'

const DB_NAME = 'markdown-radio-models'
const DB_VERSION = 1
const STORE = 'models'

let dbPromise: Promise<IDBPDatabase> | null = null

/** 모델 전용 DB 핸들(싱글턴). 앱 본체 DB 와 분리된 별도 DB. */
function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE)
        }
      },
    })
  }
  return dbPromise
}

/** 캐시에서 ArrayBuffer 조회(없으면 undefined). */
export async function getCached(key: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await getDB()
    return (await db.get(STORE, key)) as ArrayBuffer | undefined
  } catch (e) {
    // IndexedDB 사용 불가(사생활 보호 모드 등) — 캐시 미스로 처리(네트워크 폴백)
    console.warn('[modelCache] 캐시 조회 실패, 네트워크로 폴백:', e)
    return undefined
  }
}

/** ArrayBuffer 를 캐시에 저장(실패해도 치명적이지 않으므로 삼킨다). */
export async function putCached(key: string, buf: ArrayBuffer): Promise<void> {
  try {
    const db = await getDB()
    await db.put(STORE, buf, key)
  } catch (e) {
    console.warn('[modelCache] 캐시 저장 실패(다음 실행 시 재다운로드):', e)
  }
}

/** 진행률 콜백: 0~1 비율과 바이트 정보. total 을 모르면 total=0. */
export type ProgressFn = (info: {
  /** 현재까지 받은 바이트(이 파일 기준) */
  loaded: number
  /** 전체 바이트(Content-Length 없으면 0) */
  total: number
  /** 0~1 비율(total 불명 시 0) */
  ratio: number
}) => void

/**
 * 캐시 우선 fetch. 캐시에 있으면 그대로 반환, 없으면 네트워크에서 스트리밍 다운로드
 * (진행률 콜백 호출) → 캐시에 저장 → ArrayBuffer 반환.
 *
 * @param url       원격 URL(HF resolve URL 등)
 * @param cacheKey  캐시 키(repo@rev/path)
 * @param onProgress 다운로드 진행률(캐시 히트 시 호출 안 함)
 */
export async function fetchWithCache(
  url: string,
  cacheKey: string,
  onProgress?: ProgressFn,
): Promise<ArrayBuffer> {
  // 1) 캐시 우선
  const cached = await getCached(cacheKey)
  if (cached) {
    // 캐시 히트도 UI 진행률 일관성을 위해 100% 한 번 통지
    onProgress?.({ loaded: cached.byteLength, total: cached.byteLength, ratio: 1 })
    return cached
  }

  // 2) 네트워크 스트리밍 다운로드(진행률 산출)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`모델 다운로드 실패(${res.status} ${res.statusText}): ${url}`)
  }

  const total = Number(res.headers.get('content-length') ?? '0')

  // 스트림이 없거나 본문이 작으면 통째로 받는다(진행률은 0→1)
  if (!res.body) {
    const buf = await res.arrayBuffer()
    onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, ratio: 1 })
    await putCached(cacheKey, buf)
    return buf
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.({
        loaded,
        total,
        ratio: total > 0 ? loaded / total : 0,
      })
    }
  }

  // 청크 합치기 → ArrayBuffer
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  const buf = out.buffer

  await putCached(cacheKey, buf)
  return buf
}

/** 모델 캐시 전체 삭제(설정 "캐시 비우기" 용, 선택). */
export async function clearModelCache(): Promise<void> {
  try {
    const db = await getDB()
    await db.clear(STORE)
  } catch (e) {
    console.warn('[modelCache] 캐시 비우기 실패:', e)
  }
}
