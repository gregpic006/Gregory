#!/usr/bin/env bash
# Installation de JARVIS sous Linux / macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== JARVIS : installation =="

[ -d .venv ] || python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -e ".[anthropic,dev]"

if [ ! -f .env ]; then
  cp .env.example .env
  key=$(./.venv/bin/python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
  sed -i.bak "s|^JARVIS_ENCRYPTION_KEY=.*|JARVIS_ENCRYPTION_KEY=${key}|" .env && rm -f .env.bak
  echo "   cle de chiffrement generee. Ajoute maintenant ANTHROPIC_API_KEY dans .env."
fi

(cd ui && npm install)

echo
echo "Termine. Demarrer avec: ./scripts/dev.sh"
