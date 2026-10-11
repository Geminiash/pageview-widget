import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface ViewInput {
  path: string;
  ipHash: string;
  uaHash: string;
  /** 可注入时间（测试用），默认 Date.now() */
  now?: number;
}

export interface ViewResult {
  /** 该 path 当前的累计阅读量 */
  views: number;
  /** 本次是否真正计数（false = 命中去重窗口） */
  counted: boolean;
}

const HOUR_MS = 3_600_000;
const PRUNE_INTERVAL_MS = 600_000;

/**
 * SQLite 存储：
 * - pageviews     明细行，仅用于小时窗去重（只存哈希，不存原始 IP/UA），过期惰性清理
 * - path_counts   物化计数表，读写 O(1)
 * - WAL 模式，启动自动建表
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly selDup: StatementSync;
  private readonly insPv: StatementSync;
  private readonly upCount: StatementSync;
  private readonly selCount: StatementSync;
  private readonly selTop: StatementSync;
  private readonly delOld: StatementSync;
  private readonly countRows: StatementSync;
  private lastPrune = 0;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pageviews (
        path       TEXT    NOT NULL,
        ip_hash    TEXT    NOT NULL,
        ua_hash    TEXT    NOT NULL,
        hour       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pv_dedup ON pageviews (path, ip_hash, ua_hash, hour);
      CREATE TABLE IF NOT EXISTS path_counts (
        path  TEXT PRIMARY KEY,
        views INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.selDup = this.db.prepare(
      "SELECT 1 AS hit FROM pageviews WHERE path = ? AND ip_hash = ? AND ua_hash = ? AND hour = ?",
    );
    this.insPv = this.db.prepare(
      "INSERT INTO pageviews (path, ip_hash, ua_hash, hour, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.upCount = this.db.prepare(
      "INSERT INTO path_counts (path, views) VALUES (?, 1) ON CONFLICT(path) DO UPDATE SET views = views + 1",
    );
    this.selCount = this.db.prepare("SELECT views FROM path_counts WHERE path = ?");
    this.selTop = this.db.prepare(
      "SELECT path, views FROM path_counts ORDER BY views DESC, path ASC LIMIT ?",
    );
    this.delOld = this.db.prepare("DELETE FROM pageviews WHERE hour < ?");
    this.countRows = this.db.prepare("SELECT COUNT(*) AS n FROM pageviews");
  }

  /** 记录一次访问：同 path + IP哈希 + UA哈希 + 小时窗 只计一次 */
  recordView({ path, ipHash, uaHash, now = Date.now() }: ViewInput): ViewResult {
    const hour = Math.floor(now / HOUR_MS);
    this.prune(now, hour);
    const dup = this.selDup.get(path, ipHash, uaHash, hour);
    if (dup !== undefined) {
      return { views: this.countOf(path), counted: false };
    }
    this.insPv.run(path, ipHash, uaHash, hour, now);
    this.upCount.run(path);
    return { views: this.countOf(path), counted: true };
  }

  countOf(path: string): number {
    const row = this.selCount.get(path) as { views: number } | undefined;
    return row ? row.views : 0;
  }

  /** 批量查询（不计数） */
  getViews(paths: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of paths) out[p] = this.countOf(p);
    return out;
  }

  topPaths(limit: number): Array<{ path: string; views: number }> {
    const rows = this.selTop.all(limit) as Array<{ path: string; views: number }>;
    return rows.map((r) => ({ path: r.path, views: r.views }));
  }

  /** pageviews 明细行数（测试用） */
  viewRowCount(): number {
    const row = this.countRows.get() as { n: number };
    return row.n;
  }

  /** 清理上一小时之前的明细行（每 10 分钟最多执行一次） */
  private prune(now: number, currentHour: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    this.delOld.run(currentHour);
  }

  close(): void {
    this.db.close();
  }
}
