<script lang="ts">
  /**
   * FN-06/07/08/09 · 플레이어 (청취)
   *  - 재생/일시정지 토글, 이전/다음 문장(engine.seekToChunk), 진행바, 배속(engine.setRate)
   *  - 현재 읽는 문장 하이라이트: engine.on('chunkChange')로 chunkIndex 추적
   *  - 🔖 북마크: engine.position {chunkIndex, charOffset} 그대로 기록(시간 ms 금지)
   *  - 키보드: Space(재생/정지) ←/→(문장) ↑/↓(배속) B(북마크)
   *
   * 엔진은 props로 주입(테스트·통합 용이). createEngine 직접 호출은 App.svelte.
   */
  import type { Bookmark, Chunk, RadioEngine, EnginePosition } from '../lib/types'
  import { genId } from '../lib/stores/id'
  import { logEvent } from '../lib/instrumentation'
  import { settingsStore } from '../lib/stores/settings.svelte'

  interface Props {
    chunks: Chunk[]
    engine: RadioEngine
    /** 재생 상태(App 단일 소스). 청취·정독이 같은 상태를 공유한다. */
    playing: boolean
    /** 재생/일시정지 토글(App 이 engine.pause()/play() + playing 갱신). */
    onTogglePlay: () => void
    /** 문서 식별(계측·북마크 documentId). */
    docId: string
    /** 원문 해시(계측 docHash). hashText(rawText) 결과를 상위가 전달. */
    docHash: string
    /** 북마크 생성 → 상위가 IndexedDB 저장 + 목록 갱신. */
    onBookmark: (b: Bookmark) => void
    /** 현재 청크 변경 통지(상위가 정독뷰 동기화 등에 사용). 선택. */
    onChunkChange?: (chunkIndex: number) => void

    // ── 반복/구간반복/재생목록(상태·로직은 App 소유, 여기선 표시·버튼만) ──
    /** 반복 모드: off=없음, one=한 문서 반복, ab=구간(A-B) 반복. */
    repeatMode: 'off' | 'one' | 'ab'
    /** 구간 반복 시작(A) 청크 인덱스(0-base). 미지정이면 null. */
    abStart: number | null
    /** 구간 반복 끝(B) 청크 인덱스(0-base). 미지정이면 null. */
    abEnd: number | null
    /** 재생목록 진행(현재/전체). 재생목록이 없으면 null. */
    queuePos: { index: number; total: number } | null
    /** 🔁 한 문서 반복 토글(App 이 repeatMode 갱신). */
    onToggleRepeatOne: () => void
    /** ↔ 구간 반복 버튼(현재 청크 기준 A→B→해제 순환; App 이 처리). */
    onAbButton: () => void
    /** 재생목록 길이(2 이상일 때만 순서 토글 버튼 노출). */
    queueLen?: number
    /** 📋 재생목록 순서 패널 토글(App 이 showQueue 갱신). */
    onToggleQueue?: () => void
  }

  let {
    chunks,
    engine,
    playing,
    onTogglePlay,
    docId,
    docHash,
    onBookmark,
    onChunkChange,
    repeatMode,
    abStart,
    abEnd,
    queuePos,
    onToggleRepeatOne,
    onAbButton,
    queueLen = 0,
    onToggleQueue,
  }: Props = $props()

  // ── 재생 상태(룬) ───────────────────────────────────────────
  // playing 은 App 소유(props). 종료(end)도 App 이 구독해 끈다(탭 전환 시 일관성).
  let cur = $state(0) // 현재 청크 인덱스(위치의 진실)
  let rate = $state(settingsStore.value.rate)

  // ── 음성 선택(남성/여성 등) ─────────────────────────────────
  let voices = $state<{ uri: string; name: string }[]>([])
  let selectedVoice = $state('')

  // 브라우저 음성 목록 로드(비동기 voiceschanged 대응) + 현재 선택 동기화
  $effect(() => {
    const load = () => {
      voices = engine.getKoreanVoices?.() ?? []
      // settings 에 저장된 음성 우선, 없으면 엔진이 고른 기본(남성 우선)을 표시
      selectedVoice = settingsStore.value.voiceURI ?? engine.currentVoiceURI ?? ''
    }
    load()
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', load)
      return () => speechSynthesis.removeEventListener('voiceschanged', load)
    }
  })

  function onSelectVoice(e: Event): void {
    const uri = (e.currentTarget as HTMLSelectElement).value
    selectedVoice = uri
    settingsStore.setVoiceURI(uri) // App 의 effect 가 engine.setVoice 로 반영
  }

  /** 현재 청크(파생). */
  let current = $derived<Chunk | undefined>(chunks[cur])
  /** 진행률 0~1(파생). 청크 인덱스 기반(시간 아님). */
  let progress = $derived(chunks.length > 1 ? cur / (chunks.length - 1) : 0)

  /** ↔ 구간 반복 버튼 라벨(다음 동작 안내). off→A 지정, A만 있으면→B 지정, ab→해제. */
  let abLabel = $derived(
    repeatMode === 'ab'
      ? '구간 반복 해제'
      : abStart != null
        ? '구간 끝(B) 지점 지정'
        : '구간 시작(A) 지점 지정',
  )

  const RATES = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

  // ── 엔진 이벤트 구독 ────────────────────────────────────────
  // chunkChange 콜백: 엔진이 다음 청크로 넘어갈 때 현재 위치 갱신.
  function onEngineChunkChange(p: EnginePosition): void {
    cur = p.chunkIndex
    onChunkChange?.(p.chunkIndex)
  }

  // engine 인스턴스가 바뀌면(문서 전환) 구독을 재설정.
  // 'end'(재생 종료)는 App 이 구독해 playing 을 끈다(여기서 중복 구독하지 않음).
  $effect(() => {
    const e = engine
    e.on('chunkChange', onEngineChunkChange)
    // 초기 위치 동기화
    cur = e.position.chunkIndex
    return () => {
      e.off('chunkChange', onEngineChunkChange)
    }
  })

  // 배속 설정이 외부에서 바뀌면 로컬·엔진에 반영.
  $effect(() => {
    rate = settingsStore.value.rate
  })

  // ── 컨트롤 동작 ─────────────────────────────────────────────
  // 재생/일시정지 토글은 App(onTogglePlay)이 단일 소스로 처리한다.

  /** 이전 문장: 무음 청크는 건너뛰며 직전 speech 청크로(없으면 0). */
  function prev(): void {
    const target = findChunk(cur - 1, -1)
    if (target !== null) {
      engine.seekToChunk(target)
      cur = target
      logEvent('manual_seek', { docId, docHash, chunkIndex: target })
    }
  }

  /** 다음 문장. */
  function next(): void {
    const target = findChunk(cur + 1, +1)
    if (target !== null) {
      engine.seekToChunk(target)
      cur = target
      logEvent('manual_seek', { docId, docHash, chunkIndex: target })
    }
  }

  /** start 부터 step 방향으로 범위 내 첫 인덱스 반환(무음도 포함; 엔진이 무음 처리). */
  function findChunk(start: number, step: number): number | null {
    if (start < 0 || start >= chunks.length) return null
    return start
  }

  /**
   * 진행바 드래그 중 — 위치 숫자만 미리보기(엔진은 호출하지 않음).
   * 매 입력마다 seekToChunk 를 부르면 webSpeech 는 cancel↔speak 경쟁으로 무음이 되고,
   * Supertonic 은 지나치는 중간 청크를 불필요하게 재합성한다. 그래서 확정 때만 점프한다.
   */
  function onSeekPreview(e: Event): void {
    cur = Number((e.currentTarget as HTMLInputElement).value)
  }

  /**
   * 진행바 확정(드래그 놓기/키보드) → 해당 청크로 seek + 그 지점부터 재생 시작.
   * 정지 중이었어도 진행바를 옮긴 건 "여기서 듣겠다"는 의도이므로 재생을 시작한다.
   * (재생 중이었으면 seekToChunk 가 이어서 재생하고, 이미 playing 이라 play()는 무시된다.)
   * FN-07 + manual_seek 계측.
   */
  function onSeekCommit(e: Event): void {
    const idx = Number((e.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(idx)) return
    engine.seekToChunk(idx)
    cur = idx
    // 정지 중이었으면 이 지점부터 재생 시작(playing 은 App 소유 → onTogglePlay 경유로 켠다).
    if (!playing) onTogglePlay()
    logEvent('manual_seek', { docId, docHash, chunkIndex: idx })
  }

  function setRate(r: number): void {
    rate = r
    engine.setRate(r)
    settingsStore.setRate(r) // FN-08 SHOULD: 마지막 배속 저장
  }

  /** 배속을 한 단계 올리고/내리고(키보드 ↑↓). */
  function stepRate(dir: 1 | -1): void {
    const i = RATES.indexOf(rate)
    const base = i === -1 ? RATES.indexOf(1.0) : i
    const ni = Math.min(RATES.length - 1, Math.max(0, base + dir))
    setRate(RATES[ni])
  }

  /**
   * 🔖 북마크 — engine.position 을 그대로 기록(폐루프 핵심).
   *  - chunkIndex/charOffset: position 그대로(시간 ms 금지)
   *  - previewText: 현재 청크 앞 30자
   */
  function addBookmark(): void {
    const pos = engine.position
    const chunk = chunks[pos.chunkIndex]
    const preview = (chunk?.text ?? '').slice(0, 30)
    const b: Bookmark = {
      id: genId(),
      documentId: docId,
      chunkIndex: pos.chunkIndex,
      charOffset: pos.charOffset,
      previewText: preview,
      createdAt: Date.now(),
    }
    onBookmark(b)
    logEvent('bookmark_add', { docId, docHash, chunkIndex: pos.chunkIndex })
    // 가벼운 피드백
    flashBookmark()
  }

  // 북마크 토스트 피드백
  let bookmarked = $state(false)
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  function flashBookmark(): void {
    bookmarked = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (bookmarked = false), 1200)
  }

  // ── 키보드 단축키(FN-07 SHOULD) ─────────────────────────────
  function onKeydown(e: KeyboardEvent): void {
    // 입력 요소에 포커스 중이면 단축키 무시(텍스트 입력 보호)
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

    switch (e.key) {
      case ' ':
        e.preventDefault()
        onTogglePlay()
        break
      case 'ArrowLeft':
        e.preventDefault()
        prev()
        break
      case 'ArrowRight':
        e.preventDefault()
        next()
        break
      case 'ArrowUp':
        e.preventDefault()
        stepRate(1)
        break
      case 'ArrowDown':
        e.preventDefault()
        stepRate(-1)
        break
      case 'b':
      case 'B':
        e.preventDefault()
        addBookmark()
        break
    }
  }

  $effect(() => {
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  })
</script>

