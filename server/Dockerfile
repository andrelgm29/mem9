# Build stage
FROM golang:1.21 AS builder

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o mnemo-server ./cmd/server

# Runtime stage - use golang image itself (has everything needed)
FROM golang:1.21

WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/mnemo-server .

# Expose port
EXPOSE 8080

# Run the server
CMD ["./mnemo-server"]
