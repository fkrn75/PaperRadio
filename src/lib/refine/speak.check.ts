/**
 * 자가검증: node --experimental-strip-types src/lib/refine/speak.check.ts
 *
 * toSpoken(입력) === 기대 발음 인지 케이스별로 확인한다.
 * 모두 통과하면 "SPEAK OK" 출력, 하나라도 어긋나면 비0 종료코드로 종료.
 *
 * invariant.check.ts 와 같은 관행:
 *  - 외부 테스트 프레임워크 없이 Node 전용 스크립트로 실행.
 *  - process 를 최소 선언(@types/node 미설치 환경 타입검사 통과용).
 */
import { toSpoken } from './speak.ts'

declare const process: { exit(code: number): never }

interface Case {
  name: string
  input: string
  expect: string
}

const cases: Case[] = [
  // ── 숫자: 연도/정수/소수 ──
  { name: '연도(2026)', input: '2026년에 출시됩니다.', expect: '이천이십육년에 출시됩니다.' },
  { name: '정수(작은 수)', input: '사과 15개를 샀다.', expect: '사과 십오개를 샀다.' },
  { name: '정수(만 단위)', input: '인구는 52000명이다.', expect: '인구는 오만이천명이다.' },
  { name: '정수(1004=천사)', input: '방 번호는 1004호.', expect: '방 번호는 천사호.' },
  { name: '소수점(1.5)', input: '속도는 1.5배.', expect: '속도는 일 점 오배.' },
  { name: '소수점(3.14)', input: '원주율 3.14 입니다.', expect: '원주율 삼 점 일사 입니다.' },

  // ── 단위·통화·퍼센트(숫자 결합) ──
  { name: '용량(100MB)', input: '용량은 100MB 입니다.', expect: '용량은 백 메가바이트 입니다.' },
  { name: '퍼센트(40%)', input: '점유율 40% 달성.', expect: '점유율 사십 퍼센트 달성.' },
  { name: '거리(5km)', input: '5km 떨어져 있다.', expect: '오 킬로미터 떨어져 있다.' },
  { name: '무게(3kg)', input: '무게는 3kg 이다.', expect: '무게는 삼 킬로그램 이다.' },
  { name: '통화($100)', input: '가격은 $100 입니다.', expect: '가격은 백 달러 입니다.' },

  // ── 영문 약자(연속 대문자) ──
  { name: '약자(API)', input: 'API 호출이 실패했다.', expect: '에이피아이 호출이 실패했다.' },
  { name: '약자(TTS)', input: 'TTS 엔진을 켰다.', expect: '티티에스 엔진을 켰다.' },
  { name: '약자(CPU·GPU 혼합)', input: 'CPU와 GPU 사용량.', expect: '씨피유와 지피유 사용량.' },

  // ── 약자 보수성: 일반 영단어/식별자는 건드리지 않음 ──
  { name: '보수성(소문자 영단어 유지)', input: 'hello world 입니다.', expect: 'hello world 입니다.' },
  { name: '보수성(첫글자만 대문자 유지)', input: 'Apple 사의 제품.', expect: 'Apple 사의 제품.' },
  { name: '보수성(대문자+소문자 식별자 유지)', input: 'APIServer 클래스.', expect: 'APIServer 클래스.' },

  // ── 기호 ──
  { name: '앰퍼샌드(&)', input: '연구 & 개발 부서.', expect: '연구 그리고 개발 부서.' },
  { name: '원문자(①②③)', input: '① 준비 ② 실행 ③ 검토', expect: '1 준비 2 실행 3 검토' },
  // ~ 는 '에서'로, 양옆 숫자는 한국어 읽기로 함께 변환된다(삼/오).
  { name: '범위 물결(3~5)', input: '3~5명이 필요하다.', expect: '삼 에서 오명이 필요하다.' },

  // ── 호흡 보강(종결부호 뒤 공백) ──
  { name: '호흡(마침표 뒤 공백 보강)', input: '끝났다.다음으로.', expect: '끝났다. 다음으로.' },

  // ── 빈 문자열(무음 청크) ──
  { name: '빈 입력(무음)', input: '', expect: '' },
]

let allOk = true

console.log('toSpoken 발음 변환 검증')
console.log('══════════════════════════════════════════')

for (const c of cases) {
  const got = toSpoken(c.input)
  const ok = got === c.expect
  if (!ok) allOk = false
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} [${c.name}]`)
  if (!ok) {
    console.log(`    입력 : "${c.input}"`)
    console.log(`    기대 : "${c.expect}"`)
    console.log(`    실제 : "${got}"`)
  }
}

// 옵션 토글 동작도 1건 확인: numbers=false 면 숫자는 원문 유지, 단위만 한글.
console.log('──────────────────────────────────────────')
{
  const got = toSpoken('100MB 입니다.', { numbers: false })
  const expect = '100 메가바이트 입니다.'
  const ok = got === expect
  if (!ok) allOk = false
  console.log(`${ok ? '✓' : '✗'} [옵션 numbers=false(숫자 원문 유지·단위만 변환)]`)
  if (!ok) {
    console.log(`    기대 : "${expect}"`)
    console.log(`    실제 : "${got}"`)
  }
}

// 순수성 확인: 호출 전후 입력 문자열이 그대로인지(불변).
{
  const original = '2026년 API 100MB'
  const snapshot = original
  toSpoken(original)
  const ok = original === snapshot
  if (!ok) allOk = false
  console.log(`${ok ? '✓' : '✗'} [순수성(입력 불변)]`)
}

console.log('══════════════════════════════════════════')
if (allOk) {
  console.log('SPEAK OK')
  process.exit(0)
} else {
  console.error('SPEAK FAILED')
  process.exit(1)
}
