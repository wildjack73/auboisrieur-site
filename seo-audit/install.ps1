# Objectif Top 3 — Installation & lancement en une commande
# Usage : copier-coller cette ligne dans PowerShell :
#   irm https://raw.githubusercontent.com/wildjack73/auboisrieur-site/claude/google-seo-audit-tool-JjUmc/seo-audit/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Section($t) { Write-Host ""; Write-Host "── $t" -ForegroundColor Cyan }
function OK($t)      { Write-Host "  [OK] $t" -ForegroundColor Green }
function Info($t)    { Write-Host "  $t" -ForegroundColor Gray }
function Warn($t)    { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Fail($t)    { Write-Host "  [X] $t" -ForegroundColor Red }

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "   OBJECTIF TOP 3 — votre place sur le podium" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# ── 1. Node.js ────────────────────────────────────────────────
Section "Verification de Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Warn "Node.js n'est pas installe."
  $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
  if ($hasWinget) {
    Info "Tentative d'installation automatique via winget..."
    try {
      winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      $node = Get-Command node -ErrorAction SilentlyContinue
    } catch { }
  }
  if (-not $node) {
    Fail "Installation automatique impossible."
    Info "Telecharge l'installeur LTS sur : https://nodejs.org/fr"
    Info "Lance l'installeur, puis ferme cette fenetre PowerShell et"
    Info "rouvre-en une nouvelle, et recolle la meme commande."
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
  }
}
$nodeVer = (& node --version).Trim()
OK "Node.js detecte : $nodeVer"

# ── 2. Telechargement du projet ───────────────────────────────
Section "Telechargement de l'outil"
$dest = Join-Path $env:USERPROFILE "ObjectifTop3"
$zipUrl = "https://github.com/wildjack73/auboisrieur-site/archive/refs/heads/claude/google-seo-audit-tool-JjUmc.zip"
$zipFile = Join-Path $env:TEMP "ot3-$(Get-Random).zip"
$tmpExtract = Join-Path $env:TEMP "ot3-extract-$(Get-Random)"

Info "Telechargement de $zipUrl"
Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
OK "Telecharge ($([math]::Round((Get-Item $zipFile).Length/1MB, 2)) Mo)"

Info "Decompression..."
New-Item -ItemType Directory -Force -Path $tmpExtract | Out-Null
Expand-Archive -Path $zipFile -DestinationPath $tmpExtract -Force
$root = Get-ChildItem $tmpExtract -Directory | Select-Object -First 1
if (-not $root) { Fail "ZIP vide ou corrompu."; exit 1 }

if (Test-Path $dest) {
  Info "Mise a jour du dossier existant : $dest"
  Remove-Item -Recurse -Force $dest
}
Move-Item -Force $root.FullName $dest
Remove-Item -Force $zipFile
Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue
OK "Projet pret dans : $dest"

# ── 3. Lancement ──────────────────────────────────────────────
Section "Demarrage du serveur"
$seoDir = Join-Path $dest "seo-audit"
if (-not (Test-Path (Join-Path $seoDir "server.mjs"))) {
  Fail "server.mjs introuvable dans $seoDir"
  exit 1
}
Set-Location $seoDir

Info "Le navigateur va s'ouvrir dans 4 secondes sur :"
Write-Host "    http://localhost:8787/mini/categories.html" -ForegroundColor White
Write-Host ""
Warn "Ne ferme PAS cette fenetre — c'est elle qui fait tourner l'outil."
Write-Host ""

Start-Job -ScriptBlock { Start-Sleep 4; Start-Process "http://localhost:8787/mini/categories.html" } | Out-Null

# Affichage en direct du serveur (bloque)
& node server.mjs

Write-Host ""
Warn "Le serveur s'est arrete."
Read-Host "Appuie sur Entree pour fermer"
