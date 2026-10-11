import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppHandle } from "../src/server/app.js";
import { defaultConfig, type Config } from "../src/server/config.js";

const handles: AppHandle[] = [];

function startApp(overrides: Partial<Config> = {}): Promise<{ base: string; handle: AppHandle }> {
  const handle = createApp(defaultConfig(overrides));
  handles.push(handle);
  return new Promise((resolve, reject) => {
    handle.server.once("error", reject);
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("listen failed"));
      resolve({ base: `http://127.0.0.1:${addr.port}`, handle });
    });
  });
}

afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const post = (base: string, path: string, origin?: string, ua = "vitest/1"): Promise<Response> =>
  fetch(`${base}/api/count`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ua, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ path }),
  });

describe("POST /api/count", () => {
  it("计数并按 IP+UA+小时去重", async () => {
    const { base } = await startApp();
    const r1 = await post(base, "/hello");
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ views: 1 });
    // 同 IP 同 UA 同小时 → 去重
    const r2 = await post(base, "/hello");
    expect(await r2.json()).toEqual({ views: 1 });
    // 换 UA 计新访客
    const r3 = await post(base, "/hello", undefined, "other-browser/2");
    expect(await r3.json()).toEqual({ views: 2 });
  });

  it("非法路径 / 非法 JSON / 超大 body", async () => {
    const { base } = await startApp();
    expect((await post(base, "no-slash")).status).toBe(400);
    expect((await post(base, "/bad path")).status).toBe(400);
    expect(
      (
        await fetch(`${base}/api/count`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
      ).status,
    ).toBe(400);
    const big = "x".repeat(5000);
    expect(
      (
        await fetch(`${base}/api/count`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/a", padding: big }),
        })
      ).status,
    ).toBe(413);
  });

  it("限频：超限 429 且带 Retry-After", async () => {
    const { base } = await startApp({ rateMax: 1 });
    expect((await post(base, "/a")).status).toBe(200);
    const r2 = await post(base, "/b");
    expect(r2.status).toBe(429);
    expect(r2.headers.get("retry-after")).toBe("1");
  });
});

describe("GET /api/count?paths=", () => {
  it("批量查询不计数；路径内逗号用 %2C 不受分隔影响", async () => {
    const { base, handle } = await startApp();
    await post(base, "/p1");
    await post(base, "/p2");
    const res = await fetch(`${base}/api/count?paths=/p1,/p2,/none`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ views: { "/p1": 1, "/p2": 1, "/none": 0 } });
    expect(handle.store.countOf("/p1")).toBe(1);

    // widget.js 以 encodeURIComponent 编码整个列表（含分隔逗号），服务端先解码再分割
    const encoded = await fetch(`${base}/api/count?paths=${encodeURIComponent("/x,/y")}`);
    expect(await encoded.json()).toEqual({ views: { "/x": 0, "/y": 0 } });
    // 非法转义序列不 500
    const bad = await fetch(`${base}/api/count?paths=%zz`);
    expect(bad.status).toBe(200);
  });

  it("DELETE 方法 405；未知路由 404", async () => {
    const { base } = await startApp();
    expect((await fetch(`${base}/api/count`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("CORS", () => {
  it("白名单来源放行并回写 ACAO", async () => {
    const { base } = await startApp({ allowedOrigins: ["https://blog.example"] });
    const res = await post(base, "/a", "https://blog.example");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://blog.example");
  });

  it("未列入白名单且不同源 → 403", async () => {
    const { base } = await startApp();
    const res = await post(base, "/a", "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("同源（Origin host == Host）自动放行", async () => {
    const { base } = await startApp();
    const res = await post(base, "/a", base);
    expect(res.status).toBe(200);
  });

  it("OPTIONS 预检返回 204 与方法白名单", async () => {
    const { base } = await startApp({ allowedOrigins: ["https://blog.example"] });
    const res = await fetch(`${base}/api/count`, {
      method: "OPTIONS",
      headers: { origin: "https://blog.example" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("GET /api/stats", () => {
  it("未配置令牌 → 403 禁用", async () => {
    const { base } = await startApp();
    const res = await fetch(`${base}/api/stats?token=x`);
    expect(res.status).toBe(403);
  });

  it("令牌错误 403，正确返回 Top 路径", async () => {
    const { base } = await startApp({ adminToken: "sekrit" });
    await post(base, "/top");
    await post(base, "/top", undefined, "ua2");
    await post(base, "/low");

    expect((await fetch(`${base}/api/stats?token=wrong`)).status).toBe(403);
    const res = await fetch(`${base}/api/stats?token=sekrit&limit=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ top: [{ path: "/top", views: 2 }] });
  });
});

describe("widget 托管", () => {
  it("未配置 widgetPath → 404", async () => {
    const { base } = await startApp();
    expect((await fetch(`${base}/widget.js`)).status).toBe(404);
  });
});
