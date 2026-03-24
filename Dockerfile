# mem9 — Dockerfile para Render (multi-stage)
FROM golang:1.20-alpine AS builder

WORKDIR /build
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o mnemo-server ./cmd/mnemo-server

# Runtime stage
FROM alpine:latest

WORKDIR /app
COPY --from=builder /build/mnemo-server ./app

EXPOSE 8080

ENV MNEMO_PORT=8080

CMD ["./app"]
