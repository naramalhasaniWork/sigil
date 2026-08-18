#!/bin/bash
# Double-click this file in Finder to run SIGIL.
# It lives at the repo root so the launcher can find everything relative to it.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org (choose the LTS build), then"
  echo "  double-click this file again."
  echo ""
  read -r -p "  Press Return to close." _
  exit 1
fi

node scripts/desktop.mjs
status=$?

if [ $status -ne 0 ]; then
  echo ""
  read -r -p "  Something went wrong. Press Return to close." _
fi
