#!/bin/bash
set -e

echo "Building mem9..."
cd server
go build -o app ./cmd/mnemo-server
echo "Build complete!"
