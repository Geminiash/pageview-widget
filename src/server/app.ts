import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "./db.js";
import { hashIp, hashUa } from "./hash.js";
import { RateLimiter } from "./rate-limit.js";
import type { Config } from "./config.js";

const MAX_BODY_BYTES = 4096;
const MAX_PATHS = 50;
const MAX_PATH_LEN = 512;

export interface AppHandle {
  server: Server;
  store: Store;
  config: Config;
  close: () => void;
}

/**
 * 创建 HTTP 应用（不监听端口，测试可直接 listen(0)）。
 * 路由：
 *   POST /api/count          计数（beacon / JSON body {path}），按 path+IP哈希+UA哈希+小时窗去重
 *   GET  /api/count?paths=a,b 批量查询，不计数
 *   GET  /api/stats?token=   Top 路径（需要 PV_ADMIN_TOKEN）
 *   GET  /widget.js           由后端直接托管的嵌入脚本
 */
export function createApp(config: Config): AppHandle {
  const store = new Store(config.dbPath);
  const limiter = new RateLimiter(config.rateMax);
  const widgetDir = config.widgetPath ? dirname(config.widgetPath) : "";
  const widgetCache = new Map<string, { mtime: number; buf: Buffer }>();

  const json = (res: ServerResponse, status: number, data: unknown): void => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  const corsAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // 非浏览器 / 同源 fetch（无 Origin 头）
    if (config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host; // 同源自动放行
    } catch {
      return false;
    }
  };

  /** 返回 false 表示来源被拒绝（CORS 仅放行 ALLOW_ORIGINS / 同源） */
  const applyCors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (!corsAllowed(req)) return false;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    return true;
  };

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  /** 路径校验与规整：截掉 ?/#，必须以 / 开头，无空白/控制字符 */
  const normalizePath = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const p = value.split(/[?#]/)[0]!;
    if (!p.startsWith("/") || p.length > MAX_PATH_LEN || /[\s\u0000-\u001f]/.test(p)) return null;
    return p;
  };

  /** 从原始 query 中解析 paths：整段解码后按逗号分割（与 widget.js 的 encodeURIComponent 列表约定一致） */
  const rawPaths = (search: string): string[] => {
    const m = /(?:^|[?&])paths=([^&]*)/.exec(search);
    if (m === null) return [];
    let decoded: string;
    try {
      decoded = decodeURIComponent(m[1] ?? "");
    } catch {
      return []; // 非法转义序列直接视为空列表，而不是 500
    }
    return decoded
      .split(",")
      .filter(Boolean)
      .slice(0, MAX_PATHS);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
    new Promise((resolveBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // 停止消费但不断开：让 413 响应能送达客户端
          req.pause();
          resolveBody(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolveBody(Buffer.concat(chunks)));
      req.on("error", () => resolveBody(null));
    });

  const serveWidget = (res: ServerResponse, name: string): void => {
    if (!widgetDir) return json(res, 404, { error: "widget not built" });
    try {
      const file = join(widgetDir, name);
      const st = statSync(file);
      const cached = widgetCache.get(name);
      const entry =
        cached && cached.mtime === st.mtimeMs ? cached : { mtime: st.mtimeMs, buf: readFileSync(file) };
      widgetCache.set(name, entry);
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Content-Length": entry.buf.length,
      });
      res.end(entry.buf);
    } catch {
      json(res, 404, { error: "widget not found" });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://internal");
    const { pathname, search, searchParams } = url;

    // CORS 预检
    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      if (!applyCors(req, res)) return json(res, 403, { error: "origin not allowed" });
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (pathname === "/api/count") {
      if (!applyCors(req, res)) return json(res, 403, { error: "origin not allowed" });

      if (req.method === "POST") {
        if (!limiter.check(hashIp(clientIp(req), config.salt))) {
          res.setHeader("Retry-After", "1");
          return json(res, 429, { error: "rate limited" });
        }
        const body = await readBody(req);
        if (body === null) return json(res, 413, { error: "body too large" });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "invalid json" });
        }
        const path = normalizePath((parsed as { path?: unknown }).path);
        if (path === null) return json(res, 400, { error: "invalid path" });
        const ipHash = hashIp(clientIp(req), config.salt);
        const uaHash = hashUa(req.headers["user-agent"] ?? "", config.salt);
        const { views } = store.recordView({ path, ipHash, uaHash });
        return json(res, 200, { views });
      }

      if (req.method === "GET") {
        const paths = rawPaths(search)
          .map(normalizePath)
          .filter((p): p is string => p !== null);
        return json(res, 200, { views: store.getViews(paths) });
      }

      return json(res, 405, { error: "method not allowed" });
    }

    if (pathname === "/api/stats") {
      if (!applyCors(req, res)) return json(res, 403, { error: "origin not allowed" });
      if (!config.adminToken) return json(res, 403, { error: "stats disabled: PV_ADMIN_TOKEN not set" });
      if (searchParams.get("token") !== config.adminToken) return json(res, 403, { error: "invalid token" });
      const limitRaw = Number(searchParams.get("limit") ?? "");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
      return json(res, 200, { top: store.topPaths(limit) });
    }

    if (req.method === "GET" && (pathname === "/widget.js" || pathname === "/widget.esm.js")) {
      return serveWidget(res, pathname.slice(1));
    }

    return json(res, 404, { error: "not found" });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  return {
    server,
    store,
    config,
    close: () => {
      server.close();
      store.close();
    },
  };
}
