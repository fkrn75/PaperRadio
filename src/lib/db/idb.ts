/**
 * IndexedDB 래퍼 — documents / bookmarks / settings 영속 저장.
 *
 * 명세(03-functional-spec) "데이터 저장소 요약" 기준:
 *  - documents : 원문·정제본·청크·마지막 위치(StoredDocument)
 *  - bookmarks : 북마크({chunkIndex, charOffset}), documentId 인덱스로 문서별 조회
 *  - settings  : 전역 설정 1건('global' 키)
 *  - (models 스토어는 온디바이스 Supertonic 도입 시 후순위 — 여기서는 미생성)
 *
 * 타입은 모두 types.ts(계약, SSOT)에 의존한다. 이 파일은 직렬화/CRUD만 책임진다.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  type Bookmark,
  type Settings,
  type StoredDocument,
  DEFAULT_SETTINGS,
} from '../types'

// ─────────────────────────────────────────────────────────────
// 스키마 정의
// ─────────────────────────────────────────────────────────────
const DB_NAME = 'markdown-radio'
const DB_VERSION = 1
/** settings 스토어의 고정 단일 키 */
const SETTINGS_KEY = 'global'

interface MarkdownRadioDB extends DBSchema {
  documents: {
    key: string
    value: StoredDocument
  }
  bookmarks: {
    key: string
    value: Bookmark
    indexes: { 'by-document': string }
  }
  settings: {
    // 전역 설정 1건. 키는 'global' 고정(인라인 키 아님 → 별도 key 지정)
    key: string
    value: Settings
  }
}

// ─────────────────────────────────────────────────────────────
// DB 핸들 (싱글턴)
// ─────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBPDatabase<MarkdownRadioDB>> | null = null

/** DB 핸들을 연다(최초 1회 스토어/인덱스 생성). 이후 호출은 같은 Promise 재사용. */
export function getDB(): Promise<IDBPDatabase<MarkdownRadioDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MarkdownRadioDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // documents: 인라인 키(id)
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' })
        }
        // bookmarks: 인라인 키(id) + documentId 인덱스(문서별 조회·cascade 삭제)
        if (!db.objectStoreNames.contains('bookmarks')) {
          const bm = db.createObjectStore('bookmarks', { keyPath: 'id' })
          bm.createIndex('by-document', 'documentId')
        }
        // settings: out-of-line 키('global' 하나만 저장)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings')
        }
      },
    })
  }
  return dbPromise
}

// ─────────────────────────────────────────────────────────────
// documents CRUD
// ─────────────────────────────────────────────────────────────
/** 문서 저장(신규/덮어쓰기). updatedAt 은 호출 측에서 갱신해 넘기는 것을 권장. */
export async function saveDocument(doc: StoredDocument): Promise<void> {
  const db = await getDB()
  await db.put('documents', doc)
}

/** 전체 문서 목록(최근 수정 순 정렬). 라이브러리 표시용. */
export async function listDocuments(): Promise<StoredDocument[]> {
  const db = await getDB()
  const all = await db.getAll('documents')
  // 최근 갱신이 위로 오게 정렬(없으면 createdAt 기준)
  return all.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
}

/** 단일 문서 조회(없으면 undefined). */
export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  const db = await getDB()
  return db.get('documents', id)
}

/**
 * 문서 삭제 + 연결된 북마크 cascade 삭제(FN-09 엣지케이스).
 * 같은 트랜잭션에서 둘 다 지워 정합성을 보장한다.
 */
export async function deleteDocument(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['documents', 'bookmarks'], 'readwrite')
  // 1) 문서 삭제
  await tx.objectStore('documents').delete(id)
  // 2) 이 문서의 북마크 키들을 인덱스로 모아 삭제
  const idx = tx.objectStore('bookmarks').index('by-document')
  let cursor = await idx.openCursor(IDBKeyRange.only(id))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

/** 이어듣기용 마지막 청크 인덱스만 가볍게 갱신(문서 전체 재저장 회피). */
export async function updateLastChunkIndex(id: string, chunkIndex: number): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('documents', 'readwrite')
  const doc = await tx.store.get(id)
  if (doc) {
    doc.lastChunkIndex = chunkIndex
    doc.updatedAt = Date.now()
    await tx.store.put(doc)
  }
  await tx.done
}

// ─────────────────────────────────────────────────────────────
// bookmarks CRUD
// ─────────────────────────────────────────────────────────────
/** 북마크 추가(또는 같은 id 덮어쓰기). */
export async function addBookmark(b: Bookmark): Promise<void> {
  const db = await getDB()
  await db.put('bookmarks', b)
}

/** 특정 문서의 북마크 목록(생성 순 정렬). */
export async function listBookmarks(documentId: string): Promise<Bookmark[]> {
  const db = await getDB()
  const list = await db.getAllFromIndex('bookmarks', 'by-document', documentId)
  return list.sort((a, b) => a.createdAt - b.createdAt)
}

/** 모든 북마크(문서 무관). 라이브러리 카드의 북마크 수 집계 등에 사용. */
export async function listAllBookmarks(): Promise<Bookmark[]> {
  const db = await getDB()
  return db.getAll('bookmarks')
}

/** 북마크 삭제. */
export async function deleteBookmark(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('bookmarks', id)
}

// ─────────────────────────────────────────────────────────────
// settings (단일 'global' 레코드)
// ─────────────────────────────────────────────────────────────
/**
 * 전역 설정 조회. 저장된 값이 없으면 DEFAULT_SETTINGS 를 반환한다.
 * 저장본이 일부 필드만 가진 옛 버전일 수 있으므로 기본값과 병합(얕은+중첩 병합).
 */
export async function getSettings(): Promise<Settings> {
  const db = await getDB()
  const saved = await db.get('settings', SETTINGS_KEY)
  if (!saved) return { ...DEFAULT_SETTINGS }
  // 신규 필드 추가 시 하위호환을 위해 기본값 위에 덮어쓴다.
  // ⚠️ 정제/청크 옵션은 설정 UI 미연결 → 코드 기본값(DEFAULT)이 SSOT.
  //    과거 persist()(음질·테마 변경 시 settings 전체 저장)로 IndexedDB 에 남은 옛 옵션이
  //    기본값 변경(예: clauseBreak)을 가리지 않도록 saved 를 무시하고 항상 DEFAULT 를 쓴다.
  //    (정제/청크 설정 UI 를 붙이면 { ...DEFAULT, ...saved } 병합으로 되돌린다)
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    refine: { ...DEFAULT_SETTINGS.refine },
    chunk: { ...DEFAULT_SETTINGS.chunk },
  }
}

/** 전역 설정 저장(덮어쓰기). */
export async function saveSettings(s: Settings): Promise<void> {
  const db = await getDB()
  await db.put('settings', s, SETTINGS_KEY)
}
