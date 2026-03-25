#!/usr/bin/env node
/**
 * Adjugé v2 — Scraper (runs on GitHub Actions)
 * Scrapes Interencheres API → outputs JSON to stdout
 * The VPS receives this data and inserts into SQLite
 */

import { execFileSync } from "child_process";

const API = "https://search.interencheres.com/v1/search";
const PAGE_SIZE = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────
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
        "-H", 'sec-ch-ua: "Chromium";v="131", "Not_A Brand";v="24"',
        "-H", "sec-ch-ua-mobile: ?0",
        "-H", 'sec-ch-ua-platform: "Windows"',
        "-H", "sec-fetch-dest: empty",
        "-H", "sec-fetch-mode: cors",
        "-H", "sec-fetch-site: same-site",
        url,
      ], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 });
      const text = result.toString("utf-8");
      if (text.startsWith("<!")) throw new Error("Cloudflare block");
      return JSON.parse(text);
    } catch (err) {
      if (attempt < retries) {
        console.error(`  ⚠ Retry ${attempt + 1}/${retries}: ${err.message}`);
        execFileSync("sleep", ["2"]);
      } else throw err;
    }
  }
}

function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return curlFetch(url.href);
}

function todayStr() {
  return new Date().toISOString().substring(0, 10);
}

function imgUrl(media, size = "lg") {
  const url = media?.rewriteImgUrl?.[size] || media?.rewriteImgUrl?.md || media?.url || "";
  return url.startsWith("//") ? `https:${url}` : url;
}

function titleCaseCity(name) {
  return String(name || "").replace(/\b\w+/g, w =>
    w.length <= 2 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).replace(/^./, c => c.toUpperCase());
}

function cleanTitle(raw) {
  let t = String(raw || "").split("\n")[0].trim();
  t = t.replace(/^(lot\s*n?[°º]?\s*\d+\s*[-:.]?\s*)/i, "");
  t = t.replace(/^(a\s+partir\s+de\s+\d+h\d*\s*:?\s*)/i, "");
  t = t.replace(/^lieu\s+de\s+stockage\s*:\s*[^-]+\s*-\s*/i, "");
  t = t.replace(/^\d+\s*[-–]\s*/, "");
  t = t.replace(/^[A-Z]{2,5}-\d{3,}-[A-Z]{2}\s*/i, "");
  if (t === t.toUpperCase() && t.length > 5) {
    t = t.replace(/\b\w+/g, w =>
      w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
  }
  return t.substring(0, 120) || "Objet";
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .substring(0, 80);
}

// ─── Scraper ────────────────────────────────────────────────────────────────
function fetchAllItems(saleId) {
  const seen = new Set();
  const items = [];
  for (const sort of ["id", "-id"]) {
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

function scrapDate(dateStr) {
  const allSales = [];
  const seen = new Set();
  for (const sort of ["datetime", "-datetime"]) {
    const sales = apiFetch("ie4_sales", {
      limit: PAGE_SIZE, "filters[status]": "published", sort
    });
    for (const s of sales) {
      if (s.datetime && s.datetime.startsWith(dateStr) && !seen.has(s.id)) {
        seen.add(s.id);
        allSales.push(s);
      }
    }
  }

  console.error(`  📅 ${dateStr}: ${allSales.length} ventes`);
  const lots = [];

  for (const sale of allSales) {
    try {
      const items = fetchAllItems(sale.id);
      for (const item of items) {
        const auc = item.pricing?.auctioned;
        if (!auc) continue;

        const rawDesc = item.description || item.title_translations?.["fr-FR"] || "";
        const cat = item.category?.name || "";
        const medias = item.medias || [];
        const org = item.organization || {};
        const addr = sale.address || org.address || {};
        const commission = sale.options?.commission_rate?.voluntary || sale.options?.commission_rate?.judicial || 0;
        const ct = cleanTitle(rawDesc);

        lots.push({
          id: item.id,
          title: rawDesc.split("\n")[0]?.substring(0, 500) || "Objet",
          clean_title: ct,
          description: rawDesc,
          category: cat,
          category_id: item.category?.id || null,
          sold: auc.sold ? 1 : 0,
          price: auc.sold ? (auc.price || 0) : null,
          estimate_low: item.pricing?.estimates?.low || item.pricing?.estimates?.min || null,
          estimate_high: item.pricing?.estimates?.max || null,
          starting_price: item.pricing?.starting_price || null,
          commission_rate: commission || null,
          sale_date: sale.datetime?.substring(0, 10) || dateStr,
          sale_id: sale.id,
          org_name: org.names?.voluntary || org.names?.judicial || "",
          org_email: addr.email || "",
          org_phone: addr.telephone || "",
          org_address: [addr.street, addr.postcode, addr.city].filter(Boolean).join(", "),
          city: titleCaseCity(addr.city || ""),
          postcode: addr.postcode || "",
          slug: slugify(ct + "-" + item.id),
          thumb: medias[0] ? imgUrl(medias[0], "lg") : "",
          photos: medias.map(m => imgUrl(m, "lg")).filter(Boolean),
        });
      }
    } catch (err) {
      console.error(`  ⚠ Vente ${sale.id}: ${err.message}`);
    }
  }

  console.error(`  → ${lots.filter(l => l.sold).length} vendus, ${lots.filter(l => !l.sold).length} invendus`);
  return lots;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const today = todayStr();
const dateArg = process.argv[2] || today;
console.error(`\n🏛️  Adjugé v2 — Scraper`);
console.error(`   Date: ${dateArg}\n`);

const allLots = [];

// Scrape requested date + last 7 days
for (let i = 7; i >= 0; i--) {
  const d = new Date(dateArg + "T12:00:00Z");
  d.setDate(d.getDate() - i);
  const dayStr = d.toISOString().slice(0, 10);
  const lots = scrapDate(dayStr);
  allLots.push(...lots);
}

console.error(`\n📊 Total scrapé: ${allLots.length} lots`);
console.error(`   Vendus: ${allLots.filter(l => l.sold).length}`);
console.error(`   Invendus: ${allLots.filter(l => !l.sold).length}`);

// Output JSON to stdout — VPS will pipe this into SQLite
process.stdout.write(JSON.stringify(allLots));
