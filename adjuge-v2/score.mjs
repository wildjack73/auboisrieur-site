#!/usr/bin/env node
import fs from "fs";
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
    const r = execSync(`curl -s --max-time 10 "https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&filter=deliveryCountry:FR&sort=-price&limit=5&filter=deliveryCountry:FR,price:[50..]" -H "Authorization: Bearer ${token}" -H "X-EBAY-C-MARKETPLACE-ID: EBAY_FR"`, { encoding: "utf-8", maxBuffer: 5e6 });
    return (JSON.parse(r).itemSummaries || []).filter(i => i.price?.value).map(i => ({
      title: (i.title || "").substring(0, 80),
      price: parseFloat(i.price.value),
      condition: i.condition || "",
    }));
  } catch { return []; }
}


// ─── Source 3: DataForSEO Google Shopping ────────────────────────────────────
const DFSE_LOGIN = process.env.DATAFORSEO_LOGIN || "";
const DFSE_PASS = process.env.DATAFORSEO_PASSWORD || "";

function searchGoogleShopping(title) {
  if (!DFSE_LOGIN || !DFSE_PASS) return [];
  const auth = Buffer.from(DFSE_LOGIN + ":" + DFSE_PASS).toString("base64");
  const query = (title || "").substring(0, 80).replace(/['"]/g, "");
  const body = JSON.stringify([{
    keyword: query,
    location_code: 2250, // France
    language_code: "fr",
    depth: 10
  }]);
  try {
    const tmpFile = "/tmp/dfs_" + Date.now() + ".json";
    fs.writeFileSync(tmpFile, body);
    const r = execSync(`curl -s --max-time 15 -X POST "https://api.dataforseo.com/v3/merchant/google/products/task_post" -H "Authorization: Basic ${auth}" -H "Content-Type: application/json" -d @${tmpFile}`, { encoding: "utf-8", maxBuffer: 5e6 });
    fs.unlinkSync(tmpFile);
    const data = JSON.parse(r);
    if (data.tasks?.[0]?.result?.[0]?.items) {
      return data.tasks[0].result[0].items
        .filter(i => i.price && i.price > 0)
        .slice(0, 5)
        .map(i => ({
          title: (i.title || "").substring(0, 80),
          price: i.price,
          source: i.seller || i.source || "",
          condition: i.product_condition || "",
        }));
    }
    return [];
  } catch { return []; }
}

// ─── AI: full enrichment in ONE call ─────────────────────────────────────────

function callAIText(prompt) {
  if (!OPENAI_KEY) return "";
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 100,
  });
  const tmpFile = "/tmp/ai_text_" + Date.now() + ".json";
  fs.writeFileSync(tmpFile, body);
  try {
    const r = execSync(`curl -s --max-time 15 -X POST "https://api.openai.com/v1/chat/completions" -H "Authorization: Bearer ${OPENAI_KEY}" -H "Content-Type: application/json" -d @${tmpFile}`, { encoding: "utf-8", maxBuffer: 5e6 });
    fs.unlinkSync(tmpFile);
    return (JSON.parse(r).choices?.[0]?.message?.content || "").trim();
  } catch (e) { try { fs.unlinkSync(tmpFile); } catch {} return ""; }
}

