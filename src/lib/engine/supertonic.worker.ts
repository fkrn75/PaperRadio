/**
 * Supertonic 합성 워커
 *
 * denoising 루프(vector_estimator × totalStep)가 무겁기 때문에 합성은 메인 스레드가 아닌
 * 이 Web Worker 에서 수행한다. 메인 UI 가 끊기지 않는다.
 *
 * 포팅 출처(전체 SSOT): supertonic/web/helper.js (call/_infer/sampleNoisyLatent/UnicodeProcessor),
 *   supertonic/web/main.js (initializeModels = WebGPU→WASM 폴백 세션 생성).
 * 텐서 입출력 이름/shape 은 helper.js 와 1:1로 맞춘다(모델 계약).
 *
 * 실행 제공자: WebGPU 우선 시도 → 실패 시 WASM 폴백(main.js 와 동일).
 * onnxruntime-web/webgpu 서브패스(JSEP 빌드)를 import 해야 브라우저+WebGPU 가 동작한다.
 */

import type * as ort from 'onnxruntime-web'
import { fetchWithCache, type ProgressFn } from './modelCache'
import {
  MODEL_FILES,
  MODEL_REPO,
  MODEL_REVISION,
  MODEL_TOTAL_BYTES,
  VOICE_CATALOG,
  cacheKey,
  hfUrl,
  INTER_SEGMENT_SILENCE_SEC,
  type WorkerRequest,
  type WorkerResponse,
} from './supertonicProtocol'

// onnxruntime-web 런타임을 동적 로드(webgpu 빌드). 번들이 분리되어 필요 시 로드된다.
// 사용자 피드백: 모바일에서도 WebGPU 가 잘 동작한다 → 모바일/데스크탑 공통으로 WebGPU 를 우선 시도.
// (이전 모바일 빈버퍼가 교차출처 격리(COOP/COEP) 부재 때문이었는지 격리 헤더 적용 후 재검증)
let ortRT: typeof ort
async function ensureOrt(): Promise<void> {
  if (ortRT) return
  ortRT = (await import('onnxruntime-web/webgpu')) as unknown as typeof ort
  ortRT.env.wasm.numThreads = 1 // asyncify 빌드라 멀티 불가. WebGPU 는 GPU 라 스레드 무관.
  ortRT.env.wasm.simd = true
}

// ─────────────────────────────────────────────────────────────
// 워커 송신 헬퍼(타입 안전)
// ─────────────────────────────────────────────────────────────
function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  // @ts-expect-error 워커 전역 postMessage(2번째 인자 transfer list)
  ;(self as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? [])
}

// ─────────────────────────────────────────────────────────────
// tts.json 설정 타입(필요한 필드만)
// ─────────────────────────────────────────────────────────────
interface TtsCfgs {
  ae: { sample_rate: number; base_chunk_size: number }
  ttl: { chunk_compress_factor: number; latent_dim: number }
}

// ─────────────────────────────────────────────────────────────
// UnicodeProcessor — helper.js 포팅(텍스트 → textIds/textMask)
// ─────────────────────────────────────────────────────────────
const AVAILABLE_LANGS = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr',
  'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk',
  'vi', 'na',
]

class UnicodeProcessor {
  constructor(private indexer: number[]) {}

  call(textList: string[], langList: string[]): { textIds: number[][]; textMask: number[][][] } {
    const processed = textList.map((t, i) => this.preprocess(t, langList[i]))
    const lens = processed.map((t) => t.length)
    const maxLen = Math.max(...lens)

    const textIds = processed.map((text) => {
      const row = new Array<number>(maxLen).fill(0)
      for (let j = 0; j < text.length; j++) {
        const cp = text.codePointAt(j) ?? 0
        row[j] = cp < this.indexer.length ? this.indexer[cp] : -1
      }
      return row
    })

    const textMask = this.lengthToMask(lens, maxLen)
    return { textIds, textMask }
  }

