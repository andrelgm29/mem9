# mem9 — Dockerfile CORRIGIDO (Claude Code debug)
# Multi-stage: Builder (golang) → Runtime (debian slim)

# ====== BUILDER ======
FROM golang:1.21 AS builder

WORKDIR /app
COPY . .

RUN cd server && go build -o app ./cmd/mnemo-server

# ====== RUNTIME ======
FROM debian:bookworm-slim

WORKDIR /app

# Install ca-certificates para HTTPS/TLS
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy binário do builder
COPY --from=builder /app/server/app ./app

EXPOSE 8080

ENV MNEMO_PORT=8080

CMD ["./app"]
