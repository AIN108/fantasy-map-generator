import { defineConfig } from "vite";

// GitHub Pages(https://<user>.github.io/<repo>/)에서도 동작하도록 상대 경로로 빌드한다.
export default defineConfig({
  base: "./",
});
