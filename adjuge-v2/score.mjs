#!/usr/bin/env node
/**
 * Adjugé v2 — Full Enrichment (runs on VPS)
 * For each unsold lot:
 * 1. Search SQLite for similar sold lots
 * 2. Search eBay for market prices
 * 3. AI: generate title + description + deal score + FAQ in ONE call
 */

import Database from "better-sqlite3";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "adjuge.db");

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const MAX_PER_RUN = parseInt(process.env.SCORE_BUDGET || "50");

function formatPrice(n) { return Number(n || 0).toLocaleString("fr-FR"); }
function sleep(ms) { try { execSync(`sleep ${Math.max(1, Math.ceil(ms / 1000))}`); } catch {} }

// ─── Source 1: SQLite similar sold lots ──────────────────────────────────────
function searchSimilarSold(db, lot) {
  const words = (lot.clean_title || "")
    .replace(/[^a-zA-ZÀ-ÿ0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 4);
  if (!words.length) return [];
  const conds = words.map(w => `clean_title LIKE '%${w.replace(/'/g, "''")}%'`);
  try {
    return db.prepare(`
      SELECT clean_title, price, sale_date, category FROM lots
      WHERE sold = 1 AND price > 0 AND (${conds.join(" OR ")})
      ORDER BY sale_date DESC LIMIT 8
    `).all();
  } catch { return []; }
}

// ─── Source 2: eBay ──────────────────────────────────────────────────────────
let ebayToken = null;
function getEbayToken() {
  if (ebayToken) return ebayToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;
  const auth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  try {
    const r = execSync(`curl -s --max-time 10 -X POST "https://api.ebay.com/identity/v1/oauth2/token" -H "Authorization: Basic ${auth}" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"`, { encoding: "utf-8" });
    ebayToken = JSON.parse(r).access_token;
    return ebayToken;
  } catch (e) { console.error(`  ⚠ eBay auth: ${e.message}`); return null; }
}

function searchEbay(title) {
  const token = getEbayToken();
  if (!token) return [];
  const q = encodeURIComponent(title.substring(0, 50));
  try {
    const r = execSync(`curl -s --max-time 10 "https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&filter=deliveryCountry:FR&sort=price&limit=5" -H "Authorization: Bearer ${token}" -H "X-EBAY-C-MARKETPLACE-ID: EBAY_FR"`, { encoding: "utf-8", maxBuffer: 5e6 });
    return (JSON.parse(r).itemSummaries || []).filter(i => i.price?.value).map(i => ({
      title: (i.title || "").substring(0, 80),
      price: parseFloat(i.price.value),
      condition: i.condition || "",
    }));
  } catch { return []; }
}

// ─── AI: full enrichment in ONE call ─────────────────────────────────────────
function callAI(prompt) {
  if (!OPENAI_KEY) return null;
  const escaped = JSON.stringify(prompt);
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    max_tokens: 800,
  });
  // Write body to temp file to avoid shell escaping issues
  const tmpFile = "/tmp/ai_body.json";
  execSync(`cat > ${tmpFile} << 'AIBODY'\n${body}\nAIBODY`);
  try {
    const r = execSync(`curl -s --max-time 45 -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer ${OPENAI_KEY}" -H "Content-Type: application/json" -d @${tmpFile}`, { encoding: "utf-8", maxBuffer: 5e6 });
    const content = JSON.parse(r).choices?.[0]?.message?.content || "";
    return JSON.parse(content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim());
  } catch (e) { console.error(`  ⚠ AI: ${e.message}`); return null; }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🎯 Adjugé v2 — Enrichissement complet\n");
  const db = new Database(DB_PATH);

  const toEnrich = db.prepare(`
    SELECT * FROM lots WHERE sold = 0 AND (ai_title IS NULL OR ai_deal_score = -1)
    ORDER BY estimate_high DESC NULLS LAST LIMIT ?
  `).all(MAX_PER_RUN);

  console.log(`  📋 ${toEnrich.length} lots à enrichir (budget: ${MAX_PER_RUN})\n`);
  if (!toEnrich.length) { console.log("  ✅ Tout est enrichi"); db.close(); return; }

  const update = db.prepare(`
    UPDATE lots SET
      ai_title = @ai_title, ai_desc = @ai_desc,
      ai_deal_score = @ai_deal_score, ai_deal_analysis = @ai_deal_analysis,
      ai_price_analysis = @ai_price_analysis, ai_faq = @ai_faq,
      updated_at = datetime('now')
    WHERE id = @id
  `);

  let done = 0, errors = 0;

  for (const lot of toEnrich) {
    try {
      const shortTitle = (lot.clean_title || "Objet").substring(0, 60);
      process.stdout.write(`  ${done + 1}/${toEnrich.length} ${shortTitle}... `);

      // Gather market data — always search eBay (free, 5000 req/day)
      const similar = searchSimilarSold(db, lot);
      const ebayResults = searchEbay(lot.clean_title);
      const avgSold = similar.length ? Math.round(similar.reduce((s, r) => s + r.price, 0) / similar.length) : 0;
      const avgEbay = ebayResults.length ? Math.round(ebayResults.reduce((s, r) => s + r.price, 0) / ebayResults.length) : 0;

      // Build AI prompt
      const prompt = `Tu es un analyste expert en enchères françaises. Génère une fiche produit et évalue si ce lot invendu est une bonne affaire.

LOT INVENDU:
Titre brut: ${lot.clean_title}
Description brute: ${(lot.description || "").substring(0, 600)}
Catégorie Interenchères: ${lot.category || "Non classé"}
Estimation enchère: ${lot.estimate_low ? `${formatPrice(lot.estimate_low)} – ${formatPrice(lot.estimate_high)} €` : "Non communiquée"}
Mise à prix: ${lot.starting_price ? `${formatPrice(lot.starting_price)} €` : "Non communiquée"}
Maison: ${lot.org_name || "?"} à ${lot.city || "?"}

${similar.length ? `VENTES SIMILAIRES (notre base enchères):
${similar.slice(0, 5).map(r => `- "${r.clean_title}" → ${formatPrice(r.price)} € (${r.sale_date})`).join("\n")}
Prix moyen enchères: ${formatPrice(avgSold)} €` : ""}

${ebayResults.length ? `PRIX EBAY (occasion):
${ebayResults.map(r => `- ${r.title}: ${r.price}€ (${r.condition})`).join("\n")}
Prix moyen eBay: ${formatPrice(avgEbay)} €` : ""}

RÈGLES STRICTES POUR LE DEAL SCORE — le score mesure la DÉCOTE entre le prix marché réel et l'estimation enchère :
- 0 (Sans intérêt) : prix marché INCONNU ou prix marché ≤ 1.3x estimation → pas de décote significative. SI l'estimation est PROCHE du prix marché, c'est un 0.
- 1 (Bonne affaire) : prix marché = 1.5x à 2x estimation → décote 30-50%
- 2 (Super affaire) : prix marché = 2x à 3x estimation → décote 50-70%
- 3 (Exceptionnelle) : prix marché > 3x estimation → décote > 70%
IMPORTANT : Si tu ne trouves pas de prix marché fiable, mets 0. Ne surestime JAMAIS le score. Une Jeep Avenger estimée 14 000€ qui vaut 15 000€ sur le marché = score 0, PAS 2.

Réponds en JSON strict:
{
  "title": "Titre SEO propre (max 70 car). Marque + modèle + caractéristique principale. Pas de numéro de lot ni immat.",
  "desc": "Description RICHE 4-6 phrases. Identifie précisément l'objet (marque, modèle, matériaux, époque). Apporte des infos UTILES que l'acheteur ne trouve pas dans la description brute. Style expert.",
  "deal_score": 0,
  "deal_analysis": "2-3 phrases. Compare estimation vs prix marché avec des chiffres. Si score=0, explique pourquoi ce n'est pas une affaire.",
  "market_price": 0,
  "faq": [
    {"q": "Question avec le NOM de l'objet?", "a": "Réponse factuelle (max 200 car)"},
    {"q": "Question?", "a": "Réponse"},
    {"q": "Question?", "a": "Réponse"}
  ]
}`;

      const ai = callAI(prompt);

      if (ai) {
        update.run({
          id: lot.id,
          ai_title: (ai.title || lot.clean_title).substring(0, 150),
          ai_desc: (ai.desc || "").substring(0, 800),
          ai_deal_score: Math.min(3, Math.max(0, parseInt(ai.deal_score) || 0)),
          ai_deal_analysis: (ai.deal_analysis || "").substring(0, 500),
          ai_price_analysis: ai.market_price ? `Prix marché estimé : ~${formatPrice(ai.market_price)} €` : "",
          ai_faq: JSON.stringify(ai.faq || []),
        });
        const ds = parseInt(ai.deal_score) || 0;
        console.log(`${["⚪", "🟢", "🔵", "🔥"][ds]} ${ds}/3`);
      } else {
        // Fallback without AI
        update.run({
          id: lot.id,
          ai_title: lot.clean_title,
          ai_desc: null,
          ai_deal_score: 0,
          ai_deal_analysis: "Pas assez de données pour évaluer cette affaire.",
          ai_price_analysis: avgSold ? `Lots similaires vendus ~${formatPrice(avgSold)} €` : "",
          ai_faq: "[]",
        });
        console.log("⚪ 0/3 (fallback)");
      }
      done++;
    } catch (e) {
      console.log(`❌ ${e.message}`);
      errors++;
    }
    sleep(600); // Rate limit: ~100 req/min
  }

  // Stats
  console.log(`\n✅ ${done} enrichis, ${errors} erreurs`);
  const stats = db.prepare(`
    SELECT ai_deal_score as s, COUNT(*) as c FROM lots
    WHERE sold = 0 AND ai_deal_score >= 0 GROUP BY s ORDER BY s
  `).all();
  console.log("\n📊 Scores:");
  for (const s of stats) {
    console.log(`   ${["⚪ Sans intérêt", "🟢 Bonne affaire", "🔵 Super affaire", "🔥 Exceptionnelle"][s.s]}: ${s.c}`);
  }
  db.close();
}

main().catch(e => { console.error("❌", e); process.exit(1); });
