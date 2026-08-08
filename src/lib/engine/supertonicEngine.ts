/**
 * FN-04 · Supertonic 어댑터 (정체성 엔진 · 온디바이스 TTS)
 *
 * RadioEngine 얇은 façade 의 구체 구현. Supertonic v2(한국어 지원) ONNX 파이프라인을
 * Web Worker(supertonic.worker.ts) 뒤에 격리하고, 합성된 Float32 PCM 을 AudioContext 로 재생한다.
 * (façade 시그니처에 onnxruntime/AudioContext 등 백엔드 API 노출 금지 — webSpeechEngine 과 동일 계약)
 *
 * 핵심 설계(블루프린트):
 *  - capabilities = { audioBuffer: true, wordBoundary: false }
 *  - load(chunks): 'loading-model' → 워커 모델 로딩 → 청크 보관 → 첫 청크 prefetch 합성. position {0,0}.
 *  - 재생: AudioContext + AudioBufferSourceNode 큐. PCM(44.1kHz) → createBuffer → 재생.
 *  - 더블버퍼: 재생 중 다음 speech 청크를 백그라운드로 미리 합성(끊김 방지).
 *  - 무음 청크(kind==='silence'): 합성 건너뛰고 silenceMs 만큼 setTimeout 대기.
 *  - seekToChunk(i): 큐/타이머/진행 합성 취소 후 i 부터 재합성(점프 단일 진입점) + chunkChange emit.
 *  - setRate(rate): worker synth 의 speed 인자(피치 보존). 다음 합성부터 반영(이미 합성된 버퍼는 유지).
 *  - 한국어 120자 한도: 워커 synth 가 내부적으로 maxLen 120 재분할 → 어댑터는 청크 통째로 위임(안전).
 *
 * 위치(position)의 단일 진실은 chunkIndex. charOffset 은 워드바운더리가 없어 항상 0.
 */

import type { Chunk, EngineEvent, EnginePosition, RadioEngine } from '../types'
import { logEvent } from '../instrumentation'
import { isDebug, isForceWasm } from '../debug/flag'
import {
  DEFAULT_SPEED,
  DEFAULT_TOTAL_STEP,
  DEFAULT_VOICE_URI,
  MODEL_REPO,
  MODEL_REVISION,
  VOICE_CATALOG,
  resolveVoice,
  type WorkerRequest,
  type WorkerResponse,
} from './supertonicProtocol'
import { isIOS, isMobile } from './platform'

export interface EngineDocContext {
  docId: string
  docHash: string
}

/** 모델 로딩 진행률(UI 표시용). createEngine 사용처에서 onModelProgress 로 구독. */
export interface ModelLoadProgress {
  phase: 'download' | 'session'
  label: string
  /** 0~1 */
  ratio: number
}

/** 합성된 청크의 오디오 버퍼 캐시 엔트리. */
interface SynthEntry {
  /** 합성 완료된 AudioBuffer(무음 청크는 null = 타이머 대기) */
  buffer: AudioBuffer | null
  /** 합성에 쓰인 speed(= this.rate * rateScale, 배속 변경 감지용) */
  speed: number
  /** 합성에 쓰인 voiceUri(음성 변경 감지용) */
  voiceUri: string
  /** 합성에 쓰인 totalStep(품질 변경 감지용) */
  totalStep: number
  durationSec: number
  /** 합성에 쓰인 rateScale(강조 배율 변경 감지용). 기본 1.0. */
  rateScale: number
}

export class SupertonicEngine implements RadioEngine {
  // ── 능력 선언 ─────────────────────────────────────────────
  // audioBuffer: PCM/AudioBuffer 경로(O), wordBoundary: 단어경계 콜백 없음(X)
  readonly capabilities = { wordBoundary: false, audioBuffer: true }

  // ── 내부 상태 ──────────────────────────────────────────────
  private chunks: Chunk[] = []
  private _position: EnginePosition = { chunkIndex: 0, charOffset: 0 }

  private playing = false
  private paused = false

  /** 모델 로딩 완료 여부 */
  private modelReady = false
  /** 모델 로딩 진행 Promise(중복 load 방지) */
  private loadingPromise: Promise<void> | null = null

  /** 배속(FN-08). worker speed 로 전달(피치 보존) */
  private rate = DEFAULT_SPEED
  /** 선택된 음성 URI(기본 남성 M1) */
  private voiceURI: string = DEFAULT_VOICE_URI

  /** denoising step(품질↔속도) */
  private totalStep = DEFAULT_TOTAL_STEP

  /** 계측용 문서 컨텍스트 */
  private docCtx: EngineDocContext | null = null

  /** 모델 진행률 외부 구독 콜백 */
  private modelProgressCb: ((p: ModelLoadProgress) => void) | null = null
  /** 모델 로딩 오류 외부 구독 콜백(UI 재시도 버튼 노출용) */
  private modelErrorCb: ((msg: string) => void) | null = null
  /** 연속 합성 실패 횟수(워커 8스텝 자기복구까지 실패한 경우만 누적 — 죽은 GPU 표면화용). */
  private consecutiveSynthFails = 0
  /**
   * GPU device 오염(lost) 자동복구로 WASM(CPU) EP 에 고정되었는지.
   * 세션 동안 sticky — WebGPU 재오염을 막는다(완전한 WebGPU 재시도는 페이지 새로고침으로만).
   */
  private forceWasm = false
  /** 자동복구 진행 중 플래그(재진입·복구 루프 방지). */
  private recovering = false
  /** 사용 백엔드(webgpu|wasm) — 로딩 후 채워짐 */
  private backend: 'webgpu' | 'wasm' | null = null
  /** 모델 PCM 샘플레이트(load-done 에서 수신, 보통 44100). AudioBuffer 생성에 사용. */
  private modelSampleRate = 44100

