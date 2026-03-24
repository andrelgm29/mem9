#!/bin/bash
set -e

# mem9 Build Script para Render
# Compilação de mnemo-server (Go 1.20+)

echo "[BUILD] Iniciando compilação mem9..."

if ! command -v go &> /dev/null; then
  echo "[ERROR] Go não encontrado"
  exit 1
fi

GO_VERSION=$(go version | grep -oE 'go[0-9]+\.[0-9]+' | sed 's/go//')
echo "[BUILD] Go versão: $GO_VERSION"

cd server

echo "[BUILD] Sincronizando dependências..."
go mod download
go mod tidy

echo "[BUILD] Compilando mnemo-server..."
CGO_ENABLED=0 go build \
  -ldflags="-s -w" \
  -o app \
  ./cmd/mnemo-server

if [ ! -f app ]; then
  echo "[ERROR] Compilação falhou"
  exit 1
fi

echo "[BUILD] ✅ Compilação bem-sucedida"
