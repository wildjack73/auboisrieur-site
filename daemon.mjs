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
 *   ├── ville/<slug>.html             Pages villes (SEO programmatique)
 *   ├── prix/<slug>.html              Pages marques/mots-clés (SEO programmatique)
 *   ├── vente/<id>.html               Pages ventes
 *   ├── jour/<date>.html              Archives par jour
 *   ├── llms.txt                      LLM discovery file
 *   └── llms-full.txt                 LLM full data file
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
const DATA_DIR = path.join(SITE_DIR, "data");

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

function statFontSize(n) {
  const str = formatPrice(n);
  if (str.length > 10) return "1.1rem";
  if (str.length > 7) return "1.3rem";
  if (str.length > 5) return "1.5rem";
  return "1.8rem";
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
  items: new Map(),       // itemId -> item data (sold)
  unsold: new Map(),      // itemId -> item data (unsold)
  sales: new Map(),       // saleId -> { sale, items: [] }
  categories: new Map(),  // categorySlug -> { name, id, description, items: [] }
  maisons: new Map(),     // orgSlug -> { name, city, id, items: [], sales: Set }
};

// ─── Smart re-categorization rules ──────────────────────────────────────────
const RECAT_RULES = [
  // Véhicules
  { pattern: /\b(moto|scooter|cyclo|quad|trottinette|harley.davidson|yamaha.*moto|honda.*moto|kawasaki|suzuki.*moto|ducati|triumph|bmw.*moto|ktm|aprilia|vespa)\b/i, category: "Motos - Scooters - Quads" },
  { pattern: /\b(vélo|bicyclette|vtt|vtc|e-bike|ebike|bike)\b/i, category: "Vélos" },
  { pattern: /\b(bateau|voilier|catamaran|jet.ski|zodiac|semi-rigide|hors.bord)\b/i, category: "Bateaux - Nautisme" },
  { pattern: /\b(tracteur|moissonneuse|engin.*chantier|pelleteuse|chargeuse|manitou|fendt|john.deere|case.*ih|chariot.*élévateur|nacelle)\b/i, category: "Matériel agricole - Espaces verts" },
  // Bijoux & Horlogerie
  { pattern: /\b(bague|collier|bracelet.*or|pendentif|broche|solitaire|diamant|rubis|saphir|émeraude|perle|chaîne.*or|parure|bijou)\b/i, category: "Bijoux - Montres" },
  { pattern: /\b(rolex|omega|cartier.*montre|patek|breitling|tag.*heuer|jaeger|longines|montre.*gousset|montre.*poche|montre.*homme|montre.*femme|chronograph)\b/i, category: "Bijoux - Montres" },
  { pattern: /\b(pendule|horloge|comtoise|cartel|régulateur|garniture.*cheminée)\b/i, category: "Pendules - Horloges - Montres" },
  // Art
  { pattern: /\b(huile.*toile|huile.*panneau|huile.*carton|aquarelle|gouache|pastel|sanguine|tableau.*sign|peinture.*sign)\b/i, category: "Tableaux - Peintures" },
  { pattern: /\b(lithographie|estampe|gravure|eau-forte|sérigraphie|xylographie)\b/i, category: "Estampes - Dessins - Gravures" },
  { pattern: /\b(sculpture|bronze|marbre.*sculpt|buste|statue|terre.*cuite.*sculpt|sujet.*bronze)\b/i, category: "Sculptures" },
  // Mobilier
  { pattern: /\b(commode|armoire|buffet|secrétaire|bureau.*ancien|console|guéridon|table.*louis|fauteuil.*louis|bergère|canapé.*ancien|lit.*baldaquin|bonheur.*jour)\b/i, category: "Mobilier" },
  { pattern: /\b(lustre|lampe.*art.*déco|applique.*bronze|bougeoir|chandelier|lampadaire.*ancien|girandole)\b/i, category: "Luminaires" },
  { pattern: /\b(tapis.*persan|tapis.*orient|kilim|tapisserie.*aubusson|tapisserie.*verdure)\b/i, category: "Tapis - Textiles" },
  // Céramiques & Verre
  { pattern: /\b(vase.*sèvres|porcelaine.*chine|faïence|majolique|grès.*ancien|poterie.*ancien|barbotine|biscuit|compagnie.*indes)\b/i, category: "Céramiques - Faïence - Porcelaine" },
  { pattern: /\b(cristal|lalique|daum|gallé|baccarat|murano|pâte.*verre|verre.*émaillé)\b/i, category: "Verrerie - Cristallerie" },
  // Argenterie
  { pattern: /\b(argenterie|argent.*massif|ménagère.*argent|couverts.*argent|orfèvrerie|christofle|puiforcat)\b/i, category: "Argenterie - Orfèvrerie" },
  // Livres & Collections
  { pattern: /\b(livre.*ancien|manuscrit|incunable|édition.*originale|reliure|atlas.*ancien|carte.*ancienne|bible.*ancien)\b/i, category: "Livres - Manuscrits" },
  { pattern: /\b(bande.*dessinée|bd.*originale|planche.*originale|tintin|astérix|lucky.*luke)\b/i, category: "Bandes dessinées" },
  { pattern: /\b(jouet.*ancien|dinky|solido|train.*miniature|poupée.*ancien|ours.*peluche|automate|jeu.*société.*ancien|playmobil|lego)\b/i, category: "Jouets - Figurines" },
  { pattern: /\b(pièce.*or|pièce.*argent|napoléon.*or|louis.*or|médaille|numismatique|monnaie.*ancienne)\b/i, category: "Numismatique - Monnaies" },
  { pattern: /\b(timbre|philatélie|carnet.*timbre|lettre.*ancienne)\b/i, category: "Philatélie - Timbres" },
  // Mode & Luxe
  { pattern: /\b(hermès|chanel|louis.*vuitton|birkin|kelly.*hermès|gucci|dior|prada|yves.*saint.*laurent|balenciaga|givenchy|valentino|celine)\b/i, category: "Mode - Luxe" },
  { pattern: /\b(sac.*main|sac.*cuir|manteau.*fourrure|vison|étole|foulard.*soie|cravate.*soie)\b/i, category: "Mode - Luxe" },
  // Vins
  { pattern: /\b(bordeaux|bourgogne|champagne|romanée|pétrus|mouton.*rothschild|lafite|margaux|haut-brion|cheval.*blanc|whisky|cognac|armagnac|rhum.*ancien)\b/i, category: "Vins - Spiritueux" },
  // High-tech
  { pattern: /\b(iphone|ipad|macbook|samsung.*galaxy|playstation|xbox|nintendo|aspirateur.*robot|drone|gopro|sony.*alpha|nikon|canon.*eos)\b/i, category: "High-tech - Multimédia" },
  { pattern: /\b(télévision|tv.*oled|tv.*qled|enceinte.*bluetooth|casque.*audio|ordinateur|écran)\b/i, category: "High-tech - Multimédia" },
  // Électroménager
  { pattern: /\b(lave.*linge|lave.*vaisselle|réfrigérateur|congélateur|four|micro-onde|cafetière|robot.*cuisine|thermomix|dyson|kitchenaid)\b/i, category: "Électroménager" },
  // Sports & Loisirs
  { pattern: /\b(golf|tennis|ski|plongée|fitness|musculation|vélo.*appartement|tapis.*course|raquette)\b/i, category: "Sports - Loisirs" },
  // Art asiatique
  { pattern: /\b(chine.*ancien|japon.*ancien|netsuke|jade|céladon|tang|ming|qing|bouddha|gandhara|ivoire.*chine|laque.*japon|estampe.*japon|ukiyo)\b/i, category: "Art d'Asie" },
  // Instruments de musique
  { pattern: /\b(piano|violon|guitare|saxophone|trompette|accordéon|violoncelle|flûte|clarinette|harpe|orgue)\b/i, category: "Instruments de musique" },
  // Armes & Militaria
  { pattern: /\b(fusil|pistolet|carabine|revolver|sabre|épée|baïonnette|casque.*militaire|médaille.*militaire|décorations.*militaire|uniforme.*militaire)\b/i, category: "Armes - Militaria" },
  // Photographie
  { pattern: /\b(photographie.*ancienne|daguerréotype|tirage.*argentique|photo.*vintage|leica|rolleiflex)\b/i, category: "Photographie" },
];

function smartCategory(item) {
  const desc = (item.description || item.title_translations?.["fr-FR"] || "").toLowerCase();
  const currentCat = item.category?.name || "";
  for (const rule of RECAT_RULES) {
    if (rule.pattern.test(desc) && slugify(currentCat) !== slugify(rule.category)) {
      return rule.category;
    }
  }
  return currentCat;
}

