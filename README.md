# pageview-widget

极轻的自托管页面阅读量统计：**<2KB 嵌入脚本 + 零依赖 Node 后端**（`node:http` + `node:sqlite`）。

只为「这篇被看过几次」一件事而生——不要账号体系、不要 Cookie、不要第三方统计脚本。

```text
POST /api/count   本地压测 1563 req/s（并发 50，0 错误）
widget.js         1705 字节（未压缩，构建脚本硬性断言 < 2KB）
依赖              运行时 0 个 npm 包
```

## 特性

- **隐私克制**：不存原始 IP / User-Agent，只落 sha256 加盐哈希前 16 位；无 Cookie、无指纹
- **按访客去重**：同 path + IP 哈希 + UA 哈希 + 小时窗只计一次
- **物化计数**：`path_counts` 表读写 O(1)，明细表只服务去重并按小时惰性清理
- **CORS 白名单**：仅放行 `ALLOW_ORIGINS` 与同源；批量查询不计数
- **限频**：每 IP 每秒 N 次（固定 1 秒窗口），超限 429 + Retry-After
- **SPA 友好**：hook `pushState`/`replaceState`/`popstate`，路由切换自动重新计数
- **管理接口**：`/api/stats?token=` 查 Top 路径；不配 token 则完全禁用

## 快速开始

```bash
pnpm install
pnpm build        # 产出 dist/server/ 与 dist/widget.js（<2KB 断言）
cp .env.example .env   # 必改 PV_SALT！
pnpm start        # 默认 http://localhost:8787
```

## 嵌入

在页面里引入（`data-pv-api` 指向你的服务地址）：

```html
<script src="https://stats.example.com/widget.js" data-pv-api="https://stats.example.com"></script>
```

需要展示阅读量的位置放任意元素：

```html
<!-- 当前页面：自动取 location.pathname -->
本文被阅读 <span class="pageview-count">…</span> 次

<!-- 指定路径：列表页批量展示多篇文章 -->
<a href="/posts/a">文章 A</a>（<span class="pageview-count" data-pv-path="/posts/a">…</span>）

<!-- 只查询不计数（归档页等） -->
<script src="https://stats.example.com/widget.js" data-pv-api="…" data-pv-once></script>
```

## API

| 端点 | 说明 |
|---|---|
| `POST /api/count` | body `{"path":"/foo"}`，返回 `{views}`；按访客去重 |
| `GET /api/count?paths=/a,/b` | 批量查询，不计数；整段可 `encodeURIComponent` |
| `GET /api/stats?token=&limit=` | Top 路径（需 `PV_ADMIN_TOKEN`；未配置则接口禁用） |
| `GET /widget.js` `/widget.esm.js` | 后端直接托管嵌入脚本（mtime 缓存，max-age 300） |

## 配置

全部经环境变量（见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `PV_SALT` | **必填**，哈希盐值；固定不变才能保证重启后去重窗口有效 |
| `PV_DB_PATH` | SQLite 路径（Docker 内挂载 `./data`） |
| `PV_ADMIN_TOKEN` | `/api/stats` 令牌，留空禁用 |
| `ALLOW_ORIGINS` | 跨域白名单（逗号分隔）；同源自动放行 |
| `PV_RATE_MAX` | 每 IP 每秒上限，默认 10；0 = 不限频 |
| `PV_TRUST_PROXY` | 反代后设为 1，读 `X-Forwarded-For` |
| `PV_WIDGET_PATH` | 托管的 widget 文件路径，默认 `dist/widget.js` |

## 部署

Nginx 反代示例（静态站与统计同域，天然同源）：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $remote_addr;
}
location = /widget.js {
    proxy_pass http://127.0.0.1:8787/widget.js;
}
```

也可 `docker compose up -d`（仓库自带 Dockerfile 与 compose 文件，数据卷挂载 `./data`）。

## 本地开发

```bash
pnpm test          # vitest：单元（哈希/限频/配置/存储）+ HTTP 集成共 23 例
pnpm bench         # 本地压测：POST 计数 QPS + 批量查询延迟
pnpm typecheck
```

## 设计说明

- **为什么不用 Umami/Plausible？** 它们是完整分析平台；若你只要一个阅读量数字，2KB 脚本 + 单二进制依赖面（Node 自带 sqlite）更省心。
- **去重窗口**：小时级固定窗（`floor(now/3600000)`），跨小时同一访客再计一次——「每小时一次」的语义对阅读量足够。
- **清理策略**：明细行只在写入路径上惰性清理（每 10 分钟至多一次），无后台定时器。

## License

[MIT](LICENSE)