  private preprocess(text: string, lang: string): string {
    // NFKD 정규화(helper.js 동일)
    text = text.normalize('NFKD')

    // 이모지 제거(광범위 유니코드)
    const emoji =
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu
    text = text.replace(emoji, '')

    // 대시/기호 치환
    const repl: Record<string, string> = {
      '–': '-', '‑': '-', '—': '-', _: ' ',
      '“': '"', '”': '"', '‘': "'", '’': "'",
      '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
      '→': ' ', '←': ' ',
    }
    for (const [k, v] of Object.entries(repl)) text = text.replaceAll(k, v)

    // 특수기호 제거
    text = text.replace(/[♥☆♡©\\]/g, '')

    // 알려진 표현 치환
    const expr: Record<string, string> = {
      '@': ' at ',
      'e.g.,': 'for example, ',
      'i.e.,': 'that is, ',
    }
    for (const [k, v] of Object.entries(expr)) text = text.replaceAll(k, v)

    // 구두점 앞 공백 정리
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!')
      .replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'")

    // 중복 따옴표 제거
    while (text.includes('""')) text = text.replace('""', '"')
    while (text.includes("''")) text = text.replace("''", "'")
    while (text.includes('``')) text = text.replace('``', '`')

    // 공백 정리
    text = text.replace(/\s+/g, ' ').trim()

    // 끝이 구두점/따옴표/닫는 괄호가 아니면 마침표 추가
    if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.'

    if (!AVAILABLE_LANGS.includes(lang)) {
      throw new Error(`지원하지 않는 언어: ${lang}`)
    }

    // 언어 태그로 감싼다(<ko>...</ko>)
    return `<${lang}>${text}</${lang}>`
  }

  lengthToMask(lengths: number[], maxLen: number): number[][][] {
    return lengths.map((len) => {
      const row = new Array<number>(maxLen).fill(0)
      for (let j = 0; j < Math.min(len, maxLen); j++) row[j] = 1
      return [row]
    })
  }
}

// ─────────────────────────────────────────────────────────────
// 음성 스타일(Style) — helper.loadVoiceStyle 포팅(단일 화자)
// ─────────────────────────────────────────────────────────────
interface StyleTensors {
  ttl: ort.Tensor
  dp: ort.Tensor
}

interface VoiceStyleJSON {
  style_ttl: { dims: number[]; data: unknown }
  style_dp: { dims: number[]; data: unknown }
}

/** 중첩 배열을 평탄화(JSON 의 data 가 다차원 배열). */
function flattenDeep(arr: unknown): number[] {
  const out: number[] = []
  const stack: unknown[] = [arr]
  // 깊이 우선이 아니라 순서 보존이 중요 → 재귀로 처리
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const e of x) walk(e)
    } else {
      out.push(x as number)
    }
  }
  // stack 변수는 사용 안 함(가독성용 walk 사용)
  void stack
  walk(arr)
  return out
}

function buildStyle(json: VoiceStyleJSON): StyleTensors {
  const ttlDims = json.style_ttl.dims // [1, d1, d2]
  const dpDims = json.style_dp.dims
  const ttlData = Float32Array.from(flattenDeep(json.style_ttl.data))
  const dpData = Float32Array.from(flattenDeep(json.style_dp.data))
  const ttl = new ortRT.Tensor('float32', ttlData, ttlDims as number[])
  const dp = new ortRT.Tensor('float32', dpData, dpDims as number[])
  return { ttl, dp }
}

// ─────────────────────────────────────────────────────────────
// 한국어/일본어 maxLen 120 재분할 — helper.chunkText 포팅
// ─────────────────────────────────────────────────────────────
function chunkText(text: string, maxLen: number): string[] {
  if (typeof text !== 'string') throw new Error('chunkText: 문자열 필요')

  // 문단(빈 줄) 단위 분리
  const paragraphs = text.trim().split(/\n\s*\n+/).filter((p) => p.trim())
  const chunks: string[] = []

  for (let para of paragraphs) {
    para = para.trim()
    if (!para) continue

    // 문장 경계(. ! ?)로 분리. 약어/단일 대문자 예외(helper.js 동일)
    const sentences = para.split(
      /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/,
    )

    let cur = ''
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) {
        cur += (cur ? ' ' : '') + s
      } else {
        if (cur) chunks.push(cur.trim())
        cur = s
      }
    }
    if (cur) chunks.push(cur.trim())
  }

  // 한 문장이 maxLen 을 넘으면 그대로(모델이 처리). 빈 결과면 원문 1개.
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim())
  return chunks
}

// ─────────────────────────────────────────────────────────────
// 합성 엔진 상태(워커 내 싱글턴)
// ─────────────────────────────────────────────────────────────
let cfgs: TtsCfgs | null = null
let processor: UnicodeProcessor | null = null
let dpOrt: ort.InferenceSession | null = null
let textEncOrt: ort.InferenceSession | null = null
let vectorEstOrt: ort.InferenceSession | null = null
let vocoderOrt: ort.InferenceSession | null = null
let sampleRate = 44100