function registerItem(item, sale) {
  // Apply smart re-categorization
  const correctedCat = smartCategory(item);
  if (correctedCat && correctedCat !== item.category?.name) {
    item.category = { ...item.category, name: correctedCat };
  }

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

function registerUnsoldItem(item, sale) {
  // Apply smart re-categorization
  const correctedCat = smartCategory(item);
  if (correctedCat && correctedCat !== item.category?.name) {
    item.category = { ...item.category, name: correctedCat };
  }
  registry.unsold.set(item.id, { item, sale });
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
  return `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(q)}&mkcid=1&mkrid=709-53476-19255-0&campid=5339145264&toolid=10001`;
}

function amazonButton(title) {
  const amzUrl = amazonSearchUrl(title);
  const ebayUrl = ebaySearchUrl(title);
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:1rem 0;">
    <a href="${esc(ebayUrl)}" target="_blank" rel="nofollow noopener" class="ebay-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.28 5.46c-1.94 0-3.63 1.01-3.63 3.24 0 1.58.73 2.62 2.21 3.06l-2.5 2.87h1.68l2.16-2.51h.02c.22.02.44.03.67.03.51 0 .98-.06 1.39-.16v2.64h1.35V5.74a8.47 8.47 0 00-2.02-.22l-1.33-.06zm-.13 1.18c.36 0 .79.03 1.22.09v4.08c-.38.1-.81.16-1.28.16-1.38 0-2.22-.77-2.22-2.2 0-1.41.85-2.13 2.28-2.13zM14.42 8c-2.04 0-3.17 1.25-3.17 3.23 0 2.24 1.38 3.21 3.28 3.21.7 0 1.36-.11 1.88-.32l-.25-1.04c-.46.16-.95.24-1.5.24-1.22 0-2.05-.56-2.08-1.82h4.11c.03-.18.04-.4.04-.64C16.73 9.12 15.96 8 14.42 8zm-1.83 2.55c.11-.96.65-1.54 1.63-1.54.95 0 1.38.62 1.38 1.54h-3.01zM17.6 14.3h1.34V5.1H17.6v9.2zM22.25 8c-1.11 0-1.85.53-2.18 1.08h-.03l-.07-.93h-1.18c.04.55.06 1.15.06 1.85v6.93h1.34v-3.37h.02c.34.5 1.01.88 1.93.88 1.55 0 2.89-1.27 2.89-3.3C25.03 9.12 23.8 8 22.25 8zm-.27 5.34c-1.06 0-1.7-.87-1.7-2.04 0-1.26.61-2.17 1.72-2.17 1.16 0 1.72.96 1.72 2.12 0 1.3-.69 2.09-1.74 2.09z"/></svg>
      Voir sur eBay
    </a>
    <a href="${esc(amzUrl)}" target="_blank" rel="nofollow noopener" class="amazon-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M13.958 10.09c0 1.232.029 2.256-.591 3.351-.502.891-1.301 1.438-2.186 1.438-1.214 0-1.922-.924-1.922-2.292 0-2.692 2.415-3.182 4.7-3.182v.685zm3.186 7.705a.66.66 0 01-.753.077c-1.06-.878-1.25-1.284-1.828-2.12-1.748 1.784-2.986 2.317-5.249 2.317-2.681 0-4.764-1.655-4.764-4.967 0-2.585 1.401-4.344 3.394-5.205 1.729-.753 4.143-.888 5.986-1.096v-.41c0-.753.058-1.642-.384-2.292-.384-.578-1.117-.817-1.768-.817-1.2 0-2.27.616-2.531 1.891a.644.644 0 01-.549.549l-3.074-.332a.543.543 0 01-.46-.644C6.085 1.526 9.27.2 12.12.2c1.44 0 3.325.384 4.462 1.477 1.44 1.345 1.301 3.14 1.301 5.096v4.617c0 1.388.577 1.997 1.12 2.747.19.268.232.588-.01.786-.606.506-1.683 1.448-2.275 1.975l-.002-.001-.573-.104z"/><path d="M21.83 18.654c-1.906 1.412-4.669 2.16-7.05 2.16-3.337 0-6.342-1.234-8.613-3.29-.179-.161-.019-.381.195-.256 2.453 1.427 5.487 2.284 8.622 2.284 2.114 0 4.436-.438 6.577-1.345.322-.14.594.212.269.447z"/><path d="M22.678 17.535c-.243-.312-1.612-.148-2.228-.075-.187.022-.216-.14-.047-.258 1.09-.766 2.88-.545 3.088-.288.208.26-.055 2.053-1.079 2.91-.157.132-.307.062-.237-.112.23-.574.746-1.864.503-2.177z"/></svg>
      Voir sur Amazon
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23a78bfa'/%3E%3Cstop offset='100%25' stop-color='%237c5cfc'/%3E%3C/linearGradient%3E%3ClinearGradient id='g2' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%2334d399'/%3E%3Cstop offset='100%25' stop-color='%232dd4bf'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='14' y='6' width='28' height='12' rx='4' transform='rotate(-40 28 12)' fill='url(%23g)'/%3E%3Crect x='24' y='16' width='5' height='24' rx='2.5' transform='rotate(-40 26.5 28)' fill='%237c5cfc'/%3E%3Crect x='10' y='49' width='44' height='7' rx='3.5' fill='url(%23g2)'/%3E%3Crect x='16' y='44' width='32' height='7' rx='2' fill='url(%23g2)' opacity='0.6'/%3E%3C/svg%3E">
  <title>${title.includes("Adjugé") ? esc(title) : esc(title) + " — " + esc(config.siteName)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
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
  <script src="/search-data.js" defer></script>
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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { overflow-x: hidden; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; scroll-behavior: smooth; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; overflow-x: hidden; min-height: 100vh; }
    img, svg, video { display: block; max-width: 100%; }
    img { height: auto; }
    input, button, textarea, select { font: inherit; color: inherit; }
    button { cursor: pointer; border: none; background: none; }
    table { border-collapse: collapse; border-spacing: 0; }
    h1, h2, h3, h4 { line-height: 1.3; text-wrap: balance; }
    p { text-wrap: pretty; }
    a { color: var(--accent2); text-decoration: none; transition: color 0.2s; }
    a:hover { color: #fff; text-decoration: none; }
    ::selection { background: var(--accent); color: #fff; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Nav */
    .topnav { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0; display: flex; align-items: center; gap: 0; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(20px); }
    .topnav .brand { padding: 0.9rem 1.2rem 0.9rem 1.5rem; border-bottom: none !important; display: flex; align-items: center; gap: 8px; }
    .topnav .brand:hover { background: none; }
    .topnav .brand svg { flex-shrink: 0; }
    .brand-text { font-weight: 800; font-size: 1.5rem; letter-spacing: -0.02em; background: linear-gradient(135deg, var(--accent), #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .topnav .brand:hover .brand-text { background: linear-gradient(135deg, #a78bfa, #c4b5fd); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .topnav a { color: var(--text2); font-size: 1.15rem; padding: 0.9rem 1.3rem; font-weight: 600; transition: all 0.2s; border-bottom: 2px solid transparent; }
    .topnav a:hover { color: #fff; background: var(--accent-glow); border-bottom-color: var(--accent); }

    /* Breadcrumb */
    .breadcrumb { padding: 0.7rem 2rem; font-size: 0.82rem; color: var(--text3); background: var(--surface); border-bottom: 1px solid var(--border); }
    .breadcrumb a { color: var(--text2); }
    .breadcrumb a:hover { color: var(--accent2); }

    /* Layout */
    .container { max-width: 1140px; margin: 1.5rem auto; padding: 0 1.2rem; overflow: hidden; word-break: break-word; }
    .grid-2 { display: grid; grid-template-columns: 1fr 300px; gap: 1.5rem; overflow: hidden; }
    .grid-2 > main { min-width: 0; overflow: hidden; max-width: 100%; }
    /* Hamburger button */
    .hamburger { display: none; background: none; border: none; color: var(--text); font-size: 1.5rem; padding: 0.6rem 0.8rem; cursor: pointer; line-height: 1; }
    .nav-links { display: none; }
    .cat-desc { max-height: 5.5em; overflow: hidden; position: relative; transition: max-height 0.3s ease; }
    .cat-desc.expanded { max-height: none; }
    .cat-desc-toggle { display: block; text-align: center; color: var(--accent); font-size: 0.85rem; padding: 0.5rem; cursor: pointer; }

    @media (max-width: 800px) {
      .grid-2 { grid-template-columns: 1fr; }
      .topnav { padding: 0 0.3rem; flex-wrap: wrap; }
      .topnav .brand { padding: 0.6rem 0.4rem 0.6rem 0.6rem; font-size: 0.9rem; gap: 5px; }
      .topnav .brand svg { width: 20px; height: 20px; }
      .brand-text { font-size: 1.05rem; }
      .hamburger { display: block; }
      .nav-links { display: none; flex-direction: column; width: 100%; order: 10; background: var(--surface); border-top: 1px solid var(--border); }
      .nav-links.open { display: flex; }
      .nav-links a { padding: 0.9rem 1.2rem; font-size: 1.05rem; border-bottom: 1px solid var(--border); width: 100%; box-sizing: border-box; }
      .topnav > .search-wrap { order: 5; flex: 1; margin: 0 0.3rem; }
      .desk-link { display: none !important; }
      .container { margin: 0.8rem auto; padding: 0 0.6rem; }
      .breadcrumb { padding: 0.5rem 0.8rem; font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .card-body { padding: 1rem; }
      .card-header { padding: 0.8rem 1rem; }
      .price { font-size: 1.5rem; }
      .estimate { display: block; margin-top: 0.3rem; margin-left: 0 !important; }
      .lot-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.8rem; }
      .lot-card img { height: 140px; }
      .lot-card .lot-info { padding: 0.6rem; }
      .lot-card .lot-title { font-size: 0.75rem; }
      .amazon-btn, .ebay-btn { padding: 10px 16px; font-size: 0.82rem; }
      .stat-number { font-size: 1.4rem; }
      .stat-label { font-size: 0.7rem; }
      .hero-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
      .stat-box { padding: 0.8rem 0.3rem; }
      h1 { font-size: 1.15rem !important; }
      .cat-desc { max-height: 4.5em; }
    }

    /* Cards */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 1.5rem; transition: border-color 0.3s; max-width: 100%; box-sizing: border-box; }
    .card:hover { border-color: var(--border2); }
    .card-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); }
    .card-header h2, .card-header h3 { color: var(--text); font-weight: 700; }
    .card-body { padding: 1.5rem; overflow: hidden; word-break: break-word; overflow-wrap: break-word; max-width: 100%; box-sizing: border-box; }

    /* Images */
    .gallery { display: flex; flex-wrap: wrap; gap: 8px; padding: 1.5rem; background: var(--bg); justify-content: center; max-width: 100%; box-sizing: border-box; }
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
    .meta-table td { color: var(--text); }
    .meta-table td:first-child { font-weight: 600; color: var(--text2); width: 120px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }

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
    [data-theme="light"] .brand-text { background: linear-gradient(135deg, var(--accent), #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    [data-theme="light"] .topnav .brand:hover .brand-text { background: linear-gradient(135deg, #7c3aed, #6d28d9); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    [data-theme="light"] .lot-card { box-shadow: var(--shadow-sm); }
    [data-theme="light"] .lot-card:hover { box-shadow: 0 12px 32px rgba(0,0,0,0.1); }
    [data-theme="light"] .carousel { background: #222; }
    [data-theme="light"] .carousel-dots { background: #222; }
    [data-theme="light"] .carousel-thumbs { background: #222; }

    /* Brand logos */
    .brand-logo { display: block; height: 36px; width: auto; }
    .brand-logo-light { display: none; }
    [data-theme="light"] .brand-logo-dark { display: none; }
    [data-theme="light"] .brand-logo-light { display: block; }

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
    @media (max-width: 800px) {
      .search-wrap { flex: 1; margin: 0 0.3rem; max-width: 50%; }
      .search-input { width: 100%; font-size: 0.8rem; padding: 6px 10px 6px 30px; }
      .search-input:focus { width: 100%; }
      .search-results { min-width: 0; left: -40px; right: -40px; }
    }
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
  <a href="/index.html" class="brand"><svg viewBox="0 0 64 64" width="28" height="28" style="flex-shrink:0;"><defs><linearGradient id="ng" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c5cfc"/></linearGradient></defs><rect x="14" y="6" width="28" height="12" rx="4" transform="rotate(-40 28 12)" fill="url(#ng)"/><rect x="24" y="16" width="5" height="24" rx="2.5" transform="rotate(-40 26.5 28)" fill="#7c5cfc"/><rect x="10" y="49" width="44" height="7" rx="3.5" fill="#34d399"/><rect x="16" y="44" width="32" height="7" rx="2" fill="#34d399" opacity="0.6"/></svg><span class="brand-text">Adjugé !</span></a>
  <a href="/index.html" class="desk-link">Accueil</a>
  <a href="/categories.html" class="desk-link">Catégories</a>
  <a href="/villes.html" class="desk-link">Villes</a>
  <a href="/top-ventes.html" class="desk-link">🏆 Top</a>
  <a href="/invendus.html" class="desk-link">Invendus</a>
  <a href="/statistiques.html" class="desk-link">Statistiques</a>
  <span style="flex:1;"></span>
  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input type="text" class="search-input" id="searchInput" placeholder="Rechercher..." autocomplete="off">
    <div class="search-results" id="searchResults"></div>
  </div>
  <button class="theme-toggle" onclick="toggleTheme()" title="Changer de thème" aria-label="Changer de thème">
    <span class="theme-icon">🌙</span>
  </button>
  <button class="hamburger" onclick="document.getElementById('navLinks').classList.toggle('open')" aria-label="Menu">☰</button>
  <div class="nav-links" id="navLinks">
    <a href="/index.html">🏠 Accueil</a>
    <a href="/categories.html">📂 Catégories</a>
    <a href="/villes.html">📍 Villes</a>
    <a href="/top-ventes.html">🏆 Top Ventes</a>
    <a href="/invendus.html">📦 Invendus</a>
    <a href="/statistiques.html">📊 Statistiques</a>
    <a href="/a-propos.html">ℹ️ À propos</a>
  </div>
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
// Search (uses window.__SI loaded via search-data.js)
(function(){
  const input=document.getElementById('searchInput');
  const results=document.getElementById('searchResults');
  if(!input)return;
  let timer=null;
  input.addEventListener('input',function(){
    clearTimeout(timer);
    const q=this.value.trim().toLowerCase();
    if(q.length<2){results.classList.remove('active');results.innerHTML='';return;}
    timer=setTimeout(()=>{
      const data=window.__SI||[];
      const words=q.split(/\\s+/).filter(w=>w.length>0);
      const scored=data.filter(it=>words.every(w=>it.t.toLowerCase().includes(w))).map(it=>{
        const tl=it.t.toLowerCase();
        let score=0;
        words.forEach(w=>{if(tl.includes(w))score+=10;else score+=1;});
        if(tl.startsWith(q))score+=20;
        return{...it,score};
      }).sort((a,b)=>b.score-a.score);
      const matches=scored.slice(0,12);
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
  <div style="margin-top:0.5rem;">
    <a href="/mentions-legales.html" style="color:var(--text3);text-decoration:none;font-size:0.75rem;margin:0 0.5rem;">Mentions légales</a>·
    <a href="/politique-confidentialite.html" style="color:var(--text3);text-decoration:none;font-size:0.75rem;margin:0 0.5rem;">Politique de confidentialité</a>·
    <a href="/a-propos.html" style="color:var(--text3);text-decoration:none;font-size:0.75rem;margin:0 0.5rem;">À propos</a>·
    <a href="/statistiques.html" style="color:var(--text3);text-decoration:none;font-size:0.75rem;margin:0 0.5rem;">Statistiques</a>
  </div>
  <span style="color:var(--text3);font-size:0.72rem;">Les liens marchands sont des liens affiliés.</span>
</footer>`;
}

function sidebarHtml() {
  // Top categories
  const cats = [...registry.categories.entries()]
    .sort((a, b) => b[1].items.length - a[1].items.length)
    .slice(0, 15);

  // Top 10 most expensive
  const topExpensive = [...registry.items.values()]
    .sort((a, b) => (b.item.pricing?.auctioned?.price || 0) - (a.item.pricing?.auctioned?.price || 0))
    .slice(0, 10);

  // Top cities
  const cityMap = new Map();
  for (const [, { item, sale }] of registry.items) {
    const city = sale?.address?.city || item.sale?.address?.city || "";
    if (city) {
      const cs = slugify(city);
      if (!cityMap.has(cs)) cityMap.set(cs, { name: city, count: 0 });
      cityMap.get(cs).count++;
    }
  }
  const topCities = [...cityMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);

  return `<aside class="sidebar">
    ${adSlot("sidebar")}
    <div class="card">
      <div class="card-header"><h3>🏆 Top 10 ventes</h3></div>
      <div class="card-body" style="padding:0;">
        ${topExpensive.map(({ item }, i) => {
          const rawD = item.description || item.title_translations?.["fr-FR"] || "";
          const lns = rawD.split("\\n").map(l => l.trim()).filter(Boolean);
          const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 50) || "Objet");
          const price = item.pricing?.auctioned?.price || 0;
          const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
          return `<a href="/lot/${lotSlug(item)}.html" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);text-decoration:none;color:var(--text);transition:background 0.15s;">
            <span style="font-weight:800;font-size:1.1rem;color:var(--accent);min-width:22px;">${i + 1}</span>
            ${thumb ? `<img src="${esc(thumb)}" alt="" style="width:44px;height:33px;object-fit:cover;border-radius:4px;flex-shrink:0;">` : ""}
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(title)}</div>
              <div style="font-size:0.82rem;font-weight:700;color:var(--green);">${formatPrice(price)} €</div>
            </div>
          </a>`;
        }).join("")}
        <a href="/top-ventes.html" style="display:block;text-align:center;padding:12px;font-weight:600;font-size:0.85rem;color:var(--accent2);border-top:1px solid var(--border);">Voir le classement complet →</a>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>Catégories</h3></div>
      <div class="card-body cat-list">
        ${cats.map(([slug, c]) => {
          const catName = c._aiName || c.name;
          return `<a href="/categorie/${slug}.html">${esc(catName)} <span class="cat-count">(${c.items.length})</span></a>`;
        }).join("\n        ")}
        <a href="/categories.html" style="margin-top:0.5rem;font-weight:600;">Toutes les catégories →</a>
      </div>
    </div>
    ${topCities.length > 0 ? `<div class="card">
      <div class="card-header"><h3>📍 Villes</h3></div>
      <div class="card-body cat-list">
        ${topCities.map(([cs, c]) => `<a href="/ville/${cs}.html">${esc(c.name)} <span class="cat-count">(${c.count})</span></a>`).join("\n        ")}
        <a href="/villes.html" style="margin-top:0.5rem;font-weight:600;">Toutes les villes →</a>
      </div>
    </div>` : ""}
    ${adSlot("sidebar")}
    <div style="padding:1rem 0.5rem;display:flex;flex-wrap:wrap;gap:0.3rem 1rem;justify-content:center;">
      <a href="/mentions-legales.html" style="color:var(--text3);text-decoration:none;font-size:0.72rem;">Mentions légales</a>
      <a href="/politique-confidentialite.html" style="color:var(--text3);text-decoration:none;font-size:0.72rem;">Confidentialité</a>
    </div>
  </aside>`;
}

function lotCard(item) {
  const rawD = item.description || item.title_translations?.["fr-FR"] || "";
  const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
  const fallback = (lns.length > 1 && lns[0].length < 60) ? lns[0] : lns[0]?.substring(0, 70) || "Objet";
  const title = item._aiTitle || fallback;
  const price = item.pricing?.auctioned?.price || 0;
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
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

// Clean raw description: remove expo/viewing info, license plates used as titles, etc.
function cleanRawDesc(raw) {
  return raw.split("\n").map(l => l.trim()).filter(l => {
    if (!l) return false;
    // Remove exhibition/viewing lines
    if (/^expo(sition)?\s+(le|du|les|:)/i.test(l)) return false;
    if (/^visite\s+(le|du|les|:)/i.test(l)) return false;
    if (/^retrait\s+(le|du|les|:)/i.test(l)) return false;
    if (/^\d{1,2}h\d{0,2}\s*(à|au)\s*\d{1,2}h/i.test(l)) return false;
    // Remove lines that are just addresses
    if (/^\d+\s+(rue|av\.|avenue|boulevard|bd|impasse|chemin|allée|place)\s/i.test(l)) return false;
    // Remove "A partir de X€" lines
    if (/^à partir de\s+\d/i.test(l)) return false;
    return true;
  }).join("\n");
}

// Extract a meaningful title from raw description (skip license plates, lot numbers, etc.)
function extractTitle(rawDesc) {
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  // Skip lines that are just license plates (XX-123-YY or XX 123 YY)
  const isLicensePlate = (s) => /^[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}$/i.test(s.trim());
  const isLotNumber = (s) => /^(lot\s*n?°?\s*\d|n°?\s*\d)/i.test(s.trim());
  const isJustNumber = (s) => /^\d+$/.test(s.trim());

  // Find the first meaningful line
  for (const line of lines) {
    if (isLicensePlate(line) || isLotNumber(line) || isJustNumber(line)) continue;
    if (line.length < 3) continue;
    return line.length > 70 ? line.substring(0, 70) : line;
  }
  // If all lines are plates/numbers, try joining first two meaningful words
  return lines[0]?.substring(0, 70) || "Objet de collection";
}

function generateLotPage(item, sale) {
  const rawDescOriginal = item.description || item.title_translations?.["fr-FR"] || "Objet de collection";
  const rawDesc = cleanRawDesc(rawDescOriginal);
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  const fallbackTitle = extractTitle(rawDesc);
  // Use remaining lines as fallback description
  const titleLine = fallbackTitle;
  const descLines = lines.filter(l => l !== titleLine);
  const fallbackDesc = descLines.join(" ").trim();
  // Use AI-enriched title/desc if available
  const lotTitle = item._aiTitle || fallbackTitle;
  const lotDesc = item._aiDesc || fallbackDesc;
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

  const desc = `${lotTitle} adjugé ${formatPrice(auc.price || 0)} € aux enchères. Voir photos, estimation et lots similaires sur Adjugé !`;

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
    .carousel { position: relative; background: #111; border-radius: 0 0 10px 10px; overflow: hidden; width: 100%; max-width: 100%; box-sizing: border-box; }
    .carousel-main { display: flex; align-items: center; justify-content: center; min-height: 280px; max-height: 450px; padding: 1rem 50px; overflow: hidden; box-sizing: border-box; }
    .carousel-main img { max-width: 100%; max-height: 430px; object-fit: contain; cursor: zoom-in; display: block; }
    .carousel-btn { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.85); border: none; width: 40px; height: 40px; border-radius: 50%; font-size: 1.3rem; cursor: pointer; z-index: 2; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    .carousel-btn:hover { background: #fff; }
    .carousel-prev { left: 10px; }
    .carousel-next { right: 10px; }
    .carousel-dots { display: flex; justify-content: center; gap: 6px; padding: 10px; background: #111; flex-wrap: wrap; max-width: 100%; overflow: hidden; box-sizing: border-box; }
    .carousel-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; border: none; cursor: pointer; padding: 0; flex-shrink: 0; }
    .carousel-dot.active { background: #fff; }
    .carousel-thumbs { display: flex; gap: 6px; padding: 8px 12px; background: #111; overflow-x: auto; max-width: 100%; box-sizing: border-box; -webkit-overflow-scrolling: touch; }
    .carousel-thumbs img { width: 60px; height: 45px; object-fit: cover; border-radius: 4px; cursor: pointer; opacity: 0.5; transition: opacity 0.2s; border: 2px solid transparent; flex-shrink: 0; }
    .carousel-thumbs img.active { opacity: 1; border-color: #fff; }
    .carousel-counter { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.6); color: #fff; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; z-index: 2; }
    /* Lightbox */
    .lightbox { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.92); z-index: 9999; align-items: center; justify-content: center; flex-direction: column; backdrop-filter: blur(8px); }
    .lightbox.active { display: flex; }
    .lightbox img { max-width: 92vw; max-height: 85vh; object-fit: contain; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,0.5); }
    .lightbox-close { position: absolute; top: 16px; right: 20px; background: rgba(255,255,255,0.15); border: none; color: #fff; width: 44px; height: 44px; border-radius: 50%; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; z-index: 10000; }
    .lightbox-close:hover { background: rgba(255,255,255,0.3); }
    .lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); border: none; color: #fff; width: 48px; height: 48px; border-radius: 50%; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; }
    .lightbox-nav:hover { background: rgba(255,255,255,0.3); }
    .lightbox-prev { left: 16px; }
    .lightbox-next { right: 16px; }
    .lightbox-counter { position: absolute; bottom: 20px; color: rgba(255,255,255,0.7); font-size: 0.9rem; font-weight: 500; }
    @media (max-width: 800px) {
      .carousel-main { min-height: 200px; max-height: 320px; padding: 0.5rem 36px; }
      .carousel-main img { max-height: 300px; }
      .carousel-btn { width: 32px; height: 32px; font-size: 1rem; }
      .carousel-prev { left: 4px; }
      .carousel-next { right: 4px; }
      .carousel-thumbs { padding: 6px 8px; gap: 4px; }
      .carousel-thumbs img { width: 48px; height: 36px; }
      .carousel-dots { gap: 4px; padding: 6px; }
      .carousel-dot { width: 6px; height: 6px; }
      .lightbox img { max-width: 96vw; max-height: 80vh; }
      .lightbox-nav { width: 38px; height: 38px; font-size: 1.2rem; }
      .lightbox-prev { left: 8px; }
      .lightbox-next { right: 8px; }
    }
  `;

  const lightboxJS = `
    <script>
    (function(){
      const imgs = ${JSON.stringify(carouselImages.map(i => ({ src: i.src, original: i.original })))};
      let cur = 0;
      const lb = document.getElementById('lightbox');
      const lbImg = document.getElementById('lbImg');
      const lbCounter = document.getElementById('lbCounter');
      ${carouselImages.length > 1 ? `
      const main = document.getElementById('carouselMain');
      const counter = document.getElementById('carouselCounter');
      const dots = document.querySelectorAll('.carousel-dot');
      const thumbs = document.querySelectorAll('.carousel-thumbs img');
      function show(i) {
        cur = (i + imgs.length) % imgs.length;
        main.querySelector('img').src = imgs[cur].src;
        counter.textContent = (cur+1) + ' / ' + imgs.length;
        dots.forEach((d,j) => d.classList.toggle('active', j===cur));
        thumbs.forEach((t,j) => t.classList.toggle('active', j===cur));
      }
      document.querySelector('.carousel-prev').onclick = () => show(cur-1);
      document.querySelector('.carousel-next').onclick = () => show(cur+1);
      dots.forEach((d,j) => d.onclick = () => show(j));
      thumbs.forEach((t,j) => t.onclick = () => show(j));
      // Swipe on carousel
      let sx=0;
      main.addEventListener('touchstart', e => sx=e.touches[0].clientX);
      main.addEventListener('touchend', e => { const dx=e.changedTouches[0].clientX-sx; if(Math.abs(dx)>40){dx<0?show(cur+1):show(cur-1);} });
      ` : ''}

      // Lightbox
      function openLb(i) {
        cur = (i + imgs.length) % imgs.length;
        lbImg.src = imgs[cur].original || imgs[cur].src;
        lbCounter.textContent = (cur+1) + ' / ' + imgs.length;
        lb.classList.add('active');
        document.body.style.overflow = 'hidden';
      }
      function closeLb() {
        lb.classList.remove('active');
        document.body.style.overflow = '';
      }
      function lbNav(dir) {
        cur = (cur + dir + imgs.length) % imgs.length;
        lbImg.src = imgs[cur].original || imgs[cur].src;
        lbCounter.textContent = (cur+1) + ' / ' + imgs.length;
      }

      // Click on carousel main image → open lightbox
      document.getElementById('carouselMain').querySelector('img').onclick = function() { openLb(cur); };
      // Lightbox controls
      document.getElementById('lbClose').onclick = closeLb;
      ${carouselImages.length > 1 ? `
      document.getElementById('lbPrev').onclick = function() { lbNav(-1); };
      document.getElementById('lbNext').onclick = function() { lbNav(1); };
      ` : ''}
      // Close on backdrop click
      lb.onclick = function(e) { if (e.target === lb) closeLb(); };
      // Close on Escape
      document.addEventListener('keydown', function(e) {
        if (!lb.classList.contains('active')) return;
        if (e.key === 'Escape') closeLb();
        ${carouselImages.length > 1 ? `
        if (e.key === 'ArrowLeft') lbNav(-1);
        if (e.key === 'ArrowRight') lbNav(1);
        ` : ''}
      });
      // Swipe on lightbox
      let lsx=0;
      lbImg.addEventListener('touchstart', function(e) { lsx=e.touches[0].clientX; });
      lbImg.addEventListener('touchend', function(e) { const dx=e.changedTouches[0].clientX-lsx; if(Math.abs(dx)>40){dx<0?lbNav(1):lbNav(-1);} });
    })();
    </script>`;

  const lightboxHtml = carouselImages.length > 0 ? `
    <div class="lightbox" id="lightbox">
      <button class="lightbox-close" id="lbClose" aria-label="Fermer">✕</button>
      ${carouselImages.length > 1 ? `<button class="lightbox-nav lightbox-prev" id="lbPrev">‹</button><button class="lightbox-nav lightbox-next" id="lbNext">›</button>` : ""}
      <img id="lbImg" src="" alt="Zoom">
      <span class="lightbox-counter" id="lbCounter"></span>
    </div>` : "";

  const carouselHtml = carouselImages.length === 0
    ? `<div class="carousel"><div class="carousel-main" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:1.5rem;">📦 Pas de photo</div></div>`
    : `<div class="carousel">
        <div class="carousel-main" id="carouselMain">
          <img src="${esc(carouselImages[0].src)}" alt="${esc(carouselImages[0].alt)}" style="cursor:zoom-in;">
        </div>
        ${carouselImages.length > 1 ? `<button class="carousel-btn carousel-prev">‹</button><button class="carousel-btn carousel-next">›</button>` : ""}
        <span class="carousel-counter" id="carouselCounter">1 / ${carouselImages.length}</span>
        ${carouselImages.length > 1 && carouselImages.length <= 20 ? `<div class="carousel-dots">${carouselImages.map((_, i) => `<button class="carousel-dot${i === 0 ? " active" : ""}"></button>`).join("")}</div>` : ""}
        ${carouselImages.length > 1 ? `<div class="carousel-thumbs">${carouselImages.map((img, i) => `<img src="${esc(imgUrl(medias[i], "sm"))}" alt="Thumb ${i + 1}" class="${i === 0 ? "active" : ""}">`).join("")}</div>` : ""}
      </div>`;

  const slug = lotSlug(item);
  const canonicalPath = `/lot/${slug}.html`;
  const ogImage = medias[0] ? imgUrl(medias[0], "lg") : "";

  const jsonLdProduct = {
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
  };

  // FAQ Schema for GEO
  const faqSchema = item._aiFaq?.length ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": item._aiFaq.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a }
    }))
  } : null;

  const lotPageTitle = auc.sold
    ? `${shortTitle} — Adjugé ${formatPrice(auc.price)}€ aux enchères | Adjugé !`
    : `${shortTitle} — Non vendu aux enchères | Adjugé !`;

  return `${htmlHead(lotPageTitle, desc, `<style>${carouselCSS}</style>
  ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ""}
  <script type="application/ld+json">${JSON.stringify(jsonLdProduct)}<\/script>
  ${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}<\/script>` : ""}`, canonicalPath)}
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
          <div class="card-body" style="padding-bottom:0.5rem;">
            <h1 style="font-size:1.4rem;margin-bottom:0.3rem;line-height:1.4;overflow-wrap:break-word;word-break:break-word;">${esc(lotTitle)}</h1>
            <div style="margin:0.5rem 0 0.8rem;">
              ${priceHtml}
              ${estHtml ? `<span class="estimate" style="margin-left:1rem;">${estHtml}</span>` : ""}
            </div>
            ${adSlot("inArticle", "margin:0.8rem 0;")}
          </div>
          ${carouselHtml}
          <div class="card-body">
            ${amazonButton(shortTitle)}

            ${(() => {
              // Auto-generated context paragraph for ALL lots (AI or not)
              const priceVal = auc.price || 0;
              const contextParts = [];
              contextParts.push(`Ce lot${catName ? ` de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a>` : ""} a été ${auc.sold ? `adjugé <strong>${formatPrice(priceVal)} €</strong>` : "présenté"} aux enchères${saleDate ? ` le ${saleDate}` : ""}${org ? ` par la maison <a href="/maison/${orgSlug}.html" style="color:var(--accent);">${esc(org)}</a>` : ""}${city ? ` à <a href="/ville/${slugify(city)}.html" style="color:var(--accent);">${esc(city)}</a>` : ""}.`);
              if (est.min != null) contextParts.push(`L'estimation de cet objet était comprise entre <strong>${formatPrice(est.min)} €</strong> et <strong>${formatPrice(est.max)} €</strong>.`);
              if (saleName) contextParts.push(`Il faisait partie de la vente « ${esc(saleName)} ».`);

              // AI description (rich)
              if (item._aiDesc) {
                const descText = esc(item._aiDesc);
                let paragraphs = descText.split(/\n\n+/).filter(p => p.trim());
                if (paragraphs.length === 1 && descText.length > 400) {
                  const sentences = descText.split(/(?<=[.!?])\s+/);
                  paragraphs = [];
                  let current = "";
                  for (const s of sentences) {
                    if (current.length + s.length > 300 && current.length > 0) {
                      paragraphs.push(current.trim());
                      current = s;
                    } else {
                      current += (current ? " " : "") + s;
                    }
                  }
                  if (current.trim()) paragraphs.push(current.trim());
                }
                const isLong = descText.length > 800;
                const visibleParas = isLong ? paragraphs.slice(0, 3) : paragraphs;
                const hiddenParas = isLong ? paragraphs.slice(3) : [];
                return `<div style="color:var(--text);font-size:0.95rem;line-height:1.8;margin-bottom:1rem;overflow-wrap:break-word;max-width:100%;">
                  ${visibleParas.map(p => `<p style="margin-bottom:0.8rem;">${p}</p>`).join("")}
                  ${hiddenParas.length > 0 ? `<div id="descMore" style="display:none;">
                    ${hiddenParas.map(p => `<p style="margin-bottom:0.8rem;">${p}</p>`).join("")}
                  </div>
                  <button onclick="document.getElementById('descMore').style.display='block';this.style.display='none';" style="background:none;border:1px solid var(--border2);color:var(--accent);padding:8px 20px;border-radius:20px;cursor:pointer;font-size:0.85rem;font-weight:600;margin-top:0.3rem;">▼ Lire la suite</button>` : ""}
                  ${contextParts.map(p => `<p style="margin-bottom:0.8rem;">${p}</p>`).join("")}
                </div>`;
              }

              // Fallback: raw description text + context
              const rawText = lotDesc && lotDesc.length > 20 ? `<p style="margin-bottom:0.8rem;">${esc(lotDesc)}</p>` : "";
              if (catName) contextParts.push(`Retrouvez tous les résultats de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a> avec photos, prix et estimations sur Adjugé !`);
              // Add some helpful tips
              contextParts.push(`💡 <strong>Vous cherchez un objet similaire ?</strong> Consultez notre sélection <a href="/categorie/${catSlug || 'all'}.html" style="color:var(--accent);">dans cette catégorie</a> ou recherchez sur <a href="https://www.amazon.fr/s?k=${encodeURIComponent(shortTitle)}&tag=clubjouetdm-21" target="_blank" rel="nofollow" style="color:var(--accent);">Amazon</a>.`);
              return `<div style="color:var(--text);font-size:0.95rem;line-height:1.8;margin-bottom:1rem;overflow-wrap:break-word;max-width:100%;">
                ${rawText}
                ${contextParts.map(p => `<p style="margin-bottom:0.8rem;">${p}</p>`).join("")}
              </div>`;
            })()}

            ${adSlot("inArticle")}

            <table class="meta-table">
              ${catSlug ? `<tr><td>Catégorie</td><td><a href="/categorie/${catSlug}.html">${esc(catName)}</a></td></tr>` : ""}
              <tr><td>Date</td><td>${saleDate}</td></tr>
              ${org ? `<tr><td>Maison de vente</td><td><a href="/maison/${orgSlug}.html">${esc(org)}</a>${city ? ` — <a href="/ville/${slugify(city)}.html">${esc(city)}</a>` : ""}</td></tr>` : ""}
              ${saleName ? `<tr><td>Vente</td><td>${esc(saleName)}</td></tr>` : ""}
            </table>

            ${item._aiTags?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:1rem;">
              ${item._aiTags.map(tag => `<span style="background:var(--accent-glow);color:var(--accent2);padding:4px 12px;border-radius:20px;font-size:0.78rem;font-weight:500;border:1px solid var(--border2);">${esc(tag)}</span>`).join("")}
            </div>` : ""}
          </div>
        </div>

        ${item._aiPriceAnalysis ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">💰 Analyse du prix</h3></div>
          <div class="card-body">
            <p style="color:var(--text);line-height:1.7;font-size:0.92rem;">${esc(item._aiPriceAnalysis)}</p>
          </div>
        </div>` : (() => {
          // Auto-generated price context for lots not yet AI-enriched
          const avgCat = catSlug && registry.categories.has(catSlug) ? (() => {
            const cat = registry.categories.get(catSlug);
            const total = cat.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
            return cat.items.length ? Math.round(total / cat.items.length) : 0;
          })() : 0;
          const priceVal = auc.price || 0;
          const diff = avgCat > 0 && priceVal > 0 ? Math.round((priceVal / avgCat - 1) * 100) : 0;
          const diffText = diff > 20 ? `Ce lot a été adjugé <strong>${diff}% au-dessus</strong> du prix moyen de la catégorie.` :
                           diff < -20 ? `Ce lot a été adjugé <strong>${Math.abs(diff)}% en dessous</strong> du prix moyen de la catégorie — une bonne affaire.` :
                           avgCat > 0 ? `Ce lot a été adjugé à un prix proche de la moyenne de la catégorie.` : "";
          return priceVal > 0 && avgCat > 0 ? `<div class="card">
            <div class="card-header"><h3 style="font-size:1rem;">💰 Contexte de prix</h3></div>
            <div class="card-body">
              <p style="color:var(--text);line-height:1.7;font-size:0.92rem;">
                Ce lot de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a> a été adjugé <strong>${formatPrice(priceVal)} €</strong>
                ${saleDate ? ` le ${saleDate}` : ""}${org ? ` chez <a href="/maison/${orgSlug}.html" style="color:var(--accent);">${esc(org)}</a>` : ""}${city ? ` à <a href="/ville/${slugify(city)}.html" style="color:var(--accent);">${esc(city)}</a>` : ""}.
                ${est.min != null ? `L'estimation était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €. ` : ""}
                Le prix moyen dans cette catégorie est de <strong>${formatPrice(avgCat)} €</strong>.
                ${diffText}
              </p>
            </div>
          </div>` : "";
        })()}

        ${item._aiFaq?.length ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">❓ Questions fréquentes</h3></div>
          <div class="card-body">
            ${item._aiFaq.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;">
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q || "")}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a || "")}</p>
            </details>`).join("")}
          </div>
        </div>` : (() => {
          // Auto-generated FAQ for lots not yet AI-enriched
          const priceVal = auc.price || 0;
          const faqs = [];
          if (priceVal > 0 && catName) faqs.push({
            q: `Combien a été vendu ce lot de ${catName.toLowerCase()} ?`,
            a: `Ce lot a été adjugé ${formatPrice(priceVal)} € aux enchères${org ? ` chez ${org}` : ""}${city ? ` à ${city}` : ""}${saleDate ? ` le ${saleDate}` : ""}.${est.min != null ? ` L'estimation initiale était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €.` : ""}`
          });
          if (catName) faqs.push({
            q: `Où trouver des ${catName.toLowerCase()} aux enchères en France ?`,
            a: `Adjugé ! référence des milliers de lots de ${catName.toLowerCase()} vendus aux enchères en France. Consultez la page catégorie pour voir tous les résultats, prix moyens et records.`
          });
          if (org && city) faqs.push({
            q: `Comment contacter ${org} à ${city} ?`,
            a: `${org} est une maison de vente aux enchères située à ${city}. Retrouvez ses coordonnées et ses prochaines ventes sur sa page dédiée sur Adjugé !`
          });
          return faqs.length > 0 ? `<div class="card">
            <div class="card-header"><h3 style="font-size:1rem;">❓ Questions fréquentes</h3></div>
            <div class="card-body">
              ${faqs.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
                <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q)}</summary>
                <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a)}</p>
              </details>`).join("")}
            </div>
          </div>` : "";
        })()}

        ${adSlot("betweenLots")}

        ${similarLots(item)}
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${lightboxHtml}
  ${lightboxJS}
  ${footerHtml()}
</body>
</html>`;
}

function generateCategoryPage(slug, data) {
  const catName = data._aiName || data.name;
  const catDesc = data._aiDesc || data.description || "";
  const totalPrice = data.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const avgPrice = data.items.length ? Math.round(totalPrice / data.items.length) : 0;
  const maxPrice = data.items.length ? Math.max(...data.items.map(i => i.pricing?.auctioned?.price || 0)) : 0;
  const desc = `${data.items.length} lots de ${catName} vendus aux enchères en France. Prix moyen : ${formatPrice(avgPrice)}€. Record : ${formatPrice(maxPrice)}€. Photos et résultats sur Adjugé !`;

  // Top 10 most expensive in this category
  const top10Cat = [...data.items]
    .sort((a, b) => (b.pricing?.auctioned?.price || 0) - (a.pricing?.auctioned?.price || 0))
    .slice(0, 10);

  const catTitle = `${catName} aux enchères en France — Prix adjugés & Résultats | Adjugé !`;

  // Schema.org FAQPage for GEO
  const catFaqQuestions = [
    { q: `Combien coûte un ${catName} aux enchères en France ?`, a: `En moyenne, un lot de ${catName} se vend ${formatPrice(avgPrice)} € aux enchères en France. Le record observé est de ${formatPrice(maxPrice)} €.` },
    { q: `Où acheter des ${catName} aux enchères ?`, a: `Adjugé ! recense ${data.items.length} lots de ${catName} vendus aux enchères dans toute la France. Consultez les résultats avec photos et prix adjugés.` },
    { q: `Quel est le prix moyen des ${catName} aux enchères ?`, a: `Le prix moyen constaté pour la catégorie ${catName} est de ${formatPrice(avgPrice)} €, pour un total de ${formatPrice(totalPrice)} € sur ${data.items.length} lots vendus.` },
  ];
  const catFaqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": catFaqQuestions.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a }
    }))
  };

  // Record lot for factual synthesis
  const recordLot = data.items.length ? [...data.items].sort((a, b) => (b.pricing?.auctioned?.price || 0) - (a.pricing?.auctioned?.price || 0))[0] : null;
  const recordLotTitle = recordLot ? (recordLot._aiTitle || (recordLot.description || "").split("\\n")[0]?.substring(0, 60) || "lot") : "";

  // Related categories for internal linking
  const relatedCats = [...registry.categories.entries()]
    .filter(([s]) => s !== slug)
    .sort((a, b) => b[1].items.length - a[1].items.length)
    .slice(0, 5);

  return `${htmlHead(catTitle, desc, `<script type="application/ld+json">${JSON.stringify(catFaqSchema)}<\/script>`, `/categorie/${slug}.html`)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/categories.html">Catégories</a> ›
    ${esc(catName)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${esc(catName)} aux enchères</h1>

            <!-- Factual synthesis (TASK 9) -->
            <p style="color:var(--text);font-size:0.95rem;line-height:1.7;margin-bottom:1rem;background:var(--accent-glow);padding:1rem;border-radius:var(--radius-sm);border-left:3px solid var(--accent);">
              Au ${todayStr()}, la catégorie <strong>${esc(catName)}</strong> compte <strong>${formatPrice(data.items.length)}</strong> lots vendus pour <strong>${formatPrice(totalPrice)} €</strong>. Le record est de <strong>${formatPrice(maxPrice)} €</strong>${recordLotTitle ? ` pour ${esc(recordLotTitle)}` : ""}.
            </p>

            <!-- Category description with "Voir plus" toggle -->
            ${catDesc ? `<div class="cat-desc" id="catDesc" style="color:var(--text2);margin-bottom:0.5rem;font-size:0.9rem;line-height:1.7;">${esc(catDesc)}</div>
            <div class="cat-desc-toggle" id="catDescToggle" onclick="var d=document.getElementById('catDesc');d.classList.toggle('expanded');this.textContent=d.classList.contains('expanded')?'▲ Voir moins':'▼ Voir plus';">▼ Voir plus</div>` : ""}

            <!-- Dynamic stats paragraph (TASK 5) -->
            <p style="color:var(--text2);font-size:0.88rem;line-height:1.6;margin-bottom:1rem;">
              La catégorie ${esc(catName)} compte ${formatPrice(data.items.length)} lots vendus pour un total de ${formatPrice(totalPrice)}€, avec un prix moyen de ${formatPrice(avgPrice)}€.
            </p>

            <!-- Internal links (TASK 7) -->
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;">
              <a href="/top-ventes.html" style="background:var(--surface3);padding:4px 12px;border-radius:20px;font-size:0.8rem;color:var(--accent2);border:1px solid var(--border2);">Top Ventes</a>
              ${relatedCats.map(([s, c]) => `<a href="/categorie/${s}.html" style="background:var(--surface3);padding:4px 12px;border-radius:20px;font-size:0.8rem;color:var(--accent2);border:1px solid var(--border2);">${esc(c._aiName || c.name)}</a>`).join("")}
            </div>

            <div class="hero-stats" style="display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${data.items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(avgPrice)} €</div><div class="stat-label">prix moyen</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(maxPrice)} €</div><div class="stat-label">record</div></div>
            </div>
          </div>
        </div>

        ${top10Cat.length > 0 ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">🏆 Top 10 — ${esc(catName)}</h3></div>
          <div class="card-body" style="padding:0;">
            ${top10Cat.map((item, i) => {
              const rawD = item.description || item.title_translations?.["fr-FR"] || "";
              const lns = rawD.split("\\n").map(l => l.trim()).filter(Boolean);
              const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 50) || "Objet");
              const price = item.pricing?.auctioned?.price || 0;
              const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
              return `<a href="/lot/${lotSlug(item)}.html" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);text-decoration:none;color:var(--text);transition:background 0.15s;">
                <span style="font-weight:800;font-size:${i < 3 ? '1.2rem' : '0.95rem'};min-width:28px;text-align:center;">${medal}</span>
                ${thumb ? `<img src="${esc(thumb)}" alt="" style="width:50px;height:38px;object-fit:cover;border-radius:4px;flex-shrink:0;">` : ""}
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(title)}</div>
                  <div style="font-size:0.88rem;font-weight:700;color:var(--green);">${formatPrice(price)} €</div>
                </div>
              </a>`;
            }).join("")}
          </div>
        </div>` : ""}

        <!-- SSR Pre-rendered Top 10 lots (TASK 8) -->
        ${top10Cat.length > 0 ? `<div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Lots les plus chers — ${esc(catName)}</h2></div>
          <div class="card-body">
            <div class="lot-grid">
              ${top10Cat.map(item => lotCard(item)).join("\n              ")}
            </div>
          </div>
        </div>` : ""}

        <!-- QAP FAQ blocks (TASK 14) -->
        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Questions fréquentes — ${esc(catName)}</h2></div>
          <div class="card-body">
            ${catFaqQuestions.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q)}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a)}</p>
            </details>`).join("\n            ")}
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Tous les lots (${data.items.length})</h2></div>
          <div class="card-body">
            <div class="lot-grid" id="catGrid"></div>
            <div id="catLoading" style="text-align:center;padding:1rem;display:none;color:var(--text3);">Chargement...</div>
          </div>
        </div>

      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var allLots = ${JSON.stringify(data.items.map(item => {
      const rawD = item.description || item.title_translations?.["fr-FR"] || "";
      const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
      const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
      const price = item.pricing?.auctioned?.price || 0;
      const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
      const cat = item.category?.name || "";
      const estC = item.pricing?.estimates || {};
      const elC = estC.low || estC.min || 0;
      const ehC = estC.max || 0;
      const spC = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
      return { s: lotSlug(item), t: title, p: price, i: thumb, c: cat, el: elC, eh: ehC, sp: spC };
    }))};
    var grid = document.getElementById('catGrid');
    var loading = document.getElementById('catLoading');
    var offset = 0, BATCH = 40, isLoading = false;
    function loadMore() {
      if (isLoading || offset >= allLots.length) return;
      isLoading = true; loading.style.display = 'block';
      setTimeout(function() {
        var batch = allLots.slice(offset, offset + BATCH);
        batch.forEach(function(d) {
          var _ex = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : (d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '');
          grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;">'
            + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);"></div>')
            + '<div class="lot-info"><div class="lot-title">' + d.t + '</div>'
            + '<div style="color:var(--green);font-weight:700;font-size:0.85rem;">' + (d.p ? d.p.toLocaleString('fr-FR') + ' €' : '') + '</div>'
            + (_ex ? '<div style="color:var(--text3);font-size:0.72rem;">' + _ex + '</div>' : '')
            + '<div style="color:var(--text3);font-size:0.7rem;">' + d.c + '</div></div></a>';
        });
        offset += batch.length;
        loading.style.display = 'none'; isLoading = false;
      }, 100);
    }
    loadMore();
    var sentinel = document.createElement('div'); sentinel.style.height = '1px';
    loading.parentNode.insertBefore(sentinel, loading);
    new IntersectionObserver(function(e) { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  })();
  </script>
</body>
</html>`;
}

function generateMaisonPage(slug, data) {
  const totalPrice = data.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const avgPrice = data.items.length ? Math.round(totalPrice / data.items.length) : 0;
  const maxPrice = data.items.length ? Math.max(...data.items.map(i => i.pricing?.auctioned?.price || 0)) : 0;
  const desc = `${data.name} (${data.city}) — ${data.items.length} lots vendus aux enchères pour ${formatPrice(totalPrice)}€. Résultats, prix et photos.`;
  const pageTitle = `${data.name} — Résultats enchères | Adjugé !`;

  // Group by category
  const byCat = {};
  for (const item of data.items) {
    const catName = item.category?.name || "Autre";
    if (!byCat[catName]) byCat[catName] = [];
    byCat[catName].push(item);
  }

  // Contact info
  const addr = data.address || {};
  const phone = addr.telephone || "";
  const email = addr.email || "";
  const street = addr.street || "";
  const postcode = addr.postcode || "";

  // Schema.org
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "name": data.name,
    "address": {
      "@type": "PostalAddress",
      "addressLocality": data.city,
      "streetAddress": street || undefined,
      "postalCode": postcode || undefined,
      "addressCountry": "FR"
    },
    "telephone": phone || undefined,
    "email": email || undefined,
  };

  const lotsData = data.items.map(item => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
    const price = item.pricing?.auctioned?.price || 0;
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
    const cat = item.category?.name || "";
    const _est = item.pricing?.estimates || {};
    const el = _est.low || _est.min || 0;
    const eh = _est.max || 0;
    const sp = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
    return { s: lotSlug(item), t: title, p: price, i: thumb, c: cat, el, eh, sp };
  });

  return `${htmlHead(pageTitle, desc, `<script type="application/ld+json">${JSON.stringify(orgSchema)}<\/script>`, `/maison/${slug}.html`)}
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
            <p style="color:var(--text2);">${esc(data.city)} ${street ? "· " + esc(street) : ""} ${postcode ? "· " + esc(postcode) : ""}</p>
            ${phone || email ? `<div style="display:flex;flex-wrap:wrap;gap:0.8rem;margin-top:0.8rem;">
              ${phone ? `<a href="tel:${esc(phone)}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:var(--green-bg);border:1px solid var(--green);border-radius:8px;color:var(--green);font-weight:600;font-size:0.85rem;text-decoration:none;">📞 ${esc(phone)}</a>` : ""}
              ${email ? `<a href="mailto:${esc(email)}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:var(--accent-glow);border:1px solid var(--accent);border-radius:8px;color:var(--accent2);font-weight:600;font-size:0.85rem;text-decoration:none;">✉️ ${esc(email)}</a>` : ""}
            </div>` : ""}
            <div class="hero-stats" style="display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${data.items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(avgPrice)} €</div><div class="stat-label">prix moyen</div></div>
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
          <div class="card-header"><h2 style="font-size:1.1rem;">Derniers lots vendus (${data.items.length})</h2></div>
          <div class="card-body">
            <div class="lot-grid" id="maisonGrid"></div>
            <div id="maisonLoading" style="text-align:center;padding:1rem;display:none;color:var(--text3);">Chargement...</div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var allLots = ${JSON.stringify(lotsData)};
    var grid = document.getElementById('maisonGrid');
    var loading = document.getElementById('maisonLoading');
    var offset = 0, BATCH = 40, isLoading = false;
    function loadMore() {
      if (isLoading || offset >= allLots.length) return;
      isLoading = true; loading.style.display = 'block';
      setTimeout(function() {
        var batch = allLots.slice(offset, offset + BATCH);
        batch.forEach(function(d) {
          var _ex = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : (d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '');
          grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;">'
            + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);"></div>')
            + '<div class="lot-info"><div class="lot-title">' + d.t + '</div>'
            + '<div style="color:var(--green);font-weight:700;font-size:0.85rem;">' + (d.p ? d.p.toLocaleString('fr-FR') + ' €' : '') + '</div>'
            + (_ex ? '<div style="color:var(--text3);font-size:0.72rem;">' + _ex + '</div>' : '')
            + '<div style="color:var(--text3);font-size:0.7rem;">' + d.c + '</div></div></a>';
        });
        offset += batch.length;
        loading.style.display = 'none'; isLoading = false;
      }, 100);
    }
    loadMore();
    var sentinel = document.createElement('div'); sentinel.style.height = '1px';
    loading.parentNode.insertBefore(sentinel, loading);
    new IntersectionObserver(function(e) { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  })();
  </script>
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
            <p style="color:var(--text2);"><a href="/maison/${slugify(data.org)}.html">${esc(data.org)}</a> · ${esc(data.city)} · ${saleDate}</p>
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

  // Group categories into thematic families
  const FAMILIES = {
    "🚗 Véhicules & Transport": ["véhicule", "voiture", "auto", "moto", "utilitaire", "camping", "bateau", "nautique", "sport automobile", "collection automobile", "agricole"],
    "💎 Bijoux & Horlogerie": ["bijou", "montre", "pendule", "horloge", "horlog", "orfèvrerie", "argenterie"],
    "🎨 Art & Antiquités": ["tableau", "peinture", "sculpt", "estampe", "gravure", "dessin", "lithographie", "art moderne", "art contemporain", "art ancien", "art d'asie", "art d'afrique", "art premier", "archéologie"],
    "🏠 Mobilier & Décoration": ["mobilier", "meuble", "hauteur d'appui", "décoration", "luminaire", "tapis", "tapisserie", "vente mobilière"],
    "📚 Livres & Collections": ["livre", "manuscrit", "bande dessinée", "bd", "jouet", "train", "poupée", "automate", "philatélie", "timbre", "numismatique", "monnaie", "carte postale", "collection"],
    "🍷 Vins & Gastronomie": ["vin", "spiritueux", "alcool", "champagne"],
    "👗 Mode & Luxe": ["mode", "vintage", "maroquinerie", "couture", "luxe"],
    "🏺 Céramiques & Objets d'art": ["céramique", "faïence", "porcelaine", "verre", "cristal", "objet d'art"],
    "📸 Photographie & Instruments": ["photo", "instrument", "musique", "scientifique", "optique", "marine"],
    "🏢 Matériel & Stocks": ["marchandise", "stock", "matériel", "bureau", "informatique", "fonds de commerce", "secteur"],
    "🏡 Immobilier & Autres": ["immobilier", "terrain", "appartement", "maison"]
  };

  // Classify each category
  const grouped = new Map();
  const OTHER_KEY = "📦 Autres catégories";
  for (const [key] of Object.entries(FAMILIES)) grouped.set(key, []);
  grouped.set(OTHER_KEY, []);

  for (const [slug, c] of cats) {
    const catName = (c._aiName || c.name).toLowerCase();
    let found = false;
    for (const [family, keywords] of Object.entries(FAMILIES)) {
      if (keywords.some(kw => catName.includes(kw))) {
        grouped.get(family).push([slug, c]);
        found = true;
        break;
      }
    }
    if (!found) grouped.get(OTHER_KEY).push([slug, c]);
  }

  // Remove empty groups
  for (const [key, val] of grouped) {
    if (val.length === 0) grouped.delete(key);
  }

  // Total stats
  const totalLots = cats.reduce((s, [, c]) => s + c.items.length, 0);
  const totalPrice = cats.reduce((s, [, c]) => s + c.items.reduce((ss, i) => ss + (i.pricing?.auctioned?.price || 0), 0), 0);

  function catCard(slug, c) {
    const catName = c._aiName || c.name;
    const catDesc = c._aiDesc || "";
    const totalCatPrice = c.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
    const avgPrice = c.items.length ? Math.round(totalCatPrice / c.items.length) : 0;
    const top = c.items.sort((a, b) => (b.pricing?.auctioned?.price || 0) - (a.pricing?.auctioned?.price || 0))[0];
    const thumb = top?.medias?.[0] ? imgUrl(top.medias[0], "lg") : "";
    return `<a href="/categorie/${slug}.html" class="lot-card" style="position:relative;">
      ${thumb ? `<img src="${esc(thumb)}" alt="${esc(catName)}" loading="lazy">` : `<div class="no-img" style="height:140px;display:flex;align-items:center;justify-content:center;font-size:2rem;">📁</div>`}
      <div class="lot-info">
        <div class="lot-title" style="font-weight:700;font-size:0.88rem;">${esc(catName)}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <span style="color:var(--green);font-weight:700;font-size:0.82rem;">${c.items.length} lots</span>
          ${avgPrice > 0 ? `<span style="color:var(--text3);font-size:0.75rem;">moy. ${formatPrice(avgPrice)} €</span>` : ""}
        </div>
        ${catDesc ? `<div style="font-size:0.72rem;color:var(--text3);margin-top:3px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(catDesc)}</div>` : ""}
      </div>
    </a>`;
  }

  return `${htmlHead("Catégories d'enchères en France — Tous les résultats | Adjugé !", `${cats.length} catégories de ventes aux enchères en France. ${formatPrice(totalLots)} lots vendus pour ${formatPrice(totalPrice)} €. Consultez prix, photos et résultats.`)}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Catégories</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="card" style="margin-bottom:1.5rem;">
      <div class="card-body">
        <h1 style="font-size:1.5rem;margin-bottom:0.5rem;">${cats.length} catégories d'enchères</h1>
        <p style="color:var(--text2);font-size:0.92rem;line-height:1.6;">
          Explorez <strong>${formatPrice(totalLots)} lots</strong> vendus aux enchères en France, répartis en ${cats.length} catégories
          pour un total de <strong>${formatPrice(totalPrice)} €</strong>.
          Cliquez sur une catégorie pour voir les résultats, prix moyens et records.
        </p>
      </div>
    </div>

    ${[...grouped.entries()].map(([family, items]) => `
      <div style="margin-bottom:2rem;">
        <h2 style="font-size:1.2rem;margin-bottom:1rem;padding-bottom:0.5rem;border-bottom:2px solid var(--border);">${family} <span style="font-size:0.85rem;font-weight:400;color:var(--text3);">(${items.reduce((s, [, c]) => s + c.items.length, 0)} lots)</span></h2>
        <div class="lot-grid">
          ${items.map(([slug, c]) => catCard(slug, c)).join("\n          ")}
        </div>
      </div>
    `).join("")}
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

function generateTopVentesPage() {
  const sorted = [...registry.items.values()]
    .sort((a, b) => (b.item.pricing?.auctioned?.price || 0) - (a.item.pricing?.auctioned?.price || 0))
    .slice(0, 100);

  return `${htmlHead("Top 100 des ventes aux enchères les plus chères | Adjugé !", "Classement des lots les plus chers vendus aux enchères. Records, prix, photos.", "", `/top-ventes.html`)}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Top ventes</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <h1 style="font-size:1.5rem;margin-bottom:1.5rem;">🏆 Top 100 — Ventes les plus chères</h1>
    <div class="grid-2">
      <main>
        ${sorted.map(({ item }, i) => {
          const rawD = item.description || item.title_translations?.["fr-FR"] || "";
          const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
          const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
          const desc = item._aiDesc || (lns.length > 1 ? lns.slice(1).join(" ").substring(0, 100) : "");
          const price = item.pricing?.auctioned?.price || 0;
          const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
          const catName = item.category?.name || "";
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
          return `<a href="/lot/${lotSlug(item)}.html" class="card" style="margin-bottom:1rem;text-decoration:none;color:var(--text);display:flex;flex-direction:row;overflow:hidden;transition:transform 0.2s,box-shadow 0.2s;${i < 3 ? 'border-color:var(--accent);' : ''}" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='var(--shadow)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
            ${thumb ? `<img src="${esc(thumb)}" alt="${esc(title)}" style="width:140px;height:auto;object-fit:cover;flex-shrink:0;" loading="lazy">` : ""}
            <div style="padding:1rem 1.2rem;flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:0.4rem;">
                <span style="font-size:${i < 3 ? '1.5rem' : '1rem'};font-weight:800;${i < 3 ? '' : 'color:var(--text3);'}">${medal}</span>
                <span style="font-size:1.5rem;font-weight:800;color:var(--green);">${formatPrice(price)} €</span>
              </div>
              <div style="font-weight:600;font-size:0.95rem;margin-bottom:0.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(title)}</div>
              ${desc ? `<div style="color:var(--text2);font-size:0.82rem;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(desc)}</div>` : ""}
              ${catName ? `<div style="margin-top:0.4rem;font-size:0.75rem;color:var(--text3);">${esc(catName)}</div>` : ""}
            </div>
          </a>`;
        }).join("\n        ")}
        ${adSlot("betweenLots")}
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

// ─── Unsold item page ────────────────────────────────────────────────────────

function generateUnsoldPage(item, sale) {
  const rawDesc = item.description || item.title_translations?.["fr-FR"] || "Objet";
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  const hasShortTitle = lines.length > 1 && lines[0].length < 60;
  const lotTitle = item._aiTitle || (hasShortTitle ? lines[0] : lines[0]?.substring(0, 70) || "Objet");
  const lotDesc = item._aiDesc || (hasShortTitle ? lines.slice(1).join(" ") : lines.length > 1 ? lines.slice(1).join(" ") : "");
  const est = item.pricing?.estimates || {};
  const org = item.organization?.names?.voluntary || item.organization?.names?.judicial || "";
  const orgSlug = slugify(org);
  const city = sale?.address?.city || item.sale?.address?.city || "";
  const saleDate = (sale?.datetime || item.sale?.datetime || "").substring(0, 10);
  const catName = item.category?.name || "";
  const catSlug = slugify(catName);
  const medias = item.medias || [];
  const thumb = medias[0] ? imgUrl(medias[0], "lg") : "";

  const desc = `${lotTitle} — Invendu aux enchères. ${est.min ? `Estimation ${est.min}-${est.max}€.` : ""} Contactez la maison de vente.`;
  const slug = lotSlug(item);

  // Contact info — coordinates from organization.address or sale.address
  const orgAddress = item.organization?.address || sale?.organization?.address || sale?.address || {};
  const orgPhone = orgAddress.telephone || item.organization?.address?.telephone || sale?.address?.telephone || sale?.contact?.contacts?.phone_number || "";
  const orgEmail = orgAddress.email || item.organization?.address?.email || sale?.address?.email || sale?.contact?.contacts?.email || "";
  const orgWebsite = item.organization?.website || sale?.organization?.website || "";
  const orgPostcode = orgAddress.postcode || sale?.address?.postcode || "";
  const orgStreet = orgAddress.street || sale?.address?.street || "";
  const orgCity = orgAddress.city || sale?.address?.city || city;

  return `${htmlHead(`${lotTitle} — Invendu`, desc, `${thumb ? `<meta property="og:image" content="${thumb}">` : ""}`, `/lot/${slug}.html`)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/invendus.html">Invendus</a> ›
    ${esc(lotTitle)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          ${medias.length > 0 ? `<div style="background:#111;padding:1rem;display:flex;justify-content:center;border-radius:var(--radius) var(--radius) 0 0;">
            <img src="${esc(thumb)}" alt="${esc(lotTitle)}" style="max-height:400px;max-width:100%;object-fit:contain;border-radius:var(--radius-sm);">
          </div>` : ""}
          <div class="card-body">
            <div style="display:inline-block;background:var(--red-bg);color:var(--red);padding:4px 12px;border-radius:20px;font-size:0.82rem;font-weight:700;margin-bottom:0.8rem;">Invendu</div>
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;line-height:1.4;overflow-wrap:break-word;">${esc(lotTitle)}</h1>
            ${lotDesc ? `<p style="color:var(--text);font-size:0.95rem;line-height:1.8;margin-bottom:0.8rem;overflow-wrap:break-word;max-width:100%;">${esc(lotDesc)}</p>` : `<p style="color:var(--text);font-size:0.95rem;line-height:1.8;margin-bottom:0.8rem;">
              Ce lot de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a> n'a pas trouvé preneur lors de la vente aux enchères${saleDate ? ` du ${saleDate}` : ""}${org ? ` organisée par ${esc(org)}` : ""}${city ? ` à ${esc(city)}` : ""}.
              ${est.min != null ? `Son estimation était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €.` : ""}
              Il est peut-être encore disponible — contactez directement la maison de vente pour négocier un prix.
            </p>`}
            ${est.min != null ? `<div style="margin:0.8rem 0;">
              <span style="font-size:1.3rem;font-weight:700;color:var(--text);">Estimation : ${formatPrice(est.min)} – ${formatPrice(est.max)} €</span>
            </div>` : ""}
            ${adSlot("inArticle")}
            <table class="meta-table">
              ${catSlug ? `<tr><td>Catégorie</td><td><a href="/categorie/${catSlug}.html">${esc(catName)}</a></td></tr>` : ""}
              <tr><td>Date</td><td>${saleDate}</td></tr>
              ${org ? `<tr><td>Maison</td><td><a href="/maison/${orgSlug}.html">${esc(org)}</a>${city ? ` · <a href="/ville/${slugify(city)}.html">${esc(city)}</a>` : ""}</td></tr>` : ""}
            </table>
          </div>
        </div>

        ${item._aiFaq?.length ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">❓ Questions fréquentes</h3></div>
          <div class="card-body">
            ${item._aiFaq.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q || "")}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a || "")}</p>
            </details>`).join("")}
          </div>
        </div>` : (() => {
          const faqs = [];
          if (catName) faqs.push({
            q: `Peut-on encore acheter ce lot de ${catName.toLowerCase()} ?`,
            a: `Ce lot n'a pas trouvé preneur lors de la vente aux enchères. Il est possible qu'il soit encore disponible. Contactez directement ${org || "la maison de vente"}${city ? ` à ${city}` : ""} pour connaître sa disponibilité et négocier un prix.`
          });
          if (est.min != null) faqs.push({
            q: `Quelle était l'estimation de ce lot ?`,
            a: `L'estimation de ce lot était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €. N'ayant pas trouvé preneur, il est envisageable de l'acquérir à un prix inférieur à l'estimation basse en contactant la maison de vente.`
          });
          if (org && city) faqs.push({
            q: `Comment contacter ${org} ?`,
            a: `${org} est une maison de vente aux enchères située à ${city}. Vous pouvez les contacter via les coordonnées ci-dessous pour vous renseigner sur la disponibilité de ce lot.`
          });
          return faqs.length > 0 ? `<div class="card">
            <div class="card-header"><h3 style="font-size:1rem;">❓ Questions fréquentes</h3></div>
            <div class="card-body">
              ${faqs.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
                <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q)}</summary>
                <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a)}</p>
              </details>`).join("")}
            </div>
          </div>` : "";
        })()}

        <div class="card" style="border-color:var(--accent);border-width:2px;">
          <div class="card-header"><h3 style="font-size:1.1rem;">📞 Contacter la maison de vente</h3></div>
          <div class="card-body">
            <p style="color:var(--text);margin-bottom:1rem;font-size:0.95rem;">Cet objet n'a pas trouvé preneur. Il est peut-être encore disponible ! Contactez directement la maison de vente pour négocier.</p>
            <div style="display:flex;flex-direction:column;gap:0.8rem;">
              ${org ? `<div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:1.2rem;">🏛️</span>
                <div><strong>${esc(org)}</strong>${orgStreet || orgCity ? `<br><span style="color:var(--text2);font-size:0.88rem;">${orgStreet ? esc(orgStreet) + ", " : ""}${orgPostcode ? esc(orgPostcode) + " " : ""}${esc(orgCity)}</span>` : ""}</div>
              </div>` : ""}
              ${orgPhone ? `<a href="tel:${esc(orgPhone)}" style="display:flex;align-items:center;gap:10px;padding:12px 18px;background:var(--green-bg);border:1px solid var(--green);border-radius:10px;color:var(--green);font-weight:700;font-size:1rem;text-decoration:none;">
                <span style="font-size:1.2rem;">📞</span> ${esc(orgPhone)}
              </a>` : ""}
              ${orgEmail ? `<a href="mailto:${esc(orgEmail)}?subject=${encodeURIComponent("Demande concernant : " + lotTitle)}" style="display:flex;align-items:center;gap:10px;padding:12px 18px;background:var(--accent-glow);border:1px solid var(--accent);border-radius:10px;color:var(--accent2);font-weight:700;font-size:0.95rem;text-decoration:none;">
                <span style="font-size:1.2rem;">✉️</span> ${esc(orgEmail)}
              </a>` : ""}
              <a href="https://www.google.com/search?q=${encodeURIComponent(org + " " + city + " enchères contact")}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:12px 18px;background:var(--surface3);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-weight:600;font-size:0.92rem;text-decoration:none;">
                <span style="font-size:1.2rem;">🔍</span> Rechercher les coordonnées de ${esc(org)}
              </a>
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

function unsoldLotCard(item) {
  const rawD = item.description || item.title_translations?.["fr-FR"] || "";
  const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
  const fallback = (lns.length > 1 && lns[0].length < 60) ? lns[0] : lns[0]?.substring(0, 70) || "Objet";
  const title = item._aiTitle || fallback;
  const est = item.pricing?.estimates || {};
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
  const catName = item.category?.name || "";
  return `<a href="/lot/${lotSlug(item)}.html" class="lot-card">
    ${thumb ? `<img src="${esc(thumb)}" alt="${esc(title)}" loading="lazy">` : `<div class="no-img">📦</div>`}
    <div class="lot-info">
      <div class="lot-title">${esc(title)}</div>
      <div style="font-weight:700;color:var(--red);margin-top:0.3rem;font-size:0.88rem;">Invendu</div>
      ${est.min != null ? `<div style="font-size:0.78rem;color:var(--text2);margin-top:0.2rem;">Est. ${formatPrice(est.min)} – ${formatPrice(est.max)} €</div>` : ""}
      ${catName ? `<div class="lot-cat">${esc(catName)}</div>` : ""}
    </div>
  </a>`;
}

function generateInvendusIndex() {
  const unsoldItems = [...registry.unsold.values()]
    .sort((a, b) => (b.sale?.datetime || "").localeCompare(a.sale?.datetime || ""));

  // Collect categories for filter
  const catCounts = new Map();
  for (const { item } of unsoldItems) {
    const cat = item.category?.name || "Autre";
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  }
  const sortedCats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Build JSON data for client-side filtering
  const unsoldData = unsoldItems.map(({ item, sale }) => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
    const cat = item.category?.name || "Autre";
    const estLow = item.pricing?.estimates?.low || item.pricing?.estimates?.min || 0;
    const estHigh = item.pricing?.estimates?.max || 0;
    const startPrice = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
    const date = sale?.datetime ? sale.datetime.substring(0, 10) : "";
    return { s: lotSlug(item), t: title, i: thumb, c: cat, el: estLow, eh: estHigh, sp: startPrice, d: date };
  });

  const metaDesc = `${unsoldItems.length} lots invendus aux enchères. Filtrez par catégorie et contactez les maisons de vente pour négocier.`;

  return `${htmlHead("Lots invendus aux enchères — À négocier | Adjugé !", metaDesc, "", "/invendus.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Invendus</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-bottom:1.5rem;">
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--red-bg);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">📦</div>
        <div><div class="stat-number" style="font-size:${statFontSize(unsoldItems.length)}">${formatPrice(unsoldItems.length)}</div><div class="stat-label">invendus</div></div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--accent-glow);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">💬</div>
        <div><div class="stat-number" style="font-size:1.4rem;">Négociez !</div><div class="stat-label">contactez la maison</div></div>
      </div></div>
    </div>
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-header" style="display:flex;flex-wrap:wrap;align-items:center;gap:0.8rem;">
            <h1 style="font-size:1.2rem;flex:1;">Lots invendus — À négocier</h1>
          </div>
          <div class="card-body">
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;">
              <input type="text" id="unsoldSearch" placeholder="🔍 Rechercher dans les invendus..." style="flex:1;min-width:200px;background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 14px;border-radius:8px;font-size:0.85rem;font-family:inherit;outline:none;">
              <select id="unsoldCat" style="background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 12px;border-radius:8px;font-size:0.85rem;font-family:inherit;outline:none;">
                <option value="">Toutes catégories (${unsoldItems.length})</option>
                ${sortedCats.map(([cat, count]) => `<option value="${esc(cat)}">${esc(cat)} (${count})</option>`).join("")}
              </select>
              <select id="unsoldSort" style="background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 12px;border-radius:8px;font-size:0.85rem;font-family:inherit;outline:none;">
                <option value="recent">Plus récents</option>
                <option value="price-desc">Estimation décroissante</option>
                <option value="price-asc">Estimation croissante</option>
              </select>
            </div>
            <p style="color:var(--text2);margin-bottom:1rem;font-size:0.85rem;">Ces objets n'ont pas trouvé preneur. Cliquez sur un lot pour contacter la maison de vente.</p>
            <div id="unsoldCount" style="color:var(--text3);font-size:0.8rem;margin-bottom:0.8rem;"></div>
            <div class="lot-grid" id="unsoldGrid"></div>
            <div id="unsoldMore" style="text-align:center;padding:1.5rem;display:none;">
              <div style="color:var(--text3);font-size:0.85rem;">Chargement...</div>
            </div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var DATA = ${JSON.stringify(unsoldData)};
    var PAGE = 40, shown = 0, filtered = DATA;
    var grid = document.getElementById('unsoldGrid');
    var more = document.getElementById('unsoldMore');
    var countEl = document.getElementById('unsoldCount');

    function render(items, append) {
      if (!append) { grid.innerHTML = ''; shown = 0; }
      var batch = items.slice(shown, shown + PAGE);
      batch.forEach(function(d) {
        var est = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : '';
        var sp = d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '';
        var priceInfo = est || sp;
        grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;">'
          + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);display:flex;align-items:center;justify-content:center;color:var(--text3);">📷</div>')
          + '<div class="lot-info"><div class="lot-title">' + d.t + '</div>'
          + (priceInfo ? '<div style="color:var(--accent2);font-weight:700;font-size:0.85rem;">' + priceInfo + '</div>' : '')
          + '<div style="color:var(--red);font-weight:600;font-size:0.78rem;">Invendu</div>'
          + '<div style="color:var(--text3);font-size:0.7rem;margin-top:2px;">' + d.c + '</div>'
          + '</div></a>';
      });
      shown += batch.length;
      countEl.textContent = filtered.length + ' résultat' + (filtered.length > 1 ? 's' : '');
      more.style.display = shown < filtered.length ? 'block' : 'none';
    }
    // Infinite scroll
    var loading = false;
    var observer = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting && !loading && shown < filtered.length) {
        loading = true;
        render(filtered, true);
        loading = false;
      }
    }, { rootMargin: '400px' });
    observer.observe(more);

    function applyFilters() {
      var q = document.getElementById('unsoldSearch').value.toLowerCase();
      var cat = document.getElementById('unsoldCat').value;
      var sort = document.getElementById('unsoldSort').value;
      filtered = DATA.filter(function(d) {
        if (cat && d.c !== cat) return false;
        if (q && d.t.toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
      if (sort === 'price-desc') filtered.sort(function(a,b) { return (b.eh||0) - (a.eh||0); });
      else if (sort === 'price-asc') filtered.sort(function(a,b) { return (a.eh||0) - (b.eh||0); });
      else filtered.sort(function(a,b) { return (b.d||'').localeCompare(a.d||''); });
      render(filtered, false);
    }

    document.getElementById('unsoldSearch').addEventListener('input', applyFilters);
    document.getElementById('unsoldCat').addEventListener('change', applyFilters);
    document.getElementById('unsoldSort').addEventListener('change', applyFilters);
    applyFilters();
  })();
  </script>
</body>
</html>`;
}

function generateHomePage(dateStr) {
  const allValues = [...registry.items.values()];
  const totalItems = allValues.length;
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);

  // Stats du jour spécifique
  const dayItems = allValues.filter(({ sale }) => {
    const d = sale?.datetime ? sale.datetime.substring(0, 10) : dateStr;
    return d === dateStr;
  });
  const dayCount = dayItems.length;
  const dayPrice = dayItems.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);
  const dayAvg = dayCount ? Math.round(dayPrice / dayCount) : 0;
  const dayMaxItem = dayCount ? dayItems.reduce((best, cur) => (cur.item.pricing?.auctioned?.price || 0) > (best.item.pricing?.auctioned?.price || 0) ? cur : best) : null;
  const dayMax = dayMaxItem?.item.pricing?.auctioned?.price || 0;
  const dayMaxSlug = dayMaxItem ? lotSlug(dayMaxItem.item) : "";

  // Stats globales
  const globalAvg = totalItems ? Math.round(totalPrice / totalItems) : 0;
  const globalMaxItem = totalItems ? allValues.reduce((best, cur) => (cur.item.pricing?.auctioned?.price || 0) > (best.item.pricing?.auctioned?.price || 0) ? cur : best) : null;
  const globalMax = globalMaxItem?.item.pricing?.auctioned?.price || 0;
  const globalMaxSlug = globalMaxItem ? lotSlug(globalMaxItem.item) : "";

  // Nombre de jours distincts
  const uniqueDays = new Set(allValues.map(({ sale }) => sale?.datetime ? sale.datetime.substring(0, 10) : dateStr));

  // All items sorted by recent, as JSON for infinite scroll
  const allItems = allValues
    .sort((a, b) => (b.item.last_updated || "").localeCompare(a.item.last_updated || ""))
    .map(({ item }) => {
      const rawD = item.description || item.title_translations?.["fr-FR"] || "";
      const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
      const fallback = (lns.length > 1 && lns[0].length < 60) ? lns[0] : lns[0]?.substring(0, 70) || "Objet";
      const title = item._aiTitle || fallback;
      const price = item.pricing?.auctioned?.price || 0;
      const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
      const cat = item.category?.name || "";
      const est = item.pricing?.estimates || {};
      const sp = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
      const el = est.low || est.min || 0;
      const eh = est.max || 0;
      return { s: lotSlug(item), t: title, p: price, i: thumb, c: cat, sp, el, eh };
    });

  const adsenseId = config.adsenseId || "";
  const adSlotId = config.adSlots?.betweenLots || "";

  // Top 10 most expensive
  const top10 = allValues
    .sort((a, b) => (b.item.pricing?.auctioned?.price || 0) - (a.item.pricing?.auctioned?.price || 0))
    .slice(0, 10);

  // Format date lisible
  const dateParts = dateStr.split("-");
  const dateLabel = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;

  const homeTitle = "Adjugé ! — Résultats de ventes aux enchères en France | Prix & Photos";
  const homeDesc = `Adjugé ! recense ${formatPrice(totalItems)} lots vendus aux enchères en France pour ${formatPrice(totalPrice)} €. Consultez prix adjugés, photos et estimations par catégorie.`;
  return `${htmlHead(homeTitle, homeDesc, "", `/index.html`)}
<body>
  ${navHtml()}
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <!-- Factual synthesis paragraph (TASK 9) -->
    <p style="color:var(--text);font-size:0.95rem;line-height:1.7;margin-bottom:1.5rem;background:var(--accent-glow);padding:1rem;border-radius:var(--radius-sm);border-left:3px solid var(--accent);">
      Au ${dateStr}, <strong>Adjugé !</strong> recense <strong>${formatPrice(totalItems)}</strong> lots vendus aux enchères en France pour un total de <strong>${formatPrice(totalPrice)} €</strong>, soit un prix moyen de <strong>${formatPrice(globalAvg)} €</strong>.
    </p>
    <h2 style="font-size:1.1rem;color:var(--text2);margin-bottom:0.8rem;">📅 Enchères du ${dateLabel}</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem;">
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--accent-glow);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">🔨</div>
        <div><div class="stat-number" style="font-size:${statFontSize(dayCount)}">${formatPrice(dayCount)}</div><div class="stat-label">objets vendus</div></div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:var(--green-bg);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">💰</div>
        <div><div class="stat-number" style="font-size:${statFontSize(dayPrice)}">${formatPrice(dayPrice)} €</div><div class="stat-label">total adjugé</div></div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:rgba(251,191,36,0.1);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">📊</div>
        <div><div class="stat-number" style="font-size:${statFontSize(dayAvg)}">${formatPrice(dayAvg)} €</div><div class="stat-label">prix moyen</div></div>
      </div></div>
      ${dayMaxSlug ? `<a href="/lot/${dayMaxSlug}.html" class="card" style="margin:0;text-decoration:none;color:inherit;transition:transform 0.15s;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">` : `<div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">`}
        <div style="width:48px;height:48px;border-radius:12px;background:var(--red-bg);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">🏆</div>
        <div><div class="stat-number" style="font-size:${statFontSize(dayMax)}">${formatPrice(dayMax)} €</div><div class="stat-label">record du jour</div></div>
      </div>${dayMaxSlug ? `</a>` : `</div>`}
    </div>

    <h2 style="font-size:1.1rem;color:var(--text2);margin-bottom:0.8rem;">📈 Statistiques globales <span style="font-size:0.8rem;font-weight:400;">(${uniqueDays.size} jour${uniqueDays.size > 1 ? "s" : ""} de ventes)</span></h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem;">
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,var(--accent-glow),rgba(139,92,246,0.15));display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">🌐</div>
        <div><div class="stat-number" style="font-size:${statFontSize(totalItems)}">${formatPrice(totalItems)}</div><div class="stat-label">lots au total</div></div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,var(--green-bg),rgba(16,185,129,0.15));display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">💎</div>
        <div><div class="stat-number" style="font-size:${statFontSize(totalPrice)}">${formatPrice(totalPrice)} €</div><div class="stat-label">total cumulé</div></div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,rgba(251,191,36,0.1),rgba(251,191,36,0.2));display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">⚖️</div>
        <div><div class="stat-number" style="font-size:${statFontSize(globalAvg)}">${formatPrice(globalAvg)} €</div><div class="stat-label">prix moyen global</div></div>
      </div></div>
      ${globalMaxSlug ? `<a href="/lot/${globalMaxSlug}.html" class="card" style="margin:0;text-decoration:none;color:inherit;transition:transform 0.15s;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">` : `<div class="card" style="margin:0;"><div class="card-body" style="display:flex;align-items:center;gap:1rem;padding:1.2rem;">`}
        <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,var(--red-bg),rgba(239,68,68,0.15));display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">👑</div>
        <div><div class="stat-number" style="font-size:${statFontSize(globalMax)}">${formatPrice(globalMax)} €</div><div class="stat-label">record absolu</div></div>
      </div>${globalMaxSlug ? `</a>` : `</div>`}
    </div>

    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Derniers lots vendus</h2></div>
          <div class="card-body">
            <div class="lot-grid" id="lotGrid"></div>
            <div id="adContainer"></div>
            <div id="loadingMore" style="text-align:center;padding:2rem;display:none;">
              <div style="display:inline-block;width:36px;height:36px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;"></div>
              <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
            </div>
            <div id="endMessage" style="text-align:center;padding:1.5rem;color:var(--text3);font-size:0.9rem;display:none;">
              ✨ Tous les lots ont été chargés
            </div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}

  <script>
  (function(){
    const BATCH = 24;
    const AD_EVERY = 12; // insert ad every 12 lots
    const allLots = ${JSON.stringify(allItems)};
    const grid = document.getElementById('lotGrid');
    const adContainer = document.getElementById('adContainer');
    const loading = document.getElementById('loadingMore');
    const endMsg = document.getElementById('endMessage');
    const adsenseId = "${adsenseId}";
    const adSlotId = "${adSlotId}";
    let offset = 0;
    let isLoading = false;

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function formatPrice(n) { return Math.round(n).toLocaleString('fr-FR'); }

    function renderLots(start, count) {
      const end = Math.min(start + count, allLots.length);
      let html = '';
      for (let i = start; i < end; i++) {
        const lot = allLots[i];
        html += '<a href="/lot/' + lot.s + '.html" class="lot-card">';
        if (lot.i) {
          html += '<img src="' + esc(lot.i) + '" alt="' + esc(lot.t) + '" loading="lazy">';
        } else {
          html += '<div class="no-img">📦</div>';
        }
        html += '<div class="lot-info">';
        html += '<div class="lot-title">' + esc(lot.t) + '</div>';
        html += '<div class="lot-price">' + formatPrice(lot.p) + ' €</div>';
        var extra = lot.el && lot.eh ? 'Est. ' + formatPrice(lot.el) + ' – ' + formatPrice(lot.eh) + ' €' : (lot.sp ? 'Mise à prix : ' + formatPrice(lot.sp) + ' €' : '');
        if (extra) html += '<div style="color:var(--text3);font-size:0.72rem;margin-top:1px;">' + extra + '</div>';
        if (lot.c) html += '<div class="lot-cat">' + esc(lot.c) + '</div>';
        html += '</div></a>';
      }
      return { html, rendered: end - start };
    }

    function insertAd() {
      if (!adsenseId || !adSlotId) return;
      const adDiv = document.createElement('div');
      adDiv.className = 'ad-slot';
      adDiv.style.cssText = 'margin:1.5rem 0;min-height:100px;';
      adDiv.innerHTML = '<ins class="adsbygoogle" style="display:block" data-ad-client="' + adsenseId + '" data-ad-slot="' + adSlotId + '" data-ad-format="auto" data-full-width-responsive="true"></ins>';
      grid.insertAdjacentElement('afterend', adDiv);
      // Re-insert grid after ad for next batch
      try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch(e) {}
    }

    function loadMore() {
      if (isLoading || offset >= allLots.length) return;
      isLoading = true;
      loading.style.display = 'block';

      setTimeout(function() {
        const { html, rendered } = renderLots(offset, BATCH);
        grid.insertAdjacentHTML('beforeend', html);
        offset += rendered;

        // Insert ad after every AD_EVERY lots (but not the first batch)
        if (offset > BATCH && offset % AD_EVERY === 0 && adsenseId && adSlotId) {
          const adHtml = '<div class="ad-slot" style="grid-column:1/-1;margin:0.5rem 0;min-height:100px;"><ins class="adsbygoogle" style="display:block" data-ad-client="' + adsenseId + '" data-ad-slot="' + adSlotId + '" data-ad-format="auto" data-full-width-responsive="true"></ins></div>';
          grid.insertAdjacentHTML('beforeend', adHtml);
          try { (adsbygoogle = window.adsbygoogle || []).push({}); } catch(e) {}
        }

        loading.style.display = 'none';
        isLoading = false;

        if (offset >= allLots.length) {
          endMsg.style.display = 'block';
        }
      }, 150);
    }

    // Initial load
    loadMore();

    // Infinite scroll with IntersectionObserver
    const sentinel = document.createElement('div');
    sentinel.id = 'scrollSentinel';
    sentinel.style.height = '1px';
    loading.parentNode.insertBefore(sentinel, loading);

    const observer = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting && !isLoading && offset < allLots.length) {
        loadMore();
      }
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
  })();
  </script>
