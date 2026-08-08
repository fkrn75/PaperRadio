<script lang="ts">
  /**
   * FN-09 · 북마크 목록
   *  - 목록·미리보기(previewText)·점프(onJump)·삭제(ondelete)
   *  - 점프는 chunkIndex 를 그대로 넘긴다(원문 위치 = chunk.startOffset + charOffset 은
   *    상위/정독뷰가 계산). 시간 ms 의존 없음.
   */
  import type { Bookmark } from '../lib/types'
  import { logEvent } from '../lib/instrumentation'

  interface Props {
    bookmarks: Bookmark[]
    /** 북마크 점프 → 상위가 정독뷰 전환 + 해당 위치 스크롤. */
    onJump: (b: Bookmark) => void
    /** 북마크 삭제 → 상위가 IndexedDB 삭제 + 목록 갱신. */
    ondelete?: (id: string) => void
    /** 계측용(bookmark_click). 없으면 계측 생략. */
    docId?: string
    docHash?: string
  }

  let { bookmarks, onJump, ondelete, docId, docHash }: Props = $props()

  function fmtTime(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function jump(b: Bookmark): void {
    onJump(b)
    if (docId && docHash) {
      logEvent('bookmark_click', { docId, docHash, chunkIndex: b.chunkIndex })
    }
  }

  function remove(e: MouseEvent, id: string): void {
    e.stopPropagation()
    ondelete?.(id)
  }
</script>

<div class="bm-list">
  {#if bookmarks.length === 0}
    <p class="empty">아직 북마크가 없습니다. 재생 중 🔖 버튼이나 B 키로 추가하세요.</p>
  {:else}
    <ul>
      {#each bookmarks as b (b.id)}
        <li>
          <button type="button" class="item" onclick={() => jump(b)} aria-label="이 북마크로 점프">
            <span class="preview">{b.previewText || '(미리보기 없음)'}</span>
            <span class="sub">
              <span class="chunk">문장 {b.chunkIndex + 1}</span>
              <span class="sep" aria-hidden="true">·</span>
              <span class="date">{fmtTime(b.createdAt)}</span>
            </span>
          </button>
          {#if ondelete}
            <button
              type="button"
              class="del"
              onclick={(e) => remove(e, b.id)}
              aria-label="북마크 삭제"
              title="삭제"
            >
              ✕
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .bm-list {
    width: 100%;
  }
  .empty {
    color: var(--text-muted);
    text-align: center;
    padding: 1.5rem 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
  }
  .item {
    flex: 1;
    text-align: left;
    border: 1px solid var(--border);
    border-left: 3px solid var(--highlight-bookmark);
    border-radius: var(--radius-sm);
    background: var(--surface);
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .item:hover {
    border-color: var(--accent);
    border-left-color: var(--accent);
  }
  .preview {
    color: var(--text);
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.78rem;
  }
  .sep {
    opacity: 0.5;
  }
  .del {
    flex: none;
    width: 2.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
  }
  .del:hover {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
  }
</style>
