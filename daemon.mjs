#!/usr/bin/env node
/**
 * Interencheres Archive Daemon — Site Generator
 * Génère un site complet avec catégories, maisons de vente, liens Amazon affiliés et pubs.
 *
 * Structure:
 *   site/
 *   ├── index.html                    Accueil
 *   ├── lot/<id>.html                 Pages lots
 *   ├── categorie/<slug>.html         Pages catégories
 *   ├── maison/<slug>.html            Pages maisons de vente
 *   ├── vente/<id>.html               Pages ventes
 *   └── jour/<date>.html              Archives par jour
 *
 * Usage:
 *   node daemon.mjs                    Lance (poll 60s)
 *   node daemon.mjs --interval 30
 *   node daemon.mjs --date 2026-03-14
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import config from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = "https://search.interencheres.com/v1/search";
const PAGE_SIZE = 200;
const SITE_DIR = path.join(__dirname, "site");

// ─── helpers ────────────────────────────────────────────────────────────────

function curlFetch(url) {
  const result = execFileSync("curl", [
    "-s",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: fr-FR,fr;q=0.9,en;q=0.8",
    "-H", "Referer: https://www.interencheres.com/",
    "-H", "Origin: https://www.interencheres.com",
    url,
  ], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
  return JSON.parse(result.toString("utf-8"));
}

function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return curlFetch(url.href);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function nowStr() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 80) || "sans-nom";
}

function imgUrl(media, size = "lg") {
  const url = media?.rewriteImgUrl?.[size] || media?.rewriteImgUrl?.md || media?.url || "";
  return url.startsWith("//") ? `https:${url}` : url;
}

function amazonSearchUrl(title) {
  const q = String(title || "").substring(0, 120).trim();
  return `https://${config.amazonDomain}/s?k=${encodeURIComponent(q)}&tag=${config.amazonTag}`;
}

function formatPrice(n) {
  return Number(n || 0).toLocaleString("fr-FR");
}

// ─── API functions ──────────────────────────────────────────────────────────

function fetchTodaySales(dateStr) {
  const allSales = [];
  const seen = new Set();
  for (const sort of ["datetime", "-datetime"]) {
    const sales = apiFetch("ie4_sales", { limit: PAGE_SIZE, "filters[status]": "published", sort });
    for (const s of sales) {
      if (s.datetime && s.datetime.startsWith(dateStr) && !seen.has(s.id)) {
        seen.add(s.id);
        allSales.push(s);
      }
    }
  }
  return allSales;
}

function fetchAllItems(saleId) {
  const seen = new Set();
  const items = [];
  const sorts = ["id", "-id", "pricing.estimates.max", "-pricing.estimates.max"];
  for (const sort of sorts) {
    let offset = 0;
    while (true) {
      const batch = apiFetch("ie4_items", {
        "filters[sale]": saleId, limit: PAGE_SIZE, offset, sort,
      });
      if (!batch.length) break;
      let newCount = 0;
      for (const item of batch) {
        if (!seen.has(item.id)) { seen.add(item.id); items.push(item); newCount++; }
      }
      if (newCount === 0 || batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  return items;
}

// ─── State / Registry ───────────────────────────────────────────────────────
// Global registries for cross-linking
const registry = {
  items: new Map(),       // itemId -> item data
  sales: new Map(),       // saleId -> { sale, items: [] }
  categories: new Map(),  // categorySlug -> { name, id, description, items: [] }
  maisons: new Map(),     // orgSlug -> { name, city, id, items: [], sales: Set }
};

function registerItem(item, sale) {
  registry.items.set(item.id, { item, sale });

  // Register sale
  const saleId = sale?.id || item.sale?.id;
  if (saleId && !registry.sales.has(saleId)) {
    registry.sales.set(saleId, {
      sale,
      saleName: sale?.name || "",
      org: sale?.organization?.names?.voluntary || sale?.organization?.names?.judicial || "",
      city: sale?.address?.city || "",
      items: [],
    });
  }
  if (saleId) registry.sales.get(saleId).items.push(item);

  // Register category
  const catName = item.category?.name;
  if (catName) {
    const catSlug = slugify(catName);
    if (!registry.categories.has(catSlug)) {
      registry.categories.set(catSlug, {
        name: catName,
        id: item.category.id,
        description: item.category.description || item.category.summary || "",
        field: item.category.field || "",
        items: [],
      });
    }
    registry.categories.get(catSlug).items.push(item);
  }

  // Register maison
  const orgName = item.organization?.names?.voluntary || item.organization?.names?.judicial || "";
  if (orgName) {
    const orgSlug = slugify(orgName);
    const city = sale?.address?.city || item.sale?.address?.city || "";
    if (!registry.maisons.has(orgSlug)) {
      registry.maisons.set(orgSlug, {
        name: orgName,
        city,
        id: item.organization?.id,
        address: item.organization?.address || sale?.address || {},
        items: [],
        saleIds: new Set(),
      });
    }
    const m = registry.maisons.get(orgSlug);
    m.items.push(item);
    if (saleId) m.saleIds.add(saleId);
  }
}

// ─── Ad & Amazon HTML snippets ──────────────────────────────────────────────

function adSlot(slot, style = "") {
  if (!config.adsenseId || !config.adSlots[slot]) return "";
  return `<div class="ad-slot" style="${style}">
    <ins class="adsbygoogle" style="display:block" data-ad-client="${config.adsenseId}" data-ad-slot="${config.adSlots[slot]}" data-ad-format="auto" data-full-width-responsive="true"></ins>
    <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
  </div>`;
}

function amazonButton(title) {
  const url = amazonSearchUrl(title);
  return `<a href="${esc(url)}" target="_blank" rel="nofollow noopener" class="amazon-btn">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705a.66.66 0 01-.753.077c-1.06-.878-1.25-1.284-1.828-2.12-1.748 1.784-2.986 2.317-5.249 2.317-2.681 0-4.764-1.655-4.764-4.967 0-2.585 1.401-4.344 3.394-5.205 1.729-.753 4.143-.888 5.986-1.096v-.41c0-.753.058-1.642-.384-2.292-.384-.578-1.117-.817-1.768-.817-1.2 0-2.27.616-2.531 1.891a.644.644 0 01-.549.549l-3.074-.332a.543.543 0 01-.46-.644C6.085 1.526 9.27.2 12.12.2c1.44 0 3.325.384 4.462 1.477 1.44 1.345 1.301 3.14 1.301 5.096v4.617c0 1.388.577 1.997 1.12 2.747.19.268.232.588-.01.786-.606.506-1.683 1.448-2.275 1.975l-.002-.001-.573-.104z"/><path d="M21.83 18.654c-1.906 1.412-4.669 2.16-7.05 2.16-3.337 0-6.342-1.234-8.613-3.29-.179-.161-.019-.381.195-.256 2.453 1.427 5.487 2.284 8.622 2.284 2.114 0 4.436-.438 6.577-1.345.322-.14.594.212.269.447z"/><path d="M22.678 17.535c-.243-.312-1.612-.148-2.228-.075-.187.022-.216-.14-.047-.258 1.09-.766 2.88-.545 3.088-.288.208.26-.055 2.053-1.079 2.91-.157.132-.307.062-.237-.112.23-.574.746-1.864.503-2.177z"/></svg>
    Voir sur Amazon
  </a>`;
}

// ─── Shared HTML parts ──────────────────────────────────────────────────────

function htmlHead(title, description, extraHead = "") {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — ${esc(config.siteName)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index, follow">
  ${config.gaId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${config.gaId}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${config.gaId}');</script>` : ""}
  ${config.adsenseId ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${config.adsenseId}" crossorigin="anonymous"></script>` : ""}
  ${extraHead}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    a { color: #1a56db; text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .topnav { background: #1a1a2e; color: #fff; padding: 0.8rem 2rem; display: flex; align-items: center; gap: 2rem; flex-wrap: wrap; }
    .topnav .brand { font-weight: 700; font-size: 1.1rem; color: #fff; }
    .topnav a { color: #8ab4f8; font-size: 0.9rem; }
    .topnav a:hover { color: #fff; }

    /* Breadcrumb */
    .breadcrumb { padding: 0.8rem 2rem; font-size: 0.85rem; color: #888; background: #fff; border-bottom: 1px solid #eee; }
    .breadcrumb a { color: #666; }

    /* Layout */
    .container { max-width: 1100px; margin: 1.5rem auto; padding: 0 1rem; }
    .grid-2 { display: grid; grid-template-columns: 1fr 300px; gap: 1.5rem; }
    @media (max-width: 800px) { .grid-2 { grid-template-columns: 1fr; } }

    /* Cards */
    .card { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); overflow: hidden; margin-bottom: 1.5rem; }
    .card-header { padding: 1rem 1.5rem; border-bottom: 1px solid #eee; }
    .card-body { padding: 1.5rem; }

    /* Images */
    .gallery { display: flex; flex-wrap: wrap; gap: 8px; padding: 1.5rem; background: #fafafa; justify-content: center; }
    .gallery img { max-height: 300px; max-width: 100%; border-radius: 8px; cursor: pointer; transition: transform 0.2s; }
    .gallery img:hover { transform: scale(1.05); }

    /* Price */
    .price { font-size: 1.8rem; font-weight: 700; }
    .price.sold { color: #2d7d46; }
    .price.unsold { color: #b33; }
    .estimate { color: #888; font-size: 0.95rem; }
    .tag { background: #e8f5e9; color: #2d7d46; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; }

    /* Amazon button */
    .amazon-btn { display: inline-flex; align-items: center; gap: 8px; background: #f0c14b; color: #111; padding: 10px 20px; border-radius: 8px; font-weight: 600; font-size: 0.95rem; transition: background 0.2s; margin: 1rem 0; }
    .amazon-btn:hover { background: #ddb347; text-decoration: none; }

    /* Meta table */
    .meta-table { width: 100%; }
    .meta-table td { padding: 0.4rem 0; vertical-align: top; }
    .meta-table td:first-child { font-weight: 600; color: #666; width: 120px; }

    /* Lot grid */
    .lot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
    .lot-card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: box-shadow 0.2s; }
    .lot-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .lot-card img { width: 100%; height: 160px; object-fit: cover; }
    .lot-card .no-img { width: 100%; height: 160px; background: #eee; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 2rem; }
    .lot-card .lot-info { padding: 0.7rem; }
    .lot-card .lot-title { font-size: 0.8rem; line-height: 1.3; height: 2.6em; overflow: hidden; color: #333; }
    .lot-card .lot-price { font-weight: 700; color: #2d7d46; margin-top: 0.3rem; }
    .lot-card .lot-cat { font-size: 0.7rem; color: #999; margin-top: 0.2rem; }

    /* Lot list row */
    .lot-row { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 1rem; border-bottom: 1px solid #f0f0f0; text-decoration: none; color: inherit; transition: background 0.15s; }
    .lot-row:hover { background: #f8f9ff; }
    .lot-row img { width: 60px; height: 45px; object-fit: cover; border-radius: 4px; }
    .lot-row .lot-title { flex: 1; font-size: 0.85rem; }
    .lot-row .lot-price { font-weight: 700; color: #2d7d46; white-space: nowrap; }

    /* Sidebar */
    .sidebar .card { margin-bottom: 1rem; }
    .sidebar .card-header h3 { font-size: 0.95rem; }
    .cat-list a, .maison-list a { display: block; padding: 0.3rem 0; font-size: 0.85rem; border-bottom: 1px solid #f5f5f5; }
    .cat-list a:last-child, .maison-list a:last-child { border: 0; }
    .cat-count { color: #999; font-size: 0.8rem; }

    /* Stats */
    .stat-box { text-align: center; padding: 1rem; }
    .stat-number { font-size: 2rem; font-weight: 700; color: #1a1a2e; }
    .stat-label { color: #888; font-size: 0.85rem; }

    /* Ad */
    .ad-slot { margin: 1rem 0; text-align: center; min-height: 90px; }

    /* Footer */
    .footer { text-align: center; color: #aaa; padding: 2rem; font-size: 0.8rem; margin-top: 2rem; }
  </style>
</head>`;
}

function navHtml() {
  return `<nav class="topnav">
  <span class="brand">${esc(config.siteName)}</span>
  <a href="/index.html">Accueil</a>
  <a href="/categories.html">Catégories</a>
</nav>`;
}

function footerHtml() {
  return `<footer class="footer">
  ${esc(config.siteName)} · Résultats de ventes aux enchères en France<br>
  Les liens Amazon sont des liens affiliés.
</footer>`;
}

function sidebarHtml() {
  // Top categories
  const cats = [...registry.categories.entries()]
    .sort((a, b) => b[1].items.length - a[1].items.length)
    .slice(0, 15);

  return `<aside class="sidebar">
    ${adSlot("sidebar")}
    <div class="card">
      <div class="card-header"><h3>Catégories</h3></div>
      <div class="card-body cat-list">
        ${cats.map(([slug, c]) => `<a href="/categorie/${slug}.html">${esc(c.name)} <span class="cat-count">(${c.items.length})</span></a>`).join("\n        ")}
        <a href="/categories.html" style="margin-top:0.5rem;font-weight:600;">Toutes les catégories →</a>
      </div>
    </div>
    ${adSlot("sidebar")}
  </aside>`;
}

function lotCard(item) {
  const title = (item.description || item.title_translations?.["fr-FR"] || "").substring(0, 70);
  const price = item.pricing?.auctioned?.price || 0;
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "md") : "";
  const catName = item.category?.name || "";
  const catSlug = catName ? slugify(catName) : "";
  return `<a href="/lot/${item.id}.html" class="lot-card">
    ${thumb ? `<img src="${esc(thumb)}" alt="${esc(title)}" loading="lazy">` : `<div class="no-img">📦</div>`}
    <div class="lot-info">
      <div class="lot-title">${esc(title)}</div>
      <div class="lot-price">${formatPrice(price)} €</div>
      ${catSlug ? `<div class="lot-cat">${esc(catName)}</div>` : ""}
    </div>
  </a>`;
}

function similarLots(item) {
  const catSlug = item.category?.name ? slugify(item.category.name) : "";
  if (!catSlug || !registry.categories.has(catSlug)) return "";
  const similar = registry.categories.get(catSlug).items
    .filter(i => i.id !== item.id)
    .slice(0, config.similarLotsCount);
  if (!similar.length) return "";
  return `<div class="card">
    <div class="card-header"><h3>Lots similaires</h3></div>
    <div class="card-body"><div class="lot-grid">${similar.map(lotCard).join("\n")}</div></div>
  </div>`;
}

// ─── Page generators ────────────────────────────────────────────────────────

function generateLotPage(item, sale) {
  const title = item.description || item.title_translations?.["fr-FR"] || "Objet de collection";
  const shortTitle = title.substring(0, 70);
  const auc = item.pricing?.auctioned || {};
  const est = item.pricing?.estimates || {};
  const org = item.organization?.names?.voluntary || item.organization?.names?.judicial || "";
  const orgSlug = slugify(org);
  const city = sale?.address?.city || item.sale?.address?.city || "";
  const saleDate = (sale?.datetime || item.sale?.datetime || "").substring(0, 10);
  const saleName = sale?.name || item.sale?.name || "";
  const saleId = sale?.id || item.sale?.id || "";
  const catName = item.category?.name || "";
  const catSlug = slugify(catName);
  const medias = item.medias || [];

  const desc = `${shortTitle} vendu ${auc.price || 0}€ aux enchères. ${catName}. ${org}, ${city}.`;

  const imagesHtml = medias.map((m, i) => {
    const src = imgUrl(m, "lg");
    const original = imgUrl(m, "original") || src;
    return `<a href="${esc(original)}" target="_blank"><img src="${esc(src)}" alt="${esc(shortTitle)} - Photo ${i + 1}" loading="lazy"></a>`;
  }).join("\n          ");

  const priceHtml = auc.sold
    ? `<span class="price sold">${formatPrice(auc.price)} €</span>`
    : `<span class="price unsold">Non vendu</span>`;

  const estHtml = est.min != null ? `Estimation : ${formatPrice(est.min)} – ${formatPrice(est.max)} €` : "";

  return `${htmlHead(`${shortTitle} — ${auc.sold ? auc.price + "€" : "Non vendu"}`, desc)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    ${catSlug ? `<a href="/categorie/${catSlug}.html">${esc(catName)}</a> ›` : ""}
    ${esc(shortTitle)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="gallery">
            ${imagesHtml || "<p>Pas de photo</p>"}
          </div>
          <div class="card-body">
            <h1 style="font-size:1.3rem;margin-bottom:1rem;line-height:1.4;">${esc(title)}</h1>
            <div style="margin:1rem 0;">
              ${priceHtml}
              ${estHtml ? `<span class="estimate" style="margin-left:1rem;">${estHtml}</span>` : ""}
            </div>

            ${amazonButton(title)}

            ${adSlot("inArticle")}

            <table class="meta-table">
              ${catSlug ? `<tr><td>Catégorie</td><td><a href="/categorie/${catSlug}.html">${esc(catName)}</a></td></tr>` : ""}
              <tr><td>Date</td><td>${saleDate}</td></tr>
            </table>
          </div>
        </div>

        ${similarLots(item)}
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateCategoryPage(slug, data) {
  const totalPrice = data.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const avgPrice = data.items.length ? Math.round(totalPrice / data.items.length) : 0;
  const desc = `${data.items.length} lots vendus en catégorie ${data.name}. Prix moyen : ${avgPrice}€.`;

  // Group by maison
  const byMaison = {};
  for (const item of data.items) {
    const org = item.organization?.names?.voluntary || item.organization?.names?.judicial || "Autre";
    if (!byMaison[org]) byMaison[org] = [];
    byMaison[org].push(item);
  }

  return `${htmlHead(data.name, desc)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/categories.html">Catégories</a> ›
    ${esc(data.name)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${esc(data.name)}</h1>
            ${data.description ? `<p style="color:#666;margin-bottom:1rem;font-size:0.9rem;">${esc(data.description)}</p>` : ""}
            <div style="display:flex;gap:2rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${data.items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(avgPrice)} €</div><div class="stat-label">prix moyen</div></div>
            </div>
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Tous les lots (${data.items.length})</h2></div>
          <div class="card-body">
            <div class="lot-grid">
              ${data.items.slice(0, config.lotsPerCategoryPage).map(lotCard).join("\n              ")}
            </div>
          </div>
        </div>

      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateMaisonPage(slug, data) {
  const totalPrice = data.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const desc = `${data.name} (${data.city}) — ${data.items.length} lots vendus, ${formatPrice(totalPrice)}€ total.`;

  // Group by category
  const byCat = {};
  for (const item of data.items) {
    const catName = item.category?.name || "Autre";
    if (!byCat[catName]) byCat[catName] = [];
    byCat[catName].push(item);
  }

  return `${htmlHead(data.name, desc)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/maisons.html">Maisons de vente</a> ›
    ${esc(data.name)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${esc(data.name)}</h1>
            <p style="color:#666;">${esc(data.city)} ${data.address?.street ? "· " + esc(data.address.street) : ""}</p>
            <div style="display:flex;gap:2rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${data.items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${data.saleIds.size}</div><div class="stat-label">ventes</div></div>
            </div>
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Spécialités</h2></div>
          <div class="card-body cat-list">
            ${Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([cat, items]) => {
              const catSlug = slugify(cat);
              return `<a href="/categorie/${catSlug}.html">${esc(cat)} <span class="cat-count">(${items.length})</span></a>`;
            }).join("\n            ")}
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Derniers lots vendus</h2></div>
          <div class="card-body">
            <div class="lot-grid">
              ${data.items.slice(0, config.lotsPerCategoryPage).map(lotCard).join("\n              ")}
            </div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateSalePage(saleId, data) {
  const totalPrice = data.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const saleDate = (data.sale?.datetime || "").substring(0, 10);
  const desc = `Vente ${data.saleName} — ${data.org}, ${data.city} — ${data.items.length} lots, ${formatPrice(totalPrice)}€.`;

  return `${htmlHead(data.saleName || `Vente ${saleId}`, desc)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/jour/${saleDate}.html">${saleDate}</a> ›
    Vente ${saleId}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.3rem;margin-bottom:0.5rem;">${esc(data.saleName)}</h1>
            <p style="color:#666;"><a href="/maison/${slugify(data.org)}.html">${esc(data.org)}</a> · ${esc(data.city)} · ${saleDate}</p>
            <div style="display:flex;gap:2rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${data.items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
            </div>
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Résultats</h2></div>
          <div class="card-body">
            <div class="lot-grid">
              ${data.items.map(lotCard).join("\n              ")}
            </div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateCategoriesIndex() {
  const cats = [...registry.categories.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
  return `${htmlHead("Toutes les catégories", "Liste des catégories de ventes aux enchères")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Catégories</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <h1 style="font-size:1.5rem;margin-bottom:1.5rem;">${cats.length} catégories</h1>
    <div class="lot-grid">
      ${cats.map(([slug, c]) => {
        const top = c.items[0];
        const thumb = top?.medias?.[0] ? imgUrl(top.medias[0], "md") : "";
        return `<a href="/categorie/${slug}.html" class="lot-card">
          ${thumb ? `<img src="${esc(thumb)}" alt="${esc(c.name)}" loading="lazy">` : `<div class="no-img">📁</div>`}
          <div class="lot-info">
            <div class="lot-title" style="font-weight:600;">${esc(c.name)}</div>
            <div class="lot-cat">${c.items.length} lots</div>
          </div>
        </a>`;
      }).join("\n      ")}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateMaisonsIndex() {
  const maisons = [...registry.maisons.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
  return `${htmlHead("Maisons de vente", "Liste des maisons de vente aux enchères")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Maisons de vente</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <h1 style="font-size:1.5rem;margin-bottom:1.5rem;">${maisons.length} maisons de vente</h1>
    ${maisons.map(([slug, m]) => `
      <a href="/maison/${slug}.html" class="lot-row">
        <div class="lot-title"><strong>${esc(m.name)}</strong> · ${esc(m.city)}</div>
        <div class="lot-price">${m.items.length} lots · ${m.saleIds.size} ventes</div>
      </a>`).join("\n    ")}
  </div>
  ${footerHtml()}
</body>
</html>`;
}

function generateHomePage(dateStr) {
  const totalItems = registry.items.size;
  const totalPrice = [...registry.items.values()].reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);
  const recentItems = [...registry.items.values()]
    .sort((a, b) => (b.item.last_updated || "").localeCompare(a.item.last_updated || ""))
    .slice(0, 24);

  return `${htmlHead(`Enchères du ${dateStr}`, `${totalItems} lots vendus aux enchères le ${dateStr}. Photos, prix, estimations.`)}
<body>
  ${navHtml()}
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="card" style="margin-bottom:1.5rem;">
      <div class="card-body" style="display:flex;gap:2rem;justify-content:center;flex-wrap:wrap;">
        <div class="stat-box"><div class="stat-number">${totalItems}</div><div class="stat-label">objets</div></div>
        <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
        <div class="stat-box"><div class="stat-number">${registry.categories.size}</div><div class="stat-label">catégories</div></div>
      </div>
    </div>

    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Derniers lots vendus</h2></div>
          <div class="card-body">
            <div class="lot-grid">
              ${recentItems.map(({ item }) => lotCard(item)).join("\n              ")}
            </div>
          </div>
        </div>

        ${adSlot("betweenLots")}
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

// ─── Full site rebuild ──────────────────────────────────────────────────────

function rebuildAllPages(dateStr) {
  // Ensure directories
  ensureDir(path.join(SITE_DIR, "lot"));
  ensureDir(path.join(SITE_DIR, "categorie"));
  ensureDir(path.join(SITE_DIR, "jour"));
  ensureDir(path.join(SITE_DIR, "data"));

  let pageCount = 0;

  // Lot pages
  for (const [itemId, { item, sale }] of registry.items) {
    fs.writeFileSync(path.join(SITE_DIR, "lot", `${itemId}.html`), generateLotPage(item, sale), "utf-8");
    pageCount++;
  }

  // Category pages
  for (const [slug, data] of registry.categories) {
    fs.writeFileSync(path.join(SITE_DIR, "categorie", `${slug}.html`), generateCategoryPage(slug, data), "utf-8");
    pageCount++;
  }

  // Index pages
  fs.writeFileSync(path.join(SITE_DIR, "categories.html"), generateCategoriesIndex(), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), generateHomePage(dateStr), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "jour", `${dateStr}.html`), generateHomePage(dateStr), "utf-8");
  pageCount += 3;

  return pageCount;
}

// ─── FTP upload ─────────────────────────────────────────────────────────────

async function ftpUpload() {
  if (!config.ftp?.enabled || !config.ftp.host) return;

  const { Client } = await import("basic-ftp");
  const client = new Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: config.ftp.host,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure || false,
    });

    const remote = config.ftp.remotePath || "/public_html";

    // Upload all HTML files (skip data/ folder)
    async function uploadDir(localDir, remoteDir) {
      await client.ensureDir(remoteDir);
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const entry of entries) {
        const localPath = path.join(localDir, entry.name);
        const remotePath = `${remoteDir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "data") continue; // Skip data/ folder
          await uploadDir(localPath, remotePath);
        } else if (entry.name.endsWith(".html")) {
          await client.uploadFrom(localPath, remotePath);
        }
      }
    }

    const start = Date.now();
    await uploadDir(SITE_DIR, remote);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  📤 FTP upload terminé en ${elapsed}s`);
  } catch (err) {
    console.warn(`  ⚠ FTP erreur: ${err.message}`);
  } finally {
    client.close();
  }
}

// ─── daemon ─────────────────────────────────────────────────────────────────

function runDaemon(dateStr, intervalSec) {
  ensureDir(SITE_DIR);
  const dataDir = path.join(SITE_DIR, "data");
  ensureDir(dataDir);

  const knownSold = new Set();
  const stateFile = path.join(dataDir, "state.json");

  // Restore state
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      for (const itemId of state.knownSold || []) {
        knownSold.add(itemId);
        const itemFile = path.join(dataDir, `${itemId}.json`);
        if (fs.existsSync(itemFile)) {
          try {
            const saved = JSON.parse(fs.readFileSync(itemFile, "utf-8"));
            registerItem(saved.item, saved.sale);
          } catch {}
        }
      }
      console.log(`  Reprise: ${knownSold.size} lots restaurés.`);
      const pageCount = rebuildAllPages(dateStr);
      console.log(`  ${pageCount} pages régénérées.\n`);
    } catch {}
  }

  console.log(`\n🏛️  Daemon Interenchères — Site Generator`);
  console.log(`   Dossier: ${SITE_DIR}`);
  console.log(`   Intervalle: ${intervalSec}s — Ctrl+C pour arrêter`);
  console.log(`   Amazon tag: ${config.amazonTag}`);
  console.log(`   AdSense: ${config.adsenseId || "non configuré"}`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  const poll = () => {
    try {
      const sales = fetchTodaySales(dateStr);
      const now = nowStr();
      let newSoldCount = 0;

      console.log(`  [${now}] ${sales.length} ventes trouvées`);

      for (const sale of sales) {
        try {
          const items = fetchAllItems(sale.id);
          for (const item of items) {
            const auc = item.pricing?.auctioned;
            if (auc?.sold && !knownSold.has(item.id)) {
              knownSold.add(item.id);
              registerItem(item, sale);
              newSoldCount++;

              // Save for restart
              fs.writeFileSync(path.join(dataDir, `${item.id}.json`), JSON.stringify({ item, sale: { id: sale.id, name: sale.name, datetime: sale.datetime, address: sale.address, organization: sale.organization } }, null, 2), "utf-8");

              const title = (item.description || "").substring(0, 50);
              console.log(`    🔨 Lot ${item.id} — ${auc.price}€ — ${title}`);
            }
          }
        } catch (err) {
          console.warn(`    ⚠ Vente ${sale.id}: ${err.message}`);
        }
      }

      // Save state
      fs.writeFileSync(stateFile, JSON.stringify({
        knownSold: [...knownSold],
        lastPoll: new Date().toISOString(),
      }, null, 2), "utf-8");

      // Rebuild all pages (fast — all in memory)
      if (newSoldCount > 0) {
        const pageCount = rebuildAllPages(dateStr);
        console.log(`  [${now}] +${newSoldCount} lots — Total: ${knownSold.size} lots, ${pageCount} pages`);
        // Upload to FTP
        ftpUpload().catch(err => console.warn(`  ⚠ FTP: ${err.message}`));
      } else {
        process.stdout.write(`  [${now}] ${knownSold.size} lots — en attente...\r`);
      }

    } catch (err) {
      console.warn(`  ⚠ Erreur: ${err.message}`);
    }
  };

  poll();
  setInterval(poll, intervalSec * 1000);

  process.on("SIGINT", () => {
    console.log(`\n\n✅ Daemon arrêté. ${knownSold.size} lots, ${registry.categories.size} catégories, ${registry.maisons.size} maisons.`);
    console.log(`   Site: ${SITE_DIR}`);
    process.exit(0);
  });
}

// ─── main ───────────────────────────────────────────────────────────────────

// ─── Single run (for GitHub Actions / CI) ────────────────────────────────────

async function runOnce(dateStr) {
  ensureDir(SITE_DIR);
  const dataDir = path.join(SITE_DIR, "data");
  ensureDir(dataDir);

  console.log(`\n🏛️  Interenchères — Exécution unique (${dateStr})`);
  console.log(`   Amazon tag: ${config.amazonTag}`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  const sales = fetchTodaySales(dateStr);
  console.log(`  ${sales.length} ventes trouvées`);

  let soldCount = 0;
  for (const sale of sales) {
    try {
      const items = fetchAllItems(sale.id);
      for (const item of items) {
        const auc = item.pricing?.auctioned;
        if (auc?.sold) {
          registerItem(item, sale);
          soldCount++;
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Vente ${sale.id}: ${err.message}`);
    }
  }

  console.log(`  ${soldCount} lots vendus collectés`);

  if (soldCount > 0) {
    const pageCount = rebuildAllPages(dateStr);
    console.log(`  ${pageCount} pages générées`);
    await ftpUpload();
  } else {
    console.log("  Aucun lot vendu — rien à générer.");
  }

  console.log("\n✅ Terminé.");
}

// ─── main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let interval = 60;
let date = todayStr();
let once = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--interval" && args[i + 1]) { interval = parseInt(args[i + 1]); i++; }
  else if (args[i] === "--date" && args[i + 1]) { date = args[i + 1]; i++; }
  else if (args[i] === "--once") { once = true; }
  else if (args[i] === "--help") {
    console.log(`
Interencheres Site Generator

Usage:
  node daemon.mjs                    Lance en boucle (poll 60s)
  node daemon.mjs --once             Exécution unique (pour CI/GitHub Actions)
  node daemon.mjs --interval 30      Poll 30s
  node daemon.mjs --date 2026-03-14  Date spécifique

Config: config.mjs (tag Amazon, AdSense, FTP, etc.)
    `);
    process.exit(0);
  }
}

if (once) {
  runOnce(date).catch(err => { console.error(err); process.exit(1); });
} else {
  runDaemon(date, interval);
}