</body>
</html>`;
}

// ─── À propos page (TASK 10) ────────────────────────────────────────────────

function generateAProposPage() {
  const totalItems = registry.items.size;
  const totalUnsold = registry.unsold.size;
  const totalCats = registry.categories.size;
  const totalMaisons = registry.maisons.size;
  const allValues = [...registry.items.values()];
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);

  return `${htmlHead("À propos — Adjugé !", "Qui sommes-nous ? Méthodologie, sources et couverture du site Adjugé ! agrégateur de résultats d'enchères en France.", "", "/a-propos.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › À propos</div>
  <div class="container">
    <div class="card"><div class="card-body" style="max-width:800px;margin:0 auto;line-height:1.8;color:var(--text);">
      <h1 style="font-size:1.6rem;margin-bottom:1.5rem;">À propos d'Adjugé !</h1>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Qui sommes-nous ?</h2>
      <p><strong>Adjugé !</strong> est un agrégateur indépendant de résultats de ventes aux enchères publiques en France. Notre mission : rendre les prix adjugés accessibles à tous, collectionneurs, professionnels du marché de l'art et curieux.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Notre méthodologie</h2>
      <p>Les données sont collectées quotidiennement depuis Interenchères, la principale plateforme de ventes aux enchères en ligne en France. Chaque lot est indexé avec son prix d'adjudication, ses photos, son estimation et la maison de vente associée.</p>
      <p>Les descriptions et catégories sont enrichies par intelligence artificielle (GPT-4o) pour améliorer la recherche et la navigation.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Couverture</h2>
      <ul style="margin:0.5rem 0 0.5rem 1.5rem;">
        <li><strong>${formatPrice(totalItems)}</strong> lots vendus référencés</li>
        <li><strong>${formatPrice(totalUnsold)}</strong> lots invendus</li>
        <li><strong>${totalCats}</strong> catégories</li>
        <li><strong>${totalMaisons}</strong> maisons de vente</li>
        <li><strong>${formatPrice(totalPrice)} €</strong> de total adjugé</li>
        <li>Couverture : <strong>France entière</strong>, toutes maisons de vente partenaires Interenchères</li>
      </ul>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Fréquence de mise à jour</h2>
      <p>Le site est mis à jour <strong>quotidiennement</strong> via un processus automatisé. Les nouvelles ventes sont intégrées chaque jour, avec un historique cumulé sur plusieurs jours.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Date de lancement</h2>
      <p>Adjugé ! a été lancé en <strong>mars 2026</strong>.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Contact</h2>
      <p>Pour toute question : <a href="mailto:contact@auboisrieur.fr" style="color:var(--accent);">contact@auboisrieur.fr</a></p>

      <div style="margin-top:2rem;display:flex;gap:1rem;flex-wrap:wrap;">
        <a href="/statistiques.html" style="background:var(--accent);color:#fff;padding:10px 20px;border-radius:10px;font-weight:600;text-decoration:none;">Voir les statistiques</a>
        <a href="/index.html" style="background:var(--surface3);color:var(--text);padding:10px 20px;border-radius:10px;font-weight:600;text-decoration:none;border:1px solid var(--border2);">Retour à l'accueil</a>
      </div>
    </div></div>
  </div>
  ${footerHtml()}
</body></html>`;
}

// ─── Statistiques page (TASK 11) ──────────────────────────────────────────

function generateStatistiquesPage(dateStr) {
  const allValues = [...registry.items.values()];
  const totalItems = allValues.length;
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);
  const avgPrice = totalItems ? Math.round(totalPrice / totalItems) : 0;
  const maxPrice = totalItems ? Math.max(...allValues.map(({ item }) => item.pricing?.auctioned?.price || 0)) : 0;

  // Top categories
  const catStats = [...registry.categories.entries()]
    .map(([slug, c]) => {
      const catTotal = c.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
      const catAvg = c.items.length ? Math.round(catTotal / c.items.length) : 0;
      return { slug, name: c._aiName || c.name, count: c.items.length, total: catTotal, avg: catAvg };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Top maisons
  const maisonStats = [...registry.maisons.entries()]
    .map(([slug, m]) => {
      const mTotal = m.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
      return { slug, name: m.name, city: m.city, count: m.items.length, total: mTotal, sales: m.saleIds.size };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  return `${htmlHead("Statistiques des enchères en France — Chiffres clés | Adjugé !", "Statistiques complètes des ventes aux enchères en France : lots vendus, prix moyens, records, top catégories et maisons de vente.", "", "/statistiques.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Statistiques</div>
  <div class="container">
    <h1 style="font-size:1.5rem;margin-bottom:1.5rem;">Statistiques des ventes aux enchères</h1>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem;">
      <div class="card" style="margin:0;"><div class="card-body stat-box">
        <div class="stat-number" style="font-size:${statFontSize(totalItems)}">${formatPrice(totalItems)}</div>
        <div class="stat-label">lots vendus</div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body stat-box">
        <div class="stat-number" style="font-size:${statFontSize(totalPrice)}">${formatPrice(totalPrice)} €</div>
        <div class="stat-label">total adjugé</div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body stat-box">
        <div class="stat-number" style="font-size:${statFontSize(avgPrice)}">${formatPrice(avgPrice)} €</div>
        <div class="stat-label">prix moyen</div>
      </div></div>
      <div class="card" style="margin:0;"><div class="card-body stat-box">
        <div class="stat-number" style="font-size:${statFontSize(maxPrice)}">${formatPrice(maxPrice)} €</div>
        <div class="stat-label">record absolu</div>
      </div></div>
    </div>

    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Top catégories</h2></div>
          <div class="card-body" style="overflow-x:auto;">
            <table style="width:100%;font-size:0.88rem;">
              <thead><tr style="border-bottom:2px solid var(--border2);">
                <th style="text-align:left;padding:0.5rem;color:var(--text2);">Catégorie</th>
                <th style="text-align:right;padding:0.5rem;color:var(--text2);">Lots</th>
                <th style="text-align:right;padding:0.5rem;color:var(--text2);">Total</th>
                <th style="text-align:right;padding:0.5rem;color:var(--text2);">Moy.</th>
              </tr></thead>
              <tbody>
                ${catStats.map(c => `<tr style="border-bottom:1px solid var(--border);">
                  <td style="padding:0.5rem;"><a href="/categorie/${c.slug}.html">${esc(c.name)}</a></td>
                  <td style="text-align:right;padding:0.5rem;">${formatPrice(c.count)}</td>
                  <td style="text-align:right;padding:0.5rem;color:var(--green);font-weight:600;">${formatPrice(c.total)} €</td>
                  <td style="text-align:right;padding:0.5rem;">${formatPrice(c.avg)} €</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Top maisons de vente</h2></div>
          <div class="card-body" style="overflow-x:auto;">
            <table style="width:100%;font-size:0.88rem;">
              <thead><tr style="border-bottom:2px solid var(--border2);">
                <th style="text-align:left;padding:0.5rem;color:var(--text2);">Maison</th>
                <th style="text-align:left;padding:0.5rem;color:var(--text2);">Ville</th>
                <th style="text-align:right;padding:0.5rem;color:var(--text2);">Lots</th>
                <th style="text-align:right;padding:0.5rem;color:var(--text2);">Total</th>
              </tr></thead>
              <tbody>
                ${maisonStats.map(m => `<tr style="border-bottom:1px solid var(--border);">
                  <td style="padding:0.5rem;"><a href="/maison/${m.slug}.html">${esc(m.name)}</a></td>
                  <td style="padding:0.5rem;color:var(--text2);">${esc(m.city)}</td>
                  <td style="text-align:right;padding:0.5rem;">${formatPrice(m.count)}</td>
                  <td style="text-align:right;padding:0.5rem;color:var(--green);font-weight:600;">${formatPrice(m.total)} €</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
</body></html>`;
}

// ─── Programmatic SEO: City pages ────────────────────────────────────────────

function buildCityRegistry() {
  const cities = new Map();
  for (const [, { item, sale }] of registry.items) {
    const city = sale?.address?.city || item.sale?.address?.city || "";
    if (!city) continue;
    const cs = slugify(city);
    if (!cities.has(cs)) cities.set(cs, { name: city, items: [], totalPrice: 0 });
    const entry = cities.get(cs);
    entry.items.push(item);
    entry.totalPrice += item.pricing?.auctioned?.price || 0;
  }
  return cities;
}

function generateVillePage(slug, data) {
  const { name, items, totalPrice } = data;
  const avgPrice = items.length ? Math.round(totalPrice / items.length) : 0;
  const maxPrice = items.length ? Math.max(...items.map(i => i.pricing?.auctioned?.price || 0)) : 0;

  const desc = `${items.length} lots vendus aux enchères à ${name}. Prix moyen : ${formatPrice(avgPrice)}€. Record : ${formatPrice(maxPrice)}€. Photos et résultats sur Adjugé !`;
  const pageTitle = `Enchères à ${name} — Résultats, prix adjugés et photos | Adjugé !`;

  const top10 = [...items].sort((a, b) => (b.pricing?.auctioned?.price || 0) - (a.pricing?.auctioned?.price || 0)).slice(0, 10);

  // Schema.org LocalBusiness-style
  const localSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Enchères à ${name}`,
    "description": desc,
    "numberOfItems": items.length,
    "itemListElement": top10.slice(0, 5).map((item, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": item._aiTitle || (item.description || "").split("\n")[0]?.substring(0, 60) || "Lot",
      "url": `${config.siteUrl || "https://auboisrieur.fr"}/lot/${lotSlug(item)}.html`
    }))
  };

  const faqQuestions = [
    { q: `Combien coûte un objet aux enchères à ${name} ?`, a: `En moyenne, un lot vendu aux enchères à ${name} coûte ${formatPrice(avgPrice)} €. Le record observé est de ${formatPrice(maxPrice)} €.` },
    { q: `Où voir les résultats d'enchères à ${name} ?`, a: `Adjugé ! recense ${items.length} lots vendus aux enchères à ${name} avec photos, prix adjugés et estimations.` },
  ];
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqQuestions.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a }
    }))
  };

  // Group by category
  const byCat = {};
  for (const item of items) {
    const catName = item.category?.name || "Autre";
    if (!byCat[catName]) byCat[catName] = [];
    byCat[catName].push(item);
  }

  const lotsData = items.map(item => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
    const price = item.pricing?.auctioned?.price || 0;
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
    const cat = item.category?.name || "";
    const _est = item.pricing?.estimates || {};
    const el = _est.low || _est.min || 0;
    const eh = _est.max || 0;
    const sp = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
    return { s: lotSlug(item), t: title, p: price, i: thumb, c: cat, el, eh, sp };
  });

  return `${htmlHead(pageTitle, desc, `<script type="application/ld+json">${JSON.stringify(localSchema)}<\/script>
  <script type="application/ld+json">${JSON.stringify(faqSchema)}<\/script>`, `/ville/${slug}.html`)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    <a href="/villes.html">Villes</a> ›
    ${esc(name)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Enchères à ${esc(name)}</h1>
            <p style="color:var(--text);font-size:0.95rem;line-height:1.7;margin-bottom:1rem;background:var(--accent-glow);padding:1rem;border-radius:var(--radius-sm);border-left:3px solid var(--accent);">
              Au ${todayStr()}, <strong>${formatPrice(items.length)}</strong> lots ont été vendus aux enchères à <strong>${esc(name)}</strong> pour un total de <strong>${formatPrice(totalPrice)} €</strong>, soit un prix moyen de <strong>${formatPrice(avgPrice)} €</strong>.
            </p>
            <div class="hero-stats" style="display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(avgPrice)} €</div><div class="stat-label">prix moyen</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(maxPrice)} €</div><div class="stat-label">record</div></div>
            </div>
          </div>
        </div>

        ${Object.keys(byCat).length > 1 ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">Catégories à ${esc(name)}</h3></div>
          <div class="card-body cat-list">
            ${Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([cat, citems]) => {
              return `<a href="/categorie/${slugify(cat)}.html">${esc(cat)} <span class="cat-count">(${citems.length})</span></a>`;
            }).join("\n            ")}
          </div>
        </div>` : ""}

        ${top10.length > 0 ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">🏆 Top 10 — ${esc(name)}</h3></div>
          <div class="card-body" style="padding:0;">
            ${top10.map((item, i) => {
              const rawD = item.description || item.title_translations?.["fr-FR"] || "";
              const lns = rawD.split("\\n").map(l => l.trim()).filter(Boolean);
              const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 50) || "Objet");
              const price = item.pricing?.auctioned?.price || 0;
              const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
              return `<a href="/lot/${lotSlug(item)}.html" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);text-decoration:none;color:var(--text);transition:background 0.15s;">
                <span style="font-weight:800;font-size:${i < 3 ? '1.2rem' : '0.95rem'};min-width:28px;text-align:center;">${medal}</span>
                ${thumb ? `<img src="${esc(thumb)}" alt="" style="width:50px;height:38px;object-fit:cover;border-radius:4px;flex-shrink:0;">` : ""}
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(title)}</div>
                  <div style="font-size:0.88rem;font-weight:700;color:var(--green);">${formatPrice(price)} €</div>
                </div>
              </a>`;
            }).join("")}
          </div>
        </div>` : ""}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Questions fréquentes — ${esc(name)}</h2></div>
          <div class="card-body">
            ${faqQuestions.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q)}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a)}</p>
            </details>`).join("\n            ")}
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Tous les lots à ${esc(name)} (${items.length})</h2></div>
          <div class="card-body">
            <div class="lot-grid" id="villeGrid"></div>
            <div id="villeLoading" style="text-align:center;padding:1rem;display:none;color:var(--text3);">Chargement...</div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var allLots = ${JSON.stringify(lotsData)};
    var grid = document.getElementById('villeGrid');
    var loading = document.getElementById('villeLoading');
    var offset = 0, BATCH = 40, isLoading = false;
    function loadMore() {
      if (isLoading || offset >= allLots.length) return;
      isLoading = true; loading.style.display = 'block';
      setTimeout(function() {
        var batch = allLots.slice(offset, offset + BATCH);
        batch.forEach(function(d) {
          var _ex = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : (d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '');
          grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;">'
            + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);"></div>')
            + '<div class="lot-info"><div class="lot-title">' + d.t + '</div>'
            + '<div style="color:var(--green);font-weight:700;font-size:0.85rem;">' + (d.p ? d.p.toLocaleString('fr-FR') + ' €' : '') + '</div>'
            + (_ex ? '<div style="color:var(--text3);font-size:0.72rem;">' + _ex + '</div>' : '')
            + '<div style="color:var(--text3);font-size:0.7rem;">' + d.c + '</div></div></a>';
        });
        offset += batch.length;
        loading.style.display = 'none'; isLoading = false;
      }, 100);
    }
    loadMore();
    var sentinel = document.createElement('div'); sentinel.style.height = '1px';
    loading.parentNode.insertBefore(sentinel, loading);
    new IntersectionObserver(function(e) { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  })();
  </script>
