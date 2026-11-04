import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const isCI = !!process.env.CI;

// 빌드된 결과물(dist)을 vite preview로 띄워 실제 배포본과 같은 조건에서 검사한다.
// 로컬에서는 `npm run build` 후 `npm run test:e2e`.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  // 기준 이미지는 OS별로 다르게 나오므로 파일 이름에 플랫폼을 붙이지 않고 Linux 기준 하나만 둔다
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // 고해상도 화면: 캔버스 해상도·좌표 변환이 배율 2에서도 맞는지
    { name: "desktop-hidpi", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
      testIgnore: /layout\.spec/ },
    // Safari 계열 엔진. 시각 회귀 기준 이미지는 Chromium으로만 만든다.
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } }, testIgnore: /visual\.spec/ },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
});
