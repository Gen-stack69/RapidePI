// Builds the landing page (landing/) as a site of its own, separate from the
// app: `npm run build:landing` writes it to dist-landing/, which the Worker in
// wrangler.landing.jsonc serves at rapidewms.rapidewms.workers.dev.
// `npm run dev:landing` serves it locally.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./landing", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./dist-landing", import.meta.url)),
    emptyOutDir: true,
  },
  server: { port: 5174 },
});
