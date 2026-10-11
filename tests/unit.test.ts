import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortHash } from "../src/server/hash.js";
import { RateLimiter } from "../src/server/rate-limit.js";
import { loadConfig, defaultConfig } from "../src/server/config.js";
import { Store } from "../src/server/db.js";

describe("shortHash", () => {
  it("同输入同盐输出一致，16 位十六进制", () => {
    const a = shortHash("1.2.3.4", "salt");
    const b = shortHash("1.2.3.4", "salt");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("不同盐 / 不同输入产生不同哈希", () => {
    expect(shortHash("1.2.3.4", "salt-a")).not.toBe(shortHash("1.2.3.4", "salt-b"));
    expect(shortHash("1.2.3.4", "s")).not.toBe(shortHash("1.2.3.5", "s"));
  });
});

describe("RateLimiter", () => {
  it("窗口内放行 max 次，跨秒重置", () => {
    const limiter = new RateLimiter(2);
    expect(limiter.check("ip", 1000)).toBe(true);
    expect(limiter.check("ip", 1200)).toBe(true);
    expect(limiter.check("ip", 1400)).toBe(false);
    expect(limiter.check("ip", 2000)).toBe(true); // 下一秒
  });

  it("maxPerSec = 0 表示不限频", () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 100; i++) expect(limiter.check("ip", 1000)).toBe(true);
  });
});

describe("loadConfig", () => {
  it("缺省值与类型收敛", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8787);
    expect(cfg.dbPath).toBe("./pageview.db");
    expect(cfg.rateMax).toBe(10);
    expect(cfg.salt).toMatch(/^[0-9a-f]{32}$/); // 自动生成随机盐
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.trustProxy).toBe(false);
  });

  it("环境变量解析：端口 / 白名单 / 令牌 / 限频", () => {
    const cfg = loadConfig({
      PORT: "3000",
      PV_DB_PATH: "/data/pv.db",
      PV_SALT: "fixed-salt",
      PV_ADMIN_TOKEN: "tok",
      ALLOW_ORIGINS: "https://a.example, https://b.example",
      PV_RATE_MAX: "25",
      PV_TRUST_PROXY: "1",
    });
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPath).toBe("/data/pv.db");
    expect(cfg.salt).toBe("fixed-salt");
    expect(cfg.adminToken).toBe("tok");
    expect(cfg.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(cfg.rateMax).toBe(25);
    expect(cfg.trustProxy).toBe(true);
  });

  it("非法端口 / 限频回退默认", () => {
    expect(loadConfig({ PORT: "abc" }).port).toBe(8787);
    expect(loadConfig({ PV_RATE_MAX: "-5" }).rateMax).toBe(0); // floor(-5) → 0 = 不限频
    expect(loadConfig({ PV_RATE_MAX: "x" }).rateMax).toBe(10);
  });
});

describe("Store", () => {
  const mkStore = () => new Store(join(tmpdir(), `pv-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`));

  it("同 path+IP+UA 同小时只计一次，跨小时再计", () => {
    const store = mkStore();
    const hour0 = Date.parse("2026-10-11T08:00:00Z");
    const r1 = store.recordView({ path: "/a", ipHash: "ip", uaHash: "ua", now: hour0 });
    expect(r1).toEqual({ views: 1, counted: true });
    expect(store.recordView({ path: "/a", ipHash: "ip", uaHash: "ua", now: hour0 + 1000 })).toEqual({
      views: 1,
      counted: false,
    });
    // 换 UA 视为独立访客
    expect(store.recordView({ path: "/a", ipHash: "ip", uaHash: "ua2", now: hour0 + 2000 }).views).toBe(2);
    // 下一小时窗口
    expect(store.recordView({ path: "/a", ipHash: "ip", uaHash: "ua", now: hour0 + 3_600_000 }).views).toBe(3);
    store.close();
  });

  it("getViews 批量查询不计数；topPaths 按量排序", () => {
    const store = mkStore();
    store.recordView({ path: "/hot", ipHash: "i", uaHash: "u" });
    store.recordView({ path: "/hot", ipHash: "i2", uaHash: "u" });
    store.recordView({ path: "/cold", ipHash: "i", uaHash: "u" });
    expect(store.getViews(["/hot", "/cold", "/none"])).toEqual({ "/hot": 2, "/cold": 1, "/none": 0 });
    expect(store.topPaths(1)).toEqual([{ path: "/hot", views: 2 }]);
    expect(store.topPaths(10)).toEqual([
      { path: "/hot", views: 2 },
      { path: "/cold", views: 1 },
    ]);
    store.close();
  });

  it("prune 清理上一小时的明细行", () => {
    const store = mkStore();
    const hour0 = Date.parse("2026-10-11T08:00:00Z");
    store.recordView({ path: "/old", ipHash: "i", uaHash: "u", now: hour0 });
    // 超过 PRUNE_INTERVAL_MS 后的下一次写入触发清理
    store.recordView({ path: "/new", ipHash: "i", uaHash: "u", now: hour0 + 3_600_000 + 700_000 });
    expect(store.viewRowCount()).toBe(1);
    store.close();
  });
});

describe("defaultConfig", () => {
  it("覆盖项生效且不污染默认", () => {
    const a = defaultConfig({ rateMax: 3 });
    expect(a.rateMax).toBe(3);
    expect(defaultConfig().rateMax).toBe(10);
    expect(a.dbPath).toBe(":memory:");
  });
});
