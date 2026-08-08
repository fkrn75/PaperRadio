/**
 * 자가검증: node --experimental-strip-types src/lib/refine/speak.misc.check.ts
 *
 * speak.misc.ts 의 부분 매처(matchPhone/matchOrdinal/matchTemperature)가
 * idx 자리에서 기대한 { ko, len } 또는 null 을 내는지 케이스별로 확인한다.
 * 모두 통과하면 "SPEAK MISC OK", 하나라도 어긋나면 비0 종료코드.
 *
 * speak.check.ts 와 같은 관행:
 *  - 외부 테스트 프레임워크 없이 Node 전용 스크립트.
 *  - process 최소 선언(@types/node 미설치 환경 타입검사 통과용).
 */
import { matchPhone, matchOrdinal, matchTemperature } from './speak.misc.ts'

declare const process: { exit(code: number): never }

type MatchResult = { ko: string; len: number } | null

interface Case {
  name: string
  fn: (s: string, idx: number) => MatchResult
  input: string
  idx: number
  expect: MatchResult
}

const cases: Case[] = [
  // ── 전화번호: 자리별 음독, 0='공', 그룹 사이 공백 ──
  {
    name: '휴대폰(010-1234-5678)',
    fn: matchPhone,
    input: '010-1234-5678',
    idx: 0,
    expect: { ko: '공일공 일이삼사 오육칠팔', len: 13 },
  },
  {
    name: '휴대폰 중간 3자리(011-123-4567)',
    fn: matchPhone,
    input: '011-123-4567',
    idx: 0,
    expect: { ko: '공일일 일이삼 사오육칠', len: 12 },
  },
  {
    name: '서울 지역(02-123-4567)',
    fn: matchPhone,
    input: '02-123-4567',
    idx: 0,
    expect: { ko: '공이 일이삼 사오육칠', len: 11 },
  },
  {
    name: '지역번호(031-123-4567)',
    fn: matchPhone,
    input: '031-123-4567',
    idx: 0,
    expect: { ko: '공삼일 일이삼 사오육칠', len: 12 },
  },
  {
    name: '인터넷전화(070-1234-5678)',
    fn: matchPhone,
    input: '070-1234-5678',
    idx: 0,
    expect: { ko: '공칠공 일이삼사 오육칠팔', len: 13 },
  },
  {
    name: '대표번호(1588-1234)',
    fn: matchPhone,
    input: '1588-1234',
    idx: 0,
    expect: { ko: '일오팔팔 일이삼사', len: 9 },
  },
  // 문장 중간 idx 에서도 동작 + 직후 비숫자 경계.
  {
    name: '문장 중간 전화번호(idx>0)',
    fn: matchPhone,
    input: '전화 010-1234-5678 로',
    idx: 3,
    expect: { ko: '공일공 일이삼사 오육칠팔', len: 13 },
  },

  // ── 전화번호 경계: 일반 하이픈 수식은 null ──
  { name: "경계 '1-2'(전화 아님)", fn: matchPhone, input: '1-2명', idx: 0, expect: null },
  { name: "경계 '2-3개'(전화 아님)", fn: matchPhone, input: '2-3개', idx: 0, expect: null },
  // 0NN 이지만 끝 그룹이 4자리가 아니라 전화 아님(휴리스틱 거부).
  { name: "경계 '12-34-56'(짧음·전화 아님)", fn: matchPhone, input: '12-34-56', idx: 0, expect: null },
  // 직후에 숫자가 더 이어지면(긴 식별자) 보류.
  {
    name: '경계 직후 숫자 이어짐(보류)',
    fn: matchPhone,
    input: '010-1234-56789',
    idx: 0,
    expect: null,
  },

  // ── 서수: 고유어 차례 ──
  { name: '1st->첫 번째', fn: matchOrdinal, input: '1st', idx: 0, expect: { ko: '첫 번째', len: 3 } },
  { name: '2nd->두 번째', fn: matchOrdinal, input: '2nd', idx: 0, expect: { ko: '두 번째', len: 3 } },
  { name: '3rd->세 번째', fn: matchOrdinal, input: '3rd', idx: 0, expect: { ko: '세 번째', len: 3 } },
  { name: '4th->네 번째', fn: matchOrdinal, input: '4th', idx: 0, expect: { ko: '네 번째', len: 3 } },
  {
    name: '11th->열한 번째',
    fn: matchOrdinal,
    input: '11th',
    idx: 0,
    expect: { ko: '열한 번째', len: 4 },
  },
  {
    name: '21st->스물한 번째',
    fn: matchOrdinal,
    input: '21st',
    idx: 0,
    expect: { ko: '스물한 번째', len: 4 },
  },
  {
    name: '22nd->스물두 번째',
    fn: matchOrdinal,
    input: '22nd',
    idx: 0,
    expect: { ko: '스물두 번째', len: 4 },
  },
  {
    name: '30th->서른 번째',
    fn: matchOrdinal,
    input: '30th',
    idx: 0,
    expect: { ko: '서른 번째', len: 4 },
  },
  // 문장 중간 idx.
  {
    name: '문장 중간 서수(idx>0)',
    fn: matchOrdinal,
    input: 'the 2nd place',
    idx: 4,
    expect: { ko: '두 번째', len: 3 },
  },

  // ── 서수 경계: 단어 일부의 rd/th 는 건드리지 않음 ──
  // 'word' 의 'rd' 는 숫자 뒤가 아니므로 애초에 숫자에서 매칭 시작 안 됨 → idx=2('rd') 호출해도 null.
  { name: "경계 'word'의 rd(숫자 아님)", fn: matchOrdinal, input: 'word', idx: 2, expect: null },
  { name: "경계 'the'의 th(숫자 아님)", fn: matchOrdinal, input: 'the', idx: 1, expect: null },
  // 서수 접미사 뒤에 영문자가 더 붙으면(단어 일부) 보류.
  {
    name: '경계 서수 뒤 영문자(1stx 보류)',
    fn: matchOrdinal,
    input: '1stx',
    idx: 0,
    expect: null,
  },
  // 접미사·숫자 불일치(1th 는 잘못된 서수) → 보류.
  { name: "경계 불일치 '1th'(보류)", fn: matchOrdinal, input: '1th', idx: 0, expect: null },
  { name: "경계 불일치 '2st'(보류)", fn: matchOrdinal, input: '2st', idx: 0, expect: null },

  // ── 온도(선택 기능) ──
  {
    name: '온도(25°C->섭씨 이십오 도)',
    fn: matchTemperature,
    input: '25°C',
    idx: 0,
    expect: { ko: '섭씨 이십오 도', len: 4 },
  },
  {
    name: '온도 합자(25℃)',
    fn: matchTemperature,
    input: '25℃',
    idx: 0,
    expect: { ko: '섭씨 이십오 도', len: 3 },
  },
  {
    name: '온도 화씨 소수(98.6°F)',
    fn: matchTemperature,
    input: '98.6°F',
    idx: 0,
    expect: { ko: '화씨 구십팔 점 육 도', len: 6 },
  },
  // 단위 없는 ° (각도)는 모호 → null.
  { name: "온도 경계 '90°'(각도·보류)", fn: matchTemperature, input: '90° 회전', idx: 0, expect: null },
]

function eq(a: MatchResult, b: MatchResult): boolean {
  if (a === null || b === null) return a === b
  return a.ko === b.ko && a.len === b.len
}

function show(r: MatchResult): string {
  return r === null ? 'null' : `{ ko: "${r.ko}", len: ${r.len} }`
}

let allOk = true

console.log('speak.misc 부분 매처 검증 (전화번호·서수·온도)')
console.log('══════════════════════════════════════════')

for (const c of cases) {
  const got = c.fn(c.input, c.idx)
  const ok = eq(got, c.expect)
  if (!ok) allOk = false
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} [${c.name}]`)
  if (!ok) {
    console.log(`    입력 : "${c.input}" @${c.idx}`)
    console.log(`    기대 : ${show(c.expect)}`)
    console.log(`    실제 : ${show(got)}`)
  }
}

console.log('══════════════════════════════════════════')
if (allOk) {
  console.log('SPEAK MISC OK')
  process.exit(0)
} else {
  console.error('SPEAK MISC FAILED')
  process.exit(1)
}
