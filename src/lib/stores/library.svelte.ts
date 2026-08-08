/**
 * 라이브러리 스토어 — 문서 목록 + 문서별 북마크 수(룬 상태).
 *
 * IndexedDB(documents/bookmarks)를 단일 출처로 두고, UI 표시용 캐시를 룬으로 보관한다.
 * 문서 추가/삭제 시 refresh()로 다시 읽어 동기화한다.
 */

import type { StoredDocument } from '../types'
import {
  listDocuments,
  listAllBookmarks,
  deleteDocument as dbDeleteDocument,
  saveDocument,
} from '../db/idb'

// 룬 상태
let documents = $state<StoredDocument[]>([])
/** documentId → 북마크 수 */
let bookmarkCounts = $state<Record<string, number>>({})
let loaded = $state(false)

/** 전체 북마크를 읽어 문서별 개수 맵을 만든다. */
async function computeBookmarkCounts(): Promise<Record<string, number>> {
  const all = await listAllBookmarks()
  const counts: Record<string, number> = {}
  for (const b of all) {
    counts[b.documentId] = (counts[b.documentId] ?? 0) + 1
  }
  return counts
}

export const libraryStore = {
  /** 반응형 문서 목록(최근 수정 순). */
  get documents(): StoredDocument[] {
    return documents
  },
  /** 반응형 북마크 수 맵. */
  get bookmarkCounts(): Record<string, number> {
    return bookmarkCounts
  },
  get loaded(): boolean {
    return loaded
  },

  /** 특정 문서의 북마크 수(없으면 0). */
  countFor(documentId: string): number {
    return bookmarkCounts[documentId] ?? 0
  },

  /** IndexedDB 에서 문서 목록 + 북마크 수를 다시 읽는다. */
  async refresh(): Promise<void> {
    try {
      const [docs, counts] = await Promise.all([listDocuments(), computeBookmarkCounts()])
      documents = docs
      bookmarkCounts = counts
    } catch (e) {
      console.warn('[library] 새로고침 실패:', e)
    }
    loaded = true
  },

  /** 문서를 저장하고 목록을 갱신(업로드/이어듣기 위치 변경 후 호출). */
  async upsert(doc: StoredDocument): Promise<void> {
    await saveDocument(doc)
    await this.refresh()
  },

  /** 문서 삭제(북마크 cascade) 후 목록 갱신. */
  async remove(id: string): Promise<void> {
    await dbDeleteDocument(id)
    await this.refresh()
  },
}
