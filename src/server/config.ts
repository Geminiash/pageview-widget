import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export interface Config {
  /** 监听端口 */
  port: number;
  /** SQLite 数据库文件路径，":memory:" 表示内存库 */
  dbPath: string;
  /** IP/UA 哈希盐值 */
  salt: string;
  /** /api/stats 管理令牌；空字符串 = 禁用该接口 */
  adminToken: string;
  /** 允许跨域的来源白名单（同源请求始终放行） */
  allowedOrigins: string[];
  /** 由后端托管的 widget 文件路径（dist/widget.js）；空 = 不托管 */
  widgetPath: string;
  /** 每秒每 IP 请求上限；0 = 不限频 */
  rateMax: number;
  /** 是否信任反向代理的 X-Forwarded-For */
  trustProxy: boolean;
}

/** 测试/压测用的完整默认配置 */
export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8787,
    dbPath: ":memory:",
    salt: "dev-salt",
    adminToken: "",
    allowedOrigins: [],
    widgetPath: "",
    rateMax: 10,
    trustProxy: false,
    ...overrides,
  };
}

/** 从环境变量加载配置 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let salt = env.PV_SALT || "";
  if (!salt) {
    salt = randomBytes(16).toString("hex");
    console.warn(
      "[pageview-widget] PV_SALT 未设置：已生成随机盐（重启后 IP 哈希变化，去重窗口将失效）。请在环境变量或 .env 中固定 PV_SALT。",
    );
  }

  let rateMax = 10;
  if (env.PV_RATE_MAX !== undefined && env.PV_RATE_MAX !== "") {
    const n = Number(env.PV_RATE_MAX);
    rateMax = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 10;
  }

  const port = Number(env.PORT ?? "");
  return {
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 8787,
    dbPath: env.PV_DB_PATH || "./pageview.db",
    salt,
    adminToken: env.PV_ADMIN_TOKEN || "",
    allowedOrigins: (env.ALLOW_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    widgetPath: resolve(env.PV_WIDGET_PATH || "dist/widget.js"),
    rateMax,
    trustProxy: env.PV_TRUST_PROXY === "1" || env.PV_TRUST_PROXY === "true",
  };
}
