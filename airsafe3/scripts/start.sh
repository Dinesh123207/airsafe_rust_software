#!/usr/bin/env bash
# Starts the whole AIRSAFE stack with Docker (Linux / macOS):   ./scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "ERROR: Docker is not installed (https://docs.docker.com/get-docker/)."; exit 1; }
docker info >/dev/null 2>&1 || { echo "ERROR: Docker is installed but not running."; exit 1; }

echo "Building and starting AIRSAFE (the first build can take 10-25 minutes)..."
docker compose up -d --build

printf "Waiting for the API"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS http://localhost:8000/api/health 2>/dev/null | grep -q '"ok":true'; then ready=1; break; fi
  printf "."; sleep 2
done
echo
[ "$ready" = 1 ] || { echo "ERROR: the API did not become ready. Run: docker compose logs api db"; exit 1; }

echo
echo "AIRSAFE is running:  http://localhost:8000"
for ip in $(hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true); do echo "  from other devices: http://$ip:8000   (the ESP32 uses this address)"; done
echo
echo "Next: register in the web app, then:"
echo "  node tools/connect_hardware.mjs setup --email you@example.com --password '...' --room iso1 --wifi-ssid 'YOURWIFI' --wifi-pass '...' --sign"
