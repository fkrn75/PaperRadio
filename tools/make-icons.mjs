/**
 * 앱 아이콘 생성기 — SVG 를 그려 PNG 세 장으로 굽는다.
 *
 * 디자인 의도: 이 앱은 "원본 페이지를 보면서 듣는" 것이다. 그래서
 *   흰 페이지 + **노란 하이라이트 줄**(앱의 재생 하이라이트와 같은 색) + 음파
 * 세 요소로 정체성을 표현한다. 작은 크기에서 뭉개지지 않도록 요소는 셋으로 제한했다.
 *
 * maskable 은 별도로 만든다 — 플랫폼이 원형/사각형으로 잘라내므로 안전 영역(중앙 80%)
 * 안에 핵심 요소를 넣어야 한다. 같은 그림을 축소해 여백을 키운 버전이다.
 *
 * ⚠️ sharp 는 **의존성으로 두지 않는다.** 네이티브 바이너리라 CI(Cloudflare Pages) 설치가
 *    느리거나 실패할 수 있는데, 정작 앱 빌드에는 전혀 쓰이지 않는다. 산출물(PNG)은 리포에
 *    커밋돼 있으므로 아이콘을 다시 구울 때만 임시로 설치한다.
 *
 * 사용:
 *   npm i -D sharp && node tools/make-icons.mjs && npm uninstall sharp
 */
import { mkdirSync } from 'node:fs'
import sharp from 'sharp'

const NAVY_FROM = '#2b4c8c'
const NAVY_TO = '#16294d'
const HIGHLIGHT = '#ffd233' // 재생 하이라이트와 같은 노랑
const PAPER = '#ffffff'
const LINE = '#c3cddf'

/**
 * @param {number} pad 0~1. 그림 요소를 중앙으로 얼마나 오므릴지(maskable 은 크게).
 */
function svg(pad) {
  const s = 1 - pad // 요소 스케일
  const t = (512 * pad) / 2 // 중앙 정렬 오프셋
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${NAVY_FROM}"/>
      <stop offset="1" stop-color="${NAVY_TO}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g transform="translate(${t} ${t}) scale(${s})">
    <!-- 페이지 -->
    <rect x="96" y="112" width="216" height="288" rx="16" fill="${PAPER}"/>
    <!-- 본문 줄 -->
    <g fill="${LINE}">
      <rect x="128" y="152" width="152" height="16" rx="8"/>
      <rect x="128" y="192" width="152" height="16" rx="8"/>
      <rect x="128" y="272" width="152" height="16" rx="8"/>
      <rect x="128" y="312" width="112" height="16" rx="8"/>
    </g>
    <!-- 지금 읽고 있는 줄 -->
    <rect x="120" y="224" width="168" height="28" rx="10" fill="${HIGHLIGHT}"/>
    <!-- 소리 -->
    <g stroke="${HIGHLIGHT}" stroke-width="18" fill="none" stroke-linecap="round">
      <path d="M348 216 a 40 40 0 0 1 0 80"/>
      <path d="M388 176 a 84 84 0 0 1 0 160"/>
    </g>
  </g>
</svg>`
}

mkdirSync('public/icons', { recursive: true })

const jobs = [
  { file: 'public/icons/icon-512.png', size: 512, pad: 0.06 },
  { file: 'public/icons/icon-192.png', size: 192, pad: 0.06 },
  // maskable: 플랫폼이 가장자리를 잘라내므로 요소를 더 오므린다.
  { file: 'public/icons/icon-maskable-192.png', size: 192, pad: 0.24 },
]

for (const { file, size, pad } of jobs) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png({ compressionLevel: 9 }).toFile(file)
  console.log(`${file} (${size}x${size}, pad ${pad})`)
}
console.log('아이콘 생성 완료')
