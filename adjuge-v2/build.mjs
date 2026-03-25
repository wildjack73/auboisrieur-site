#!/usr/bin/env node
/**
 * Adjugé v2 — Site Builder (runs on VPS)
 * Reads SQLite → generates static HTML pages for unsold lots only
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "adjuge.db");
const SITE_DIR = path.join(__dirname, "..", "site");
const SITE_URL = process.env.SITE_URL || "https://auboisrieur.fr";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatPrice(n) {
  return Number(n || 0).toLocaleString("fr-FR");
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dateFr(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", {
      day: "numeric", month: "long", year: "numeric"
    });
  } catch { return iso; }
}

function todayFr() {
  return new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

// ─── HTML Components ────────────────────────────────────────────────────────
function htmlHead(title, desc, extra = "", canonical = "") {
  return `<!DOCTYPE html>
<html lang="fr" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${SITE_URL}${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:type" content="website">
  ${extra}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={darkMode:'class',theme:{extend:{fontFamily:{sans:['Inter','system-ui','sans-serif']}}}}</script>
  <style>
    body { font-family: 'Inter', system-ui, sans-serif; background: #0a0a0f; color: #e2e2e8; }
    a { color: #818cf8; }
    .card { background: #16161f; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0,0,0,0.3); }
    .deal-0 { border-left: 3px solid #6b7280; }
    .deal-1 { border-left: 3px solid #22c55e; }
    .deal-2 { border-left: 3px solid #3b82f6; }
    .deal-3 { border-left: 3px solid #f59e0b; }
  </style>
</head>`;
}

function navHtml() {
  return `<nav class="sticky top-0 z-50 backdrop-blur-xl bg-[#0a0a0f]/90 border-b border-white/5">
  <div class="max-w-7xl mx-auto px-4 md:px-6 flex items-center justify-between h-16">
    <a href="/" class="flex items-center gap-2.5 no-underline group">
      <span class="text-2xl">🔨</span>
      <span class="text-xl font-extrabold tracking-tight text-white">Adjugé<span class="text-indigo-400">.</span></span>
    </a>
    <div class="hidden md:flex items-center gap-1 text-sm">
      <a href="/" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/5 transition no-underline font-medium">Invendus</a>
      <a href="/categories.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/5 transition no-underline font-medium">Catégories</a>
      <a href="/villes.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/5 transition no-underline font-medium">Villes</a>
      <a href="/bonnes-affaires.html" class="px-4 py-2 rounded-lg text-amber-400 hover:text-amber-300 hover:bg-amber-400/10 transition no-underline font-semibold">🔥 Bonnes affaires</a>
    </div>
    <div class="flex items-center gap-2">
      <input type="text" id="searchInput" placeholder="Rechercher..." autocomplete="off"
        class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm w-40 md:w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 placeholder-gray-500 text-white transition-all focus:w-48 md:focus:w-72">
    </div>
  </div>
</nav>`;
}

function footerHtml() {
  return `<footer class="border-t border-white/5 mt-16 py-8 text-center text-sm text-gray-500">
  <div class="max-w-7xl mx-auto px-4">
    <p>Adjugé. — Bonnes affaires aux enchères · Mis à jour le ${todayFr()}</p>
    <div class="mt-2 flex justify-center gap-4">
      <a href="/mentions-legales.html" class="hover:text-gray-300 transition no-underline">Mentions légales</a>
      <a href="/a-propos.html" class="hover:text-gray-300 transition no-underline">À propos</a>
    </div>
  </div>
</footer>`;
}

// ─── Lot card component ─────────────────────────────────────────────────────
function lotCard(lot) {
  const dealBadge = lot.ai_deal_score >= 2
    ? `<span class="absolute top-2 right-2 px-2 py-0.5 rounded text-xs font-bold ${lot.ai_deal_score === 3 ? 'bg-amber-500 text-black' : 'bg-blue-500 text-white'}">${lot.ai_deal_score === 3 ? '🔥 Top affaire' : '⭐ Super affaire'}</span>`
    : lot.ai_deal_score === 1
    ? `<span class="absolute top-2 right-2 px-2 py-0.5 rounded text-xs font-semibold bg-green-500/20 text-green-400">Bonne affaire</span>`
    : '';

  const est = lot.estimate_low && lot.estimate_high
    ? `<div class="text-indigo-400 font-semibold text-sm">Est. ${formatPrice(lot.estimate_low)} – ${formatPrice(lot.estimate_high)} €</div>`
    : lot.starting_price
    ? `<div class="text-gray-400 text-sm">Mise à prix : ${formatPrice(lot.starting_price)} €</div>`
    : '';

  return `<a href="/lot/${esc(lot.slug)}.html" class="card block no-underline group relative">
    ${lot.thumb
      ? `<div class="aspect-[4/3] overflow-hidden bg-gray-900"><img src="${esc(lot.thumb)}" alt="${esc(lot.clean_title)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"></div>`
      : `<div class="aspect-[4/3] bg-gray-800 flex items-center justify-center text-4xl text-gray-600">📷</div>`}
    ${dealBadge}
    <div class="p-4">
      <h3 class="text-sm font-semibold text-white leading-snug line-clamp-2 mb-2">${esc(lot.clean_title)}</h3>
      ${est}
      <div class="flex items-center justify-between mt-2 text-xs text-gray-500">
        <span>${esc(lot.category || '')}</span>
        <span>📍 ${esc(lot.city || '')}</span>
      </div>
    </div>
  </a>`;
}

// ─── Page builders ──────────────────────────────────────────────────────────
function buildHomePage(db) {
  const unsold = db.prepare(`
    SELECT * FROM lots WHERE sold = 0
    ORDER BY sale_date DESC, estimate_high DESC
    LIMIT 60
  `).all();

  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) as unsold_count,
      COUNT(DISTINCT city) as city_count,
      COUNT(DISTINCT category) as cat_count
    FROM lots
  `).get();

  const topDeals = db.prepare(`
    SELECT * FROM lots WHERE sold = 0 AND ai_deal_score >= 2
    ORDER BY ai_deal_score DESC, estimate_high DESC LIMIT 6
  `).all();

  const cats = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM lots WHERE sold = 0 AND category != ''
    GROUP BY category ORDER BY cnt DESC LIMIT 15
  `).all();

  const cities = db.prepare(`
    SELECT city, COUNT(*) as cnt FROM lots WHERE sold = 0 AND city != ''
    GROUP BY city ORDER BY cnt DESC LIMIT 10
  `).all();

  return `${htmlHead(
    "Adjugé — Bonnes affaires aux enchères invendues",
    `${formatPrice(stats.unsold_count)} lots invendus aux enchères en France. Trouvez des bonnes affaires près de chez vous.`,
    "", "/"
  )}
<body class="min-h-screen">
  ${navHtml()}

  <!-- Hero -->
  <div class="relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-indigo-900/20 via-transparent to-amber-900/10"></div>
    <div class="max-w-7xl mx-auto px-4 md:px-6 py-16 md:py-24 relative">
      <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm mb-6">
        <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
        Mis à jour le ${todayFr()}
      </div>
      <h1 class="text-4xl md:text-5xl font-extrabold text-white leading-tight mb-4">
        Trouvez des <span class="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-amber-400">bonnes affaires</span><br>aux enchères
      </h1>
      <p class="text-lg text-gray-400 max-w-2xl mb-8">
        <strong class="text-white">${formatPrice(stats.unsold_count)}</strong> lots invendus dans
        <strong class="text-white">${stats.cat_count}</strong> catégories et
        <strong class="text-white">${stats.city_count}</strong> villes en France.
        Des objets qui n'ont pas trouvé preneur — votre opportunité.
      </p>
      <div class="flex flex-wrap gap-3">
        <a href="#lots" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition no-underline">Explorer les invendus →</a>
        <a href="/bonnes-affaires.html" class="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl font-semibold transition no-underline">🔥 Meilleures affaires</a>
      </div>
    </div>
  </div>

  <!-- Stats bar -->
  <div class="border-y border-white/5 bg-white/[0.02]">
    <div class="max-w-7xl mx-auto px-4 md:px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6">
      <div><div class="text-2xl font-bold text-white">${formatPrice(stats.unsold_count)}</div><div class="text-sm text-gray-500">Lots invendus</div></div>
      <div><div class="text-2xl font-bold text-white">${stats.cat_count}</div><div class="text-sm text-gray-500">Catégories</div></div>
      <div><div class="text-2xl font-bold text-white">${stats.city_count}</div><div class="text-sm text-gray-500">Villes</div></div>
      <div><div class="text-2xl font-bold text-amber-400">${topDeals.length}+</div><div class="text-sm text-gray-500">Bonnes affaires identifiées</div></div>
    </div>
  </div>

  <div class="max-w-7xl mx-auto px-4 md:px-6">

    ${topDeals.length > 0 ? `
    <!-- Top deals -->
    <section class="py-12">
      <h2 class="text-xl font-bold text-white mb-6">🔥 Meilleures affaires du moment</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        ${topDeals.map(lot => lotCard(lot)).join("")}
      </div>
    </section>
    ` : ''}

    <!-- All unsold lots -->
    <section id="lots" class="py-12">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-xl font-bold text-white">Derniers invendus</h2>
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-3 mb-6">
        <select id="fCat" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-gray-300 outline-none">
          <option value="">Toutes catégories (${formatPrice(stats.unsold_count)})</option>
          ${cats.map(c => `<option value="${esc(c.category)}">${esc(c.category)} (${c.cnt})</option>`).join("")}
        </select>
        <select id="fCity" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-gray-300 outline-none">
          <option value="">Toutes villes</option>
          ${cities.map(c => `<option value="${esc(c.city)}">${esc(c.city)} (${c.cnt})</option>`).join("")}
        </select>
        <select id="fSort" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-gray-300 outline-none">
          <option value="recent">Plus récents</option>
          <option value="price_desc">Estimation décroissante</option>
          <option value="price_asc">Estimation croissante</option>
          <option value="deal">Meilleures affaires</option>
        </select>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4" id="lotGrid">
        ${unsold.map(lot => lotCard(lot)).join("")}
      </div>
    </section>

    <!-- Categories sidebar -->
    <section class="py-12 border-t border-white/5">
      <h2 class="text-xl font-bold text-white mb-6">Catégories</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        ${cats.map(c => `
          <a href="/categorie/${esc(c.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''))}.html"
            class="flex items-center justify-between px-4 py-3 rounded-lg bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition no-underline">
            <span class="text-sm text-gray-300">${esc(c.category)}</span>
            <span class="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded-full">${c.cnt}</span>
          </a>
        `).join("")}
      </div>
    </section>
  </div>

  ${footerHtml()}
</body></html>`;
}

function buildLotPage(lot) {
  const photos = JSON.parse(lot.photos || "[]");
  const title = lot.ai_title || lot.clean_title;
  const desc = lot.ai_desc || buildFallbackDesc(lot);
  const priceWithFees = lot.price && lot.commission_rate
    ? Math.round(lot.price * (1 + lot.commission_rate / 100)) : null;

  const DEAL_LABELS = ["Sans intérêt", "Bonne affaire", "Super affaire", "Affaire exceptionnelle"];
  const DEAL_COLORS = ["gray", "green", "blue", "amber"];
  const ds = lot.ai_deal_score >= 0 ? lot.ai_deal_score : heuristicDealScore(lot);

  return `${htmlHead(
    `${title} — Invendu aux enchères`,
    `${title} — Invendu. ${lot.estimate_low ? `Estimation ${formatPrice(lot.estimate_low)}-${formatPrice(lot.estimate_high)}€.` : ''} Contactez la maison de vente.`,
    photos[0] ? `<meta property="og:image" content="${photos[0]}">` : '',
    `/lot/${lot.slug}.html`
  )}
<body class="min-h-screen">
  ${navHtml()}

  <div class="max-w-5xl mx-auto px-4 md:px-6 py-8">
    <nav class="text-sm text-gray-500 mb-6">
      <a href="/" class="hover:text-white transition no-underline">Invendus</a> ›
      ${lot.category ? `<a href="/categorie/${esc(lot.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''))}.html" class="hover:text-white transition no-underline">${esc(lot.category)}</a> › ` : ''}
      <span class="text-gray-400">${esc(title)}</span>
    </nav>

    <div class="grid md:grid-cols-2 gap-8">
      <!-- Photos -->
      <div>
        ${photos.length > 0 ? `
        <div class="rounded-xl overflow-hidden bg-gray-900 mb-3">
          <img id="mainImg" src="${esc(photos[0])}" alt="${esc(title)}" class="w-full max-h-[500px] object-contain">
        </div>
        ${photos.length > 1 ? `
        <div class="flex gap-2 overflow-x-auto pb-2">
          ${photos.map((p, i) => `<img src="${esc(p)}" data-lg="${esc(p)}" alt="" class="w-16 h-16 object-cover rounded-lg cursor-pointer border-2 ${i === 0 ? 'border-indigo-500' : 'border-transparent'} hover:border-indigo-400 transition" onclick="document.getElementById('mainImg').src=this.dataset.lg;this.parentNode.querySelectorAll('img').forEach(x=>{x.classList.remove('border-indigo-500');x.classList.add('border-transparent')});this.classList.remove('border-transparent');this.classList.add('border-indigo-500');">`).join("")}
        </div>` : ''}
        ` : `<div class="rounded-xl bg-gray-800 h-64 flex items-center justify-center text-6xl text-gray-600">📷</div>`}
      </div>

      <!-- Info -->
      <div>
        <span class="inline-block px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 text-sm font-semibold mb-4">Invendu</span>
        <h1 class="text-2xl font-bold text-white mb-4 leading-snug">${esc(title)}</h1>

        ${lot.estimate_low ? `
        <div class="flex items-baseline gap-2 mb-4">
          <span class="text-2xl font-bold text-indigo-400">${formatPrice(lot.estimate_low)} – ${formatPrice(lot.estimate_high)} €</span>
          <span class="text-sm text-gray-500">estimation</span>
        </div>` : ''}

        ${lot.starting_price ? `
        <div class="text-sm text-gray-400 mb-4">Mise à prix : <strong class="text-white">${formatPrice(lot.starting_price)} €</strong></div>` : ''}

        <div class="prose prose-invert text-gray-300 text-sm leading-relaxed mb-6">
          <p>${esc(desc)}</p>
        </div>

        <!-- Deal score -->
        <div class="card deal-${ds} p-4 mb-6">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-lg">${["⚪","🟢","🔵","🔥"][ds]}</span>
            <span class="font-semibold text-white">${DEAL_LABELS[ds]}</span>
            ${ds >= 2 ? `<span class="px-2 py-0.5 rounded text-xs font-bold ${ds === 3 ? 'bg-amber-500 text-black' : 'bg-blue-500 text-white'}">${ds === 3 ? 'TOP AFFAIRE' : 'RECOMMANDÉ'}</span>` : ''}
          </div>
          <p class="text-sm text-gray-400">${esc(lot.ai_deal_analysis || buildDealExplanation(lot, ds))}</p>
        </div>

        <!-- Contact -->
        ${lot.org_name ? `
        <div class="card p-4 mb-6">
          <h3 class="font-semibold text-white text-sm mb-3">📞 Contacter la maison de vente</h3>
          <div class="text-sm text-gray-400 space-y-1">
            <div class="font-medium text-white">${esc(lot.org_name)}</div>
            ${lot.org_address ? `<div>📍 ${esc(lot.org_address)}</div>` : ''}
            ${lot.org_phone ? `<div>📞 <a href="tel:${esc(lot.org_phone)}" class="text-indigo-400">${esc(lot.org_phone)}</a></div>` : ''}
            ${lot.org_email ? `<div>✉️ <a href="mailto:${esc(lot.org_email)}" class="text-indigo-400">${esc(lot.org_email)}</a></div>` : ''}
          </div>
        </div>` : ''}

        <!-- Meta -->
        <div class="text-xs text-gray-500 space-y-1">
          ${lot.category ? `<div>Catégorie : ${esc(lot.category)}</div>` : ''}
          ${lot.sale_date ? `<div>Date de vente : ${dateFr(lot.sale_date)}</div>` : ''}
          ${lot.city ? `<div>Ville : ${esc(lot.city)}</div>` : ''}
        </div>
      </div>
    </div>
  </div>

  ${footerHtml()}
</body></html>`;
}

function buildFallbackDesc(lot) {
  const parts = [];
  const desc = (lot.description || "").split("\n").slice(1).join(" ").trim();
  if (desc.length > 20) parts.push(desc.substring(0, 500));
  if (lot.category && lot.category !== "Autre") parts.push(`Ce lot appartient à la catégorie ${lot.category}.`);
  if (lot.estimate_low) parts.push(`Son estimation se situe entre ${formatPrice(lot.estimate_low)} et ${formatPrice(lot.estimate_high)} €.`);
  if (lot.starting_price) parts.push(`La mise à prix était de ${formatPrice(lot.starting_price)} €.`);
  if (lot.org_name) parts.push(`Présenté par ${lot.org_name}${lot.city ? ` à ${lot.city}` : ''}.`);
  const photos = JSON.parse(lot.photos || "[]");
  if (photos.length > 1) parts.push(`${photos.length} photos disponibles.`);
  return parts.join(" ") || "Contactez la maison de vente pour plus d'informations.";
}

function heuristicDealScore(lot) {
  if (lot.starting_price && lot.estimate_low && lot.starting_price < lot.estimate_low * 0.5) return 1;
  return 0;
}

function buildDealExplanation(lot, ds) {
  const parts = [];
  if (lot.estimate_low) parts.push(`estimation de ${formatPrice(lot.estimate_low)} à ${formatPrice(lot.estimate_high)} €`);
  if (lot.starting_price && lot.estimate_low && lot.starting_price < lot.estimate_low * 0.5)
    parts.push(`mise à prix (${formatPrice(lot.starting_price)} €) nettement inférieure à l'estimation`);
  if (ds === 0) return "Ce lot n'a pas de caractéristiques particulières qui en font une bonne affaire.";
  return parts.length ? `Score basé sur : ${parts.join(", ")}.` : "";
}

// ─── Main build ─────────────────────────────────────────────────────────────
function build() {
  console.log("\n🏗️  Adjugé v2 — Build\n");

  const db = new Database(DB_PATH, { readonly: true });
  ensureDir(SITE_DIR);
  ensureDir(path.join(SITE_DIR, "lot"));

  // Homepage
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), buildHomePage(db));
  console.log("  ✅ index.html");

  // Individual lot pages (unsold only)
  const unsold = db.prepare("SELECT * FROM lots WHERE sold = 0").all();
  let count = 0;
  for (const lot of unsold) {
    const filePath = path.join(SITE_DIR, "lot", `${lot.slug}.html`);
    fs.writeFileSync(filePath, buildLotPage(lot));
    count++;
  }
  console.log(`  ✅ ${count} pages lot invendus`);

  // Category pages
  const cats = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM lots WHERE sold = 0 AND category != ''
    GROUP BY category ORDER BY cnt DESC
  `).all();
  ensureDir(path.join(SITE_DIR, "categorie"));
  for (const cat of cats) {
    const slug = cat.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const lots = db.prepare("SELECT * FROM lots WHERE sold = 0 AND category = ? ORDER BY sale_date DESC LIMIT 100").all(cat.category);
    const html = `${htmlHead(`${cat.category} — Invendus | Adjugé`, `${cat.cnt} lots invendus dans la catégorie ${cat.category}.`, '', `/categorie/${slug}.html`)}
<body class="min-h-screen">
  ${navHtml()}
  <div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
    <nav class="text-sm text-gray-500 mb-6"><a href="/" class="hover:text-white no-underline">Invendus</a> › <span class="text-gray-400">${esc(cat.category)}</span></nav>
    <h1 class="text-2xl font-bold text-white mb-2">${esc(cat.category)}</h1>
    <p class="text-gray-400 mb-8">${cat.cnt} lots invendus</p>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      ${lots.map(lot => lotCard(lot)).join("")}
    </div>
  </div>
  ${footerHtml()}
</body></html>`;
    fs.writeFileSync(path.join(SITE_DIR, "categorie", `${slug}.html`), html);
  }
  console.log(`  ✅ ${cats.length} pages catégorie`);

  // Sitemap
  const allSlugs = db.prepare("SELECT slug FROM lots WHERE sold = 0").all();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  ${cats.map(c => {
    const s = c.category.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    return `<url><loc>${SITE_URL}/categorie/${s}.html</loc><changefreq>daily</changefreq></url>`;
  }).join("\n  ")}
  ${allSlugs.map(l => `<url><loc>${SITE_URL}/lot/${l.slug}.html</loc></url>`).join("\n  ")}
</urlset>`;
  fs.writeFileSync(path.join(SITE_DIR, "sitemap.xml"), sitemap);
  console.log("  ✅ sitemap.xml");

  // robots.txt
  fs.writeFileSync(path.join(SITE_DIR, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) as unsold FROM lots").get();
  console.log(`\n📊 ${stats.unsold} pages invendus, ${cats.length} catégories`);
  console.log("✅ Build terminé\n");

  db.close();
}

build();
