# mem9 — Dockerfile FINAL (Claude Code tested + verified)
# Multi-stage: Builder (golang:1.24) → Runtime (alpine:latest)
# Testado e validado 100%

# ====== BUILDER ======
FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY . .

RUN cd server && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o app ./cmd/mnemo-server

# ====== RUNTIME ======
FROM alpine:latest

WORKDIR /app

# Install ca-certificates para HTTPS/TLS
RUN apk add --no-cache ca-certificates

# Copy binário do builder
COPY --from=builder /app/server/app ./app

# Non-root user (security)
RUN addgroup -g 1000 appuser && adduser -u 1000 -G appuser -s /sbin/nologin -D appuser
USER appuser:1000

EXPOSE 8080

ENV MNEMO_PORT=8080

CMD ["./app"]
