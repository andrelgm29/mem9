# Stage 1: Prepare source
FROM golang:1.21 AS prep

WORKDIR /app

# Copy server directory to root
COPY server/ .

# Stage 2: Build
FROM golang:1.21 AS builder

WORKDIR /app

COPY --from=prep /app .

# Build the binary
RUN go build -o mnemo-server ./cmd/server

# Stage 3: Runtime
FROM golang:1.21

WORKDIR /app

COPY --from=builder /app/mnemo-server .

EXPOSE 8080

CMD ["./mnemo-server"]