/** 음성 스타일 캐시(uri → Style). 최초 1회 JSON fetch 후 텐서 생성. */
const styleCache = new Map<string, StyleTensors>()

/** 취소된 합성 id 집합(점프/정지 시 추가 → 결과 폐기). */
const cancelled = new Set<number>()

/**
 * 합성 직렬화 체인. 합성 요청을 '한 번에 하나씩' 처리해 두 개 이상의 ortRT.run() 이 동시에
 * GPU 추론을 돌리는 것을 막는다 — 동시 추론은 모바일 GPU hang(무음)의 주원인이다(빠른 seek·
 * 이어듣기 재오픈 등에서 '취소됐지만 아직 run() 중인 합성'과 '새 합성'이 GPU 에서 겹침).
 * 각 synth 요청은 이 체인 뒤에 이어 붙어 순차 실행된다.
 */
let synthChain: Promise<void> = Promise.resolve()

let activeRepo = MODEL_REPO
let activeRevision = MODEL_REVISION

// ─────────────────────────────────────────────────────────────
// 모델 로딩 — main.js initializeModels + helper.loadTextToSpeech 포팅
// ─────────────────────────────────────────────────────────────
async function loadModels(
  repo: string,
  revision: string,
  forceWasm = false,
): Promise<'webgpu' | 'wasm'> {
  activeRepo = repo
  activeRevision = revision

  // 다운로드 진행률: 파일별 바이트를 전체(MODEL_TOTAL_BYTES) 대비 누적
  let downloadedBytes = 0
  const downloadOne = async (path: string): Promise<ArrayBuffer> => {
    const url = hfUrl(repo, revision, path)
    const key = cacheKey(repo, revision, path)
    let lastLoaded = 0
    const onProgress: ProgressFn = ({ loaded }) => {
      downloadedBytes += loaded - lastLoaded
      lastLoaded = loaded
      const file = MODEL_FILES.find((f) => f.path === path)
      post({
        type: 'load-progress',
        phase: 'download',
        label: file?.label ?? path,
        ratio: Math.min(1, downloadedBytes / MODEL_TOTAL_BYTES),
      })
    }
    return fetchWithCache(url, key, onProgress)
  }

  // 1) 설정 + 인덱서(JSON)
  const cfgBuf = await downloadOne('onnx/tts.json')
  cfgs = JSON.parse(new TextDecoder().decode(cfgBuf)) as TtsCfgs
  sampleRate = cfgs.ae.sample_rate

  const idxBuf = await downloadOne('onnx/unicode_indexer.json')
  const indexer = JSON.parse(new TextDecoder().decode(idxBuf)) as number[]
  processor = new UnicodeProcessor(indexer)

  // 2) ONNX 4개 바이트 다운로드(세션은 EP 결정 후 생성)
  const dpBuf = await downloadOne('onnx/duration_predictor.onnx')
  const teBuf = await downloadOne('onnx/text_encoder.onnx')
  const veBuf = await downloadOne('onnx/vector_estimator.onnx')
  const voBuf = await downloadOne('onnx/vocoder.onnx')

  // 3) 세션 생성: WebGPU 우선 → 실패 시 WASM(main.js 폴백)
  const createSessions = async (
    providers: ('webgpu' | 'wasm')[],
  ): Promise<void> => {
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    }
    // 경로 대신 바이트(Uint8Array)로 생성(블루프린트 지정)
    post({ type: 'load-progress', phase: 'session', label: '길이 예측기 세션', ratio: 0.25 })
    dpOrt = await ortRT.InferenceSession.create(new Uint8Array(dpBuf), opts)
    post({ type: 'load-progress', phase: 'session', label: '텍스트 인코더 세션', ratio: 0.5 })
    textEncOrt = await ortRT.InferenceSession.create(new Uint8Array(teBuf), opts)
    post({ type: 'load-progress', phase: 'session', label: '벡터 추정기 세션', ratio: 0.75 })
    vectorEstOrt = await ortRT.InferenceSession.create(new Uint8Array(veBuf), opts)
    post({ type: 'load-progress', phase: 'session', label: '보코더 세션', ratio: 1 })
    vocoderOrt = await ortRT.InferenceSession.create(new Uint8Array(voBuf), opts)
  }

  // forceWasm: 오염된 GPU device 우회 복구 — WebGPU 시도 없이 곧장 CPU(WASM) 로 로드한다.
  // (device lost 상태에서 webgpu 세션을 또 만들면 재오염/hang 하므로 그 경로를 아예 끊는다)
  if (forceWasm) {
    await createSessions(['wasm'])
    return 'wasm'
  }

  try {
    await createSessions(['webgpu', 'wasm']) // webgpu 우선, ort 가 내부 폴백도 허용
    return 'webgpu'
  } catch (e) {
    console.warn('[supertonic.worker] WebGPU 세션 생성 실패, WASM 폴백:', e)
    // 부분 생성된 세션 폐기 후 재시도
    dpOrt = textEncOrt = vectorEstOrt = vocoderOrt = null
    await createSessions(['wasm'])
    return 'wasm'
  }
}

