/**
 * 자가검증: node --experimental-strip-types src/lib/refine/speak.datetime.check.ts
 *
 * matchDate / matchTime 이 (입력, idx) 위치에서 기대한 { ko, len } 또는 null 을
 * 내는지 케이스별로 확인한다. 모두 통과하면 "DATETIME OK", 하나라도 어긋나면 비0 종료.
 *
 * speak.check.ts 와 같은 관행:
 *  - 외부 테스트 프레임워크 없이 Node 전용 스크립트로 실행.
 *  - process 를 최소 선언(@types/node 미설치 환경 타입검사 통과용).
 *
 * 매처는 idx 위치 매칭이므로, 테스트는 "패턴이 시작되는 위치"를 idx 로 준다.
 * 기대값은 매칭 성공 시 { ko, len }, 실패(원문 유지) 시 null.
 */
import { matchDate, matchTime } from './speak.datetime.ts'

declare const process: { exit(code: number): never }

type Matcher = (s: string, idx: number) => { ko: string; len: number } | null

interface Case {
  name: string
  fn: Matcher
  input: string
  idx: number
  expect: { ko: string; len: number } | null
}

const cases: Case[] = [
  // ── 날짜: M/D (불규칙 월 포함) ──
  { name: '날짜 6/22 → 유월 이십이일', fn: matchDate, input: '6/22', idx: 0, expect: { ko: '유월 이십이일', len: 4 } },
  { name: '날짜 3/5 → 삼월 오일', fn: matchDate, input: '회의는 3/5 예정', idx: 4, expect: { ko: '삼월 오일', len: 3 } },
  { name: '날짜 10/1 → 시월 일일(시월 불규칙)', fn: matchDate, input: '10/1', idx: 0, expect: { ko: '시월 일일', len: 4 } },
  { name: '날짜 1/31 → 일월 삼십일일', fn: matchDate, input: '1/31', idx: 0, expect: { ko: '일월 삼십일일', len: 4 } },

  // ── 날짜: YYYY-MM-DD / YYYY/MM/DD ──
  { name: '날짜 2026-06-22 → 연+유월+일', fn: matchDate, input: '2026-06-22', idx: 0, expect: { ko: '이천이십육 년 유월 이십이일', len: 10 } },
  { name: '날짜 2026/06/22 (슬래시형)', fn: matchDate, input: '2026/06/22', idx: 0, expect: { ko: '이천이십육 년 유월 이십이일', len: 10 } },

  // ── 날짜 보수성: 범위 밖이면 null (분수·비율·경로) ──
  { name: '날짜 6/99 → null(일 31 초과=분수)', fn: matchDate, input: '6/99', idx: 0, expect: null },
  { name: '날짜 13/5 → null(월 12 초과)', fn: matchDate, input: '13/5', idx: 0, expect: null },
  { name: '날짜 0/5 → null(월 0)', fn: matchDate, input: '0/5', idx: 0, expect: null },
  { name: '날짜 6/22/99 → null(꼬리 슬래시=경로/추가구분)', fn: matchDate, input: '6/22/99', idx: 0, expect: null },

  // ── 시각: H:MM / HH:MM ──
  { name: '시각 14:30 → 열네 시 삼십 분', fn: matchTime, input: '14:30', idx: 0, expect: { ko: '열네 시 삼십 분', len: 5 } },
  { name: '시각 9:05 → 아홉 시 오 분(영 처리)', fn: matchTime, input: '9:05', idx: 0, expect: { ko: '아홉 시 오 분', len: 4 } },
  { name: '시각 0:00 → 영 시 정각(00=정각)', fn: matchTime, input: '0:00', idx: 0, expect: { ko: '영 시 정각', len: 4 } },
  { name: '시각 23:59 → 스물세 시 오십구 분', fn: matchTime, input: '23:59', idx: 0, expect: { ko: '스물세 시 오십구 분', len: 5 } },
  { name: '시각 12:00 → 열두 시 정각', fn: matchTime, input: '점심 12:00 약속', idx: 3, expect: { ko: '열두 시 정각', len: 5 } },

  // ── 시각 보수성: 범위 밖/형식 어긋나면 null ──
  { name: '시각 3:1 → null(분 1자리=구절/비율)', fn: matchTime, input: '요한복음 3:1 절', idx: 5, expect: null },
  { name: '시각 25:00 → null(시 24 초과=비율)', fn: matchTime, input: '25:00', idx: 0, expect: null },
  { name: '시각 14:60 → null(분 60=범위밖)', fn: matchTime, input: '14:60', idx: 0, expect: null },
  { name: '시각 12:30:45 → null(초까지=시각단독 아님)', fn: matchTime, input: '12:30:45', idx: 0, expect: null },

  // ── 교차 보수성: 시각 매처에 날짜 모양, 날짜 매처에 시각 모양 ──
  { name: '날짜매처에 14:30 → null', fn: matchDate, input: '14:30', idx: 0, expect: null },
  { name: '시각매처에 6/22 → null', fn: matchTime, input: '6/22', idx: 0, expect: null },
]

let allOk = true

console.log('matchDate / matchTime 검증')
console.log('══════════════════════════════════════════')

/** { ko, len } | null 비교 헬퍼. */
function eq(
  a: { ko: string; len: number } | null,
  b: { ko: string; len: number } | null
): boolean {
  if (a === null || b === null) return a === b
  return a.ko === b.ko && a.len === b.len
}

function show(v: { ko: string; len: number } | null): string {
  return v === null ? 'null' : `{ ko: "${v.ko}", len: ${v.len} }`
}

for (const c of cases) {
  const got = c.fn(c.input, c.idx)
  const ok = eq(got, c.expect)
  if (!ok) allOk = false
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} [${c.name}]`)
  if (!ok) {
    console.log(`    입력 : "${c.input}" (idx=${c.idx})`)
    console.log(`    기대 : ${show(c.expect)}`)
    console.log(`    실제 : ${show(got)}`)
  }
}

console.log('══════════════════════════════════════════')
if (allOk) {
  console.log('DATETIME OK')
  process.exit(0)
} else {
  console.error('DATETIME FAILED')
  process.exit(1)
}
