# mem9 — Dockerfile para Render (multi-stage)
FROM golang:1.20-alpine AS builder

WORKDIR /build

# Copiar apenas go.mod primeiro (para cache)
COPY server/go.mod ./

# Download e gerar go.sum
RUN go mod download && go mod tidy

# Copiar resto do código
COPY server/ .

# Compilar
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o mnemo-server ./cmd/mnemo-server

# Runtime stage
FROM alpine:latest

WORKDIR /app

# Copiar binário compilado
COPY --from=builder /build/mnemo-server /app/mnemo-server

EXPOSE 8080

ENV MNEMO_PORT=8080

CMD ["/app/mnemo-server"]
