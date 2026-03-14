#!/usr/bin/env node
/**
 * Interencheres Search API Scraper
 * Sauvegarde les lots d'une vente avant purge de l'index ElasticSearch.
 *
 * Usage:
 *   node scraper.mjs <saleId>                  # Sauvegarde tous les lots d'une vente
 *   node scraper.mjs --item <itemId>            # Sauvegarde un lot précis
 *   node scraper.mjs --search "mot clé"         # Recherche par texte
 *   node scraper.mjs --watch <saleId> [sec]     # Surveille une vente en cours (poll toutes les N sec, défaut 30)
 *   node scraper.mjs --results "mot clé"        # Cherche dans l'historique des résultats (23000+ ventes depuis 2007)
 *   node scraper.mjs --results-pdf <saleId>     # Télécharge le PDF des résultats d'une vente passée
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = "https://search.interencheres.com/v1/search";
const PAGE_SIZE = 200;

// ─── helpers ────────────────────────────────────────────────────────────────

// Use curl to bypass Cloudflare TLS fingerprinting (Node fetch gets 403)
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

function curlDownload(url, destPath) {
  execFileSync("curl", ["-s", "-o", destPath, "-L", url], { timeout: 60000 });
}

function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return curlFetch(url.href);
}

function fetchAllItems(saleId) {
  const seen = new Set();
  const items = [];
  // Try multiple sort orders to get all items (API caps at 200 per query)
  const sorts = ["id", "-id", "pricing.estimates.max", "-pricing.estimates.max"];
  for (const sort of sorts) {
    let offset = 0;
    while (true) {
      const batch = apiFetch("ie4_items", {
        "filters[sale]": saleId,
        limit: PAGE_SIZE,
        offset,
        sort,
      });
      if (!batch.length) break;
      let newCount = 0;
      for (const item of batch) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
          newCount++;
        }
      }
      if (newCount === 0 || batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  return items;
}

function fetchItem(itemId) {
  const data = apiFetch("ie4_items", { "filters[id]": itemId });
  return data.length ? data[0] : null;
}

function fetchSale(saleId) {
  const data = apiFetch("ie4_sales", { "filters[id]": saleId });
  return data.length ? data[0] : null;
}

function searchItems(query, limit = 200) {
  return apiFetch("ie4_items", { q: query, limit });
}

// ─── sales_results (historique 2007+) ───────────────────────────────────────

function searchSaleResults(query, limit = 200) {
  return apiFetch("sales_results", { q: query, limit, sort: "-datetime" });
}

function searchSaleResultsByOrg(orgId, limit = 200) {
  return apiFetch("sales_results", { "filters[organization]": orgId, limit, sort: "-datetime" });
}

function fetchSaleResult(saleId) {
  // sales_results index doesn't support filters[id], so search all and find by ID
  // First try with organization filter if we can find the sale in ie4_sales
  try {
    const sale = fetchSale(saleId);
    if (sale?.organization?.id) {
      const results = searchSaleResultsByOrg(sale.organization.id);
      const match = results.find(r => r.id === Number(saleId));
      if (match) return match;
    }
  } catch {}
  // Fallback: broad search
  const all = searchSaleResults(String(saleId));
  return all.find(r => r.id === Number(saleId)) || null;
}

// ─── download images ────────────────────────────────────────────────────────

function downloadImage(url, destPath) {
  const fullUrl = url.startsWith("//") ? `https:${url}` : url;
  try {
    curlDownload(fullUrl, destPath);
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
  } catch {
    return false;
  }
}

function downloadItemImages(item, dir) {
  const medias = item.medias || [];
  const downloaded = [];
  for (let i = 0; i < medias.length; i++) {
    const media = medias[i];
    // Use largest available rewrite URL, fallback to original
    const url =
      media.rewriteImgUrl?.lg ||
      media.rewriteImgUrl?.md ||
      media.url ||
      null;
    if (!url) continue;
    const ext = path.extname(media.meta?.name || ".jpg") || ".jpg";
    const filename = `${item.id}_img${i}${ext}`;
    const destPath = path.join(dir, filename);
    if (fs.existsSync(destPath)) {
      downloaded.push(filename);
      continue;
    }
    try {
      const ok = downloadImage(url, destPath);
      if (ok) downloaded.push(filename);
    } catch {
      console.warn(`  ⚠ Image ${i} échouée pour lot ${item.id}`);
    }
  }
  return downloaded;
}

// ─── format / save ──────────────────────────────────────────────────────────

function formatItem(item) {
  return {
    id: item.id,
    title: item.description || item.title_translations?.["fr-FR"] || "",
    title_translations: item.title_translations || {},
    description: item.description || "",
    description_translations: item.description_translations || {},
    status: item.status,
    category: item.category,
    category_leaves_ids: item.category_leaves_ids,
    characteristics: item.characteristics,
    internal_reference: item.internal_reference,
    pricing: {
      estimates: item.pricing?.estimates || null,
      auctioned: item.pricing?.auctioned || null,
      starting_price: item.pricing?.starting_price || null,
      reserve_price: item.pricing?.reserve_price || null,
    },
    sale: {
      id: item.sale?.id,
      title: item.sale?.title,
      dates: item.sale?.dates,
    },
    organization: {
      id: item.organization?.id,
      names: item.organization?.names,
      address: item.organization?.address,
    },
    medias: (item.medias || []).map((m) => ({
      url: m.url,
      rewriteImgUrl: m.rewriteImgUrl,
      meta: m.meta,
      dimensions: m.dimensions,
    })),
    shipping: item.shipping,
    has_shipping: item.has_shipping,
    features: item.features,
    last_updated: item.last_updated,
    _raw_keys: Object.keys(item),
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveSaleData(saleId, saleInfo, items, outputDir) {
  ensureDir(outputDir);
  const imgDir = path.join(outputDir, "images");
  ensureDir(imgDir);

  // Save sale info
  if (saleInfo) {
    fs.writeFileSync(
      path.join(outputDir, "sale.json"),
      JSON.stringify(saleInfo, null, 2),
      "utf-8"
    );
  }

  // Save all items
  const formatted = items.map(formatItem);
  fs.writeFileSync(
    path.join(outputDir, "items.json"),
    JSON.stringify(formatted, null, 2),
    "utf-8"
  );

  // Save summary CSV
  const csvLines = [
    "id;titre;estimation_min;estimation_max;vendu;prix;type",
    ...formatted.map((it) => {
      const est = it.pricing.estimates || {};
      const auc = it.pricing.auctioned || {};
      const title = (it.title || "").replace(/;/g, ",").replace(/\n/g, " ");
      return `${it.id};${title};${est.min ?? ""};${est.max ?? ""};${auc.sold ?? ""};${auc.price ?? ""};${auc.type ?? ""}`;
    }),
  ];
  fs.writeFileSync(
    path.join(outputDir, "resultats.csv"),
    "\uFEFF" + csvLines.join("\n"),
    "utf-8"
  );

  return { imgDir, formatted };
}

// ─── commands ───────────────────────────────────────────────────────────────

function cmdSale(saleId, { downloadImages = true } = {}) {
  console.log(`\n📦 Récupération de la vente ${saleId}...`);

  const saleInfo = fetchSale(saleId);
  if (!saleInfo) {
    console.error("❌ Vente non trouvée dans l'index ie4_sales.");
    return;
  }
  console.log(
    `  Vente: ${saleInfo.title || saleInfo.id} — ${saleInfo.items_count} lots annoncés`
  );

  console.log("  Chargement des lots...");
  const items = fetchAllItems(saleId);
  console.log(`  ${items.length} lots récupérés.`);

  const outputDir = path.join(__dirname, "data", `sale_${saleId}`);
  const { imgDir, formatted } = saveSaleData(saleId, saleInfo, items, outputDir);

  // Stats
  const sold = formatted.filter((it) => it.pricing.auctioned?.sold);
  const totalAdj = sold.reduce(
    (s, it) => s + (it.pricing.auctioned?.price || 0),
    0
  );
  console.log(
    `  ${sold.length}/${formatted.length} lots vendus — Total adjugé: ${totalAdj} €`
  );

  // Try to get results PDF
  const saleResult = fetchSaleResult(saleId);
  if (saleResult?.sale_results?.url) {
    const pdfUrl = saleResult.sale_results.url;
    const pdfPath = path.join(outputDir, "resultats.pdf");
    console.log("  Téléchargement du PDF des résultats...");
    downloadImage(pdfUrl, pdfPath);
    console.log(`  PDF sauvegardé: resultats.pdf`);
  }

  // Download images
  if (downloadImages) {
    console.log("  Téléchargement des images...");
    let imgCount = 0;
    for (const item of items) {
      const dl = downloadItemImages(item, imgDir);
      imgCount += dl.length;
    }
    console.log(`  ${imgCount} images sauvegardées.`);
  }

  console.log(`\n✅ Données sauvegardées dans: ${outputDir}`);
  console.log(`   - sale.json       (infos vente)`);
  console.log(`   - items.json      (tous les lots détaillés)`);
  console.log(`   - resultats.csv   (résumé des résultats)`);
  console.log(`   - resultats.pdf   (PDF officiel si disponible)`);
  console.log(`   - images/         (photos des lots)`);
}

function cmdItem(itemId) {
  console.log(`\n🔍 Récupération du lot ${itemId}...`);
  const item = fetchItem(itemId);
  if (!item) {
    console.error("❌ Lot non trouvé (peut-être purgé de l'index).");
    return;
  }

  const outputDir = path.join(__dirname, "data", `item_${itemId}`);
  ensureDir(outputDir);
  const imgDir = path.join(outputDir, "images");
  ensureDir(imgDir);

  const formatted = formatItem(item);
  fs.writeFileSync(
    path.join(outputDir, "item.json"),
    JSON.stringify(formatted, null, 2),
    "utf-8"
  );

  const dl = downloadItemImages(item, imgDir);

  const auc = formatted.pricing.auctioned;
  console.log(`  Titre: ${formatted.title}`);
  console.log(
    `  Estimation: ${formatted.pricing.estimates?.min}-${formatted.pricing.estimates?.max} €`
  );
  if (auc?.sold) console.log(`  Adjugé: ${auc.price} € (${auc.type})`);
  else console.log(`  Non vendu`);
  console.log(`  ${dl.length} images téléchargées.`);
  console.log(`\n✅ Sauvegardé dans: ${outputDir}`);
}

function cmdSearch(query) {
  console.log(`\n🔎 Recherche lots: "${query}"...`);
  const items = searchItems(query);
  console.log(`  ${items.length} résultats.\n`);

  for (const item of items.slice(0, 20)) {
    const auc = item.pricing?.auctioned;
    const est = item.pricing?.estimates;
    const title = (
      item.description ||
      item.title_translations?.["fr-FR"] ||
      ""
    ).substring(0, 80);
    const price = auc?.sold ? `${auc.price}€` : est ? `est. ${est.min}-${est.max}€` : "";
    console.log(`  [${item.id}] ${title} — ${price}`);
  }
  if (items.length > 20)
    console.log(`  ... et ${items.length - 20} autres résultats`);
}

function cmdResults(query) {
  console.log(`\n📜 Recherche résultats de ventes: "${query}"...`);
  const results = searchSaleResults(query);
  console.log(`  ${results.length} ventes trouvées.\n`);

  for (const sale of results.slice(0, 30)) {
    const date = sale.datetime ? sale.datetime.substring(0, 10) : "?";
    const org = sale.organization?.names?.voluntary || sale.organization?.names?.judicial || "?";
    const city = sale.address?.city || "";
    const hasPdf = sale.sale_results?.url ? "📄" : "  ";
    console.log(
      `  ${hasPdf} [${sale.id}] ${date} — ${(sale.name || "").substring(0, 60)} — ${org}, ${city}`
    );
  }
  if (results.length > 30)
    console.log(`  ... et ${results.length - 30} autres`);
  console.log(`\n  💡 Pour télécharger un PDF: node scraper.mjs --results-pdf <saleId>`);
}

function cmdResultsOrg(orgId) {
  console.log(`\n📜 Résultats de l'organisation ${orgId}...`);
  const results = searchSaleResultsByOrg(orgId);
  if (!results.length) {
    console.error("❌ Aucun résultat pour cette organisation.");
    return;
  }

  const org = results[0].organization?.names?.voluntary || results[0].organization?.names?.judicial || "?";
  console.log(`  ${org} — ${results.length} ventes avec résultats.\n`);

  for (const sale of results) {
    const date = sale.datetime ? sale.datetime.substring(0, 10) : "?";
    const hasPdf = sale.sale_results?.url ? "📄" : "  ";
    console.log(
      `  ${hasPdf} [${sale.id}] ${date} — ${(sale.name || "").substring(0, 70)}`
    );
  }
  console.log(`\n  💡 Pour télécharger un PDF: node scraper.mjs --results-pdf <saleId>`);
}

function cmdResultsPdf(saleId) {
  console.log(`\n📄 Récupération du PDF des résultats pour la vente ${saleId}...`);

  const result = fetchSaleResult(saleId);
  if (!result) {
    console.error("❌ Vente non trouvée dans l'index sales_results.");
    return;
  }

  const date = result.datetime ? result.datetime.substring(0, 10) : "?";
  const org = result.organization?.names?.voluntary || result.organization?.names?.judicial || "?";
  console.log(`  Vente: ${result.name}`);
  console.log(`  Date: ${date} — ${org}`);

  if (!result.sale_results?.url) {
    console.error("  ❌ Pas de PDF de résultats disponible pour cette vente.");

    // Save metadata anyway
    const outputDir = path.join(__dirname, "data", `results_${saleId}`);
    ensureDir(outputDir);
    fs.writeFileSync(
      path.join(outputDir, "sale_result.json"),
      JSON.stringify(result, null, 2),
      "utf-8"
    );
    console.log(`  Métadonnées sauvegardées dans: ${outputDir}/sale_result.json`);
    return;
  }

  const pdfUrl = result.sale_results.url;
  const outputDir = path.join(__dirname, "data", `results_${saleId}`);
  ensureDir(outputDir);

  // Save metadata
  fs.writeFileSync(
    path.join(outputDir, "sale_result.json"),
    JSON.stringify(result, null, 2),
    "utf-8"
  );

  // Download PDF
  const pdfPath = path.join(outputDir, "resultats.pdf");
  const fullUrl = pdfUrl.startsWith("//") ? `https:${pdfUrl}` : pdfUrl;
  console.log(`  Téléchargement: ${fullUrl}`);
  curlDownload(fullUrl, pdfPath);

  if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0) {
    const sizeMb = (fs.statSync(pdfPath).size / 1024).toFixed(1);
    console.log(`\n✅ PDF téléchargé: ${pdfPath} (${sizeMb} Ko)`);
  } else {
    console.error("  ❌ Échec du téléchargement du PDF.");
  }
}

function cmdWatch(saleId, intervalSec = 30) {
  console.log(
    `\n👁️  Surveillance de la vente ${saleId} (toutes les ${intervalSec}s) — Ctrl+C pour arrêter\n`
  );

  const outputDir = path.join(__dirname, "data", `sale_${saleId}`);
  ensureDir(outputDir);
  const imgDir = path.join(outputDir, "images");
  ensureDir(imgDir);

  const knownSold = new Map();

  const poll = () => {
    try {
      const items = fetchAllItems(saleId);
      const now = new Date().toLocaleTimeString("fr-FR");
      let newSold = 0;

      for (const item of items) {
        const auc = item.pricing?.auctioned;
        if (auc?.sold && !knownSold.has(item.id)) {
          knownSold.set(item.id, auc.price);
          newSold++;
          const title = (
            item.description ||
            item.title_translations?.["fr-FR"] ||
            ""
          ).substring(0, 60);
          console.log(
            `  [${now}] 🔨 Lot ${item.id} adjugé ${auc.price}€ — ${title}`
          );
          // Save immediately + download images
          const formatted = formatItem(item);
          fs.writeFileSync(
            path.join(outputDir, `lot_${item.id}.json`),
            JSON.stringify(formatted, null, 2),
            "utf-8"
          );
          downloadItemImages(item, imgDir);
        }
      }

      if (newSold === 0) {
        process.stdout.write(`  [${now}] ${knownSold.size} lots vendus — en attente...\r`);
      }

      // Update global files periodically
      const saleInfo = fetchSale(saleId);
      saveSaleData(saleId, saleInfo, items, outputDir);
    } catch (err) {
      console.warn(`  ⚠ Erreur: ${err.message}`);
    }
  };

  poll();
  setInterval(poll, intervalSec * 1000);
}

// ─── main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Interencheres Scraper — Sauvegarde les données de ventes aux enchères

Usage:
  node scraper.mjs <saleId>                  Sauvegarder tous les lots d'une vente (items + images)
  node scraper.mjs --no-images <saleId>      Idem sans télécharger les images
  node scraper.mjs --item <itemId>           Sauvegarder un lot précis + images
  node scraper.mjs --search "mot clé"        Rechercher des lots dans l'index courant
  node scraper.mjs --watch <saleId> [sec]    Surveiller une vente en direct

  node scraper.mjs --results "mot clé"       Chercher dans l'historique (23000+ ventes depuis 2007)
  node scraper.mjs --results-org <orgId>     Lister les ventes passées d'une maison de vente
  node scraper.mjs --results-pdf <saleId>    Télécharger le PDF des résultats d'adjudication

Index ElasticSearch:
  ie4_items        Lots en cours / récents (purgés après quelques mois)
  ie4_sales        Ventes en cours / récentes
  sales_results    Résultats historiques avec PDF (depuis 2007, 23000+ ventes)

API publique: ${API}
  `);
  process.exit(0);
}

if (args[0] === "--item") {
  cmdItem(args[1]);
} else if (args[0] === "--search") {
  cmdSearch(args.slice(1).join(" "));
} else if (args[0] === "--results") {
  cmdResults(args.slice(1).join(" "));
} else if (args[0] === "--results-org") {
  cmdResultsOrg(args[1]);
} else if (args[0] === "--results-pdf") {
  cmdResultsPdf(args[1]);
} else if (args[0] === "--watch") {
  cmdWatch(args[1], parseInt(args[2]) || 30);
} else if (args[0] === "--no-images") {
  cmdSale(args[1], { downloadImages: false });
} else {
  cmdSale(args[0]);
}