</body>
</html>`;
}

function generateVillesIndex() {
  const cities = buildCityRegistry();
  const sorted = [...cities.entries()].filter(([, c]) => c.items.length >= 3).sort((a, b) => b[1].items.length - a[1].items.length);

  return `${htmlHead("Enchères par ville en France — Résultats | Adjugé !", "Retrouvez les résultats de ventes aux enchères ville par ville en France. Prix adjugés, photos, statistiques.", "", "/villes.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Villes</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <h1 style="font-size:1.5rem;margin-bottom:1.5rem;">Enchères par ville (${sorted.length} villes)</h1>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;">
      ${sorted.map(([slug, c]) => {
        const avg = c.items.length ? Math.round(c.totalPrice / c.items.length) : 0;
        return `<a href="/ville/${slug}.html" class="card" style="margin:0;text-decoration:none;color:inherit;transition:transform 0.15s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
          <div class="card-body" style="padding:1rem 1.2rem;">
            <div style="font-weight:700;font-size:1.05rem;margin-bottom:0.3rem;">${esc(c.name)}</div>
            <div style="display:flex;gap:1.5rem;font-size:0.85rem;color:var(--text2);">
              <span><strong style="color:var(--accent2);">${c.items.length}</strong> lots</span>
              <span><strong style="color:var(--green);">${formatPrice(c.totalPrice)} €</strong> total</span>
              <span>Moy. <strong>${formatPrice(avg)} €</strong></span>
            </div>
          </div>
        </a>`;
      }).join("\n      ")}
    </div>
  </div>
  ${footerHtml()}
</body>
</html>`;
}

// ─── Programmatic SEO: Brand/Keyword pages ───────────────────────────────────

const KNOWN_BRANDS = [
  "Rolex", "Hermès", "Cartier", "Chanel", "Louis Vuitton", "Ferrari", "Porsche", "BMW", "Mercedes",
  "Omega", "Patek Philippe", "Van Cleef", "Boucheron", "Bulgari", "Tiffany", "Lalique", "Daum",
  "Gallé", "Sèvres", "Meissen", "Longines", "Breitling", "IWC", "Jaeger-LeCoultre", "Audemars Piguet",
  "Dior", "Gucci", "Prada", "Yves Saint Laurent", "Givenchy", "Balenciaga", "Fendi", "Celine",
  "Aston Martin", "Lamborghini", "Maserati", "Bentley", "Rolls-Royce", "Jaguar",
  "Christofle", "Baccarat", "Saint-Louis", "Limoges", "Delft", "Murano",
];

const KNOWN_KEYWORDS = [
  "tableau", "pendule", "commode", "fauteuil", "bureau", "armoire", "montre", "bague",
  "collier", "bracelet", "sculpture", "bronze", "lithographie", "estampe", "tapis",
  "lustre", "miroir", "vase", "horloge", "secrétaire", "console", "buffet", "vitrine",
  "canapé", "chaise", "table", "lampe", "gravure", "aquarelle", "dessin", "affiche",
];

function buildKeywordRegistry() {
  const keywords = new Map();

  for (const [, { item }] of registry.items) {
    const desc = (item.description || item.title_translations?.["fr-FR"] || "").toLowerCase();
    const title = (item._aiTitle || "").toLowerCase();
    const combined = desc + " " + title;

    for (const brand of KNOWN_BRANDS) {
      const lower = brand.toLowerCase();
      if (combined.includes(lower)) {
        const slug = slugify(brand);
        if (!keywords.has(slug)) keywords.set(slug, { name: brand, items: [], isBrand: true });
        keywords.get(slug).items.push(item);
      }
    }

    for (const kw of KNOWN_KEYWORDS) {
      const pattern = new RegExp(`\\b${kw}s?\\b`, "i");
      if (pattern.test(combined)) {
        const slug = slugify(kw);
        if (!keywords.has(slug)) keywords.set(slug, { name: kw, items: [], isBrand: false });
        keywords.get(slug).items.push(item);
      }
    }
  }

  return keywords;
}

function generatePrixPage(slug, data) {
  const { name, items, isBrand } = data;
  const totalPrice = items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
  const avgPrice = items.length ? Math.round(totalPrice / items.length) : 0;
  const maxPrice = items.length ? Math.max(...items.map(i => i.pricing?.auctioned?.price || 0)) : 0;
  const minPrice = items.length ? Math.min(...items.filter(i => (i.pricing?.auctioned?.price || 0) > 0).map(i => i.pricing.auctioned.price)) : 0;

  const label = isBrand ? name : name.charAt(0).toUpperCase() + name.slice(1);
  const artDe = isBrand ? `d'un ${label}` : `d'un ${label}`;
  const pageTitle = `Prix ${label} aux enchères en France — Résultats & Photos | Adjugé !`;
  const desc = `${items.length} ${label} vendus aux enchères en France. Prix moyen : ${formatPrice(avgPrice)}€. De ${formatPrice(minPrice)}€ à ${formatPrice(maxPrice)}€. Photos et résultats.`;

  const top10 = [...items].sort((a, b) => (b.pricing?.auctioned?.price || 0) - (a.pricing?.auctioned?.price || 0)).slice(0, 10);

  const faqQuestions = [
    { q: `Quel est le prix ${artDe} aux enchères ?`, a: `Le prix moyen ${artDe} aux enchères en France est de ${formatPrice(avgPrice)} €. Les prix vont de ${formatPrice(minPrice)} € à ${formatPrice(maxPrice)} € selon l'état, la rareté et la provenance.` },
    { q: `Combien vaut un ${label} aux enchères ?`, a: `Sur ${items.length} lots ${label} vendus, la valeur moyenne est de ${formatPrice(avgPrice)} €. Le record observé est de ${formatPrice(maxPrice)} €.` },
    { q: `Où acheter un ${label} aux enchères en France ?`, a: `Adjugé ! recense ${items.length} lots ${label} vendus aux enchères dans toute la France avec photos, prix adjugés et estimations.` },
  ];

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqQuestions.map(({ q, a }) => ({
      "@type": "Question",
      "name": q,
      "acceptedAnswer": { "@type": "Answer", "text": a }
    }))
  };

  const lotsData = items.map(item => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 70) || "Objet");
    const price = item.pricing?.auctioned?.price || 0;
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
    const cat = item.category?.name || "";
    const _est = item.pricing?.estimates || {};
    const el = _est.low || _est.min || 0;
    const eh = _est.max || 0;
    const sp = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
    return { s: lotSlug(item), t: title, p: price, i: thumb, c: cat, el, eh, sp };
  });

  return `${htmlHead(pageTitle, desc, `<script type="application/ld+json">${JSON.stringify(faqSchema)}<\/script>`, `/prix/${slug}.html`)}
<body>
  ${navHtml()}
  <div class="breadcrumb">
    <a href="/index.html">Accueil</a> ›
    Prix ${esc(label)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Prix ${esc(label)} aux enchères</h1>
            <p style="color:var(--text);font-size:0.95rem;line-height:1.7;margin-bottom:1rem;background:var(--accent-glow);padding:1rem;border-radius:var(--radius-sm);border-left:3px solid var(--accent);">
              Au ${todayStr()}, <strong>${formatPrice(items.length)}</strong> lots ${esc(label)} ont été vendus aux enchères en France.
              Le prix moyen est de <strong>${formatPrice(avgPrice)} €</strong>, avec des adjudications allant de <strong>${formatPrice(minPrice)} €</strong> à <strong>${formatPrice(maxPrice)} €</strong>.
            </p>
            <div class="hero-stats" style="display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0;">
              <div class="stat-box"><div class="stat-number">${items.length}</div><div class="stat-label">lots vendus</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(totalPrice)} €</div><div class="stat-label">total adjugé</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(avgPrice)} €</div><div class="stat-label">prix moyen</div></div>
              <div class="stat-box"><div class="stat-number">${formatPrice(maxPrice)} €</div><div class="stat-label">record</div></div>
            </div>
          </div>
        </div>

        ${top10.length > 0 ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">🏆 Top 10 — ${esc(label)}</h3></div>
          <div class="card-body" style="padding:0;">
            ${top10.map((item, i) => {
              const rawD = item.description || item.title_translations?.["fr-FR"] || "";
              const lns = rawD.split("\\n").map(l => l.trim()).filter(Boolean);
              const title = item._aiTitle || (lns.length > 1 && lns[0].length < 60 ? lns[0] : lns[0]?.substring(0, 50) || "Objet");
              const price = item.pricing?.auctioned?.price || 0;
              const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
              return `<a href="/lot/${lotSlug(item)}.html" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);text-decoration:none;color:var(--text);transition:background 0.15s;">
                <span style="font-weight:800;font-size:${i < 3 ? '1.2rem' : '0.95rem'};min-width:28px;text-align:center;">${medal}</span>
                ${thumb ? `<img src="${esc(thumb)}" alt="" style="width:50px;height:38px;object-fit:cover;border-radius:4px;flex-shrink:0;">` : ""}
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(title)}</div>
                  <div style="font-size:0.88rem;font-weight:700;color:var(--green);">${formatPrice(price)} €</div>
                </div>
              </a>`;
            }).join("")}
          </div>
        </div>` : ""}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Questions fréquentes — ${esc(label)}</h2></div>
          <div class="card-body">
            ${faqQuestions.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q)}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a)}</p>
            </details>`).join("\n            ")}
          </div>
        </div>

        ${adSlot("betweenLots")}

        <div class="card">
          <div class="card-header"><h2 style="font-size:1.1rem;">Tous les lots ${esc(label)} (${items.length})</h2></div>
          <div class="card-body">
            <div class="lot-grid" id="prixGrid"></div>
            <div id="prixLoading" style="text-align:center;padding:1rem;display:none;color:var(--text3);">Chargement...</div>
          </div>
        </div>
      </main>
      ${sidebarHtml()}
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var allLots = ${JSON.stringify(lotsData)};
    var grid = document.getElementById('prixGrid');
    var loading = document.getElementById('prixLoading');
    var offset = 0, BATCH = 40, isLoading = false;
    function loadMore() {
      if (isLoading || offset >= allLots.length) return;
      isLoading = true; loading.style.display = 'block';
      setTimeout(function() {
        var batch = allLots.slice(offset, offset + BATCH);
        batch.forEach(function(d) {
          var _ex = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : (d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '');
          grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;">'
            + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);"></div>')
            + '<div class="lot-info"><div class="lot-title">' + d.t + '</div>'
            + '<div style="color:var(--green);font-weight:700;font-size:0.85rem;">' + (d.p ? d.p.toLocaleString('fr-FR') + ' €' : '') + '</div>'
            + (_ex ? '<div style="color:var(--text3);font-size:0.72rem;">' + _ex + '</div>' : '')
            + '<div style="color:var(--text3);font-size:0.7rem;">' + d.c + '</div></div></a>';
        });
        offset += batch.length;
        loading.style.display = 'none'; isLoading = false;
      }, 100);
    }
    loadMore();
    var sentinel = document.createElement('div'); sentinel.style.height = '1px';
    loading.parentNode.insertBefore(sentinel, loading);
    new IntersectionObserver(function(e) { if (e[0].isIntersecting) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  })();
  </script>
</body>
</html>`;
}

