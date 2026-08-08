/**
 * 자가검증: node --experimental-strip-types src/lib/refine/speak.units.check.ts
 *
 * speak.units.ts 의 매처 3종(matchFraction / matchCurrency / matchDimension)을
 * 케이스별로 직접 호출해 { ko, len } 또는 null 을 확인한다.
 * 모두 통과하면 "SPEAK UNITS OK" 출력, 하나라도 어긋나면 비0 종료코드로 종료.
 *
 * speak.check.ts 와 같은 관행:
 *  - 외부 테스트 프레임워크 없이 Node 전용 스크립트로 실행.
 *  - process 를 최소 선언(@types/node 미설치 환경 타입검사 통과용).
 *
 * ⚠️ 매처는 toSpoken 루프 안에서 idx 위치에 호출되는 "부분 매처"다. 그래서
 *    s(문자열)·idx(시작 위치)를 직접 주고, 기대값은 { ko, len } 또는 null 로 검증한다.
 */
import { matchFraction, matchCurrency, matchDimension } from './speak.units.ts'

declare const process: { exit(code: number): never }

type Matcher = (s: string, idx: number) => { ko: string; len: number } | null
type Expect = { ko: string; len: number } | null

interface Case {
  name: string
  fn: Matcher
  s: string
  idx: number
  expect: Expect
}

function eq(a: Expect, b: Expect): boolean {
  if (a === null || b === null) return a === b
  return a.ko === b.ko && a.len === b.len
}
function show(v: Expect): string {
  return v === null ? 'null' : `{ ko: "${v.ko}", len: ${v.len} }`
}

