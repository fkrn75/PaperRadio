<script lang="ts">
  /**
   * PDF 입력 — 드래그앤드롭 + 파일 선택.
   *
   * 실제 변환(열기·추출·청크·저장)은 lib/pdf/document.ts 가 맡고, 여기서는 파일을 받아
   * 진행 상황을 보여주는 일만 한다.
   *
   * ⚠️ 마크다운/텍스트와 달리 PDF 는 **비동기 + 체감 시간**이 있다(136쪽 문서 기준 수 초).
   *    진행 표시 없이 두면 사용자가 멈춘 줄 안다.
   */
  import type { StoredDocument } from '../lib/types'
  import { importPdfFile, type ImportProgress } from '../lib/pdf/document'

  interface Props {
    /** 가져오기 성공 → 저장된 문서 전달. */
    onimported: (doc: StoredDocument) => void
  }
  const { onimported }: Props = $props()

  /** 5MB 넘으면 한 번 확인(수십 MB PDF 는 저장 용량·추출 시간이 모두 커진다). */
  const WARN_BYTES = 20 * 1024 * 1024

  let dragging = $state(false)
  let busy = $state(false)
  let progress = $state<ImportProgress | null>(null)
  let error = $state('')

  const progressLabel = $derived.by(() => {
    const p = progress
    if (!p) return ''
    if (p.phase === 'opening') return 'PDF 여는 중…'
    if (p.phase === 'extracting') return `텍스트 읽는 중… ${p.page ?? 0}/${p.pageCount ?? 0}쪽`
    if (p.phase === 'chunking') return '문장으로 나누는 중…'
    return '저장 중…'
  })

  const progressPct = $derived.by(() => {
    const p = progress
    if (!p || p.phase === 'opening') return 0
    if (p.phase === 'extracting' && p.pageCount) return Math.round(((p.page ?? 0) / p.pageCount) * 90)
    return p.phase === 'chunking' ? 95 : 99
  })

  async function handleFile(file: File): Promise<void> {
    error = ''
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      error = 'PDF 파일만 열 수 있습니다'
      return
    }
    if (file.size === 0) {
      error = '빈 파일입니다'
      return
    }
    if (file.size > WARN_BYTES) {
      const mb = (file.size / 1048576).toFixed(0)
      if (!confirm(`${mb}MB 파일입니다. 읽는 데 시간이 걸리고 저장 공간도 그만큼 씁니다. 계속할까요?`)) return
    }

    busy = true
    try {
      const doc = await importPdfFile(file, { onProgress: (p) => (progress = p) })
      onimported(doc)
    } catch (e) {
      error = `열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
      progress = null
    }
  }

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // 같은 파일을 다시 골라도 change 가 뜨도록 값을 비운다.
    input.value = ''
    if (file) void handleFile(file)
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    dragging = false
    if (busy) return
    const file = e.dataTransfer?.files?.[0]
    if (file) void handleFile(file)
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="dropzone"
  class:dragging
  class:busy
  ondragover={(e) => {
    e.preventDefault()
    if (!busy) dragging = true
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if busy}
    <div class="progress">
      <div class="bar"><div class="fill" style:width="{progressPct}%"></div></div>
      <p class="dz-sub">{progressLabel}</p>
    </div>
  {:else}
    <p class="dz-title">PDF를 여기에 놓거나</p>
    <label class="pick">
      파일 선택
      <input type="file" accept=".pdf,application/pdf" onchange={onPick} hidden />
    </label>
    <p class="dz-sub">원본 그대로 보면서 들을 수 있습니다</p>
  {/if}
</div>

{#if error}
  <p class="err" role="alert">{error}</p>
{/if}

<style>
  .dropzone {
    border: 2px dashed var(--border, #e3e7ef);
    border-radius: 12px;
    padding: 2rem 1rem;
    text-align: center;
    background: var(--surface, #fff);
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .dropzone.dragging {
    border-color: #2b4c8c;
    background: var(--accent-weak, #eef2fb);
  }
  .dropzone.busy {
    border-style: solid;
  }
  .dz-title {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    color: var(--text, #1c2230);
  }
  .dz-sub {
    margin: 0.75rem 0 0;
    font-size: 0.82rem;
    color: var(--muted, #4a5568);
  }
  .pick {
    display: inline-block;
    padding: 0.5rem 1.1rem;
    border-radius: 8px;
    background: #2b4c8c;
    color: #fff;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .progress {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--border, #e3e7ef);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #2b4c8c;
    transition: width 0.2s;
  }
  .err {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
    color: #c0392b;
  }
</style>