<div class="player">
  <!-- 재생목록 진행(있을 때만). 작은 보조 텍스트. -->
  {#if queuePos}
    <div class="queue-status" aria-live="polite">
      재생목록 {queuePos.index + 1} / {queuePos.total}
    </div>
  {/if}

  <!-- 구간 반복 활성 표시(A·B 모두 지정 시). -->
  {#if repeatMode === 'ab' && abStart != null && abEnd != null}
    <div class="ab-info" aria-live="polite">구간반복 {abStart + 1}–{abEnd + 1}</div>
  {/if}

  <!-- 현재 읽는 문장 하이라이트 영역(원문 동기화는 정독뷰, 여기는 정제 텍스트) -->
  <div class="now-reading" aria-live="polite">
    {#if current}
      {#if current.kind === 'silence'}
        <span class="silence">…</span>
      {:else}
        <p class="sentence">{current.text}</p>
      {/if}
    {:else}
      <p class="sentence muted">재생할 내용이 없습니다.</p>
    {/if}
  </div>

  <!-- 진행바: 청크 인덱스 기반 -->
  <div class="progress-row">
    <span class="idx">{cur + 1}</span>
    <input
      class="seek"
      type="range"
      min="0"
      max={Math.max(0, chunks.length - 1)}
      step="1"
      value={cur}
      oninput={onSeekPreview}
      onchange={onSeekCommit}
      aria-label="문장 위치"
    />
    <span class="idx total">{chunks.length}</span>
  </div>

  <!-- 컨트롤 -->
  <div class="controls">
    <button type="button" class="ctrl" onclick={prev} aria-label="이전 문장" title="이전 문장 (←)">
      ◀◀
    </button>
    <button
      type="button"
      class="ctrl play"
      onclick={onTogglePlay}
      aria-label={playing ? '일시정지' : '재생'}
      title="재생/일시정지 (Space)"
    >
      {playing ? '⏸' : '▶'}
    </button>
    <button type="button" class="ctrl" onclick={next} aria-label="다음 문장" title="다음 문장 (→)">
      ▶▶
    </button>

    <!-- 배속 -->
    <div class="rate" title="배속 (↑↓)">
      <select aria-label="배속" value={rate} onchange={(e) => setRate(Number(e.currentTarget.value))}>
        {#each RATES as r}
          <option value={r}>{r}x</option>
        {/each}
      </select>
    </div>

    <!-- 음성 선택(브라우저에 한국어 음성이 2개 이상일 때만 노출) -->
    {#if voices.length > 1}
      <div class="rate voice" title="음성 선택">
        <select aria-label="음성" value={selectedVoice} onchange={onSelectVoice}>
          {#each voices as v}
            <option value={v.uri}>{v.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <!-- 한 문서 반복 토글 -->
    <button
      type="button"
      class="ctrl"
      class:active={repeatMode === 'one'}
      onclick={onToggleRepeatOne}
      title="한 문서 반복"
      aria-label="한 문서 반복"
    >
      🔁
    </button>

    <!-- 구간 반복(현재 청크 기준 A→B→해제) -->
    <button
      type="button"
      class="ctrl"
      class:active={repeatMode === 'ab'}
      onclick={onAbButton}
      title={abLabel}
      aria-label="구간 반복"
    >
      ↔
    </button>

    <!-- 북마크 -->
    <button
      type="button"
      class="ctrl bookmark"
      class:flash={bookmarked}
      onclick={addBookmark}
      aria-label="북마크 추가"
      title="북마크 (B)"
    >
      🔖
    </button>

    <!-- 재생목록 순서(2개 이상일 때만): 패널 토글 -->
    {#if queueLen > 1}
      <button
        type="button"
        class="ctrl"
        onclick={onToggleQueue}
        aria-label="재생목록 순서"
        title="재생목록 순서"
      >
        📋
      </button>
    {/if}
  </div>

  {#if bookmarked}
    <p class="toast" role="status">북마크 추가됨</p>
  {/if}
</div>

<style>
  .player {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .now-reading {
    min-height: 4.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.1rem;
    box-shadow: var(--shadow);
    display: flex;
    align-items: center;
  }
  .sentence {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.7;
    /* 현재 읽는 문장 강조 */
    background: var(--highlight);
    border-radius: 6px;
    padding: 0.1rem 0.3rem;
    box-decoration-break: clone;
  }
  .sentence.muted {
    background: transparent;
    color: var(--text-muted);
  }
  .silence {
    color: var(--text-muted);
    font-size: 1.5rem;
    letter-spacing: 0.2em;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .idx {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    font-size: 0.85rem;
    min-width: 2.5ch;
    text-align: right;
  }
  .idx.total {
    text-align: left;
  }
  .seek {
    flex: 1;
    accent-color: var(--accent);
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ctrl {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    padding: 0.6rem 0.9rem;
    font-size: 1rem;
    min-width: 3rem;
  }
  .ctrl:hover {
    border-color: var(--accent);
  }
  .ctrl.play {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    font-size: 1.2rem;
    min-width: 3.5rem;
  }
  .ctrl.bookmark.flash {
    background: var(--highlight-bookmark);
    border-color: var(--warn);
  }
  /* 반복/구간반복 활성 상태(accent 강조) */
  .ctrl.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  /* 재생목록 진행 / 구간반복 보조 텍스트 */
  .queue-status,
  .ab-info {
    text-align: center;
    font-size: 0.8rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .ab-info {
    color: var(--accent);
    font-weight: 600;
  }
  .rate select {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    padding: 0.55rem 0.5rem;
    font-family: inherit;
    font-size: 0.9rem;
  }

  .toast {
    margin: 0;
    text-align: center;
    color: var(--ok);
    background: var(--ok-soft);
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
  }
</style>
