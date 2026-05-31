import { build } from "esbuild";

await build({
  entryPoints: ["src/server/vercel-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "api/index.ts",
  minify: true,
  legalComments: "none",
  banner: {
    js: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);"
  },
  footer: {
    js: "export default globalThis['__certusVercelHandler'];"
  }
});
