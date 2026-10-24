# One image: Next.js (static export) + Rust API serving it. Build:  docker compose build api
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
ENV NEXT_EXPORT=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM rust:1-bookworm AS api
WORKDIR /src
COPY backend/ ./
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=api /src/target/release/airsafe-api /usr/local/bin/airsafe-api
COPY --from=web /web/out /app/public
ENV STATIC_DIR=/app/public PORT=8000
EXPOSE 8000
CMD ["airsafe-api"]