// ─── llms.txt generator (TASK 12) ──────────────────────────────────────────

function generateLlmsTxt() {
  const totalItems = registry.items.size;
  const totalUnsold = registry.unsold.size;
  const totalCats = registry.categories.size;
  const totalMaisons = registry.maisons.size;
  const allValues = [...registry.items.values()];
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);

  return `# Adjugé ! — auboisrieur.fr

> Agrégateur de résultats de ventes aux enchères publiques françaises.

## Description
Adjugé ! est un site indépendant qui recense les résultats de ventes aux enchères publiques en France.
Source des données : Interenchères (interencheres.com).
Mise à jour : quotidienne.
Contact : contact@auboisrieur.fr

## Données disponibles
- ${formatPrice(totalItems)} lots vendus avec prix adjugés, photos et estimations
- ${formatPrice(totalUnsold)} lots invendus
- ${totalCats} catégories (art, mobilier, bijoux, véhicules, etc.)
- ${totalMaisons} maisons de vente
- ${formatPrice(totalPrice)} € de total adjugé

## Pages et URL
- Accueil : https://auboisrieur.fr/index.html
- Catégories : https://auboisrieur.fr/categories.html
- Page catégorie : https://auboisrieur.fr/categorie/{slug}.html
- Page lot : https://auboisrieur.fr/lot/{slug}.html
- Top ventes : https://auboisrieur.fr/top-ventes.html
- Invendus : https://auboisrieur.fr/invendus.html
- Statistiques : https://auboisrieur.fr/statistiques.html
- Villes : https://auboisrieur.fr/villes.html
- Page ville : https://auboisrieur.fr/ville/{slug}.html
- Prix par marque/mot-clé : https://auboisrieur.fr/prix/{slug}.html
- Maisons de vente : https://auboisrieur.fr/maisons.html
- Page maison : https://auboisrieur.fr/maison/{slug}.html
- API stats JSON : https://auboisrieur.fr/api/stats.json
- Données complètes LLM : https://auboisrieur.fr/llms-full.txt
- À propos : https://auboisrieur.fr/a-propos.html

## Exemples de questions auxquelles ce site peut répondre
- Quel est le prix moyen d'une Rolex aux enchères en France ?
- Combien coûte un tableau aux enchères ?
- Quels sont les résultats d'enchères à Paris / Lyon / Bordeaux ?
- Quel est le record de vente aux enchères en France récemment ?
- Quelles sont les catégories les plus populaires aux enchères ?
- Combien de lots sont vendus par jour aux enchères en France ?

## Fraîcheur des données
Dernière mise à jour : ${todayStr()}
Fréquence : quotidienne (scraping automatisé)
Historique cumulé : 7+ jours glissants
`;
}

