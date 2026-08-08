<script lang="ts">
  /**
   * PaperRadio 앱 셸.
   *
   * Phase 1 범위: PDF 를 올려 **듣는 것**까지. 원본 페이지를 보는 정독뷰는 Phase 2 에서
   * 이 셸의 탭으로 붙는다(재생 상태는 이미 여기 한곳에 모여 있으므로 그대로 공유된다).
   *
   * 상태 소유 원칙(MarkdownRadio 와 동일): 재생 상태(playing·repeat·A-B)는 **App 이 단일 소스**로
   * 갖고, Player/정독뷰는 표시와 버튼만 담당한다. 두 화면이 같은 상태를 보게 하기 위함이다.
   */
  import { createEngine } from './lib/engine'
  import { hashText } from './lib/instrumentation'
  import { settingsStore } from './lib/stores/settings.svelte'
  import { libraryStore } from './lib/stores/library.svelte'
  import {
    getDocument,
    updateLastChunkIndex,
    addBookmark,
    listBookmarks,
    deleteBookmark,
  } from './lib/db/idb'
  import { isViewOnly } from './lib/pdf/document'
  import { pageForChunk } from './lib/locate'
  import type { Bookmark, EnginePosition, StoredDocument } from './lib/types'
  import Uploader from './components/Uploader.svelte'
  import Library from './components/Library.svelte'
  import Player from './components/Player.svelte'
  import PdfReadingView from './components/PdfReadingView.svelte'
  import BookmarkList from './components/BookmarkList.svelte'

  let view = $state<'library' | 'player'>('library')
  /** 문서 화면의 탭. 청취=재생 컨트롤, 정독=원본 페이지. */
  let tab = $state<'listen' | 'read'>('listen')
  let doc = $state<StoredDocument | null>(null)
  let bookmarks = $state<Bookmark[]>([])
  /**
   * 북마크가 가리키는 원문 위치. 정독뷰가 이 값이 바뀔 때 스크롤·강조한다.
   * nonce 를 함께 둔 이유: 같은 북마크를 다시 눌러도 다시 이동해야 하기 때문(값만 보면 변화가 없다).
   */
  let jumpTarget = $state<{ offset: number; nonce: number } | null>(null)
  let jumpNonce = 0

  // 재생 상태(단일 소스)
  let engine = $state(createEngine(settingsStore.value.engine))
  let playing = $state(false)
  let currentChunkIndex = $state(0)
  let repeatMode = $state<'off' | 'one' | 'ab'>('off')
  let abStart = $state<number | null>(null)
  let abEnd = $state<number | null>(null)

  const chunks = $derived(doc?.chunks ?? [])
  const docHash = $derived(doc ? hashText(doc.rawText) : '')
  const viewOnly = $derived(doc ? isViewOnly(doc) : false)

  // 현재 청크가 몇 쪽인지 — 헤더 표시용(정독뷰는 같은 계산을 내부에서 한다).
  const currentPage = $derived(doc ? pageForChunk(doc.pdf.pageRanges, chunks, currentChunkIndex) : 0)

  /** 엔진 위치 변경 구독(현재 청크 추적 + 이어듣기 저장). */
  function attachEngine(): void {
    const onChange = (p: EnginePosition) => {
      currentChunkIndex = p.chunkIndex
      if (doc) {
        doc.lastChunkIndex = p.chunkIndex
        // 매 청크마다 쓰지만 이 헬퍼는 해당 필드만 갱신해 가볍다. 이어듣기 유실이 더 아프다.
        void updateLastChunkIndex(doc.id, p.chunkIndex)
      }
    }
    engine.on('chunkChange', onChange)
  }
  attachEngine()

  async function openDocument(d: StoredDocument): Promise<void> {
    doc = d
    bookmarks = await listBookmarks(d.id)
    engine.setDocContext?.({ docId: d.id, docHash: hashText(d.rawText) })
    engine.setRate(settingsStore.value.rate)

    if (!isViewOnly(d)) {
      await engine.load(d.chunks ?? [])
      // 이어듣기: 마지막 위치가 유효하면 그 청크부터. 끝까지 들었으면 처음부터.
      const last = d.lastChunkIndex ?? 0
      const resume = last > 0 && last < (d.chunks?.length ?? 0) - 1 ? last : 0
      currentChunkIndex = resume
      engine.seekToChunk(resume)
    }
    playing = false
    // 스캔본은 들을 게 없으니 곧바로 정독(원본 보기)으로 연다.
    tab = isViewOnly(d) ? 'read' : 'listen'
    view = 'player'
  }

  async function handleSelect(id: string): Promise<void> {
    const d = await getDocument(id)
    if (d) await openDocument(d)
  }

  /** 그 청크로 이동한 뒤 곧바로 재생(정독뷰 더블클릭 경로). */
  function seekAndPlay(i: number): void {
    if (viewOnly) return
    engine.seekToChunk(i)
    engine.play()
    playing = true
  }

  function togglePlay(): void {
    if (!doc || viewOnly) return
    if (playing) {
      engine.pause()
      playing = false
    } else {
      engine.play()
      playing = true
    }
  }

  async function handleBookmark(b: Bookmark): Promise<void> {
    await addBookmark(b)
    bookmarks = await listBookmarks(b.documentId)
  }

  async function handleDeleteBookmark(id: string): Promise<void> {
    await deleteBookmark(id)
    if (doc) bookmarks = await listBookmarks(doc.id)
  }

  /**
   * 북마크 → 원문 위치로 점프.
   * 북마크는 (청크, 청크 내 상대 offset)로 저장되므로 절대 offset 으로 환산해 넘긴다.
   */
  function handleJump(b: Bookmark): void {
    const c = chunks[b.chunkIndex]
    if (!c) return
    jumpTarget = { offset: c.startOffset + b.charOffset, nonce: ++jumpNonce }
    tab = 'read'
  }

  /** ↔ 버튼: 현재 청크 기준 A → B → 해제 순환. */
  function handleAbButton(): void {
    if (repeatMode === 'ab') {
      repeatMode = 'off'
      abStart = abEnd = null
      return
    }
    if (abStart === null) {
      abStart = currentChunkIndex
      return
    }
    abEnd = Math.max(currentChunkIndex, abStart)
    repeatMode = 'ab'
  }

  function goHome(): void {
    engine.stop()
    playing = false
    view = 'library'
    void libraryStore.refresh()
  }
