#!/usr/bin/env bash
# Lanceur Mac / Linux pour "Objectif Top 3"
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js n'est pas installé. Télécharge-le sur https://nodejs.org/fr (LTS) puis relance ce fichier."
  echo
  read -n 1 -s -r -p "Appuie sur une touche pour fermer..."
  exit 1
fi

echo
echo "============================================"
echo "  OBJECTIF TOP 3 - votre place sur le podium"
echo "============================================"
echo
echo "Démarrage du serveur local..."
echo "Le navigateur va s'ouvrir sur : http://localhost:8787/mini/categories.html"
echo "Ne ferme pas cette fenêtre — c'est elle qui fait tourner le serveur."
echo

( sleep 3; (open http://localhost:8787/mini/categories.html 2>/dev/null || xdg-open http://localhost:8787/mini/categories.html 2>/dev/null) ) &
exec node server.mjs