function generateLlmsFullTxt() {
  const allValues = [...registry.items.values()];
  const totalItems = allValues.length;
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);
  const avgPrice = totalItems ? Math.round(totalPrice / totalItems) : 0;

  // Top categories
  const catStats = [...registry.categories.entries()]
    .map(([slug, c]) => {
      const catTotal = c.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
      const catAvg = c.items.length ? Math.round(catTotal / c.items.length) : 0;
      return { name: c._aiName || c.name, count: c.items.length, avg: catAvg };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Top sales
  const top20 = allValues
    .sort((a, b) => (b.item.pricing?.auctioned?.price || 0) - (a.item.pricing?.auctioned?.price || 0))
    .slice(0, 20);

  // Top cities
  const cities = buildCityRegistry();
  const topCities = [...cities.entries()].filter(([, c]) => c.items.length >= 3).sort((a, b) => b[1].items.length - a[1].items.length).slice(0, 20);

  // Brands found
  const kwReg = buildKeywordRegistry();
  const topBrands = [...kwReg.entries()].filter(([, d]) => d.isBrand && d.items.length >= 3).sort((a, b) => b[1].items.length - a[1].items.length).slice(0, 20);

  let txt = `# Adjugé ! — auboisrieur.fr — Données complètes

## Résumé
Adjugé ! est un agrégateur de résultats de ventes aux enchères publiques françaises.
Au ${todayStr()}, le site recense ${formatPrice(totalItems)} lots vendus pour ${formatPrice(totalPrice)} €.
Prix moyen par lot : ${formatPrice(avgPrice)} €.

## Top catégories
${catStats.map((c, i) => `${i + 1}. ${c.name} : ${c.count} lots, prix moyen ${formatPrice(c.avg)} €`).join("\n")}

## Top ventes (les plus chères)
${top20.map(({ item }, i) => {
  const title = item._aiTitle || (item.description || "").split("\n")[0]?.substring(0, 60) || "Lot";
  const price = item.pricing?.auctioned?.price || 0;
  return `${i + 1}. ${title} : ${formatPrice(price)} €`;
}).join("\n")}

## Villes couvertes
${topCities.map(([, c]) => `${c.name} (${c.items.length} lots)`).join(", ")}

## Marques présentes
${topBrands.map(([, d]) => `${d.name} (${d.items.length} lots)`).join(", ")}

## Source
Données collectées quotidiennement depuis Interenchères (interencheres.com).
Descriptions enrichies par intelligence artificielle.
Dernière mise à jour : ${todayStr()}.
`;

  return txt;
}

// ─── API stats.json generator (TASK 13) ────────────────────────────────────

function generateStatsJson(dateStr) {
  const allValues = [...registry.items.values()];
  const totalItems = allValues.length;
  const totalPrice = allValues.reduce((s, { item }) => s + (item.pricing?.auctioned?.price || 0), 0);
  const avgPrice = totalItems ? Math.round(totalPrice / totalItems) : 0;
  const maxPrice = totalItems ? Math.max(...allValues.map(({ item }) => item.pricing?.auctioned?.price || 0)) : 0;

  const categories = [...registry.categories.entries()]
    .map(([slug, c]) => {
      const catTotal = c.items.reduce((s, i) => s + (i.pricing?.auctioned?.price || 0), 0);
      const catAvg = c.items.length ? Math.round(catTotal / c.items.length) : 0;
      return { slug, name: c._aiName || c.name, lots: c.items.length, total_eur: catTotal, avg_eur: catAvg };
    })
    .sort((a, b) => b.lots - a.lots);

  return JSON.stringify({
    date: dateStr,
    source: "Interenchères (interencheres.com)",
    total_lots: totalItems,
    total_adjuge_eur: totalPrice,
    prix_moyen_eur: avgPrice,
    record_absolu_eur: maxPrice,
    categories,
  }, null, 2);
}

// ─── Full site rebuild ──────────────────────────────────────────────────────

function generateMentionsLegales() {
  return `${htmlHead("Mentions légales", "Mentions légales du site auboisrieur.fr", "", "/mentions-legales.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Mentions légales</div>
  <div class="container">
    <div class="card"><div class="card-body" style="max-width:800px;margin:0 auto;line-height:1.8;color:var(--text);">
      <h1 style="font-size:1.6rem;margin-bottom:1.5rem;">Mentions légales</h1>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Éditeur du site</h2>
      <p>Le site <strong>auboisrieur.fr</strong> est un site d'agrégation de résultats de ventes aux enchères publiques en France. Il est édité à titre personnel.</p>
      <p>Contact : <a href="mailto:contact@auboisrieur.fr" style="color:var(--accent);">contact@auboisrieur.fr</a></p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Hébergement</h2>
      <p>Ce site est hébergé par <strong>Hostinger International Ltd</strong>, 61 Lordou Vironos str., 6023 Larnaca, Chypre.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Propriété intellectuelle</h2>
      <p>Les photos et descriptions des lots proviennent des catalogues de ventes aux enchères publiés par les maisons de vente. Ces contenus restent la propriété de leurs auteurs respectifs.</p>
      <p>Les textes enrichis par intelligence artificielle (titres, descriptions, FAQ) sont générés automatiquement à titre informatif et ne constituent en aucun cas une expertise officielle.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Liens d'affiliation</h2>
      <p>Ce site contient des liens d'affiliation vers <strong>Amazon</strong> et <strong>eBay</strong>. En cliquant sur ces liens et en effectuant un achat, nous percevons une commission sans surcoût pour vous. Ces liens sont identifiés par les boutons "Chercher sur Amazon" et "Chercher sur eBay".</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Publicité</h2>
      <p>Ce site utilise <strong>Google AdSense</strong> pour afficher des publicités. Google utilise des cookies pour diffuser des annonces pertinentes. Vous pouvez gérer vos préférences publicitaires via <a href="https://www.google.com/settings/ads" target="_blank" rel="nofollow" style="color:var(--accent);">les paramètres Google Ads</a>.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Responsabilité</h2>
      <p>Les informations diffusées sur ce site (prix, descriptions, estimations) sont fournies à titre indicatif. Elles ne constituent ni une expertise, ni un conseil d'achat ou de vente. Nous ne garantissons pas l'exactitude des prix affichés ni la disponibilité des lots.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">Droit applicable</h2>
      <p>Le présent site est soumis au droit français. Tout litige sera de la compétence des juridictions françaises.</p>
    </div></div>
  </div>
  ${footerHtml()}
</body></html>`;
}

function generatePolitiqueConfidentialite() {
  return `${htmlHead("Politique de confidentialité", "Politique de protection des données personnelles du site auboisrieur.fr", "", "/politique-confidentialite.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Politique de confidentialité</div>
  <div class="container">
    <div class="card"><div class="card-body" style="max-width:800px;margin:0 auto;line-height:1.8;color:var(--text);">
      <h1 style="font-size:1.6rem;margin-bottom:1.5rem;">Politique de confidentialité & Protection des données</h1>
      <p style="color:var(--text2);margin-bottom:1.5rem;">Dernière mise à jour : ${new Date().toISOString().slice(0, 10)}</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">1. Données collectées</h2>
      <p>Le site <strong>auboisrieur.fr</strong> ne collecte <strong>aucune donnée personnelle directement</strong>. Nous ne proposons ni formulaire d'inscription, ni espace membre, ni newsletter.</p>
      <p>Cependant, des données peuvent être collectées indirectement par nos partenaires :</p>
      <ul style="margin:0.5rem 0 0.5rem 1.5rem;">
        <li><strong>Google AdSense</strong> : cookies publicitaires pour afficher des annonces personnalisées</li>
        <li><strong>Google Analytics / GoatCounter</strong> : statistiques anonymes de fréquentation</li>
        <li><strong>Amazon / eBay (affiliation)</strong> : cookies de suivi lors du clic sur les liens partenaires</li>
      </ul>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">2. Cookies</h2>
      <p>Ce site utilise des cookies pour :</p>
      <ul style="margin:0.5rem 0 0.5rem 1.5rem;">
        <li><strong>Mémoriser votre préférence de thème</strong> (clair/sombre) — cookie local, aucune donnée transmise</li>
        <li><strong>Afficher des publicités</strong> via Google AdSense — cookies tiers de Google</li>
        <li><strong>Mesurer l'audience</strong> — cookies analytiques anonymisés</li>
      </ul>
      <p>Vous pouvez à tout moment désactiver les cookies via les paramètres de votre navigateur.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">3. Finalité du traitement</h2>
      <p>Les données indirectement collectées servent uniquement à :</p>
      <ul style="margin:0.5rem 0 0.5rem 1.5rem;">
        <li>Améliorer l'expérience utilisateur (thème, navigation)</li>
        <li>Financer le site via la publicité et l'affiliation</li>
        <li>Analyser la fréquentation pour améliorer le contenu</li>
      </ul>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">4. Durée de conservation</h2>
      <p>Le cookie de thème est conservé dans votre navigateur sans limite de durée. Les cookies publicitaires et analytiques sont gérés par leurs émetteurs respectifs (Google, Amazon, eBay) selon leurs propres politiques.</p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">5. Vos droits (RGPD)</h2>
      <p>Conformément au Règlement Général sur la Protection des Données (RGPD), vous disposez des droits suivants :</p>
      <ul style="margin:0.5rem 0 0.5rem 1.5rem;">
        <li><strong>Droit d'accès</strong> : savoir quelles données sont collectées</li>
        <li><strong>Droit de rectification</strong> : corriger vos données</li>
        <li><strong>Droit à l'effacement</strong> : demander la suppression de vos données</li>
        <li><strong>Droit d'opposition</strong> : refuser le traitement de vos données</li>
        <li><strong>Droit à la portabilité</strong> : récupérer vos données dans un format lisible</li>
      </ul>
      <p>Pour exercer vos droits, contactez-nous à : <a href="mailto:contact@auboisrieur.fr" style="color:var(--accent);">contact@auboisrieur.fr</a></p>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">6. Sous-traitants</h2>
      <table style="width:100%;border-collapse:collapse;margin:1rem 0;">
        <tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:0.5rem;color:var(--accent);">Partenaire</th><th style="text-align:left;padding:0.5rem;color:var(--accent);">Finalité</th><th style="text-align:left;padding:0.5rem;color:var(--accent);">Politique</th></tr>
        <tr style="border-bottom:1px solid var(--border);"><td style="padding:0.5rem;">Google AdSense</td><td style="padding:0.5rem;">Publicité</td><td style="padding:0.5rem;"><a href="https://policies.google.com/privacy" target="_blank" rel="nofollow" style="color:var(--accent);">Voir</a></td></tr>
        <tr style="border-bottom:1px solid var(--border);"><td style="padding:0.5rem;">Amazon</td><td style="padding:0.5rem;">Affiliation</td><td style="padding:0.5rem;"><a href="https://www.amazon.fr/gp/help/customer/display.html?nodeId=201909010" target="_blank" rel="nofollow" style="color:var(--accent);">Voir</a></td></tr>
        <tr style="border-bottom:1px solid var(--border);"><td style="padding:0.5rem;">eBay</td><td style="padding:0.5rem;">Affiliation</td><td style="padding:0.5rem;"><a href="https://www.ebay.fr/help/policies/member-behaviour-policies/user-privacy-notice-privacy-policy?id=4260" target="_blank" rel="nofollow" style="color:var(--accent);">Voir</a></td></tr>
        <tr><td style="padding:0.5rem;">Hostinger</td><td style="padding:0.5rem;">Hébergement</td><td style="padding:0.5rem;"><a href="https://www.hostinger.fr/politique-de-confidentialite" target="_blank" rel="nofollow" style="color:var(--accent);">Voir</a></td></tr>
      </table>

      <h2 style="font-size:1.2rem;color:var(--accent);margin-top:1.5rem;">7. Contact</h2>
      <p>Pour toute question relative à la protection de vos données : <a href="mailto:contact@auboisrieur.fr" style="color:var(--accent);">contact@auboisrieur.fr</a></p>
    </div></div>
  </div>
  ${footerHtml()}
</body></html>`;
}

function rebuildCategories() {
  // Rebuild categories from current item.category.name (which may have been updated by AI or rules)
  registry.categories.clear();
  for (const [, { item }] of registry.items) {
    const catName = item.category?.name;
    if (!catName) continue;
    const catSlug = slugify(catName);
    if (!registry.categories.has(catSlug)) {
      registry.categories.set(catSlug, {
        name: catName,
        id: item.category.id,
        description: item.category.description || "",
        items: [],
      });
    }
    registry.categories.get(catSlug).items.push(item);
  }
  console.log(`  📂 ${registry.categories.size} catégories reconstruites`);
}

function rebuildAllPages(dateStr) {
  // Rebuild categories before generating pages (AI may have changed categories)
  rebuildCategories();

  // Ensure directories
  ensureDir(path.join(SITE_DIR, "lot"));
  ensureDir(path.join(SITE_DIR, "categorie"));
  ensureDir(path.join(SITE_DIR, "jour"));
  ensureDir(path.join(SITE_DIR, "data"));
  ensureDir(path.join(SITE_DIR, "ville"));
  ensureDir(path.join(SITE_DIR, "prix"));
  ensureDir(path.join(SITE_DIR, "maison"));

  let pageCount = 0;
  let skipped = 0;

  // Template version — increment when lot page template changes to force regeneration
  const TEMPLATE_VERSION = "v5";
  // HACK: skip force-regen in CI to avoid 26K files upload timeout
  const skipForceRegen = process.env.SKIP_FORCE_REGEN === "true";
  const versionFile = path.join(DATA_DIR, "template-version.txt");
  let lastVersion = "";
  try { lastVersion = fs.readFileSync(versionFile, "utf-8").trim(); } catch {}
  const forceRegen = !skipForceRegen && lastVersion !== TEMPLATE_VERSION;
  if (forceRegen) console.log(`  🔄 Template ${lastVersion || "?"} → ${TEMPLATE_VERSION} — regénération de toutes les pages lot`);
  fs.writeFileSync(versionFile, TEMPLATE_VERSION, "utf-8");

  // Lot pages — regenerate all if template changed, otherwise only new
  for (const [itemId, { item, sale }] of registry.items) {
    const slug = lotSlug(item);
    const filePath = path.join(SITE_DIR, "lot", `${slug}.html`);
    if (!forceRegen && fs.existsSync(filePath)) { skipped++; continue; }
    fs.writeFileSync(filePath, generateLotPage(item, sale), "utf-8");
    pageCount++;
  }

  // Category pages — always regenerate (content changes with new lots)
  for (const [slug, data] of registry.categories) {
    fs.writeFileSync(path.join(SITE_DIR, "categorie", `${slug}.html`), generateCategoryPage(slug, data), "utf-8");
    pageCount++;
  }

  // Index pages — always regenerate
  fs.writeFileSync(path.join(SITE_DIR, "categories.html"), generateCategoriesIndex(), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), generateHomePage(dateStr), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "top-ventes.html"), generateTopVentesPage(), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "invendus.html"), generateInvendusIndex(), "utf-8");
  pageCount += 4;

  // Generate a page per day (group lots by sale date)
  const dayMap = new Map();
  for (const [, { item, sale }] of registry.items) {
    const d = sale?.datetime ? sale.datetime.substring(0, 10) : dateStr;
    if (!dayMap.has(d)) dayMap.set(d, []);
    dayMap.get(d).push({ item, sale });
  }
  for (const [day] of dayMap) {
    fs.writeFileSync(path.join(SITE_DIR, "jour", `${day}.html`), generateHomePage(day), "utf-8");
    pageCount++;
  }
  if (!dayMap.has(dateStr)) {
    fs.writeFileSync(path.join(SITE_DIR, "jour", `${dateStr}.html`), generateHomePage(dateStr), "utf-8");
    pageCount++;
  }

  // Unsold lot pages — regenerate all if template changed
  for (const [itemId, { item, sale }] of registry.unsold) {
    const slug = lotSlug(item);
    const filePath = path.join(SITE_DIR, "lot", `${slug}.html`);
    if (!forceRegen && fs.existsSync(filePath)) { skipped++; continue; }
    fs.writeFileSync(filePath, generateUnsoldPage(item, sale), "utf-8");
    pageCount++;
  }

  if (skipped > 0) console.log(`  ⏩ ${skipped} pages lot déjà existantes (ignorées)`);

  // Legal pages
  fs.writeFileSync(path.join(SITE_DIR, "mentions-legales.html"), generateMentionsLegales(), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "politique-confidentialite.html"), generatePolitiqueConfidentialite(), "utf-8");
  pageCount += 2;

  // À propos page (TASK 10)
  fs.writeFileSync(path.join(SITE_DIR, "a-propos.html"), generateAProposPage(), "utf-8");
  pageCount++;

  // Statistiques page (TASK 11)
  fs.writeFileSync(path.join(SITE_DIR, "statistiques.html"), generateStatistiquesPage(dateStr), "utf-8");
  pageCount++;

  // Maison pages — always regenerate
  for (const [slug, data] of registry.maisons) {
    if (data.items.length >= 3) {
      fs.writeFileSync(path.join(SITE_DIR, "maison", `${slug}.html`), generateMaisonPage(slug, data), "utf-8");
      pageCount++;
    }
  }
  fs.writeFileSync(path.join(SITE_DIR, "maisons.html"), generateMaisonsIndex(), "utf-8");
  pageCount++;

  // City pages (programmatic SEO)
  const cityRegistry = buildCityRegistry();
  let cityPageCount = 0;
  for (const [slug, data] of cityRegistry) {
    if (data.items.length >= 3) {
      fs.writeFileSync(path.join(SITE_DIR, "ville", `${slug}.html`), generateVillePage(slug, data), "utf-8");
      cityPageCount++;
    }
  }
  fs.writeFileSync(path.join(SITE_DIR, "villes.html"), generateVillesIndex(), "utf-8");
  pageCount += cityPageCount + 1;
  if (cityPageCount > 0) console.log(`  📍 ${cityPageCount} pages ville générées`);

  // Brand/keyword pages (programmatic SEO)
  const kwRegistry = buildKeywordRegistry();
  let kwPageCount = 0;
  for (const [slug, data] of kwRegistry) {
    if (data.items.length >= 3) {
      fs.writeFileSync(path.join(SITE_DIR, "prix", `${slug}.html`), generatePrixPage(slug, data), "utf-8");
      kwPageCount++;
    }
  }
  pageCount += kwPageCount;
  if (kwPageCount > 0) console.log(`  🏷️ ${kwPageCount} pages prix/marque générées`);

  // llms.txt (TASK 12)
  fs.writeFileSync(path.join(SITE_DIR, "llms.txt"), generateLlmsTxt(), "utf-8");
  pageCount++;

  // llms-full.txt
  fs.writeFileSync(path.join(SITE_DIR, "llms-full.txt"), generateLlmsFullTxt(), "utf-8");
  pageCount++;

  // /api/stats.json (TASK 13)
  ensureDir(path.join(SITE_DIR, "api"));
  fs.writeFileSync(path.join(SITE_DIR, "api", "stats.json"), generateStatsJson(dateStr), "utf-8");
  pageCount++;

  // Search index as JS — includes both sold AND unsold items
  const allSearchItems = [...registry.items.values(), ...registry.unsold.values()];
  const searchIndex = allSearchItems.map(({ item }) => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const fallbackTitle = (lns.length > 1 && lns[0].length < 60) ? lns[0] + " " + lns.slice(1).join(" ") : lns.join(" ");
    const title = item._aiTitle || fallbackTitle;
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
    const price = item.pricing?.auctioned?.price ? formatPrice(item.pricing.auctioned.price) : "Invendu";
    return { id: lotSlug(item), t: title.substring(0, 150), p: price, img: thumb };
  });
  fs.writeFileSync(path.join(SITE_DIR, "search-data.js"), `window.__SI=${JSON.stringify(searchIndex)};`, "utf-8");
  pageCount++;

  // Sitemap.xml
  const siteUrl = config.siteUrl || "https://auboisrieur.fr";
  const today = dateStr || new Date().toISOString().slice(0, 10);
  let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  sitemap += `  <url><loc>${siteUrl}/index.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/categories.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/top-ventes.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/invendus.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/mentions-legales.html</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/politique-confidentialite.html</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.3</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/a-propos.html</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.5</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/statistiques.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/api/stats.json</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.3</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/villes.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>\n`;
  sitemap += `  <url><loc>${siteUrl}/maisons.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>\n`;
  for (const [slug] of registry.categories) {
    sitemap += `  <url><loc>${siteUrl}/categorie/${slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>\n`;
  }
  // City pages
  for (const [slug, data] of cityRegistry) {
    if (data.items.length >= 3) {
      sitemap += `  <url><loc>${siteUrl}/ville/${slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>\n`;
    }
  }
  // Brand/keyword pages
  for (const [slug, data] of kwRegistry) {
    if (data.items.length >= 3) {
      sitemap += `  <url><loc>${siteUrl}/prix/${slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>\n`;
    }
  }
  // Maison pages
  for (const [slug, data] of registry.maisons) {
    if (data.items.length >= 3) {
      sitemap += `  <url><loc>${siteUrl}/maison/${slug}.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>\n`;
    }
  }
  for (const [, { item }] of registry.items) {
    sitemap += `  <url><loc>${siteUrl}/lot/${lotSlug(item)}.html</loc><lastmod>${today}</lastmod><priority>0.6</priority></url>\n`;
  }
  for (const [, { item }] of registry.unsold) {
    sitemap += `  <url><loc>${siteUrl}/lot/${lotSlug(item)}.html</loc><lastmod>${today}</lastmod><priority>0.5</priority></url>\n`;
  }
  sitemap += `</urlset>`;
  fs.writeFileSync(path.join(SITE_DIR, "sitemap.xml"), sitemap, "utf-8");

  // robots.txt
  const robots = `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml

User-agent: Googlebot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

Disallow: /data/
Disallow: /stats.html
`;
  fs.writeFileSync(path.join(SITE_DIR, "robots.txt"), robots, "utf-8");

  // stats.html — non-indexed live visitor counter (GoatCounter API)
  const gcToken = process.env.GOATCOUNTER_TOKEN || "";
  fs.writeFileSync(path.join(SITE_DIR, "stats.html"), `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Visiteurs — Adjugé !</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #0f0f13; color: #e8e8ed; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .counter { font-size: 8rem; font-weight: 900; background: linear-gradient(135deg, #7c5cfc, #34d399); -webkit-background-clip: text; -webkit-text-fill-color: transparent; line-height: 1; transition: transform 0.3s; }
    .counter.bump { transform: scale(1.05); }
    .label { color: #9999ab; font-size: 1.2rem; margin-top: 0.5rem; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #34d399; margin-right: 8px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    .back { position: absolute; top: 1.5rem; left: 1.5rem; color: #7c5cfc; text-decoration: none; font-size: 0.9rem; }
  </style>
</head>
<body>
  <a href="/index.html" class="back">← Retour</a>
  <div class="counter" id="count">–</div>
  <div class="label"><span class="dot"></span>visiteurs cumulés</div>
  <script>
  const API = 'https://wildjack.goatcounter.com/api/v0';
  const TOKEN = '${gcToken}';
  const H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const el = document.getElementById('count');
  let prev = 0;

  async function update() {
    try {
      const r = await fetch(API + '/stats/total', { headers: H });
      const j = await r.json();
      const n = j.total || j.total_unique || 0;
      if (n !== prev) { el.textContent = Number(n).toLocaleString('fr-FR'); el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 300); prev = n; }
    } catch(e) { console.error(e); }
  }

  update();
  setInterval(update, 10000);
  </script>
</body>
</html>`, "utf-8");
  pageCount++;

  // ads.txt — required by Google AdSense
  if (config.adsenseId) {
    const pubId = config.adsenseId.replace("ca-", "");
    fs.writeFileSync(path.join(SITE_DIR, "ads.txt"), `google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`, "utf-8");
    pageCount++;
  }
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

  // favicon.svg — maillet "Adjugé !"
  fs.writeFileSync(path.join(SITE_DIR, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c5cfc"/></linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#2dd4bf"/></linearGradient>
  </defs>
  <rect x="14" y="6" width="28" height="12" rx="4" transform="rotate(-40 28 12)" fill="url(#g)"/>
  <rect x="24" y="16" width="5" height="24" rx="2.5" transform="rotate(-40 26.5 28)" fill="#7c5cfc"/>
  <rect x="10" y="49" width="44" height="7" rx="3.5" fill="url(#g2)"/>
  <rect x="16" y="44" width="32" height="7" rx="2" fill="url(#g2)" opacity="0.6"/>
  <text x="32" y="60" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="9" fill="#fff" opacity="0.9">!</text>
</svg>`, "utf-8");

  // Copy logo files if they exist
  const logoDark = path.join(__dirname, "logo-dark.jpg");
  const logoLight = path.join(__dirname, "logo-light.jpg");
  if (fs.existsSync(logoDark)) { fs.copyFileSync(logoDark, path.join(SITE_DIR, "logo-dark.jpg")); pageCount++; }
  if (fs.existsSync(logoLight)) { fs.copyFileSync(logoLight, path.join(SITE_DIR, "logo-light.jpg")); pageCount++; }

  return pageCount;
}

// ─── FTP upload ─────────────────────────────────────────────────────────────

async function ftpUpload() {
  if (process.env.SKIP_FTP === "true") { console.log("  ⏭️  FTP skip (lftp dans le workflow)"); return; }
  if (!config.ftp?.enabled || !config.ftp.host) return;

  const remote = (config.ftp.remotePath || "/public_html").replace(/\/+$/, "");

  // Collect files to upload
  const UPLOAD_EXT = new Set([".html", ".xml", ".txt", ".json", ".js", ".svg", ".jpg", ".png", ".ico", ".webp"]);
  function collectFiles(localDir, remoteDir, files = []) {
    const entries = fs.readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "data") continue;
        collectFiles(path.join(localDir, entry.name), `${remoteDir}/${entry.name}`, files);
      } else if (UPLOAD_EXT.has(path.extname(entry.name)) || entry.name === ".htaccess") {
        files.push({ local: path.join(localDir, entry.name), remote: `${remoteDir}/${entry.name}` });
      }
    }
    return files;
  }

  const allFiles = collectFiles(SITE_DIR, remote);

  // Incremental upload tracker
  const uploadedTracker = path.join(DATA_DIR, "ftp-uploaded.json");
  let alreadyUploaded = {};
  try { alreadyUploaded = JSON.parse(fs.readFileSync(uploadedTracker, "utf-8")); } catch {}

  const alwaysUpload = new Set(["index.html", "categories.html", "top-ventes.html", "invendus.html", "sitemap.xml", "ads.txt", "robots.txt", ".htaccess", "search-index.json", "search-data.js", "mentions-legales.html", "politique-confidentialite.html", "a-propos.html", "statistiques.html", "llms.txt", "llms-full.txt", "stats.json", "maisons.html", "villes.html"]);

  const files = allFiles.filter(f => {
    const basename = path.basename(f.local);
    if (alwaysUpload.has(basename)) return true;
    if (basename.startsWith("categorie-")) return true;
    const mtime = fs.statSync(f.local).mtimeMs;
    if (alreadyUploaded[f.remote] && alreadyUploaded[f.remote] >= mtime) return false;
    return true;
  });

  // Prioritize index pages (non-lot pages go first)
  const priorityFiles = files.filter(f => !f.remote.includes("/lot/"));
  const lotFiles = files.filter(f => f.remote.includes("/lot/"));
  const sortedFiles = [...priorityFiles, ...lotFiles];

  console.log(`  📤 ${sortedFiles.length} fichiers à uploader (${allFiles.length - files.length} déjà à jour)`);
  if (sortedFiles.length === 0) return;

  const saveTracker = () => { try { fs.writeFileSync(uploadedTracker, JSON.stringify(alreadyUploaded), "utf-8"); } catch {} };

  // Try SFTP first (port 22), then FTP (port 21) as fallback
  let connected = false;

  // === SFTP attempt ===
  try {
    const SftpClient = (await import("ssh2-sftp-client")).default;
    const sftp = new SftpClient();
    console.log("  🔐 Tentative SFTP (port 22)...");
    await sftp.connect({
      host: config.ftp.host,
      port: 22,
      username: config.ftp.user,
      password: config.ftp.password,
      readyTimeout: 30000,
      retries: 2,
      retry_minTimeout: 5000,
    });
    connected = true;
    console.log("  ✅ SFTP connecté !");

    // Ensure directories exist
    const dirs = new Set();
    for (const f of sortedFiles) {
      const dir = f.remote.substring(0, f.remote.lastIndexOf("/"));
      dirs.add(dir);
    }
    for (const dir of [...dirs].sort()) {
      try { await sftp.mkdir(dir, true); } catch {}
    }
    if (dirs.size > 0) console.log(`  📁 ${dirs.size} dossiers vérifiés`);

    const start = Date.now();
    let uploadCount = 0;
    let errorCount = 0;

    for (const f of sortedFiles) {
      try {
        await sftp.put(f.local, f.remote);
        uploadCount++;
        alreadyUploaded[f.remote] = Date.now();
        if (uploadCount % 200 === 0) {
          console.log(`    ${uploadCount}/${sortedFiles.length} uploadés...`);
          saveTracker();
        }
      } catch (err) {
        errorCount++;
        if (errorCount <= 5) console.warn(`  ⚠ Upload ${f.remote}: ${err.message}`);
        if (errorCount > 20) {
          console.warn(`  ⛔ Trop d'erreurs SFTP (${errorCount}), arrêt`);
          break;
        }
      }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  📤 SFTP terminé: ${uploadCount}/${sortedFiles.length} fichiers en ${elapsed}s${errorCount ? ` (${errorCount} erreurs)` : ""}`);
    saveTracker();
    await sftp.end();
    return;
  } catch (err) {
    console.warn(`  ⚠ SFTP échoué: ${err.message}`);
  }

  // === FTP fallback ===
  try {
    const { Client } = await import("basic-ftp");
    const client = new Client(600000);
    client.ftp.verbose = false;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`  📡 Tentative FTP (port 21) ${attempt}/${maxRetries}...`);
        await client.access({
          host: config.ftp.host,
          user: config.ftp.user,
          password: config.ftp.password,
          secure: config.ftp.secure || false,
        });
        connected = true;
        console.log("  ✅ FTP connecté !");
        break;
      } catch (err) {
        console.warn(`  ⚠ FTP connexion tentative ${attempt}/${maxRetries}: ${err.message}`);
        if (attempt === maxRetries) { client.close(); return; }
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    if (!connected) return;

    const dirs = new Set();
    for (const f of sortedFiles) {
      const dir = f.remote.substring(0, f.remote.lastIndexOf("/"));
      dirs.add(dir);
    }
    for (const dir of [...dirs].sort()) {
      try { await client.ensureDir(dir); } catch {}
    }
    if (dirs.size > 0) console.log(`  📁 ${dirs.size} dossiers vérifiés`);

    const start = Date.now();
    let uploadCount = 0;
    let errorCount = 0;

    for (const f of sortedFiles) {
      try {
        await client.uploadFrom(f.local, f.remote);
        uploadCount++;
        alreadyUploaded[f.remote] = Date.now();
        if (uploadCount % 200 === 0) {
          console.log(`    ${uploadCount}/${sortedFiles.length} uploadés...`);
          saveTracker();
        }
      } catch (err) {
        errorCount++;
        if (errorCount <= 5) console.warn(`  ⚠ Upload ${f.remote}: ${err.message}`);
        if (errorCount > 20) {
          console.warn(`  ⛔ Trop d'erreurs FTP (${errorCount}), arrêt`);
          break;
        }
      }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  📤 FTP terminé: ${uploadCount}/${sortedFiles.length} fichiers en ${elapsed}s${errorCount ? ` (${errorCount} erreurs)` : ""}`);
    saveTracker();
    client.close();
  } catch (err) {
    console.warn(`  ⚠ FTP erreur: ${err.message}`);
  }
}

// ─── daemon ─────────────────────────────────────────────────────────────────

function runDaemon(dateStr, intervalSec) {
  ensureDir(SITE_DIR);
  const dataDir = DATA_DIR;
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

// ─── AI Enrichment (GPT-4o-mini) ──────────────────────────────────────────────

const AI_CACHE_FILE = path.join(SITE_DIR, "data", "ai-cache.json");

function loadAiCache() {
  try {
    if (fs.existsSync(AI_CACHE_FILE)) return JSON.parse(fs.readFileSync(AI_CACHE_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveAiCache(cache) {
  ensureDir(path.join(SITE_DIR, "data"));
  fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(cache), "utf-8");
}

async function callGpt(messages, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 800,
      });
      const result = execFileSync("curl", [
        "-s", "--max-time", "30",
        "https://api.openai.com/v1/chat/completions",
        "-H", "Content-Type: application/json",
        "-H", `Authorization: Bearer ${config.openaiKey}`,
        "-d", body,
      ], { maxBuffer: 1024 * 1024, timeout: 35000 });
      const json = JSON.parse(result.toString("utf-8"));
      if (json.error) throw new Error(json.error.message);
      return json.choices?.[0]?.message?.content || "";
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }
}

const AI_SYSTEM_PROMPT = `Tu es un expert en objets d'art, antiquités et enchères. On te donne la description brute d'un lot vendu aux enchères en France avec son prix d'adjudication.

