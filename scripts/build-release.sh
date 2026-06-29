#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

echo "Building sendgrid-mcp binaries into $DIST"

cd "$ROOT"

bun build --compile --target=bun-linux-x64 src/index.ts --outfile "$DIST/sendgrid-linux-x64"
bun build --compile --target=bun-linux-arm64 src/index.ts --outfile "$DIST/sendgrid-linux-arm64"
bun build --compile --target=bun-darwin-x64 src/index.ts --outfile "$DIST/sendgrid-darwin-x64"
bun build --compile --target=bun-darwin-arm64 src/index.ts --outfile "$DIST/sendgrid-darwin-arm64"
bun build --compile --target=bun-windows-x64 src/index.ts --outfile "$DIST/sendgrid-windows-x64.exe"

# Default local dev binary (current platform)
bun build --compile src/index.ts --outfile "$ROOT/bin/sendgrid"

chmod +x "$DIST"/sendgrid-* "$ROOT/bin/sendgrid" 2>/dev/null || true

echo "Done:"
ls -lh "$DIST"
