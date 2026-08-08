<script lang="ts">
  /**
   * 정독 화면의 재생 컨트롤.
   *
   * 렌더러(원본 페이지든 무엇이든)와 **완전히 무관**하다 — 재생 상태와 콜백만 받는다.
   * 그래서 정독뷰가 어떤 방식으로 바뀌어도 이 컴포넌트는 그대로 쓸 수 있고,
   * 청취 화면(Player)과 같은 상태를 보므로 두 화면의 조작이 어긋나지 않는다.
   */
  interface Props {
    playing: boolean
    onTogglePlay: () => void
    repeatMode: 'off' | 'one' | 'ab'
    abStart: number | null
    abEnd: number | null
    onToggleRepeatOne: () => void
    /** ↔ 버튼: 현재 위치 기준 A → B → 해제 순환(상위가 처리). */
    onAbButton: () => void
    /** 재생 중인 페이지 등 상태 문구(선택). */
    status?: string
  }
  const {
    playing,
    onTogglePlay,
    repeatMode,
    abStart,
    abEnd,
    onToggleRepeatOne,
    onAbButton,
    status = '',
  }: Props = $props()

  const hint = $derived.by(() => {
    if (repeatMode === 'ab' && abStart != null && abEnd != null) {
      return `구간 반복 ${abStart + 1} → ${abEnd + 1}`
    }
    if (abStart != null && repeatMode !== 'ab') return '끝 지점에서 ↔ 를 한 번 더'
    return status || '문장을 더블클릭하면 그 위치부터 재생'
  })
</script>

<div class="read-controls">
  <button
    type="button"
    class="read-play"
    class:playing
    onclick={onTogglePlay}
    aria-label={playing ? '일시정지' : '재생'}
    title="재생/일시정지"
  >
    <span class="ico" aria-hidden="true">{playing ? '⏸' : '▶'}</span>
    <span class="lbl">{playing ? '일시정지' : '재생'}</span>
  </button>

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

  <button
    type="button"
    class="ctrl"
    class:active={repeatMode === 'ab' || abStart != null}
    onclick={onAbButton}
    title="구간 반복"
    aria-label="구간 반복"
  >
    ↔ 구간
  </button>

  <span class="read-hint">{hint}</span>
</div>

<style>
  .read-controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .read-play {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font: inherit;
    font-size: 0.88rem;
    padding: 0.4rem 0.85rem;
    border-radius: 8px;
    border: 1px solid #2b4c8c;
    background: #2b4c8c;
    color: #fff;
    cursor: pointer;
  }
  .read-play.playing {
    background: var(--surface, #fff);
    color: #2b4c8c;
  }
  .ctrl {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--border, #e3e7ef);
    background: var(--surface, #fff);
    color: var(--text, #1c2230);
    cursor: pointer;
  }
  .ctrl.active {
    border-color: #2b4c8c;
    color: #2b4c8c;
    font-weight: 600;
  }
  .read-hint {
    font-size: 0.78rem;
    color: var(--muted, #4a5568);
    margin-left: auto;
  }
</style>