  // ── 오디오 ─────────────────────────────────────────────────
  private ctx: AudioContext | null = null
  /** 현재 재생 중인 소스 노드(정지/점프 시 stop) */
  private currentSource: AudioBufferSourceNode | null = null
  /** 무음 청크 대기 타이머 */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 재생 흐름 세대(generation). stopSource/seek/restart 마다 +1.
   * playCurrent 가 비동기 합성을 await 하는 동안 흐름이 리셋되면(점프/음성변경/정지),
   * 캡처한 세대와 현재 세대가 달라져 stale 한 then 콜백(advance/playBuffer)을 무시한다.
   * (취소가 buffer=null 로 resolve 될 때 엉뚱한 advance 가 발생하는 레이스 방지)
   */
  private playGen = 0

  // ── 합성 캐시/워커 ─────────────────────────────────────────
  private worker: Worker | null = null
  /** chunkIndex → 합성 결과 캐시 */
  private synthCache = new Map<number, SynthEntry>()
  /** chunkIndex → 진행 중 합성 Promise(중복 합성 방지) */
  private pendingSynth = new Map<number, Promise<SynthEntry>>()
  /** 합성 요청 id → resolver(워커 응답 매칭) */
  private synthResolvers = new Map<
    number,
    { resolve: (e: SynthEntry) => void; reject: (err: Error) => void; chunkIndex: number }
  >()
  /** 요청 id 시퀀스 */
  private reqSeq = 0

  // ── 이벤트 ─────────────────────────────────────────────────
  private listeners: Record<EngineEvent, Set<(p: EnginePosition) => void>> = {
    chunkChange: new Set(),
    end: new Set(),
  }

  constructor(ctx?: EngineDocContext) {
    if (ctx) this.docCtx = ctx
    // ?wasm=1 디버그 스위치: 처음부터 WASM(CPU) EP 로 로드(WebGPU 건너뜀).
    // 폰에서 WASM 합성이 실제로 소리를 내는지/속도를 직접 검증하기 위함(자동복구의 전제 확인).
    if (isForceWasm()) {
      this.forceWasm = true
      if (isDebug()) console.info('[MR] ?wasm=1 → 처음부터 WASM(CPU) 강제 로드')
    }
  }

  // ── 위치 ───────────────────────────────────────────────────
  get position(): EnginePosition {
    return this._position
  }

  setDocContext(ctx: EngineDocContext | null): void {
    this.docCtx = ctx
  }

  /** 모델 다운로드/세션 진행률 구독(UI). load 전에 등록 권장. */
  onModelProgress(cb: ((p: ModelLoadProgress) => void) | null): void {
    this.modelProgressCb = cb
  }

  /** 모델 로딩 오류 구독(UI). 오류 시 메시지를 받아 재시도 버튼 등을 노출할 수 있다. */
  onModelError(cb: ((msg: string) => void) | null): void {
    this.modelErrorCb = cb
  }

  /**
   * 모델 로딩 재시도. 직전 로딩이 실패(load-error)한 뒤 호출.
   * modelReady/loadingPromise 를 리셋하고 ensureModel 을 다시 돌려 워커에 load 를 재요청한다.
   */
  retryLoad(): Promise<void> {
    this.modelReady = false
    this.loadingPromise = null
    return this.ensureModel()
  }

  /** 사용 중 백엔드(UI 배지용). 로딩 전 null. */
  get activeBackend(): 'webgpu' | 'wasm' | null {
    return this.backend
  }

  // ── 음성 ───────────────────────────────────────────────────
  /** UI 드롭다운용: Supertonic 음성 목록(M1~M5/F1~F5). */
  getKoreanVoices(): { uri: string; name: string }[] {
    return VOICE_CATALOG.map((v) => ({ uri: v.uri, name: v.name }))
  }

  get currentVoiceURI(): string | null {
    return this.voiceURI
  }

  /**
   * 음성 선택. null 이면 기본(남성 M1). 음성이 바뀌면 합성 캐시를 무효화하고
   * 재생 중이면 현재 청크부터 새 음성으로 재합성(점프와 동일 경로).
   */
  setVoice(uri: string | null): void {
    const next = resolveVoice(uri).uri
    if (next === this.voiceURI) return
    this.voiceURI = next
    // 음성이 바뀌면 모든 캐시 무효(스타일이 달라짐)
    this.invalidateSynth()
    if (this.playing && !this.paused) {
      // 현재 청크부터 새 음성으로 다시(위치 유지)
      this.restartFromCurrent()
    } else {
      // 정지/일시정지 중이면 현재 청크 prefetch 만
      void this.ensureSynth(this._position.chunkIndex)
    }
  }

