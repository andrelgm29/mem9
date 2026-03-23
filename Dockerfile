# Build and run in one stage
FROM golang:1.21

WORKDIR /app

# Copy everything
COPY . .

# Build
RUN cd server && go build -o mnemo-server ./cmd/server

# Expose port
EXPOSE 8080

# Run
CMD ["./server/mnemo-server"]
