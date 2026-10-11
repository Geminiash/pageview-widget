// 构建 widget.js（UMD/IIFE）与 widget.esm.js（ESM），并断言未压缩体积 < 2KB
import { build } from "esbuild";
import { statSync } from "node:fs";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const common = {
  entryPoints: ["src/embed/widget.ts"],
  bundle: true,
  minify: false,
  target: "es2019",
  logLevel: "silent",
};

await build({ ...common, format: "iife", outfile: "dist/widget.js" });
await build({ ...common, format: "esm", outfile: "dist/widget.esm.js" });

let failed = false;
for (const f of ["dist/widget.js", "dist/widget.esm.js"]) {
  const size = statSync(f).size;
  const ok = size < 2048;
  if (!ok) failed = true;
  console.log(`${ok ? "OK " : "FAIL"} ${f}: ${size} bytes (limit 2048)`);
}
if (failed) {
  console.error("widget 超过 2KB 限制，构建失败");
  process.exit(1);
}
