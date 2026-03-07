#!/usr/bin/env bash
# Bootstrap: install Python3 + pip, then hand off to the real setup script.
set -euo pipefail

echo "══════════════════════════════════════════════"
echo "  Shado Cloud — Master Setup (bootstrap)"
echo "══════════════════════════════════════════════"

sudo apt update
sudo apt install -y python3 python3-pip python3-venv curl

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$SCRIPT_DIR/master-setup.py" "$@"
