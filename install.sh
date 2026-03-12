#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=4242
PROJECT_DIR=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Check Bun
if ! command -v bun &>/dev/null; then
  echo "ERROR: Bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "✓ Bun $(bun --version)"

# Detect project dir
if [[ -z "$PROJECT_DIR" ]]; then
  echo "Usage: ./install.sh --project-dir /path/to/project"
  echo "  The project must contain .flow/ and scripts/ralph/runs/"
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/.flow" ]]; then
  echo "ERROR: $PROJECT_DIR/.flow not found"
  exit 1
fi
echo "✓ Project: $PROJECT_DIR"

# Create wrapper script
WRAPPER_DIR="$HOME/.local/bin"
mkdir -p "$WRAPPER_DIR"
WRAPPER="$WRAPPER_DIR/jena-factory"

cat > "$WRAPPER" <<WRAPPER_EOF
#!/usr/bin/env bash
export PROJECT_DIR="$PROJECT_DIR"
exec bun "$SCRIPT_DIR/server.ts" --port $PORT "\$@"
WRAPPER_EOF

chmod +x "$WRAPPER"
echo "✓ Wrapper: $WRAPPER"

# Check PATH
if [[ ":$PATH:" != *":$WRAPPER_DIR:"* ]]; then
  echo ""
  echo "⚠  Add to PATH: export PATH=\"$WRAPPER_DIR:\$PATH\""
  echo "   Add this to ~/.bashrc or ~/.zshrc"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  JenaAI-Factory installed!           ║"
echo "║  Run: jena-factory                   ║"
echo "║  Open: http://localhost:$PORT          ║"
echo "╚══════════════════════════════════════╝"
