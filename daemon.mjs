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

function curlFetch(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = execFileSync("curl", [
        "-s", "--compressed", "--tlsv1.3",
        "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "-H", "Accept: application/json, text/plain, */*",
        "-H", "Accept-Language: fr-FR,fr;q=0.9,en;q=0.8",
        "-H", "Accept-Encoding: gzip, deflate, br",
        "-H", "Referer: https://www.interencheres.com/",
        "-H", "Origin: https://www.interencheres.com",
        "-H", "sec-ch-ua: \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "-H", "sec-ch-ua-mobile: ?0",
        "-H", "sec-ch-ua-platform: \"Windows\"",
        "-H", "sec-fetch-dest: empty",
        "-H", "sec-fetch-mode: cors",
        "-H", "sec-fetch-site: same-site",
        url,
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
      const text = result.toString("utf-8");
      if (text.startsWith("<!")) throw new Error("Cloudflare block — got HTML instead of JSON");
      return JSON.parse(text);
    } catch (err) {
      if (attempt < retries) {
        console.warn(`  ⚠ Retry ${attempt + 1}/${retries}: ${err.message}`);
        execFileSync("sleep", ["2"]);
      } else {
        throw err;
      }
    }
  }
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

function lotSlug(item) {
  const raw = item.description || item.title_translations?.["fr-FR"] || "";
  const words = raw
    .split(/\n/)[0]
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 4)
    .join("-")
    .toLowerCase();
  return `${words || "lot"}-${item.id}`;
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

function ebaySearchUrl(title) {
  const q = String(title || "").substring(0, 120).trim();
  return `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(q)}&mkcid=1&mkrid=709-53476-19255-0&campid=5339108912&toolid=10001`;
}

function amazonButton(title) {
  const amzUrl = amazonSearchUrl(title);
  const ebayUrl = ebaySearchUrl(title);
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:1rem 0;">
    <a href="${esc(amzUrl)}" target="_blank" rel="nofollow noopener" class="amazon-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705a.66.66 0 01-.753.077c-1.06-.878-1.25-1.284-1.828-2.12-1.748 1.784-2.986 2.317-5.249 2.317-2.681 0-4.764-1.655-4.764-4.967 0-2.585 1.401-4.344 3.394-5.205 1.729-.753 4.143-.888 5.986-1.096v-.41c0-.753.058-1.642-.384-2.292-.384-.578-1.117-.817-1.768-.817-1.2 0-2.27.616-2.531 1.891a.644.644 0 01-.549.549l-3.074-.332a.543.543 0 01-.46-.644C6.085 1.526 9.27.2 12.12.2c1.44 0 3.325.384 4.462 1.477 1.44 1.345 1.301 3.14 1.301 5.096v4.617c0 1.388.577 1.997 1.12 2.747.19.268.232.588-.01.786-.606.506-1.683 1.448-2.275 1.975l-.002-.001-.573-.104z"/><path d="M21.83 18.654c-1.906 1.412-4.669 2.16-7.05 2.16-3.337 0-6.342-1.234-8.613-3.29-.179-.161-.019-.381.195-.256 2.453 1.427 5.487 2.284 8.622 2.284 2.114 0 4.436-.438 6.577-1.345.322-.14.594.212.269.447z"/><path d="M22.678 17.535c-.243-.312-1.612-.148-2.228-.075-.187.022-.216-.14-.047-.258 1.09-.766 2.88-.545 3.088-.288.208.26-.055 2.053-1.079 2.91-.157.132-.307.062-.237-.112.23-.574.746-1.864.503-2.177z"/></svg>
      Voir sur Amazon
    </a>
    <a href="${esc(ebayUrl)}" target="_blank" rel="nofollow noopener" class="ebay-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.28 5.46c-1.94 0-3.63 1.01-3.63 3.24 0 1.58.73 2.62 2.21 3.06l-2.5 2.87h1.68l2.16-2.51h.02c.22.02.44.03.67.03.51 0 .98-.06 1.39-.16v2.64h1.35V5.74a8.47 8.47 0 00-2.02-.22l-1.33-.06zm-.13 1.18c.36 0 .79.03 1.22.09v4.08c-.38.1-.81.16-1.28.16-1.38 0-2.22-.77-2.22-2.2 0-1.41.85-2.13 2.28-2.13zM14.42 8c-2.04 0-3.17 1.25-3.17 3.23 0 2.24 1.38 3.21 3.28 3.21.7 0 1.36-.11 1.88-.32l-.25-1.04c-.46.16-.95.24-1.5.24-1.22 0-2.05-.56-2.08-1.82h4.11c.03-.18.04-.4.04-.64C16.73 9.12 15.96 8 14.42 8zm-1.83 2.55c.11-.96.65-1.54 1.63-1.54.95 0 1.38.62 1.38 1.54h-3.01zM17.6 14.3h1.34V5.1H17.6v9.2zM22.25 8c-1.11 0-1.85.53-2.18 1.08h-.03l-.07-.93h-1.18c.04.55.06 1.15.06 1.85v6.93h1.34v-3.37h.02c.34.5 1.01.88 1.93.88 1.55 0 2.89-1.27 2.89-3.3C25.03 9.12 23.8 8 22.25 8zm-.27 5.34c-1.06 0-1.7-.87-1.7-2.04 0-1.26.61-2.17 1.72-2.17 1.16 0 1.72.96 1.72 2.12 0 1.3-.69 2.09-1.74 2.09z"/></svg>
      Voir sur eBay
    </a>
  </div>`;
}

// ─── Shared HTML parts ──────────────────────────────────────────────────────

function htmlHead(title, description, extraHead = "", canonicalPath = "") {
  const siteUrl = config.siteUrl || "";
  const canonical = canonicalPath && siteUrl ? `<link rel="canonical" href="${siteUrl}${canonicalPath}">` : "";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${esc(title)} — ${esc(config.siteName)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index, follow">
  <meta name="google-site-verification" content="_Kyi4x31upT8Ey-EZ-TPUZoFOLBIqW4uLb7iY6MSJNo">
  ${canonical}
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:type" content="website">
  ${canonicalPath && siteUrl ? `<meta property="og:url" content="${siteUrl}${canonicalPath}">` : ""}
  ${config.gaId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${config.gaId}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${config.gaId}');</script>` : ""}
  ${config.adsenseId ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${config.adsenseId}" crossorigin="anonymous"></script>` : ""}
  <script data-goatcounter="https://wildjack.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
  ${extraHead}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0f0f13; --surface: #1a1a24; --surface2: #22222e; --surface3: #2a2a38;
      --text: #e8e8ed; --text2: #9999ab; --text3: #666678;
      --accent: #7c5cfc; --accent2: #9b7dff; --accent-glow: rgba(124,92,252,0.15);
      --green: #34d399; --green-bg: rgba(52,211,153,0.1);
      --red: #f87171; --red-bg: rgba(248,113,113,0.1);
      --gold: #fbbf24; --blue: #60a5fa;
      --border: rgba(255,255,255,0.06); --border2: rgba(255,255,255,0.1);
      --radius: 14px; --radius-sm: 8px;
      --shadow: 0 4px 24px rgba(0,0,0,0.3); --shadow-sm: 0 2px 8px rgba(0,0,0,0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
    a { color: var(--accent2); text-decoration: none; transition: color 0.2s; }
    a:hover { color: #fff; text-decoration: none; }
    ::selection { background: var(--accent); color: #fff; }

    /* Nav */
    .topnav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0; display: flex; align-items: center; gap: 0; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(20px); }
    .topnav .brand { font-weight: 800; font-size: 1.15rem; color: #fff; padding: 0.9rem 2rem; letter-spacing: -0.02em; background: linear-gradient(135deg, var(--accent), #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .topnav a { color: var(--text2); font-size: 0.88rem; padding: 0.9rem 1.2rem; font-weight: 500; transition: all 0.2s; border-bottom: 2px solid transparent; }
    .topnav a:hover { color: #fff; background: var(--accent-glow); border-bottom-color: var(--accent); }

    /* Breadcrumb */
    .breadcrumb { padding: 0.7rem 2rem; font-size: 0.82rem; color: var(--text3); background: var(--surface); border-bottom: 1px solid var(--border); }
    .breadcrumb a { color: var(--text2); }
    .breadcrumb a:hover { color: var(--accent2); }

    /* Layout */
    .container { max-width: 1140px; margin: 1.5rem auto; padding: 0 1.2rem; }
    .grid-2 { display: grid; grid-template-columns: 1fr 300px; gap: 1.5rem; }
    @media (max-width: 800px) { .grid-2 { grid-template-columns: 1fr; } .topnav { flex-wrap: wrap; } .topnav .brand { width: 100%; } }

    /* Cards */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 1.5rem; transition: border-color 0.3s; }
    .card:hover { border-color: var(--border2); }
    .card-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); }
    .card-header h2, .card-header h3 { color: var(--text); font-weight: 700; }
    .card-body { padding: 1.5rem; }

    /* Images */
    .gallery { display: flex; flex-wrap: wrap; gap: 8px; padding: 1.5rem; background: var(--bg); justify-content: center; }
    .gallery img { max-height: 300px; max-width: 100%; border-radius: var(--radius-sm); cursor: pointer; transition: transform 0.2s; }
    .gallery img:hover { transform: scale(1.03); }

    /* Price */
    .price { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; }
    .price.sold { color: var(--green); text-shadow: 0 0 30px rgba(52,211,153,0.3); }
    .price.unsold { color: var(--red); }
    .estimate { color: var(--text3); font-size: 0.9rem; }
    .tag { background: var(--green-bg); color: var(--green); padding: 3px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 600; }

    /* Affiliate buttons */
    .amazon-btn { display: inline-flex; align-items: center; gap: 8px; background: linear-gradient(135deg, #f0c14b, #e6a817); color: #111; padding: 12px 24px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; transition: all 0.25s; box-shadow: 0 2px 12px rgba(240,193,75,0.25); }
    .amazon-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(240,193,75,0.4); text-decoration: none; color: #111; }
    .ebay-btn { display: inline-flex; align-items: center; gap: 8px; background: linear-gradient(135deg, #0064d2, #0050aa); color: #fff; padding: 12px 24px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; transition: all 0.25s; box-shadow: 0 2px 12px rgba(0,100,210,0.25); }
    .ebay-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,100,210,0.4); text-decoration: none; color: #fff; }

    /* Meta table */
    .meta-table { width: 100%; margin-top: 1rem; }
    .meta-table td { padding: 0.5rem 0; vertical-align: top; border-bottom: 1px solid var(--border); }
    .meta-table tr:last-child td { border: 0; }
    .meta-table td:first-child { font-weight: 600; color: var(--text3); width: 120px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Lot grid */
    .lot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1.2rem; }
    .lot-card { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; transition: all 0.3s; position: relative; }
    .lot-card:hover { border-color: var(--accent); transform: translateY(-4px); box-shadow: 0 12px 32px rgba(0,0,0,0.3); }
    .lot-card img { width: 100%; height: 180px; object-fit: cover; transition: transform 0.3s; }
    .lot-card:hover img { transform: scale(1.05); }
    .lot-card .no-img { width: 100%; height: 180px; background: var(--surface3); display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 2.5rem; }
    .lot-card .lot-info { padding: 0.9rem; }
    .lot-card .lot-title { font-size: 0.82rem; font-weight: 500; line-height: 1.4; height: 2.8em; overflow: hidden; color: var(--text); }
    .lot-card .lot-price { font-weight: 800; color: var(--green); margin-top: 0.4rem; font-size: 1rem; }
    .lot-card .lot-cat { font-size: 0.72rem; color: var(--text3); margin-top: 0.3rem; font-weight: 500; }

    /* Lot list row */
    .lot-row { display: flex; align-items: center; gap: 1rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit; transition: all 0.15s; border-radius: var(--radius-sm); }
    .lot-row:hover { background: var(--accent-glow); }
    .lot-row img { width: 56px; height: 42px; object-fit: cover; border-radius: 6px; }
    .lot-row .lot-title { flex: 1; font-size: 0.85rem; color: var(--text); }
    .lot-row .lot-price { font-weight: 700; color: var(--green); white-space: nowrap; }

    /* Sidebar */
    .sidebar .card { margin-bottom: 1rem; }
    .sidebar .card-header h3 { font-size: 0.9rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text2); }
    .cat-list a, .maison-list a { display: flex; justify-content: space-between; align-items: center; padding: 0.45rem 0.5rem; font-size: 0.84rem; border-bottom: 1px solid var(--border); border-radius: 4px; color: var(--text); transition: all 0.15s; }
    .cat-list a:hover, .maison-list a:hover { background: var(--accent-glow); color: var(--accent2); }
    .cat-list a:last-child, .maison-list a:last-child { border: 0; }
    .cat-count { color: var(--text3); font-size: 0.78rem; font-weight: 600; background: var(--surface3); padding: 2px 8px; border-radius: 10px; }

    /* Stats */
    .stat-box { text-align: center; padding: 1.2rem 1.5rem; }
    .stat-number { font-size: 2.2rem; font-weight: 800; letter-spacing: -0.03em; background: linear-gradient(135deg, var(--accent2), var(--blue)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .stat-label { color: var(--text3); font-size: 0.82rem; font-weight: 500; margin-top: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Hero section for home */
    .hero-stats { background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%); border: 1px solid var(--border2); border-radius: var(--radius); padding: 0; margin-bottom: 1.5rem; position: relative; overflow: hidden; }
    .hero-stats::before { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle at 30% 40%, var(--accent-glow) 0%, transparent 50%); pointer-events: none; }
    .hero-stats .stat-box { position: relative; z-index: 1; }

    /* Ad */
    .ad-slot { margin: 1rem 0; text-align: center; min-height: 90px; border-radius: var(--radius-sm); }

    /* Footer */
    .footer { text-align: center; color: var(--text3); padding: 2.5rem; font-size: 0.78rem; margin-top: 2rem; border-top: 1px solid var(--border); }
    .footer a { color: var(--text2); }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--surface3); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text3); }

    /* Light mode */
    [data-theme="light"] {
      --bg: #f4f4f8; --surface: #ffffff; --surface2: #f9f9fc; --surface3: #eeeef2;
      --text: #1a1a2e; --text2: #555568; --text3: #8888a0;
      --accent: #6d4aff; --accent2: #5a3de8; --accent-glow: rgba(109,74,255,0.08);
      --green: #16a34a; --green-bg: rgba(22,163,74,0.08);
      --red: #dc2626; --red-bg: rgba(220,38,38,0.08);
      --gold: #d97706; --blue: #2563eb;
      --border: rgba(0,0,0,0.06); --border2: rgba(0,0,0,0.1);
      --shadow: 0 4px 24px rgba(0,0,0,0.06); --shadow-sm: 0 2px 8px rgba(0,0,0,0.04);
    }
    [data-theme="light"] .stat-number { background: linear-gradient(135deg, var(--accent), var(--blue)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    [data-theme="light"] .price.sold { text-shadow: none; }
    [data-theme="light"] .topnav .brand { background: linear-gradient(135deg, var(--accent), #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    [data-theme="light"] .lot-card { box-shadow: var(--shadow-sm); }
    [data-theme="light"] .lot-card:hover { box-shadow: 0 12px 32px rgba(0,0,0,0.1); }
    [data-theme="light"] .carousel { background: #222; }
    [data-theme="light"] .carousel-dots { background: #222; }
    [data-theme="light"] .carousel-thumbs { background: #222; }

    /* Theme toggle */
    .theme-toggle { background: var(--surface3); border: 1px solid var(--border2); width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; transition: all 0.3s; margin-right: 0.5rem; }
    .theme-toggle:hover { background: var(--accent-glow); border-color: var(--accent); transform: scale(1.1); }

    /* Search */
    .search-wrap { position: relative; margin: 0 0.5rem; }
    .search-input { background: var(--surface3); border: 1px solid var(--border2); color: var(--text); padding: 7px 14px 7px 34px; border-radius: 20px; font-size: 0.84rem; width: 200px; outline: none; transition: all 0.3s; font-family: inherit; }
    .search-input::placeholder { color: var(--text3); }
    .search-input:focus { border-color: var(--accent); background: var(--surface); width: 280px; box-shadow: 0 0 0 3px var(--accent-glow); }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text3); pointer-events: none; font-size: 0.85rem; }
    .search-results { position: absolute; top: 100%; left: 0; right: 0; margin-top: 6px; background: var(--surface); border: 1px solid var(--border2); border-radius: var(--radius-sm); box-shadow: var(--shadow); max-height: 400px; overflow-y: auto; z-index: 200; display: none; min-width: 320px; }
    .search-results.active { display: block; }
    .search-result { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border); text-decoration: none; color: var(--text); transition: background 0.15s; }
    .search-result:hover { background: var(--accent-glow); }
    .search-result img { width: 48px; height: 36px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
    .search-result .sr-title { font-size: 0.82rem; line-height: 1.3; flex: 1; }
    .search-result .sr-price { color: var(--green); font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
    .search-no-result { padding: 1rem; text-align: center; color: var(--text3); font-size: 0.85rem; }
    @media (max-width: 800px) { .search-input { width: 140px; } .search-input:focus { width: 200px; } .search-results { min-width: 260px; } }
  </style>
  <script>
    (function(){
      const t = localStorage.getItem('theme') || 'dark';
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>`;
}

function navHtml() {
  return `<nav class="topnav">
  <span class="brand">${esc(config.siteName)}</span>
  <a href="/index.html">Accueil</a>
  <a href="/categories.html">Catégories</a>
  <span style="flex:1;"></span>
  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input type="text" class="search-input" id="searchInput" placeholder="Rechercher un lot..." autocomplete="off">
    <div class="search-results" id="searchResults"></div>
  </div>
  <button class="theme-toggle" onclick="toggleTheme()" title="Changer de thème" aria-label="Changer de thème">
    <span class="theme-icon">🌙</span>
  </button>
</nav>
<script>
function toggleTheme(){
  const h=document.documentElement;
  const c=h.getAttribute('data-theme')==='light'?'dark':'light';
  h.setAttribute('data-theme',c);
  localStorage.setItem('theme',c);
  document.querySelector('.theme-icon').textContent=c==='light'?'☀️':'🌙';
}
(function(){
  const t=localStorage.getItem('theme')||'dark';
  const i=document.querySelector('.theme-icon');
  if(i)i.textContent=t==='light'?'☀️':'🌙';
})();
// Search
(function(){
  let idx=null;
  const input=document.getElementById('searchInput');
  const results=document.getElementById('searchResults');
  if(!input)return;
  async function loadIndex(){
    if(idx)return idx;
    try{ const r=await fetch('/search-index.json'); idx=await r.json(); }catch(e){ idx=[]; }
    return idx;
  }
  let timer=null;
  input.addEventListener('input',function(){
    clearTimeout(timer);
    const q=this.value.trim().toLowerCase();
    if(q.length<2){results.classList.remove('active');results.innerHTML='';return;}
    timer=setTimeout(async()=>{
      const data=await loadIndex();
      const words=q.split(/\\s+/);
      const matches=data.filter(it=>words.every(w=>it.t.toLowerCase().includes(w))).slice(0,12);
      if(!matches.length){results.innerHTML='<div class="search-no-result">Aucun résultat</div>';results.classList.add('active');return;}
      results.innerHTML=matches.map(m=>\`<a href="/lot/\${m.id}.html" class="search-result">
        \${m.img?\`<img src="\${m.img}" alt="" loading="lazy">\`:''}
        <span class="sr-title">\${m.t.substring(0,80)}</span>
        <span class="sr-price">\${m.p} €</span>
      </a>\`).join('');
      results.classList.add('active');
    },200);
  });
  document.addEventListener('click',function(e){if(!e.target.closest('.search-wrap'))results.classList.remove('active');});
  input.addEventListener('focus',function(){if(results.innerHTML)results.classList.add('active');});
})();
</script>`;
}

function footerHtml() {
  return `<footer class="footer">
  <div style="font-weight:600;color:var(--text2);margin-bottom:0.3rem;">${esc(config.siteName)}</div>
  Résultats de ventes aux enchères en France · Photos · Prix · Estimations<br>
  <span style="color:var(--text3);font-size:0.72rem;">Les liens marchands sont des liens affiliés.</span>
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
  const rawD = item.description || item.title_translations?.["fr-FR"] || "";
  const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
  const title = (lns.length > 1 && lns[0].length < 60) ? lns[0] : lns[0]?.substring(0, 70) || "Objet";
  const price = item.pricing?.auctioned?.price || 0;
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "md") : "";
  const catName = item.category?.name || "";
  const catSlug = catName ? slugify(catName) : "";
  return `<a href="/lot/${lotSlug(item)}.html" class="lot-card">
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
  const rawDesc = item.description || item.title_translations?.["fr-FR"] || "Objet de collection";
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  // If first line is short (<60 chars) and there are more lines → it's a title
  const hasShortTitle = lines.length > 1 && lines[0].length < 60;
  const lotTitle = hasShortTitle ? lines[0] : lines[0]?.substring(0, 70) || "Objet de collection";
  const lotDesc = hasShortTitle ? lines.slice(1).join(" ") : (lines.length > 1 ? lines.slice(1).join(" ") : "");
  const title = rawDesc;
  const shortTitle = lotTitle;
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

  const desc = `${lotTitle} — ${lotDesc ? lotDesc.substring(0, 120) : ""} vendu ${auc.price || 0}€ aux enchères. ${catName}.`;

  const carouselImages = medias.map((m, i) => {
    const src = imgUrl(m, "lg");
    const original = imgUrl(m, "original") || src;
    return { src, original, alt: `${shortTitle} - Photo ${i + 1}` };
  });

  const priceHtml = auc.sold
    ? `<span class="price sold">${formatPrice(auc.price)} €</span>`
    : `<span class="price unsold">Non vendu</span>`;

  const estHtml = est.min != null ? `Estimation : ${formatPrice(est.min)} – ${formatPrice(est.max)} €` : "";

  const carouselCSS = `
    .carousel { position: relative; background: #111; border-radius: 0 0 10px 10px; overflow: hidden; }
    .carousel-main { display: flex; align-items: center; justify-content: center; min-height: 350px; max-height: 500px; }
    .carousel-main img { max-width: 100%; max-height: 500px; object-fit: contain; cursor: zoom-in; }
    .carousel-btn { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.85); border: none; width: 40px; height: 40px; border-radius: 50%; font-size: 1.3rem; cursor: pointer; z-index: 2; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    .carousel-btn:hover { background: #fff; }
    .carousel-prev { left: 10px; }
    .carousel-next { right: 10px; }
    .carousel-dots { display: flex; justify-content: center; gap: 6px; padding: 10px; background: #111; }
    .carousel-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; border: none; cursor: pointer; padding: 0; }
    .carousel-dot.active { background: #fff; }
    .carousel-thumbs { display: flex; gap: 6px; padding: 8px 12px; background: #111; overflow-x: auto; justify-content: center; }
    .carousel-thumbs img { width: 60px; height: 45px; object-fit: cover; border-radius: 4px; cursor: pointer; opacity: 0.5; transition: opacity 0.2s; border: 2px solid transparent; }
    .carousel-thumbs img.active { opacity: 1; border-color: #fff; }
    .carousel-counter { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.6); color: #fff; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; z-index: 2; }
  `;

  const carouselJS = carouselImages.length > 1 ? `
    <script>
    (function(){
      const imgs = ${JSON.stringify(carouselImages.map(i => ({ src: i.src, original: i.original })))};
      let cur = 0;
      const main = document.getElementById('carouselMain');
      const counter = document.getElementById('carouselCounter');
      const dots = document.querySelectorAll('.carousel-dot');
      const thumbs = document.querySelectorAll('.carousel-thumbs img');
      function show(i) {
        cur = (i + imgs.length) % imgs.length;
        main.querySelector('img').src = imgs[cur].src;
        main.querySelector('a').href = imgs[cur].original;
        counter.textContent = (cur+1) + ' / ' + imgs.length;
        dots.forEach((d,j) => d.classList.toggle('active', j===cur));
        thumbs.forEach((t,j) => t.classList.toggle('active', j===cur));
      }
      document.querySelector('.carousel-prev').onclick = () => show(cur-1);
      document.querySelector('.carousel-next').onclick = () => show(cur+1);
      dots.forEach((d,j) => d.onclick = () => show(j));
      thumbs.forEach((t,j) => t.onclick = () => show(j));
      // Swipe support
      let sx=0;
      main.addEventListener('touchstart', e => sx=e.touches[0].clientX);
      main.addEventListener('touchend', e => { const dx=e.changedTouches[0].clientX-sx; if(Math.abs(dx)>40){dx<0?show(cur+1):show(cur-1);} });
    })();
    </script>` : "";

  const carouselHtml = carouselImages.length === 0
    ? `<div class="carousel"><div class="carousel-main" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:#666;font-size:1.5rem;">📦 Pas de photo</div></div>`
    : `<div class="carousel">
        <div class="carousel-main" id="carouselMain">
          <a href="${esc(carouselImages[0].original)}" target="_blank"><img src="${esc(carouselImages[0].src)}" alt="${esc(carouselImages[0].alt)}"></a>
        </div>
        ${carouselImages.length > 1 ? `<button class="carousel-btn carousel-prev">‹</button><button class="carousel-btn carousel-next">›</button>` : ""}
        <span class="carousel-counter" id="carouselCounter">1 / ${carouselImages.length}</span>
        ${carouselImages.length > 1 ? `<div class="carousel-dots">${carouselImages.map((_, i) => `<button class="carousel-dot${i === 0 ? " active" : ""}"></button>`).join("")}</div>` : ""}
        ${carouselImages.length > 1 ? `<div class="carousel-thumbs">${carouselImages.map((img, i) => `<img src="${esc(imgUrl(medias[i], "sm"))}" alt="Thumb ${i + 1}" class="${i === 0 ? "active" : ""}">`).join("")}</div>` : ""}
      </div>`;

  const slug = lotSlug(item);
  const canonicalPath = `/lot/${slug}.html`;
  const ogImage = medias[0] ? imgUrl(medias[0], "lg") : "";

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    "name": lotTitle,
    "description": lotDesc || lotTitle,
    "image": ogImage || undefined,
    "category": catName || undefined,
    "offers": {
      "@type": "Offer",
      "price": auc.price || 0,
      "priceCurrency": "EUR",
      "availability": "https://schema.org/SoldOut",
      "itemCondition": "https://schema.org/UsedCondition"
    }
  });

  return `${htmlHead(`${shortTitle} — ${auc.sold ? auc.price + "€" : "Non vendu"}`, desc, `<style>${carouselCSS}</style>
  ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ""}
  <script type="application/ld+json">${jsonLd}<\/script>`, canonicalPath)}
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
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.3rem;line-height:1.4;">${esc(lotTitle)}</h1>
            ${lotDesc ? `<p style="color:#555;font-size:0.95rem;line-height:1.5;margin-bottom:0.8rem;">${esc(lotDesc)}</p>` : ""}
            <div style="margin:0.5rem 0 1rem;">
              ${priceHtml}
              ${estHtml ? `<span class="estimate" style="margin-left:1rem;">${estHtml}</span>` : ""}
            </div>
          </div>
          ${carouselHtml}
          <div class="card-body">
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
  ${carouselJS}
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

  return `${htmlHead(data.name, desc, "", `/categorie/${slug}.html`)}
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

  return `${htmlHead(`Enchères du ${dateStr}`, `${totalItems} lots vendus aux enchères le ${dateStr}. Photos, prix, estimations.`, "", `/index.html`)}
<body>
  ${navHtml()}
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="hero-stats">
      <div style="display:flex;gap:0;justify-content:center;flex-wrap:wrap;">
        <div class="stat-box"><div class="stat-number">${totalItems}</div><div class="stat-label">objets vendus</div></div>
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
    const slug = lotSlug(item);
    fs.writeFileSync(path.join(SITE_DIR, "lot", `${slug}.html`), generateLotPage(item, sale), "utf-8");
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

  // Search index JSON
  const searchIndex = [...registry.items.values()].map(({ item }) => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const title = (lns.length > 1 && lns[0].length < 60) ? lns[0] + " " + lns.slice(1).join(" ") : lns.join(" ");
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
    const price = formatPrice(item.pricing?.auctioned?.price || 0);
    return { id: lotSlug(item), t: title.substring(0, 150), p: price, img: thumb };
  });
  fs.writeFileSync(path.join(SITE_DIR, "search-index.json"), JSON.stringify(searchIndex), "utf-8");
  pageCount++;

  // Sitemap.xml
  const siteUrl = config.siteUrl || "https://auboisrieur.fr";
  const today = dateStr || new Date().toISOString().slice(0, 10);
  let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  sitemap += `  <url><loc>${siteUrl}/index.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/categories.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  for (const [slug] of registry.categories) {
    sitemap += `  <url><loc>${siteUrl}/categorie/${slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>\n`;
  }
  for (const [, { item }] of registry.items) {
    sitemap += `  <url><loc>${siteUrl}/lot/${lotSlug(item)}.html</loc><lastmod>${today}</lastmod><priority>0.6</priority></url>\n`;
  }
  sitemap += `</urlset>`;
  fs.writeFileSync(path.join(SITE_DIR, "sitemap.xml"), sitemap, "utf-8");

  // robots.txt
  const robots = `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml

User-agent: Googlebot
Allow: /

Disallow: /data/
`;
  fs.writeFileSync(path.join(SITE_DIR, "robots.txt"), robots, "utf-8");
  pageCount += 2;

  // .htaccess — override WordPress completely
  fs.writeFileSync(path.join(SITE_DIR, ".htaccess"), `# Force static site over WordPress
DirectoryIndex index.html index.php

# Correct MIME types
AddType application/xml .xml
AddType text/plain .txt
AddType image/svg+xml .svg
AddType application/json .json

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /

  # Serve sitemap.xml, robots.txt, favicon.svg directly
  RewriteRule ^sitemap\\.xml$ /sitemap.xml [L]
  RewriteRule ^robots\\.txt$ /robots.txt [L]
  RewriteRule ^favicon\\.svg$ /favicon.svg [L]

  # If the requested file exists on disk, serve it (our static HTML)
  RewriteCond %{REQUEST_FILENAME} -f
  RewriteRule ^ - [L]

  # If directory, serve it
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteRule ^ - [L]

  # Homepage
  RewriteRule ^$ /index.html [L]

  # Block WordPress wp-login, wp-admin, xmlrpc
  RewriteRule ^wp-login\\.php$ - [R=404,L]
  RewriteRule ^xmlrpc\\.php$ - [R=404,L]
</IfModule>
`, "utf-8");

  // favicon.svg — maillet d'enchères
  fs.writeFileSync(path.join(SITE_DIR, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#9b7dff"/><stop offset="100%" stop-color="#7c5cfc"/></linearGradient></defs>
  <rect x="8" y="8" width="32" height="14" rx="3" transform="rotate(-45 24 15)" fill="url(#g)"/>
  <rect x="26" y="22" width="6" height="28" rx="2" transform="rotate(-45 29 36)" fill="#7c5cfc"/>
  <ellipse cx="44" cy="54" rx="14" ry="5" fill="#34d399" opacity="0.8"/>
  <rect x="30" y="48" width="28" height="6" rx="2" fill="#34d399"/>
</svg>`, "utf-8");

  return pageCount;
}

// ─── FTP upload ─────────────────────────────────────────────────────────────

async function ftpUpload() {
  if (!config.ftp?.enabled || !config.ftp.host) return;

  const { Client } = await import("basic-ftp");
  const client = new Client(600000); // 10 min timeout
  client.ftp.verbose = false;

  try {
    await client.access({
      host: config.ftp.host,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure || false,
    });

    const remote = (config.ftp.remotePath || "/public_html").replace(/\/+$/, "");

    // Collect all HTML files (skip data/)
    function collectFiles(localDir, remoteDir, files = []) {
      const entries = fs.readdirSync(localDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name === "data") continue;
          collectFiles(path.join(localDir, entry.name), `${remoteDir}/${entry.name}`, files);
        } else if (entry.name.endsWith(".html") || entry.name === ".htaccess") {
          files.push({ local: path.join(localDir, entry.name), remote: `${remoteDir}/${entry.name}` });
        }
      }
      return files;
    }

    const files = collectFiles(SITE_DIR, remote);
    console.log(`  📤 ${files.length} fichiers à uploader vers ${remote}`);

    // Use ensureDir for each unique directory (basic-ftp handles nested creation)
    const dirs = new Set();
    for (const f of files) {
      const dir = f.remote.substring(0, f.remote.lastIndexOf("/"));
      dirs.add(dir);
    }
    for (const dir of [...dirs].sort()) {
      try {
        await client.ensureDir(dir);
      } catch (err) {
        console.warn(`  ⚠ Dossier ${dir}: ${err.message}`);
      }
    }
    console.log(`  📁 ${dirs.size} dossiers vérifiés`);

    // Upload files one by one
    const start = Date.now();
    let uploadCount = 0;
    let errorCount = 0;
    for (const f of files) {
      try {
        await client.uploadFrom(f.local, f.remote);
        uploadCount++;
        if (uploadCount % 100 === 0) console.log(`    ${uploadCount}/${files.length} uploadés...`);
      } catch (err) {
        errorCount++;
        if (errorCount <= 5) console.warn(`  ⚠ Upload ${f.remote}: ${err.message}`);
      }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  📤 FTP terminé: ${uploadCount}/${files.length} fichiers en ${elapsed}s${errorCount ? ` (${errorCount} erreurs)` : ""}`);
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

function yesterdayStr(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function scrapDate(dateStr) {
  const sales = fetchTodaySales(dateStr);
  console.log(`  📅 ${dateStr}: ${sales.length} ventes trouvées`);

  let soldCount = 0;
  for (const sale of sales) {
    try {
      const items = fetchAllItems(sale.id);
      for (const item of items) {
        const auc = item.pricing?.auctioned;
        if (auc?.sold && !registry.items.has(item.id)) {
          registerItem(item, sale);
          soldCount++;
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Vente ${sale.id}: ${err.message}`);
    }
  }
  console.log(`  → ${soldCount} nouveaux lots vendus`);
  return soldCount;
}

async function runOnce(dateStr) {
  ensureDir(SITE_DIR);
  const dataDir = path.join(SITE_DIR, "data");
  ensureDir(dataDir);

  console.log(`\n🏛️  Interenchères — Exécution unique`);
  console.log(`   Amazon tag: ${config.amazonTag}`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  // Scrape yesterday + today to catch late evening sales
  const yesterday = yesterdayStr(dateStr);
  let totalSold = 0;
  totalSold += scrapDate(yesterday);
  totalSold += scrapDate(dateStr);

  console.log(`\n  Total: ${totalSold} lots vendus collectés (${yesterday} + ${dateStr})`);

  if (totalSold > 0) {
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
