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
  import { createEngine, SupertonicEngine, type ModelLoadProgress } from './lib/engine'
  import { qualityToStep } from './lib/engine/supertonicProtocol'
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
  import type {
    Bookmark,
    EngineKind,
    EnginePosition,
    StoredDocument,
    TtsQuality,
  } from './lib/types'
  import Uploader from './components/Uploader.svelte'
  import Library from './components/Library.svelte'
  import Player from './components/Player.svelte'
  import PdfReadingView from './components/PdfReadingView.svelte'
  import BookmarkList from './components/BookmarkList.svelte'

  let view = $state<'library' | 'player'>('library')
  /** 문서 화면의 탭. 청취=재생 컨트롤, 정독=원본 페이지. */
  let tab = $state<'listen' | 'read'>('listen')
  /**
   * 정독뷰를 한 번이라도 열었는가.
   *
   * 열고 나면 탭을 옮겨도 **컴포넌트를 살려 두고 숨기기만** 한다. 매번 지웠다 만들면
   * 보던 쪽이 1쪽으로 리셋되고(실측) 원본 PDF 도 다시 파싱해야 해서 낭비다.
   */
  let readMounted = $state(false)
  $effect(() => {
    if (tab === 'read') readMounted = true
  })
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
  /** Supertonic 모델 다운로드/로딩 진행률(배너용). */
  let modelProgress = $state<ModelLoadProgress | null>(null)
  /** Supertonic 모델 로드 실패 메시지(있으면 배너에 재시도 버튼). */
  let modelError = $state<string | null>(null)
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

  /**
   * 엔진 위치 변경 구독(현재 청크 추적 + 이어듣기 저장).
   *
   * ⚠️ effect 로 두는 이유: 음성 엔진을 바꾸면(webspeech ↔ supertonic) 인스턴스가 통째로
   *    교체된다. 최초 1회만 구독하면 교체한 엔진의 위치 변화를 아무도 듣지 못해
   *    하이라이트·이어듣기가 멎는다. `engine` 을 읽으므로 교체 시 자동 재구독된다.
   *    (onChange 안의 `doc` 읽기는 나중에 호출되므로 추적되지 않는다 — 재구독은 엔진 교체 때만.)
   */
  $effect(() => {
    const e = engine
    const onChange = (p: EnginePosition) => {
      currentChunkIndex = p.chunkIndex
      if (doc) {
        doc.lastChunkIndex = p.chunkIndex
        // 매 청크마다 쓰지만 이 헬퍼는 해당 필드만 갱신해 가볍다. 이어듣기 유실이 더 아프다.
        void updateLastChunkIndex(doc.id, p.chunkIndex)
      }
    }
    e.on('chunkChange', onChange)
    return () => e.off('chunkChange', onChange)
  })

  /**
   * 선택한 음성(voiceURI)을 엔진에 반영. 없으면 null = 엔진 기본(남성 우선).
   *
   * ⚠️ Player 의 드롭다운은 **설정에 저장만** 한다. 실제 `engine.setVoice` 는 여기서만 부른다.
   *    이 effect 가 없으면 목소리를 바꿔도 처음 음성으로만 계속 재생된다(실측).
   *    `engine` 을 읽으므로 엔진을 갈아끼워도 선택이 다시 적용된다.
   */
  $effect(() => {
    engine.setVoice?.(settingsStore.value.voiceURI ?? null)
  })

  // 음질 프리셋(ttsQuality) → Supertonic 의 totalStep 반영. webspeech 면 아무 일도 하지 않는다.
  $effect(() => {
    const e = engine
    if (e instanceof SupertonicEngine) {
      e.setTotalStep(qualityToStep(settingsStore.value.ttsQuality))
    }
  })

  // 모델 다운로드/로딩 진행률·실패 구독(엔진 교체 시 자동 재구독).
  $effect(() => {
    const e = engine
    if (e instanceof SupertonicEngine) {
      e.onModelProgress((p) => {
        modelProgress = p
        if (p.ratio >= 1) modelError = null
      })
      e.onModelError?.((msg) => (modelError = msg))
      return () => {
        e.onModelProgress(null)
        e.onModelError?.(null)
      }
    }
  })

  /**
   * 음성 엔진 전환(브라우저 기본 ↔ 온디바이스 Supertonic).
   * 듣던 위치는 유지한다 — 엔진만 갈아끼우는 것이지 문서를 다시 여는 게 아니다.
   */
  async function setEngineKind(kind: EngineKind): Promise<void> {
    if (kind === settingsStore.value.engine) return
    engine.stop()
    playing = false
    if (engine instanceof SupertonicEngine) engine.dispose()
    modelProgress = null
    modelError = null
    settingsStore.patch({ engine: kind })

    const ctx = doc ? { docId: doc.id, docHash: hashText(doc.rawText) } : undefined
    engine = createEngine(kind, ctx)
    engine.setRate(settingsStore.value.rate)
    if (doc && !isViewOnly(doc)) {
      const at = currentChunkIndex
      await engine.load(chunks)
      engine.seekToChunk(at)
    }
  }

  /** 음질 프리셋 변경 — 저장만 하면 위 effect 가 엔진에 반영한다. */
  function setQuality(q: TtsQuality): void {
    settingsStore.setTtsQuality(q)
  }

  /** 모델 로드 재시도(에러 배너 버튼). */
  function retryModel(): void {
    modelError = null
    if (engine instanceof SupertonicEngine) void engine.retryLoad()
  }

  async function openDocument(d: StoredDocument): Promise<void> {
    doc = d
    bookmarks = await listBookmarks(d.id)
    engine.setDocContext?.({ docId: d.id, docHash: hashText(d.rawText) })
    engine.setRate(settingsStore.value.rate)

    // 이어듣기: 마지막 위치가 유효하면 그 청크부터. 끝까지 들었으면 처음부터.
    const last = d.lastChunkIndex ?? 0
    const resume = last > 0 && last < (d.chunks?.length ?? 0) - 1 ? last : 0
    currentChunkIndex = resume

    if (!isViewOnly(d)) {
      // ⚠️ 엔진 로드를 기다리지 않는다.
      //    Supertonic 첫 사용은 모델 ~380MB 를 받느라 load 가 수십 초 걸린다. 여기서 await 하면
      //    그동안 화면이 라이브러리에 머물러 **원본 PDF 조차 못 본다** — 보기는 음성과 무관하다.
      //    진행률은 상단 배너가 알리고, 준비되면 시작 위치만 맞춘다.
      //    로드 전에 재생을 눌러도 안전하다(엔진의 play 가 모델 준비를 자체적으로 기다린다).
      const e = engine
      void (async () => {
        await e.load(d.chunks ?? [])
        // 로드를 기다리는 사이 다른 문서를 열었거나 엔진을 바꿨으면 그쪽이 주인이다.
        // ⚠️ 문서는 반드시 **id 로** 비교한다. `doc` 은 $state 프록시라 원본 `d` 와 identity 가
        //    달라 `doc !== d` 가 항상 참이 된다(그러면 이 seek 이 영영 실행되지 않는다).
        if (doc?.id !== d.id || engine !== e) return
        e.seekToChunk(resume)
      })()
    }
    playing = false
    jumpTarget = null
    readMounted = false // 다른 문서를 열었으니 정독뷰는 새로 만든다
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

  {#if modelError}
    <div class="model-error" role="alert">
      <span class="me-label">{modelError}</span>
      <button class="me-retry" onclick={retryModel}>다시 시도</button>
    </div>
  {:else if modelProgress && modelProgress.ratio < 1}
    <div class="model-progress" role="status">
      <span class="mp-label">{modelProgress.label}… {Math.round(modelProgress.ratio * 100)}%</span>
      <progress max="1" value={modelProgress.ratio}></progress>
    </div>
  {/if}

  {#if view === 'library'}
    <section class="pane">
      <div class="engine-pick">
        <span class="engine-label">음성 엔진</span>
        <div class="engine-opts">
          <button
            class:active={settingsStore.value.engine === 'webspeech'}
            onclick={() => setEngineKind('webspeech')}
          >
            기본 <small>빠름 · 무설치</small>
          </button>
          <button
            class:active={settingsStore.value.engine === 'supertonic'}
            onclick={() => setEngineKind('supertonic')}
          >
            고품질 Supertonic <small>최초 1회 ~380MB</small>
          </button>
        </div>
      </div>

      {#if settingsStore.value.engine === 'supertonic'}
        <div class="quality-pick">
          <span class="engine-label">
            음질 프리셋 <small class="ql-hint">높을수록 또렷 · 느림</small>
          </span>
          <div class="quality-opts">
            {#each [['fast', '빠름', 'step 5'], ['standard', '표준', 'step 8'], ['high', '고품질', 'step 12']] as [q, label, hint] (q)}
              <button
                class:active={settingsStore.value.ttsQuality === q}
                onclick={() => setQuality(q as TtsQuality)}
              >
                {label} <small>{hint}</small>
              </button>
            {/each}
          </div>
        </div>
      {/if}

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
      {/if}

      <!-- 정독뷰는 한 번 열면 숨기기만 한다(보던 쪽·로드한 원본을 유지). -->
      {#if readMounted}
        <div class="read-pane" class:hidden={tab !== 'read'}>
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
            viewMode={settingsStore.value.pdfViewMode}
            onChangeViewMode={(m) => settingsStore.patch({ pdfViewMode: m })}
            followPlayback={settingsStore.value.followPlayback}
            onChangeFollow={(v) => settingsStore.patch({ followPlayback: v })}
          />
        </div>
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
  /* 정독뷰는 지우지 않고 숨긴다 — 보던 쪽과 이미 파싱한 원본을 유지하기 위해. */
  .read-pane {
    display: contents;
  }
  .read-pane.hidden {
    display: none;
  }
  /* ── 음성 엔진 선택 ── */
  .engine-pick,
  .quality-pick {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .engine-label {
    font-size: 0.85rem;
    color: var(--text-muted, #4a5568);
    font-weight: 600;
  }
  .ql-hint {
    font-weight: 400;
    font-size: 0.72rem;
    color: var(--text-muted, #4a5568);
    margin-left: 0.3rem;
  }
  .engine-opts,
  .quality-opts {
    display: flex;
    gap: 0.5rem;
  }
  .engine-opts button,
  .quality-opts button {
    flex: 1;
    border: 1px solid var(--border, #e3e7ef);
    background: var(--surface, #fff);
    color: var(--text, #1c2230);
    border-radius: var(--radius-sm, 9px);
    font-weight: 600;
    display: flex;
    flex-direction: column;
    cursor: pointer;
  }
  .engine-opts button {
    padding: 0.7rem 0.6rem;
    font-size: 0.95rem;
    gap: 0.15rem;
    line-height: 1.25;
  }
  .quality-opts button {
    padding: 0.55rem 0.5rem;
    font-size: 0.9rem;
    gap: 0.1rem;
    line-height: 1.2;
  }
  .engine-opts button small,
  .quality-opts button small {
    font-weight: 400;
    font-size: 0.74rem;
    color: var(--text-muted, #4a5568);
  }
  .engine-opts button.active,
  .quality-opts button.active {
    border-color: var(--accent, #2b4c8c);
    background: var(--accent-soft, #e8eeff);
    color: var(--accent, #2b4c8c);
  }
  .engine-opts button.active small,
  .quality-opts button.active small {
    color: var(--accent, #2b4c8c);
  }

  /* ── 모델 다운로드 진행률 / 실패 배너 ── */
  .model-progress {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    background: var(--accent-soft, #e8eeff);
    border: 1px solid var(--border, #e3e7ef);
    border-radius: var(--radius-sm, 9px);
    padding: 0.6rem 0.8rem;
    margin-bottom: 1rem;
  }
  .mp-label {
    font-size: 0.85rem;
    color: var(--accent, #2b4c8c);
    font-weight: 600;
  }
  .model-progress progress {
    width: 100%;
    height: 8px;
    accent-color: var(--accent, #2b4c8c);
  }
  .model-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    background: var(--warn-soft, #fdf0e6);
    border: 1px solid var(--warn, #b25b1b);
    color: var(--warn, #b25b1b);
    border-radius: var(--radius-sm, 9px);
    padding: 0.6rem 0.8rem;
    margin-bottom: 1rem;
  }
  .me-label {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .me-retry {
    flex: none;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
    border-radius: var(--radius-sm, 9px);
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
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
