import { build } from "esbuild"

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.js",
  sourcemap: true,
  logLevel: "info",
  external: [
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@huggingface/transformers",
  ],
  banner: {
    js: "import { createRequire as _ocqCreateRequire } from 'module';\nconst require = _ocqCreateRequire(import.meta.url);",
  },
})
