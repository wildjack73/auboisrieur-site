#!/usr/bin/env node
/**
 * Adjugé v2 — Site Builder (runs on VPS)
 * Pro design, AdSense-ready, rich content pages
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "adjuge.db");
const SITE_DIR = path.join(__dirname, "..", "site");
const SITE_URL = process.env.SITE_URL || "https://auboisrieur.fr";
const ADSENSE_ID = process.env.ADSENSE_ID || "";

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function formatPrice(n) { return Number(n || 0).toLocaleString("fr-FR"); }
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function dateFr(iso) {
  if (!iso) return "";
  try { return new Date(iso+"T12:00:00Z").toLocaleDateString("fr-FR",{day:"numeric",month:"long",year:"numeric"}); }
  catch { return iso; }
}
function todayFr() { return new Date().toLocaleDateString("fr-FR",{day:"numeric",month:"long",year:"numeric"}); }
function slugify(t) { return String(t||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").substring(0,80); }
function dateFrShort(iso){if(!iso)return "";var d=iso.split("-");return d.length===3?d[2]+"/"+d[1]+"/"+d[0]:iso}

// ─── HTML Shell ──────────────────────────────────────────────────────────────
function htmlHead(title, desc, extra="", canonical="") {
  return `<!DOCTYPE html>
<html lang="fr" class="dark">
<head>
<meta charset="utf-8">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-MDW75MLB');</script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE_URL}${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:site_name" content="Adjugé">
<meta property="og:type" content="website">
${extra}
${ADSENSE_ID ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_ID}" crossorigin="anonymous"></script>` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class',theme:{extend:{fontFamily:{sans:['Inter','system-ui','sans-serif']},colors:{surface:'#12121a',surface2:'#1a1a26',surface3:'#22222f',accent:'#818cf8',accent2:'#f59e0b'}}}}</script>
<style>
*{box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#09090f;color:#d4d4dc;-webkit-font-smoothing:antialiased}
a{color:#818cf8;text-decoration:none}
a:hover{color:#a5b4fc}
.card{background:#14141e;border:1px solid rgba(255,255,255,0.05);border-radius:16px;overflow:hidden;transition:all 0.25s}
.card:hover{border-color:rgba(129,140,248,0.15);box-shadow:0 12px 40px rgba(0,0,0,0.4)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:0.7rem;font-weight:700;letter-spacing:0.02em}
.deal-fire{background:linear-gradient(135deg,#f59e0b,#ef4444);color:#000}
.deal-super{background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.2)}
.deal-good{background:rgba(34,197,94,0.1);color:#4ade80;border:1px solid rgba(34,197,94,0.15)}
.prose{line-height:1.8;color:#a1a1b0}
.prose p{margin-bottom:1rem}
.prose strong{color:#e4e4ec}
.gradient-text{background:linear-gradient(135deg,#818cf8 0%,#c084fc 50%,#f59e0b 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}
.pulse-dot{animation:pulse-dot 2s ease-in-out infinite}
</style>
<link rel="stylesheet" href="/hero-flip.css">
</head>`;
}

function navHtml() {
  return `<!-- GTM noscript --><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MDW75MLB" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript><nav class="sticky top-0 z-50 backdrop-blur-2xl bg-[#09090f]/85 border-b border-white/[0.04]">
<div class="max-w-7xl mx-auto px-4 md:px-6 flex items-center justify-between h-16">
  <a href="/" class="flex items-center gap-2.5 group">
    <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-lg font-black shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/40 transition-shadow">A</div>
    <span class="text-xl font-extrabold tracking-tight text-white">Adjugé<span class="text-indigo-400">!</span> <span class="text-[#39FF14]">In</span>vendu<span class="text-amber-400">!</span></span>
  </a>
  <div class="hidden md:flex items-center gap-1 text-[0.82rem]">
    <a href="/" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Invendus</a>
    <a href="/categories.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Catégories</a>
    <a href="/villes.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Villes</a>
    <a href="/maisons.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Maisons</a>
    <a href="/carte.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Carte</a>
      <a href="/blog.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Blog</a>
    <a href="/bonnes-affaires.html" class="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-amber-400 hover:text-amber-300 transition font-semibold text-xs">🔥 Bonnes affaires</a>
  </div>
  <div class="flex items-center gap-3">
    <div class="relative">
      <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
      <input type="text" id="searchInput" placeholder="Rechercher un lot..." autocomplete="off"
        class="bg-white/[0.04] border border-white/[0.06] rounded-xl pl-10 pr-4 py-2 text-sm w-40 md:w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/30 placeholder-gray-600 text-white transition-all focus:w-48 md:focus:w-72">
    </div>
    <button class="md:hidden w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-gray-400 hover:text-white transition" onclick="document.getElementById('mobileNav').classList.toggle('hidden')">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
  </div>
</div>
<div class="hidden md:hidden border-t border-white/[0.04] bg-[#09090f]" id="mobileNav">
  <div class="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-1">
    <a href="/" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Invendus</a>
    <a href="/categories.html" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Catégories</a>
    <a href="/villes.html" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Villes</a>
    <a href="/maisons.html" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Maisons de vente</a>
    <a href="/carte.html" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Carte</a>
    <a href="/blog.html" class="px-4 py-3 rounded-lg text-gray-300 hover:bg-white/[0.04] transition text-sm">Blog</a>
    <a href="/bonnes-affaires.html" class="px-4 py-3 rounded-lg text-amber-400 hover:bg-amber-500/10 transition text-sm font-semibold">🔥 Bonnes affaires</a>
  </div>
</div>
</nav>`;
}

function adSlot(type="") {
  if (!ADSENSE_ID) return "";
  return `<div class="my-6"><ins class="adsbygoogle" style="display:block" data-ad-client="${ADSENSE_ID}" data-ad-slot="" data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle = window.adsbygoogle || []).push({});</script></div>`;
}

function footerHtml() {
  return `<footer class="border-t border-white/[0.04] mt-20">
<div class="max-w-7xl mx-auto px-4 md:px-6 py-12">
  <div class="grid md:grid-cols-3 gap-8 mb-8">
    <div>
      <div class="flex items-center gap-2 mb-3">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm font-black">A</div>
        <span class="text-lg font-bold text-white">Adjugé ! Invendu !</span>
      </div>
      <p class="text-sm text-gray-500 leading-relaxed">Trouvez des bonnes affaires parmi les lots invendus aux enchères en France. Chaque lot est analysé pour identifier les meilleures opportunités.</p>
    </div>
    <div>
      <h4 class="text-sm font-semibold text-white mb-3">Navigation</h4>
      <div class="flex flex-col gap-2 text-sm text-gray-500">
        <a href="/" class="hover:text-gray-300 transition">Tous les invendus</a>
        <a href="/categories.html" class="hover:text-gray-300 transition">Catégories</a>
        <a href="/villes.html" class="hover:text-gray-300 transition">Villes</a>
        <a href="/bonnes-affaires.html" class="hover:text-gray-300 transition">Bonnes affaires</a>
        <a href="/comment-ca-marche.html" class="hover:text-gray-300 transition">Comment ça marche</a>
      </div>
    </div>
    <div>
      <h4 class="text-sm font-semibold text-white mb-3">Guides</h4>
      <div class="flex flex-col gap-2 text-sm text-gray-500">
        <a href="/guide/acheter-invendu-enchères.html" class="hover:text-gray-300 transition">Acheter un invendu</a>
        <a href="/guide/négocier-maison-vente.html" class="hover:text-gray-300 transition">Négocier avec une maison de vente</a>
        <a href="/guide/evaluer-objet-enchères.html" class="hover:text-gray-300 transition">Évaluer un objet</a>
        <a href="/guide/acheter-objet-invendu-enchères.html" class="hover:text-gray-300 transition">Acheter un invendu</a>
      </div>
    </div>
    <div>
      <h4 class="text-sm font-semibold text-white mb-3">Informations</h4>
      <div class="flex flex-col gap-2 text-sm text-gray-500">
        <a href="/a-propos.html" class="hover:text-gray-300 transition">À propos</a>
        <a href="/mentions-legales.html" class="hover:text-gray-300 transition">Mentions légales</a>
        <a href="/politique-confidentialite.html" class="hover:text-gray-300 transition">Confidentialité</a>
      </div>
    </div>
  </div>
  <div class="border-t border-white/[0.04] pt-6 text-center text-xs text-gray-600">
    <p>Adjugé ! Invendu ! — Les meilleures affaires aux enchères · Mis à jour le ${todayFr()}</p>
    <p class="mt-1">Les photos et descriptions proviennent des catalogues des maisons de vente. Adjugé n'organise aucune vente.</p>
  </div>
</div>

<script src="/hero-flip.js"></script>
<script src="/search.js"></script>
</footer>
<div id="lightbox" onclick="this.style.display='none'" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);cursor:zoom-out;align-items:center;justify-content:center"><img id="lightbox-img" style="max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px"></div>
<script>function openLightbox(src){var lb=document.getElementById("lightbox");var img=document.getElementById("lightbox-img");img.src=src.replace("/fit-in/400x400/","/fit-in/1200x1200/");lb.style.display="flex"}</script>
`;
}

// ─── Lot Card ────────────────────────────────────────────────────────────────

function catImgPath(catName) {
  const s = catName.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const imgPath = path.join(SITE_DIR, "img", "cat", s + ".jpg");
  if (fs.existsSync(imgPath)) return "/img/cat/" + s + ".jpg";
  return "";
}

function lotCard(lot) {
  const title = (lot.ai_title && lot.title && lot.title.length > 5) ? lot.ai_title : (lot.clean_title || lot.title || lot.category || "Lot invendu");
  const ds = lot.ai_deal_score || 0;
  const dealBadge = ds >= 3
    ? `<span class="badge deal-fire absolute top-3 right-3 shadow-lg">🔥 TOP AFFAIRE</span>`
    : ds >= 2
    ? `<span class="badge deal-super absolute top-3 right-3">⭐ Super affaire</span>`
    : ds >= 1
    ? `<span class="badge deal-good absolute top-3 right-3">Bonne affaire</span>`
    : '';

  const est = lot.estimate_low && lot.estimate_high
    ? `<div class="text-sm font-semibold text-indigo-400">${formatPrice(lot.estimate_low)} – ${formatPrice(lot.estimate_high)} €</div>`
    : lot.starting_price
    ? `<div class="text-sm text-gray-400">Mise à prix : ${formatPrice(lot.starting_price)} €</div>`
    : '';

  return `<a href="/lot/${esc(lot.slug)}.html" class="card block group relative" data-date="${lot.sale_date||''}" data-score="${lot.ai_deal_score||0}" data-price="${lot.estimate_high||0}">
  ${lot.thumb
    ? `<div class="aspect-[4/3] overflow-hidden bg-[#0d0d14]"><img src="${esc(lot.thumb)}" alt="${esc(title)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"></div>`
    : `<div class="aspect-[4/3] bg-[#0d0d14] flex items-center justify-center"><svg class="w-12 h-12 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg></div>`}
  ${dealBadge}
  <div class="p-4 space-y-2">
    <h3 class="text-[0.82rem] font-semibold text-white leading-snug line-clamp-2">${esc(title)}</h3>
    ${est}
    ${lot.sale_date ? `<div class="text-[0.68rem] text-orange-400/70 flex items-center gap-1">📅 Invendu le ${dateFrShort(lot.sale_date)}</div>` : ''}
    <div class="flex items-center justify-between text-[0.7rem] text-gray-500 pt-1">
      <span class="truncate max-w-[60%]">${esc(lot.category || '')}</span>
      ${lot.city ? `<span class="flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>${esc(lot.city)}</span>` : ''}
    </div>
  </div>
</a>`;
}

// ─── Lot Page ────────────────────────────────────────────────────────────────
function buildLotPage(lot) {
  const photos = JSON.parse(lot.photos || "[]");
  const title = (lot.ai_title && lot.title && lot.title.length > 5) ? lot.ai_title : (lot.clean_title || lot.title || lot.category || "Lot invendu");
  const desc = lot.ai_desc || buildFallbackDesc(lot);
  const ds = lot.ai_deal_score >= 0 ? lot.ai_deal_score : 0;
  const DEAL_LABELS = ["Sans intérêt particulier", "Bonne affaire", "Super affaire", "Affaire exceptionnelle"];
  const DEAL_ICONS = ["", "🟢", "⭐", "🔥"];
  const DEAL_BG = ["bg-gray-500/5 border-gray-500/10", "bg-green-500/5 border-green-500/10", "bg-blue-500/5 border-blue-500/10", "bg-gradient-to-r from-amber-500/10 to-orange-500/10 border-amber-500/20"];
  const faq = (() => { try { return JSON.parse(lot.ai_faq || "[]"); } catch { return []; } })();

  const metaDesc = `${title} — Lot invendu aux enchères.${lot.estimate_low ? ` Estimation ${formatPrice(lot.estimate_low)}-${formatPrice(lot.estimate_high)}€.` : ''} Analyse et contact maison de vente.`;

  return `${htmlHead(
    `${title} — Invendu aux enchères | Adjugé`,
    metaDesc,
    `${photos[0] ? `<meta property="og:image" content="${photos[0]}">` : ''}
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": title,
      "description": desc.substring(0, 200),
      "image": photos[0] || "",
      "offers": {
        "@type": "Offer",
        "priceCurrency": "EUR",
        "price": lot.estimate_low || lot.starting_price || 0,
        "availability": "https://schema.org/InStock",
        "seller": { "@type": "Organization", "name": lot.org_name || "Maison de vente" }
      }
    })}</script>`,
    `/lot/${lot.slug}.html`
  )}
<body>
${navHtml()}

<article class="max-w-6xl mx-auto px-4 md:px-6 py-8">
  <!-- Breadcrumb -->
  <nav class="flex items-center gap-2 text-sm text-gray-500 mb-6 overflow-x-auto">
    <a href="/" class="hover:text-white transition whitespace-nowrap">Invendus</a>
    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    ${lot.category ? `<a href="/categorie/${slugify(lot.category)}.html" class="hover:text-white transition whitespace-nowrap">${esc(lot.category)}</a>
    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>` : ''}
    <span class="text-gray-400 truncate">${esc(title)}</span>
  </nav>

  <div class="grid lg:grid-cols-5 gap-8">
    <!-- LEFT: Photos + Description (3 cols) -->
    <div class="lg:col-span-3 space-y-6">

      <!-- Gallery -->
      <div class="card overflow-hidden">
        ${photos.length > 0 ? `
        <div class="bg-[#0a0a12] p-4 md:p-6">
          <img id="mainImg" src="${esc(photos[0])}" alt="${esc(title)}" class="w-full max-h-[500px] object-contain rounded-lg">
        </div>
        ${photos.length > 1 ? `
        <div class="flex gap-2 p-4 overflow-x-auto border-t border-white/[0.04]">
          ${photos.map((p, i) => `<img src="${esc(p)}" alt="" class="w-16 h-16 md:w-20 md:h-20 object-cover rounded-lg cursor-pointer border-2 ${i===0?'border-indigo-500 opacity-100':'border-transparent opacity-50'} hover:opacity-100 transition-all flex-shrink-0" onclick="document.getElementById('mainImg').src='${esc(p)}';this.parentNode.querySelectorAll('img').forEach(x=>{x.classList.replace('border-indigo-500','border-transparent');x.classList.replace('opacity-100','opacity-50')});this.classList.replace('border-transparent','border-indigo-500');this.classList.replace('opacity-50','opacity-100')">`).join("")}
        </div>` : ''}
        ` : `<div class="bg-[#0a0a12] h-64 flex items-center justify-center">
          <svg class="w-20 h-20 text-gray-800" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        </div>`}
      </div>

      ${adSlot()}

      <!-- Description -->
      <div class="card p-6 md:p-8">
        <h2 class="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          Description
        </h2>
        <div class="prose text-[0.92rem]">
          ${desc.split('\n').filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}
        </div>
        ${lot.category ? `<p class="mt-4 text-sm text-gray-500">Ce lot fait partie de la catégorie <a href="/categorie/${slugify(lot.category)}.html" class="text-indigo-400 hover:text-indigo-300 font-medium">${esc(lot.category)}</a>. Consultez les autres invendus de cette catégorie pour comparer les prix.</p>` : ''}
      </div>

      ${adSlot()}

      <!-- FAQ -->
      ${faq.length > 0 ? `
      <div class="card p-6 md:p-8">
        <h2 class="text-lg font-bold text-white mb-6 flex items-center gap-2">
          <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Questions fréquentes
        </h2>
        <div class="space-y-4">
          ${faq.map(f => `
          <details class="group">
            <summary class="flex items-center justify-between cursor-pointer text-sm font-medium text-white hover:text-indigo-400 transition py-3 border-b border-white/[0.04]">
              <span>${esc(f.q)}</span>
              <svg class="w-4 h-4 text-gray-500 group-open:rotate-180 transition-transform flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </summary>
            <p class="text-sm text-gray-400 leading-relaxed py-3">${esc(f.a)}</p>
          </details>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <!-- RIGHT: Sidebar (2 cols) -->
    <aside class="lg:col-span-2 space-y-5">

      <!-- Title + Price card -->
      <div class="card p-6 space-y-4 lg:sticky lg:top-20">
        <span class="badge bg-orange-500/10 border border-orange-500/20 text-orange-400">Invendu</span>
        <h1 class="text-xl md:text-2xl font-bold text-white leading-snug">${esc(title)}</h1>

        ${lot.estimate_low ? `
        <div class="bg-white/[0.02] rounded-xl p-4 border border-white/[0.04]">
          <div class="text-xs text-gray-500 mb-1 uppercase tracking-wider font-medium">Estimation</div>
          <div class="text-2xl font-bold text-white">${formatPrice(lot.estimate_low)} – ${formatPrice(lot.estimate_high)} €</div>
          ${lot.starting_price ? `<div class="text-sm text-gray-400 mt-1">Mise à prix : ${formatPrice(lot.starting_price)} €</div>` : ''}
        </div>` : lot.starting_price ? `
        <div class="bg-white/[0.02] rounded-xl p-4 border border-white/[0.04]">
          <div class="text-xs text-gray-500 mb-1 uppercase tracking-wider font-medium">Mise à prix</div>
          <div class="text-2xl font-bold text-white">${formatPrice(lot.starting_price)} €</div>
        </div>` : ''}

        <!-- Deal score -->
        <div class="rounded-xl p-4 border ${DEAL_BG[ds]}">
          <div class="flex items-center gap-2 mb-2">
            ${DEAL_ICONS[ds] ? `<span class="text-lg">${DEAL_ICONS[ds]}</span>` : ''}
            <span class="font-bold text-white text-sm">${DEAL_LABELS[ds]}</span>
            ${ds >= 3 ? `<span class="badge deal-fire text-[0.65rem] ml-auto">TOP</span>` : ds >= 2 ? `<span class="badge deal-super text-[0.65rem] ml-auto">REC.</span>` : ''}
          </div>
          ${lot.ai_deal_analysis ? `<p class="text-[0.82rem] text-gray-400 leading-relaxed">${esc(lot.ai_deal_analysis)}</p>` : ''}
          ${lot.ai_price_analysis ? `<p class="text-[0.78rem] text-gray-500 mt-2 flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>${esc(lot.ai_price_analysis)}</p>` : ''}
        </div>

        <!-- Contact -->
        ${lot.org_name ? `
        <div class="rounded-xl p-4 bg-white/[0.02] border border-white/[0.04]">
          <h3 class="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
            Contacter la maison de vente
          </h3>
          <div class="space-y-2 text-sm">
            <div class="font-semibold text-white">${esc(lot.org_name)}</div>
            ${lot.org_address ? `<div class="text-gray-400 flex items-start gap-2"><svg class="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/></svg>${esc(lot.org_address)}</div>` : ''}
            ${lot.org_phone ? `<a href="tel:${esc(lot.org_phone)}" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition font-medium"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>${esc(lot.org_phone)}</a>` : ''}
            ${lot.org_email ? `<a href="mailto:${esc(lot.org_email)}" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition font-medium"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>${esc(lot.org_email)}</a>` : ''}
          </div>
          <div class="mt-4 pt-3 border-t border-white/[0.04] text-xs text-gray-500">
            💡 Les invendus peuvent souvent être acquis en dessous de l'estimation. N'hésitez pas à négocier.
          </div>
        </div>` : ''}

        <!-- Meta -->
        <div class="flex flex-wrap gap-2 text-[0.7rem]">
          ${lot.sale_date ? `<span class="px-2.5 py-1 rounded-lg bg-white/[0.03] text-gray-500">${dateFr(lot.sale_date)}</span>` : ''}
          ${lot.city ? `<span class="px-2.5 py-1 rounded-lg bg-white/[0.03] text-gray-500">📍 ${esc(lot.city)}</span>` : ''}
          ${lot.category ? `<span class="px-2.5 py-1 rounded-lg bg-white/[0.03] text-gray-500">${esc(lot.category)}</span>` : ''}
        </div>
      </div>
    </aside>
  </div>
</article>

${footerHtml()}
</body></html>`;
}

function buildFallbackDesc(lot) {
  const parts = [];
  const raw = (lot.description||"").split("\n").slice(1).join(" ").trim();
  if (raw.length > 20) parts.push(raw.substring(0, 500));
  if (lot.category && lot.category !== "Autre") parts.push(`Ce lot appartient à la catégorie ${lot.category}.`);
  if (lot.estimate_low) parts.push(`Son estimation se situe entre ${formatPrice(lot.estimate_low)} et ${formatPrice(lot.estimate_high)} €.`);
  if (lot.starting_price) parts.push(`La mise à prix était de ${formatPrice(lot.starting_price)} €.`);
  if (lot.org_name) parts.push(`Présenté par ${lot.org_name}${lot.city ? ` à ${lot.city}` : ''}.`);
  const nPhotos = JSON.parse(lot.photos||"[]").length;
  if (nPhotos > 1) parts.push(`${nPhotos} photos disponibles.`);
  return parts.join(" ") || "Contactez la maison de vente pour plus d'informations.";
}

// ─── Home Page ───────────────────────────────────────────────────────────────
function buildHomePage(db) {
  const stats = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) as unsold, COUNT(DISTINCT city) as cities, COUNT(DISTINCT category) as cats FROM lots`).get();
  const topDeals = db.prepare(`SELECT * FROM lots WHERE sold=0 AND ai_deal_score>=2 ORDER BY ai_deal_score DESC, estimate_high DESC LIMIT 8`).all();
  const recent = db.prepare(`SELECT * FROM lots WHERE sold=0 ORDER BY sale_date DESC, estimate_high DESC LIMIT 40`).all();
  const cats = db.prepare(`SELECT category, COUNT(*) as cnt FROM lots WHERE sold=0 AND category!='' GROUP BY category ORDER BY cnt DESC LIMIT 20`).all();
  const cities = db.prepare(`SELECT city, COUNT(*) as cnt FROM lots WHERE sold=0 AND city!='' GROUP BY city ORDER BY cnt DESC LIMIT 12`).all();
  const scoredCount = db.prepare(`SELECT COUNT(*) as cnt FROM lots WHERE sold=0 AND ai_deal_score>=1`).get();

  return `${htmlHead(
    "Adjugé ! Invendu ! — Bonnes affaires aux enchères en France",
    `${formatPrice(stats.unsold)} lots invendus aux enchères en France. Trouvez des bonnes affaires analysées par IA près de chez vous.`,
    "", "/"
  )}
<body>
${navHtml()}

<!-- Hero -->
<section class="relative overflow-hidden border-b border-white/[0.04]">
  <div class="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,119,198,0.15),transparent)]"></div>
  <div class="max-w-7xl mx-auto px-4 md:px-6 py-16 md:py-24 relative">
    <div class="grid lg:grid-cols-2 gap-8 items-center">
    <div>
    <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-gray-400 text-xs mb-6">
      <span class="w-1.5 h-1.5 rounded-full bg-green-400 pulse-dot"></span>
      Mis à jour le ${todayFr()}
    </div>
    <h1 class="text-3xl md:text-5xl lg:text-6xl font-black text-white leading-[1.1] mb-5 tracking-tight">
      On trouve.<br>On analyse.<br><span class="gradient-text">Vous négociez.</span>
    </h1>
    <p class="text-base md:text-lg text-gray-400 max-w-2xl mb-4 leading-relaxed">
      <strong class="text-white">${formatPrice(stats.unsold)}</strong> lots invendus aux enchères publiques françaises, analysés et notés par notre algorithme.
      Chaque objet est comparé aux prix du marche (eBay, enchères passées) pour identifier les vraies bonnes affaires.
    </p>
    <p class="text-sm text-gray-500 max-w-2xl mb-8 leading-relaxed">
      Adjugé recense les objets qui n'ont pas trouvé preneur lors des ventes aux enchères en France.
      Véhicules, bijoux, art, mobilier, matériel professionnel - contactez directement la maison de vente pour négocier un prix avantageux.
    </p>
    <div class="flex flex-wrap gap-3">
      <a href="#lots" class="px-7 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition-all hover:shadow-lg hover:shadow-indigo-500/25 text-sm">Explorer les invendus</a>
      <a href="/bonnes-affaires.html" class="px-7 py-3.5 bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08] text-white rounded-xl font-semibold transition text-sm">🔥 ${scoredCount.cnt}+ bonnes affaires</a>
    </div>
    </div>
    <div class="hidden lg:flex justify-center">
      <div class="flip-container">
        <div class="flip-card">
          <div class="flip-front">
            <img src="${topDeals[0]?.thumb || ''}" alt="" style="width:100%;height:260px;object-fit:cover">
            <div style="padding:20px">
              <div class="flex items-center gap-2 mb-3">
                <span style="padding:3px 10px;border-radius:20px;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.3);color:#f97316;font-size:0.65rem;font-weight:700">Invendu</span>
                <span style="font-size:0.6rem;color:#6b7280">${topDeals[0]?.category || ''}</span>
              </div>
              <h4 style="color:#fff;font-weight:800;font-size:0.95rem;line-height:1.3;margin-bottom:12px">${(topDeals[0]?.ai_title || topDeals[0]?.clean_title || '').substring(0,50)}</h4>
              <div style="font-size:0.6rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">Estimation</div>
              <div style="font-size:1.4rem;font-weight:900;color:#818cf8">${formatPrice(topDeals[0]?.estimate_low || 0)} - ${formatPrice(topDeals[0]?.estimate_high || 0)} &euro;</div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:0.65rem;color:#6b7280">
                <span>📍 ${topDeals[0]?.city || ''}</span>
              </div>
              <div class="flip-hint">↻ Notre analyse...</div>
            </div>
          </div>
          <div class="flip-back">
            <div style="padding:24px;height:100%;display:flex;flex-direction:column">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                <span style="padding:4px 12px;border-radius:20px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#000;font-size:0.7rem;font-weight:800">🔥 Top Affaire</span>
                <span style="color:#4ade80;font-weight:800">-40%</span>
              </div>
              <h4 style="color:#fff;font-weight:700;font-size:0.9rem;margin-bottom:16px">${(topDeals[0]?.ai_title || topDeals[0]?.clean_title || '').substring(0,50)}</h4>
              <div style="flex:1;display:flex;flex-direction:column;gap:8px">
                <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                  <span style="color:#6b7280;font-size:0.75rem">🏛️ Estimation</span>
                  <span style="color:#818cf8;font-weight:700">${formatPrice(topDeals[0]?.estimate_low || 0)} &euro;</span>
                </div>
                <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                  <span style="color:#6b7280;font-size:0.75rem">🛒 Prix marché</span>
                  <span style="color:#d4d4dc;font-weight:700">~${formatPrice(Math.round((topDeals[0]?.estimate_high || 0) * 1.4))} &euro;</span>
                </div>
              </div>
              <div style="border-radius:12px;padding:16px;margin-top:12px;border:1px solid rgba(245,158,11,0.2);background:rgba(245,158,11,0.06)">
                <div style="font-size:0.7rem;font-weight:700;color:#f59e0b;margin-bottom:4px">🏷️ Prix conseillé</div>
                <div style="font-size:1.2rem;font-weight:900;color:#fff">${formatPrice(Math.round((topDeals[0]?.estimate_low || 0) * 0.8))} - ${formatPrice(Math.round((topDeals[0]?.estimate_high || 0) * 0.9))} &euro;</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style="position:absolute;bottom:-20px;right:0;padding:6px 14px;border-radius:20px;border:1px solid rgba(99,102,241,0.2);background:rgba(99,102,241,0.06);color:#818cf8;font-size:0.7rem;font-weight:600">3 sources de prix</div>
    </div>
    </div>
  </div>
</section>

<!-- Stats -->
<section class="border-b border-white/[0.04] bg-white/[0.01]">
  <div class="max-w-7xl mx-auto px-4 md:px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-8">
    <div><div class="text-3xl font-black text-white">${formatPrice(stats.unsold)}</div><div class="text-xs text-gray-500 mt-1 uppercase tracking-wider">Lots invendus</div></div>
    <div><div class="text-3xl font-black text-white">${stats.cats}</div><div class="text-xs text-gray-500 mt-1 uppercase tracking-wider">Catégories</div></div>
    <div><div class="text-3xl font-black text-white">${stats.cities}</div><div class="text-xs text-gray-500 mt-1 uppercase tracking-wider">Villes</div></div>
    <div><div class="text-3xl font-black text-amber-400">${scoredCount.cnt}+</div><div class="text-xs text-gray-500 mt-1 uppercase tracking-wider">Bonnes affaires</div></div>
  </div>
</section>

<!-- How scoring works — visual -->
<section class="py-16 border-b border-white/[0.04]">
  <div class="max-w-7xl mx-auto px-4 md:px-6">
    <div class="text-center mb-10">
      <h2 class="text-2xl md:text-3xl font-black text-white mb-3">Notre algorithme identifie les <span class="gradient-text">vraies bonnes affaires</span></h2>
      <p class="text-gray-400 max-w-2xl mx-auto">Pour chaque lot invendu, nous croisons 3 sources de prix pour mesurer la décote réelle par rapport au marché.</p>
    </div>

    <!-- 3 sources -->
    <div class="grid md:grid-cols-3 gap-6 mb-12">
      <div class="card p-6 text-center">
        <div class="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto mb-4">
          <svg class="w-6 h-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
        </div>
        <h3 class="font-bold text-white text-sm mb-2">Enchères passées</h3>
        <p class="text-xs text-gray-500 leading-relaxed">Notre base de ${formatPrice(stats.total)} résultats de ventes aux enchères françaises. La référence la plus fiable.</p>
      </div>
      <div class="card p-6 text-center">
        <div class="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
          <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z"/></svg>
        </div>
        <h3 class="font-bold text-white text-sm mb-2">eBay France</h3>
        <p class="text-xs text-gray-500 leading-relaxed">Prix de vente récents sur le marché de l'occasion. Idéal pour les objets courants et véhicules.</p>
      </div>
      <div class="card p-6 text-center">
        <div class="w-12 h-12 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto mb-4">
          <svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        </div>
        <h3 class="font-bold text-white text-sm mb-2">Intelligence artificielle</h3>
        <p class="text-xs text-gray-500 leading-relaxed">GPT-4 analyse chaque lot, identifie l'objet et synthétise toutes les sources pour un score fiable.</p>
      </div>
    </div>

    <!-- Score levels -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="rounded-xl p-5 bg-gray-500/5 border border-gray-500/10 text-center">
        <div class="text-3xl mb-2">⚪</div>
        <div class="font-bold text-gray-400 text-sm">Sans intérêt</div>
        <div class="text-[0.7rem] text-gray-600 mt-1">Estimation ≈ prix marché</div>
      </div>
      <div class="rounded-xl p-5 bg-green-500/5 border border-green-500/10 text-center">
        <div class="text-3xl mb-2">🟢</div>
        <div class="font-bold text-green-400 text-sm">Bonne affaire</div>
        <div class="text-[0.7rem] text-gray-600 mt-1">Décote ~10%</div>
      </div>
      <div class="rounded-xl p-5 bg-blue-500/5 border border-blue-500/10 text-center">
        <div class="text-3xl mb-2">⭐</div>
        <div class="font-bold text-blue-400 text-sm">Super affaire</div>
        <div class="text-[0.7rem] text-gray-600 mt-1">Décote 10-25%</div>
      </div>
      <div class="rounded-xl p-5 bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-center">
        <div class="text-3xl mb-2">🔥</div>
        <div class="font-bold text-amber-400 text-sm">Exceptionnelle</div>
        <div class="text-[0.7rem] text-gray-600 mt-1">Décote > 25%</div>
      </div>
    </div>

    <div class="text-center mt-8">
      <a href="/comment-ca-marche.html" class="text-sm text-indigo-400 hover:text-indigo-300 transition font-medium">En savoir plus sur notre méthode →</a>
    </div>
  </div>
</section>

<div class="max-w-7xl mx-auto px-4 md:px-6">

  <!-- Accès rapide -->
  <section class="grid grid-cols-2 md:grid-cols-4 gap-3 -mt-6 mb-4 relative z-10">
    <a href="/bonnes-affaires.html" class="rounded-2xl p-4 bg-gradient-to-br from-amber-500/15 to-orange-500/10 border border-amber-500/25 hover:border-amber-500/50 transition group">
      <div class="text-2xl mb-1">🔥</div>
      <div class="font-bold text-amber-300 text-sm group-hover:text-amber-200">Bonnes affaires</div>
      <div class="text-[0.7rem] text-gray-500">Les meilleures décotes</div>
    </a>
    <a href="#lots" class="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/40 transition group">
      <div class="text-2xl mb-1">🆕</div>
      <div class="font-bold text-white text-sm group-hover:text-indigo-300">Derniers invendus</div>
      <div class="text-[0.7rem] text-gray-500">Ajoutés aujourd'hui</div>
    </a>
    <a href="/categories.html" class="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06] hover:border-indigo-500/40 transition group">
      <div class="text-2xl mb-1">🗂️</div>
      <div class="font-bold text-white text-sm group-hover:text-indigo-300">Catégories</div>
      <div class="text-[0.7rem] text-gray-500">Parcourir par type</div>
    </a>
    <a href="/carte.html" class="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06] hover:border-emerald-500/40 transition group">
      <div class="text-2xl mb-1">📍</div>
      <div class="font-bold text-white text-sm group-hover:text-emerald-300">Près de chez moi</div>
      <div class="text-[0.7rem] text-gray-500">Voir la carte</div>
    </a>
  </section>

  ${topDeals.length > 0 ? `
  <!-- Top deals -->
  <section class="py-12">
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold text-white flex items-center gap-2">🔥 Meilleures affaires</h2>
      <a href="/bonnes-affaires.html" class="text-sm text-indigo-400 hover:text-indigo-300 transition font-medium">Voir tout →</a>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      ${topDeals.map(l => lotCard(l)).join("")}
    </div>
  </section>` : ''}

  ${adSlot()}

  <!-- Recent lots -->
  <section id="lots" class="py-12 border-t border-white/[0.04]">
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold text-white">Derniers invendus</h2>
    </div>
    <div class="flex items-center gap-2 mb-4">
      <button onclick="filterByDate('all')" class="date-btn px-4 py-2 rounded-lg text-sm font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20" data-d="all">Tous</button>
      <button onclick="filterByDate('today')" class="date-btn px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.03] text-gray-400 border border-white/[0.05]" data-d="today">Aujourd'hui</button>
      <button onclick="filterByDate('3d')" class="date-btn px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.03] text-gray-400 border border-white/[0.05]" data-d="3d">3 jours</button>
      <button onclick="filterByDate('week')" class="date-btn px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.03] text-gray-400 border border-white/[0.05]" data-d="week">7 jours</button>
    </div>
    <script>function filterByDate(p){document.querySelectorAll(".date-btn").forEach(function(b){var a=b.dataset.d===p;b.style.background=a?"rgba(99,102,241,0.15)":"rgba(255,255,255,0.03)";b.style.color=a?"#818cf8":"#9ca3af";b.style.borderColor=a?"rgba(99,102,241,0.2)":"rgba(255,255,255,0.05)"});var now=new Date();document.querySelectorAll("[data-date]").forEach(function(el){if(p==="all"){el.style.display="";return}var d=el.dataset.date;if(!d){el.style.display="none";return}var diff=(now-new Date(d+"T12:00:00"))/86400000;if(p==="today")el.style.display=diff<1?"":"none";else if(p==="3d")el.style.display=diff<3?"":"none";else if(p==="week")el.style.display=diff<7?"":"none"})}</script>
    <div class="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
      ${cats.slice(0, 12).map(c => { const s = slugify(c.category); const img = fs.existsSync(path.join(SITE_DIR,"img","cat",s+".jpg")) ? "/img/cat/"+s+".jpg" : ""; return `<a href="/categorie/${s}.html" class="group relative rounded-xl overflow-hidden aspect-square block">${img?`<img src="${img}" alt="${esc(c.category)}" loading="lazy" class="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition-transform duration-500">`:`<div class="absolute inset-0 bg-gradient-to-br from-indigo-900/40 to-purple-900/40"></div>`}<div class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent"></div><div class="absolute bottom-0 left-0 right-0 p-2"><div class="text-white text-[0.72rem] font-semibold leading-tight line-clamp-2">${esc(c.category)}</div><div class="text-gray-300 text-[0.6rem]">${c.cnt.toLocaleString("fr-FR")} lots</div></div></a>`; }).join("")}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      ${recent.map(l => lotCard(l)).join("")}
    </div>
    <div class="text-center mt-8"><a href="/recherche.html" class="inline-block px-8 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition-all hover:shadow-lg hover:shadow-indigo-500/25 text-sm">Voir tous les invendus →</a></div>
  </section>

  ${adSlot()}

  <!-- Cities -->
  <section class="py-12 border-t border-white/[0.04]">
    <h2 class="text-xl font-bold text-white mb-6">Par ville</h2>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      ${cities.map(c => `<a href="/ville/${slugify(c.city)}.html" class="flex items-center justify-between px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] transition group">
        <span class="text-sm text-gray-300 group-hover:text-white transition">${esc(c.city)}</span>
        <span class="text-xs text-gray-600 bg-white/[0.04] px-2 py-0.5 rounded-full">${c.cnt}</span>
      </a>`).join("")}
    </div>
  </section>

  <!-- SEO Content -->
  <section class="py-12 border-t border-white/[0.04]">
    <div class="max-w-3xl">
      <h2 class="text-xl font-bold text-white mb-4">Adjugé ! Invendu ! — Le seul outil dédié aux invendus des enchères</h2>
      <div class="prose text-sm">
        <p><strong>Qu'est-ce qu'un lot invendu ?</strong> Lors d'une vente aux enchères publique, certains lots n'atteignent pas leur prix de réserve ou ne reçoivent aucune enchère. Ces objets — véhicules, bijoux, tableaux, mobilier, matériel professionnel — restent disponibles auprès de la maison de vente et peuvent souvent être acquis en dessous de leur estimation.</p>
        <p><strong>Comment fonctionne notre analyse ?</strong> Pour chaque lot invendu, notre algorithme croise trois sources de prix : les résultats des ventes aux enchères passées (notre base de données), les prix de vente sur eBay France, et les prix du marché via Google Shopping. Cette comparaison permet d'évaluer si l'estimation de l'objet représente une réelle décote par rapport à sa valeur marchande.</p>
        <p><strong>Le score de bonne affaire (0 à 3)</strong> est attribué en fonction de l'écart entre l'estimation enchère et le prix marché réel. Un score de 3 signifie que l'objet est estimé à moins de 30% de sa valeur sur le marché — une opportunité rare. Un score de 0 signifie que l'estimation est proche du prix marché — pas de décote significative.</p>
        <p><strong>Comment acheter ?</strong> Contactez directement la maison de vente indiquée sur chaque fiche. Les coordonnées complètes (téléphone, email, adresse) sont disponibles. Les commissaires-priseurs sont généralement ouverts à la négociation sur les lots invendus — c'est dans leur intérêt de vendre ces objets.</p>
      </div>
    </div>
  </section>
</div>

${footerHtml()}
</body></html>`;
}

// ─── Category page ───────────────────────────────────────────────────────────
function buildCategoryPage(db, cat) {
  const slug = slugify(cat.category);
  const lots = db.prepare("SELECT * FROM lots WHERE sold=0 AND category=? ORDER BY ai_deal_score DESC, sale_date DESC LIMIT 500").all(cat.category);
  const avgEst = db.prepare("SELECT AVG(estimate_low) as avg FROM lots WHERE sold=0 AND category=? AND estimate_low>0").get(cat.category);

  return `${htmlHead(
    `${cat.category} — Lots invendus aux enchères | Adjugé`,
    `${cat.cnt} lots invendus dans la catégorie ${cat.category}. Trouvez des bonnes affaires analysées par notre IA.`,
    "", `/categorie/${slug}.html`
  )}
<body>
${navHtml()}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
  <nav class="text-sm text-gray-500 mb-6"><a href="/" class="hover:text-white transition">Invendus</a> <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg> <span class="text-gray-400">${esc(cat.category)}</span></nav>
  <div class="mb-8">
    <h1 class="text-2xl md:text-3xl font-bold text-white mb-2">${esc(cat.category)}</h1>
    <p class="text-gray-400">${cat.cnt} lots invendus${avgEst?.avg ? ` · Estimation moyenne : ${formatPrice(Math.round(avgEst.avg))} €` : ''}</p>
  </div>
  ${adSlot()}
  <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
    ${lots.map(l => lotCard(l)).join("")}
  </div>
  <div class="mt-12 prose text-sm max-w-3xl">
    <h2 class="text-lg font-bold text-white mb-3">Acheter des ${esc(cat.category.toLowerCase())} aux enchères</h2>
    <p>Les ventes aux enchères sont une excellente source pour acquérir des ${esc(cat.category.toLowerCase())} à des prix compétitifs. Les lots invendus présentés ici n'ont pas trouvé preneur lors de la vente initiale et peuvent souvent être négociés directement avec la maison de vente. Contactez le commissaire-priseur pour connaître la disponibilité et le prix de vente.</p>
  </div>
</div>
${footerHtml()}
</body></html>`;
}

// ─── Ville page ──────────────────────────────────────────────────────────────
function buildVillePage(db, ville) {
  const slug = slugify(ville.city);
  const lots = db.prepare("SELECT * FROM lots WHERE sold=0 AND city=? ORDER BY ai_deal_score DESC, sale_date DESC LIMIT 500").all(ville.city);

  return `${htmlHead(
    `Invendus aux enchères à ${ville.city} | Adjugé`,
    `${ville.cnt} lots invendus aux enchères à ${ville.city}. Bonnes affaires près de chez vous.`,
    "", `/ville/${slug}.html`
  )}
<body>
${navHtml()}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
  <nav class="text-sm text-gray-500 mb-6"><a href="/" class="hover:text-white transition">Invendus</a> <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg> <a href="/villes.html" class="hover:text-white transition">Villes</a> <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg> <span class="text-gray-400">${esc(ville.city)}</span></nav>
  <h1 class="text-2xl md:text-3xl font-bold text-white mb-2">Invendus à ${esc(ville.city)}</h1>
  <p class="text-gray-400 mb-8">${ville.cnt} lots disponibles</p>
  ${adSlot()}
  <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
    ${lots.map(l => lotCard(l)).join("")}
  </div>
</div>
${footerHtml()}
</body></html>`;
}

// ─── Bonnes affaires page ────────────────────────────────────────────────────
function buildBonnesAffaires(db) {
  const deals = db.prepare("SELECT * FROM lots WHERE sold=0 AND ai_deal_score>=1 ORDER BY sale_date DESC, ai_deal_score DESC").all();

  return `${htmlHead(
    "Bonnes affaires aux enchères — Lots invendus analysés | Adjugé",
    `${deals.length} bonnes affaires identifiées parmi les lots invendus aux enchères en France.`,
    "", "/bonnes-affaires.html"
  )}
<body>
${navHtml()}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
  <h1 class="text-2xl md:text-3xl font-bold text-white mb-2">🔥 Bonnes affaires</h1>
  <p class="text-gray-400 mb-8">${deals.length} lots identifiés comme de bonnes opportunités par notre analyse (prix marché, enchères passées, eBay).</p>
  ${adSlot()}
  <div class="flex items-center gap-2 mb-6 flex-wrap">
    <button onclick="sortDeals('recent')" class="sort-btn px-4 py-2 rounded-lg text-sm font-medium bg-indigo-500/15 text-indigo-400 border border-indigo-500/20" data-s="recent">🆕 Récentes</button>
    <button onclick="sortDeals('score')" class="sort-btn px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.03] text-gray-400 border border-white/[0.05]" data-s="score">🔥 Meilleures décotes</button>
    <button onclick="sortDeals('price')" class="sort-btn px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.03] text-gray-400 border border-white/[0.05]" data-s="price">💰 Plus chères</button>
  </div>
  <div id="dealsGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
    ${deals.map(l => lotCard(l)).join("")}
  </div>
  <script>
  function sortDeals(mode){
    document.querySelectorAll(".sort-btn").forEach(function(b){var a=b.dataset.s===mode;b.style.background=a?"rgba(99,102,241,0.15)":"rgba(255,255,255,0.03)";b.style.color=a?"#818cf8":"#9ca3af";b.style.borderColor=a?"rgba(99,102,241,0.2)":"rgba(255,255,255,0.05)"});
    var g=document.getElementById("dealsGrid");
    var cards=Array.prototype.slice.call(g.children);
    cards.sort(function(x,y){
      if(mode==="recent"){return (y.dataset.date||"").localeCompare(x.dataset.date||"") || (y.dataset.score-x.dataset.score);}
      if(mode==="score"){return (y.dataset.score-x.dataset.score) || (y.dataset.date||"").localeCompare(x.dataset.date||"");}
      if(mode==="price"){return (y.dataset.price-x.dataset.price);}
    });
    cards.forEach(function(c){g.appendChild(c)});
  }
  </script>
  <div class="mt-12 prose text-sm max-w-3xl">
    <h2 class="text-lg font-bold text-white mb-3">Comment sont identifiées les bonnes affaires ?</h2>
    <p>Chaque lot invendu est analysé en croisant trois sources : les prix de ventes aux enchères similaires dans notre base, les prix sur eBay France, et les prix du marché via Google Shopping. Un algorithme attribue un score de 0 (sans intérêt) à 3 (affaire exceptionnelle) en fonction de la décote par rapport au prix marché.</p>
  </div>
</div>
${footerHtml()}
</body></html>`;
}

// ─── Static pages ────────────────────────────────────────────────────────────
function buildMentionsLegales() {
  return `${htmlHead("Mentions légales | Adjugé", "Mentions légales du site Adjugé.", "", "/mentions-legales.html")}
<body>${navHtml()}
<div class="max-w-3xl mx-auto px-4 md:px-6 py-12 prose">
  <h1 class="text-2xl font-bold text-white mb-6">Mentions légales</h1>
  <p><strong>Éditeur :</strong> Référencement NICE — SIREN 447716218</p>
  <p><strong>Hébergeur :</strong> OVH SAS — 2 rue Kellermann, 59100 Roubaix</p>
  <p><strong>Contact :</strong> contact@auboisrieur.fr</p>
  <p>Les photos et descriptions des lots proviennent des catalogues de ventes aux enchères publiés par les maisons de vente. Adjugé n'organise aucune vente aux enchères et ne prélève aucune commission.</p>
  <p>Les estimations et analyses de prix sont fournies à titre indicatif et ne constituent pas un conseil d'investissement.</p>
</div>
${footerHtml()}</body></html>`;
}

function buildAPropos() {
  return `${htmlHead("À propos | Adjugé", "Adjugé analyse les lots invendus aux enchères pour trouver les bonnes affaires.", "", "/a-propos.html")}
<body>${navHtml()}
<div class="max-w-3xl mx-auto px-4 md:px-6 py-12 prose">
  <h1 class="text-2xl font-bold text-white mb-6">À propos d'Adjugé</h1>
  <p>Adjugé est un service gratuit qui analyse les lots invendus lors des ventes aux enchères publiques en France. Notre objectif : vous aider à trouver des bonnes affaires.</p>
  <h2 class="text-lg font-bold text-white mt-6 mb-3">Comment ça marche ?</h2>
  <p>Nous collectons quotidiennement les résultats des ventes aux enchères françaises. Pour chaque lot invendu, notre algorithme croise plusieurs sources de prix (enchères passées, eBay, marché en ligne) afin d'évaluer si l'objet représente une bonne affaire.</p>
  <h2 class="text-lg font-bold text-white mt-6 mb-3">Comment acheter un lot invendu ?</h2>
  <p>Contactez directement la maison de vente indiquée sur chaque fiche. Les coordonnées (téléphone, email, adresse) sont disponibles. Les invendus peuvent généralement être négociés en dessous de l'estimation initiale.</p>
</div>
${footerHtml()}</body></html>`;
}

// ─── Editorial pages ─────────────────────────────────────────────────────────

function guideLayout(title, desc, canonical, content) {
  return `${htmlHead(title, desc, "", canonical)}
<body>
${navHtml()}
<article class="max-w-3xl mx-auto px-4 md:px-6 py-12">
  <nav class="text-sm text-gray-500 mb-8"><a href="/" class="hover:text-white transition">Accueil</a> <svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg> <span class="text-gray-400">${esc(title.split(' | ')[0])}</span></nav>
  ${content}
  ${adSlot()}
  <div class="mt-12 p-6 rounded-xl bg-indigo-500/5 border border-indigo-500/10">
    <h3 class="text-lg font-bold text-white mb-2">Trouvez votre prochaine bonne affaire</h3>
    <p class="text-sm text-gray-400 mb-4">Parcourez les ${new Date().getFullYear() > 2025 ? "milliers" : "centaines"} de lots invendus analysés par notre algorithme.</p>
    <a href="/" class="inline-block px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold text-sm transition">Explorer les invendus →</a>
  </div>
</article>
${footerHtml()}
</body></html>`;
}

function buildCommentCaMarche() {
  return guideLayout(
    "Comment ça marche | Adjugé",
    "Adjugé analyse les lots invendus aux enchères pour identifier les bonnes affaires. Découvrez notre méthode.",
    "/comment-ca-marche.html",
    `<h1 class="text-3xl md:text-4xl font-black text-white mb-6">Comment fonctionne Adjugé ?</h1>
    <p class="text-lg text-gray-400 mb-10">Adjugé est le seul outil qui recense et analyse les lots invendus des ventes aux enchères publiques en France. Voici comment nous identifions les bonnes affaires.</p>

    <div class="space-y-12">
      <div class="flex gap-5">
        <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-xl font-black text-indigo-400">1</div>
        <div>
          <h2 class="text-xl font-bold text-white mb-2">Collecte quotidienne des résultats</h2>
          <p class="text-gray-400 leading-relaxed">Chaque jour, notre système collecte automatiquement les résultats de toutes les ventes aux enchères publiques en France. Nous identifions les lots qui n'ont pas trouvé preneur — les <strong class="text-white">invendus</strong>. Ces objets sont toujours disponibles auprès de la maison de vente et représentent des opportunités d'achat.</p>
        </div>
      </div>

      <div class="flex gap-5">
        <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-xl font-black text-indigo-400">2</div>
        <div>
          <h2 class="text-xl font-bold text-white mb-2">Analyse des prix du marché</h2>
          <p class="text-gray-400 leading-relaxed">Pour chaque lot invendu, nous croisons <strong class="text-white">trois sources de prix</strong> afin d'estimer sa valeur réelle sur le marché :</p>
          <ul class="mt-3 space-y-2 text-gray-400">
            <li class="flex items-start gap-2"><span class="text-indigo-400 mt-1">●</span> <strong class="text-gray-300">Notre base d'enchères</strong> — Les prix d'adjudication de lots similaires vendus lors de ventes précédentes. C'est la référence la plus fiable pour les objets d'art, antiquités et véhicules.</li>
            <li class="flex items-start gap-2"><span class="text-indigo-400 mt-1">●</span> <strong class="text-gray-300">eBay France</strong> — Les prix de vente récents pour des objets similaires sur le marché de l'occasion. Utile pour les objets courants, l'électronique, les véhicules.</li>
            <li class="flex items-start gap-2"><span class="text-indigo-400 mt-1">●</span> <strong class="text-gray-300">Google Shopping</strong> — Les prix pratiqués par les vendeurs professionnels en ligne. Donne une indication du prix neuf ou remis à neuf.</li>
          </ul>
        </div>
      </div>

      <div class="flex gap-5">
        <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-xl font-black text-indigo-400">3</div>
        <div>
          <h2 class="text-xl font-bold text-white mb-2">Score de bonne affaire (0 à 3)</h2>
          <p class="text-gray-400 leading-relaxed mb-4">Notre algorithme compare l'estimation du lot aux prix du marché réels et attribue un score basé sur la <strong class="text-white">décote</strong> :</p>
          <div class="space-y-3">
            <div class="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <span class="text-lg">⚪</span>
              <div><strong class="text-gray-300">0 — Sans intérêt</strong><span class="text-gray-500 text-sm ml-2">L'estimation est proche du prix marché. Pas de décote significative.</span></div>
            </div>
            <div class="flex items-center gap-3 p-3 rounded-lg bg-green-500/[0.03] border border-green-500/[0.08]">
              <span class="text-lg">🟢</span>
              <div><strong class="text-green-400">1 — Bonne affaire</strong><span class="text-gray-500 text-sm ml-2">Décote de 30 à 50% par rapport au marché.</span></div>
            </div>
            <div class="flex items-center gap-3 p-3 rounded-lg bg-blue-500/[0.03] border border-blue-500/[0.08]">
              <span class="text-lg">⭐</span>
              <div><strong class="text-blue-400">2 — Super affaire</strong><span class="text-gray-500 text-sm ml-2">Décote de 50 à 70%. L'objet vaut 2 à 3 fois son estimation.</span></div>
            </div>
            <div class="flex items-center gap-3 p-3 rounded-lg bg-amber-500/[0.03] border border-amber-500/[0.08]">
              <span class="text-lg">🔥</span>
              <div><strong class="text-amber-400">3 — Affaire exceptionnelle</strong><span class="text-gray-500 text-sm ml-2">Décote de plus de 70%. Opportunité rare.</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex gap-5">
        <div class="flex-shrink-0 w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-xl font-black text-indigo-400">4</div>
        <div>
          <h2 class="text-xl font-bold text-white mb-2">Contactez la maison de vente</h2>
          <p class="text-gray-400 leading-relaxed">Chaque fiche inclut les coordonnées complètes de la maison de vente (téléphone, email, adresse). Contactez directement le commissaire-priseur pour connaître la disponibilité du lot et <strong class="text-white">négocier le prix</strong>. Les maisons de vente sont généralement ouvertes à la discussion sur les invendus — c'est dans leur intérêt de vendre ces objets.</p>
        </div>
      </div>
    </div>`
  );
}

function buildGuideAcheter() {
  return guideLayout(
    "Comment acheter un lot invendu aux enchères | Adjugé",
    "Guide complet pour acheter un lot invendu aux enchères publiques en France. Démarches, conseils et pièges à éviter.",
    "/guide/acheter-invendu-enchères.html",
    `<h1 class="text-3xl font-black text-white mb-6">Comment acheter un lot invendu aux enchères</h1>
    <p class="text-lg text-gray-400 mb-8">Les lots invendus aux enchères représentent des opportunités méconnues du grand public. Voici tout ce que vous devez savoir pour en profiter.</p>

    <div class="prose">
      <h2 class="text-xl font-bold text-white mt-8 mb-3">Qu'est-ce qu'un lot invendu ?</h2>
      <p>Lors d'une vente aux enchères publique, le commissaire-priseur fixe un prix de réserve pour chaque lot — le prix minimum en dessous duquel l'objet ne sera pas vendu. Si aucune enchère n'atteint ce prix, ou si personne n'enchérit, le lot est déclaré <strong>invendu</strong>.</p>
      <p>Contrairement à ce que l'on pourrait penser, un lot invendu n'est pas forcément un objet de mauvaise qualité. Il peut s'agir d'un objet rare qui n'a pas trouvé son public ce jour-là, d'un lot présenté avec une estimation trop élevée, ou simplement d'un jour où les acheteurs potentiels étaient absents.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Comment contacter la maison de vente ?</h2>
      <p>Sur chaque fiche Adjugé, vous trouverez les coordonnées complètes de la maison de vente :</p>
      <ul>
        <li><strong>Téléphone</strong> — Le moyen le plus rapide. Appelez aux heures d'ouverture (généralement 9h-12h et 14h-18h).</li>
        <li><strong>Email</strong> — Idéal pour une première prise de contact, surtout si vous souhaitez envoyer une offre écrite.</li>
        <li><strong>Adresse</strong> — Vous pouvez vous rendre sur place pour voir l'objet en personne avant d'acheter.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Peut-on négocier le prix ?</h2>
      <p><strong>Oui, c'est même recommandé.</strong> Les maisons de vente sont généralement ouvertes à la négociation sur les invendus. Voici quelques repères :</p>
      <ul>
        <li>Commencez par proposer <strong>20 à 40% en dessous</strong> de l'estimation basse.</li>
        <li>Les lots invendus depuis plusieurs semaines sont plus négociables que ceux du jour.</li>
        <li>Si l'objet nécessite des réparations ou un transport coûteux, mentionnez-le dans votre offre.</li>
        <li>N'oubliez pas que des <strong>frais acheteur</strong> (15 à 30%) s'ajoutent au prix négocié.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Les frais à prévoir</h2>
      <p>En plus du prix d'achat, prévoyez :</p>
      <ul>
        <li><strong>Frais acheteur</strong> : 15 à 30% du prix selon la maison de vente (TTC). C'est la rémunération du commissaire-priseur.</li>
        <li><strong>Transport</strong> : À votre charge. Les maisons de vente ne livrent généralement pas. Prévoyez un transporteur pour les objets volumineux.</li>
        <li><strong>Stockage</strong> : Les lots doivent être retirés dans un délai fixé (souvent 15 jours). Au-delà, des frais de stockage peuvent s'appliquer.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Les pièges à éviter</h2>
      <ul>
        <li><strong>Ne pas voir l'objet en personne</strong> — Les photos ne montrent pas tout. Si possible, déplacez-vous pour examiner l'objet avant d'acheter.</li>
        <li><strong>Oublier les frais</strong> — Un objet à 100€ vous coûtera 125-130€ avec les frais. Intégrez-les dans votre budget.</li>
        <li><strong>Acheter sans rechercher le prix marché</strong> — C'est là qu'Adjugé vous aide en comparant l'estimation aux prix réels du marché.</li>
        <li><strong>Se précipiter</strong> — Les invendus ne sont pas urgents. Prenez le temps de comparer et négocier.</li>
      </ul>
    </div>`
  );
}

function buildGuideNegocier() {
  return guideLayout(
    "Comment négocier avec une maison de vente aux enchères | Adjugé",
    "Conseils pratiques pour négocier l'achat d'un lot invendu auprès d'un commissaire-priseur.",
    "/guide/négocier-maison-vente.html",
    `<h1 class="text-3xl font-black text-white mb-6">Comment négocier avec une maison de vente</h1>
    <p class="text-lg text-gray-400 mb-8">Le commissaire-priseur a tout intérêt à vendre les lots invendus. Voici comment aborder la négociation pour obtenir le meilleur prix.</p>

    <div class="prose">
      <h2 class="text-xl font-bold text-white mt-8 mb-3">Comprendre la position du vendeur</h2>
      <p>Un lot invendu représente un coût pour la maison de vente : stockage, assurance, catalogage — tout cela sans revenu. Le commissaire-priseur est donc naturellement motivé pour trouver un acheteur, même à un prix inférieur à l'estimation initiale.</p>
      <p>De plus, le propriétaire de l'objet (le vendeur) est souvent déçu par l'absence de vente et peut accepter de baisser ses prétentions. C'est un contexte favorable pour l'acheteur.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Préparer sa négociation</h2>
      <p>Avant de contacter la maison de vente, rassemblez ces éléments :</p>
      <ul>
        <li><strong>Le prix marché réel</strong> — Consultez la fiche Adjugé qui compare l'estimation aux prix eBay et enchères passées.</li>
        <li><strong>L'historique du lot</strong> — A-t-il été présenté plusieurs fois sans trouver preneur ? C'est un argument de négociation.</li>
        <li><strong>Les défauts éventuels</strong> — Tout ce qui justifie une décote : état, réparations nécessaires, transport coûteux.</li>
        <li><strong>Votre budget maximum</strong> — Fixez-le avant d'appeler, frais inclus.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Les techniques qui fonctionnent</h2>
      <ul>
        <li><strong>Soyez direct et poli</strong> — "Bonjour, je suis intéressé par le lot X qui est resté invendu. Seriez-vous ouvert à une discussion sur le prix ?"</li>
        <li><strong>Proposez un prix précis</strong> — Pas "faites-moi un prix", mais "je peux vous proposer X€, frais compris".</li>
        <li><strong>Justifiez votre offre</strong> — "J'ai vu des modèles similaires à X€ sur eBay" ou "Il nécessite telle réparation estimée à X€".</li>
        <li><strong>Montrez que vous êtes un acheteur sérieux</strong> — "Je peux venir chercher l'objet cette semaine" ou "Je peux régler immédiatement".</li>
        <li><strong>N'ayez pas peur du silence</strong> — Après votre offre, attendez. Le commissaire-priseur doit souvent consulter le vendeur.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Quelles marges de négociation ?</h2>
      <p>En pratique, voici les décotes que vous pouvez raisonnablement espérer sur un invendu :</p>
      <ul>
        <li><strong>Invendu du jour</strong> : 10 à 20% sous l'estimation basse</li>
        <li><strong>Invendu de plus d'une semaine</strong> : 20 à 40% sous l'estimation basse</li>
        <li><strong>Invendu de plus d'un mois</strong> : 30 à 50% sous l'estimation basse</li>
        <li><strong>Objet volumineux difficile à stocker</strong> : jusqu'à 60% de décote possible</li>
      </ul>
      <p>Ces chiffres sont des moyennes. Chaque situation est unique et dépend de la motivation du vendeur.</p>
    </div>`
  );
}

function buildGuideEvaluer() {
  return guideLayout(
    "Comment évaluer un objet vendu aux enchères | Adjugé",
    "Apprenez à estimer la valeur d'un objet aux enchères. Méthodes, outils et conseils d'experts.",
    "/guide/evaluer-objet-enchères.html",
    `<h1 class="text-3xl font-black text-white mb-6">Comment évaluer un objet aux enchères</h1>
    <p class="text-lg text-gray-400 mb-8">Savoir estimer la valeur d'un objet est essentiel pour identifier les bonnes affaires. Voici les méthodes utilisées par les professionnels.</p>

    <div class="prose">
      <h2 class="text-xl font-bold text-white mt-8 mb-3">L'estimation du commissaire-priseur</h2>
      <p>L'estimation affichée dans le catalogue de vente est réalisée par le commissaire-priseur, souvent assisté d'un expert spécialisé. Elle représente la fourchette de prix à laquelle l'objet devrait se vendre. Cette estimation est généralement fiable, mais elle n'est pas infaillible.</p>
      <p>Plusieurs facteurs peuvent faire varier le prix final :</p>
      <ul>
        <li>La <strong>rareté</strong> de l'objet — un objet unique peut largement dépasser l'estimation</li>
        <li>La <strong>mode</strong> et les tendances du marché — certains styles sont plus recherchés à certaines périodes</li>
        <li>La <strong>provenance</strong> — un objet ayant appartenu à une personnalité se vend plus cher</li>
        <li>L'<strong>état de conservation</strong> — crucial pour le mobilier, les bijoux et les véhicules</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Comparer avec le marché</h2>
      <p>C'est exactement ce que fait Adjugé. Pour évaluer un objet, comparez son estimation avec :</p>
      <ul>
        <li><strong>Les résultats d'enchères passées</strong> — Le meilleur indicateur. Des bases comme Adjugé, Artnet ou Gazette Drouot permettent de consulter les prix d'adjudication d'objets similaires.</li>
        <li><strong>eBay et les plateformes d'occasion</strong> — Pour les objets courants (véhicules, électronique, design), eBay donne une bonne indication du prix de revente.</li>
        <li><strong>Les antiquaires et galeries</strong> — Leurs prix incluent une marge commerciale importante (souvent 50 à 100% au-dessus du prix enchères).</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Les catégories à surveiller</h2>
      <p>Certaines catégories offrent régulièrement de bonnes affaires aux enchères :</p>
      <ul>
        <li><strong>Véhicules d'occasion</strong> — Les voitures invendues aux enchères judiciaires sont souvent 20 à 40% sous le prix du marché.</li>
        <li><strong>Mobilier et design</strong> — Les meubles de qualité se vendent mal aux enchères (transport difficile) mais valent beaucoup en boutique.</li>
        <li><strong>Matériel professionnel</strong> — Les machines, outillage et matériel informatique décotent fortement aux enchères.</li>
        <li><strong>Bijoux</strong> — Le prix de l'or et des pierres donne un plancher de valeur fiable. Si l'estimation est proche du prix du métal, c'est une sécurité.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Le score Adjugé</h2>
      <p>Notre algorithme automatise cette comparaison. Pour chaque lot invendu, nous calculons l'écart entre l'estimation et le prix marché réel. Un score élevé (2 ou 3) signifie que l'objet est estimé bien en dessous de sa valeur marchande — une opportunité à saisir.</p>
    </div>`
  );
}

function buildGuideInvenduAchat() {
  return guideLayout(
    "Peut-on acheter un objet aux enchères s'il a été invendu ? | Adjugé ! Invendu !",
    "Oui ! Un lot invendu aux enchères reste disponible. Découvrez comment l'acheter, à quel prix et auprès de qui.",
    "/guide/acheter-objet-invendu-enchères.html",
    `<h1 class="text-3xl font-black text-white mb-6">Peut-on acheter un objet aux enchères s'il a été invendu ?</h1>
    <p class="text-lg text-gray-400 mb-8"><strong class="text-white">Oui, absolument.</strong> C'est même l'une des meilleures façons d'acquérir des objets à prix avantageux. Voici tout ce qu'il faut savoir.</p>

    <div class="prose">
      <h2 class="text-xl font-bold text-white mt-8 mb-3">Que devient un lot invendu ?</h2>
      <p>Quand un lot ne trouve pas preneur lors de la vente aux enchères — parce que personne n'a enchéri ou que le prix de réserve n'a pas été atteint — il est déclaré <strong>invendu</strong>. Mais cela ne signifie pas que l'objet disparaît. Il reste <strong>physiquement chez la maison de vente</strong> ou chez son propriétaire.</p>
      <p>Après la vente, plusieurs scénarios sont possibles :</p>
      <ul>
        <li><strong>Vente de gré à gré</strong> — Le commissaire-priseur peut vendre l'objet directement à un acheteur intéressé, sans passer par une nouvelle vente aux enchères. C'est le cas le plus courant et le plus avantageux pour l'acheteur.</li>
        <li><strong>Représentation dans une prochaine vente</strong> — L'objet est remis en vente ultérieurement, parfois avec une estimation revue à la baisse.</li>
        <li><strong>Retour au propriétaire</strong> — Le vendeur récupère son objet s'il ne souhaite pas baisser le prix.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Comment acheter un invendu ?</h2>
      <p>La démarche est simple :</p>
      <ol>
        <li><strong>Identifiez le lot</strong> sur Adjugé ! Invendu ! — consultez la fiche détaillée avec l'estimation, les photos et l'analyse de prix.</li>
        <li><strong>Contactez la maison de vente</strong> — Les coordonnées (téléphone, email) sont sur chaque fiche. Appelez ou écrivez en mentionnant le numéro du lot et la vente.</li>
        <li><strong>Demandez si le lot est disponible</strong> — Il peut avoir été vendu de gré à gré entre-temps ou retiré par le propriétaire.</li>
        <li><strong>Négociez le prix</strong> — C'est là que ça devient intéressant. Le commissaire-priseur et le vendeur sont motivés à vendre un invendu. Vous avez un vrai pouvoir de négociation.</li>
        <li><strong>Réglez et retirez</strong> — Une fois le prix convenu, vous payez (virement, chèque, parfois CB) et venez chercher l'objet.</li>
      </ol>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">À quel prix peut-on acheter un invendu ?</h2>
      <p>C'est la question clé. Voici les repères :</p>
      <ul>
        <li><strong>En dessous de l'estimation basse</strong> — C'est la règle, pas l'exception. L'objet n'a pas trouvé preneur à ce prix, il est donc logique de proposer moins.</li>
        <li><strong>20 à 50% sous l'estimation</strong> — C'est la fourchette la plus courante pour les achats de gré à gré après une vente.</li>
        <li><strong>Parfois encore moins</strong> — Si l'objet est encombrant, que le stockage coûte cher à la maison de vente, ou que le vendeur est pressé, la décote peut atteindre 60-70%.</li>
      </ul>
      <p>C'est exactement ce que mesure notre <strong>score de bonne affaire</strong> : l'écart entre l'estimation et le prix réel du marché. Plus le score est élevé, plus l'opportunité est grande.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Les frais à prévoir</h2>
      <p>Attention, même pour un achat de gré à gré après invendu, des frais s'appliquent :</p>
      <ul>
        <li><strong>Frais de vente</strong> : Même en vente de gré à gré, la maison de vente prélève une commission (généralement 10 à 20% TTC, parfois négociable).</li>
        <li><strong>TVA</strong> : Selon le régime de la vente (TVA sur marge ou TVA normale).</li>
        <li><strong>Transport</strong> : À votre charge dans tous les cas.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Pourquoi les invendus sont-ils des opportunités ?</h2>
      <p>Plusieurs raisons font des invendus de vraies bonnes affaires :</p>
      <ul>
        <li><strong>L'estimation était trop haute</strong> — Le commissaire-priseur a visé trop haut. Cela ne veut pas dire que l'objet ne vaut rien, juste que son prix de marché est inférieur.</li>
        <li><strong>Mauvais timing</strong> — La vente avait lieu un jour de faible affluence, ou les collectionneurs ciblés n'étaient pas présents.</li>
        <li><strong>Objet niche</strong> — Certains objets très spécifiques (machines industrielles, instruments scientifiques, véhicules spéciaux) n'intéressent qu'un petit nombre d'acheteurs. En vente aux enchères, si ces acheteurs sont absents, l'objet reste invendu — mais sa valeur réelle est intacte.</li>
        <li><strong>Volume de la vente</strong> — Les grosses ventes avec 500+ lots voient souvent des invendus par simple saturation de l'attention des enchérisseurs.</li>
      </ul>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Le rôle d'Adjugé ! Invendu !</h2>
      <p>Notre service recense automatiquement tous les invendus des ventes aux enchères publiques en France. Pour chaque lot, nous :</p>
      <ul>
        <li>Comparons l'estimation avec les <strong>prix réels du marché</strong> (eBay, enchères passées, Google Shopping)</li>
        <li>Attribuons un <strong>score de bonne affaire</strong> de 0 à 3</li>
        <li>Fournissons les <strong>coordonnées complètes</strong> de la maison de vente</li>
        <li>Rédigeons une <strong>fiche détaillée</strong> avec description enrichie et FAQ</li>
      </ul>
      <p>Notre objectif : vous faire gagner du temps en identifiant les vraies opportunités parmi les milliers de lots invendus chaque semaine.</p>
    </div>`
  );
}

function buildPolitiqueConfidentialite() {
  return guideLayout(
    "Politique de confidentialité | Adjugé",
    "Politique de confidentialité du site Adjugé.",
    "/politique-confidentialite.html",
    `<h1 class="text-3xl font-black text-white mb-6">Politique de confidentialité</h1>
    <div class="prose">
      <p><strong>Dernière mise à jour :</strong> ${todayFr()}</p>
      <h2 class="text-xl font-bold text-white mt-8 mb-3">Collecte de données</h2>
      <p>Adjugé ne collecte aucune donnée personnelle de ses visiteurs. Nous n'utilisons pas de formulaire d'inscription, de compte utilisateur, ni de système de suivi individuel.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Cookies</h2>
      <p>Adjugé utilise des cookies strictement nécessaires au fonctionnement du site. Si des publicités sont affichées via Google AdSense, Google peut utiliser des cookies pour personnaliser les annonces. Vous pouvez gérer vos préférences de cookies dans les paramètres de votre navigateur.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Données affichées</h2>
      <p>Les informations affichées sur les lots (descriptions, photos, estimations) proviennent des catalogues publics des ventes aux enchères. Les coordonnées des maisons de vente sont des informations professionnelles publiques.</p>

      <h2 class="text-xl font-bold text-white mt-8 mb-3">Contact</h2>
      <p>Pour toute question relative à la confidentialité, contactez-nous à contact@auboisrieur.fr.</p>
    </div>`
  );
}

// ─── Build all ───────────────────────────────────────────────────────────────

const DEPT_TO_REGION={"01":"ARA","02":"HDF","03":"ARA","04":"PACA","05":"PACA","06":"PACA","07":"ARA","08":"GE","09":"OCC","10":"GE","11":"OCC","12":"OCC","13":"PACA","14":"NOR","15":"ARA","16":"NAQ","17":"NAQ","18":"CVL","19":"NAQ","21":"BFC","22":"BRE","23":"NAQ","24":"NAQ","25":"BFC","26":"ARA","27":"NOR","28":"CVL","29":"BRE","30":"OCC","31":"OCC","32":"OCC","33":"NAQ","34":"OCC","35":"BRE","36":"CVL","37":"CVL","38":"ARA","39":"BFC","40":"NAQ","41":"CVL","42":"ARA","43":"ARA","44":"PDL","45":"CVL","46":"OCC","47":"NAQ","48":"OCC","49":"PDL","50":"NOR","51":"GE","52":"GE","53":"PDL","54":"GE","55":"GE","56":"BRE","57":"GE","58":"BFC","59":"HDF","60":"HDF","61":"NOR","62":"HDF","63":"ARA","64":"NAQ","65":"OCC","66":"OCC","67":"GE","68":"GE","69":"ARA","70":"BFC","71":"BFC","72":"PDL","73":"ARA","74":"ARA","75":"IDF","76":"NOR","77":"IDF","78":"IDF","79":"NAQ","80":"HDF","81":"OCC","82":"OCC","83":"PACA","84":"PACA","85":"PDL","86":"NAQ","87":"NAQ","88":"GE","89":"BFC","90":"BFC","91":"IDF","92":"IDF","93":"IDF","94":"IDF","95":"IDF","97":"OM","98":"OM","99":"ETR"};
const REGION_NAMES={"ARA":"Auvergne-Rhône-Alpes","HDF":"Hauts-de-France","PACA":"Provence-Alpes-Côte d'Azur","GE":"Grand Est","OCC":"Occitanie","NAQ":"Nouvelle-Aquitaine","NOR":"Normandie","CVL":"Centre-Val de Loire","BFC":"Bourgogne-Franche-Comté","BRE":"Bretagne","PDL":"Pays de la Loire","IDF":"Île-de-France","OM":"Outre-mer","ETR":"Étranger"};
const REGION_GRADS={"ARA":"from-blue-600 to-cyan-600","HDF":"from-amber-600 to-orange-600","PACA":"from-sky-500 to-blue-500","GE":"from-rose-600 to-pink-600","OCC":"from-orange-500 to-red-500","NAQ":"from-emerald-600 to-teal-600","NOR":"from-indigo-600 to-purple-600","CVL":"from-lime-600 to-green-600","BFC":"from-violet-600 to-fuchsia-600","BRE":"from-cyan-600 to-blue-600","PDL":"from-teal-500 to-emerald-500","IDF":"from-purple-600 to-indigo-600","OM":"from-pink-500 to-rose-500","ETR":"from-gray-600 to-gray-700"};

function buildVillesHtml(cities) {
  console.log("    buildVillesHtml:", cities.length, "cities");
  console.log("    First city:", JSON.stringify(cities[0]));
  const regionMap = {};
  cities.forEach(ci => {
    const dept = (ci.postcode || "").substring(0, 2);
    const rk = DEPT_TO_REGION[dept] || "ETR";
    if (!regionMap[rk]) regionMap[rk] = [];
    regionMap[rk].push(ci);
  });
  const sorted = Object.entries(regionMap).sort((a, b) => {
    const tA = a[1].reduce((s, x) => s + x.cnt, 0);
    const tB = b[1].reduce((s, x) => s + x.cnt, 0);
    return tB - tA;
  });
  let html = "";
  sorted.forEach(([rk, villes]) => {
    if (rk === "ETR") return;
    const rName = REGION_NAMES[rk] || rk;
    const total = villes.reduce((s, x) => s + x.cnt, 0);
    const grad = REGION_GRADS[rk] || "from-gray-600 to-gray-700";
    html += '<div class="mb-10">';
    html += '<div class="flex items-center gap-3 mb-4"><div class="w-1 h-6 rounded-full bg-gradient-to-b ' + grad + '"></div>';
    html += '<h2 class="text-lg font-bold text-white">' + esc(rName) + '</h2>';
    html += '<span class="text-sm text-gray-500">' + total + ' lots</span></div>';
    html += '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">';
    villes.forEach(ci => {
      html += '<a href="/ville/' + slugify(ci.city) + '.html" class="block rounded-xl overflow-hidden bg-gradient-to-br ' + grad + ' p-4 hover:scale-[1.02] transition-transform">';
      html += '<div class="text-white font-bold text-sm">' + esc(ci.city) + '</div>';
      html += '<div class="text-white/70 text-xs mt-1">' + ci.cnt + ' invendus</div></a>';
    });
    html += '</div></div>';
  });
  return html;
}

function build() {
  console.log("\n🏗️  Adjugé v2 — Build Pro\n");
  const db = new Database(DB_PATH, { readonly: true });
  ensureDir(SITE_DIR);
  ensureDir(path.join(SITE_DIR, "lot"));
  ensureDir(path.join(SITE_DIR, "categorie"));
  ensureDir(path.join(SITE_DIR, "ville"));

  // Homepage
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), buildHomePage(db));
  console.log("  ✅ index.html");

  // Bonnes affaires
  fs.writeFileSync(path.join(SITE_DIR, "bonnes-affaires.html"), buildBonnesAffaires(db));
  console.log("  ✅ bonnes-affaires.html");

  // Lot pages
  const unsold = db.prepare("SELECT * FROM lots WHERE sold=0").all();
  for (const lot of unsold) {
    fs.writeFileSync(path.join(SITE_DIR, "lot", `${lot.slug}.html`), buildLotPage(lot));
  }
  console.log(`  ✅ ${unsold.length} pages lot`);

  // Category pages
  const cats = db.prepare("SELECT category, COUNT(*) as cnt FROM lots WHERE sold=0 AND category!='' GROUP BY category ORDER BY cnt DESC").all();
  for (const cat of cats) {
    fs.writeFileSync(path.join(SITE_DIR, "categorie", `${slugify(cat.category)}.html`), buildCategoryPage(db, cat));
  }
  console.log(`  ✅ ${cats.length} pages catégorie`);

  // Categories index
  fs.writeFileSync(path.join(SITE_DIR, "categories.html"), `${htmlHead("Catégories — Invendus | Adjugé", "Toutes les catégories d'invendus aux enchères.", "", "/categories.html")}
<body>${navHtml()}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
  <h1 class="text-2xl font-bold text-white mb-6">Catégories</h1>
  <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
    ${cats.map(c => {
      const imgSlug = slugify(c.category);
      const imgFile = path.join(SITE_DIR, "img", "cat", imgSlug + ".jpg");
      const hasImg = fs.existsSync(imgFile);
      return `<a href="/categorie/${slugify(c.category)}.html" class="card block group overflow-hidden">
        ${hasImg
          ? `<div class="aspect-[3/2] overflow-hidden bg-[#0d0d14]"><img src="/img/cat/${imgSlug}.jpg" alt="${esc(c.category)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"></div>`
          : `<div class="aspect-[3/2] bg-gradient-to-br from-indigo-900/30 to-purple-900/30 flex items-center justify-center"><span class="text-3xl text-gray-600">📦</span></div>`}
        <div class="p-4 flex items-center justify-between">
          <span class="text-sm text-gray-300 group-hover:text-white transition font-medium">${esc(c.category)}</span>
          <span class="text-xs text-gray-600 bg-white/[0.04] px-2.5 py-1 rounded-full">${c.cnt}</span>
        </div>
      </a>`;
    }).join("")}
  </div>
</div>
${footerHtml()}</body></html>`);
  console.log("  ✅ categories.html");

  // Ville pages
  const cities = db.prepare("SELECT city, MAX(postcode) as postcode, COUNT(*) as cnt FROM lots WHERE sold=0 AND length(city)>0 GROUP BY city ORDER BY cnt DESC").all();
  for (const v of cities) {
    fs.writeFileSync(path.join(SITE_DIR, "ville", `${slugify(v.city)}.html`), buildVillePage(db, v));
  }
  console.log(`  ✅ ${cities.length} pages ville`);

  // Villes index
  fs.writeFileSync(path.join(SITE_DIR, "villes.html"), `${htmlHead("Villes — Invendus | Adjugé", "Invendus aux enchères par ville.", "", "/villes.html")}
<body>${navHtml()}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
  <h1 class="text-2xl font-bold text-white mb-6">Invendus par ville</h1>
  ${buildVillesHtml(cities)}
</div>
${footerHtml()}</body></html>`);
  console.log("  ✅ villes.html");

  // Static pages
  ensureDir(path.join(SITE_DIR, "guide"));
  fs.writeFileSync(path.join(SITE_DIR, "mentions-legales.html"), buildMentionsLegales());
  fs.writeFileSync(path.join(SITE_DIR, "a-propos.html"), buildAPropos());
  fs.writeFileSync(path.join(SITE_DIR, "comment-ca-marche.html"), buildCommentCaMarche());
  fs.writeFileSync(path.join(SITE_DIR, "guide/acheter-invendu-enchères.html"), buildGuideAcheter());
  fs.writeFileSync(path.join(SITE_DIR, "guide/négocier-maison-vente.html"), buildGuideNegocier());
  fs.writeFileSync(path.join(SITE_DIR, "guide/evaluer-objet-enchères.html"), buildGuideEvaluer());
  fs.writeFileSync(path.join(SITE_DIR, "guide/acheter-objet-invendu-enchères.html"), buildGuideInvenduAchat());
  fs.writeFileSync(path.join(SITE_DIR, "politique-confidentialite.html"), buildPolitiqueConfidentialite());
  console.log("  ✅ pages statiques + guides");

  // Sitemap
  const allSlugs = db.prepare("SELECT slug FROM lots WHERE sold=0").all();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
<url><loc>${SITE_URL}/bonnes-affaires.html</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
<url><loc>${SITE_URL}/categories.html</loc><changefreq>weekly</changefreq></url>
<url><loc>${SITE_URL}/villes.html</loc><changefreq>weekly</changefreq></url>
<url><loc>${SITE_URL}/comment-ca-marche.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
<url><loc>${SITE_URL}/guide/acheter-invendu-enchères.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
<url><loc>${SITE_URL}/guide/négocier-maison-vente.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
<url><loc>${SITE_URL}/guide/evaluer-objet-enchères.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
<url><loc>${SITE_URL}/guide/acheter-objet-invendu-enchères.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>
<url><loc>${SITE_URL}/a-propos.html</loc><changefreq>monthly</changefreq></url>
${cats.map(c => `<url><loc>${SITE_URL}/categorie/${slugify(c.category)}.html</loc><changefreq>daily</changefreq></url>`).join("\n")}
${cities.map(c => `<url><loc>${SITE_URL}/ville/${slugify(c.city)}.html</loc><changefreq>daily</changefreq></url>`).join("\n")}
${allSlugs.map(l => `<url><loc>${SITE_URL}/lot/${l.slug}.html</loc></url>`).join("\n")}
</urlset>`;
  fs.writeFileSync(path.join(SITE_DIR, "sitemap.xml"), sitemap);
  fs.writeFileSync(path.join(SITE_DIR, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  console.log("  ✅ sitemap.xml + robots.txt");

  console.log(`\n📊 Total: ${unsold.length} invendus, ${cats.length} catégories, ${cities.length} villes`);
  console.log("✅ Build terminé\n");
  db.close();
}

build();
