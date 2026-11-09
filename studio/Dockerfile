# Sử dụng Debian (bookworm-slim) thay vì Alpine để fix dứt điểm lỗi EPERM của Node 22
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Dùng corepack để cài đặt pnpm chuẩn xác và an toàn nhất
RUN corepack enable pnpm && corepack install --global pnpm@9.15.4

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Copy package.jsons cho workspace packages
COPY studio/package.json ./studio/
COPY shared/package.json ./shared/

# Tắt cảnh báo update để tránh lỗi EPERM khi pnpm cố ghi log vào root
RUN pnpm config set update-notifier false
# Cài đặt và lưu store thẳng vào folder working để dễ dàng copy sang stage sau
RUN pnpm install --no-frozen-lockfile --ignore-scripts --store-dir=./.pnpm-store

FROM base AS builder
WORKDIR /app
# BẮT BUỘC: Copy .pnpm-store từ deps sang để không làm gãy các symlink của node_modules
COPY --from=deps /app/.pnpm-store ./.pnpm-store
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/studio/node_modules ./studio/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY . .

# Next.js telemetry disable
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter studio build
# Đảm bảo public directory tồn tại
RUN mkdir -p /app/studio/public

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Lệnh tạo user/group chuẩn trên môi trường Debian
RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/studio/public ./studio/public

# Set permission cho prerender cache
RUN mkdir -p /app/studio/.next
RUN chown nextjs:nodejs /app/studio/.next

# Copy các output file từ NextJS standalone
COPY --from=builder --chown=nextjs:nodejs /app/studio/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/studio/.next/static ./studio/.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "studio/server.js"]