function callAI(prompt) {
  if (!OPENAI_KEY) return null;
  const escaped = JSON.stringify(prompt);
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
    max_tokens: 3500,
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
    ORDER BY sale_date DESC, estimate_high DESC LIMIT ?
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

  const PARALLEL = 10;
  async function processLot(lot, idx, total) {
    
    try {
      const shortTitle = (lot.clean_title || "Objet").substring(0, 60);
      process.stdout.write(`  ${done + 1}/${toEnrich.length} ${shortTitle}... `);

      // Gather market data — always search eBay (free, 5000 req/day)
      const similar = searchSimilarSold(db, lot);
      // ── PASS 1: AI identifies the product ──
      const identifyPrompt = `Identifie précisément cet objet invendu aux enchères. Réponds en UNE LIGNE avec : marque, modèle exact, année si possible.\nDescription: ${(lot.description || lot.clean_title || "").substring(0, 400)}\nCatégorie: ${lot.category || "?"}`;
      const identified = callAIText(identifyPrompt);
      const searchTerm = (identified || lot.clean_title || "").substring(0, 80).replace(/[\n\r"]/g, "");

      // ── COLLECT DATA with identified name ──
      const ebayResults = searchEbay(searchTerm);
      const shopResults = searchGoogleShopping(searchTerm);
      const avgShop = shopResults.length ? Math.round(shopResults.reduce((s, r) => s + r.price, 0) / shopResults.length) : 0;
      const avgSold = similar.length ? Math.round(similar.reduce((s, r) => s + r.price, 0) / similar.length) : 0;
      const avgEbay = ebayResults.length ? Math.round(ebayResults.reduce((s, r) => s + r.price, 0) / ebayResults.length) : 0;

      // Build AI prompt
      const prompt = `Tu es un analyste expert en enchères françaises et en évaluation d'objets.
Tu reçois un lot invendu avec TOUTES les données collectées : description originale, prix eBay, prix Google Shopping, ventes passées similaires.
ANALYSE TOUTES CES SOURCES pour donner un score précis. Génère une fiche produit et évalue si ce lot invendu est une bonne affaire.

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

${shopResults.length ? `PRIX GOOGLE SHOPPING:
${shopResults.map(r => `- ${r.title}: ${r.price}€ (${r.source}${r.condition ? ', ' + r.condition : ''})`).join("\n")}
Prix moyen Google: ${formatPrice(avgShop)} €` : ""}

${ebayResults.length ? `PRIX EBAY (occasion):
${ebayResults.map(r => `- ${r.title}: ${r.price}€ (${r.condition})`).join("\n")}
Prix moyen eBay: ${formatPrice(avgEbay)} €` : ""}

RÈGLES STRICTES POUR LE DEAL SCORE — le score mesure la DÉCOTE entre le prix marché réel et l'estimation enchère :
- 0 (Sans intérêt) : prix marché INCONNU ou prix marché ≤ 1.1x estimation → pas de décote significative.
- 1 (Bonne affaire) : prix marché = 1.1x à 1.25x estimation → décote ~10%
- 2 (Super affaire) : prix marché = 1.25x à 1.5x estimation → décote 10-25%
- 3 (Exceptionnelle) : prix marché > 1.5x estimation → décote > 25%
IMPORTANT — RÈGLES DE SCORING :
- Score 0 PAR DÉFAUT pour les objets génériques (lot de vaisselle, meuble sans marque, objet courant).
- Score 1+ si tu as des DONNÉES MARCHÉ ci-dessus (eBay, Google, ventes similaires) OU si l'objet est d'une MARQUE CONNUE dont tu connais la cote (Rolex, Cartier, BMW, Hermès, Leica, etc.).
- Pour les objets de marque : tu peux utiliser tes connaissances du marché pour estimer le prix. Une Rolex Submariner estimée 15 000€ vaut 25-35 000€ = score 2.
- Pour les objets SANS marque connue et SANS données marché : score 0 obligatoire.
- Un invendu n'est PAS automatiquement une bonne affaire — sois sélectif.
- L'estimation enchère est souvent proche du prix marché pour les objets courants.
- Objectif : ~60% score 0, ~25% score 1, ~10% score 2, ~5% score 3.

Réponds en JSON strict:
{
  "title": "Titre SEO propre (max 70 car). Marque + modèle + caractéristique principale. Pas de numéro de lot ni immat.",
  "desc": "Description TRÈS DÉTAILLÉE 8-12 phrases (max 1000 car). RÉÉCRIS la description brute en français soigné puis ENRICHIS avec tes connaissances : marque, modèle exact, matériaux, dimensions, époque, cote marché, historique du produit, points forts/faibles. Pour véhicules : motorisation, puissance, consommation, options connues du modèle. Style expert passionné qui INFORME et donne ENVIE.",
  "deal_score": 0,
  "deal_analysis": "2-3 phrases. Compare estimation vs prix marché avec des chiffres. Si score=0, explique pourquoi ce n'est pas une affaire.",
  "market_price": 0,
  "faq": [
    {"q": "Combien coûte [MARQUE MODÈLE] d'occasion ?", "a": "Prix marché occasion réel avec fourchette (max 250 car)"},
    {"q": "Où trouver [MARQUE MODÈLE] pas cher ?", "a": "Mentionner enchères invendues comme source alternative moins chère"},
    {"q": "[MARQUE MODÈLE] avis et fiabilité", "a": "Points forts/faibles, retours d'expérience connus"},
    {"q": "Comment acheter un invendu aux enchères ?", "a": "Processus concret : contacter la maison, négocier, frais"},
    {"q": "[Question prix/cote naturelle]", "a": "Réponse avec chiffres réels"},
    {"q": "[Question pratique que poserait un vrai acheteur]", "a": "Réponse utile et factuelle"},
    {"q": "[Question comparaison avec produit similaire]", "a": "Comparer avec alternatives du marché"},
    {"q": "Quels frais prévoir pour acheter aux enchères ?", "a": "Frais acheteur 20-30%, enlèvement, transport"}
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
          ai_price_analysis: (Number(ai.market_price) > 0) ? `Prix marché estimé : ~${formatPrice(Number(ai.market_price))} €` : "",
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

  // Process in parallel batches of 10
  for (let i = 0; i < toEnrich.length; i += PARALLEL) {
    const batch = toEnrich.slice(i, i + PARALLEL);
    await Promise.all(batch.map((lot, j) => processLot(lot, i + j, toEnrich.length)));
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