  // ── RadioEngine: load ──────────────────────────────────────
  /**
   * 청크 보관 + 모델 로딩 보장 + 첫 청크 prefetch.
   * state 전이는 UI(stores)가 position/이벤트로 관찰하므로 엔진은 내부 플래그만 관리한다.
   */
  async load(chunks: Chunk[]): Promise<void> {
    this.stopInternal(false)
    this.invalidateSynth()
    this.chunks = chunks
    this._position = { chunkIndex: 0, charOffset: 0 }

    // 모델 로딩 보장(중복 방지)
    await this.ensureModel()

    // ⚠️ 여기서 첫 청크를 prefetch 하지 않는다. 호출부(openDocument)가 시작 위치로
    //    seekToChunk(resume) 를 호출해 '그 청크 하나만' prefetch 한다.
    //    예전엔 load 가 chunk 0 을, 직후 seekToChunk 가 resume 을 '각각' 합성해 두 합성이 동시에
    //    GPU 추론을 돌렸고, 모바일에서 이 동시 추론이 hang(이어듣기 재오픈 무음)했다.
    //    단일 prefetch 로 합쳐 그 동시성을 없앤다(동시 합성=모바일 GPU hang 의 또 다른 원인).
  }

  // ── RadioEngine: play ──────────────────────────────────────
  play(): void {
    if (this.chunks.length === 0) return

    // [iOS] play() 는 사용자 제스처(재생 버튼)에서 호출되므로, 이 시점에 AudioContext 를
    // 생성·resume 해 두면 iOS 자동재생 차단을 푼다. 모델 로딩(await) 뒤에 resume 하면
    // 제스처 컨텍스트를 벗어나 차단될 수 있어, 여기서 동기적으로 보장한다.
    // (플랫폼 무관하게 suspended 면 resume 시도해도 무해 — 일반 브라우저도 안전)
    this.ensureCtxResumed()

    if (this.paused) {
      this.resumeFromPause()
      return
    }
    if (this.playing) return

    this.playing = true
    this.paused = false
    void this.ensureModel().then(() => {
      if (this.playing && !this.paused) this.playCurrent()
    })
  }

