# mem9 — Dockerfile simples para Render
FROM golang:1.20-alpine AS builder

WORKDIR /app
COPY server/ .

RUN go build -o app ./cmd/mnemo-server

FROM alpine:latest
COPY --from=builder /app/app /app

EXPOSE 8080
CMD ["./app"]
