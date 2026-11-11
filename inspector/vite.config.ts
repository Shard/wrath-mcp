/*
 * The bin's own page (`page/`), built to `dist/`, which `wrath-inspector`
 * serves. `bun run build` here; `bun run dev` serves it with the API proxied
 * to a bin on 8091 (`WRATH_INSPECTOR_ORIGIN` points it elsewhere).
 */
import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const origin = process.env["WRATH_INSPECTOR_ORIGIN"] ?? "http://127.0.0.1:8091";

export default defineConfig({
  root: resolve(import.meta.dirname, "page"),
  base: "/",
  plugins: [solid()],
  resolve: { dedupe: ["solid-js"] },
  build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true, target: "es2022" },
  server: { port: 5181, proxy: { "/api": origin, "/tiles": origin } },
});