const cases: Case[] = [
  // ──────────────────────────────────────────────────────
  // 분수 (matchFraction)
  // ──────────────────────────────────────────────────────
  // 사용자 예시(1순위): 단순분수가 분수로 읽혀야 한다.
  { name: '분수 1/2 -> 이분의 일', fn: matchFraction, s: '1/2', idx: 0, expect: { ko: '이분의 일', len: 3 } },
  { name: '분수 3/4 -> 사분의 삼', fn: matchFraction, s: '3/4', idx: 0, expect: { ko: '사분의 삼', len: 3 } },
  { name: '분수 2/3 -> 삼분의 이', fn: matchFraction, s: '2/3', idx: 0, expect: { ko: '삼분의 이', len: 3 } },
  { name: '분수 5/6 -> 육분의 오', fn: matchFraction, s: '5/6', idx: 0, expect: { ko: '육분의 오', len: 3 } },
  // 날짜로 불가능(분모>31): 분수 확정 — 일(日) 범위를 벗어나 날짜가 될 수 없음.
  { name: '분수 3/32 -> 삼십이분의 삼(분모>31)', fn: matchFraction, s: '3/32', idx: 0, expect: { ko: '삼십이분의 삼', len: 4 } },
  // 날짜로 불가능(분자>12): 분수 확정 — 월(月) 범위를 벗어나 날짜가 될 수 없음.
  { name: '분수 13/4 -> 사분의 십삼(분자>12)', fn: matchFraction, s: '13/4', idx: 0, expect: { ko: '사분의 십삼', len: 4 } },
  // 문장 중간(앞에 한글)에서도 인식.
  { name: '분수 문장중간(약 3/4 지점)', fn: matchFraction, s: '약 3/4 지점', idx: 2, expect: { ko: '사분의 삼', len: 3 } },

  // ── 경계: 유효 날짜로도 보이는 모호 구간 → null (날짜 매처에 양보) ──
  { name: '경계 6/22 -> null(날짜 우선·핵심)', fn: matchFraction, s: '6/22', idx: 0, expect: null },
  { name: '경계 5/30 -> null(날짜 우선)', fn: matchFraction, s: '5/30', idx: 0, expect: null },
  { name: '경계 12/25 -> null(날짜 우선)', fn: matchFraction, s: '12/25', idx: 0, expect: null },
  { name: '경계 1/16 -> null(유효날짜 1월16일)', fn: matchFraction, s: '1/16', idx: 0, expect: null },
  { name: '경계 3/3 -> null(분자>=분모·모호)', fn: matchFraction, s: '3/3', idx: 0, expect: null },
  // 꼬리/중첩/소수 — 단순분수 아님.
  { name: '경계 6/22/99 -> null(날짜꼬리)', fn: matchFraction, s: '6/22/99', idx: 0, expect: null },
  { name: '경계 1/2/3 -> null(중첩 슬래시)', fn: matchFraction, s: '1/2/3', idx: 0, expect: null },
  { name: '경계 1/2.5 -> null(소수 꼬리)', fn: matchFraction, s: '1/2.5', idx: 0, expect: null },
  // 비전형: 분모 1·분모 0·0 패딩·분모 100+.
  { name: '경계 5/1 -> null(분모 1)', fn: matchFraction, s: '5/1', idx: 0, expect: null },
  { name: '경계 1/0 -> null(분모 0)', fn: matchFraction, s: '1/0', idx: 0, expect: null },
  { name: '경계 01/2 -> null(0 패딩)', fn: matchFraction, s: '01/2', idx: 0, expect: null },
  // 가분수형 10/2: 분모 2-12지만 분자(10)<분모(2) 아님 → (A) 불충족, 날짜불가도 아님 → null.
  { name: '경계 10/2 -> null(가분수·모호)', fn: matchFraction, s: '10/2', idx: 0, expect: null },

  // ──────────────────────────────────────────────────────
  // 통화기호 (matchCurrency)  — $ 제외
  // ──────────────────────────────────────────────────────
  { name: '통화 ₩5000 -> 오천 원', fn: matchCurrency, s: '₩5000', idx: 0, expect: { ko: '오천 원', len: 5 } },
  { name: '통화 €10 -> 십 유로', fn: matchCurrency, s: '€10', idx: 0, expect: { ko: '십 유로', len: 3 } },
  { name: '통화 £20 -> 이십 파운드', fn: matchCurrency, s: '£20', idx: 0, expect: { ko: '이십 파운드', len: 3 } },
  { name: '통화 ¥100 -> 백 엔', fn: matchCurrency, s: '¥100', idx: 0, expect: { ko: '백 엔', len: 4 } },
  // 콤마·소수·문장중간.
  { name: '통화 ₩1,000,000 -> 백만 원', fn: matchCurrency, s: '₩1,000,000', idx: 0, expect: { ko: '백만 원', len: 10 } },
  { name: '통화 €10.5 -> 십 점 오 유로', fn: matchCurrency, s: '€10.5', idx: 0, expect: { ko: '십 점 오 유로', len: 5 } },
  { name: '통화 문장중간(가격 ₩5000 임)', fn: matchCurrency, s: '가격 ₩5000 임', idx: 3, expect: { ko: '오천 원', len: 5 } },
  // 경계: 기호 단독/숫자 없음 → null.
  { name: '경계 ₩ 단독 -> null', fn: matchCurrency, s: '₩원', idx: 0, expect: null },
  { name: '경계 $100 -> null(달러는 speak.ts 담당)', fn: matchCurrency, s: '$100', idx: 0, expect: null },

  // ──────────────────────────────────────────────────────
  // 차원 (matchDimension)
  // ──────────────────────────────────────────────────────
  { name: '차원 2D -> 투디', fn: matchDimension, s: '2D', idx: 0, expect: { ko: '투디', len: 2 } },
  { name: '차원 3D -> 쓰리디', fn: matchDimension, s: '3D', idx: 0, expect: { ko: '쓰리디', len: 2 } },
  { name: '차원 4D -> 포디', fn: matchDimension, s: '4D', idx: 0, expect: { ko: '포디', len: 2 } },
  { name: '차원 1D -> 원디', fn: matchDimension, s: '1D', idx: 0, expect: { ko: '원디', len: 2 } },
  { name: '차원 문장중간(완전 3D 영화)', fn: matchDimension, s: '완전 3D 영화', idx: 3, expect: { ko: '쓰리디', len: 2 } },
  // 경계: 뒤에 영문자/숫자 → null.
  { name: '경계 3Days -> null(뒤 영문자)', fn: matchDimension, s: '3Days', idx: 0, expect: null },
  { name: '경계 2Dx -> null(뒤 영문자)', fn: matchDimension, s: '2Dx', idx: 0, expect: null },
  { name: '경계 3D4 -> null(뒤 숫자)', fn: matchDimension, s: '3D4', idx: 0, expect: null },
  { name: '경계 0D -> null(0은 제외)', fn: matchDimension, s: '0D', idx: 0, expect: null },
]

let allOk = true

console.log('speak.units 매처(분수·통화·차원) 검증')
console.log('══════════════════════════════════════════')

for (const c of cases) {
  const got = c.fn(c.s, c.idx)
  const ok = eq(got, c.expect)
  if (!ok) allOk = false
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} [${c.name}]`)
  if (!ok) {
    console.log(`    입력 : s="${c.s}", idx=${c.idx}`)
    console.log(`    기대 : ${show(c.expect)}`)
    console.log(`    실제 : ${show(got)}`)
  }
}

console.log('══════════════════════════════════════════')
if (allOk) {
  console.log('SPEAK UNITS OK')
  process.exit(0)
} else {
  console.error('SPEAK UNITS FAILED')
  process.exit(1)
}
