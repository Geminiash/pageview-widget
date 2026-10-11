import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, () => {
  console.log(`[pageview-widget] listening on http://0.0.0.0:${config.port}`);
  console.log(`[pageview-widget] db=${config.dbPath}`);
  console.log(`[pageview-widget] widget=${config.widgetPath || "(未托管)"}`);
  console.log(
    config.adminToken
      ? "[pageview-widget] /api/stats 已启用（需 token）"
      : "[pageview-widget] /api/stats 未启用（未设置 PV_ADMIN_TOKEN）",
  );
});

const shutdown = (signal: string): void => {
  console.log(`[pageview-widget] ${signal} received, shutting down`);
  app.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
