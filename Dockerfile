# Битрикс24 колл-центр коннектор — прод-образ.
FROM node:20-slim

# pnpm через corepack, версия под lockfile (pnpm-lock v9 / pnpm 10).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Манифесты сначала — кешируем слой установки зависимостей.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Исходники (tsx запускает TypeScript напрямую).
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV QUEUE_DATA_DIR=/data
EXPOSE 3000

# pnpm start → tsx src/index.ts
CMD ["pnpm", "start"]
