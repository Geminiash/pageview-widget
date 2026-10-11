// 压测脚本：对本机起的服务打 N 次 POST /api/count，输出 QPS。
// 用法：pnpm build && node scripts/bench.mjs [total=1000] [concurrency=50]
// 限频默认关闭（rateMax=0），测的是后端纯吞吐；生产默认 10 次/秒/IP。
import { createApp } from "../dist/server/app.js";
import { defaultConfig } from "../dist/server/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const total = Number(process.argv[2] ?? 1000);
const concurrency = Number(process.argv[3] ?? 50);
if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(concurrency) || concurrency <= 0) {
  console.error("用法: node scripts/bench.mjs [total] [concurrency]");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "pv-bench-"));
const app = createApp(
  defaultConfig({ dbPath: join(dir, "bench.db"), rateMax: 0, salt: "bench-salt", adminToken: "bench" }),
);
await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}/api/count`;

// 50 个路径 x 10 个 UA：保证命中真实的写入路径（去重键各不相同）
const uaPool = Array.from({ length: 10 }, (_, i) => `bench-ua-${i}`);
let cursor = 0;
let errors = 0;

const worker = async () => {
  while (cursor < total) {
    const i = cursor++;
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": uaPool[i % uaPool.length] },
      body: JSON.stringify({ path: `/post-${i % 50}` }),
    });
    if (!res.ok) errors++;
  }
};

const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const ms = performance.now() - t0;

// 顺便验证查询与统计接口
const q0 = performance.now();
const qres = await fetch(`${base}?paths=${encodeURIComponent("/post-0,/post-1")}`);
const stats = await fetch(`http://127.0.0.1:${port}/api/stats?token=bench`);
const qms = performance.now() - q0;

console.log(`POST /api/count x ${total}, concurrency=${concurrency}`);
console.log(`  time:   ${ms.toFixed(0)} ms`);
console.log(`  qps:    ${(total / (ms / 1000)).toFixed(0)} req/s`);
console.log(`  errors: ${errors}`);
console.log(`GET  batch + /api/stats: ${qms.toFixed(1)} ms`);
console.log(`stats: ${JSON.stringify(await stats.json()).slice(0, 120)}...`);

app.close();
rmSync(dir, { recursive: true, force: true });
