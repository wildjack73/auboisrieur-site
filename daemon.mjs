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

// ─── communes GPS lookup (build-time only) ──────────────────────────────────
let communesGps = {};
try {
  communesGps = JSON.parse(fs.readFileSync(path.join(__dirname, "communes.json"), "utf-8"));
} catch { console.log("⚠️ communes.json not found — map disabled"); }

function cityToCoords(cityName) {
  if (!cityName) return null;
  const key = cityName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return communesGps[key] || null;
}

// Approximate region from GPS coordinates (13 metropolitan regions)
function coordsToRegion(lat, lng) {
  // Rough bounding boxes for French regions
  if (lat > 49.5) return "Hauts-de-France";
  if (lat > 48.5 && lng < -1) return "Bretagne";
  if (lat > 48.5 && lng < 1) return "Normandie";
  if (lat > 48.2 && lng >= 1 && lng < 3.5) return "Île-de-France";
  if (lat > 48.2 && lng >= 3.5) return "Grand Est";
  if (lat > 47.5 && lng < 0) return "Pays de la Loire";
  if (lat > 47.5 && lng >= 0 && lng < 3) return "Centre-Val de Loire";
  if (lat > 47 && lng >= 3 && lng < 5.5) return "Bourgogne-Franche-Comté";
  if (lat > 47 && lng >= 5.5) return "Bourgogne-Franche-Comté";
  if (lat > 46 && lng < 0.5) return "Nouvelle-Aquitaine";
  if (lat > 45.5 && lng >= 4) return "Auvergne-Rhône-Alpes";
  if (lat > 45 && lng >= 0.5 && lng < 4) return "Auvergne-Rhône-Alpes";
  if (lat > 44 && lng < 0.5) return "Nouvelle-Aquitaine";
  if (lat > 43.5 && lng >= 0.5 && lng < 3) return "Occitanie";
  if (lat > 43 && lng >= 3) return "Provence-Alpes-Côte d'Azur";
  if (lat > 42 && lng < 3) return "Occitanie";
  if (lat > 41) return "Corse";
  return "Autre";
}

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
function todayFr() {
  const d = new Date();
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

// Normalize city names: "NANTES" → "Nantes", "SAINT-MARIENS" → "Saint-Mariens"
function titleCaseCity(name) {
  if (!name) return "";
  return name.toLowerCase().replace(/(^|[\s-])(\w)/g, (m, sep, c) => sep + c.toUpperCase());
}

// Convert ISO date "2026-03-18" to French "18 mars 2026"
function dateFr(isoDate) {
  if (!isoDate || isoDate.length < 10) return isoDate || "";
  try {
    const d = new Date(isoDate + "T12:00:00"); // noon to avoid timezone issues
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  } catch { return isoDate; }
}

// Convert ISO date "2026-03-18" to "18/03/2026"
function dateShortFr(isoDate) {
  if (!isoDate || isoDate.length < 10) return isoDate || "";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function nowStr() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Only write file if content changed — preserves timestamp for lftp --only-newer
function writeIfChanged(filePath, content) {
  try {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing === content) return false; // unchanged
  } catch {} // file doesn't exist yet
  fs.writeFileSync(filePath, content, "utf-8");
  return true; // written
}

// Extract vehicle specs from raw description for vehicle lots
function extractVehicleSpecs(rawDesc, catName) {
  // Only apply to vehicle-related categories
  const isVehicle = /v[ée]hicul|auto|moto|voiture|utilitaire|camping|quad|scooter/i.test(catName || "")
    || /v[ée]hicul|automobile/i.test(rawDesc.substring(0, 100));
  if (!isVehicle) return null;

  const text = rawDesc.replace(/\n/g, " ");
  const specs = {};

  // Marque + Modèle — first line often has "MARQUE - MODELE ..."
  const brandModelMatch = text.match(/^([A-Z][A-ZÀ-Ü]{1,15})\s*[-–—]\s*(.+?)(?:\s*[-–—]|$)/m);
  if (brandModelMatch) {
    specs.marque = brandModelMatch[1].trim();
    // Keep full model name (includes engine info which is useful context)
    let model = brandModelMatch[2].trim();
    // Remove CH/CV power suffix to avoid redundancy with motorisation
    model = model.replace(/\s+\d{2,3}\s*(CH|CV)\b/i, "").trim();
    specs.modele = model.substring(0, 60);
  }

  // Motorisation — look for engine patterns
  const engineMatch = text.match(/(\d+[.,]\d+)\s*[lL]?\s*(DCI|HDI|TDI|TDCI|CDI|CRDI|TSI|TFSI|GTI|D4D|JTDM|MJET|MJTD|BlueHDI|PureTech|TCE|DIG-T|E-TECH)?\s*(\d{2,3})\s*(ch|cv|hp)/i);
  if (engineMatch) {
    const cylL = engineMatch[1].replace(",", ".");
    const tech = engineMatch[2] || "";
    const hp = engineMatch[3];
    specs.motorisation = `${cylL} L ${tech} ${hp} ch`.replace(/\s+/g, " ").trim();
  } else {
    // Try simpler pattern: "1.5 DCI" or "2.0 TDI"
    const simpleEngine = text.match(/(\d+[.,]\d+)\s*[lL]?\s*(DCI|HDI|TDI|TDCI|CDI|CRDI|TSI|TFSI|GTI|D4D|JTDM|MJET|BlueHDI|PureTech|TCE|DIG-T)/i);
    if (simpleEngine) specs.motorisation = `${simpleEngine[1].replace(",", ".")} L ${simpleEngine[2]}`;
    // Or just "68 CH" / "110 CV"
    const hpOnly = text.match(/(\d{2,3})\s*(ch|cv|hp)/i);
    if (!specs.motorisation && hpOnly) specs.puissance = `${hpOnly[1]} ${hpOnly[2].toUpperCase()}`;
  }

  // Carburant / Énergie
  const fuelMap = {
    "GO": "Diesel (Gasoil)",
    "GASOIL": "Diesel (Gasoil)",
    "GAZOLE": "Diesel (Gasoil)",
    "DIESEL": "Diesel",
    "ES": "Essence",
    "ESSENCE": "Essence",
    "ELECTRIQUE": "Électrique",
    "HYBRIDE": "Hybride",
    "GPL": "GPL",
    "GNV": "GNV",
  };
  for (const [key, val] of Object.entries(fuelMap)) {
    // Match as standalone word
    if (new RegExp(`\\b${key}\\b`, "i").test(text)) {
      specs.carburant = val;
      break;
    }
  }

  // Mise en service
  const miseEnService = text.match(/mise\s+en\s+service\s*[:.]?\s*(\d{2}[\/.-]\d{2}[\/.-]\d{4})/i)
    || text.match(/MEC\s*[:.]?\s*(\d{2}[\/.-]\d{2}[\/.-]\d{4})/i)
    || text.match(/date\s+1[eè]?re?\s+(?:mise\s+en\s+)?(?:circulation|immat)\s*[:.]?\s*(\d{2}[\/.-]\d{2}[\/.-]\d{4})/i);
  if (miseEnService) specs.mise_en_service = miseEnService[1];

  // Kilométrage
  const kmMatch = text.match(/(\d[\d\s.,]*)\s*km/i);
  if (kmMatch) {
    const kmVal = kmMatch[1].replace(/[\s.]/g, "").replace(",", "");
    if (parseInt(kmVal) > 100 && parseInt(kmVal) < 1000000) {
      specs.kilometrage = parseInt(kmVal).toLocaleString("fr-FR") + " km";
    }
  }

  // Finition / Version
  const finitionMatch = text.match(/\b(VISIA|ACENTA|TEKNA|LIFE|ZEN|INTENS|INITIALE|BUSINESS|ACTIVE|ALLURE|GT LINE|GT|RS|AMG|S-LINE|R-LINE|SPORT|LUXURY|PREMIUM|CONFORT|TREND|TITANIUM|GHIA|AMBIENTE|STYLE|ELEGANCE|AVANTAGE|ACCESS|SENSE|SHINE|FLAIR|LOUNGE|POP|EASY|CROSS|CITY|EDITION|SPECIAL|PACK|DYNAMIC|SELECT|TECHNO|FIRST)\b/i);
  if (finitionMatch) specs.finition = finitionMatch[1];

  // Immatriculation
  const immatMatch = text.match(/\b([A-Z]{2}[-\s]?\d{3}[-\s]?[A-Z]{2})\b/);
  if (immatMatch) specs.immatriculation = immatMatch[1];

  // Boîte de vitesses
  const boiteMatch = text.match(/\b(BVM?\d?|BVA\d?|automatique|manuelle|robotis[ée]e?|CVT|DSG|EDC|EAT\d?|S-?TRONIC|PDK|TIPTRONIC)\b/i);
  if (boiteMatch) {
    const val = boiteMatch[1].toUpperCase();
    if (/BVM|MANUELLE/i.test(val)) specs.boite = "Manuelle";
    else if (/BVA|AUTO|CVT|DSG|EDC|EAT|TRONIC|PDK|TIPTRONIC/i.test(val)) specs.boite = "Automatique";
    else specs.boite = boiteMatch[1];
  }

  // Nombre de portes
  const portesMatch = text.match(/(\d)\s*(?:portes?|P)\b/i);
  if (portesMatch && parseInt(portesMatch[1]) >= 2 && parseInt(portesMatch[1]) <= 5) {
    specs.portes = portesMatch[1] + " portes";
  }

  // Couleur
  const couleurMatch = text.match(/\b(noir[e]?|blanc(?:he)?|gris[e]?|rouge|bleu[e]?|vert[e]?|jaune|orange|beige|marron|argent[ée]?|anthracite|brun[e]?|bordeaux|champagne|cr[eè]me|dor[ée]|ivoire|sable|prune)\b/i);
  if (couleurMatch) specs.couleur = couleurMatch[1].charAt(0).toUpperCase() + couleurMatch[1].slice(1).toLowerCase();

  // Only return if we found meaningful specs
  const count = Object.keys(specs).length;
  return count >= 2 ? specs : null;
}

// Format vehicle specs as HTML table
function vehicleSpecsHtml(specs) {
  if (!specs) return "";
  const labels = {
    marque: "🏭 Marque",
    modele: "🚗 Modèle",
    motorisation: "⚙️ Motorisation",
    puissance: "💪 Puissance",
    carburant: "⛽ Énergie",
    mise_en_service: "📅 Mise en service",
    kilometrage: "🛣️ Kilométrage",
    finition: "✨ Finition",
    boite: "🔧 Boîte de vitesses",
    portes: "🚪 Portes",
    couleur: "🎨 Couleur",
    immatriculation: "🔢 Immatriculation",
  };
  const rows = Object.entries(specs)
    .filter(([k, v]) => v && labels[k])
    .map(([k, v]) => `<tr><td>${labels[k]}</td><td><strong>${esc(String(v))}</strong></td></tr>`)
    .join("");
  if (!rows) return "";
  return `<div class="card">
    <div class="card-header"><h3 style="font-size:1rem;">🔧 Fiche technique</h3></div>
    <div class="card-body">
      <table class="meta-table">${rows}</table>
    </div>
  </div>`;
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

// ─── Taxonomie officielle Interenchères ──────────────────────────────────────
const CATEGORY_TAXONOMY = {
  "art-decoration-collections": {
    name: "Art, Décoration & Collections",
    subcats: [
      "Tableaux, Dessins & Estampes", "Sculptures", "Art Contemporain & Urbain",
      "Mobilier Ancien", "Design & Mobilier du XXe", "Arts de la Table", "Luminaires",
      "Bijoux & Pierres Précieuses", "Montres de Collection", "Maroquinerie de Luxe", "Mode & Accessoires",
      "Arts d'Asie", "Arts d'Orient & Islamiques", "Archéologie & Arts Premiers",
      "Vins & Spiritueux", "Militaria", "Jouets & Modélisme", "BD, Mangas & Comics",
      "Instruments de Musique", "Livres & Manuscrits", "Numismatique", "Philatélie",
      "Lingots & Pièces d'Or", "Argent Métal",
      "Céramiques & Porcelaine", "Verrerie & Cristallerie", "Argenterie & Orfèvrerie",
      "Tapis & Textiles", "Photographie", "Objets d'art & Curiosités", "Art populaire",
      "Pendules & Horloges"
    ]
  },
  "vehicules": {
    name: "Véhicules",
    subcats: [
      "Voitures de Collection", "Voitures Particulières",
      "Motos & Scooters", "Utilitaires & Véhicules de Société",
      "Bateaux & Nautisme", "Camping-cars & Caravanes",
      "Pièces détachées & Accessoires"
    ]
  },
  "biens-equipement": {
    name: "Biens d'équipement",
    subcats: [
      "BTP & Construction", "Matériel Agricole & Viticole",
      "Machines-outils & Industrie", "Manutention & Levage",
      "Matériel de Restauration & Hôtellerie", "Matériel Médical",
      "Informatique & Téléphonie", "Électroménager",
      "Destockage & Invendus", "Mobilier & Matériel de Bureau",
      "Bricolage & Jardinage", "High-tech & Multimédia",
      "Fonds de Commerce & Licences", "Photo & Audiovisuel"
    ]
  },
  "divers-nature": {
    name: "Divers & Nature",
    subcats: [
      "Chevaux & Équitation", "Objets du Quotidien", "Sports & Loisirs", "Autre"
    ]
  }
};

// Map Interenchères category IDs → { parent, subcat }
const CATEGORY_ID_MAP = {
  // mo = Art & Objets mobiliers
  200: { parent: "art-decoration-collections", subcat: "Objets d'art & Curiosités" },
  201: { parent: "art-decoration-collections", subcat: "Argenterie & Orfèvrerie" },
  202: { parent: "art-decoration-collections", subcat: "Art populaire" },
  203: { parent: "art-decoration-collections", subcat: "Arts d'Asie" },
  204: { parent: "art-decoration-collections", subcat: "Art populaire" },
  205: { parent: "art-decoration-collections", subcat: "Bijoux & Pierres Précieuses" },
  206: { parent: "art-decoration-collections", subcat: "Livres & Manuscrits" },
  207: { parent: "art-decoration-collections", subcat: "Céramiques & Porcelaine" },
  208: { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  209: { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  210: { parent: "art-decoration-collections", subcat: "Instruments de Musique" },
  211: { parent: "art-decoration-collections", subcat: "Objets d'art & Curiosités" },
  212: { parent: "art-decoration-collections", subcat: "Jouets & Modélisme" },
  213: { parent: "art-decoration-collections", subcat: "Numismatique" },
  214: { parent: "art-decoration-collections", subcat: "Philatélie" },
  215: { parent: "art-decoration-collections", subcat: "Mobilier Ancien" },
  216: { parent: "art-decoration-collections", subcat: "Mobilier Ancien" },
  217: { parent: "art-decoration-collections", subcat: "Design & Mobilier du XXe" },
  218: { parent: "art-decoration-collections", subcat: "Mode & Accessoires" },
  219: { parent: "art-decoration-collections", subcat: "Numismatique" },
  220: { parent: "art-decoration-collections", subcat: "Pendules & Horloges" },
  221: { parent: "art-decoration-collections", subcat: "Design & Mobilier du XXe" },
  222: { parent: "art-decoration-collections", subcat: "Verrerie & Cristallerie" },
  223: { parent: "art-decoration-collections", subcat: "Verrerie & Cristallerie" },
  224: { parent: "art-decoration-collections", subcat: "Vins & Spiritueux" },
  225: { parent: "art-decoration-collections", subcat: "Photographie" },
  226: { parent: "art-decoration-collections", subcat: "Sculptures" },
  227: { parent: "art-decoration-collections", subcat: "Arts d'Orient & Islamiques" },
  228: { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  229: { parent: "art-decoration-collections", subcat: "Tapis & Textiles" },
  230: { parent: "art-decoration-collections", subcat: "Archéologie & Arts Premiers" },
  231: { parent: "art-decoration-collections", subcat: "Militaria" },
  232: { parent: "art-decoration-collections", subcat: "Luminaires" },
  // pr = Professionnel & Stocks
  234: { parent: "biens-equipement", subcat: "BTP & Construction" },
  236: { parent: "biens-equipement", subcat: "Machines-outils & Industrie" },
  238: { parent: "biens-equipement", subcat: "Destockage & Invendus" },
  239: { parent: "biens-equipement", subcat: "Matériel Agricole & Viticole" },
  240: { parent: "biens-equipement", subcat: "Manutention & Levage" },
  242: { parent: "biens-equipement", subcat: "Matériel de Restauration & Hôtellerie" },
  243: { parent: "biens-equipement", subcat: "Destockage & Invendus" },
  244: { parent: "biens-equipement", subcat: "Matériel Médical" },
  248: { parent: "biens-equipement", subcat: "Électroménager" },
  249: { parent: "biens-equipement", subcat: "Mobilier & Matériel de Bureau" },
  250: { parent: "biens-equipement", subcat: "Photo & Audiovisuel" },
  251: { parent: "biens-equipement", subcat: "Informatique & Téléphonie" },
  // vh = Véhicules
  254: { parent: "vehicules", subcat: "Camping-cars & Caravanes" },
  256: { parent: "vehicules", subcat: "Bateaux & Nautisme" },
  261: { parent: "vehicules", subcat: "Utilitaires & Véhicules de Société" },
  262: { parent: "vehicules", subcat: "Voitures Particulières" },
  265: { parent: "vehicules", subcat: "Voitures de Collection" },
};

// Map Interenchères category names (normalized) → { parent, subcat }
const CATEGORY_MAP = {
  // Art
  "tableaux - peintures": { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  "tableaux modernes et contemporains": { parent: "art-decoration-collections", subcat: "Art Contemporain & Urbain" },
  "estampes - dessins - gravures": { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  "estampes - affiches - gravure - lithographie - eau-forte": { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  "dessins - pastel - aquarelle - gouache - fusain - encre": { parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  "sculptures": { parent: "art-decoration-collections", subcat: "Sculptures" },
  // Mobilier & Décoration
  "mobilier": { parent: "art-decoration-collections", subcat: "Mobilier Ancien" },
  "vente de mobilier courant": { parent: "art-decoration-collections", subcat: "Mobilier Ancien" },
  "mobilier moderne, contemporain et design": { parent: "art-decoration-collections", subcat: "Design & Mobilier du XXe" },
  "luminaires": { parent: "art-decoration-collections", subcat: "Luminaires" },
  "objets d'art et de decoration du xxe siecle": { parent: "art-decoration-collections", subcat: "Design & Mobilier du XXe" },
  "tapis - textiles": { parent: "art-decoration-collections", subcat: "Tapis & Textiles" },
  "tapis - tapisseries - tentures": { parent: "art-decoration-collections", subcat: "Tapis & Textiles" },
  // Bijoux & Mode
  "bijoux": { parent: "art-decoration-collections", subcat: "Bijoux & Pierres Précieuses" },
  "bijoux - montres": { parent: "art-decoration-collections", subcat: "Bijoux & Pierres Précieuses" },
  "pendules - horloges - montres": { parent: "art-decoration-collections", subcat: "Pendules & Horloges" },
  "mode - luxe": { parent: "art-decoration-collections", subcat: "Mode & Accessoires" },
  "mode - vintage - maroquinerie": { parent: "art-decoration-collections", subcat: "Maroquinerie de Luxe" },
  // Céramiques & Verre
  "ceramiques - faience - porcelaine": { parent: "art-decoration-collections", subcat: "Céramiques & Porcelaine" },
  "ceramiques - faience - porcelaine - gres - terre cuite": { parent: "art-decoration-collections", subcat: "Céramiques & Porcelaine" },
  "verrerie - cristallerie": { parent: "art-decoration-collections", subcat: "Verrerie & Cristallerie" },
  "objets de vitrine - verreries - flacons - sulfures": { parent: "art-decoration-collections", subcat: "Verrerie & Cristallerie" },
  "argenterie - orfevrerie": { parent: "art-decoration-collections", subcat: "Argenterie & Orfèvrerie" },
  "argenterie - orfevrerie - metal argente": { parent: "art-decoration-collections", subcat: "Argenterie & Orfèvrerie" },
  // Collections
  "vins - spiritueux": { parent: "art-decoration-collections", subcat: "Vins & Spiritueux" },
  "instruments de musique": { parent: "art-decoration-collections", subcat: "Instruments de Musique" },
  "instruments scientifiques - objets de marine - curiosites": { parent: "art-decoration-collections", subcat: "Objets d'art & Curiosités" },
  "numismatique - monnaies": { parent: "art-decoration-collections", subcat: "Numismatique" },
  "jouets - figurines": { parent: "art-decoration-collections", subcat: "Jouets & Modélisme" },
  "armes - militaria": { parent: "art-decoration-collections", subcat: "Militaria" },
  "art populaire": { parent: "art-decoration-collections", subcat: "Art populaire" },
  "art d'asie": { parent: "art-decoration-collections", subcat: "Arts d'Asie" },
  "photographies - cinema - appareils photo": { parent: "art-decoration-collections", subcat: "Photographie" },
  "cartes postales - vieux papiers": { parent: "art-decoration-collections", subcat: "Livres & Manuscrits" },
  "high-tech - multimedia": { parent: "biens-equipement", subcat: "High-tech & Multimédia" },
  "sports - loisirs": { parent: "divers-nature", subcat: "Sports & Loisirs" },
  // Véhicules
  "voitures de sport et de collection": { parent: "vehicules", subcat: "Voitures de Collection" },
  "vehicules particuliers": { parent: "vehicules", subcat: "Voitures Particulières" },
  "utilitaires legers - vehicules de societe": { parent: "vehicules", subcat: "Utilitaires & Véhicules de Société" },
  "bateaux - nautisme": { parent: "vehicules", subcat: "Bateaux & Nautisme" },
  "motos - scooters - quads": { parent: "vehicules", subcat: "Motos & Scooters" },
  // Biens d'équipement
  "materiel agricole - espaces verts": { parent: "biens-equipement", subcat: "Matériel Agricole & Viticole" },
  "materiel et stocks de fonds de commerce": { parent: "biens-equipement", subcat: "Destockage & Invendus" },
  "electromenager": { parent: "biens-equipement", subcat: "Électroménager" },
  "mobilier et materiel de bureau - informatique": { parent: "biens-equipement", subcat: "Mobilier & Matériel de Bureau" },
  "materiel medical - laboratoire": { parent: "biens-equipement", subcat: "Matériel Médical" },
  "photo - audiovisuel - sonorisation - eclairage": { parent: "biens-equipement", subcat: "Photo & Audiovisuel" },
};

// Regex fallback for items with no category or unmapped categories
const CATEGORY_REGEX_FALLBACK = [
  { pattern: /\b(moto|scooter|quad|harley|ducati|yamaha|kawasaki|vespa|triumph)\b/i, parent: "vehicules", subcat: "Motos & Scooters" },
  { pattern: /\b(bateau|voilier|catamaran|jet.ski|zodiac|nautisme)\b/i, parent: "vehicules", subcat: "Bateaux & Nautisme" },
  { pattern: /\b(bague|collier|pendentif|diamant|saphir|émeraude|rubis|bijou|parure|bracelet.*or)\b/i, parent: "art-decoration-collections", subcat: "Bijoux & Pierres Précieuses" },
  { pattern: /\b(rolex|omega|patek|breitling|cartier.*montre|tag.*heuer|montre.*gousset|chronograph)\b/i, parent: "art-decoration-collections", subcat: "Montres de Collection" },
  { pattern: /\b(huile.*toile|aquarelle|gouache|tableau.*sign|peinture.*sign|lithographie|estampe|gravure)\b/i, parent: "art-decoration-collections", subcat: "Tableaux, Dessins & Estampes" },
  { pattern: /\b(sculpture|bronze.*sculpt|buste|statue|terre.*cuite.*sculpt)\b/i, parent: "art-decoration-collections", subcat: "Sculptures" },
  { pattern: /\b(commode|armoire|buffet|secrétaire|console|guéridon|fauteuil.*louis|bergère)\b/i, parent: "art-decoration-collections", subcat: "Mobilier Ancien" },
  { pattern: /\b(hermès|chanel|vuitton|birkin|gucci|dior|prada|sac.*main|maroquinerie)\b/i, parent: "art-decoration-collections", subcat: "Maroquinerie de Luxe" },
  { pattern: /\b(bordeaux|bourgogne|champagne|romanée|pétrus|whisky|cognac|armagnac)\b/i, parent: "art-decoration-collections", subcat: "Vins & Spiritueux" },
  { pattern: /\b(tracteur|moissonneuse|pelleteuse|chargeuse|manitou|john.deere|chariot.*élévateur|nacelle)\b/i, parent: "biens-equipement", subcat: "Matériel Agricole & Viticole" },
  { pattern: /\b(iphone|ipad|macbook|samsung.*galaxy|playstation|xbox|nintendo|drone)\b/i, parent: "biens-equipement", subcat: "High-tech & Multimédia" },
  { pattern: /\b(lave.*linge|lave.*vaisselle|réfrigérateur|congélateur|robot.*cuisine|thermomix|dyson)\b/i, parent: "biens-equipement", subcat: "Électroménager" },
  { pattern: /\b(piano|violon|guitare|saxophone|trompette|accordéon)\b/i, parent: "art-decoration-collections", subcat: "Instruments de Musique" },
  { pattern: /\b(fusil|carabine|revolver|sabre|épée|baïonnette|militaire)\b/i, parent: "art-decoration-collections", subcat: "Militaria" },
  { pattern: /\b(jade|céladon|ming|qing|bouddha|netsuke|laque.*japon)\b/i, parent: "art-decoration-collections", subcat: "Arts d'Asie" },
  { pattern: /\b(porcelaine|faïence|majolique|barbotine|biscuit)\b/i, parent: "art-decoration-collections", subcat: "Céramiques & Porcelaine" },
  { pattern: /\b(cristal|lalique|daum|gallé|baccarat|murano)\b/i, parent: "art-decoration-collections", subcat: "Verrerie & Cristallerie" },
  { pattern: /\b(argenterie|argent.*massif|orfèvrerie|christofle)\b/i, parent: "art-decoration-collections", subcat: "Argenterie & Orfèvrerie" },
  { pattern: /\b(livre.*ancien|manuscrit|édition.*originale)\b/i, parent: "art-decoration-collections", subcat: "Livres & Manuscrits" },
  { pattern: /\b(pièce.*or|napoléon.*or|louis.*or|numismatique)\b/i, parent: "art-decoration-collections", subcat: "Numismatique" },
];

// Get parent name from slug
function getParentName(parentSlug) {
  return CATEGORY_TAXONOMY[parentSlug]?.name || "";
}

function mapToTaxonomy(item) {
  const catName = item.category?.name || "";
  const catId = item.category?.id || 0;
  const field = item.category?.field || "";
  const desc = (item.description || item.title_translations?.["fr-FR"] || "").toLowerCase();

  // 1. Try mapping by category ID (most reliable)
  if (catId && CATEGORY_ID_MAP[catId]) return CATEGORY_ID_MAP[catId];

  // 2. Try mapping by normalized category name
  const normalizedName = catName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s*\(.*\)/, "").replace(/\n/g, " ").trim();
  if (normalizedName) {
    for (const [key, val] of Object.entries(CATEGORY_MAP)) {
      if (normalizedName.includes(key) || key.includes(normalizedName.substring(0, 15))) {
        return val;
      }
    }
  }

  // 3. Try by field code (mo=art/mobilier, vh=vehicules, pr=professionnel)
  if (field === "vh") return { parent: "vehicules", subcat: "Voitures Particulières" };
  if (field === "pr") return { parent: "biens-equipement", subcat: "Destockage & Invendus" };

  // 4. Regex fallback on description
  for (const rule of CATEGORY_REGEX_FALLBACK) {
    if (rule.pattern.test(desc)) return { parent: rule.parent, subcat: rule.subcat };
  }

  // 5. Default: field "mo" → art, otherwise divers
  if (field === "mo") return { parent: "art-decoration-collections", subcat: "Objets d'art & Curiosités" };
  return { parent: "divers-nature", subcat: "Autre" };
}

function registerItem(item, sale) {
  // Apply taxonomy mapping — keep original Interencheres category name, only add parent grouping
  const taxonomy = mapToTaxonomy(item);
  item._parentCat = getParentName(taxonomy.parent);
  item._parentCatSlug = taxonomy.parent;
  // Keep Interencheres original category name (e.g. "Bijoux - Montres"), don't override

  // Store real commission rate from API (instead of guessing 25%)
  const saleData = sale || item.sale || {};
  const commissionRate = saleData.options?.commission_rate?.voluntary || saleData.options?.commission_rate?.judicial || 0;
  if (commissionRate > 0) item._commissionRate = commissionRate;
  // Store sale contact info for unsold lots
  const saleContact = saleData.contact || {};
  if (saleContact.contacts?.email || saleContact.contacts?.phone_number) {
    item._saleContact = {
      name: saleContact.name || "",
      email: saleContact.contacts?.email || "",
      phone: saleContact.contacts?.phone_number || "",
    };
  }
  // Store withdrawal conditions
  const withdrawal = item.shipping?.withdrawal_conditions || "";
  if (withdrawal) item._withdrawal = withdrawal;

  registry.items.set(item.id, { item, sale });

  // Register sale
  const saleId = sale?.id || item.sale?.id;
  if (saleId && !registry.sales.has(saleId)) {
    registry.sales.set(saleId, {
      sale,
      saleName: sale?.name || "",
      org: sale?.organization?.names?.voluntary || sale?.organization?.names?.judicial || "",
      city: titleCaseCity(sale?.address?.city || ""),
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
        parent: item._parentCatSlug || "divers-nature",
        parentName: item._parentCat || "Divers & Nature",
        items: [],
      });
    }
    registry.categories.get(catSlug).items.push(item);
  }

  // Register maison
  const orgName = item.organization?.names?.voluntary || item.organization?.names?.judicial || "";
  if (orgName) {
    const orgSlug = slugify(orgName);
    const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
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
  // Apply taxonomy mapping — keep original Interencheres category name, only add parent grouping
  const taxonomy = mapToTaxonomy(item);
  item._parentCat = getParentName(taxonomy.parent);
  item._parentCatSlug = taxonomy.parent;
  // Keep Interencheres original category name (e.g. "Bijoux - Montres"), don't override
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
  <script src="/search-data.js?v=${Date.now()}"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={darkMode:'class',theme:{extend:{colors:{brand:{400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed'},surface:{800:'#1e1b2e',900:'#13111c',950:'#0c0a14'}}}}}</script>
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

    /* Nav — handled by Tailwind now, keep minimal fallback */

    /* Breadcrumb */
    .breadcrumb { max-width: 72rem; margin: 0 auto; padding: 0.6rem 1.5rem; font-size: 0.8rem; color: var(--text3); }
    .breadcrumb a { color: var(--text2); }
    .breadcrumb a:hover { color: var(--accent2); }

    /* Layout */
    .container { max-width: 72rem; margin: 1.5rem auto; padding: 0 1.5rem; overflow: hidden; word-break: break-word; }
    .grid-2 { display: grid; grid-template-columns: 1fr 300px; gap: 1.5rem; overflow: hidden; }
    .grid-2 > main { min-width: 0; overflow: hidden; max-width: 100%; }
    .cat-desc { max-height: 5.5em; overflow: hidden; position: relative; transition: max-height 0.3s ease; }
    .cat-desc.expanded { max-height: none; }
    .cat-desc-toggle { display: block; text-align: center; color: var(--accent); font-size: 0.85rem; padding: 0.5rem; cursor: pointer; }

    @media (max-width: 800px) {
      .grid-2 { grid-template-columns: 1fr; }
      .container { margin: 0.8rem auto; padding: 0 0.8rem; }
      .breadcrumb { padding: 0.5rem 0.8rem; font-size: 0.75rem; }
      .card-body { padding: 1rem; }
      .card-header { padding: 0.8rem 1rem; }
      .price { font-size: 1.5rem; }
      .estimate { display: block; margin-top: 0.3rem; margin-left: 0 !important; }
      .lot-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.8rem; }
      .lot-card .lot-info { padding: 0.6rem; }
      .lot-card .lot-title { font-size: 0.75rem; }
      .amazon-btn, .ebay-btn { padding: 10px 16px; font-size: 0.82rem; }
      .stat-number { font-size: 1.4rem; }
      .stat-label { font-size: 0.7rem; }
      h1 { font-size: 1.15rem !important; }
      .cat-desc { max-height: 4.5em; }
    }

    /* Cards */
    .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 1rem; overflow: hidden; margin-bottom: 1.5rem; transition: border-color 0.2s; max-width: 100%; box-sizing: border-box; }
    .card:hover { border-color: rgba(255,255,255,0.1); }
    .card-header { padding: 0.8rem 1.2rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .card-header h2, .card-header h3 { color: var(--text); font-weight: 600; }
    .card-body { padding: 1.2rem; overflow: hidden; word-break: break-word; overflow-wrap: break-word; max-width: 100%; box-sizing: border-box; }

    /* Images */
    .gallery { display: flex; flex-wrap: wrap; gap: 8px; padding: 1.5rem; background: var(--bg); justify-content: center; max-width: 100%; box-sizing: border-box; }
    .gallery img { max-height: 300px; max-width: 100%; border-radius: var(--radius-sm); cursor: pointer; transition: transform 0.2s; }
    .gallery img:hover { transform: scale(1.03); }

    /* Price */
    .price { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; }
    .price.sold { color: var(--accent2); }
    .price.unsold { color: var(--red); }
    .estimate { color: var(--text3); font-size: 0.85rem; }
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
    .lot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1rem; }
    .lot-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 1rem; overflow: hidden; transition: all 0.2s; position: relative; }
    .lot-card:hover { border-color: rgba(139,92,246,0.3); background: rgba(255,255,255,0.05); }
    .lot-card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; transition: transform 0.3s; }
    .lot-card:hover img { transform: scale(1.05); }
    .lot-card .no-img { width: 100%; aspect-ratio: 4/3; background: var(--surface3); display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 2rem; }
    .lot-card .lot-info { padding: 0.85rem; }
    .lot-card .lot-title { font-size: 0.82rem; font-weight: 500; line-height: 1.4; height: 2.8em; overflow: hidden; color: var(--text); }
    .lot-card .lot-price { font-weight: 800; color: var(--accent2); margin-top: 0.4rem; font-size: 1rem; }
    .lot-card .lot-cat { font-size: 0.7rem; color: var(--text3); margin-top: 0.3rem; }

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
    .stat-number { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; color: var(--text); }
    .stat-label { color: var(--text3); font-size: 0.78rem; font-weight: 500; margin-top: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Ad */
    .ad-slot { margin: 1rem 0; text-align: center; min-height: 90px; border-radius: var(--radius-sm); }

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
    [data-theme="light"] .price.sold { text-shadow: none; }
    [data-theme="light"] .lot-card { box-shadow: var(--shadow-sm); }
    [data-theme="light"] .lot-card:hover { box-shadow: 0 12px 32px rgba(0,0,0,0.1); }
    [data-theme="light"] .carousel { background: #222; }
    [data-theme="light"] .carousel-dots { background: #222; }
    [data-theme="light"] .carousel-thumbs { background: #222; }

    /* Search dropdown */
    .search-wrap { position: relative; }
    .search-results { position: absolute; top: 100%; left: 0; right: 0; margin-top: 6px; background: var(--surface); border: 1px solid rgba(255,255,255,0.1); border-radius: 0.75rem; box-shadow: 0 8px 30px rgba(0,0,0,0.4); max-height: 400px; overflow-y: auto; z-index: 200; display: none; min-width: 320px; }
    .search-results.active { display: block; }
    .search-result { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); text-decoration: none; color: var(--text); transition: background 0.15s; }
    .search-result:hover { background: rgba(255,255,255,0.05); }
    .search-result img { width: 48px; height: 36px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
    .search-result .sr-title { font-size: 0.82rem; line-height: 1.3; flex: 1; }
    .search-result .sr-price { color: var(--accent2); font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
    .search-no-result { padding: 1rem; text-align: center; color: var(--text3); font-size: 0.85rem; }
    @media (max-width: 800px) {
      .search-results { min-width: 0; left: -40px; right: -40px; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme','dark');</script>
</head>`;
}

function navHtml() {
  return `<nav class="sticky top-0 z-50 backdrop-blur-xl bg-[var(--surface)]/95 border-b border-white/10 shadow-lg shadow-black/10">
  <div class="max-w-6xl mx-auto px-4 md:px-6 flex items-center justify-between h-16">
    <a href="/index.html" class="flex items-center gap-2.5 no-underline shrink-0 group">
      <img src="/img/gavel.png" alt="" width="32" height="32" class="drop-shadow-md group-hover:scale-110 transition-transform">
      <span class="text-xl font-extrabold tracking-tight text-[var(--text)]">Adjugé<span class="text-[var(--accent2)]">.</span></span>
    </a>
    <div class="hidden md:flex items-center gap-0.5 text-[0.85rem]">
      <a href="/index.html" class="px-3.5 py-2 rounded-lg text-[var(--text)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-semibold">Accueil</a>
      <a href="/categories.html" class="px-3.5 py-2 rounded-lg text-[var(--text2)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-medium">Catégories</a>
      <a href="/villes.html" class="px-3.5 py-2 rounded-lg text-[var(--text2)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-medium">Villes</a>
      <a href="/top-ventes.html" class="px-3.5 py-2 rounded-lg text-[var(--text2)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-medium">Top</a>
      <a href="/invendus.html" class="px-3.5 py-2 rounded-lg text-[var(--text2)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-medium">Invendus</a>
      <a href="/recherche.html" class="px-3.5 py-2 rounded-lg text-[var(--text2)] hover:text-white hover:bg-[var(--accent)]/10 transition no-underline font-medium">Recherche</a>
    </div>
    <div class="flex items-center gap-2">
      <div class="search-wrap relative">
        <input type="text" id="searchInput" placeholder="Rechercher un lot..." autocomplete="off"
          class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm w-36 md:w-52 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50 focus:border-[var(--accent)] placeholder-[var(--text3)] text-[var(--text)] font-[inherit] transition-all focus:w-48 md:focus:w-72">
        <div class="search-results" id="searchResults"></div>
      </div>
      <!-- Theme toggle disabled — dark mode only for now -->
      <button class="md:hidden w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-lg hover:bg-white/10 transition" onclick="document.getElementById('navLinks').classList.toggle('hidden')" aria-label="Menu">☰</button>
    </div>
  </div>
  <div class="hidden md:hidden border-t border-white/5 bg-[var(--surface)]" id="navLinks">
    <div class="max-w-6xl mx-auto px-4 py-2 flex flex-col">
      <a href="/index.html" class="px-4 py-3 text-sm text-[var(--text)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline font-semibold">Accueil</a>
      <a href="/categories.html" class="px-4 py-3 text-sm text-[var(--text2)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline">Catégories</a>
      <a href="/villes.html" class="px-4 py-3 text-sm text-[var(--text2)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline">Villes</a>
      <a href="/top-ventes.html" class="px-4 py-3 text-sm text-[var(--text2)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline">Top Ventes</a>
      <a href="/invendus.html" class="px-4 py-3 text-sm text-[var(--text2)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline">Invendus</a>
      <a href="/recherche.html" class="px-4 py-3 text-sm text-[var(--text2)] hover:bg-[var(--accent)]/10 rounded-lg transition no-underline">Recherche</a>
    </div>
  </div>
</nav>
<script>
// Dark mode only — light mode disabled for now
(function(){ document.documentElement.setAttribute('data-theme','dark'); })();
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
  // Enter → redirect to full search page
  input.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();var q=this.value.trim();if(q)window.location.href='/recherche.html?q='+encodeURIComponent(q);}
  });
})();
</script>`;
}

function footerHtml() {
  return `<footer class="border-t border-white/5 mt-12">
  <div class="max-w-6xl mx-auto px-6 py-10">
    <div class="flex flex-col md:flex-row justify-between items-start gap-8">
      <div>
        <a href="/index.html" class="text-lg font-bold text-[var(--text)] no-underline">Adjugé<span class="text-[var(--accent)]">.</span></a>
        <p class="text-sm text-[var(--text3)] mt-2 max-w-xs">Résultats de ventes aux enchères en France. Prix adjugés, photos et estimations.</p>
      </div>
      <div class="flex gap-12 text-sm text-[var(--text3)]">
        <div class="flex flex-col gap-2">
          <span class="text-[var(--text2)] font-medium mb-1">Navigation</span>
          <a href="/index.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Accueil</a>
          <a href="/categories.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Catégories</a>
          <a href="/villes.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Villes</a>
          <a href="/top-ventes.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Top ventes</a>
          <a href="/invendus.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Invendus</a>
          <a href="/recherche.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Recherche</a>
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-[var(--text2)] font-medium mb-1">Légal</span>
          <a href="/mentions-legales.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Mentions légales</a>
          <a href="/politique-confidentialite.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Confidentialité</a>
          <a href="/a-propos.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">À propos</a>
          <a href="/statistiques.html" class="hover:text-[var(--text)] transition no-underline text-[var(--text3)]">Statistiques</a>
        </div>
      </div>
    </div>
    <div class="border-t border-white/5 mt-8 pt-6 text-center text-xs text-[var(--text3)]">
      © 2026 Adjugé ! — Référencement NICE (SIREN 447 716 218) · Les liens marchands sont des liens affiliés.
    </div>
  </div>
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
    const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
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

function lotCard(item, sale) {
  const rawD = cleanRawDesc(item.description || item.title_translations?.["fr-FR"] || "");
  const title = item._aiTitle || extractTitle(rawD);
  const price = item.pricing?.auctioned?.price || 0;
  const sold = price > 0;
  const est = item.pricing?.estimates || {};
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
  const catName = item.category?.name || "";
  const catSlug = catName ? slugify(catName) : "";
  const saleDate = sale?.datetime ? sale.datetime.substring(0, 10) : "";
  const dateDisplay = dateShortFr(saleDate);
  const estStr = est.min != null ? `Est. ${formatPrice(est.min)} – ${formatPrice(est.max)} €` : "";
  const priceLabel = sold ? `${formatPrice(price)} €` : (estStr || "Prix non communiqué");
  const statusLabel = sold ? "Adjugé" : "Invendu";
  const statusColor = sold ? "var(--accent)" : "#e67e22";
  return `<a href="/lot/${lotSlug(item)}.html" class="lot-card">
    ${thumb ? `<img src="${esc(thumb)}" alt="${esc(title)}" loading="lazy">` : `<div class="no-img">📦</div>`}
    <div class="lot-info">
      <div class="lot-title">${esc(title)}</div>
      <div style="font-weight:700;color:${statusColor};font-size:0.95rem;">${priceLabel}</div>
      <div style="font-size:0.75rem;color:${statusColor};">${statusLabel}</div>
      ${dateDisplay ? `<div style="color:var(--text3);font-size:0.7rem;margin-top:2px;">Présenté en vente le ${dateDisplay}</div>` : ""}
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

// Clean a title line: remove ref numbers, lot numbers, leading dashes, "sur désignation" etc.
function cleanTitleLine(s) {
  let t = s;
  // Remove "(Ref. X)" or "(Ref X)" or "(Réf. X)" patterns
  t = t.replace(/\(r[ée]f\.?\s*[^)]*\)\s*/gi, "").trim();
  // Remove leading "Ref. X -" or "Réf X :"
  t = t.replace(/^r[ée]f\.?\s*\S+\s*[-:–—]\s*/i, "").trim();
  // Remove leading lot/article numbering: "1 -", "N°12 -", "LOT 3 :", "LOT 59 UNE..."
  t = t.replace(/^(lot\s*)?n?°?\s*\d+\s*[-:–—]\s*/i, "").trim();
  // Remove "LOT XX " without separator (e.g. "LOT 59 UNE POUSSETTE")
  t = t.replace(/^lot\s+\d+\s+/i, "").trim();
  // Remove leading quantity "1 " for single items (but keep "12 bouteilles")
  t = t.replace(/^1\s+(?=[a-zàâéèêëïîôùûüç])/i, "").trim();
  // Remove "sur désignation (VILLE CODE) :" prefix
  t = t.replace(/^sur\s+d[ée]signation\s*(\([^)]*\))?\s*:?\s*/i, "").trim();
  // Remove "dans nos locaux à VILLE :" prefix
  t = t.replace(/^dans\s+nos\s+locaux\s+[àa]\s+[^:]+:\s*/i, "").trim();
  // Remove "LIEU DE STOCKAGE : Ville - RÉSEAU -" prefix (Alcopa-style)
  t = t.replace(/^lieu\s+de\s+stockage\s*:\s*[^-]+\s*-\s*/i, "").trim();
  // Remove network/arcade name prefix (single word followed by -)
  t = t.replace(/^[A-Z]{3,20}\s*-\s+/i, "").trim();
  // Remove leading "- " or trailing " - -" or " -"
  t = t.replace(/^[-–—]\s+/, "").trim();
  t = t.replace(/\s*[-–—]\s*[-–—]?\s*$/, "").trim();
  return t || s; // Return original if cleaning emptied it
}

// Extract a meaningful title from raw description (skip license plates, lot numbers, etc.)
function extractTitle(rawDesc) {
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  // Skip lines that are just license plates (XX-123-YY or XX 123 YY)
  const isLicensePlate = (s) => /^[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}$/i.test(s.trim());
  const isLotNumber = (s) => /^(lot\s*n?°?\s*\d|n°?\s*\d)/i.test(s.trim());
  const isJustNumber = (s) => /^\d+$/.test(s.trim());
  const isRefOnly = (s) => /^\(?\s*r[ée]f\.?\s*[^)]*\)?\s*$/i.test(s.trim());

  // Find the first meaningful line
  for (const line of lines) {
    if (isLicensePlate(line) || isLotNumber(line) || isJustNumber(line) || isRefOnly(line)) continue;
    if (line.length < 3) continue;
    const cleaned = cleanTitleLine(line);
    if (cleaned.length < 3) continue;
    return cleaned.length > 70 ? cleaned.substring(0, 70) : cleaned;
  }
  // If all lines are plates/numbers, try joining first two meaningful words
  const fallback = lines[0] ? cleanTitleLine(lines[0]) : "Objet de collection";
  return fallback.substring(0, 70) || "Objet de collection";
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
  const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
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
  // Prix frais inclus — utilise le taux réel de la vente si disponible, sinon estime à 25%
  const realRate = item._commissionRate || 0;
  const BUYER_FEE_RATE = realRate > 0 ? realRate / 100 : 0.25;
  const isRealRate = realRate > 0;
  const priceWithFees = auc.sold && auc.price ? Math.round(auc.price * (1 + BUYER_FEE_RATE)) : 0;
  const feesHtml = priceWithFees ? `<div style="color:var(--text2);font-size:0.82rem;margin-top:4px;">${isRealRate ? "" : "≈ "}${formatPrice(priceWithFees)} € frais inclus <span style="font-size:0.7rem;color:var(--text3);" title="${isRealRate ? `Frais acheteur de ${realRate}% appliqués par la maison de vente.` : "Estimation basée sur un taux moyen de frais acheteur de 25%. Les frais réels varient selon la maison de vente."}">(${isRealRate ? `${realRate}% de frais` : "estimé*"})</span></div>` : "";

  const estHtml = est.min != null ? `Estimation : ${formatPrice(est.min)} – ${formatPrice(est.max)} €` : "";

  // Ratio mise à prix → prix vendu
  const startPrice = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
  const soldPrice = auc.sold && auc.price ? auc.price : 0;
  const priceRatio = startPrice > 0 && soldPrice > 0 ? (soldPrice / startPrice) : 0;
  const ratioLabel = priceRatio >= 5 ? "🔥 Surprise" : priceRatio >= 3 ? "⚡ Belle enchère" : priceRatio >= 1.5 ? "📈 Bonne dynamique" : priceRatio >= 1 ? "→ Enchère normale" : "";
  const ratioColor = priceRatio >= 5 ? "#ef4444" : priceRatio >= 3 ? "#f59e0b" : priceRatio >= 1.5 ? "#10b981" : "var(--text2)";
  const ratioHtml = priceRatio > 0 ? `<div style="margin-top:6px;display:inline-flex;align-items:center;gap:0.5rem;background:${priceRatio >= 3 ? "rgba(239,68,68,0.08)" : priceRatio >= 1.5 ? "rgba(16,185,129,0.08)" : "var(--card2)"};padding:4px 12px;border-radius:8px;font-size:0.85rem;">
    <span style="font-weight:700;color:${ratioColor};">×${priceRatio.toFixed(1)}</span>
    <span style="color:var(--text2);">la mise à prix (${formatPrice(startPrice)} €)</span>
    <span style="font-size:0.78rem;color:${ratioColor};font-weight:600;">${ratioLabel}</span>
  </div>` : (startPrice > 0 && !auc.sold ? `<div style="margin-top:6px;font-size:0.85rem;color:var(--text2);">Mise à prix : ${formatPrice(startPrice)} €</div>` : "");

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
  <div class="breadcrumb" style="display:flex;align-items:center;gap:0.5rem;">
    <a href="javascript:history.back()" style="text-decoration:none;font-size:1.2rem;color:var(--accent);" title="Retour">←</a>
    <span><a href="/index.html">Accueil</a> ›
    ${catSlug ? `<a href="/categorie/${catSlug}.html">${esc(catName)}</a> ›` : ""}
    ${esc(shortTitle)}</span>
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
              ${feesHtml}
              ${ratioHtml}
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
              contextParts.push(`Ce lot${catName ? ` de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a>` : ""} a été ${auc.sold ? `adjugé <strong>${formatPrice(priceVal)} €</strong>` : "présenté"} aux enchères${saleDate ? ` le ${dateFr(saleDate)}` : ""}${org ? ` par la maison <a href="/maison/${orgSlug}.html" style="color:var(--accent);">${esc(org)}</a>` : ""}${city ? ` à <a href="/ville/${slugify(city)}.html" style="color:var(--accent);">${esc(city)}</a>` : ""}.`);
              if (priceWithFees) contextParts.push(`Soit ${isRealRate ? "" : "environ "}<strong>${formatPrice(priceWithFees)} € frais de vente inclus</strong> (${isRealRate ? `taux de ${realRate}% appliqué par la maison de vente` : "estimation basée sur un taux moyen de 25%"}).`);
              if (est.min != null) contextParts.push(`L'estimation de cet objet était comprise entre <strong>${formatPrice(est.min)} €</strong> et <strong>${formatPrice(est.max)} €</strong>.`);
              if (saleName) contextParts.push(`Il faisait partie de la vente « ${esc(saleName)} ».`);
              if (item._withdrawal) contextParts.push(`<strong>Enlèvement :</strong> ${esc(item._withdrawal.substring(0, 200))}.`);

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
              <tr><td>Date</td><td>${dateFr(saleDate)}</td></tr>
              ${org ? `<tr><td>Maison de vente</td><td><a href="/maison/${orgSlug}.html">${esc(org)}</a>${city ? ` — <a href="/ville/${slugify(city)}.html">${esc(city)}</a>` : ""}</td></tr>` : ""}
              ${saleName ? `<tr><td>Vente</td><td>${esc(saleName)}</td></tr>` : ""}
            </table>

            ${item._aiTags?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:1rem;">
              ${item._aiTags.map(tag => `<span style="background:var(--accent-glow);color:var(--accent2);padding:4px 12px;border-radius:20px;font-size:0.78rem;font-weight:500;border:1px solid var(--border2);">${esc(tag)}</span>`).join("")}
            </div>` : ""}
          </div>
        </div>

        ${vehicleSpecsHtml(item._aiSpecs || extractVehicleSpecs(rawDesc, catName))}

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
                ${saleDate ? ` le ${dateFr(saleDate)}` : ""}${org ? ` chez <a href="/maison/${orgSlug}.html" style="color:var(--accent);">${esc(org)}</a>` : ""}${city ? ` à <a href="/ville/${slugify(city)}.html" style="color:var(--accent);">${esc(city)}</a>` : ""}.
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
          const faqTitle = shortTitle.length > 5 ? shortTitle : "cet objet";
          const faqs = [];
          if (priceVal > 0) faqs.push({
            q: `Combien a été vendu « ${faqTitle} » aux enchères ?`,
            a: `Ce lot a été adjugé ${formatPrice(priceVal)} € aux enchères${org ? ` chez ${org}` : ""}${city ? ` à ${city}` : ""}${saleDate ? ` le ${dateFr(saleDate)}` : ""}.${priceWithFees ? ` Soit environ ${formatPrice(priceWithFees)} € frais de vente inclus (estimation).` : ""}${est.min != null ? ` L'estimation initiale était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €.` : ""}`
          });
          else if (!auc.sold) faqs.push({
            q: `Peut-on encore acheter « ${faqTitle} » ?`,
            a: `Ce lot n'a pas trouvé preneur lors de la vente aux enchères${saleDate ? ` du ${dateFr(saleDate)}` : ""}. Il est possible qu'il soit encore disponible.${org ? ` Contactez directement ${org}${city ? ` à ${city}` : ""} pour vérifier la disponibilité et négocier le prix.` : ""}`
          });
          if (est.min != null) faqs.push({
            q: `Quelle était l'estimation de « ${faqTitle} » ?`,
            a: `L'estimation de ce lot était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €.${!auc.sold ? " N'ayant pas été vendu, il est possible de l'acquérir en dessous de l'estimation basse en contactant directement la maison de vente." : priceVal > est.max ? ` Le prix final (${formatPrice(priceVal)} €) a dépassé l'estimation haute, signe d'un fort intérêt des enchérisseurs.` : ""}`
          });
          if (org && city) faqs.push({
            q: `Comment contacter ${org} ?`,
            a: `${org} est une maison de vente aux enchères située à ${city}.${!auc.sold ? " Vous pouvez les contacter pour négocier l'achat de ce lot invendu." : " Retrouvez tous leurs résultats de ventes sur Adjugé !"}`
          });
          // Additional contextual FAQs
          if (catName) faqs.push({
            q: `Comment acheter des ${catName.toLowerCase()} aux enchères ?`,
            a: `Pour acheter des ${catName.toLowerCase()} aux enchères en France, consultez les ventes à venir dans votre région. Les enchères publiques sont ouvertes à tous, en salle ou en ligne. Inscrivez-vous sur le site de la maison de vente, fixez-vous un budget maximum et n'oubliez pas d'ajouter les frais acheteur (environ 20 à 30%) au prix d'adjudication.`
          });
          if (priceVal > 0 && catName) faqs.push({
            q: `Quel est le prix moyen d'un lot ${catName.toLowerCase()} aux enchères ?`,
            a: `Le prix d'un lot ${catName.toLowerCase()} aux enchères varie considérablement selon la qualité, la rareté et la provenance. Ce lot a été adjugé ${formatPrice(priceVal)} €. Sur Adjugé !, retrouvez des milliers de résultats pour comparer les prix et estimer la valeur d'objets similaires.`
          });
          if (priceVal > 0) faqs.push({
            q: `Quel est le prix d'occasion de « ${faqTitle} » ?`,
            a: `Sur le marché de la seconde main, ce type d'objet a été adjugé ${formatPrice(priceVal)} € aux enchères publiques${priceWithFees ? ` (soit ~${formatPrice(priceWithFees)} € frais inclus)` : ""}. Les enchères sont un excellent moyen d'estimer la valeur d'occasion d'un objet — les prix reflètent la demande réelle du marché.`
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
  // Natural French FAQ — adapt article/preposition to category name
  const startsWithVowel = /^[aeéèêiîoôuùûyh]/i.test(catName);
  const artDe = startsWithVowel ? `d'${catName}` : `de ${catName}`;
  const artUn = startsWithVowel ? `un objet ${catName}` : `un lot de ${catName}`;
  const catFaqQuestions = [
    { q: `Combien coûte ${artUn} aux enchères en France ?`, a: `Sur ${data.items.length} lots ${artDe} vendus aux enchères, le prix moyen constaté est de ${formatPrice(avgPrice)} €. Le record observé atteint ${formatPrice(maxPrice)} €.` },
    { q: `Où acheter ${artDe} aux enchères ?`, a: `Adjugé ! recense ${data.items.length} lots ${artDe} vendus aux enchères dans toute la France, avec photos, prix adjugés et estimations.` },
    { q: `Le marché ${artDe} est-il dynamique aux enchères ?`, a: `La catégorie ${catName} totalise ${formatPrice(totalPrice)} € de ventes pour ${data.items.length} lots, soit un prix moyen de ${formatPrice(avgPrice)} €.` },
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
    ${data.parentName ? `${esc(data.parentName)} ›` : ""}
    ${esc(catName)}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${esc(catName)} aux enchères</h1>
            ${catDesc ? `<p style="color:var(--text2);font-size:0.9rem;line-height:1.7;margin-bottom:1rem;">${esc(catDesc)}</p>` : ""}

            <!-- Factual synthesis (TASK 9) -->
            <p style="color:var(--text);font-size:0.95rem;line-height:1.7;margin-bottom:1rem;background:var(--accent-glow);padding:1rem;border-radius:var(--radius-sm);border-left:3px solid var(--accent);">
              Au ${todayFr()}, la catégorie <strong>${esc(catName)}</strong> compte <strong>${formatPrice(data.items.length)}</strong> lots vendus pour <strong>${formatPrice(totalPrice)} €</strong>. Le record est de <strong>${formatPrice(maxPrice)} €</strong>${recordLotTitle ? ` pour ${esc(recordLotTitle)}` : ""}.
            </p>

            <!-- Dynamic stats paragraph -->
            <p style="color:var(--text2);font-size:0.88rem;line-height:1.6;margin-bottom:1rem;">
              La catégorie <strong>${esc(catName)}</strong> compte <strong>${formatPrice(data.items.length)}</strong> lots vendus pour un total de <strong>${formatPrice(totalPrice)} €</strong>, avec un prix moyen de <strong>${formatPrice(avgPrice)} €</strong>.${maxPrice > 0 ? ` Record : <strong>${formatPrice(maxPrice)} €</strong>.` : ""}
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
    <a href="/jour/${saleDate}.html">${dateShortFr(saleDate)}</a> ›
    Vente ${saleId}
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-body">
            <h1 style="font-size:1.3rem;margin-bottom:0.5rem;">${esc(data.saleName)}</h1>
            <p style="color:var(--text2);"><a href="/maison/${slugify(data.org)}.html">${esc(data.org)}</a> · ${esc(data.city)} · ${dateFr(saleDate)}</p>
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

  // Group categories by parent using CATEGORY_TAXONOMY
  const grouped = new Map();
  for (const [parentSlug, parentData] of Object.entries(CATEGORY_TAXONOMY)) {
    grouped.set(parentSlug, { name: parentData.name, items: [] });
  }

  for (const [slug, c] of cats) {
    const parentSlug = c.parent || "divers-nature";
    if (!grouped.has(parentSlug)) grouped.set(parentSlug, { name: getParentName(parentSlug) || "Divers", items: [] });
    grouped.get(parentSlug).items.push([slug, c]);
  }

  // Remove empty groups
  for (const [key, val] of grouped) {
    if (val.items.length === 0) grouped.delete(key);
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

  return `${htmlHead("Catégories d'enchères en France — Tous les résultats | Adjugé !", `${cats.length} catégories de ventes aux enchères en France. ${formatPrice(totalLots)} lots vendus pour ${formatPrice(totalPrice)} €. Consultez prix, photos et résultats.`, "", "/categories.html")}
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

    ${[...grouped.entries()].map(([parentSlug, group]) => `
      <div style="margin-bottom:2rem;">
        <h2 class="text-lg font-semibold mb-4 flex items-center gap-2 text-[var(--text)]">
          <span class="w-1 h-6 bg-[var(--accent)] rounded-full"></span>
          ${esc(group.name)} <span class="text-xs font-normal text-[var(--text3)]">(${group.items.reduce((s, [, c]) => s + c.items.length, 0)} lots)</span>
        </h2>
        <div class="lot-grid">
          ${group.items.sort((a, b) => b[1].items.length - a[1].items.length).map(([slug, c]) => catCard(slug, c)).join("\n          ")}
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
  return `${htmlHead("Maisons de vente", "Liste des maisons de vente aux enchères", "", "/maisons.html")}
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
  const rawDescOriginal = item.description || item.title_translations?.["fr-FR"] || "Objet";
  const rawDesc = cleanRawDesc(rawDescOriginal);
  const fallbackTitle = extractTitle(rawDesc);
  const lines = rawDesc.split("\n").map(l => l.trim()).filter(Boolean);
  const descLines = lines.filter(l => cleanTitleLine(l) !== fallbackTitle);
  const lotTitle = item._aiTitle || fallbackTitle;
  const lotDesc = item._aiDesc || descLines.join(" ").trim();
  const est = item.pricing?.estimates || {};
  const org = item.organization?.names?.voluntary || item.organization?.names?.judicial || "";
  const orgSlug = slugify(org);
  const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
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
  <div class="breadcrumb" style="display:flex;align-items:center;gap:0.5rem;">
    <a href="javascript:history.back()" style="text-decoration:none;font-size:1.2rem;color:var(--accent);" title="Retour">←</a>
    <span><a href="/index.html">Accueil</a> ›
    <a href="/invendus.html">Invendus</a> ›
    ${esc(lotTitle)}</span>
  </div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="container">
    <div class="grid-2">
      <main>
        <div class="card">
          ${medias.length > 0 ? `<div style="background:#111;padding:1rem;border-radius:var(--radius) var(--radius) 0 0;">
            <div style="display:flex;justify-content:center;">
              <img id="mainImg" src="${esc(imgUrl(medias[0], "lg"))}" alt="${esc(lotTitle)}" style="max-height:400px;max-width:100%;object-fit:contain;border-radius:var(--radius-sm);cursor:${medias.length > 1 ? "pointer" : "default"};">
            </div>
            ${medias.length > 1 ? `<div style="display:flex;gap:8px;margin-top:10px;overflow-x:auto;padding:4px 0;">
              ${medias.map((m, i) => `<img src="${esc(imgUrl(m, "sm"))}" data-lg="${esc(imgUrl(m, "lg"))}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid ${i === 0 ? "var(--accent)" : "transparent"};opacity:${i === 0 ? "1" : "0.6"};" onclick="document.getElementById('mainImg').src=this.dataset.lg;this.parentNode.querySelectorAll('img').forEach(function(x){x.style.border='2px solid transparent';x.style.opacity='0.6';});this.style.border='2px solid var(--accent)';this.style.opacity='1';">`).join("")}
            </div>` : ""}
          </div>` : ""}
          <div class="card-body">
            <div style="display:inline-block;background:var(--red-bg);color:var(--red);padding:4px 12px;border-radius:20px;font-size:0.82rem;font-weight:700;margin-bottom:0.8rem;">Invendu</div>
            <h1 style="font-size:1.4rem;margin-bottom:0.5rem;line-height:1.4;overflow-wrap:break-word;">${esc(lotTitle)}</h1>
            ${(() => {
              const descParas = [];
              if (lotDesc) descParas.push(`<p style="margin-bottom:0.8rem;">${esc(lotDesc)}</p>`);
              descParas.push(`<p style="margin-bottom:0.8rem;">Ce lot${catName ? ` de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a>` : ""} n'a pas trouvé preneur lors de la vente aux enchères${saleDate ? ` du ${dateFr(saleDate)}` : ""}${org ? ` organisée par <a href="/maison/${orgSlug}.html" style="color:var(--accent);">${esc(org)}</a>` : ""}${city ? ` à <a href="/ville/${slugify(city)}.html" style="color:var(--accent);">${esc(city)}</a>` : ""}.</p>`);
              if (est.min != null) descParas.push(`<p style="margin-bottom:0.8rem;">Son estimation était comprise entre <strong>${formatPrice(est.min)} €</strong> et <strong>${formatPrice(est.max)} €</strong>. Les invendus peuvent souvent être acquis en dessous de l'estimation basse — une opportunité à saisir.</p>`);
              descParas.push(`<p style="margin-bottom:0.8rem;">💡 <strong>Cet objet vous intéresse ?</strong> Il est peut-être encore disponible. Contactez directement la maison de vente pour connaître sa disponibilité et négocier un prix avantageux. Les lots invendus aux enchères représentent souvent d'excellentes opportunités d'achat.</p>`);
              if (catName) descParas.push(`<p style="margin-bottom:0.8rem;">Retrouvez tous les invendus de la catégorie <a href="/categorie/${catSlug}.html" style="color:var(--accent);">${esc(catName)}</a> et d'autres bonnes affaires sur <a href="/invendus.html" style="color:var(--accent);">notre page Invendus</a>.</p>`);
              return `<div style="color:var(--text);font-size:0.95rem;line-height:1.8;margin-bottom:0.8rem;overflow-wrap:break-word;max-width:100%;">${descParas.join("")}</div>`;
            })()}
            ${est.min != null ? `<div style="margin:0.8rem 0;">
              <span style="font-size:1.3rem;font-weight:700;color:var(--text);">Estimation : ${formatPrice(est.min)} – ${formatPrice(est.max)} €</span>
            </div>` : ""}
            ${adSlot("inArticle")}
            <table class="meta-table">
              ${catSlug ? `<tr><td>Catégorie</td><td><a href="/categorie/${catSlug}.html">${esc(catName)}</a></td></tr>` : ""}
              <tr><td>Date</td><td>${dateFr(saleDate)}</td></tr>
              ${org ? `<tr><td>Maison</td><td><a href="/maison/${orgSlug}.html">${esc(org)}</a>${city ? ` · <a href="/ville/${slugify(city)}.html">${esc(city)}</a>` : ""}</td></tr>` : ""}
            </table>
          </div>
        </div>

        ${vehicleSpecsHtml(item._aiSpecs || extractVehicleSpecs(rawDesc, catName))}

        ${(() => {
          const DEAL_LABELS = ["Sans intérêt", "Bonne affaire", "Super affaire", "Affaire exceptionnelle"];
          const DEAL_ICONS = ["⚪", "🟢", "🔵", "🔥"];
          const DEAL_COLORS = ["var(--text3)", "#22c55e", "#3b82f6", "#f59e0b"];
          const estL = item.pricing?.estimates?.low || item.pricing?.estimates?.min || 0;
          const estH = item.pricing?.estimates?.max || 0;
          const spU = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
          const nPh = item.medias?.length || 0;
          // Deal score: only trust AI score, heuristic max = 1
          let ds = 0;
          if (item._aiDealScore >= 0) {
            ds = item._aiDealScore;
          } else if (spU > 0 && estL > 0 && spU < estL * 0.5) {
            ds = 1; // mise à prix nettement sous l'estimation
          }
          // Build explanation if no AI analysis
          let explanation = item._aiDealAnalysis || "";
          if (!explanation) { // unsold page — always build explanation
            const reasons = [];
            if (estH > 0) reasons.push(`estimation de ${formatPrice(estL)} à ${formatPrice(estH)} €`);
            if (spU > 0 && estL > 0 && spU < estL * 0.5) reasons.push(`mise à prix (${formatPrice(spU)} €) nettement inférieure à l'estimation`);
            else if (spU > 0) reasons.push(`mise à prix de ${formatPrice(spU)} €`);
            if (nPh >= 3) reasons.push(`${nPh} photos disponibles`);
            if (ds === 0) explanation = "Ce lot n'a pas de caractéristiques particulières qui en font une bonne affaire.";
            else if (reasons.length) explanation = `Score basé sur : ${reasons.join(", ")}.`;
          }
          if (!explanation) return ""; // Don't show deal block without explanation
          return `<div class="card" style="border-left:4px solid ${DEAL_COLORS[ds]};">
          <div class="card-header" style="display:flex;align-items:center;gap:0.6rem;">
            <span style="font-size:1.3rem;">${DEAL_ICONS[ds]}</span>
            <h3 style="font-size:1rem;margin:0;">${DEAL_LABELS[ds]}</h3>
            ${ds >= 2 ? `<span style="background:${DEAL_COLORS[ds]};color:${ds === 3 ? "#000" : "#fff"};font-size:0.7rem;font-weight:800;padding:2px 10px;border-radius:4px;">${ds === 3 ? "TOP AFFAIRE" : "RECOMMANDÉ"}</span>` : ""}
          </div>
          <div class="card-body">
            <p style="color:var(--text);font-size:0.92rem;line-height:1.7;margin-bottom:0.5rem;">${esc(explanation)}</p>
            ${item._aiPriceAnalysis ? `<p style="color:var(--text2);font-size:0.85rem;line-height:1.6;font-style:italic;">📊 ${esc(item._aiPriceAnalysis)}</p>` : ""}
          </div>
        </div>`;
        })()}

        ${item._aiFaq?.length ? `<div class="card">
          <div class="card-header"><h3 style="font-size:1rem;">❓ Questions fréquentes</h3></div>
          <div class="card-body">
            ${item._aiFaq.map(({ q, a }) => `<details style="margin-bottom:0.8rem;border-bottom:1px solid var(--border);padding-bottom:0.8rem;" open>
              <summary style="cursor:pointer;font-weight:600;color:var(--text);font-size:0.92rem;padding:0.3rem 0;">${esc(q || "")}</summary>
              <p style="color:var(--text);margin-top:0.5rem;font-size:0.88rem;line-height:1.6;">${esc(a || "")}</p>
            </details>`).join("")}
          </div>
        </div>` : (() => {
          const faqTitle = lotTitle.length > 5 ? lotTitle : "cet objet";
          const faqs = [];
          faqs.push({
            q: `Peut-on encore acheter « ${faqTitle} » ?`,
            a: `Ce lot n'a pas trouvé preneur lors de la vente aux enchères${saleDate ? ` du ${dateFr(saleDate)}` : ""}. Il est possible qu'il soit encore disponible. Contactez directement ${org || "la maison de vente"}${city ? ` à ${city}` : ""} pour connaître sa disponibilité et négocier un prix.`
          });
          if (est.min != null) faqs.push({
            q: `Quelle était l'estimation de « ${faqTitle} » ?`,
            a: `L'estimation de ce lot était de ${formatPrice(est.min)} à ${formatPrice(est.max)} €. N'ayant pas trouvé preneur, il est envisageable de l'acquérir en dessous de l'estimation basse en contactant directement la maison de vente.`
          });
          if (org && city) faqs.push({
            q: `Comment contacter ${org} pour ce lot ?`,
            a: `${org} est une maison de vente aux enchères située à ${city}. Vous pouvez les contacter pour vous renseigner sur la disponibilité de « ${faqTitle} » et négocier un prix d'achat.`
          });
          // Additional contextual FAQs for unsold lots
          faqs.push({
            q: `Comment négocier le prix d'un lot invendu aux enchères ?`,
            a: `Lorsqu'un lot ne trouve pas preneur en salle, il est souvent possible de l'acquérir après la vente en contactant directement la maison de vente. Le prix de départ est généralement la mise à prix ou l'estimation basse. N'hésitez pas à faire une offre raisonnable — les vendeurs sont souvent ouverts à la négociation pour écouler les invendus.`
          });
          if (catName) faqs.push({
            q: `Où trouver des ${catName.toLowerCase()} aux enchères en France ?`,
            a: `Adjugé ! référence des milliers de lots de ${catName.toLowerCase()} vendus et invendus aux enchères en France. Consultez notre catégorie dédiée pour comparer les prix, voir les photos et identifier les bonnes affaires parmi les invendus.`
          });
          faqs.push({
            q: `Quel est le prix d'occasion de « ${faqTitle} » ?`,
            a: `Cet objet n'ayant pas trouvé preneur aux enchères${est.min != null ? ` malgré une estimation de ${formatPrice(est.min)} à ${formatPrice(est.max)} €` : ""}, il est possible de l'acquérir à un prix avantageux sur le marché de la seconde main. Contactez la maison de vente pour connaître le prix actuel et négocier.`
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
            ${item._saleContact?.email || item._saleContact?.phone ? `<div style="background:var(--green-bg);border:1px solid var(--green);border-radius:10px;padding:12px 16px;margin-bottom:0.8rem;">
              <div style="font-size:0.82rem;color:var(--green);font-weight:700;margin-bottom:4px;">Contact direct de la vente${item._saleContact.name ? ` — ${esc(item._saleContact.name)}` : ""}</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.8rem;">
                ${item._saleContact.phone ? `<a href="tel:${esc(item._saleContact.phone)}" style="color:var(--green);font-weight:700;text-decoration:none;">📞 ${esc(item._saleContact.phone)}</a>` : ""}
                ${item._saleContact.email ? `<a href="mailto:${esc(item._saleContact.email)}?subject=${encodeURIComponent("Lot invendu : " + lotTitle)}" style="color:var(--accent2);font-weight:600;text-decoration:none;">✉️ ${esc(item._saleContact.email)}</a>` : ""}
              </div>
            </div>` : ""}
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

function unsoldLotCard(item, sale) {
  const rawD = cleanRawDesc(item.description || item.title_translations?.["fr-FR"] || "");
  const title = item._aiTitle || extractTitle(rawD);
  const est = item.pricing?.estimates || {};
  const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
  const catName = item.category?.name || "";
  const saleDate = sale?.datetime ? sale.datetime.substring(0, 10) : "";
  const dateDisplay = dateShortFr(saleDate);
  return `<a href="/lot/${lotSlug(item)}.html" class="lot-card">
    ${thumb ? `<img src="${esc(thumb)}" alt="${esc(title)}" loading="lazy">` : `<div class="no-img">📦</div>`}
    <div class="lot-info">
      <div class="lot-title">${esc(title)}</div>
      ${est.min != null ? `<div style="font-weight:700;color:#e67e22;font-size:0.88rem;">Est. ${formatPrice(est.min)} – ${formatPrice(est.max)} €</div>` : ""}
      <div style="font-size:0.75rem;color:var(--red);font-weight:600;">Invendu</div>
      ${dateDisplay ? `<div style="color:var(--text3);font-size:0.7rem;margin-top:2px;">Présenté en vente le ${dateDisplay}</div>` : ""}
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
    const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
    const coords = cityToCoords(city);
    const nPhotos = item.medias?.length || 0;
    // Deal score: only trust AI score or strong heuristic signals
    // Without market price data, we can NOT know if it's a good deal
    // Heuristic max = 1 (conservative), only AI can give 2 or 3
    let deal = 0;
    if (item._aiDealScore >= 0) {
      deal = item._aiDealScore;
    } else {
      // Only "Bonne affaire" (1) when starting price is well below estimation
      if (startPrice > 0 && estLow > 0 && startPrice < estLow * 0.5) {
        deal = 1; // mise à prix nettement sous l'estimation = signal d'affaire
      }
    }
    const dealText = item._aiDealAnalysis || "";
    return { s: lotSlug(item), t: title, i: thumb, c: cat, el: estLow, eh: estHigh, sp: startPrice, d: date, v: city, ba: deal, da: dealText, ...(coords ? { lat: coords[0], lng: coords[1] } : {}) };
  });

  const metaDesc = `${unsoldItems.length} lots invendus aux enchères. Filtrez par catégorie et contactez les maisons de vente pour négocier.`;

  // Build city aggregates for map markers (group by city to avoid 12K markers)
  const cityAgg = new Map();
  for (const d of unsoldData) {
    if (!d.lat || !d.v) continue;
    const key = d.v;
    if (!cityAgg.has(key)) cityAgg.set(key, { v: d.v, lat: d.lat, lng: d.lng, n: 0 });
    cityAgg.get(key).n++;
  }
  const mapCities = JSON.stringify([...cityAgg.values()]);

  return `${htmlHead("Lots invendus aux enchères — À négocier | Adjugé !", metaDesc, "", "/invendus.html")}
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<style>
#unsoldMap{height:400px;border-radius:12px;border:1px solid var(--border);margin-bottom:1rem;z-index:1;}
#unsoldMap.hidden{display:none;}
.map-toggle{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:var(--surface3);border:1px solid var(--border2);color:var(--text);cursor:pointer;font-size:0.85rem;font-family:inherit;}
.map-toggle:hover{background:var(--surface2);}
.map-toggle.active{background:var(--accent);color:#fff;border-color:var(--accent);}
.geo-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:var(--accent);border:none;color:#fff;cursor:pointer;font-size:0.85rem;font-family:inherit;}
.geo-btn:hover{opacity:0.9;}
.leaflet-popup-content{color:#1a1a2e;font-family:system-ui;}
</style>
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
              <select id="unsoldDate" style="background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 12px;border-radius:8px;font-size:0.85rem;font-family:inherit;outline:none;">
                <option value="">Toutes dates</option>
                <option value="1">Aujourd'hui</option>
                <option value="3">3 derniers jours</option>
                <option value="7">Cette semaine</option>
                <option value="30">Ce mois</option>
              </select>
              <select id="unsoldSort" style="background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 12px;border-radius:8px;font-size:0.85rem;font-family:inherit;outline:none;">
                <option value="recent">Plus récents</option>
                <option value="deal">Meilleures affaires</option>
                <option value="price-desc">Estimation décroissante</option>
                <option value="price-asc">Estimation croissante</option>
              </select>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;">
              <button class="map-toggle active" id="mapToggle" onclick="toggleMap()">🗺️ Carte</button>
              <button class="geo-btn" id="geoBtn" onclick="geolocate()">📍 Près de chez moi</button>
            </div>
            <div id="unsoldMap"></div>
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
      var DEAL_LABELS = ['', '🟢 Bonne affaire', '🔵 Super affaire', '🔥 Affaire exceptionnelle'];
      var DEAL_COLORS = ['', '#22c55e', '#3b82f6', '#f59e0b'];
      batch.forEach(function(d) {
        var est = d.el && d.eh ? 'Est. ' + d.el.toLocaleString('fr-FR') + ' – ' + d.eh.toLocaleString('fr-FR') + ' €' : '';
        var sp = d.sp ? 'Mise à prix : ' + d.sp.toLocaleString('fr-FR') + ' €' : '';
        var dealBadge = d.ba > 0 ? '<div style="font-size:0.72rem;font-weight:700;color:' + DEAL_COLORS[d.ba] + ';padding:2px 0;">' + DEAL_LABELS[d.ba] + '</div>' : '';
        grid.innerHTML += '<a href="/lot/' + d.s + '.html" class="lot-card" style="text-decoration:none;position:relative;" onclick="saveState()">'
          + (d.ba === 3 ? '<div style="position:absolute;top:8px;right:8px;background:#f59e0b;color:#000;font-size:0.65rem;font-weight:800;padding:2px 8px;border-radius:4px;z-index:1;">🔥 TOP</div>' : '')
          + (d.i ? '<img src="' + d.i + '" alt="" loading="lazy">' : '<div style="height:160px;background:var(--surface3);display:flex;align-items:center;justify-content:center;color:var(--text3);">📷</div>')
          + '<div class="lot-info">' + dealBadge + '<div class="lot-title">' + d.t + '</div>'
          + (est ? '<div style="color:var(--accent2);font-weight:700;font-size:0.85rem;">' + est + '</div>' : '')
          + (sp ? '<div style="color:var(--text2);font-size:0.78rem;">' + sp + '</div>' : '')
          + '<div style="color:var(--red);font-weight:600;font-size:0.78rem;">Invendu</div>'
          + (d.da ? '<div style="color:var(--text2);font-size:0.72rem;margin-top:4px;line-height:1.4;border-left:2px solid ' + DEAL_COLORS[d.ba] + ';padding-left:6px;">' + d.da.substring(0, 120) + (d.da.length > 120 ? '…' : '') + '</div>' : '')
          + (d.d ? '<div style="color:var(--text3);font-size:0.7rem;margin-top:2px;">📅 Présenté le ' + d.d.split('-').reverse().join('/') + '</div>' : '')
          + (d.v ? '<div style="color:var(--text3);font-size:0.7rem;">📍 ' + d.v + '</div>' : '')
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
      var days = parseInt(document.getElementById('unsoldDate').value) || 0;
      var minDate = '';
      if (days > 0) {
        var dd = new Date(); dd.setDate(dd.getDate() - days + 1);
        minDate = dd.toISOString().substring(0, 10);
      }
      // If activeCity from URL hash, filter by city instead of resetting
      if (activeCity) {
        filtered = DATA.filter(function(d) { return d.v === activeCity; });
        filtered.sort(function(a,b) { return (b.d||'').localeCompare(a.d||''); });
        render(filtered, false);
        countEl.textContent = filtered.length + ' invendu' + (filtered.length > 1 ? 's' : '') + ' à ' + activeCity;
        return;
      }
      filtered = DATA.filter(function(d) {
        if (cat && d.c !== cat) return false;
        if (q && d.t.toLowerCase().indexOf(q) === -1) return false;
        if (minDate && d.d < minDate) return false;
        return true;
      });
      if (sort === 'deal') filtered.sort(function(a,b) { return (b.ba||0) - (a.ba||0) || (b.eh||0) - (a.eh||0); });
      else if (sort === 'price-desc') filtered.sort(function(a,b) { return (b.eh||0) - (a.eh||0); });
      else if (sort === 'price-asc') filtered.sort(function(a,b) { return (a.eh||0) - (b.eh||0); });
      else filtered.sort(function(a,b) { return (b.d||'').localeCompare(a.d||''); });
      render(filtered, false);
    }

    // ─── URL hash ↔ filter state persistence ───────────
    window.saveState = function() {
      var params = {};
      var q = document.getElementById('unsoldSearch').value;
      var cat = document.getElementById('unsoldCat').value;
      var sort = document.getElementById('unsoldSort').value;
      var days = document.getElementById('unsoldDate').value;
      if (q) params.q = q;
      if (cat) params.cat = cat;
      if (sort && sort !== 'recent') params.sort = sort;
      if (days) params.days = days;
      if (activeCity) params.city = activeCity;
      // Save scroll position + number of items shown
      params.n = shown;
      var hash = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
      history.replaceState(null, '', hash ? '#' + hash : location.pathname);
      // Also save scroll Y in sessionStorage (hash can't hold it reliably)
      try { sessionStorage.setItem('unsold_scrollY', window.scrollY); } catch(e) {}
    };
    // Save state on any scroll (debounced)
    var scrollTimer;
    window.addEventListener('scroll', function() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function() {
        try { sessionStorage.setItem('unsold_scrollY', window.scrollY); } catch(e) {}
      }, 200);
    });

    function restoreState() {
      var hash = location.hash.replace(/^#/, '');
      if (!hash) return false;
      var params = {};
      hash.split('&').forEach(function(p) { var kv = p.split('='); if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]); });
      if (params.q) document.getElementById('unsoldSearch').value = params.q;
      if (params.cat) document.getElementById('unsoldCat').value = params.cat;
      if (params.sort) document.getElementById('unsoldSort').value = params.sort;
      if (params.days) document.getElementById('unsoldDate').value = params.days;
      if (params.city) activeCity = params.city;
      return params;
    }
    var restored = restoreState();

    document.getElementById('unsoldSearch').addEventListener('input', function() { applyFilters(); saveState(); });
    document.getElementById('unsoldCat').addEventListener('change', function() { applyFilters(); saveState(); });
    document.getElementById('unsoldDate').addEventListener('change', function() { applyFilters(); saveState(); });
    document.getElementById('unsoldSort').addEventListener('change', function() { applyFilters(); saveState(); });
    window.addEventListener('popstate', function() { restoreState(); applyFilters(); });
    applyFilters();
    // Restore scroll position: load enough items then scroll back
    if (restored && restored.n) {
      var targetN = parseInt(restored.n) || 0;
      while (shown < targetN && shown < filtered.length) {
        render(filtered, true);
      }
      setTimeout(function() {
        var savedY = 0;
        try { savedY = parseInt(sessionStorage.getItem('unsold_scrollY')) || 0; } catch(e) {}
        if (savedY > 0) window.scrollTo(0, savedY);
      }, 100);
    }

    // ─── Map ──────────────────────────────────────────
    var CITIES = ${mapCities};
    var map = null, markers = [], mapVisible = true, activeCity = '';

    function initMap() {
      if (map) return;
      map = L.map('unsoldMap').setView([46.6, 2.5], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 18
      }).addTo(map);

      CITIES.forEach(function(c) {
        var m = L.circleMarker([c.lat, c.lng], {
          radius: Math.min(5 + Math.sqrt(c.n) * 2, 25),
          fillColor: '#a78bfa',
          color: '#7c5cfc',
          weight: 1.5,
          opacity: 0.9,
          fillOpacity: 0.6
        }).addTo(map);
        m.bindPopup('<strong>' + c.v + '</strong><br>' + c.n + ' invendu' + (c.n > 1 ? 's' : '') + '<br><a href="#" onclick="filterByCity(\\'' + c.v.replace(/'/g, "\\\\'") + '\\');return false;" style="color:#7c5cfc;font-weight:600;">Voir les lots →</a>');
        m._cityName = c.v;
        markers.push(m);
      });
    }

    window.filterByCity = function(city) {
      activeCity = city;
      document.getElementById('unsoldSearch').value = '';
      document.getElementById('unsoldCat').value = '';
      filtered = DATA.filter(function(d) { return d.v === city; });
      filtered.sort(function(a,b) { return (b.d||'').localeCompare(a.d||''); });
      render(filtered, false);
      countEl.textContent = filtered.length + ' invendu' + (filtered.length > 1 ? 's' : '') + ' à ' + city;
      saveState();
      // Scroll to grid
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    window.toggleMap = function() {
      var el = document.getElementById('unsoldMap');
      var btn = document.getElementById('mapToggle');
      mapVisible = !mapVisible;
      if (mapVisible) {
        el.classList.remove('hidden');
        btn.classList.add('active');
        btn.textContent = '🗺️ Carte';
        if (!map) initMap();
        else map.invalidateSize();
      } else {
        el.classList.add('hidden');
        btn.classList.remove('active');
        btn.textContent = '🗺️ Carte';
      }
    };

    window.geolocate = function() {
      var btn = document.getElementById('geoBtn');
      btn.textContent = '📍 Localisation...';
      if (!mapVisible) { toggleMap(); }
      if (!map) initMap();
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(pos) {
          var lat = pos.coords.latitude, lng = pos.coords.longitude;
          map.setView([lat, lng], 10);
          L.marker([lat, lng], {
            icon: L.divIcon({ className: '', html: '<div style="background:#34d399;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.3);"></div>', iconSize: [14,14], iconAnchor: [7,7] })
          }).addTo(map).bindPopup('📍 Vous êtes ici').openPopup();
          btn.textContent = '📍 Près de chez moi';
          // Also filter grid to nearby items (within ~50km)
          filtered = DATA.filter(function(d) {
            if (!d.lat) return false;
            var dlat = d.lat - lat, dlng = d.lng - lng;
            return (dlat*dlat + dlng*dlng) < 0.25; // ~50km radius
          });
          filtered.sort(function(a,b) { return (b.d||'').localeCompare(a.d||''); });
          render(filtered, false);
          countEl.textContent = filtered.length + ' invendu' + (filtered.length > 1 ? 's' : '') + ' près de chez vous';
        }, function() {
          btn.textContent = '📍 Près de chez moi';
          alert('Impossible de vous localiser. Vérifiez les autorisations de votre navigateur.');
        });
      }
    };

    // Init map on load
    initMap();
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

  // ── Ratio mise à prix → prix vendu ────────────────────────────────
  const withStartAndSold = allValues.filter(({ item }) => {
    const sp = item.pricing?.starting_price || item.pricing?.reserve_price || 0;
    const price = item.pricing?.auctioned?.price || 0;
    return sp > 0 && price > 0;
  });
  const ratioCount = withStartAndSold.length;
  const ratios = withStartAndSold.map(({ item }) => {
    const sp = item.pricing?.starting_price || item.pricing?.reserve_price;
    const price = item.pricing?.auctioned?.price;
    return { ratio: price / sp, sp, price, item };
  });
  const avgRatio = ratioCount ? (ratios.reduce((s, r) => s + r.ratio, 0) / ratioCount).toFixed(1) : "–";
  const medianRatio = ratioCount ? ratios.sort((a, b) => a.ratio - b.ratio)[Math.floor(ratioCount / 2)].ratio.toFixed(1) : "–";
  const aboveEstCount = allValues.filter(({ item }) => {
    const price = item.pricing?.auctioned?.price || 0;
    const estHigh = item.pricing?.estimates?.max || 0;
    return price > 0 && estHigh > 0 && price > estHigh;
  }).length;
  const withEstCount = allValues.filter(({ item }) => (item.pricing?.estimates?.max || 0) > 0 && (item.pricing?.auctioned?.price || 0) > 0).length;
  const aboveEstPct = withEstCount ? Math.round(aboveEstCount / withEstCount * 100) : 0;
  // Top surprises: biggest multipliers
  const topSurprises = ratios.sort((a, b) => b.ratio - a.ratio).slice(0, 5).map(r => ({
    slug: lotSlug(r.item),
    title: r.item._aiTitle || cleanTitleLine((r.item.description || r.item.title_translations?.["fr-FR"] || "").split("\n")[0] || "Objet"),
    sp: r.sp,
    price: r.price,
    ratio: r.ratio.toFixed(1),
    thumb: r.item.medias?.[0] ? imgUrl(r.item.medias[0], "lg") : "",
  }));

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
<body class="dark">
  ${navHtml()}
  ${adSlot("header", "padding: 0.5rem 2rem;")}

  <!-- Hero -->
  <section class="relative overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-b from-purple-900/20 via-[var(--bg)]/50 to-[var(--bg)]"></div>
    <div class="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1600&q=80')] bg-cover bg-center opacity-10"></div>
    <div class="relative max-w-6xl mx-auto px-6 py-16 md:py-20">
      <div class="max-w-2xl">
        <div class="inline-flex items-center gap-2 bg-[var(--accent-glow)] border border-[var(--accent)]/20 rounded-full px-4 py-1.5 text-sm text-[var(--accent2)] mb-6">
          <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
          Mis à jour le ${todayFr()}
        </div>
        <h1 class="text-3xl md:text-5xl font-extrabold tracking-tight leading-tight mb-4 text-[var(--text)]">
          Résultats de ventes aux<br>enchères en <span class="text-transparent bg-clip-text bg-gradient-to-r from-[var(--accent2)] to-purple-300">France</span>
        </h1>
        <p class="text-base md:text-lg text-[var(--text2)] leading-relaxed mb-8">
          Consultez les prix adjugés, photos et estimations de <span class="text-[var(--text)] font-semibold">${formatPrice(totalItems)}</span> lots vendus aux enchères pour un total de <span class="text-[var(--text)] font-semibold">${formatPrice(totalPrice)} €</span>.
        </p>
        <div class="flex flex-wrap gap-3">
          <a href="#lots" class="bg-[var(--accent)] hover:bg-[var(--accent2)] text-white px-6 py-3 rounded-xl font-semibold text-sm transition shadow-lg shadow-[var(--accent)]/25">Explorer les ventes →</a>
          <a href="/invendus.html" class="bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text)] px-6 py-3 rounded-xl font-semibold text-sm transition">Invendus à négocier</a>
        </div>
      </div>
    </div>
  </section>

  <!-- Stats du jour -->
  <section class="max-w-6xl mx-auto px-6 -mt-4">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <div class="bg-white/[0.03] backdrop-blur border border-white/5 rounded-2xl p-5 hover:bg-white/[0.05] transition">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Objets vendus aujourd'hui</p>
        <p class="text-2xl md:text-3xl font-bold tracking-tight text-[var(--text)]">${formatPrice(dayCount)}</p>
      </div>
      <div class="bg-white/[0.03] backdrop-blur border border-white/5 rounded-2xl p-5 hover:bg-white/[0.05] transition">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Total adjugé</p>
        <p class="text-2xl md:text-3xl font-bold tracking-tight text-[var(--text)]">${dayPrice >= 1000000 ? (dayPrice / 1000000).toFixed(1) + " M€" : formatPrice(dayPrice) + " €"}</p>
      </div>
      <div class="bg-white/[0.03] backdrop-blur border border-white/5 rounded-2xl p-5 hover:bg-white/[0.05] transition">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Prix moyen</p>
        <p class="text-2xl md:text-3xl font-bold tracking-tight text-[var(--text)]">${formatPrice(dayAvg)} €</p>
      </div>
      ${dayMaxSlug ? `<a href="/lot/${dayMaxSlug}.html"` : `<div`} class="bg-white/[0.03] backdrop-blur border border-white/5 rounded-2xl p-5 hover:bg-white/[0.05] transition group no-underline">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Record du jour</p>
        <p class="text-2xl md:text-3xl font-bold tracking-tight text-[var(--accent2)] group-hover:text-[var(--accent)]">${formatPrice(dayMax)} €</p>
      ${dayMaxSlug ? `</a>` : `</div>`}
    </div>
  </section>

  <!-- Stats globales -->
  <section class="max-w-6xl mx-auto px-6 mt-10">
    <h2 class="text-base md:text-lg font-semibold mb-4 flex items-center gap-2 text-[var(--text)]">
      <span class="w-1 h-6 bg-[var(--accent)] rounded-full"></span>
      Statistiques globales <span class="text-xs font-normal text-[var(--text3)]">(${uniqueDays.size} jour${uniqueDays.size > 1 ? "s" : ""} de ventes)</span>
    </h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Lots au total</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--text)]">${formatPrice(totalItems)}</p>
      </div>
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Total cumulé</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--text)]">${totalPrice >= 1000000 ? (totalPrice / 1000000).toFixed(1) + " M€" : formatPrice(totalPrice) + " €"}</p>
      </div>
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Prix moyen global</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--text)]">${formatPrice(globalAvg)} €</p>
      </div>
      ${globalMaxSlug ? `<a href="/lot/${globalMaxSlug}.html"` : `<div`} class="bg-white/[0.03] border border-white/5 rounded-2xl p-5 group no-underline">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Record absolu</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--accent2)]">${formatPrice(globalMax)} €</p>
      ${globalMaxSlug ? `</a>` : `</div>`}
    </div>
  </section>

  <!-- Mise à prix vs Prix vendu -->
  <section class="max-w-6xl mx-auto px-6 mt-10">
    <h2 class="text-base md:text-lg font-semibold mb-4 flex items-center gap-2 text-[var(--text)]">
      <span class="w-1 h-6 bg-[var(--accent)] rounded-full"></span>
      Mise à prix vs Prix vendu <span class="text-xs font-normal text-[var(--text3)]">(${formatPrice(ratioCount)} lots analysés)</span>
    </h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Ratio moyen</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--text)]">×${avgRatio}</p>
        <p class="text-[0.7rem] text-[var(--text3)] mt-2 leading-snug">En moyenne, un lot se vend ${avgRatio}× sa mise à prix de départ</p>
      </div>
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Ratio médian</p>
        <p class="text-2xl md:text-3xl font-bold text-[var(--text)]">×${medianRatio}</p>
        <p class="text-[0.7rem] text-[var(--text3)] mt-2 leading-snug">La moitié des lots se vend plus de ${medianRatio}× la mise à prix</p>
      </div>
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Au-dessus de l'estimation</p>
        <p class="text-2xl md:text-3xl font-bold text-emerald-400">${aboveEstPct}%</p>
        <p class="text-[0.7rem] text-[var(--text3)] mt-2 leading-snug">${aboveEstPct}% des lots dépassent l'estimation haute du commissaire-priseur</p>
      </div>
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl p-5">
        <p class="text-xs md:text-sm text-[var(--text3)] mb-1">Plus grosse surprise</p>
        <p class="text-2xl md:text-3xl font-bold text-amber-400">×${topSurprises[0]?.ratio || "–"}</p>
        <p class="text-[0.7rem] text-[var(--text3)] mt-2 leading-snug">Le lot le plus surprenant a atteint ${topSurprises[0]?.ratio || "–"}× sa mise à prix</p>
      </div>
    </div>
  </section>

  <!-- Top 10 + Top surprises côte à côte -->
  <section class="max-w-6xl mx-auto px-6 mt-10">
    <div class="grid md:grid-cols-2 gap-4 md:gap-6">
      <!-- Top 10 -->
      <div class="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
        <div class="px-5 py-3.5 border-b border-white/5"><h3 class="font-semibold text-sm text-[var(--text)]">Top 10 ventes</h3></div>
        <div class="divide-y divide-white/5">
          ${top10.map(({ item }, i) => {
            const p = item.pricing?.auctioned?.price || 0;
            const rawD = item.description || item.title_translations?.["fr-FR"] || "";
            const fallback = extractTitle(rawD);
            const t = item._aiTitle || fallback;
            const th = item.medias?.[0] ? imgUrl(item.medias[0], "lg") : "";
            const sl = lotSlug(item);
            const cn = item.category?.name || "";
            return `<a href="/lot/${sl}.html" class="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.03] transition no-underline">
            <span class="text-sm font-bold text-[var(--accent2)] w-6">${i + 1}</span>
            ${th ? `<img src="${th}" class="w-14 h-14 rounded-xl object-cover flex-shrink-0" loading="lazy">` : `<div class="w-14 h-14 rounded-xl bg-[var(--surface3)] flex-shrink-0"></div>`}
            <div class="flex-1 min-w-0"><p class="text-sm font-medium text-[var(--text)] line-clamp-2 leading-snug">${esc(t.substring(0, 60))}</p><p class="text-xs text-[var(--text3)] mt-0.5">${esc(cn)}</p></div>
            <span class="text-sm font-bold text-emerald-400 whitespace-nowrap">${formatPrice(p)} €</span>
          </a>`;
          }).join("")}
        </div>
      </div>
      <!-- Top surprises — cards avec photos -->
      ${topSurprises.length ? `<div>
        <div class="mb-3"><h3 class="font-semibold text-sm text-[var(--text)]">Plus grosses surprises</h3></div>
        <div class="flex flex-col gap-3">
          ${topSurprises.map(s => `<a href="/lot/${s.slug}.html" class="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-xl p-3 hover:border-amber-500/30 hover:bg-white/[0.05] transition no-underline group">
            ${s.thumb ? `<img src="${s.thumb}" class="w-16 h-16 rounded-lg object-cover flex-shrink-0" loading="lazy">` : `<div class="w-16 h-16 rounded-lg bg-[var(--surface3)] flex-shrink-0"></div>`}
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-[var(--text)] line-clamp-1 leading-snug">${esc(s.title.substring(0, 55))}</p>
              <p class="text-xs text-[var(--text3)] mt-1">Mise à prix : ${formatPrice(s.sp)} € → Vendu : <span class="text-emerald-400 font-semibold">${formatPrice(s.price)} €</span></p>
            </div>
            <span class="text-xl md:text-2xl font-black text-amber-400 shrink-0">×${s.ratio}</span>
          </a>`).join("")}
        </div>
      </div>` : ""}
    </div>
  </section>

  <!-- Lots vendus -->
  <div class="max-w-6xl mx-auto px-6 mt-10" id="lots">
    <div class="grid-2">
      <main>
        <div class="card">
          <div class="card-header flex items-center justify-between"><h2 style="font-size:1.1rem;">Derniers lots vendus</h2></div>
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
  </div><!-- /grid-2 -->
  </div><!-- /max-w-6xl -->
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
    const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
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
              Au ${todayFr()}, <strong>${formatPrice(items.length)}</strong> lots ont été vendus aux enchères à <strong>${esc(name)}</strong> pour un total de <strong>${formatPrice(totalPrice)} €</strong>, soit un prix moyen de <strong>${formatPrice(avgPrice)} €</strong>.
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
  const totalLots = sorted.reduce((s, [, c]) => s + c.items.length, 0);
  const totalPrice = sorted.reduce((s, [, c]) => s + c.totalPrice, 0);
  const top5 = sorted.slice(0, 5);

  // Build map data
  const mapCities = sorted.map(([slug, c]) => {
    const coords = cityToCoords(c.name);
    if (!coords) return null;
    return { v: c.name, s: slug, lat: coords[0], lng: coords[1], n: c.items.length, t: c.totalPrice };
  }).filter(Boolean);

  // All cities as JSON for client-side search/sort, with region
  const citiesJson = sorted.map(([slug, c]) => {
    const avg = c.items.length ? Math.round(c.totalPrice / c.items.length) : 0;
    const maxP = c.items.length ? Math.max(...c.items.map(i => i.pricing?.auctioned?.price || 0)) : 0;
    const coords = cityToCoords(c.name);
    const region = coords ? coordsToRegion(coords[0], coords[1]) : "Autre";
    return { s: slug, n: c.name, l: c.items.length, t: c.totalPrice, a: avg, m: maxP, r: region };
  });

  return `${htmlHead("Enchères par ville en France — Résultats | Adjugé !", `Résultats de ventes aux enchères dans ${sorted.length} villes en France. ${formatPrice(totalLots)} lots pour ${formatPrice(totalPrice)} €.`, "", "/villes.html")}
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Villes</div>
  ${adSlot("header", "padding: 0.5rem 2rem;")}
  <div class="max-w-6xl mx-auto px-4 md:px-6 py-6">

    <h1 class="text-2xl md:text-3xl font-bold mb-2 text-[var(--text)]">Enchères par ville</h1>
    <p class="text-sm text-[var(--text2)] mb-6">${formatPrice(totalLots)} lots vendus dans ${sorted.length} villes pour un total de ${formatPrice(totalPrice)} €</p>

    <!-- Carte -->
    <div id="villesMap" style="height:400px;border-radius:1rem;border:1px solid rgba(255,255,255,0.05);margin-bottom:1.5rem;z-index:1;"></div>

    <!-- Top 5 hero -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
      ${top5.map(([slug, c], i) => {
        const avg = c.items.length ? Math.round(c.totalPrice / c.items.length) : 0;
        const maxP = Math.max(...c.items.map(it => it.pricing?.auctioned?.price || 0));
        return `<a href="/ville/${slug}.html" class="bg-white/[0.03] border border-white/5 rounded-2xl p-4 hover:border-[var(--accent)]/30 hover:bg-white/[0.05] transition no-underline group ${i === 0 ? "col-span-2 md:col-span-1" : ""}">
          <div class="text-xs text-[var(--accent2)] font-bold mb-1">#${i + 1}</div>
          <div class="text-base md:text-lg font-bold text-[var(--text)] group-hover:text-[var(--accent2)] transition">${esc(c.name)}</div>
          <div class="text-xl md:text-2xl font-extrabold text-[var(--accent2)] mt-1">${formatPrice(c.items.length)}</div>
          <div class="text-xs text-[var(--text3)]">lots · moy. ${formatPrice(avg)} €</div>
          <div class="text-xs text-emerald-400 font-semibold mt-1">Record : ${formatPrice(maxP)} €</div>
        </a>`;
      }).join("")}
    </div>

    <!-- Recherche + tri + filtre région -->
    <div class="flex flex-wrap gap-3 mb-4">
      <input type="text" id="citySearch" placeholder="Rechercher une ville..." class="flex-1 min-w-[200px] bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-[var(--text)] placeholder-[var(--text3)] outline-none focus:ring-2 focus:ring-[var(--accent)]/50 font-[inherit]">
      <select id="regionFilter" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-[var(--text)] font-[inherit] outline-none">
        <option value="">Toutes les régions</option>
        <option value="Île-de-France">Île-de-France</option>
        <option value="Auvergne-Rhône-Alpes">Auvergne-Rhône-Alpes</option>
        <option value="Nouvelle-Aquitaine">Nouvelle-Aquitaine</option>
        <option value="Occitanie">Occitanie</option>
        <option value="Provence-Alpes-Côte d'Azur">PACA</option>
        <option value="Grand Est">Grand Est</option>
        <option value="Hauts-de-France">Hauts-de-France</option>
        <option value="Bretagne">Bretagne</option>
        <option value="Normandie">Normandie</option>
        <option value="Pays de la Loire">Pays de la Loire</option>
        <option value="Centre-Val de Loire">Centre-Val de Loire</option>
        <option value="Bourgogne-Franche-Comté">Bourgogne-Franche-Comté</option>
        <option value="Corse">Corse</option>
      </select>
      <select id="citySort" class="bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm text-[var(--text)] font-[inherit] outline-none">
        <option value="lots">Plus de lots</option>
        <option value="total">Total € décroissant</option>
        <option value="avg">Prix moyen décroissant</option>
        <option value="alpha">Alphabétique</option>
      </select>
    </div>

    <!-- Grille de villes -->
    <div id="cityCount" class="text-xs text-[var(--text3)] mb-3"></div>
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3" id="cityGrid"></div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var DATA = ${JSON.stringify(citiesJson)};
    var grid = document.getElementById('cityGrid');
    var countEl = document.getElementById('cityCount');

    function render(items) {
      grid.innerHTML = items.map(function(c) {
        var badge = c.l >= 500 ? '<span class="inline-block text-[0.6rem] font-bold bg-[var(--accent)]/20 text-[var(--accent2)] px-2 py-0.5 rounded-full ml-1">TOP</span>' : '';
        return '<a href="/ville/' + c.s + '.html" class="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:border-[var(--accent)]/30 hover:bg-white/[0.05] transition no-underline block">'
          + '<div class="font-bold text-[var(--text)] text-sm mb-1">' + c.n + badge + '</div>'
          + '<div class="text-[0.65rem] text-[var(--text3)] mb-2">' + (c.r || '') + '</div>'
          + '<div class="text-2xl font-extrabold text-[var(--accent2)]">' + c.l.toLocaleString('fr-FR') + '</div>'
          + '<div class="text-xs text-[var(--text3)] mb-1">lots vendus</div>'
          + '<div class="flex justify-between text-xs text-[var(--text2)] mt-2 pt-2 border-t border-white/5">'
          + '<span>' + c.t.toLocaleString('fr-FR') + ' € total</span>'
          + '<span>moy. ' + c.a.toLocaleString('fr-FR') + ' €</span>'
          + '</div></a>';
      }).join('');
      countEl.textContent = items.length + ' ville' + (items.length > 1 ? 's' : '');
    }

    function applyFilters() {
      var q = document.getElementById('citySearch').value.trim().toLowerCase();
      var sort = document.getElementById('citySort').value;
      var region = document.getElementById('regionFilter').value;
      var filtered = DATA;
      if (q) filtered = filtered.filter(function(c) { return c.n.toLowerCase().indexOf(q) !== -1; });
      if (region) filtered = filtered.filter(function(c) { return c.r === region; });
      if (sort === 'total') filtered = filtered.slice().sort(function(a,b) { return b.t - a.t; });
      else if (sort === 'avg') filtered = filtered.slice().sort(function(a,b) { return b.a - a.a; });
      else if (sort === 'alpha') filtered = filtered.slice().sort(function(a,b) { return a.n.localeCompare(b.n); });
      render(filtered);
    }

    document.getElementById('citySearch').addEventListener('input', applyFilters);
    document.getElementById('citySort').addEventListener('change', applyFilters);
    document.getElementById('regionFilter').addEventListener('change', applyFilters);
    applyFilters();

    // Map
    var MAP_DATA = ${JSON.stringify(mapCities)};
    var map = L.map('villesMap').setView([46.6, 2.5], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    MAP_DATA.forEach(function(c) {
      var r = Math.min(5 + Math.sqrt(c.n) * 1.5, 30);
      L.circleMarker([c.lat, c.lng], { radius: r, fillColor: '#a78bfa', color: '#7c5cfc', weight: 1.5, opacity: 0.9, fillOpacity: 0.6 })
        .addTo(map)
        .bindPopup('<strong>' + c.v + '</strong><br>' + c.n + ' lots · ' + c.t.toLocaleString('fr-FR') + ' €<br><a href="/ville/' + c.s + '.html" style="color:#7c5cfc;font-weight:600;">Voir les résultats →</a>');
    });
  })();
  </script>
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
              Au ${todayFr()}, <strong>${formatPrice(items.length)}</strong> lots ${esc(label)} ont été vendus aux enchères en France.
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
Source des données : ventes aux enchères publiques françaises.
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
Au ${todayFr()}, le site recense ${formatPrice(totalItems)} lots vendus pour ${formatPrice(totalPrice)} €.
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
Données collectées quotidiennement depuis les ventes aux enchères publiques françaises.
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
    source: "Ventes aux enchères publiques françaises",
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
      <p>Le site <strong>auboisrieur.fr</strong> est édité par :</p>
      <p><strong>Référencement NICE</strong><br>
      Entreprise individuelle<br>
      SIREN : 447 716 218<br>
      Siège social : Nice (06), France<br>
      Activité : Conseil en systèmes et logiciels informatiques (APE 6202A)</p>
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
        parent: item._parentCatSlug || "divers-nature",
        parentName: item._parentCat || "Divers & Nature",
        items: [],
      });
    }
    registry.categories.get(catSlug).items.push(item);
  }
  console.log(`  📂 ${registry.categories.size} catégories reconstruites`);
}

// Inline FTP uploader — uploads pages one by one as they're generated
async function createInlineFtp() {
  if (process.env.SKIP_FTP === "true" && !config.ftp?.host) {
    // In CI: use basic-ftp with env vars
    const host = process.env.FTP_HOST;
    const user = process.env.FTP_USER;
    const pass = process.env.FTP_PASSWORD;
    const remote = process.env.FTP_REMOTE_PATH || "/public_html";
    if (!host || !user) return null;

    try {
      const { Client } = await import("basic-ftp");
      const client = new Client();
      client.ftp.verbose = false;
      await client.access({ host, user, password: pass, secure: false });
      console.log("  📡 FTP inline connecté");
      return {
        upload: async (localPath, remotePath) => {
          const fullRemote = `${remote}/${remotePath}`;
          try {
            await client.ensureDir(fullRemote.substring(0, fullRemote.lastIndexOf("/")));
            await client.uploadFrom(localPath, fullRemote);
          } catch {}
        },
        close: () => { try { client.close(); } catch {} }
      };
    } catch (err) {
      console.log(`  ⚠️ FTP inline indisponible: ${err.message}`);
      return null;
    }
  }

  if (!config.ftp?.enabled) return null;
  try {
    const { Client } = await import("basic-ftp");
    const client = new Client();
    client.ftp.verbose = false;
    await client.access({
      host: config.ftp.host,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: false,
    });
    const remote = config.ftp.remotePath || "/public_html";
    console.log("  📡 FTP inline connecté");
    return {
      upload: async (localPath, remotePath) => {
        const fullRemote = `${remote}/${remotePath}`;
        try {
          await client.ensureDir(fullRemote.substring(0, fullRemote.lastIndexOf("/")));
          await client.uploadFrom(localPath, fullRemote);
        } catch {}
      },
      close: () => { try { client.close(); } catch {} }
    };
  } catch (err) {
    console.log(`  ⚠️ FTP inline indisponible: ${err.message}`);
    return null;
  }
}

async function rebuildAllPages(dateStr) {
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
  ensureDir(path.join(SITE_DIR, "img"));

  // Copy static assets (logo) — always copy to ensure it's up to date
  const logoSrc = path.join(__dirname, "gavel-logo.png");
  const logoDst = path.join(SITE_DIR, "img", "gavel.png");
  if (fs.existsSync(logoSrc)) {
    fs.copyFileSync(logoSrc, logoDst);
  }

  let pageCount = 0;
  let skipped = 0;
  let uploaded = 0;

  // Inline FTP disabled — lftp in workflow handles deployment much faster in parallel
  const ftp = null;

  // Template version — increment when lot page template changes to force regeneration
  const TEMPLATE_VERSION = "v7";
  // HACK: skip force-regen in CI to avoid 26K files upload timeout
  const skipForceRegen = process.env.SKIP_FORCE_REGEN === "true";
  const versionFile = path.join(DATA_DIR, "template-version.txt");
  let lastVersion = "";
  try { lastVersion = fs.readFileSync(versionFile, "utf-8").trim(); } catch {}
  const forceRegen = !skipForceRegen && lastVersion !== TEMPLATE_VERSION;
  if (forceRegen) console.log(`  🔄 Template ${lastVersion || "?"} → ${TEMPLATE_VERSION} — regénération de toutes les pages lot`);
  fs.writeFileSync(versionFile, TEMPLATE_VERSION, "utf-8");

  // Lot pages — regenerate if: template changed, new page, or AI-enriched since last build
  const aiTracker = path.join(DATA_DIR, "ai-built.json");
  let alreadyBuiltWithAi = {};
  try { alreadyBuiltWithAi = JSON.parse(fs.readFileSync(aiTracker, "utf-8")); } catch {}

  for (const [itemId, { item, sale }] of registry.items) {
    const slug = lotSlug(item);
    const filePath = path.join(SITE_DIR, "lot", `${slug}.html`);
    const hasAi = !!item._aiTitle;
    const wasBuiltWithAi = !!alreadyBuiltWithAi[itemId];

    // Skip if: no force regen, file exists, and AI status hasn't changed
    if (!forceRegen && fs.existsSync(filePath) && (hasAi === wasBuiltWithAi)) { skipped++; continue; }

    writeIfChanged(filePath, generateLotPage(item, sale));
    if (hasAi) alreadyBuiltWithAi[itemId] = true;
    pageCount++;

    // Upload inline — page goes live immediately
    if (ftp) {
      await ftp.upload(filePath, `lot/${slug}.html`);
      uploaded++;
      if (uploaded % 50 === 0) console.log(`    📤 ${uploaded} pages uploadées en temps réel...`);
    }
  }

  // Save AI build tracker
  fs.writeFileSync(aiTracker, JSON.stringify(alreadyBuiltWithAi), "utf-8");

  // Category pages — only write if content changed (preserves timestamps for lftp)
  let catChanged = 0;
  for (const [slug, data] of registry.categories) {
    if (writeIfChanged(path.join(SITE_DIR, "categorie", `${slug}.html`), generateCategoryPage(slug, data))) catChanged++;
    pageCount++;
  }
  console.log(`  📂 ${registry.categories.size} catégories (${catChanged} modifiées)`);

  // Index pages — always write (content changes with new lots)
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
    writeIfChanged(path.join(SITE_DIR, "jour", `${day}.html`), generateHomePage(day));
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
    writeIfChanged(filePath, generateUnsoldPage(item, sale));
    pageCount++;
  }

  if (skipped > 0) console.log(`  ⏩ ${skipped} pages lot déjà existantes (ignorées)`);

  // Legal pages
  fs.writeFileSync(path.join(SITE_DIR, "mentions-legales.html"), generateMentionsLegales(), "utf-8");
  fs.writeFileSync(path.join(SITE_DIR, "politique-confidentialite.html"), generatePolitiqueConfidentialite(), "utf-8");
  pageCount += 2;

  // Page 404 custom — SEO friendly
  const topCats = [...registry.categories.entries()]
    .sort((a, b) => b[1].items.length - a[1].items.length)
    .slice(0, 8);
  fs.writeFileSync(path.join(SITE_DIR, "404.html"), `${htmlHead("Page introuvable — Adjugé !", "Cette page n'existe pas ou a été déplacée. Retrouvez nos enchères sur Adjugé !", '<meta name="robots" content="noindex">', "/404.html")}
<body>
  ${navHtml()}
  <div class="container" style="text-align:center;padding:3rem 1rem;">
    <div style="font-size:4rem;margin-bottom:1rem;">🔨</div>
    <h1 style="font-size:1.8rem;margin-bottom:0.5rem;">Page introuvable</h1>
    <p style="color:var(--text2);margin-bottom:2rem;max-width:500px;margin-left:auto;margin-right:auto;">Cette page n'existe pas ou a été déplacée. Pas de panique, retrouvez nos milliers d'objets vendus aux enchères !</p>
    <div style="display:flex;flex-wrap:wrap;gap:0.8rem;justify-content:center;margin-bottom:2rem;">
      <a href="/index.html" style="background:var(--accent);color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;">🏠 Accueil</a>
      <a href="/categories.html" style="background:var(--surface3);color:var(--text);padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;border:1px solid var(--border2);">📂 Catégories</a>
      <a href="/invendus.html" style="background:var(--surface3);color:var(--text);padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;border:1px solid var(--border2);">📦 Invendus</a>
      <a href="/top-ventes.html" style="background:var(--surface3);color:var(--text);padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;border:1px solid var(--border2);">🏆 Top Ventes</a>
    </div>
    ${topCats.length > 0 ? `<div style="margin-top:1rem;"><h3 style="font-size:1rem;margin-bottom:0.8rem;">Catégories populaires</h3><div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:center;">${topCats.map(([slug, data]) => `<a href="/categorie/${slug}.html" style="background:var(--surface2);padding:6px 14px;border-radius:20px;font-size:0.82rem;text-decoration:none;color:var(--text);border:1px solid var(--border2);">${esc(data.name)} (${data.items.length})</a>`).join("")}</div></div>` : ""}
  </div>
  ${footerHtml()}
</body></html>`, "utf-8");
  pageCount++;

  // À propos page (TASK 10)
  fs.writeFileSync(path.join(SITE_DIR, "a-propos.html"), generateAProposPage(), "utf-8");
  pageCount++;

  // Statistiques page (TASK 11)
  fs.writeFileSync(path.join(SITE_DIR, "statistiques.html"), generateStatistiquesPage(dateStr), "utf-8");
  pageCount++;

  // Maison pages — always regenerate
  for (const [slug, data] of registry.maisons) {
    if (data.items.length >= 3) {
      writeIfChanged(path.join(SITE_DIR, "maison", `${slug}.html`), generateMaisonPage(slug, data));
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
      writeIfChanged(path.join(SITE_DIR, "ville", `${slug}.html`), generateVillePage(slug, data));
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
      writeIfChanged(path.join(SITE_DIR, "prix", `${slug}.html`), generatePrixPage(slug, data));
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
  const searchIndex = allSearchItems.map(({ item, sale }) => {
    const rawD = item.description || item.title_translations?.["fr-FR"] || "";
    const lns = rawD.split("\n").map(l => l.trim()).filter(Boolean);
    const fallbackTitle = (lns.length > 1 && lns[0].length < 60) ? lns[0] + " " + lns.slice(1).join(" ") : lns.join(" ");
    const title = item._aiTitle || fallbackTitle;
    const thumb = item.medias?.[0] ? imgUrl(item.medias[0], "sm") : "";
    const priceNum = item.pricing?.auctioned?.price || 0;
    const price = priceNum ? formatPrice(priceNum) : "Invendu";
    const cat = item.category?.name || "";
    const city = titleCaseCity(sale?.address?.city || item.sale?.address?.city || "");
    const sold = item.pricing?.auctioned?.sold ? 1 : 0;
    return { id: lotSlug(item), t: title.substring(0, 150), p: price, pn: priceNum, img: thumb, c: cat, v: city, so: sold };
  });
  fs.writeFileSync(path.join(SITE_DIR, "search-data.js"), `window.__SI=${JSON.stringify(searchIndex)};`, "utf-8");
  pageCount++;

  // ─── Search page ────────────────────────────────────────────────────
  const searchCats = [...new Set(searchIndex.map(i => i.c).filter(Boolean))].sort();
  writeIfChanged(path.join(SITE_DIR, "recherche.html"), `${htmlHead("Recherche — Adjugé !", "Recherchez parmi ${formatPrice(searchIndex.length)} lots vendus et invendus aux enchères en France.", "", "/recherche.html")}
<body>
  ${navHtml()}
  <div class="breadcrumb"><a href="/index.html">Accueil</a> › Recherche</div>
  <div class="max-w-6xl mx-auto px-4 md:px-6 py-8">
    <h1 class="text-2xl md:text-3xl font-bold mb-6 text-[var(--text)]">Rechercher un lot</h1>
    <div class="flex flex-col md:flex-row gap-3 mb-6">
      <input type="text" id="sq" placeholder="Ex: Rolex, tableau impressionniste, Citroën 2CV..." autofocus
        class="flex-1 bg-[var(--surface3)] border border-[var(--border2)] text-[var(--text)] px-5 py-3 rounded-xl text-base outline-none focus:ring-2 focus:ring-[var(--accent)]/50 focus:border-[var(--accent)] placeholder-[var(--text3)] font-[inherit]">
      <select id="sc" class="bg-[var(--surface3)] border border-[var(--border2)] text-[var(--text)] px-4 py-3 rounded-xl text-sm font-[inherit] outline-none">
        <option value="">Toutes catégories</option>
        ${searchCats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <select id="ss" class="bg-[var(--surface3)] border border-[var(--border2)] text-[var(--text)] px-4 py-3 rounded-xl text-sm font-[inherit] outline-none">
        <option value="">Tous statuts</option>
        <option value="1">Vendus</option>
        <option value="0">Invendus</option>
      </select>
      <select id="sso" class="bg-[var(--surface3)] border border-[var(--border2)] text-[var(--text)] px-4 py-3 rounded-xl text-sm font-[inherit] outline-none">
        <option value="rel">Pertinence</option>
        <option value="ph">Prix décroissant</option>
        <option value="pl">Prix croissant</option>
      </select>
    </div>
    <div id="scount" class="text-sm text-[var(--text3)] mb-4"></div>
    <div class="lot-grid" id="sgrid"></div>
    <div id="smore" style="text-align:center;padding:2rem;display:none;">
      <div style="color:var(--text3);font-size:0.85rem;">Chargement...</div>
    </div>
  </div>
  ${footerHtml()}
  <script>
  (function(){
    var DATA = window.__SI || [];
    var PAGE = 48, shown = 0, filtered = [];
    var grid = document.getElementById('sgrid');
    var more = document.getElementById('smore');
    var countEl = document.getElementById('scount');

    function render(append) {
      if (!append) { grid.innerHTML = ''; shown = 0; }
      var batch = filtered.slice(shown, shown + PAGE);
      batch.forEach(function(d) {
        grid.innerHTML += '<a href="/lot/' + d.id + '.html" class="lot-card" style="text-decoration:none;">'
          + (d.img ? '<img src="' + d.img.replace(/\\/sm\\//,'/lg/') + '" alt="" loading="lazy">' : '<div class="no-img">📷</div>')
          + '<div class="lot-info"><div class="lot-title">' + d.t.substring(0, 80) + '</div>'
          + '<div class="lot-price">' + d.p + (d.so ? ' €' : '') + '</div>'
          + (d.c ? '<div class="lot-cat">' + d.c + '</div>' : '')
          + (d.v ? '<div style="color:var(--text3);font-size:0.68rem;">📍 ' + d.v + '</div>' : '')
          + '</div></a>';
      });
      shown += batch.length;
      countEl.textContent = filtered.length.toLocaleString('fr-FR') + ' résultat' + (filtered.length > 1 ? 's' : '');
      more.style.display = shown < filtered.length ? 'block' : 'none';
    }

    var observer = new IntersectionObserver(function(entries) {
      if (entries[0].isIntersecting && shown < filtered.length) render(true);
    }, { rootMargin: '400px' });
    observer.observe(more);

    function search() {
      var q = document.getElementById('sq').value.trim().toLowerCase();
      var cat = document.getElementById('sc').value;
      var status = document.getElementById('ss').value;
      var sort = document.getElementById('sso').value;
      var words = q.split(/\\s+/).filter(function(w) { return w.length > 0; });

      // Update URL
      var params = new URLSearchParams();
      if (q) params.set('q', q);
      if (cat) params.set('cat', cat);
      if (status) params.set('status', status);
      if (sort !== 'rel') params.set('sort', sort);
      history.replaceState(null, '', params.toString() ? '?' + params.toString() : location.pathname);

      filtered = DATA;
      if (words.length) {
        filtered = filtered.filter(function(d) {
          var tl = d.t.toLowerCase();
          return words.every(function(w) { return tl.indexOf(w) !== -1; });
        });
        // Score for relevance
        filtered = filtered.map(function(d) {
          var tl = d.t.toLowerCase();
          var score = 0;
          words.forEach(function(w) { if (tl.indexOf(w) !== -1) score += 10; });
          if (tl.indexOf(q) === 0) score += 30;
          else if (tl.indexOf(q) !== -1) score += 15;
          d._score = score;
          return d;
        });
      }
      if (cat) filtered = filtered.filter(function(d) { return d.c === cat; });
      if (status !== '') filtered = filtered.filter(function(d) { return String(d.so) === status; });

      if (sort === 'ph') filtered.sort(function(a,b) { return (b.pn||0) - (a.pn||0); });
      else if (sort === 'pl') filtered.sort(function(a,b) { return (a.pn||0) - (b.pn||0); });
      else if (words.length) filtered.sort(function(a,b) { return (b._score||0) - (a._score||0); });

      render(false);
    }

    // Restore from URL params
    var params = new URLSearchParams(location.search);
    if (params.get('q')) document.getElementById('sq').value = params.get('q');
    if (params.get('cat')) document.getElementById('sc').value = params.get('cat');
    if (params.get('status')) document.getElementById('ss').value = params.get('status');
    if (params.get('sort')) document.getElementById('sso').value = params.get('sort');

    var timer;
    document.getElementById('sq').addEventListener('input', function() { clearTimeout(timer); timer = setTimeout(search, 250); });
    document.getElementById('sc').addEventListener('change', search);
    document.getElementById('ss').addEventListener('change', search);
    document.getElementById('sso').addEventListener('change', search);

    // Auto-search if query present
    if (params.get('q') || params.get('cat') || params.get('status')) search();
    else { filtered = DATA; render(false); }
  })();
  </script>
</body></html>`);
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

  # Fallback: custom 404 page
  ErrorDocument 404 /404.html
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

  // Close FTP connection
  if (ftp) {
    // Upload index pages at the end
    const indexFiles = ["index.html", "categories.html", "top-ventes.html", "invendus.html", "sitemap.xml", "robots.txt", "search-data.js", "ads.txt", "llms.txt"];
    for (const f of indexFiles) {
      const p = path.join(SITE_DIR, f);
      if (fs.existsSync(p)) await ftp.upload(p, f);
    }
    ftp.close();
    console.log(`  📤 ${uploaded} pages lot uploadées en temps réel via FTP`);
  }

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

  const alwaysUpload = new Set(["index.html", "categories.html", "top-ventes.html", "invendus.html", "recherche.html", "sitemap.xml", "ads.txt", "robots.txt", ".htaccess", "search-index.json", "search-data.js", "mentions-legales.html", "politique-confidentialite.html", "a-propos.html", "statistiques.html", "llms.txt", "llms-full.txt", "stats.json", "maisons.html", "villes.html", "404.html"]);

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

async function runDaemon(dateStr, intervalSec) {
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
      const pageCount = await rebuildAllPages(dateStr);
      console.log(`  ${pageCount} pages régénérées.\n`);
    } catch {}
  }

  console.log(`\n🏛️  Daemon Interenchères — Site Generator`);
  console.log(`   Dossier: ${SITE_DIR}`);
  console.log(`   Intervalle: ${intervalSec}s — Ctrl+C pour arrêter`);
  console.log(`   Amazon tag: ${config.amazonTag}`);
  console.log(`   AdSense: ${config.adsenseId || "non configuré"}`);
  console.log(`   FTP: ${config.ftp?.enabled ? config.ftp.host : "désactivé"}\n`);

  const poll = async () => {
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
        const pageCount = await rebuildAllPages(dateStr);
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

// DataForSEO Google Shopping search — returns real market prices
async function searchMarketPrices(query) {
  if (!config.dataforseoLogin || !config.dataforseoPassword || !query) return null;
  try {
    const auth = Buffer.from(`${config.dataforseoLogin}:${config.dataforseoPassword}`).toString("base64");
    const body = JSON.stringify([{
      keyword: query.substring(0, 120),
      language_code: "fr",
      location_code: 2250, // France
      device: "desktop",
    }]);
    const result = execFileSync("curl", [
      "-s", "--max-time", "15",
      "https://api.dataforseo.com/v3/serp/google/shopping/live/advanced",
      "-H", "Content-Type: application/json",
      "-H", `Authorization: Basic ${auth}`,
      "-d", body,
    ], { maxBuffer: 2 * 1024 * 1024, timeout: 20000 });
    const json = JSON.parse(result.toString("utf-8"));
    const items = json?.tasks?.[0]?.result?.[0]?.items || [];
    const found = [];
    for (const it of items.slice(0, 15)) {
      if (it.price_from || it.price_to || it.price) {
        found.push({
          title: (it.title || "").substring(0, 80),
          price: it.price_from || it.price || 0,
          priceTo: it.price_to || 0,
          source: it.seller || it.source || "",
          condition: it.product_condition || "",
        });
      }
    }
    return found.length > 0 ? found.slice(0, 8) : null;
  } catch {
    return null;
  }
}

async function callGpt(messages, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 1200,
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
- Si des PRIX MARCHÉ (Google Shopping) sont fournis dans un second message, utilise-les pour ton analyse de prix. Ce sont des prix réels trouvés en ligne pour des objets similaires.
- IDENTIFIE le vrai objet dans la description. La première ligne peut être un numéro d'immatriculation, un code, un numéro de lot — ignore-les. Trouve le NOM RÉEL du produit (marque, modèle, type d'objet).
- IGNORE les infos logistiques : dates d'expo, adresses de retrait, conditions de vente, frais.
- La catégorie Interenchères peut être vague ("Secteurs d'activités spécifiques - Divers") — recatégorise correctement.

Tu dois retourner un JSON avec exactement 9 champs :
- "title": le NOM RÉEL de l'objet, accrocheur, clair et SEO-friendly (max 70 car). Ex: si la desc parle d'une "CITROEN AMI" avec immatriculation, le titre doit être "Citroën AMI — Véhicule électrique compact". Pas de numéro de lot, pas de plaque d'immat, pas de "A partir de".
- "desc": RÉÉCRIS et ENRICHIS la description brute fournie en 6-10 phrases (max 900 car). INTERDICTION de phrases creuses type "bijou intemporel", "saura séduire les amateurs", "pièce d'exception". Sois FACTUEL et TECHNIQUE : poids exact, dimensions, poinçons, carat, calibre, numéro de série, année de fabrication, tirage, techniques utilisées. Ajoute des INFOS que l'acheteur ne trouve pas dans la description brute : cote actuelle sur le marché, historique de la marque/artiste, rareté, points à vérifier avant achat. Pour une bague or 750 : poids en grammes, type de sertissage, taille du diamant en carats, couleur/pureté si visible. Pour une montre : calibre, fréquence, réserve de marche, diamètre boîtier. Pour un meuble : essence du bois, époque exacte, dimensions, restaurations. Pour un véhicule : motorisation, puissance, km, CT, options. Pas de mention de la maison de vente ni d'infos expo/retrait.
- "category": NE PAS CHANGER. Recopie EXACTEMENT la catégorie Interenchères fournie dans le message. Ne la modifie pas, ne la recatégorise pas.
- "price_analysis": analyse du prix en 2-3 phrases (max 250 car). Compare avec le marché.
- "deal_score": note de 0 à 3. SOIS TRÈS STRICT — la majorité des lots sont 0. Score 2 ou 3 = EXCEPTIONNEL et RARE. 0=sans intérêt (objet banal, lot vrac, valeur faible, pas de marché secondaire actif — c'est le score par DÉFAUT pour 70% des lots), 1=bonne affaire (objet de marque identifiable, estimation raisonnable, demande existante sur le marché occasion), 2=super affaire (objet de qualité reconnue dont le prix marché occasion est VÉRIFIABLEMENT 2x+ l'estimation — UNIQUEMENT si tu as des données de prix marché concrètes), 3=affaire exceptionnelle (réservé aux objets iconiques/collector avec cote établie bien supérieure — Rolex Daytona, Hermès Birkin, Ferrari, etc.).
- "deal_analysis": (max 400 car) Analyse experte UNIQUEMENT si deal_score >= 1 : explique POURQUOI c'est une bonne affaire. Inclure : estimation du prix sur le marché de l'occasion/neuf, la décote par rapport au prix marché, le potentiel de revente, la rareté, la demande pour ce type d'objet. Sois factuel et précis avec des prix. Exemple : "Ce Renault Trafic 2.0 DCI se négocie entre 12 000 et 18 000 € sur le marché occasion. Avec une estimation de 15 000 €, un invendu peut souvent s'obtenir 20-30% en dessous, soit autour de 10 000-12 000 €. Forte demande pour les utilitaires récents." Pour deal_score=0, mettre "".
- "faq": array de 5 objets {q, a} — questions contenant le NOM RÉEL DE L'OBJET (pas la catégorie Interenchères !). Inclure : prix/valeur, comment acheter, authenticité/état, marché/tendance, conseil pratique. Réponses factuelles et détaillées (max 250 car chacune).
- "tags": array de 3-5 mots-clés pertinents (marque, époque, matériau, style...)
- "specs": (UNIQUEMENT pour les véhicules/motos) un objet avec les champs disponibles : { "marque", "modele", "motorisation", "puissance", "carburant", "mise_en_service", "kilometrage", "finition", "boite", "portes", "couleur", "type_vehicule" }. Ex: {"marque":"Nissan","modele":"Note 1.5 DCI Visia","motorisation":"1.5 L DCI 68 ch","carburant":"Diesel","mise_en_service":"10/07/2007","finition":"Visia"}. Pour les non-véhicules, mettre null.

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
      item._aiSpecs = cache[item.id].specs || null;
      item._aiDealScore = cache[item.id].ds ?? -1;
      item._aiDealAnalysis = cache[item.id].da || "";
      item._aiPriceAnalysis = cache[item.id].pa || "";
      item._aiFaq = cache[item.id].faq || [];
      item._aiTags = cache[item.id].tags || [];
      // Keep original Interencheres category — don't override with AI category
    }
  }

  // Find items that still need enrichment
  let toEnrich = items.filter(({ item }) => {
    if (!cache[item.id]) return true;
    const faq = cache[item.id].faq || [];
    if (faq.length < 3) return true;
    const hasGeoQ = faq.some(f => /prix|valeur|co[uû]t|combien/i.test(f.q || ""));
    if (!hasGeoQ) return true;
    // Re-enrich if FAQ references generic category names instead of actual product
    const hasBadFaq = faq.some(f => /secteurs? d.activit|divers|ventes? aux ench.res\s*[?.]?\s*$/i.test(f.q || ""));
    if (hasBadFaq) return true;
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

    const isUnsold = registry.unsold.has(item.id);
    const estLow = item.pricing?.estimates?.low || item.pricing?.estimates?.min || 0;
    const estHigh = item.pricing?.estimates?.max || 0;
    const startPrice = item.pricing?.starting_price || 0;

    // Step 1: GPT text — identify the object from description
    const userMsg = `Catégorie Interenchères (peut être vague): ${catName}\nPrix adjugé: ${price}€${isUnsold ? `\nSTATUT: INVENDU (pas vendu aux enchères)${estLow ? `\nEstimation: ${estLow}-${estHigh}€` : ""}${startPrice ? `\nMise à prix: ${startPrice}€` : ""}` : ""}\nDescription brute:\n${rawDesc.substring(0, 500)}`;

    try {
      let response = await callGpt([
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ]);

      // Step 2: If we got a title, search Google Shopping for market prices
      let cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      let parsed;
      try { parsed = JSON.parse(cleaned); } catch { parsed = null; }

      if (parsed?.title && config.dataforseoLogin) {
        const shopResults = await searchMarketPrices(parsed.title);
        if (shopResults && shopResults.length > 0) {
          const marketInfo = "PRIX MARCHÉ RÉELS (Google Shopping) :\n" + shopResults.map(r =>
            `- ${r.title} : ${r.price}€${r.priceTo ? `-${r.priceTo}€` : ""} (${r.source}${r.condition ? `, ${r.condition}` : ""})`
          ).join("\n");

          // Step 3: Re-ask GPT with market prices for better deal analysis
          const refinedContent = `L'objet identifié est : "${parsed.title}"\n${isUnsold ? `STATUT: INVENDU${estLow ? ` | Estimation: ${estLow}-${estHigh}€` : ""}${startPrice ? ` | Mise à prix: ${startPrice}€` : ""}` : `Prix adjugé: ${price}€`}\n\n${marketInfo}\n\nMets à jour UNIQUEMENT les champs "price_analysis", "deal_score" et "deal_analysis" en te basant sur ces prix marché réels. Garde les autres champs identiques. Réponds en JSON complet.`;

          const refined = await callGpt([
            { role: "system", content: AI_SYSTEM_PROMPT },
            { role: "user", content: userMsg },
            { role: "assistant", content: response },
            { role: "user", content: refinedContent },
          ]);
          const cleanedRefined = refined.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          try {
            const parsedRefined = JSON.parse(cleanedRefined);
            if (parsedRefined.title) {
              response = refined;
              cleaned = cleanedRefined;
              parsed = parsedRefined;
            }
          } catch {} // Keep original if refinement fails
        }
      }

      // Parse final JSON response (may have been refined with market data)
      if (!parsed) parsed = JSON.parse(cleaned);

      if (parsed.title && parsed.desc) {
        cache[item.id] = {
          t: parsed.title,
          d: parsed.desc,
          cat: parsed.category || "",
          pa: parsed.price_analysis || "",
          ds: typeof parsed.deal_score === "number" ? parsed.deal_score : -1,
          da: parsed.deal_analysis || "",
          faq: parsed.faq || [],
          tags: parsed.tags || [],
          specs: parsed.specs || null,
        };
        item._aiTitle = parsed.title;
        item._aiDesc = parsed.desc;
        item._aiCategory = parsed.category || "";
        item._aiPriceAnalysis = parsed.price_analysis || "";
        item._aiDealScore = typeof parsed.deal_score === "number" ? parsed.deal_score : -1;
        item._aiDealAnalysis = parsed.deal_analysis || "";
        item._aiFaq = parsed.faq || [];
        item._aiTags = parsed.tags || [];
        item._aiSpecs = parsed.specs || null;
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
      item._aiSpecs = cache[item.id].specs || null;
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
    // 1) AI enrichment FIRST — so pages are built with AI content
    if (process.env.SKIP_AI === "true") {
      console.log("  ⏭️  AI skip (SKIP_AI=true)");
    } else {
      const AI_BUDGET = process.env.AI_BUDGET ? parseInt(process.env.AI_BUDGET) : 50;
      await aiEnrichLots(AI_BUDGET);
    }

    // 2) Build ALL pages (with AI data already applied)
    const pageCount = await rebuildAllPages(dateStr);
    console.log(`  📄 ${pageCount} pages générées`);

    // 3) Deploy once
    await ftpUpload();
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
  const pageCount = await rebuildAllPages(dateStr);
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
