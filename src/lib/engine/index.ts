/**
 * FN-04 · 엔진 팩토리
 *
 * UI는 RadioEngine 인터페이스만 본다. 실제 구체 엔진 선택은 여기서 캡슐화한다.
 *  - 'webspeech': 부트스트랩 폴백(브라우저 내장 speechSynthesis)
 *  - 'supertonic': 정체성 엔진(온디바이스 Supertonic ONNX, Web Worker + AudioContext)
 */

import type { EngineKind, RadioEngine } from '../types'
import { WebSpeechEngine, type EngineDocContext } from './webSpeechEngine'
import { SupertonicEngine } from './supertonicEngine'

export { WebSpeechEngine } from './webSpeechEngine'
export { SupertonicEngine } from './supertonicEngine'
export type { EngineDocContext } from './webSpeechEngine'
export type { ModelLoadProgress } from './supertonicEngine'

/**
 * 엔진 생성. kind 미지정 시 webspeech.
 * @param kind 'webspeech'(기본·폴백) | 'supertonic'(온디바이스 정체성 엔진)
 * @param ctx  계측용 문서 컨텍스트(선택). UI가 나중에 engine.setDocContext 로 주입해도 됨.
 */
export function createEngine(kind: EngineKind = 'webspeech', ctx?: EngineDocContext): RadioEngine {
  if (kind === 'supertonic') {
    return new SupertonicEngine(ctx)
  }
  return new WebSpeechEngine(ctx)
}