// ─────────────────────────────────────────────────────────────
// 음성 스타일 로딩(캐시)
// ─────────────────────────────────────────────────────────────
async function getStyle(voiceUri: string): Promise<StyleTensors> {
  const cached = styleCache.get(voiceUri)
  if (cached) return cached

  const voice = VOICE_CATALOG.find((v) => v.uri === voiceUri) ?? VOICE_CATALOG[0]
  const url = hfUrl(activeRepo, activeRevision, voice.path)
  const key = cacheKey(activeRepo, activeRevision, voice.path)
  const buf = await fetchWithCache(url, key)
  const json = JSON.parse(new TextDecoder().decode(buf)) as VoiceStyleJSON
  const style = buildStyle(json)
  styleCache.set(voiceUri, style)
  return style
}

// ─────────────────────────────────────────────────────────────
// 노이즈 잠재(noisy latent) 샘플링 — helper.sampleNoisyLatent 포팅
// ─────────────────────────────────────────────────────────────
function sampleNoisyLatent(
  duration: number[],
  baseChunkSize: number,
  chunkCompress: number,
  latentDim: number,
): { xt: number[][][]; latentMask: number[][][] } {
  const bsz = duration.length
  const maxDur = Math.max(...duration)
  const wavLenMax = Math.floor(maxDur * sampleRate)
  const wavLengths = duration.map((d) => Math.floor(d * sampleRate))

  const chunkSize = baseChunkSize * chunkCompress
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize)
  const latentDimVal = latentDim * chunkCompress

  const xt: number[][][] = []
  for (let b = 0; b < bsz; b++) {
    const batch: number[][] = []
    for (let d = 0; d < latentDimVal; d++) {
      const row: number[] = []
      for (let t = 0; t < latentLen; t++) {
        // Box-Muller 변환(표준정규)
        const u1 = Math.max(0.0001, Math.random())
        const u2 = Math.random()
        row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2))
      }
      batch.push(row)
    }
    xt.push(batch)
  }

  const latentLengths = wavLengths.map((len) => Math.floor((len + chunkSize - 1) / chunkSize))
  const latentMask = lengthToMask(latentLengths, latentLen)

  // 마스크 적용
  for (let b = 0; b < bsz; b++) {
    for (let d = 0; d < latentDimVal; d++) {
      for (let t = 0; t < latentLen; t++) {
        xt[b][d][t] *= latentMask[b][0][t]
      }
    }
  }

  return { xt, latentMask }
}

function lengthToMask(lengths: number[], maxLen: number): number[][][] {
  return lengths.map((len) => {
    const row = new Array<number>(maxLen).fill(0)
    for (let j = 0; j < Math.min(len, maxLen); j++) row[j] = 1
    return [row]
  })
}

