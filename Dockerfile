# pageview-widget — node:24-alpine 多阶段构建
# 构建阶段需要 devDependencies（typescript/esbuild），运行阶段零依赖
FROM node:24-alpine AS build

RUN npm config set registry https://registry.npmmirror.com \
  && npm install -g pnpm@11

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src

RUN pnpm build

FROM node:24-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist

ENV HOST=0.0.0.0 \
    PORT=8787 \
    PV_DB_PATH=/app/data/pageview.db

VOLUME ["/app/data"]
EXPOSE 8787

CMD ["node", "dist/server/index.js"]
