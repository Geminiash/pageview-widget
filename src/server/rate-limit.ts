/**
 * 固定 1 秒窗口限频器：每 IP 每秒最多 maxPerSec 次。
 * maxPerSec <= 0 表示不限频。
 */
export class RateLimiter {
  private readonly hits = new Map<string, { win: number; n: number }>();

  constructor(private readonly maxPerSec: number) {}

  /** 返回 true = 放行，false = 超限 */
  check(key: string, now: number = Date.now()): boolean {
    if (this.maxPerSec <= 0) return true;
    const win = Math.floor(now / 1000);
    const cur = this.hits.get(key);
    if (cur === undefined || cur.win !== win) {
      if (cur !== undefined || this.hits.size > 50_000) this.sweep(win);
      this.hits.set(key, { win, n: 1 });
      return true;
    }
    if (cur.n >= this.maxPerSec) return false;
    cur.n++;
    return true;
  }

  /** 内存保护：清理过期窗口 */
  private sweep(currentWin: number): void {
    for (const [k, v] of this.hits) {
      if (v.win < currentWin) this.hits.delete(k);
    }
  }
}
