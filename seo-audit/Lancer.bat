@echo off
chcp 65001 >nul
title Objectif Top 3 - serveur local
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [X] Node.js n'est pas installe sur cette machine.
  echo.
  echo     Telecharge-le sur https://nodejs.org/fr (version LTS),
  echo     installe-le, puis relance ce fichier en double-cliquant dessus.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   OBJECTIF TOP 3 - votre place sur le podium
echo ============================================
echo.
echo Demarrage du serveur local...
echo.
echo Le navigateur va s'ouvrir dans 3 secondes sur :
echo   http://localhost:8787/mini/categories.html
echo.
echo IMPORTANT : NE FERME PAS cette fenetre, c'est elle qui fait
echo tourner le serveur. Pour arreter l'outil, ferme cette fenetre.
echo.
echo --------------------------------------------
echo.

start "" cmd /c "ping -n 4 127.0.0.1 >nul && start """" http://localhost:8787/mini/categories.html"
node server.mjs

echo.
echo --------------------------------------------
echo Le serveur s'est arrete.
pause