RÈGLES IMPORTANTES :
- IDENTIFIE le vrai objet dans la description. La première ligne peut être un numéro d'immatriculation, un code, un numéro de lot — ignore-les. Trouve le NOM RÉEL du produit (marque, modèle, type d'objet).
- IGNORE les infos logistiques : dates d'expo, adresses de retrait, conditions de vente, frais.
- La catégorie Interenchères peut être vague ("Secteurs d'activités spécifiques - Divers") — recatégorise correctement.

Tu dois retourner un JSON avec exactement 6 champs :
- "title": le NOM RÉEL de l'objet, accrocheur, clair et SEO-friendly (max 70 car). Ex: si la desc parle d'une "CITROEN AMI" avec immatriculation, le titre doit être "Citroën AMI — Véhicule électrique compact". Pas de numéro de lot, pas de plaque d'immat, pas de "A partir de".
- "desc": une description enrichie de 2-3 phrases (max 300 car) qui décrit l'objet, son intérêt, ses caractéristiques. Ton expert qui donne envie. Pas de mention de la maison de vente ni d'infos expo/retrait.
- "category": la VRAIE catégorie basée sur l'objet réel. Choisis parmi : Bijoux - Montres, Tableaux - Peintures, Mobilier, Céramiques - Porcelaine, Art asiatique, Livres - Manuscrits, Véhicules, Vins - Spiritueux, Mode - Luxe, Jouets - Figurines, Instruments de musique, Art contemporain, Sculptures, Argenterie - Orfèvrerie, Numismatique, Photographie, Luminaires, Tapis - Textiles, Objets de vitrine, Matériel professionnel, Électroménager, High-tech - Multimédia, Sports - Loisirs, Jardin - Extérieur, Autre
- "price_analysis": analyse du prix en 2-3 phrases (max 250 car). Compare avec le marché.
- "faq": array de 3 objets {q, a} — questions contenant le NOM RÉEL DE L'OBJET (pas la catégorie Interenchères !). Format : "Combien coûte un/une [objet réel] aux enchères ?", "Quelle est la valeur d'un/une [objet réel] ?", etc. Réponses factuelles avec prix (max 200 car chacune).
- "tags": array de 3-5 mots-clés pertinents (marque, époque, matériau, style...)

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.`;

async function aiEnrichLots(maxPerRun = 0) {
  if (!config.openaiKey) {
    console.log("  ⏭️  Pas de clé OpenAI — enrichissement AI désactivé");
    return;
  }

  const cache = loadAiCache();
  // Merge sold + unsold items for enrichment
  const items = [...registry.items.values(), ...registry.unsold.values()];

  // Apply existing cache first (so pages already enriched keep their AI content)
  for (const { item } of items) {
    if (cache[item.id]) {
      item._aiTitle = cache[item.id].t;
      item._aiDesc = cache[item.id].d;
      if (cache[item.id].cat) {
        item._aiCategory = cache[item.id].cat;
        item.category = { ...item.category, name: cache[item.id].cat };
      }
    }
  }

  // Find items that still need enrichment
  let toEnrich = items.filter(({ item }) => {
    if (!cache[item.id]) return true;
    if (!cache[item.id].cat) return true; // needs AI category
    const faq = cache[item.id].faq || [];
    if (faq.length < 3) return true;
    const hasGeoQ = faq.some(f => /prix|valeur|co[uû]t|combien/i.test(f.q || ""));
    if (!hasGeoQ) return true;
    return false;
  });

  if (toEnrich.length === 0) {
    console.log("  ✨ Tous les lots sont déjà enrichis par l'IA");
    return;
  }

  // Limit per run to avoid timeout (200 lots ≈ 15-20 min max)
  if (maxPerRun > 0 && toEnrich.length > maxPerRun) {
    console.log(`  🤖 Enrichissement IA: ${toEnrich.length} lots à traiter, limité à ${maxPerRun} ce run`);
    toEnrich = toEnrich.slice(0, maxPerRun);
  } else {
    console.log(`  🤖 Enrichissement IA: ${toEnrich.length} lots à traiter...`);
  }

  const CONCURRENCY = 20;
  let done = 0;
  let errors = 0;

  async function processItem({ item }) {
    const rawDescOrig = item.description || item.title_translations?.["fr-FR"] || "";
    const rawDesc = cleanRawDesc(rawDescOrig);
    const catName = item.category?.name || "";
    const price = item.pricing?.auctioned?.price || 0;

    const userMsg = `Catégorie Interenchères (peut être vague): ${catName}\nPrix adjugé: ${price}€\nDescription brute:\n${rawDesc.substring(0, 500)}`;

    try {
      const response = await callGpt([
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ]);

      // Parse JSON response
      const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.title && parsed.desc) {
        cache[item.id] = {
          t: parsed.title,
          d: parsed.desc,
          cat: parsed.category || "",
          pa: parsed.price_analysis || "",
          faq: parsed.faq || [],
          tags: parsed.tags || [],
        };
        item._aiTitle = parsed.title;
        item._aiDesc = parsed.desc;
        item._aiCategory = parsed.category || "";
        item._aiPriceAnalysis = parsed.price_analysis || "";
        item._aiFaq = parsed.faq || [];
        item._aiTags = parsed.tags || [];
      }
    } catch (err) {
      errors++;
      // Keep original description if AI fails
    }

    done++;
    if (done % 100 === 0 || done === toEnrich.length) {
      console.log(`    ${done}/${toEnrich.length} enrichis${errors ? ` (${errors} erreurs)` : ""}...`);
      // Save cache periodically
      saveAiCache(cache);
    }
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processItem));
  }

  saveAiCache(cache);
  console.log(`  ✅ Enrichissement terminé: ${done - errors} réussis, ${errors} erreurs`);

  // Apply cache to all items (including previously cached ones)
  for (const { item } of items) {
    if (cache[item.id]) {
      item._aiTitle = cache[item.id].t;
      item._aiDesc = cache[item.id].d;
      item._aiPriceAnalysis = cache[item.id].pa || "";
      item._aiFaq = cache[item.id].faq || [];
      item._aiTags = cache[item.id].tags || [];
    }
  }

  // Enrich categories (one-shot, all at once)
  await aiEnrichCategories(cache);
  saveAiCache(cache);
}

async function aiEnrichCategories(cache) {
  if (!config.openaiKey) return;

  const cats = [...registry.categories.entries()];
  const needEnrich = cats.filter(([slug]) => !cache[`cat_${slug}`]);

  if (needEnrich.length === 0) {
    // Apply cached data
    for (const [slug, data] of cats) {
      if (cache[`cat_${slug}`]) {
        data._aiName = cache[`cat_${slug}`].n;
        data._aiDesc = cache[`cat_${slug}`].d;
      }
    }
    console.log("  ✨ Catégories déjà enrichies");
    return;
  }

  console.log(`  🤖 Enrichissement catégories: ${needEnrich.length}...`);

  const catList = needEnrich.map(([slug, data]) => `- ${slug}: "${data.name}" (${data.items.length} lots)`).join("\n");

  try {
    const response = await callGpt([
      { role: "system", content: `Tu es un expert en enchères et objets d'art. On te donne une liste de catégories d'un site de résultats d'enchères françaises.

