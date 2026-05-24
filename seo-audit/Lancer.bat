@echo off
title Objectif Top 3 - serveur local
cd /d "%~dp0"

echo.
echo ================================================
echo   OBJECTIF TOP 3 - votre place sur le podium
echo ================================================
echo.
echo Dossier de travail : %CD%
echo.

REM Verifie qu'on est dans le bon dossier
if not exist "server.mjs" (
  echo [ERREUR] Le fichier server.mjs est introuvable dans ce dossier.
  echo.
  echo Ce script doit etre dans le dossier "seo-audit" du projet,
  echo a cote de server.mjs, audit.mjs, public/ etc.
  echo.
  echo Tu as probablement telecharge SEULEMENT le .bat au lieu du
  echo projet complet. Telecharge le ZIP complet ici :
  echo.
  echo   https://github.com/wildjack73/auboisrieur-site/archive/refs/heads/claude/google-seo-audit-tool-JjUmc.zip
  echo.
  echo Decompresse-le, va dans le sous-dossier seo-audit, et
  echo double-clique Lancer.bat depuis la.
  echo.
  pause
  exit /b 1
)

REM Verifie que Node.js est installe
where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js n'est pas installe (ou pas dans le PATH).
  echo.
  echo Installe la version LTS depuis :
  echo   https://nodejs.org/fr
  echo.
  echo Choisis l'installeur Windows (.msi), suivant/suivant/suivant.
  echo Ensuite FERME toutes les fenetres PowerShell et relance ce script.
  echo.
  pause
  exit /b 1
)

echo Node.js detecte :
node --version
echo.
echo Demarrage du serveur sur http://localhost:8787
echo Le navigateur va s'ouvrir tout seul dans 4 secondes.
echo.
echo --------------------------------------------------
echo  IMPORTANT : ne ferme PAS cette fenetre.
echo  C'est elle qui fait tourner l'outil.
echo  Pour arreter : ferme cette fenetre ou appuie sur Ctrl+C.
echo --------------------------------------------------
echo.

REM Ouvre le navigateur apres 4 secondes (delai pour laisser le serveur demarrer)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8787/mini/categories.html'"

REM Lance le serveur (bloque tant que le serveur tourne)
node server.mjs

echo.
echo --------------------------------------------------
echo Le serveur s'est arrete (code: %errorlevel%).
echo Si c'etait inattendu, copie ce qui s'est affiche au-dessus
echo et envoie-le pour qu'on diagnostique.
echo --------------------------------------------------
pause
