<script lang="ts">
  /**
   * FN-11 · 문서 라이브러리
   *  - 문서 목록(제목·날짜·청크 수·북마크 수) 표시
   *  - 단일 선택 → onselect(id), 삭제 → 확인 후 라이브러리 스토어에서 제거
   *  - 다중 선택(체크박스) → onplaylist(ids) 로 재생목록 순차 재생(상위 책임)
   *
   * 데이터는 libraryStore(룬)에서 읽는다. 마운트 시 refresh() 1회.
   */
  import type { StoredDocument } from '../lib/types'
  import { libraryStore } from '../lib/stores/library.svelte'

  interface Props {
    /** 문서 단일 선택 → 플레이어로 즉시 전환(상위 책임). */
    onselect: (id: string) => void
    /**
     * 다중 선택 → 재생목록 순차 재생(상위 책임).
     * 표시 순서대로 정렬된 문서 id 배열을 넘긴다.
     */
    onplaylist: (ids: string[]) => void
  }

  let { onselect, onplaylist }: Props = $props()

  /**
   * 다중 선택된 문서 id 집합.
   * Svelte5에서 Set 내부 변경은 반응성을 깨므로, 변경 시 항상 재할당
   * (`selected = new Set(selected)`) 한다.
   */
  let selected = $state<Set<string>>(new Set())

  /** 체크박스 토글: 선택/해제(이벤트 전파는 호출부에서 막음). */
  function toggle(id: string): void {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }

  /** 현재 표시 목록이 전부 선택됐는지(전체선택 토글용). */
  const allSelected = $derived(
    libraryStore.documents.length > 0 &&
      libraryStore.documents.every((d) => selected.has(d.id))
  )

  /** 전체 선택/해제 토글. */
  function toggleAll(): void {
    if (allSelected) {
      selected = new Set()
    } else {
      selected = new Set(libraryStore.documents.map((d) => d.id))
    }
  }

  /** 선택 전체 해제. */
  function clearSelection(): void {
    selected = new Set()
  }

  /**
   * 선택된 문서를 표시 순서대로 정렬해 재생목록으로 넘기고 선택을 해제한다.
   * (정렬 기준 = libraryStore.documents 의 현재 표시 순서)
   */
  function playSelected(): void {
    const ordered = libraryStore.documents
      .filter((d) => selected.has(d.id))
      .map((d) => d.id)
    if (ordered.length === 0) return
    onplaylist(ordered)
    selected = new Set()
  }

  // 마운트 시 목록 로드(이미 로드됐어도 최신화)
  $effect(() => {
    void libraryStore.refresh()
  })

  /** 청크 수: chunks 캐시가 있으면 길이, 없으면 미정(–). */
  function chunkCount(doc: StoredDocument): string {
    return doc.chunks ? String(doc.chunks.length) : '–'
  }

  /** 날짜를 'YYYY.MM.DD' 로 표기(로케일 비의존, 짧게). */
  function fmtDate(ts: number): string {
    const d = new Date(ts)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
  }

  async function remove(e: MouseEvent, doc: StoredDocument): Promise<void> {
    e.stopPropagation() // 카드 클릭(선택)과 분리
    const ok = confirm(`"${doc.title}" 문서를 삭제할까요? 연결된 북마크도 함께 지워집니다.`)
    if (!ok) return
    await libraryStore.remove(doc.id)
  }
</script>

<div class="library">
  {#if !libraryStore.loaded}
    <p class="empty">불러오는 중…</p>
  {:else if libraryStore.documents.length === 0}
    <p class="empty">아직 문서가 없습니다. 위에서 추가해 보세요.</p>
  {:else}
    <div class="head">
      <button
        type="button"
        class="select-all"
        onclick={toggleAll}
        aria-pressed={allSelected}
      >
        {allSelected ? '전체 해제' : '전체 선택'}
      </button>
    </div>
    <ul class="cards">
      {#each libraryStore.documents as doc (doc.id)}
        <li class:selected={selected.has(doc.id)}>
          <!-- 선택 체크박스: 카드 본문(.card 버튼)과 독립된 별도 영역이라
               클릭이 onselect(즉시 열기)를 건드리지 않음. -->
          <label class="pick" title="재생목록에 추가/제거">
            <input
              type="checkbox"
              checked={selected.has(doc.id)}
              onchange={() => toggle(doc.id)}
              aria-label={`${doc.title} 재생목록 선택`}
            />
          </label>
          <button
            type="button"
            class="card"
            onclick={() => onselect(doc.id)}
            aria-label={`${doc.title} 열기`}
          >
            <span class="title">{doc.title}</span>
            <span class="meta">
              <span class="date">{fmtDate(doc.updatedAt ?? doc.createdAt)}</span>
              <span class="sep" aria-hidden="true">·</span>
              <span>청크 {chunkCount(doc)}</span>
              <span class="sep" aria-hidden="true">·</span>
              <span class="bm" class:has={libraryStore.countFor(doc.id) > 0}>
                🔖 {libraryStore.countFor(doc.id)}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="del"
            onclick={(e) => remove(e, doc)}
            aria-label={`${doc.title} 삭제`}
            title="삭제"
          >
            ✕
          </button>
        </li>
      {/each}
    </ul>

    {#if selected.size > 0}
      <!-- 하단 sticky 액션 바: 선택이 있을 때만 노출 -->
      <div class="playlist-bar">
        <button type="button" class="play" onclick={playSelected}>
          ▶ {selected.size}개 재생목록 재생
        </button>
        <button type="button" class="clear" onclick={clearSelection}>
          선택 해제
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .library {
    width: 100%;
  }
  .empty {
    color: var(--text-muted);
    text-align: center;
    padding: 1.5rem 0;
  }
  /* 상단: 전체 선택/해제 토글 */
  .head {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.55rem;
  }
  .select-all {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    font-size: 0.8rem;
    padding: 0.35rem 0.7rem;
  }
  .select-all:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  li {
    display: flex;
    align-items: stretch;
    gap: 0.4rem;
  }
  /* 선택된 카드 강조(테두리/배경 accent 톤) */
  li.selected .card {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  /* 체크박스 영역: 탭 영역 충분히(모바일) */
  .pick {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    cursor: pointer;
  }
  .pick:hover {
    border-color: var(--accent);
  }
  .pick input {
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .card {
    flex: 1;
    text-align: left;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    box-shadow: var(--shadow);
    transition: border-color 0.15s, transform 0.05s;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card:active {
    transform: translateY(1px);
  }
  .title {
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .sep {
    opacity: 0.5;
  }
  .bm.has {
    color: var(--accent);
    font-weight: 600;
  }
  .del {
    flex: none;
    width: 2.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .del:hover {
    color: var(--warn);
    border-color: var(--warn);
    background: var(--warn-soft);
  }

  /* 하단 sticky 재생목록 액션 바 */
  .playlist-bar {
    position: sticky;
    bottom: 0;
    margin-top: 0.7rem;
    padding: 0.6rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .play {
    flex: 1;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 0.92rem;
    padding: 0.6rem 0.9rem;
  }
  .play:hover {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
  }
  .play:active {
    transform: translateY(1px);
  }
  .clear {
    flex: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-muted);
    font-size: 0.85rem;
    padding: 0.6rem 0.8rem;
  }
  .clear:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