// ─────────────────────────────────────────────────────────────
// 단일 세그먼트 추론 — helper._infer 포팅
// ─────────────────────────────────────────────────────────────
async function infer(
  textList: string[],
  langList: string[],
  style: StyleTensors,
  totalStep: number,
  speed: number,
): Promise<{ wav: number[]; duration: number[] }> {
  if (!cfgs || !processor || !dpOrt || !textEncOrt || !vectorEstOrt || !vocoderOrt) {
    throw new Error('모델이 로드되지 않았습니다')
  }
  const bsz = textList.length

  // 텍스트 처리
  const { textIds, textMask } = processor.call(textList, langList)

  const textIdsFlat = BigInt64Array.from(textIds.flat().map((x) => BigInt(x)))
  const textIdsTensor = new ortRT.Tensor('int64', textIdsFlat, [bsz, textIds[0].length])

  const textMaskFlat = Float32Array.from(textMask.flat(2))
  const textMaskTensor = new ortRT.Tensor('float32', textMaskFlat, [bsz, 1, textMask[0][0].length])

  // 길이 예측
  const dpOut = await dpOrt.run({
    text_ids: textIdsTensor,
    style_dp: style.dp,
    text_mask: textMaskTensor,
  })
  const duration = Array.from(dpOut.duration.data as Float32Array | Float64Array, Number)

  // speed 적용(피치 보존: duration 을 speed 로 나눔)
  for (let i = 0; i < duration.length; i++) duration[i] /= speed

  // 텍스트 인코딩
  const teOut = await textEncOrt.run({
    text_ids: textIdsTensor,
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  })
  const textEmb = teOut.text_emb

  // 노이즈 잠재 샘플링
  let { xt, latentMask } = sampleNoisyLatent(
    duration,
    cfgs.ae.base_chunk_size,
    cfgs.ttl.chunk_compress_factor,
    cfgs.ttl.latent_dim,
  )

  const latentMaskFlat = Float32Array.from(latentMask.flat(2))
  const latentMaskTensor = new ortRT.Tensor('float32', latentMaskFlat, [bsz, 1, latentMask[0][0].length])

  const totalStepTensor = new ortRT.Tensor('float32', new Float32Array(bsz).fill(totalStep), [bsz])

  // denoising 루프(vector_estimator × totalStep)
  for (let step = 0; step < totalStep; step++) {
    const curStepTensor = new ortRT.Tensor('float32', new Float32Array(bsz).fill(step), [bsz])

    const xtFlat = Float32Array.from(xt.flat(2))
    const xtTensor = new ortRT.Tensor('float32', xtFlat, [bsz, xt[0].length, xt[0][0].length])

    const veOut = await vectorEstOrt.run({
      noisy_latent: xtTensor,
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latentMaskTensor,
      text_mask: textMaskTensor,
      current_step: curStepTensor,
      total_step: totalStepTensor,
    })

    const denoised = Array.from(veOut.denoised_latent.data as Float32Array, Number)

    // 3D 재구성
    const latentDimLen = xt[0].length
    const latentLen = xt[0][0].length
    xt = []
    let idx = 0
    for (let b = 0; b < bsz; b++) {
      const batch: number[][] = []
      for (let d = 0; d < latentDimLen; d++) {
        const row: number[] = []
        for (let t = 0; t < latentLen; t++) row.push(denoised[idx++])
        batch.push(row)
      }
      xt.push(batch)
    }
  }

  // 파형 생성(보코더)
  const finalXtFlat = Float32Array.from(xt.flat(2))
  const finalXtTensor = new ortRT.Tensor('float32', finalXtFlat, [bsz, xt[0].length, xt[0][0].length])

  const voOut = await vocoderOrt.run({ latent: finalXtTensor })
  const wav = Array.from(voOut.wav_tts.data as Float32Array, Number)

  return { wav, duration }
}

// ─────────────────────────────────────────────────────────────
// 텍스트 전체 합성 — helper.call 포팅(ko maxLen 120 자동 재분할 포함)
// ─────────────────────────────────────────────────────────────
async function synth(
  text: string,
  lang: string,
  voiceUri: string,
  totalStep: number,
  speed: number,
): Promise<{ pcm: Float32Array; durationSec: number }> {
  const style = await getStyle(voiceUri)
  if (style.ttl.dims[0] !== 1) {
    throw new Error('단일 화자 합성만 지원합니다')
  }

  // 한국어/일본어는 maxLen 120 으로 자동 재분할(원본 call() 규약)
  const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300
  const textList = chunkText(text, maxLen)
  const langList = new Array(textList.length).fill(lang)

  let wavCat: number[] = []
  let durCat = 0

  for (let i = 0; i < textList.length; i++) {
    const { wav, duration } = await infer([textList[i]], [langList[i]], style, totalStep, speed)
    // duration[0] 까지만 유효 길이로 잘라 이어붙임(원본 main.js 의 slice 와 동일 취지).
    // ⚠️ floor 내림 + duration_predictor 의 과소예측이 겹치면 실제 음성의 꼬리가 잘린다.
    //    긴 문장이 다중 세그먼트로 쪼개지면 '문장 중간'이 잘려 음절이 빠진 듯 들림.
    //    작은 tail 패딩 + ceil 로 과소트림을 막는다(여분은 보코더 무음이라 무해).
    const TAIL_PAD_SEC = 0.05
    const validLen = Math.min(wav.length, Math.ceil(sampleRate * (duration[0] + TAIL_PAD_SEC)))
    const seg = wav.slice(0, validLen)

    if (wavCat.length === 0) {
      wavCat = seg
      durCat = duration[0]
    } else {
      const silenceLen = Math.floor(INTER_SEGMENT_SILENCE_SEC * sampleRate)
      wavCat = wavCat.concat(new Array(silenceLen).fill(0), seg)
      durCat += duration[0] + INTER_SEGMENT_SILENCE_SEC
    }
  }

  return { pcm: Float32Array.from(wavCat), durationSec: durCat }
}

