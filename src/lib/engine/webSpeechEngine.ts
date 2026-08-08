/**
 * FN-04 · Web Speech 어댑터 (부트스트랩 폴백 엔진)
 *
 * RadioEngine 얇은 façade 의 구체 구현. 브라우저 내장 speechSynthesis 를
 * 이 클래스 뒤에 격리한다(façade 시그니처에 브라우저 API 노출 금지).
 *
 * 핵심 규칙(MUST, 03-functional-spec.md FN-04):
 *  - 모든 점프(seekToChunk)는 speechSynthesis.cancel() 선행 후 대상 청크부터 재발화
 *    → 안드로이드/크롬 큐 잔류 버그 회피.
 *  - pause/resume 이 불안정한 환경은 현재 청크 cancel 후 re-speak 폴백으로 처리.
 *  - 무음 청크(kind==='silence')는 발화 없이 silenceMs 만큼 대기 후 다음 청크.
 *  - 배속(setRate)은 재생단에서 즉시 반영(utterance.rate, 브라우저가 피치 보존).
 *
 * 위치(position)의 단일 진실은 시간(ms)이 아니라 chunkIndex 다.
 */

import type { Chunk, EngineEvent, EnginePosition, RadioEngine } from '../types'
import { logEvent } from '../instrumentation'

// ─────────────────────────────────────────────────────────────
// 계측 식별자 컨텍스트
//   logEvent 는 docId/docHash 가 필요하다. 엔진은 청크만 받으므로
//   재생 관련 계측(chunk_play_*, jump_resolved)을 남기려면 이 컨텍스트를
//   외부(UI)가 주입해야 한다. 없으면 재생 계측은 조용히 생략한다(엔진 동작엔 무영향).
// ─────────────────────────────────────────────────────────────
export interface EngineDocContext {
  docId: string
  docHash: string
}

export class WebSpeechEngine implements RadioEngine {
  // ── 내부 상태 ──────────────────────────────────────────────
  private chunks: Chunk[] = []
  private _position: EnginePosition = { chunkIndex: 0, charOffset: 0 }

  /** 재생 중(play 호출 후 stop/end 전)인지 — pause 와 구분 */
  private playing = false
  /** 일시정지 상태 */
  private paused = false

  /** 무음 청크 대기 타이머 핸들 */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** 현재 발화 중인 utterance(중복 onend 무시·cancel 식별용) */
  private currentUtterance: SpeechSynthesisUtterance | null = null

  /** ko-KR 우선 음성 캐시 */
  private voice: SpeechSynthesisVoice | null = null
  private voicesReady = false
  /** 사용자가 선택한 음성 URI(없으면 기본 선택 로직 = 남성 우선) */
  private voiceURI: string | null = null

  /** 배속(FN-08) */
  private rate = 1.0

  /** 계측용 문서 컨텍스트(UI가 setDocContext 로 주입) */
  private docCtx: EngineDocContext | null = null

  // ── 이벤트 리스너 ──────────────────────────────────────────
  private listeners: Record<EngineEvent, Set<(p: EnginePosition) => void>> = {
    chunkChange: new Set(),
    end: new Set(),
  }

  // ── 능력 선언 ─────────────────────────────────────────────
  // wordBoundary: onboundary 로 단어 단위 charOffset 갱신 가능
  // audioBuffer: Web Speech 는 PCM 을 안 주므로 false
  readonly capabilities = { wordBoundary: true, audioBuffer: false }

  constructor(ctx?: EngineDocContext) {
    if (ctx) this.docCtx = ctx
    // 음성 목록을 가능한 한 일찍 준비(비동기 로딩 대비)
    this.primeVoices()
  }

  // ── 위치(읽기 전용 노출) ───────────────────────────────────
  get position(): EnginePosition {
    return this._position
  }

  /**
   * 계측용 문서 컨텍스트 주입. UI가 문서를 로드할 때 호출하면
   * chunk_play_start/end·jump_resolved 가 올바른 docId/docHash 로 적재된다.
   */
  setDocContext(ctx: EngineDocContext | null): void {
    this.docCtx = ctx
  }

