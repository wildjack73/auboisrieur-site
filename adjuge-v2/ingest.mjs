#!/usr/bin/env node
/**
 * Adjugé v2 — Ingest (runs on VPS)
 * Reads JSON from stdin → SQLite
 * + title extraction from description
 * + category fixing
 * + city/postcode normalization
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "adjuge.db");
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDb() {
  ensureDir(path.dirname(DB_PATH));
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY,
      title TEXT, clean_title TEXT, description TEXT,
      category TEXT, category_id INTEGER,
      sold INTEGER NOT NULL DEFAULT 0,
      price REAL, estimate_low REAL, estimate_high REAL,
      starting_price REAL, commission_rate REAL,
      sale_date TEXT, sale_id INTEGER,
      org_name TEXT, org_email TEXT, org_phone TEXT, org_address TEXT,
      city TEXT, postcode TEXT, slug TEXT UNIQUE,
      thumb TEXT, photos TEXT,
      ai_title TEXT, ai_desc TEXT, ai_deal_score INTEGER DEFAULT -1,
      ai_deal_analysis TEXT, ai_price_analysis TEXT, ai_faq TEXT, ai_tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lots_sold ON lots(sold);
    CREATE INDEX IF NOT EXISTS idx_lots_category ON lots(category);
    CREATE INDEX IF NOT EXISTS idx_lots_city ON lots(city);
    CREATE INDEX IF NOT EXISTS idx_lots_sale_date ON lots(sale_date);
    CREATE INDEX IF NOT EXISTS idx_lots_slug ON lots(slug);
    CREATE INDEX IF NOT EXISTS idx_lots_deal_score ON lots(ai_deal_score);
  `);
  return db;
}

// ─── Title extraction from description ──────────────────────────────────────
function extractTitleFromDesc(desc) {
  if (!desc || desc.length < 10) return "";
  const lines = desc.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 5);
  for (const line of lines) {
    if (/^(lot\s*\d|n°|ref|expo|enlèvement|retrait|stockage|conditions|frais|tva|commission|du\s+lundi|visible|impératif)/i.test(line)) continue;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(line)) continue;
    if (/^(Lieu|Adresse|Contact|Tel|Email|Horaire)/i.test(line)) continue;
    return line.substring(0, 150).replace(/\s+/g, " ").trim();
  }
  return "";
}

// ─── Category fixing rules ──────────────────────────────────────────────────
const CAT_FIXES = [
  { match: /\b(meuble|commode|armoire|buffet|table\s|chaise|fauteuil|console|secrétaire|bibliothèque|étagère|bahut|enfilade|guéridon|desserte)\b/i, correct: "Mobilier Ancien", wrong: /bijoux|numismatique|vins|informatique|voitures|instruments/i },
  { match: /\b(huile sur|aquarelle|lithographi|estampe|gravure|tableau|peinture|toile|sérigraphie|pastel\s+sur)\b/i, correct: "Tableaux, Dessins & Estampes", wrong: /bijoux|mobilier|voitures|informatique|vins|pendules/i },
  { match: /\b(montre|rolex|omega|cartier|breitling|patek|audemars|tag.heuer|seiko|longines|jaeger|iwc|tudor|vacheron|chronograph)\b/i, correct: "Bijoux & Pierres Précieuses", wrong: /vins|luminaires|pendules|mobilier|informatique|numismatique|destockage/i },
  { match: /\b(collier|bague\s|bracelet\s+(?:en|or|argent)|pendentif|diamant|saphir|rubis|émeraude|broche|or\s+\d+[ck]|or\s+750)\b/i, correct: "Bijoux & Pierres Précieuses", wrong: /vins|luminaires|pendules|mobilier|informatique|destockage/i },
  { match: /\b(bouteille|champagne|cognac|whisky|armagnac|château\s|domaine\s|cuvée|millésim|bourgogne|bordeaux|pommard|gevrey|romanée|saint-émilion|médoc|magnum|spiritueux)\b/i, correct: "Vins & Spiritueux", wrong: /bijoux|luminaires|pendules|mobilier|informatique|voitures|tableaux|instruments/i },
  { match: /\b(genre\s*:\s*vp|immatricul.*[A-Z]{2}.\d{3}|mise en service.*\d{2}\/\d{2}\/\d{4})\b/i, correct: "Voitures Particulières", wrong: /bijoux|vins|luminaires|mobilier|instruments|tableaux|numismatique/i },
  { match: /\b(genre\s*:\s*ctte|fourgon)\b/i, correct: "Utilitaires & Véhicules de Société", wrong: /bijoux|vins|mobilier|particulières/i },
  { match: /\b(médaille|pièce\s+de\s+monnaie|denier|franc\s+\d|napoléon\s+or|louis\s+d.or)\b/i, correct: "Numismatique", wrong: /bijoux|vins|mobilier|informatique/i },
  { match: /\b(lustre|lampe\s|applique|chandelier|lampadaire|plafonnier|suspension|girandole)\b/i, correct: "Luminaires", wrong: /vins|bijoux|voitures|informatique/i },
  { match: /\b(pendule|horloge|cartel|comtoise|régulateur)\b/i, correct: "Pendules & Horloges", wrong: /bijoux|vins|voitures|informatique|mobilier/i },
  { match: /\b(sculpture|bronze\s|buste|statue|terre\s+cuite)\b/i, correct: "Sculptures", wrong: /bijoux|vins|mobilier|voitures|pendules/i },
  { match: /\b(ménagère|argenterie|orfèvrerie|métal\s+argenté|couvert\s+argent)\b/i, correct: "Argenterie & Orfèvrerie", wrong: /bijoux|vins|mobilier|voitures/i },
  { match: /\b(faïence|porcelaine|vase\s+(?:en|de)|sèvres|limoges|delft|gien)\b/i, correct: "Céramiques & Porcelaine", wrong: /bijoux|vins|mobilier|voitures|luminaires/i },
  { match: /\b(tracteur|moissonneuse|charrue|semoir|pulvérisateur)\b/i, correct: "Matériel Agricole & Viticole", wrong: /bijoux|vins|mobilier|informatique/i },
  { match: /\b(pelleteuse|chargeuse|grue|nacelle|compacteur|bulldozer)\b/i, correct: "BTP & Construction", wrong: /bijoux|vins|mobilier|informatique/i },
];

function fixCategory(lot) {
  const text = (lot.title || "") + " " + (lot.clean_title || "") + " " + (lot.description || "").substring(0, 300);
  const cat = lot.category || "";
  for (const rule of CAT_FIXES) {
    if (rule.match.test(text) && rule.wrong.test(cat)) {
      return rule.correct;
    }
  }
  return cat;
}

// ─── City/postcode normalization ────────────────────────────────────────────
const CITY_NORMS = {"TOULOUSE":"Toulouse","NANTES":"Nantes","MEAUX":"Meaux","PARIS":"Paris","BORDEAUX":"Bordeaux","BRASLES":"Brasles","LYON":"Lyon","MARSEILLE":"Marseille","NICE":"Nice","BETHUNE":"Béthune","ROUEN":"Rouen","FECAMP":"Fécamp"};
const CITY_PC = {"Paris":"75001","Toulouse":"31000","Nantes":"44000","Bordeaux":"33000","Lyon":"69001","Marseille":"13001","Nice":"06000","Lille":"59000","Reims":"51100","Le Havre":"76600","Aix-en-Provence":"13100","Coutances":"50200","Longuenesse":"62219","Chaumont":"52000","Mâcon":"71000","Vichy":"03200","Toulon":"83000","Vendeville":"59175","Corbas":"69960","Portets":"33640","Brasles":"02400","La Rochelle":"17000","Limoges":"87000","Chambéry":"73000","Rouen":"76000","Dijon":"21000","Beaune":"21200","Agen":"47000","Montauban":"82000","Tarbes":"65000","Rodez":"12000","Le Mans":"72000","Mayenne":"53100","Argenteuil":"95100","Neuilly-sur-Seine":"92200","Le Raincy":"93340","Fontainebleau":"77300","Fécamp":"76400","Villeurbanne":"69100","Saint-Quentin":"02100","Dunkerque":"59140","Amiens":"80000","Troyes":"10000","Chartres":"28000","Meaux":"77100","Versailles":"78000","Strasbourg":"67000","Clermont-Ferrand":"63000"};

function normalizeCity(lot) {
  if (lot.city && CITY_NORMS[lot.city]) lot.city = CITY_NORMS[lot.city];
  if (lot.city && (!lot.postcode || lot.postcode.length < 5) && CITY_PC[lot.city]) {
    lot.postcode = CITY_PC[lot.city];
  }
}

// ─── Vision fallback for high-value lots without title ──────────────────────
async function visionTitle(thumbUrl) {
  if (!OPENAI_KEY || !thumbUrl) return "";
  try {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 60,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Identifie cet objet en une phrase courte (max 60 caractères). Réponds UNIQUEMENT le nom de l'objet, rien d'autre. Ex: 'Commode Louis XV en noyer', 'Rolex Submariner Date', 'Paire de fauteuils cabriolet'" },
          { type: "image_url", image_url: { url: thumbUrl, detail: "low" } }
        ]
      }]
    });
    const r = execSync(`curl -s --max-time 15 -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer ${OPENAI_KEY}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`, { encoding: "utf-8" });
    const parsed = JSON.parse(r);
    return (parsed.choices?.[0]?.message?.content || "").trim().substring(0, 100);
  } catch { return ""; }
}

// ─── Main ───────────────────────────────────────────────────────────────────
let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", async () => {
  const lots = JSON.parse(data);
  console.log(`📥 Réception de ${lots.length} lots`);

  const db = initDb();

  // Pre-process: fix titles, categories, cities
  let titleFixed = 0, catFixed = 0, visionUsed = 0;

  for (const lot of lots) {
    // 1. Title extraction from description if empty
    if ((!lot.title || lot.title.length < 5) && (!lot.clean_title || lot.clean_title.length < 5)) {
      const extracted = extractTitleFromDesc(lot.description);
      if (extracted) {
        lot.clean_title = extracted;
        titleFixed++;
      }
    }

    // 2. Fix category
    const fixedCat = fixCategory(lot);
    if (fixedCat !== lot.category) {
      lot.category = fixedCat;
      catFixed++;
    }

    // 3. Normalize city/postcode
    normalizeCity(lot);
  }

  // 4. Vision for high-value lots without any title (> 500€ estimation)
  if (OPENAI_KEY) {
    const noTitle = lots.filter(l => (!l.title || l.title.length < 5) && (!l.clean_title || l.clean_title.length < 5) && l.thumb && (l.estimate_high || 0) > 500);
    console.log(`  👁️ ${noTitle.length} lots sans titre > 500€ — vision IA...`);
    for (const lot of noTitle.slice(0, 20)) { // Max 20 per run
      const title = await visionTitle(lot.thumb);
      if (title && title.length > 3) {
        lot.clean_title = title;
        visionUsed++;
      }
    }
  }

  // Insert/update
  const upsert = db.prepare(`
    INSERT INTO lots (
      id, title, clean_title, description, category, category_id,
      sold, price, estimate_low, estimate_high, starting_price, commission_rate,
      sale_date, sale_id, org_name, org_email, org_phone, org_address,
      city, postcode, slug, thumb, photos, updated_at
    ) VALUES (
      @id, @title, @clean_title, @description, @category, @category_id,
      @sold, @price, @estimate_low, @estimate_high, @starting_price, @commission_rate,
      @sale_date, @sale_id, @org_name, @org_email, @org_phone, @org_address,
      @city, @postcode, @slug, @thumb, @photos, datetime('now')
    ) ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(NULLIF(excluded.title,''), lots.title),
      clean_title = COALESCE(NULLIF(excluded.clean_title,''), lots.clean_title),
      description = COALESCE(NULLIF(excluded.description,''), lots.description),
      category = COALESCE(NULLIF(excluded.category,''), lots.category),
      sold = excluded.sold,
      price = COALESCE(excluded.price, lots.price),
      city = COALESCE(NULLIF(excluded.city,''), lots.city),
      postcode = COALESCE(NULLIF(excluded.postcode,''), lots.postcode),
      thumb = COALESCE(NULLIF(excluded.thumb,''), lots.thumb),
      photos = COALESCE(NULLIF(excluded.photos,'[]'), lots.photos),
      -- Re-score when a placeholder title is replaced by a substantially richer one
      -- (auction houses publish lots early with a category-only title, then fill in
      -- make/model later). Resetting score=-1 + ai_title=NULL re-queues AI scoring
      -- and makes the page fall back to the real clean_title meanwhile.
      ai_deal_score = CASE WHEN NULLIF(excluded.clean_title,'') IS NOT NULL
        AND length(excluded.clean_title) > length(COALESCE(lots.clean_title,'')) + 10
        THEN -1 ELSE lots.ai_deal_score END,
      ai_title = CASE WHEN NULLIF(excluded.clean_title,'') IS NOT NULL
        AND length(excluded.clean_title) > length(COALESCE(lots.clean_title,'')) + 10
        THEN NULL ELSE lots.ai_title END,
      updated_at = datetime('now')
  `);

  let inserted = 0, updated = 0;
  const insertMany = db.transaction((items) => {
    for (const lot of items.filter(l => l.id)) {
      // Skip lots without any content
      if ((!lot.title || lot.title.length < 3) && (!lot.clean_title || lot.clean_title.length < 3) && (!lot.thumb)) continue;
      const existing = db.prepare("SELECT id FROM lots WHERE id = ?").get(lot.id);
      upsert.run({ ...lot, photos: JSON.stringify(lot.photos || []) });
      if (existing) updated++; else inserted++;
    }
  });

  insertMany(lots);

  const stats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN sold=1 THEN 1 ELSE 0 END) as sold_count, SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) as unsold_count FROM lots").get();

  console.log(`✅ ${inserted} insérés, ${updated} mis à jour`);
  console.log(`  📝 ${titleFixed} titres extraits de la description`);
  console.log(`  📂 ${catFixed} catégories corrigées`);
  if (visionUsed) console.log(`  👁️ ${visionUsed} titres identifiés par vision IA`);
  console.log(`📊 Base: ${stats.total} lots (${stats.sold_count} vendus, ${stats.unsold_count} invendus)`);

  db.close();
});
