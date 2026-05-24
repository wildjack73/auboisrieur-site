@echo off
title Objectif Top 3 - serveur local
cd /d "%~dp0"

echo.
echo ================================================
echo   OBJECTIF TOP 3 - votre place sur le podium
echo ================================================
echo.

REM ── Verifier Node ──────────────────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js n'est pas installe.
  echo     Installe la version LTS sur https://nodejs.org/fr puis relance.
  echo.
  pause
  exit /b 1
)
echo Node.js detecte :
node --version

REM ── Mise a jour automatique depuis GitHub ──────────────────────────────────
echo.
echo Recherche de mises a jour...
set "ZIP=%TEMP%\ot3-update.zip"
set "EXT=%TEMP%\ot3-update-ext"
if exist "%EXT%" rmdir /s /q "%EXT%"
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest 'https://github.com/wildjack73/auboisrieur-site/archive/refs/heads/claude/google-seo-audit-tool-JjUmc.zip' -OutFile '%ZIP%' -UseBasicParsing -ErrorAction Stop; Expand-Archive '%ZIP%' '%EXT%' -Force; exit 0 } catch { Write-Host '  Pas de connexion ou GitHub indisponible — on lance la version locale.'; exit 1 }"
if not errorlevel 1 (
  set "ROOT=%EXT%\auboisrieur-site-claude-google-seo-audit-tool-JjUmc"
  if exist "%ROOT%\seo-audit\server.mjs" (
    echo Application de la mise a jour...
    REM On copie tout SAUF Lancer.bat (en cours d'execution) — il sera ecrase au prochain lancement via ce script lui-meme si on autorise. On garde la version locale du .bat.
    robocopy "%ROOT%\seo-audit" "%CD%" /E /XF "Lancer.bat" /XO /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
    echo Mise a jour appliquee. Pour mettre a jour Lancer.bat lui-meme, recolle la commande PowerShell d'installation.
  )
)
if exist "%ZIP%" del "%ZIP%"
if exist "%EXT%" rmdir /s /q "%EXT%"

REM ── Lancement ──────────────────────────────────────────────────────────────
echo.
echo Demarrage du serveur sur http://localhost:8787
echo Le navigateur va s'ouvrir dans 4 secondes.
echo.
echo --------------------------------------------------
echo  IMPORTANT : ne ferme PAS cette fenetre.
echo  C'est elle qui fait tourner l'outil.
echo  Pour arreter : ferme cette fenetre.
echo --------------------------------------------------
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:8787/mini/categories.html'"
node server.mjs

echo.
echo Le serveur s'est arrete.
pause
