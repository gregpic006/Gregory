#!/usr/bin/env bash
# Demarrage de JARVIS en une seule commande (Linux / macOS).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  echo "Environnement absent. Lance d'abord: ./scripts/setup.sh" >&2
  exit 1
fi

# Configuration et interface: refaites avant chaque demarrage, y compris apres
# une mise a jour — une nouvelle version peut ajouter des options a .env.
prepare() {
  ./.venv/bin/python -m jarvis_core.cli setup --quiet || {
    echo "Configuration incomplete (voir ci-dessus). JARVIS ne demarre pas." >&2
    exit 1
  }
  # Recompile l'interface seulement si une source est plus recente que le build.
  if [ ! -f ui/dist/index.html ] || [ -n "$(find ui/src ui/index.html ui/package.json -newer ui/dist/index.html 2>/dev/null | head -1)" ]; then
    echo "-> compilation de l'interface"
    (cd ui && { [ -d node_modules ] || npm install; } && npm run build)
  fi
}
prepare

port=$(grep -E '^JARVIS_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 || true)
echo
echo "JARVIS demarre sur http://127.0.0.1:${port:-8787}"
echo
# Boucle de relance: JARVIS quitte avec le code 42 apres s'etre mis a jour
# depuis son interface. Tout autre code arrete pour de bon.
while true; do
    code=0
    ./.venv/bin/python -m jarvis_core.cli serve || code=$?
    [ "$code" -ne 42 ] && exit "$code"
    echo
    echo "-> mise a jour appliquee, redemarrage"
    echo
    sleep 1
    prepare
done