  // ── RadioEngine: pause ─────────────────────────────────────
  /**
   * AudioContext.suspend() 로 일시정지(샘플 위치 보존). 무음 대기 중이면 타이머만 멈춘다.
   */
  pause(): void {
    if (!this.playing || this.paused) return
    this.paused = true

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
      return
    }
    if (this.ctx && this.ctx.state === 'running') {
      void this.ctx.suspend()
    }
  }

  private resumeFromPause(): void {
    this.paused = false
    if (!this.playing) return

    const cur = this.chunks[this._position.chunkIndex]
    if (cur && cur.kind === 'silence') {
      // 무음 청크 재개: 처음부터 다시 대기(간단·안전)
      this.playCurrent()
      return
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume()
      return
    }
    // 컨텍스트가 없거나 소스가 끝난 경우 현재 청크부터 재생
    this.playCurrent()
  }

  // ── RadioEngine: stop ──────────────────────────────────────
  /** 재생 중단 + idle. 위치 유지(이어듣기 친화). */
  stop(): void {
    this.stopInternal(true)
  }

  private stopInternal(keepPosition: boolean): void {
    this.playing = false
    this.paused = false
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    this.stopSource()
    if (this.ctx && this.ctx.state === 'suspended') {
      // 재개 가능 상태로 두지 않도록 running 으로 되돌림(다음 play 대비)
      void this.ctx.resume().catch(() => {})
    }
    if (!keepPosition) {
      this._position = { chunkIndex: 0, charOffset: 0 }
    }
  }

  // ── RadioEngine: seekToChunk(모든 점프의 단일 진입점) ──────
  /**
   * 대상 청크로 점프. 진행 중 재생/타이머/합성을 취소하고 i 부터 재합성·재생.
   * 'chunkChange' emit + 계측(jump_resolved).
   */
  seekToChunk(i: number): void {
    if (this.chunks.length === 0) return
    const idx = Math.max(0, Math.min(i, this.chunks.length - 1))

    this.stopSource()
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    // 진행 중인(현재 위치) 합성은 취소하되, 캐시는 유지(같은 speed/voice 면 재사용 가능)
    this.cancelPendingExcept(idx)

    this._position = { chunkIndex: idx, charOffset: 0 }
    this.paused = false

    this.track('jump_resolved', idx)
    this.emit('chunkChange')

    if (this.playing) this.playCurrent()
    else void this.ensureSynth(this.firstSynthIndexFrom(idx))
  }

  // ── RadioEngine: setRate(FN-08) ────────────────────────────
  /**
   * 배속 저장. worker synth 의 speed 로 전달(피치 보존).
   * 이미 합성된 버퍼는 유지하고, 다음 합성부터 새 배속 반영(블루프린트 허용).
   * 단, 현재 재생 중인 청크 이후의 미합성/다른배속 캐시는 무효화해 일관성 유지.
   */
  setRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(rate, 2.0))
    if (clamped === this.rate) return
    this.rate = clamped
    // 현재 청크는 그대로 두고, 다음(prefetch) 캐시 중 배속이 다른 것을 비워 재합성 유도
    for (const [k, v] of this.synthCache) {
      if (k > this._position.chunkIndex && v.speed !== clamped) this.synthCache.delete(k)
    }
    for (const k of [...this.pendingSynth.keys()]) {
      if (k > this._position.chunkIndex) this.cancelSynthReq(k)
    }
    // 다음 청크 미리 합성(새 배속)
    if (this.playing) void this.ensureSynth(this.firstSynthIndexFrom(this._position.chunkIndex + 1))
  }

  // ── 품질(totalStep) 변경 ───────────────────────────────────
  /**
   * 합성 품질(denoising totalStep) 변경. clamp 1~30.
   * 현재값과 같으면 무시. 현재 위치 '이후'의 캐시/진행 합성을 무효화해 새 품질로 재합성을 유도하고,
   * 재생 중이면 다음 청크를 즉시 재합성 트리거(현재 재생 중인 버퍼는 유지 → 끊김/회귀 방지).
   * (setRate 와 동일한 보수적 정책: 현재 청크는 건드리지 않음)
   */
  setTotalStep(step: number): void {
    let clamped = Math.max(1, Math.min(Math.round(step), 30))
    // [모바일] 12스텝(고품질 프리셋)은 모바일 GPU 워치독을 넘겨 합성이 hang(무음+멈춤)한다(실측 확인).
    // 폰/태블릿에서는 GPU 가 감당하는 안전 상한(8=표준)으로 자동 제한한다 — 고품질을 골라도 무음
    // 대신 안정적으로 소리가 난다(8↔12 의 음질 차이는 미미). 데스크탑은 제한 없음.
    const MOBILE_MAX_STEP = 8
    if (isMobile() && clamped > MOBILE_MAX_STEP) {
      if (isDebug()) console.info('[MR] 모바일 step 상한 적용 ' + clamped + '→' + MOBILE_MAX_STEP)
      clamped = MOBILE_MAX_STEP
    }
    if (clamped === this.totalStep) return
    this.totalStep = clamped
    // 현재 청크는 그대로 두고, 이후(prefetch) 캐시 중 품질이 다른 것을 비워 재합성 유도
    for (const [k, v] of this.synthCache) {
      if (k > this._position.chunkIndex && v.totalStep !== clamped) this.synthCache.delete(k)
    }
    for (const k of [...this.pendingSynth.keys()]) {
      if (k > this._position.chunkIndex) this.cancelSynthReq(k)
    }
    // 재생 중이면 다음 청크 미리 합성(새 품질)
    if (this.playing) void this.ensureSynth(this.firstSynthIndexFrom(this._position.chunkIndex + 1))
  }

  // ── 재생 핵심 ──────────────────────────────────────────────
  /** 현재 chunkIndex 의 청크를 재생(무음이면 대기). */
  private playCurrent(): void {
    if (!this.playing) return
    const idx = this._position.chunkIndex
    if (idx >= this.chunks.length) {
      this.finishAll()
      return
    }
    const chunk = this.chunks[idx]
    this._position = { chunkIndex: idx, charOffset: 0 }

    // 무음 청크: 합성 없이 대기 후 다음
    if (chunk.kind === 'silence') {
      const ms = chunk.silenceMs ?? 0
      this.track('chunk_play_start', idx)
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null
        this.track('chunk_play_end', idx)
        this.advance()
      }, ms)
      // 다음 speech 청크 더블버퍼
      void this.ensureSynth(this.firstSynthIndexFrom(idx + 1))
      return
    }

    // speech 청크: 빈 텍스트면 건너뜀
    if (!chunk.text || chunk.text.trim().length === 0) {
      this.advance()
      return
    }

    // 합성 결과를 받아 재생(없으면 합성 대기). 현재 세대를 캡처해 stale 콜백 무시.
    const gen = this.playGen
    const t0 = isDebug() ? performance.now() : 0
    void this.ensureSynth(idx)
      .then((entry) => {
        if (isDebug()) {
          console.info(
            '[diag] synth idx',
            idx,
            '| backend',
            this.activeBackend,
            '| buffer',
            entry?.buffer ? `${entry.buffer.length}smp@${entry.buffer.sampleRate}Hz` : 'NULL/EMPTY',
            '| wait',
            Math.round(performance.now() - t0),
            'ms',
          )
        }
        // 대기 사이 흐름이 리셋(점프/음성변경/정지)되었거나 위치가 바뀌었으면 폐기
        if (gen !== this.playGen) return
        if (!this.playing || this.paused || this._position.chunkIndex !== idx) return
        if (!entry.buffer) {
          // 버퍼가 없으면(취소/이례적) 다음으로
          this.advance()
          return
        }
        this.consecutiveSynthFails = 0 // 정상 합성 → 실패 누적 리셋
        void this.playBuffer(entry.buffer, idx)
        // 더블버퍼: 다음 speech 청크 미리 합성
        void this.ensureSynth(this.firstSynthIndexFrom(idx + 1))
      })
      .catch((e) => {
        if (gen !== this.playGen) return
        console.warn('[SupertonicEngine] 합성 실패, 다음 청크로:', e)
        // 합성 hang(워커 90s 타임아웃)이면 워커를 재생성(webgpu)해 자가복구한다.
        // = 사용자가 찾은 워크어라운드(음질 기본↔고품질 토글로 엔진 재생성→소리남)의 자동화.
        // WASM 강제전환은 폐기했다(폰 WASM 로드가 느려/hang 해 복구 대기 중 재생이 영구 정지하는 역효과).
        // recoverWorker 가 재로딩에 타임아웃 가드를 둬 트랩을 막으므로 기본 ON 으로 둔다.
        // ⚠️ '시간 초과' 는 워커 SYNTH_HANG 타임아웃 메시지(synthWithGuard)와 결합 — 함께 유지.
        const isHang = e instanceof Error && e.message.includes('시간 초과')
        if (isHang && this.backend === 'webgpu' && !this.forceWasm && !this.recovering) {
          if (isDebug()) console.info('[MR] 합성 hang 감지 → 워커 재생성 자동복구 트리거')
          void this.recoverWorker() // 복구가 현재 청크부터 재생을 이어간다(여기서 advance 하지 않음)
          return
        }
        // 그 외 일반 합성 오류: 연속 2회면 사용자에게 표면화(무음+멈춤 방치 방지). 성공 시 카운터 리셋.
        if (++this.consecutiveSynthFails >= 2) {
          this.consecutiveSynthFails = 0
          this.modelErrorCb?.(
            '음성 합성이 반복 실패했습니다. 음질을 표준으로 낮추거나 "다시 시도"를 눌러보세요.',
          )
        }
        if (this.playing && !this.paused && this._position.chunkIndex === idx) this.advance()
      })
  }

  /** AudioBuffer 를 소스 노드로 재생하고 onended 에서 advance. */
  private async playBuffer(buffer: AudioBuffer, idx: number): Promise<void> {
    const ctx = this.getCtx()
    // [안드로이드/iOS] suspended 면 resume 이 "완료된 뒤" start 해야 한다.
    // void resume 후 곧바로 start 하면 resume 미완료 상태로 재생돼 소리가 안 난다(무음).
    // 특히 모델이 캐시된 2회차부터는 합성이 빨라 이 레이스가 더 잘 터진다.
    let resumed = false
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
        resumed = true
      } catch {
        /* resume 실패해도 아래 start 는 시도(일부 환경은 그래도 소리가 난다) */
      }
    }
    // resume 대기 사이에 정지/일시정지로 흐름이 바뀌었으면 폐기(유령 재생 방지)
    if (!this.playing || this.paused) return

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    this.currentSource = src

    if (isDebug()) console.info('[MR] play chunk=' + idx + ' ctx=' + ctx.state + (resumed ? ' (resumed)' : ''))
    this.track('chunk_play_start', idx)
    src.onended = () => {
      // 우리가 stop() 한 소스의 onended 는 무시(currentSource 교체로 식별)
      if (this.currentSource !== src) return
      this.currentSource = null
      this.track('chunk_play_end', idx)
      if (this.paused || !this.playing) return
      this.advance()
    }
    try {
      // ⚠️ [모바일] suspended→resume 직후엔 출력 디바이스 스핀업에 수십~수백 ms 가 걸려,
      //    곧바로 start() 하면 버퍼 앞부분(speech)의 한두 음절이 삼켜진다('앞 음절 누락').
      //    긴 문장은 합성이 길어 그 사이 context 가 suspend 되므로 이 경로를 자주 탄다.
      //    resume 한 경우에만 살짝 미래(now+LEAD)에 예약해 스핀업이 무음 구간을 먹게 한다.
      //    이미 running 이던 PC 등은 지연 0(기존과 동일).
      const RESUME_LEAD_SEC = 0.18
      src.start(resumed ? ctx.currentTime + RESUME_LEAD_SEC : 0)
    } catch (e) {
      console.warn('[SupertonicEngine] 재생 시작 실패, 다음 청크로:', e)
      this.currentSource = null
      this.advance()
    }
  }

  /** 다음 청크로 진행. 마지막이면 end. */
  private advance(): void {
    const next = this._position.chunkIndex + 1
    if (next >= this.chunks.length) {
      this.finishAll()
      return
    }
    this._position = { chunkIndex: next, charOffset: 0 }
    this.emit('chunkChange')
    this.playCurrent()
  }

  private finishAll(): void {
    this.playing = false
    this.paused = false
    this.stopSource()
    this.emit('end')
  }

  /** 음성 변경 등으로 현재 청크부터 새로 시작(위치 유지). */
  private restartFromCurrent(): void {
    this.stopSource()
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    this.playCurrent()
  }

  /** 현재 소스 노드 정지/해제(onended 무력화 포함). 재생 흐름 세대도 올려 stale 콜백 무효화. */
  private stopSource(): void {
    this.playGen++ // 진행 중 await 중인 playCurrent 콜백을 무효화
    const src = this.currentSource
    this.currentSource = null // 먼저 끊어 onended 가 advance 하지 않게
    if (src) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* 이미 끝남 */
      }
      try {
        src.disconnect()
      } catch {
        /* noop */
      }
    }
  }

  // ── 합성(워커 호출) ────────────────────────────────────────
  /**
   * idx 청크 합성 보장. 캐시 히트(같은 speed/voice)면 즉시 반환,
   * 진행 중이면 그 Promise 공유, 없으면 워커에 합성 요청.
   * 무음/빈 청크는 buffer=null 엔트리로 즉시 resolve.
   */
  private ensureSynth(idx: number): Promise<SynthEntry> {
    if (idx < 0 || idx >= this.chunks.length) {
      return Promise.resolve({
        buffer: null,
        speed: this.rate,
        voiceUri: this.voiceURI,
        totalStep: this.totalStep,
        durationSec: 0,
        rateScale: 1.0,
      })
    }
    const chunk = this.chunks[idx]
    // 무음/빈 청크는 합성 불필요
    if (chunk.kind === 'silence' || !chunk.text || chunk.text.trim().length === 0) {
      const e: SynthEntry = {
        buffer: null,
        speed: this.rate,
        voiceUri: this.voiceURI,
        totalStep: this.totalStep,
        durationSec: 0,
        rateScale: 1.0,
      }
      return Promise.resolve(e)
    }

    // 강조 배율(chunk.rateScale). 없으면 1.0(기본속도).
    const rateScale = chunk.rateScale ?? 1.0
    // 실제 합성 speed = 전역 배속 × 강조 배율
    const effectiveSpeed = this.rate * rateScale

    // 캐시 히트(현재 effectiveSpeed/voice/품질 일치).
    // ⚠️ rateScale 이 달라지면 effectiveSpeed 도 달라지므로 자동으로 캐시 미스.
    const cached = this.synthCache.get(idx)
    if (
      cached &&
      cached.speed === effectiveSpeed &&
      cached.voiceUri === this.voiceURI &&
      cached.totalStep === this.totalStep
    ) {
      return Promise.resolve(cached)
    }
    // 진행 중
    const pend = this.pendingSynth.get(idx)
    if (pend) return pend

    // 새 합성 요청
    // ⚠️ 합성 입력만 spokenText 로 대체(발음 최적화). 표시·점프·북마크용 chunk.text 는 절대 안 바뀐다.
    //    위 무음/빈 가드는 chunk.text 기준이지만, 발음정제는 빈→비어있지 않음을 만들지 않으므로(toSpoken 순수·무음은 '')
    //    "발화할 텍스트가 있는데 합성만 spokenText 로" 라는 의미가 정확히 성립한다.
    const promise = this.requestSynth(idx, chunk.spokenText ?? chunk.text, rateScale)
    this.pendingSynth.set(idx, promise)
    promise
      .then((entry) => {
        // ⚠️ P1: 취소된 합성은 buffer=null 로 resolve 된다(cancelSynthReq).
        // 그걸 캐시에 넣으면 다음에 같은 speed/voice/totalStep 으로 이 청크를 재생할 때
        // 캐시 히트로 합성을 건너뛰어 '영구 무음'이 된다. 이 청크는 speech(비어있지 않음)
        // 가 확실하므로, 실제 buffer 가 있는 결과만 캐시한다(취소/이례적 null 은 캐시 제외).
        if (entry.buffer) this.synthCache.set(idx, entry)
      })
      .catch(() => {
        /* 호출부에서 처리 */
      })
      .finally(() => {
        this.pendingSynth.delete(idx)
      })
    return promise
  }

  /** 워커에 단일 합성 요청 → PCM 수신 → AudioBuffer 생성. */
  private requestSynth(chunkIndex: number, text: string, rateScale = 1.0): Promise<SynthEntry> {
    const worker = this.getWorker()
    const id = ++this.reqSeq
    // 강조 배율을 전역 배속에 곱해 실제 합성 speed 결정.
    const speed = this.rate * rateScale
    const voiceUri = this.voiceURI
    const totalStep = this.totalStep

    const p = new Promise<SynthEntry>((resolve, reject) => {
      this.synthResolvers.set(id, {
        chunkIndex,
        reject,
        resolve: (entry) => resolve(entry),
      })
    })

    const req: WorkerRequest = {
      type: 'synth',
      id,
      text,
      lang: 'ko',
      voiceUri,
      totalStep,
      speed,
    }
    if (isDebug())
      console.info(
        '[MR] synth 요청 chunk=' + chunkIndex + ' id=' + id + ' step=' + totalStep + ' len=' + text.length,
      )
    worker.postMessage(req)

    // 응답에서 PCM → AudioBuffer 변환(요청 시점의 speed/voice/품질/rateScale 메타 고정)
    return p.then((entry) => ({ ...entry, speed, voiceUri, totalStep, rateScale }))
  }

  /** PCM(Float32, sampleRate Hz) → AudioBuffer 변환. */
  private pcmToBuffer(pcm: Float32Array, sampleRate: number): AudioBuffer {
    const ctx = this.getCtx()
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate)
    buffer.getChannelData(0).set(pcm)
    return buffer
  }

  // ── 합성 캐시 관리 ─────────────────────────────────────────
  /** 전체 합성 캐시/진행 무효화(문서 교체·음성 변경 시). */
  private invalidateSynth(): void {
    this.synthCache.clear()
    for (const k of [...this.pendingSynth.keys()]) this.cancelSynthReq(k)
    this.pendingSynth.clear()
  }

  /** idx 를 제외한 진행 중 합성 취소(점프 시). */
  private cancelPendingExcept(keep: number): void {
    for (const k of [...this.pendingSynth.keys()]) {
      if (k !== keep) this.cancelSynthReq(k)
    }
  }

  /** chunkIndex 에 해당하는 진행 중 합성 요청을 워커에 취소 통지 + resolver 정리. */
  private cancelSynthReq(chunkIndex: number): void {
    // 해당 chunkIndex 의 모든 미완 요청 id 취소
    for (const [id, r] of [...this.synthResolvers]) {
      if (r.chunkIndex === chunkIndex) {
        this.worker?.postMessage({ type: 'cancel', id } satisfies WorkerRequest)
        this.synthResolvers.delete(id)
        // reject 하지 않고 조용히 폐기(취소는 정상 흐름) — 빈 엔트리로 resolve
        r.resolve({
          buffer: null,
          speed: this.rate,
          voiceUri: this.voiceURI,
          totalStep: this.totalStep,
          durationSec: 0,
          rateScale: 1.0,
        })
      }
    }
    this.pendingSynth.delete(chunkIndex)
  }

  /** idx 이상에서 합성이 필요한(speech·비어있지 않은) 첫 청크 인덱스. 없으면 -1. */
  private firstSynthIndexFrom(idx: number): number {
    for (let i = Math.max(0, idx); i < this.chunks.length; i++) {
      const c = this.chunks[i]
      if (c.kind !== 'silence' && c.text && c.text.trim().length > 0) return i
    }
    return -1
  }

  // ── 모델 로딩 ──────────────────────────────────────────────
  /** 모델 로딩 보장(1회). 이미 로딩됐으면 즉시 resolve. */
  private ensureModel(): Promise<void> {
    if (this.modelReady) return Promise.resolve()
    if (this.loadingPromise) return this.loadingPromise

    const worker = this.getWorker()
    this.loadingPromise = new Promise<void>((resolve, reject) => {
      this.modelLoadResolve = resolve
      this.modelLoadReject = reject
      const req: WorkerRequest = {
        type: 'load',
        repo: MODEL_REPO,
        revision: MODEL_REVISION,
        forceWasm: this.forceWasm,
      }
      if (isDebug())
        console.info('[MR] 모델 load 요청 전송' + (this.forceWasm ? ' (forceWasm=CPU 복구)' : ''))
      worker.postMessage(req)
    })
    return this.loadingPromise
  }

  private modelLoadResolve: (() => void) | null = null
  private modelLoadReject: ((e: Error) => void) | null = null

  // ── 워커 ───────────────────────────────────────────────────
  /** 워커 싱글턴 생성 + 메시지 핸들러 배선. */
  private getWorker(): Worker {
    if (this.worker) return this.worker
    // Vite 워커 import 규약(?worker 가 아닌 new URL 방식 — ES 워커)
    this.worker = new Worker(new URL('./supertonic.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onWorkerMessage(ev.data)
    this.worker.onerror = (ev) => {
      console.error('[SupertonicEngine] 워커 오류:', ev.message)
      this.modelLoadReject?.(new Error(ev.message))
    }
    return this.worker
  }

  private onWorkerMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'load-progress':
        this.modelProgressCb?.({ phase: msg.phase, label: msg.label, ratio: msg.ratio })
        return
      case 'load-done':
        this.modelReady = true
        this.backend = msg.backend
        this.modelSampleRate = msg.sampleRate
        if (isDebug()) console.info('[MR] load-done backend=' + msg.backend + ' sr=' + msg.sampleRate)
        this.modelLoadResolve?.()
        this.modelLoadResolve = this.modelLoadReject = null
        return
      case 'load-error':
        this.modelLoadReject?.(new Error(msg.message))
        this.modelLoadResolve = this.modelLoadReject = null
        this.loadingPromise = null
        // UI 재시도 버튼 노출용 콜백(retryLoad 로 다시 시도 가능). 배너 라벨이 일반화됐으므로
        // 여기서 '모델 로딩 실패:' 접두를 직접 붙여 맥락을 유지한다(합성 실패 메시지와 구분).
        this.modelErrorCb?.('모델 로딩 실패: ' + msg.message)
        return
      case 'synth-done': {
        const r = this.synthResolvers.get(msg.id)
        if (!r) return // 취소됨
        this.synthResolvers.delete(msg.id)
        if (isDebug()) console.info('[MR] synth-done id=' + msg.id + ' pcm=' + msg.pcm.length + 'smp')
        // 워커가 PCM 을 cfgs.ae.sample_rate(보통 44100)로 생성하므로 그 값으로 버퍼를 만든다.
        // AudioContext 네이티브 레이트(흔히 48000)와 달라도 createBuffer 의 sampleRate 인자로
        // 정확히 지정하면 브라우저가 재생 시 자동 리샘플링한다(피치 정상).
        const buffer = this.pcmToBuffer(msg.pcm, this.modelSampleRate)
        // rateScale 은 requestSynth 의 .then() 체인에서 최종값으로 덮어써지므로 임시 1.0.
        r.resolve({
          buffer,
          speed: this.rate,
          voiceUri: this.voiceURI,
          totalStep: this.totalStep,
          durationSec: msg.durationSec,
          rateScale: 1.0,
        })
        return
      }
      case 'synth-error': {
        const r = this.synthResolvers.get(msg.id)
        if (!r) return
        this.synthResolvers.delete(msg.id)
        if (isDebug()) console.info('[MR] synth-error id=' + msg.id + ' ' + msg.message)
        r.reject(new Error(msg.message))
        return
      }
    }
  }

  // ── AudioContext ───────────────────────────────────────────
  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
    }
    return this.ctx
  }

  /**
   * AudioContext 를 생성하고 suspended 면 resume.
   * play() 진입점(사용자 제스처)에서 호출해 iOS 자동재생 차단을 해제한다.
   * isIOS() 여부와 무관하게 suspended 상태면 resume 을 시도해도 무해하다.
   */
  private ensureCtxResumed(): void {
    // isIOS()는 로깅/의도 명시용. 실제 동작은 모든 플랫폼에서 suspended면 resume(안전).
    void isIOS()
    const ctx = this.getCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
  }

  // ── 이벤트 ─────────────────────────────────────────────────
  on(event: EngineEvent, cb: (p: EnginePosition) => void): void {
    this.listeners[event].add(cb)
  }

  off(event: EngineEvent, cb: (p: EnginePosition) => void): void {
    this.listeners[event].delete(cb)
  }

  private emit(event: EngineEvent): void {
    const snapshot = this._position
    for (const cb of this.listeners[event]) {
      try {
        cb(snapshot)
      } catch (e) {
        console.warn('[SupertonicEngine] 리스너 예외:', e)
      }
    }
  }

  // ── 계측 ───────────────────────────────────────────────────
  private track(type: 'chunk_play_start' | 'chunk_play_end' | 'jump_resolved', chunkIndex: number): void {
    if (!this.docCtx) return
    logEvent(type, { docId: this.docCtx.docId, docHash: this.docCtx.docHash, chunkIndex })
  }

  /**
   * GPU device 오염 자동복구. 합성이 hang(워커 90s 타임아웃)하고 백엔드가 WebGPU 면 device lost 로
   * 판단하고, 워커를 통째로 terminate+재생성한 뒤 WASM(CPU) EP 로만 다시 로드한다(forceWasm).
   *
   * 왜 '새 워커'가 아니라 forceWasm 인가: 페이지 리로드(=새 워커급)로도 복구가 안 됐던 이유는
   * 재로딩이 다시 WebGPU 를 시도해 오염된 device 를 또 잡았기 때문. WASM 은 GPU 를 전혀 쓰지 않아
   * 오염과 무관하게 CPU 로 소리를 낸다(단일스레드라 다소 느림). forceWasm 를 세션 동안 sticky 로 둬
   * WebGPU 재오염을 막는다(완전한 WebGPU 재시도는 페이지 새로고침으로만).
   * ONNX 바이트는 modelCache 가 캐시하므로 워커 재생성에도 재다운로드는 없다(세션 재생성만, 수 초).
   */
  private async recoverWorker(): Promise<void> {
    if (this.recovering) return
    this.recovering = true
    this.consecutiveSynthFails = 0
    if (isDebug()) console.info('[MR] 합성 hang → 워커 재생성(webgpu) 자동복구 시작')
    // 현재 오디오/타이머 정지(stopSource 가 playGen++ 로 진행 중 stale 콜백 무효화) + 합성 캐시·진행 정리
    this.stopSource()
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
    this.invalidateSynth()
    // hang 한 워커/ORT 런타임을 통째로 폐기(terminate → getWorker 가 다음에 새 워커 생성).
    // = 사용자 워크어라운드(음질 기본↔고품질 토글로 엔진 재생성)와 동일한 복구를 자동화.
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        /* 이미 종료 */
      }
      this.worker = null
    }
    // 로딩 상태 리셋 → ensureModel 이 새 워커에 load 전송(forceWasm=false → webgpu 재생성)
    this.modelReady = false
    this.loadingPromise = null
    this.backend = null
    this.modelLoadResolve = this.modelLoadReject = null
    try {
      // ⚠️ 재로딩도 hang 하면 영구 대기(트랩)하지 않도록 타임아웃(30s)을 건다(이전 WASM 트랩 사고 교훈).
      await Promise.race([
        this.ensureModel(), // forceWasm=false → 새 webgpu 워커로 재생성
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('복구 로딩 시간 초과')), 30000),
        ),
      ])
      if (isDebug()) console.info('[MR] 자동복구 완료 backend=' + this.backend)
      // 재생 중이었다면 현재 청크부터 이어서 재생(위치/하이라이트 유지).
      if (this.playing && !this.paused) this.playCurrent()
    } catch (e) {
      if (isDebug()) console.warn('[MR] 자동복구 실패', e)
      this.modelErrorCb?.(
        '재생을 복구하지 못했습니다. 새로고침하거나 음질(기본↔고품질)을 한 번 바꿔 보세요.',
      )
    } finally {
      this.recovering = false
    }
  }

  /** 엔진 폐기(워커 종료·컨텍스트 닫기). 통합 단계에서 엔진 교체 시 호출. */
  dispose(): void {
    this.stopInternal(false)
    this.invalidateSynth()
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
    }
    this.modelReady = false
    this.loadingPromise = null
  }
}
