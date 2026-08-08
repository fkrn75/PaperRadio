/**
 * Supertonic 엔진 ↔ 워커 공유 계약(SSOT)
 *
 * - 모델 파일 매니페스트(HF 경로)
 * - 음성(voice style) 카탈로그(M1~M5 남성 / F1~F5 여성)
 * - 워커 메시지 타입(main ↔ worker)
 *
 * 엔진(supertonicEngine.ts)과 워커(supertonic.worker.ts) 양쪽에서 import 한다.
 * 원본 파이프라인 출처: supertonic/web/helper.js, main.js (정독 후 포팅).
 */

import type { TtsQuality } from '../types'

// ─────────────────────────────────────────────────────────────
// 모델 저장소 / 파일 매니페스트
// ─────────────────────────────────────────────────────────────
/**
 * 1순위 모델 저장소. `Supertone/supertonic-3` — 31개 언어 지원, **한국어 합성 가능**(1차증거 확정).
 * onnx/ 4개 합계 약 380MB. 음성 스타일 M1~M5/F1~F5 + unicode_indexer + tts.json 모두 존재.
 *
 * ⚠️ 한국어 검증 핵심(왜 base/supertonic 이 아닌가):
 *   helper.js 의 preprocessText 는 텍스트를 **NFKD 정규화**한다 → 완성형 한글 음절('한', U+D55C)이
 *   조합형 자모(초성/중성/종성, U+1100~U+11FF)로 분해된다. 따라서 unicode_indexer 는 음절 영역이
 *   아니라 **조합자모 영역에 인덱스를 가져야** 한글이 토큰화된다.
 *   - base `Supertone/supertonic`: split="opensource-en"(영어 전용). NFKD 분해 후 "한국어" 8자모 전부
 *     indexer 값 -1 = 미등록 → **한국어 합성 불가**(처음 채택했다가 진단으로 폐기).
 *   - v2 `Supertone/supertonic-2`: split="opensource-multilingual". 자모 전부 유효 → 한국어 가능(폴백).
 *   - v3 `Supertone/supertonic-3`: split="opensource-multilingual". 자모 전부 유효 + 사용자가 공식 데모에서
 *     한국어 직접 청취(교차검증). tts.json 핵심설정(sample_rate 44100·base_chunk_size 512·latent_dim 24·
 *     chunk_compress_factor 6)이 v2 와 동일 → helper.js 파이프라인 무수정 호환.
 *
 * 폴백 후보(v3 문제 시): MODEL_REPO 를 'Supertone/supertonic-2' 로, MODEL_FILES/VOICE 크기를 v2 값으로
 *   바꾸면 된다(경로는 동일). v2 onnx 합계 약 251MB.
 */
export const MODEL_REPO = 'Supertone/supertonic-3'
export const MODEL_REVISION = 'main'

