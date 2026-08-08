import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// Cloudflare Pages: build `npm run build` → output `dist`
//
// onnxruntime-web 설정(Supertonic 엔진 · MarkdownRadio 에서 검증된 구성 그대로):
//  - optimizeDeps.exclude: ort 는 자체 .wasm/.mjs 사이드카를 동적 로드하므로
//    Vite 의 의존성 사전 번들(esbuild)에서 제외해야 WASM 경로가 깨지지 않는다.
//  - build.target 'esnext': ort 와 WebGPU 경로가 top-level await/최신 문법을 쓴다.
//  - worker.format 'es': 합성 워커(supertonic.worker.ts)를 ES 모듈 워커로 번들.
//    ⚠️ pdf.js 워커도 같은 설정 아래 공존해야 한다(Phase 0 스파이크 검증 항목).
//
// PWA(vite-plugin-pwa / Workbox):
//  ⚠️ 모델 파일(.onnx ~380MB, .bin)은 절대 precache 하지 않는다 — modelCache.ts 의
//     자체 IndexedDB 캐시로 관리하므로 SW 가 손대면 중복/용량 폭증.
export default defineConfig({
  server: {
    // 실기 검증(안드로이드)용: cloudflared 터널 Host 헤더 허용.
    allowedHosts: ['.trycloudflare.com'],
    // onnxruntime-web 멀티스레드 WASM(SharedArrayBuffer)에 교차출처 격리가 필요하다.
    // 격리가 없으면 simd-threaded wasm 추론이 빈 버퍼(무음)를 낸다(안드로이드 실측).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false, // public/manifest.webmanifest 를 직접 관리
      workbox: {
        // precache 대상: 앱 셸(소형 정적 자산)만.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,ico}'],
        // 모델·런타임 대용량 자산 + pdf.js 청크(lazy)는 SW 캐시에서 차단.
        //  - 모델: IndexedDB 자체 캐시. pdf: PDF 문서를 열 때만 동적 로드(첫 설치 경량 유지).
        globIgnores: ['**/*.{onnx,bin,wasm,mjs,data}', '**/pdf-*.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  optimizeDeps: {
    // ort 와 동일한 이유(자체 사이드카 동적 로드) + pdf.js 는 워커를 별도 로드한다.
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // pdf.js 생태계를 단일 'pdf' 청크로 묶는다. dynamic import(lazy)라 메인 번들엔
        // 안 들어가고, 이 청크만 globIgnores('**/pdf-*.js')로 precache 에서 통째 제외
        // → PWA 첫 설치를 경량으로 유지한다.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/]pdfjs-dist[\\/]/.test(id)) return 'pdf'
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
})