</script>

<main>
  <header class="shell-head">
    <button class="brand" onclick={goHome} title="라이브러리로">
      <span class="mark">◧</span> PaperRadio
    </button>
    {#if doc && view === 'player'}
      <span class="doc-title" title={doc.title}>{doc.title}</span>
      <span class="doc-meta">{doc.pdf.pageCount}쪽{currentPage ? ` · ${currentPage}쪽 재생 중` : ''}</span>
    {/if}
  </header>

  {#if view === 'library'}
    <section class="pane">
      <Uploader onimported={(d) => openDocument(d)} />
      <Library onselect={handleSelect} onplaylist={(ids) => ids[0] && handleSelect(ids[0])} />
    </section>
  {:else if doc}
    <section class="pane">
      <nav class="tabs" aria-label="문서 보기 방식">
        <button class="tab" class:on={tab === 'listen'} onclick={() => (tab = 'listen')} disabled={viewOnly}>
          청취
        </button>
        <button class="tab" class:on={tab === 'read'} onclick={() => (tab = 'read')}>정독</button>
      </nav>

      {#if tab === 'listen'}
        {#if viewOnly}
          <!-- 스캔본: 글자 정보가 없어 낭독할 내용이 없다. 정독(보기)은 정상 동작한다. -->
          <div class="notice">
            <p class="notice-title">읽을 수 있는 텍스트가 없는 PDF입니다</p>
            <p class="notice-sub">
              종이를 스캔한 이미지 PDF로 보입니다. 글자 정보가 없어 낭독은 할 수 없지만,
              원본 페이지는 정독 탭에서 그대로 볼 수 있습니다.
            </p>
          </div>
        {:else}
          <Player
            {chunks}
            {engine}
            {playing}
            onTogglePlay={togglePlay}
            docId={doc.id}
            {docHash}
            onBookmark={handleBookmark}
            onChunkChange={(i) => (currentChunkIndex = i)}
            {repeatMode}
            {abStart}
            {abEnd}
            queuePos={null}
            onToggleRepeatOne={() => (repeatMode = repeatMode === 'one' ? 'off' : 'one')}
            onAbButton={handleAbButton}
          />
          {#if bookmarks.length > 0}
            <BookmarkList
              {bookmarks}
              onJump={handleJump}
              ondelete={handleDeleteBookmark}
              docId={doc.id}
              {docHash}
            />
          {/if}
        {/if}
      {:else}
        <PdfReadingView
          docId={doc.id}
          pdf={doc.pdf}
          rawText={doc.rawText}
          {chunks}
          {currentChunkIndex}
          {jumpTarget}
          {playing}
          onTogglePlay={togglePlay}
          onSeek={(i) => engine.seekToChunk(i)}
          onSeekPlay={seekAndPlay}
          {repeatMode}
          {abStart}
          {abEnd}
          onToggleRepeatOne={() => (repeatMode = repeatMode === 'one' ? 'off' : 'one')}
          onAbButton={handleAbButton}
        />
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 0.75rem 1rem 3rem;
  }
  .shell-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.4rem 0 0.9rem;
    flex-wrap: wrap;
  }
  .brand {
    font: inherit;
    font-weight: 700;
    font-size: 1.02rem;
    color: var(--text, #1c2230);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .mark {
    color: #2b4c8c;
  }
  .doc-title {
    font-size: 0.9rem;
    color: var(--text, #1c2230);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 46%;
  }
  .doc-meta {
    font-size: 0.78rem;
    color: var(--muted, #4a5568);
    margin-left: auto;
  }
  .pane {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--border, #e3e7ef);
  }
  .tab {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.45rem 0.95rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted, #4a5568);
    cursor: pointer;
  }
  .tab.on {
    color: #2b4c8c;
    border-bottom-color: #2b4c8c;
    font-weight: 600;
  }
  .tab:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .notice {
    border: 1px solid var(--border, #e3e7ef);
    border-left: 3px solid #b25b1b;
    border-radius: 8px;
    background: var(--surface, #fff);
    padding: 1rem 1.1rem;
  }
  .notice-title {
    margin: 0 0 0.35rem;
    font-weight: 600;
    color: var(--text, #1c2230);
  }
  .notice-sub {
    margin: 0;
    font-size: 0.86rem;
    line-height: 1.7;
    color: var(--muted, #4a5568);
    word-break: keep-all;
  }
</style>