/** HF resolve URL 생성기. */
export function hfUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${path}`
}

/** 캐시 키 생성기(repo@rev/path). modelCache 키 규약과 일치. */
export function cacheKey(repo: string, revision: string, path: string): string {
  return `${repo}@${revision}/${path}`
}

/** 모델 파일 종류. */
export type ModelFileKind = 'onnx' | 'json'

export interface ModelFile {
  /** 저장소 내 상대 경로(helper.js/main.js 로딩 코드와 동일) */
  path: string
  kind: ModelFileKind
  /** UI 표시용 라벨 */
  label: string
  /** 대략적 바이트(진행률 가중치용, HF 트리 확인값) */
  approxBytes: number
}

/**
 * 합성에 필요한 모델 파일 목록(설정 JSON + 4개 ONNX 세션).
 * 순서 = 다운로드/로딩 순서. helper.loadTextToSpeech 의 로딩 순서를 따른다.
 */
// approxBytes = Supertone/supertonic-3 의 HF 트리 실측값(2026-06-21). 진행률 분모로만 쓰임.
export const MODEL_FILES: ModelFile[] = [
  { path: 'onnx/tts.json', kind: 'json', label: '설정(tts.json)', approxBytes: 8253 },
  { path: 'onnx/unicode_indexer.json', kind: 'json', label: '유니코드 인덱서', approxBytes: 277676 },
  { path: 'onnx/duration_predictor.onnx', kind: 'onnx', label: '길이 예측기', approxBytes: 3700147 },
  { path: 'onnx/text_encoder.onnx', kind: 'onnx', label: '텍스트 인코더', approxBytes: 36416150 },
  { path: 'onnx/vector_estimator.onnx', kind: 'onnx', label: '벡터 추정기', approxBytes: 256534781 },
  { path: 'onnx/vocoder.onnx', kind: 'onnx', label: '보코더', approxBytes: 101424195 },
]

/** 모델 다운로드 총 바이트(진행률 분모). */
export const MODEL_TOTAL_BYTES = MODEL_FILES.reduce((s, f) => s + f.approxBytes, 0)

// ─────────────────────────────────────────────────────────────
// 음성 스타일 카탈로그 (voice style)
// ─────────────────────────────────────────────────────────────
/**
 * voice_styles/*.json 한 개당 ~292KB(v3 기준). URI 는 RadioEngine.setVoice(uri) 의 식별자로 쓴다.
 * URI 규약: `supertonic:M1` 형태(파일명과 1:1). 기본은 남성 M1(블루프린트 지정).
 */
export interface SupertonicVoice {
  /** RadioEngine setVoice/currentVoiceURI 용 식별자 */
  uri: string
  /** voice_styles 내 파일 경로 */
  path: string
  /** UI 표시 이름 */
  name: string
  gender: 'male' | 'female'
}

export const VOICE_CATALOG: SupertonicVoice[] = [
  { uri: 'supertonic:M1', path: 'voice_styles/M1.json', name: '남성 1 (M1)', gender: 'male' },
  { uri: 'supertonic:M2', path: 'voice_styles/M2.json', name: '남성 2 (M2)', gender: 'male' },
  { uri: 'supertonic:M3', path: 'voice_styles/M3.json', name: '남성 3 (M3)', gender: 'male' },
  { uri: 'supertonic:M4', path: 'voice_styles/M4.json', name: '남성 4 (M4)', gender: 'male' },
  { uri: 'supertonic:M5', path: 'voice_styles/M5.json', name: '남성 5 (M5)', gender: 'male' },
  { uri: 'supertonic:F1', path: 'voice_styles/F1.json', name: '여성 1 (F1)', gender: 'female' },
  { uri: 'supertonic:F2', path: 'voice_styles/F2.json', name: '여성 2 (F2)', gender: 'female' },
  { uri: 'supertonic:F3', path: 'voice_styles/F3.json', name: '여성 3 (F3)', gender: 'female' },
  { uri: 'supertonic:F4', path: 'voice_styles/F4.json', name: '여성 4 (F4)', gender: 'female' },
  { uri: 'supertonic:F5', path: 'voice_styles/F5.json', name: '여성 5 (F5)', gender: 'female' },
]

/** 기본 음성(남성 M1). */
export const DEFAULT_VOICE_URI = 'supertonic:M1'

/** URI → voice 메타 조회(없으면 기본 M1). */
export function resolveVoice(uri: string | null | undefined): SupertonicVoice {
  if (uri) {
    const found = VOICE_CATALOG.find((v) => v.uri === uri)
    if (found) return found
  }
  return VOICE_CATALOG.find((v) => v.uri === DEFAULT_VOICE_URI) ?? VOICE_CATALOG[0]
}

// ─────────────────────────────────────────────────────────────
// 합성 파라미터 기본값
// ─────────────────────────────────────────────────────────────
/**
 * TTS 품질 프리셋 → denoising totalStep 매핑.
 * denoising 반복 횟수는 품질↔속도 트레이드오프(클수록 음질↑·합성 느림).
 * 원본 데모 기본값은 가변(보통 8~16). 흘려듣기 용도라 standard(8)를 기본으로 둔다.
 *
 * ⚠️ 키는 types.ts 의 `TtsQuality`('fast'|'standard'|'high')와 1:1 일치한다.
 *    Record<TtsQuality, number> 로 선언해 키 누락/오타를 컴파일 타임에 강제한다.
 */
export const QUALITY_STEPS: Record<TtsQuality, number> = { fast: 5, standard: 8, high: 12 }

/** 기본 품질 프리셋. */
export const DEFAULT_QUALITY_PRESET: TtsQuality = 'standard'

/**
 * denoising 반복 횟수 기본값. = QUALITY_STEPS[DEFAULT_QUALITY_PRESET] = 8.
 * (기존 코드가 DEFAULT_TOTAL_STEP 를 참조하므로 심볼은 유지 — 하위호환)
 * 타입은 number(특정 리터럴로 좁혀지면 setTotalStep 등 가변 대입이 막힘).
 */
export const DEFAULT_TOTAL_STEP: number = QUALITY_STEPS[DEFAULT_QUALITY_PRESET]

/** 품질 프리셋 → totalStep 조회(미지정/미지원 시 기본값). */
export function qualityToStep(quality: string | null | undefined): number {
  if (quality && quality in QUALITY_STEPS) {
    return QUALITY_STEPS[quality as TtsQuality]
  }
  return DEFAULT_TOTAL_STEP
}

/** 기본 speed(피치 보존). helper.call 기본 1.05. 우리 setRate 가 이 값을 덮어쓴다. */
export const DEFAULT_SPEED = 1.0

/** 합성 청크 사이 무음(초). 원본 call() 기본 0.3. 우리는 어댑터에서 청크별로 합성하므로 0. */
export const INTER_SEGMENT_SILENCE_SEC = 0.3

// ─────────────────────────────────────────────────────────────
// 워커 메시지 프로토콜 (main ↔ worker)
// ─────────────────────────────────────────────────────────────

/** main → worker */
export type WorkerRequest =
  | {
      type: 'load'
      /** 모델 저장소(미지정 시 기본 MODEL_REPO) */
      repo?: string
      revision?: string
      /**
       * true 면 WebGPU 시도를 건너뛰고 WASM(CPU) EP 로만 로드한다.
       * GPU device 오염(12스텝 등으로 device lost) 자동복구 시, 워커를 재생성하면서 이 플래그로
       * WebGPU 재시도(재오염)를 막고 CPU 경로로 확실히 소리를 낸다(단일스레드라 다소 느림).
       */
      forceWasm?: boolean
    }
  | {
      type: 'synth'
      /** 요청 식별자(응답 매칭용) */
      id: number
      text: string
      lang: string // 'ko'
      /** 음성 URI(supertonic:M1 등) */
      voiceUri: string
      totalStep: number
      /** 재생 배속(피치 보존). helper _infer 의 speed 인자로 전달 */
      speed: number
    }
  | {
      /** 진행 중 합성 취소(점프/정지 시). 해당 id 이후 결과는 폐기 */
      type: 'cancel'
      id: number
    }

/** worker → main */
export type WorkerResponse =
  | { type: 'load-progress'; phase: 'download' | 'session'; label: string; ratio: number }
  | { type: 'load-done'; sampleRate: number; backend: 'webgpu' | 'wasm' }
  | { type: 'load-error'; message: string }
  | {
      type: 'synth-done'
      id: number
      /** 모노 PCM Float32(sampleRate Hz). transferable 로 전송 */
      pcm: Float32Array
      durationSec: number
    }
  | { type: 'synth-error'; id: number; message: string }
