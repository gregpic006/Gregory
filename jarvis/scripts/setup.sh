#!/usr/bin/env bash
# Installation de JARVIS sous Linux / macOS.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== JARVIS : installation =="

if [ ! -d .venv ]; then
  # 3.12 en priorite: faster-whisper n'a pas toujours de roue pour les
  # versions les plus recentes de Python.
  for candidate in python3.12 python3.13 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "-> creation de l'environnement Python ($candidate)"
      "$candidate" -m venv .venv
      break
    fi
  done
fi
[ -d .venv ] || { echo "Python 3.11+ introuvable." >&2; exit 1; }
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
