# Simple one-stage build
FROM golang:1.21

# Set working directory to server folder
WORKDIR /app/server

# Copy entire repo
COPY . /app

# Download dependencies
RUN go mod download

# Build
RUN go build -o mnemo-server ./cmd/server

# Expose port
EXPOSE 8080

# Run binary from current directory
CMD ["./mnemo-server"]
