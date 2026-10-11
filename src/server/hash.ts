import { createHash } from "node:crypto";

/**
 * 隐私哈希：sha256(input + salt) 前 16 位十六进制。
 * 只落盘哈希，绝不存原始 IP / User-Agent。
 */
export function shortHash(input: string, salt: string): string {
  return createHash("sha256").update(input + salt).digest("hex").slice(0, 16);
}

export const hashIp = (ip: string, salt: string): string => shortHash(ip, salt);
export const hashUa = (ua: string, salt: string): string => shortHash(ua, salt);
