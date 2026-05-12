// Logique d'audit : orchestration + analyse de texte / statistiques.
import config from "./config.mjs";
import dataforseo from "./providers/dataforseo.mjs";
import valueserp from "./providers/valueserp.mjs";
import { analyzeImages, visionConfigured } from "./vision.mjs";

const PROVIDERS = { dataforseo, valueserp };

// ── Analyse de texte (français) ─────────────────────────────────────────────
const STOPWORDS = new Set(`au aux avec ce ces dans de des du elle en et eux il
ils je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou
où par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos
votre vous c d j l à m n s t y été être avoir fait faire plus moins très bien
aussi alors comme donc car ni si sans sous chez entre vers depuis pendant avant
après tout tous toute toutes autre autres aucun aucune chaque cette cet
notamment ainsi afin déjà encore toujours jamais ici là est sont a ont avez
sommes êtes suis es est the and for you your our with that this from`.split(/\s+/));

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9àâäéèêëîïôöùûüç' -]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return normalize(s).split(" ").filter(w => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

// Compte les mots et les bigrammes sur un ensemble de documents.
// Le compte est "documents distincts contenant le terme" (plus parlant pour le SEO).
function keywordStats(docs) {
  const unigram = new Map();
  const bigram = new Map();
  let nonEmpty = 0;
  for (const doc of docs) {
    if (!doc || !doc.trim()) continue;
    nonEmpty++;
    const toks = tokenize(doc);
    const seenU = new Set(), seenB = new Set();
    for (let i = 0; i < toks.length; i++) {
      if (!seenU.has(toks[i])) { seenU.add(toks[i]); unigram.set(toks[i], (unigram.get(toks[i]) || 0) + 1); }
      if (i + 1 < toks.length) {
        const bg = toks[i] + " " + toks[i + 1];
        if (!seenB.has(bg)) { seenB.add(bg); bigram.set(bg, (bigram.get(bg) || 0) + 1); }
      }
    }
  }
  const top = (m, n) => [...m.entries()]
    .map(([term, count]) => ({ term, count, pct: nonEmpty ? Math.round((count / nonEmpty) * 100) : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, n);
  return { documents: nonEmpty, unigrams: top(unigram, 40), bigrams: top(bigram, 25) };
}

function numberStats(values) {
  const v = values.filter(x => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return {
    count: v.length,
    min: v[0], max: v[v.length - 1],
    avg: Math.round((sum / v.length) * 100) / 100,
    median: q(0.5), p25: q(0.25), p75: q(0.75),
  };
}

// Catégories d'une fiche, normalisées sous la forme [principale, ...secondaires].
function bizCategories(b) {
  const list = [];
  if (b.category) list.push(String(b.category).trim());
  for (const c of (b.categories || [])) { const s = String(c).trim(); if (s) list.push(s); }
  return [...new Set(list.filter(Boolean))];
}

// Poids d'une fiche selon sa position dans le top N : le #1 pèse plus que le #N.
// (#1 → topN, #2 → topN-1, … #N → 1). Une fiche sans rang connu vaut 1.
function rankWeight(rank, topN) {
  const r = Number.isFinite(rank) ? rank : topN;
  return Math.max(1, topN - r + 1);
}

// Catégories du top N, prises isolément, pondérées par la position.
function weightedCategoryTally(businesses, topN) {
  const m = new Map(); // cat -> { score, fiches }
  for (const b of businesses) {
    const w = rankWeight(b.rank, topN);
    for (const c of bizCategories(b)) {
      const e = m.get(c) || { score: 0, fiches: 0 };
      e.score += w; e.fiches += 1; m.set(c, e);
    }
  }
  const total = [...m.values()].reduce((s, e) => s + e.score, 0) || 1;
  return [...m.entries()]
    .map(([term, e]) => ({ term, count: e.score, fiches: e.fiches, pct: Math.round((e.score / total) * 100) }))
    .sort((a, b) => b.count - a.count).slice(0, 25);
}

// Reproduit la logique du bot ZennoPoster, en pondérant par la position :
// on compte les COMBINAISONS exactes de catégories (principale + secondaires)
// du top N, chaque fiche apportant un poids fonction de son rang, et on
// recommande la combinaison au score le plus élevé.
function categoryComboAnalysis(businesses, topN) {
  const combos = new Map(); // "Cat A; Cat B" -> { score, fiches }
  let withCats = 0;
  for (const b of businesses) {
    const cats = bizCategories(b);
    if (!cats.length) continue;
    withCats++;
    const w = rankWeight(b.rank, topN);
    const key = cats.join("; ");
    const e = combos.get(key) || { score: 0, fiches: 0 };
    e.score += w; e.fiches += 1; combos.set(key, e);
  }
  const total = [...combos.values()].reduce((s, e) => s + e.score, 0) || 1;
  const sorted = [...combos.entries()]
    .map(([combo, e]) => ({ combo, count: e.score, fiches: e.fiches, pct: Math.round((e.score / total) * 100) }))
    .sort((a, b) => b.count - a.count);
  let recommendation = null, mainCategory = null, secondaryCategories = [];
  if (sorted.length) {
    const parts = sorted[0].combo.split(";").map(s => s.trim()).filter(Boolean);
    mainCategory = parts[0] || null;
    secondaryCategories = parts.slice(1);
    recommendation = secondaryCategories.length
      ? `Catégorie principale à utiliser : ${mainCategory} — et catégories secondaires à utiliser : ${secondaryCategories.join(", ")}.`
      : `Catégorie principale à utiliser : ${mainCategory} — sans catégories secondaires recommandées.`;
  }
  return {
    weighting: `position : #1 = ${topN} pts … #${topN} = 1 pt`,
    businessesWithCategories: withCats,
    combos: sorted.slice(0, 25),
    mainCategory, secondaryCategories, recommendation,
  };
}

// ── Audit principal ─────────────────────────────────────────────────────────
// opts: { keyword, cities[], topN, providerName, withReviews, withVision, onProgress }
export async function runAudit(opts) {
  const {
    keyword, cities, topN = 3,
    providerName = config.defaultProvider,
    withReviews = false, withVision = false,
    onProgress = () => {},
  } = opts;

  if (!keyword || !keyword.trim()) throw new Error("Mot-clé (métier) requis.");
  if (!Array.isArray(cities) || !cities.length) throw new Error("Liste de villes requise.");
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Fournisseur inconnu : ${providerName}`);

  const limitedCities = cities.slice(0, config.maxCitiesPerAudit);
  const businesses = [];
  const errors = [];
  let done = 0;

  for (const city of limitedCities) {
    onProgress({ phase: "serp", city, done, total: limitedCities.length });
    try {
      const top = await provider.localPack(keyword, city, topN);
      for (const biz of top) {
        let enriched = biz;
        try { enriched = await provider.businessInfo(biz); } catch (e) { /* keep base */ }
        businesses.push(enriched);
      }
    } catch (e) {
      errors.push({ city, error: String(e.message || e) });
    }
    done++;
    onProgress({ phase: "serp", city, done, total: limitedCities.length });
  }

  // Avis (optionnel, borné aux 30 premières fiches pour limiter le coût/temps)
  if (withReviews) {
    const subset = businesses.slice(0, 30);
    let i = 0;
    for (const biz of subset) {
      onProgress({ phase: "reviews", done: i, total: subset.length, name: biz.name });
      try {
        const rv = await provider.reviews(biz);
        if (rv?.length) biz.reviews = rv;
      } catch { /* skip */ }
      i++;
    }
  }

  // Vision (optionnel)
  let visionAgg = null;
  if (withVision && visionConfigured()) {
    const withImgs = businesses.filter(b => b.images?.length).slice(0, 25);
    const labels = new Map();
    let analyzed = 0, i = 0;
    for (const biz of withImgs) {
      onProgress({ phase: "vision", done: i, total: withImgs.length, name: biz.name });
      const r = await analyzeImages(biz.images);
      analyzed += r.analyzed;
      for (const [k, v] of Object.entries(r.labels)) labels.set(k, (labels.get(k) || 0) + v);
      i++;
    }
    visionAgg = {
      imagesAnalyzed: analyzed,
      businessesAnalyzed: withImgs.length,
      topObjects: [...labels.entries()].map(([term, count]) => ({ term, count }))
        .sort((a, b) => b.count - a.count).slice(0, 30),
    };
  }

  // ── Agrégations ───────────────────────────────────────────────────────────
  const descriptions = businesses.map(b => b.description).filter(Boolean);
  const snippets = businesses.map(b => b.snippet).filter(Boolean);
  const reviewTexts = businesses.flatMap(b => (b.reviews || []).map(r => r.text)).filter(Boolean);

  const report = {
    keyword,
    provider: providerName,
    topN,
    generatedAt: new Date().toISOString(),
    cities: { requested: limitedCities.length, withResults: limitedCities.length - errors.length },
    businesses: { total: businesses.length, withDescription: descriptions.length, withReviewsText: businesses.filter(b => b.reviews?.length).length },
    errors,
    stats: {
      rating: numberStats(businesses.map(b => b.rating)),
      reviewsCount: numberStats(businesses.map(b => b.reviewsCount)),
      photosCount: numberStats(businesses.map(b => b.photosCount)),
      descriptionLength: numberStats(descriptions.map(d => d.length)),
    },
    categories: weightedCategoryTally(businesses, topN),
    categoryCombos: categoryComboAnalysis(businesses, topN),
    descriptionKeywords: keywordStats(descriptions),
    snippetKeywords: keywordStats(snippets),
    reviewKeywords: keywordStats(reviewTexts),
    vision: visionAgg,
    sample: businesses.slice(0, 50).map(b => ({
      name: b.name, city: b.city, rank: b.rank, rating: b.rating,
      reviewsCount: b.reviewsCount, category: b.category,
      description: b.description ? b.description.slice(0, 300) : null,
    })),
  };

  // Recommandations dérivées
  report.recommendations = buildRecommendations(report);
  return report;
}

function buildRecommendations(r) {
  const recs = [];
  if (r.stats.reviewsCount) {
    recs.push(`Viser au moins ${r.stats.reviewsCount.median} avis (médiane du top ${r.topN}), idéalement ${r.stats.reviewsCount.p75}+ pour passer devant la majorité.`);
  }
  if (r.stats.rating) {
    recs.push(`Note moyenne du top ${r.topN} : ${r.stats.rating.avg}/5 — rester au-dessus de ${r.stats.rating.p25}/5.`);
  }
  if (r.stats.descriptionLength) {
    recs.push(`Rédiger une description d'environ ${r.stats.descriptionLength.median} caractères (médiane observée).`);
  }
  const kw = r.descriptionKeywords.unigrams.slice(0, 8).map(k => k.term).join(", ");
  if (kw) recs.push(`Intégrer ces mots-clés dans la description : ${kw}.`);
  const bg = r.descriptionKeywords.bigrams.slice(0, 5).map(k => k.term).join(" / ");
  if (bg) recs.push(`Expressions fréquentes dans le top ${r.topN} : ${bg}.`);
  if (r.categoryCombos?.recommendation) recs.push(r.categoryCombos.recommendation);
  else if (r.categories.length) recs.push(`Catégorie principale à privilégier : « ${r.categories[0].term} ».`);
  if (r.vision?.topObjects?.length) {
    recs.push(`Types de photos les plus présents dans le top ${r.topN} : ${r.vision.topObjects.slice(0, 6).map(o => o.term).join(", ")}.`);
  }
  return recs;
}

export default { runAudit };