  // ── 음성 선택(한국어 우선) ─────────────────────────────────
  /** getVoices 가 비어 있으면 onvoiceschanged 를 한 번 기다렸다 선택 */
  private primeVoices(): void {
    if (typeof speechSynthesis === 'undefined') return
    const pick = () => {
      const voices = speechSynthesis.getVoices()
      if (voices.length === 0) return false
      this.voice = this.selectVoice(voices)
      this.voicesReady = true
      return true
    }
    if (pick()) return
    // 비동기 로딩: 한 번만 듣고 정리
    const handler = () => {
      pick()
      speechSynthesis.removeEventListener('voiceschanged', handler)
    }
    speechSynthesis.addEventListener('voiceschanged', handler)
  }

  /**
   * 음성 선택 우선순위: 사용자 지정(voiceURI) > 한국어 남성 휴리스틱 > 첫 한국어 > null(브라우저 기본).
   * 성별 속성이 표준에서 빠졌으므로 이름 휴리스틱으로 남성을 추정한다(예: Microsoft InJoon).
   */
  private selectVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    if (this.voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === this.voiceURI)
      if (chosen) return chosen
    }
    const ko = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ko'))
    const male = ko.find((v) => /injoon|injun|\bmale\b|남성|남자/i.test(v.name))
    if (male) return male
    if (ko.length > 0) return ko[0]
    if (voices.length > 0) {
      console.warn('[WebSpeechEngine] 한국어(ko) 음성을 찾지 못해 브라우저 기본 음성을 사용합니다.')
    }
    return null
  }

  /** 현재 선택된 음성의 URI(UI 표시 동기화용) */
  get currentVoiceURI(): string | null {
    return this.voice?.voiceURI ?? null
  }

  /** UI 드롭다운용: 사용 가능한 한국어 음성 목록 */
  getKoreanVoices(): { uri: string; name: string }[] {
    if (typeof speechSynthesis === 'undefined') return []
    return speechSynthesis
      .getVoices()
      .filter((v) => v.lang && v.lang.toLowerCase().startsWith('ko'))
      .map((v) => ({ uri: v.voiceURI, name: v.name }))
  }

  /** 음성 선택. null이면 기본 선택(남성 우선). 재생 중이면 즉시 재발화로 반영. */
  setVoice(uri: string | null): void {
    this.voiceURI = uri
    const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : []
    this.voice = this.selectVoice(voices)
    if (this.playing && !this.paused) this.reSpeakCurrent()
  }

  // ── RadioEngine: load ──────────────────────────────────────
  /** 청크 배열 저장 + 위치 초기화. Web Speech 는 즉시 사용 가능하므로 바로 resolve. */
  load(chunks: Chunk[]): Promise<void> {
    this.stopInternal(/* keepPosition */ false)
    this.chunks = chunks
    this._position = { chunkIndex: 0, charOffset: 0 }
    return Promise.resolve()
  }

  // ── RadioEngine: play ──────────────────────────────────────
  /** 현재 chunkIndex 부터 재생 시작 */
  play(): void {
    if (typeof speechSynthesis === 'undefined') {
      console.warn('[WebSpeechEngine] speechSynthesis 를 사용할 수 없는 환경입니다.')
      return
    }
    if (this.chunks.length === 0) return

    // 일시정지에서의 재개
    if (this.paused) {
      this.resumeFromPause()
      return
    }
    // 이미 재생 중이면 무시(중복 speak 방지)
    if (this.playing) return

    this.playing = true
    this.paused = false
    this.speakCurrent()
  }

  // ── RadioEngine: pause ─────────────────────────────────────
  /**
   * speechSynthesis.pause() 시도. 환경 불안정 대비 paused 플래그를 세워두고,
   * resume 이 실제로 동작하지 않으면 resumeFromPause 에서 현재 청크 re-speak 로 폴백.
   */
  pause(): void {
    if (!this.playing || this.paused) return
    this.paused = true

    // 무음 청크 대기 중이면 타이머만 멈춘다(speak 상태 아님)
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
      return
    }
    try {
      speechSynthesis.pause()
    } catch {
      // pause 미지원 — resumeFromPause 의 re-speak 폴백에 맡긴다(취소만 해 둠)
      this.cancelSpeech()
    }
  }

  /**
   * 일시정지 해제. 우선 speechSynthesis.resume() 를 시도하되,
   * 실제로 발화가 재개되지 않는(paused 잔류) 환경에서는 현재 청크를 처음부터 re-speak.
   */
  private resumeFromPause(): void {
    this.paused = false
    if (!this.playing) {
      // pause 도중 stop 된 경우
      return
    }

    // 무음 청크였다면 그대로 다음 진행을 위해 현재 청크부터 재처리
    const cur = this.chunks[this._position.chunkIndex]
    if (cur && cur.kind === 'silence') {
      this.speakCurrent()
      return
    }

    try {
      // 큐에 멈춰 있던 utterance 가 있으면 재개
      if (speechSynthesis.paused && speechSynthesis.speaking) {
        speechSynthesis.resume()
        // 일부 크롬 환경의 resume 무반응 버그 대비: 곧바로 상태 점검 후 폴백
        // (speaking 이 유지되면 정상으로 본다. 폴백은 안전하게 re-speak.)
        return
      }
    } catch {
      /* 폴백으로 진행 */
    }
    // 폴백: 현재 청크를 처음부터 다시 발화(위치 유지)
    this.reSpeakCurrent()
  }

  // ── RadioEngine: stop ──────────────────────────────────────
  /** 발화 취소 + idle. 위치는 유지(이어듣기 친화)한다. */
  stop(): void {
    this.stopInternal(/* keepPosition */ true)
  }

  private stopInternal(keepPosition: boolean): void {
    this.playing = false
    this.paused = false
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    this.cancelSpeech()
    if (!keepPosition) {
      this._position = { chunkIndex: 0, charOffset: 0 }
    }
  }

  // ── RadioEngine: seekToChunk(모든 점프의 단일 진입점) ──────
  /**
   * 대상 청크로 점프. MUST: speechSynthesis.cancel() 선행 후 i 부터 재발화.
   * 'chunkChange' emit + 계측(jump_resolved).
   */
  seekToChunk(i: number): void {
    if (this.chunks.length === 0) return
    const idx = Math.max(0, Math.min(i, this.chunks.length - 1))

    // 안드로이드/크롬 큐 잔류 버그 회피 — 무조건 취소 선행
    this.cancelSpeech()
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }

    this._position = { chunkIndex: idx, charOffset: 0 }
    this.paused = false

    // 점프 안착 계측
    this.track('jump_resolved', idx)
    // 위치 변경 통지
    this.emit('chunkChange')

    // 재생 중이었다면 대상 청크부터 즉시 이어서 발화
    if (this.playing) {
      this.speakCurrent()
    }
  }

  // ── RadioEngine: setRate(FN-08) ────────────────────────────
  /**
   * 배속 저장 + 즉시 반영. 재생 중이면 현재 청크를 cancel 후 새 rate 로 재발화
   * (위치 유지). utterance.rate 는 브라우저가 피치를 보존한다.
   */
  setRate(rate: number): void {
    // 0.75~2.0 권장 범위로 클램프(FN-08 상한 고정)
    const clamped = Math.max(0.5, Math.min(rate, 2.0))
    this.rate = clamped
    // 재생 중(무음 대기 아님)일 때만 즉시 재발화로 반영
    if (this.playing && !this.paused && this.currentUtterance) {
      this.reSpeakCurrent()
    }
  }

  // ── 발화 핵심 ──────────────────────────────────────────────
  /** 현재 chunkIndex 의 청크를 발화(또는 무음 대기). charOffset 0 부터. */
  private speakCurrent(): void {
    this._position = { chunkIndex: this._position.chunkIndex, charOffset: 0 }
    this.speakFrom(this._position.chunkIndex, 0)
  }

  /** 현재 청크를 처음부터 다시 발화(배속 변경·음성 변경·resume 폴백용). */
  private reSpeakCurrent(): void {
    this.cancelSpeech()
    // charOffset 부터 정확히 재개하기는 Web Speech 가 보장하지 못하므로
    // 현재 청크 전체를 처음부터 다시 읽는다(위치=청크 인덱스는 유지).
    // ⚠️ P2: 처음부터 재발화하므로 charOffset 을 0 으로 동기화한다. 이렇게 하지 않으면
    // (예: speakFrom 이 !playing 으로 조기 반환하는 경로 등에서) 멈춘 시점의 옛 charOffset 이
    // 남아 UI 위치/그 시점에 찍는 북마크의 charOffset 이 실제 발화 시작과 어긋난다.
    this._position = { chunkIndex: this._position.chunkIndex, charOffset: 0 }
    this.speakFrom(this._position.chunkIndex, 0)
  }

  /**
   * idx 청크부터 발화 시작. speech 면 utterance, silence 면 setTimeout.
   * @param idx       청크 인덱스
   * @param charStart 청크 내 시작 오프셋(현재는 항상 0; 향후 정밀 재개용 파라미터)
   */
  private speakFrom(idx: number, charStart: number): void {
    if (!this.playing) return
    if (idx >= this.chunks.length) {
      this.finishAll()
      return
    }
    const chunk = this.chunks[idx]
    this._position = { chunkIndex: idx, charOffset: charStart }

    // 무음 청크: 발화 없이 대기 후 다음
    if (chunk.kind === 'silence') {
      const ms = chunk.silenceMs ?? 0
      this.track('chunk_play_start', idx)
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null
        this.track('chunk_play_end', idx)
        this.advance()
      }, ms)
      return
    }

    // speech 청크: 빈 텍스트면 건너뜀(FN-04 길이 0 처리)
    // ⚠️ 합성(발화) 입력만 spokenText 로 대체한다(발음 최적화). chunk.text(표시·점프·북마크용)는 절대 안 바뀐다.
    //    빈 텍스트 판정도 "실제 발화할 텍스트(spokenText ?? text)" 기준으로 일관되게(undefined→text 폴백, ''→스킵).
    const speakText = chunk.spokenText ?? chunk.text ?? ''
    // spokenText 가 존재하면 발화 길이가 text 와 달라 onboundary 의 charIndex 가 text 위치와 어긋난다.
    // → 그런 청크는 charOffset 갱신을 건너뛰고 청크 시작(0)에 고정한다(북마크는 chunkIndex 기준이라 안전).
    const hasSpoken = typeof chunk.spokenText === 'string'
    if (speakText.trim().length === 0) {
      this.advance()
      return
    }

    if (typeof SpeechSynthesisUtterance === 'undefined' || typeof speechSynthesis === 'undefined') {
      return
    }

    // [안드로이드] 음성 목록이 늦게 준비되는 기기 대비: 아직 미선택이면 지금 다시 선택 시도.
    // (voiceschanged 이전에 play 하면 voice=null 인 채 lang 만으로 발화돼 무음이 될 수 있다)
    if (!this.voice) {
      const vs = speechSynthesis.getVoices()
      if (vs.length > 0) {
        this.voice = this.selectVoice(vs)
        this.voicesReady = true
      }
    }

    const u = new SpeechSynthesisUtterance(speakText)
    if (this.voice) u.voice = this.voice
    u.lang = this.voice?.lang ?? 'ko-KR'
    // 강조 배율(chunk.rateScale)이 있으면 전역 배속에 곱해 적용.
    // reSpeakCurrent 도 speakFrom 을 호출하므로 자동 반영된다.
    u.rate = this.rate * (chunk.rateScale ?? 1.0)
    this.currentUtterance = u

    // 단어 경계 → charOffset 갱신(미지원 환경 대비 안전 처리)
    // ⚠️ spokenText 로 발화하는 청크는 charIndex(발화 텍스트 기준)가 원문 text 위치와 어긋나므로
    //    charOffset 을 갱신하지 않고 청크 시작(0)에 고정한다(북마크는 chunkIndex 기준이라 정확성 유지).
    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (this.currentUtterance !== u) return
      if (hasSpoken) return // 발음정제 청크: charOffset 0 고정(charIndex 가 text 와 불일치)
      // charIndex 가 유효할 때만 갱신(charLength 가 없는 브라우저 있음)
      const ci = ev.charIndex
      if (typeof ci === 'number' && ci >= 0 && ci <= speakText.length) {
        this._position = { chunkIndex: idx, charOffset: charStart + ci }
      }
    }

    u.onstart = () => {
      if (this.currentUtterance !== u) return
      this.track('chunk_play_start', idx)
    }

    u.onend = () => {
      // cancel 로 교체된 옛 utterance 의 onend 는 무시
      if (this.currentUtterance !== u) return
      this.currentUtterance = null
      this.track('chunk_play_end', idx)
      // 일시정지 중이면 진행을 멈춘다(재개 시 처리)
      if (this.paused || !this.playing) return
      this.advance()
    }

    u.onerror = (ev: SpeechSynthesisErrorEvent) => {
      if (this.currentUtterance !== u) return
      this.currentUtterance = null
      // 'interrupted'/'canceled' 는 우리가 cancel 한 정상 흐름 — 진행 결정은 호출부가 한다
      if (ev.error === 'interrupted' || ev.error === 'canceled') return
      console.warn('[WebSpeechEngine] 발화 오류, 다음 청크로 진행:', ev.error)
      if (this.paused || !this.playing) return
      this.advance()
    }

    try {
      // [안드로이드/크롬] speechSynthesis 가 내부적으로 paused 로 굳어 있으면 speak 가 무음이 된다 → 먼저 resume.
      if (speechSynthesis.paused) speechSynthesis.resume()
      speechSynthesis.speak(u)
    } catch (e) {
      console.warn('[WebSpeechEngine] speak 실패, 다음 청크로 진행:', e)
      this.currentUtterance = null
      this.advance()
    }
  }

  /** 다음 청크로 진행. 마지막이면 end. 진행 시 chunkChange emit. */
  private advance(): void {
    const next = this._position.chunkIndex + 1
    if (next >= this.chunks.length) {
      this.finishAll()
      return
    }
    this._position = { chunkIndex: next, charOffset: 0 }
    this.emit('chunkChange')
    this.speakFrom(next, 0)
  }

  /** 전체 종료 처리 */
  private finishAll(): void {
    this.playing = false
    this.paused = false
    this.currentUtterance = null
    this.emit('end')
  }

  // ── 발화 취소(공통) ────────────────────────────────────────
  /** 진행 중 utterance 를 폐기하고 큐를 비운다(onend 콜백 무력화 포함). */
  private cancelSpeech(): void {
    // currentUtterance 를 먼저 끊어 옛 콜백이 advance 하지 않게 한다
    this.currentUtterance = null
    try {
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
    } catch {
      /* noop */
    }
  }

  // ── 이벤트 관리 ────────────────────────────────────────────
  on(event: EngineEvent, cb: (p: EnginePosition) => void): void {
    this.listeners[event].add(cb)
  }

  off(event: EngineEvent, cb: (p: EnginePosition) => void): void {
    this.listeners[event].delete(cb)
  }

  /** 현재 position 을 해당 이벤트 리스너 전원에게 통지(리스너 예외는 격리) */
  private emit(event: EngineEvent): void {
    const snapshot = this._position
    for (const cb of this.listeners[event]) {
      try {
        cb(snapshot)
      } catch (e) {
        console.warn('[WebSpeechEngine] 리스너 예외:', e)
      }
    }
  }

  // ── 계측 헬퍼 ──────────────────────────────────────────────
  /** docCtx 가 있을 때만 재생 관련 이벤트를 적재(없으면 무해하게 생략) */
  private track(type: 'chunk_play_start' | 'chunk_play_end' | 'jump_resolved', chunkIndex: number): void {
    if (!this.docCtx) return
    logEvent(type, { docId: this.docCtx.docId, docHash: this.docCtx.docHash, chunkIndex })
  }
}