// ─────────────────────────────────────────────────────────────
// 합성 hang 가드 — 넉넉한 타임아웃(동시 재시도 없음)
// ─────────────────────────────────────────────────────────────
/**
 * device lost 등으로 ort.run() 이 영영 안 끝나면 synth() 가 영구 pending → 엔진 resolver 가
 * 영구 대기(무음+멈춤)한다. 이를 막기 위해 '넉넉한' 타임아웃으로 끊어 synth-error 로 전환한다
 * (엔진이 연속 실패를 표면화 → 사용자 '다시 시도'=워커 재생성=새 GPU device).
 *
 * ⚠️ 모바일 고품질(12스텝)은 한 청크 합성이 수십 초 걸릴 수 있다. 타임아웃을 짧게 잡으면
 *    '느리지만 되던' 합성을 끊어 오히려 전부 무음이 된다(실측 회귀). 그래서 '진짜 hang' 만
 *    걸리도록 넉넉히(90s) 잡고, 저스텝 동시 재시도는 하지 않는다 — 죽지 않은 원본 추론과 GPU 를
 *    다퉈 둘 다 실패시킬 수 있어 모바일에서 역효과이기 때문이다.
 */
const SYNTH_HANG_TIMEOUT_MS = 90000
function synthWithGuard(
  text: string,
  lang: string,
  voiceUri: string,
  totalStep: number,
  speed: number,
): Promise<{ pcm: Float32Array; durationSec: number }> {
  return Promise.race([
    synth(text, lang, voiceUri, totalStep, speed),
    new Promise<{ pcm: Float32Array; durationSec: number }>((_, reject) =>
      setTimeout(() => reject(new Error('합성 시간 초과(응답 없음)')), SYNTH_HANG_TIMEOUT_MS),
    ),
  ])
}

// ─────────────────────────────────────────────────────────────
// 메시지 핸들러
// ─────────────────────────────────────────────────────────────
self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data

  if (msg.type === 'cancel') {
    cancelled.add(msg.id)
    return
  }

  if (msg.type === 'load') {
    try {
      await ensureOrt()
      const backend = await loadModels(
        msg.repo ?? MODEL_REPO,
        msg.revision ?? MODEL_REVISION,
        msg.forceWasm ?? false,
      )
      post({ type: 'load-done', sampleRate, backend })
    } catch (e) {
      post({ type: 'load-error', message: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  if (msg.type === 'synth') {
    const { id, text, lang, voiceUri, totalStep, speed } = msg
    // ⚠️ 합성 직렬화: 이전 합성이 끝난 뒤에 시작한다. onmessage 는 async 라 여러 synth 가 await 중
    //    인터리브되는데, 그러면 두 개 이상의 ortRT.run() 이 GPU 에서 '동시에' 돌아 모바일 GPU 가
    //    hang(무음) 한다(빠른 seek·이어듣기 재오픈에서 취소된 합성의 run() 이 새 합성과 겹치는 게 주범).
    //    한 번에 하나씩만 돌리면 그 동시성이 사라진다.
    synthChain = synthChain
      .then(async () => {
        // 시작 전에 이미 취소(점프/정지)됐으면 합성 자체를 건너뛴다 — 불필요한 GPU 작업·지연 제거.
        if (cancelled.has(id)) {
          cancelled.delete(id)
          return
        }
        try {
          await ensureOrt()
          const { pcm, durationSec } = await synthWithGuard(text, lang, voiceUri, totalStep, speed)
          // 합성 도중 취소되었으면 결과 폐기
          if (cancelled.has(id)) {
            cancelled.delete(id)
            return
          }
          // PCM 버퍼는 transferable 로 넘겨 복사 비용 제거
          post({ type: 'synth-done', id, pcm, durationSec }, [pcm.buffer])
        } catch (e) {
          if (cancelled.has(id)) {
            cancelled.delete(id)
            return
          }
          post({ type: 'synth-error', id, message: e instanceof Error ? e.message : String(e) })
        }
      })
      .catch(() => {
        /* 체인이 예외로 끊기지 않게(다음 합성이 계속 직렬화되도록) */
      })
    return
  }
}
