/**
 * 설정 스토어 — Svelte 5 룬($state) 기반 모듈 상태.
 *
 * - 단일 진실: 메모리의 `settings` 객체(룬). 컴포넌트는 이를 직접 읽고 갱신한다.
 * - 영속: 변경 시 IndexedDB(settings 'global')에 저장. 앱 시작 시 load()로 복원.
 * - 테마: theme 변경 시 <html data-theme>를 갱신해 app.css 의 강제 테마와 연동.
 *
 * 사용:
 *   import { settingsStore } from '../lib/stores/settings.svelte'
 *   await settingsStore.load()           // 앱 시작 1회
 *   settingsStore.value.rate             // 읽기(룬 → 반응형)
 *   settingsStore.setRate(1.5)           // 갱신 + 영속
 */

import { type Settings, DEFAULT_SETTINGS } from '../types'
import { getSettings, saveSettings } from '../db/idb'

// 모듈 스코프 룬 상태(앱 전역 단일 인스턴스)
let settings = $state<Settings>({ ...DEFAULT_SETTINGS })
let loaded = $state(false)

/** theme 설정을 <html data-theme>에 반영(system 이면 속성 제거 → prefers-color-scheme 따름). */
function applyTheme(theme: Settings['theme']): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

/** 현재 settings 를 IndexedDB 에 저장(best-effort, 실패해도 UI는 진행). */
async function persist(): Promise<void> {
  try {
    await saveSettings($state.snapshot(settings))
  } catch (e) {
    console.warn('[settings] 저장 실패(무시):', e)
  }
}

export const settingsStore = {
  /** 반응형 설정 객체(읽기 전용처럼 사용; 변경은 set* 메서드로). */
  get value(): Settings {
    return settings
  },
  /** load() 완료 여부 */
  get loaded(): boolean {
    return loaded
  },

  /** 앱 시작 시 IndexedDB 에서 설정 복원 + 테마 적용. */
  async load(): Promise<void> {
    try {
      settings = await getSettings()
    } catch (e) {
      console.warn('[settings] 로드 실패, 기본값 사용:', e)
      settings = { ...DEFAULT_SETTINGS }
    }
    applyTheme(settings.theme)
    loaded = true
  },

  /** 배속(FN-08) 설정 — 0.75~2.0 권장 범위로 클램프. */
  setRate(rate: number): void {
    const clamped = Math.min(2.0, Math.max(0.5, rate))
    settings.rate = clamped
    void persist()
  },

  /** 테마 변경 + 즉시 <html> 반영. */
  setTheme(theme: Settings['theme']): void {
    settings.theme = theme
    applyTheme(theme)
    void persist()
  },

  /** 선택한 Web Speech 음성(voiceURI) 저장. */
  setVoiceURI(voiceURI: string | undefined): void {
    settings.voiceURI = voiceURI
    void persist()
  },

  /** Supertonic 합성 품질 프리셋 저장(실제 totalStep 매핑은 엔진이 수행). */
  setTtsQuality(q: import('../types').TtsQuality): void {
    settings.ttsQuality = q
    void persist()
  },

  /** 정제/청크 옵션 등 임의 필드를 부분 갱신(설정 화면용). */
  patch(partial: Partial<Settings>): void {
    settings = {
      ...settings,
      ...partial,
      refine: { ...settings.refine, ...(partial.refine ?? {}) },
      chunk: { ...settings.chunk, ...(partial.chunk ?? {}) },
    }
    if (partial.theme) applyTheme(partial.theme)
    void persist()
  },
}