Pour chaque catégorie, retourne un JSON array avec :
- "slug": le slug original (identique à l'input)
- "name": un nom de catégorie plus court, accrocheur et SEO (max 50 caractères). En français.
- "desc": une description de la catégorie en 2 phrases (max 200 caractères) qui explique ce qu'on y trouve et donne envie d'explorer. Ton expert et enthousiaste.

Réponds UNIQUEMENT en JSON array valide, sans markdown, sans backticks.` },
      { role: "user", content: catList },
    ]);

    const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    for (const cat of parsed) {
      if (cat.slug && cat.name && cat.desc) {
        cache[`cat_${cat.slug}`] = { n: cat.name, d: cat.desc };
      }
    }

    console.log(`  ✅ ${parsed.length} catégories enrichies`);
  } catch (err) {
    console.warn(`  ⚠ Enrichissement catégories échoué: ${err.message}`);
  }

  // Apply to registry
  for (const [slug, data] of cats) {
    if (cache[`cat_${slug}`]) {
      data._aiName = cache[`cat_${slug}`].n;
      data._aiDesc = cache[`cat_${slug}`].d;
    }
  }
}

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
  let unsoldCount = 0;
  for (const sale of sales) {
    try {
      const items = fetchAllItems(sale.id);
      for (const item of items) {
        const auc = item.pricing?.auctioned;
        if (auc?.sold && !registry.items.has(item.id)) {
          registerItem(item, sale);
          soldCount++;
        } else if (auc && !auc.sold && !registry.unsold.has(item.id) && !registry.items.has(item.id)) {
          registerUnsoldItem(item, sale);
          unsoldCount++;
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Vente ${sale.id}: ${err.message}`);
    }
  }
  console.log(`  → ${soldCount} vendus, ${unsoldCount} invendus`);
  return soldCount;
}

async function runOnce(dateStr) {
  ensureDir(SITE_DIR);
  const dataDir = DATA_DIR;
  ensureDir(dataDir);

  console.log(`\n🏛️  Interenchères — Exécution unique`);
  console.log(`   Amazon tag: ${config.amazonTag}`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  // Load ALL cached lots (so we keep every day's pages)
  let cachedCount = 0;
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".json") && f !== "state.json" && f !== "ai-cache.json");
  for (const f of files) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf-8"));
      if (saved.unsold && saved.item && !registry.unsold.has(saved.item.id)) {
        registerUnsoldItem(saved.item, saved.sale);
        cachedCount++;
      } else if (saved.item && !registry.items.has(saved.item.id)) {
        registerItem(saved.item, saved.sale);
        cachedCount++;
      }
    } catch {}
  }
  if (cachedCount > 0) console.log(`  📦 ${cachedCount} lots restaurés depuis le cache (total cumulé)`);

  // Scrape last 7 days to accumulate as much data as possible
  let totalSold = 0;
  for (let i = 7; i >= 0; i--) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    totalSold += scrapDate(dayStr);
  }

  // Save new items to data dir (sold + unsold)
  for (const [itemId, { item, sale }] of registry.items) {
    const itemFile = path.join(dataDir, `${itemId}.json`);
    if (!fs.existsSync(itemFile)) {
      fs.writeFileSync(itemFile, JSON.stringify({ item, sale: { id: sale?.id, name: sale?.name, datetime: sale?.datetime, address: sale?.address, organization: sale?.organization } }, null, 2), "utf-8");
    }
  }
  for (const [itemId, { item, sale }] of registry.unsold) {
    const itemFile = path.join(dataDir, `unsold_${itemId}.json`);
    if (!fs.existsSync(itemFile)) {
      fs.writeFileSync(itemFile, JSON.stringify({ item, sale: { id: sale?.id, name: sale?.name, datetime: sale?.datetime, address: sale?.address, organization: sale?.organization }, unsold: true }, null, 2), "utf-8");
    }
  }
  // Save state
  const stateFile = path.join(dataDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ knownSold: [...registry.items.keys()], knownUnsold: [...registry.unsold.keys()], lastPoll: new Date().toISOString() }, null, 2), "utf-8");

  const totalItems = registry.items.size;
  console.log(`\n  Total: ${totalSold} nouveaux lots scrapés, ${totalItems} lots au total (cache + scrape)`);

  if (totalItems > 0) {
    // 1) Build pages FIRST (so site updates immediately, even without AI)
    const pageCount = rebuildAllPages(dateStr);
    console.log(`  📄 ${pageCount} pages générées`);
    await ftpUpload();

    // 2) AI enrichment AFTER first deploy
    if (process.env.SKIP_AI === "true") {
      console.log("  ⏭️  AI skip (SKIP_AI=true)");
    } else {
      const AI_BUDGET = process.env.AI_BUDGET ? parseInt(process.env.AI_BUDGET) : 50;
      await aiEnrichLots(AI_BUDGET);

      // 3) Rebuild only the AI-enriched pages + index pages, then re-upload
      const enrichedCount = rebuildAllPages(dateStr);
      if (enrichedCount > 0) {
        console.log(`  🔄 ${enrichedCount} pages mises à jour avec IA`);
        await ftpUpload();
      }
    }
  } else {
    console.log("  Aucun lot — rien à générer.");
  }

  console.log("\n✅ Terminé.");
}

// ─── Rebuild from cached data (no scraping) ────────────────────────────────

async function runRebuild(dateStr) {
  ensureDir(SITE_DIR);
  const dataDir = DATA_DIR;
  ensureDir(dataDir);

  console.log(`\n🔄 Interenchères — Rebuild depuis le cache`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  // Load ALL cached item JSON files (every day cumulated)
  let loaded = 0;
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".json") && f !== "state.json" && f !== "ai-cache.json");
  for (const f of files) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf-8"));
      if (saved.unsold && saved.item && !registry.unsold.has(saved.item.id)) {
        registerUnsoldItem(saved.item, saved.sale);
        loaded++;
      } else if (saved.item && !registry.items.has(saved.item.id)) {
        registerItem(saved.item, saved.sale);
        loaded++;
      }
    } catch {}
  }

  console.log(`  📦 ${loaded} lots chargés depuis le cache`);

  if (loaded === 0) {
    console.log("  ❌ Aucune donnée en cache. Lancez d'abord --once pour scraper.");
    process.exit(1);
  }

  // Apply AI enrichment from cache — limited to fit in job timeout
  const AI_BUDGET = process.env.AI_BUDGET ? parseInt(process.env.AI_BUDGET) : 500;
  await aiEnrichLots(AI_BUDGET);

  // Rebuild all pages with new design
  const pageCount = rebuildAllPages(dateStr);
  console.log(`  📄 ${pageCount} pages régénérées`);

  // Upload via FTP
  await ftpUpload();

  console.log("\n✅ Rebuild terminé.");
}

// ─── main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let interval = 60;
let date = todayStr();
let once = false;
let rebuild = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--interval" && args[i + 1]) { interval = parseInt(args[i + 1]); i++; }
  else if (args[i] === "--date" && args[i + 1]) { date = args[i + 1]; i++; }
  else if (args[i] === "--once") { once = true; }
  else if (args[i] === "--rebuild") { rebuild = true; }
  else if (args[i] === "--help") {
    console.log(`
Interencheres Site Generator

Usage:
  node daemon.mjs                    Lance en boucle (poll 60s)
  node daemon.mjs --once             Exécution unique (pour CI/GitHub Actions)
  node daemon.mjs --rebuild          Rebuild depuis le cache (pas de scraping)
  node daemon.mjs --interval 30      Poll 30s
  node daemon.mjs --date 2026-03-14  Date spécifique

Config: config.mjs (tag Amazon, AdSense, FTP, etc.)
    `);
    process.exit(0);
  }
}

if (rebuild) {
  runRebuild(date).catch(err => { console.error(err); process.exit(1); });
} else if (once) {
  runOnce(date).catch(err => { console.error(err); process.exit(1); });
} else {
  runDaemon(date, interval);
}
