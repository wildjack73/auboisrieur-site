// Logique d'audit : orchestration + analyse de texte / statistiques.
import config from "./config.mjs";
import dataforseo from "./providers/dataforseo.mjs";
import valueserp from "./providers/valueserp.mjs";
import { analyzeImages, visionConfigured } from "./vision.mjs";
import serpapi from "./serpapi.mjs";
import { translate, translateConfigured } from "./translate.mjs";

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

// Aide à la rédaction de la description : à partir des mots-clés des
// descriptions du top N, on classe les mots en "à mettre impérativement",
// "recommandés", "optionnels", on liste les expressions à reprendre, et on
// génère un modèle de description prêt à adapter.
function descriptionGuide(dk, keyword, lengthStats) {
  if (!dk || !dk.documents) return null;
  const u = dk.unigrams || [], b = dk.bigrams || [];
  const mustUse = u.filter(x => x.pct >= 60);
  const recommended = u.filter(x => x.pct >= 30 && x.pct < 60);
  const optional = u.filter(x => x.pct >= 15 && x.pct < 30);
  const phrases = b.filter(x => x.pct >= 20);
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const words = [...new Set([...mustUse, ...recommended].map(x => x.term))].slice(0, 12);
  const draftParts = [
    `${cap(keyword)} — [votre nom], à [votre ville].`,
    words.length ? `Nos services : ${words.join(", ")}.` : "",
    phrases.slice(0, 3).map(p => cap(p.term) + ".").join(" "),
    "Devis gratuit, intervention rapide. Contactez-nous dès aujourd'hui.",
  ].filter(Boolean);
  return {
    documents: dk.documents,
    targetLength: lengthStats ? { median: lengthStats.median, p25: lengthStats.p25, p75: lengthStats.p75 } : null,
    mustUse, recommended, optional, phrases,
    draft: draftParts.join(" "),
  };
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

// Faut-il mettre le mot-clé dans le NOM de la fiche ? On regarde quelle part
// des fiches du top N contient la requête (ex. "expert-comptable") dans leur
// titre Google, globalement et par position.
function titleKeywordAnalysis(businesses, keyword, topN) {
  const kwTokens = tokenize(keyword);
  const kwNorm = normalize(keyword).replace(/-/g, " ").replace(/\s+/g, " ").trim();
  let withTitle = 0, hits = 0, anyToken = 0;
  const perRank = new Map(); // rank -> { n, withKw }
  const examples = { with: [], without: [] };
  for (const b of businesses) {
    if (!b.name) continue;
    withTitle++;
    const tNorm = normalize(b.name).replace(/-/g, " ").replace(/\s+/g, " ").trim();
    const tTokens = new Set(tokenize(b.name));
    const matched = kwTokens.filter(t => tTokens.has(t));
    const hasAll = (kwNorm && tNorm.includes(kwNorm)) || (kwTokens.length > 0 && matched.length === kwTokens.length);
    if (matched.length) anyToken++;
    if (hasAll) hits++;
    const r = Number.isFinite(b.rank) ? b.rank : topN;
    const e = perRank.get(r) || { n: 0, withKw: 0 }; e.n++; if (hasAll) e.withKw++; perRank.set(r, e);
    const bucket = hasAll ? examples.with : examples.without;
    if (bucket.length < 8) bucket.push(`${b.name} (${b.city})`);
  }
  const pct = n => withTitle ? Math.round((n / withTitle) * 100) : 0;
  const p = pct(hits);
  let recommendation = null;
  if (withTitle) {
    if (p >= 60) recommendation = `${p}% des fiches du top ${topN} ont « ${keyword} » dans le nom de la fiche → conseillé de l'intégrer au nom (en restant réaliste : Google sanctionne le name stuffing).`;
    else if (p >= 25) recommendation = `${p}% des fiches du top ${topN} ont « ${keyword} » dans le nom → optionnel, ça peut aider mais ce n'est pas déterminant ici.`;
    else recommendation = `Seulement ${p}% des fiches du top ${topN} ont « ${keyword} » dans le nom → pas nécessaire de l'ajouter au nom de ta fiche.`;
  }
  return {
    businessesWithTitle: withTitle,
    keywordInTitlePct: p,
    anyTokenPct: pct(anyToken),
    byRank: [...perRank.entries()].map(([rank, v]) => ({ rank, n: v.n, withKw: v.withKw, pct: v.n ? Math.round((v.withKw / v.n) * 100) : 0 })).sort((a, b) => a.rank - b.rank),
    examples,
    recommendation,
  };
}

// Aide "sémantique des avis" : à partir des chips Google (place topics) et des
// mots du texte des avis, on liste les mots à reprendre dans les réponses aux
// avis (et à suggérer aux clients), avec un modèle de réponse.
function reviewSemanticGuide(reviewTopics, reviewKeywords, keyword) {
  const topics = (reviewTopics?.topics || []).filter(t => t.term && t.term.length >= 3);
  const textWords = (reviewKeywords?.unigrams || []).filter(x => x.term.length >= 4);
  if (!topics.length && !textWords.length) return null;
  const mustMention = topics.slice(0, 10).map(t => ({ term: t.term, count: t.count }));
  const alsoUseful = topics.slice(10, 24).map(t => t.term);
  const fromReviewText = textWords.slice(0, 15).map(x => x.term);
  const words = [...new Set([...mustMention.map(m => m.term), ...fromReviewText])].slice(0, 12);
  const responseTemplate =
    `Bonjour [prénom], merci beaucoup pour votre avis et votre confiance ! ` +
    `Toute l'équipe est ravie que votre expérience ait été à la hauteur` +
    (words.length ? ` — ${words.slice(0, 4).join(", ")} font partie de ce qui nous tient à cœur` : "") +
    `. Au plaisir de vous accueillir à nouveau. [Signature, ${keyword}]`;
  return { mustMention, alsoUseful, fromReviewText, words, responseTemplate };
}

// Mots-clés des avis selon Google ("place topics") : Google associe à chaque
// fiche des sujets fréquemment mentionnés dans les avis, avec un nombre de
// mentions. On somme ces mentions sur tout le top N (comme le bot ZennoPoster).
function placeTopicsAnalysis(businesses) {
  const m = new Map(); // term -> { mentions, fiches }
  let withTopics = 0;
  for (const b of businesses) {
    const topics = b.placeTopics || [];
    if (topics.length) withTopics++;
    for (const t of topics) {
      const e = m.get(t.term) || { mentions: 0, fiches: 0 };
      e.mentions += (Number(t.count) || 0); e.fiches += 1; m.set(t.term, e);
    }
  }
  const total = [...m.values()].reduce((s, e) => s + e.mentions, 0) || 1;
  return {
    businessesWithTopics: withTopics,
    topics: [...m.entries()]
      .map(([term, e]) => ({ term, count: e.mentions, fiches: e.fiches, pct: Math.round((e.mentions / total) * 100) }))
      .sort((a, b) => b.count - a.count).slice(0, 40),
  };
}

// Sites de citations / annuaires : domaines qui ressortent dans les SERP
// organiques de "<métier> <ville>". On compte dans combien de villes chaque
// domaine apparaît → les annuaires où il faut être présent pour ce métier.
function citationsAnalysis(byCity) {
  const citiesScanned = byCity.length;
  const m = new Map(); // domain -> { cities:Set, occ, bestRank, sampleUrl, title }
  for (const { city, items } of byCity) {
    for (const it of items) {
      if (!it.domain) continue;
      const e = m.get(it.domain) || { cities: new Set(), occ: 0, bestRank: Infinity, sampleUrl: null, title: null };
      e.cities.add(city); e.occ++;
      if (Number.isFinite(it.rank) && it.rank < e.bestRank) e.bestRank = it.rank;
      if (!e.sampleUrl && it.url) e.sampleUrl = it.url;
      if (!e.title && it.title) e.title = it.title;
      m.set(it.domain, e);
    }
  }
  const domains = [...m.entries()].map(([domain, e]) => ({
    domain, count: e.cities.size, occurrences: e.occ,
    pct: citiesScanned ? Math.round((e.cities.size / citiesScanned) * 100) : 0,
    bestRank: Number.isFinite(e.bestRank) ? e.bestRank : null,
    sampleUrl: e.sampleUrl, title: e.title,
  })).sort((a, b) => b.count - a.count || a.bestRank - b.bestRank || b.occurrences - a.occurrences);
  return { citiesScanned, domains: domains.slice(0, 60), mustSubmit: domains.filter(d => d.pct >= 50).slice(0, 30) };
}

// ── Audit principal ─────────────────────────────────────────────────────────
// opts: { keyword, cities[], topN, providerName, withReviews, withVision, withCitations, onProgress }
export async function runAudit(opts) {
  const {
    keyword, cities, topN = 3,
    providerName = config.defaultProvider,
    withReviews = false, withVision = false, withCitations = false,
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
        // Mots-clés des avis ("place topics") : seul DataForSEO les expose →
        // si un autre fournisseur est utilisé mais DataForSEO est configuré,
        // on complète la fiche avec ses place_topics.
        if (providerName !== "dataforseo" && dataforseo.configured() && enriched.cid && !(enriched.placeTopics?.length)) {
          try {
            const d = await dataforseo.businessInfo(enriched);
            if (d.placeTopics?.length) enriched = { ...enriched, placeTopics: d.placeTopics, description: enriched.description || d.description };
          } catch { /* skip */ }
        }
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

  // Citations / annuaires (optionnel) : SERP organique par ville
  let citations = null;
  if (withCitations && typeof provider.organicResults === "function") {
    const byCity = [];
    let i = 0;
    for (const city of limitedCities) {
      onProgress({ phase: "citations", done: i, total: limitedCities.length, city });
      try { byCity.push({ city, items: await provider.organicResults(keyword, city) }); }
      catch (e) { byCity.push({ city, items: [] }); }
      i++;
    }
    citations = citationsAnalysis(byCity);
  }

  // Photos + Vision (optionnel)
  let visionAgg = null;
  if (withVision && visionConfigured()) {
    const targets = businesses.slice(0, 25);
    // 1) compléter les photos via SerpApi (google_maps_photos) si configuré
    if (serpapi.configured()) {
      let i = 0;
      for (const biz of targets) {
        onProgress({ phase: "photos", done: i, total: targets.length, name: biz.name });
        try {
          const ph = await serpapi.getPlacePhotos(biz.place_id || (biz.cid ? String(biz.cid) : null));
          if (ph.length) biz.images = [...new Set([...(biz.images || []), ...ph])];
        } catch { /* skip */ }
        i++;
      }
    }
    // 2) Vision sur les photos
    const withImgs = targets.filter(b => b.images?.length);
    const O = new Map(), L = new Map(), T = new Map();
    const allImages = []; // { url, objects[], labels[] }
    let imagesAnalyzed = 0, i = 0;
    for (const biz of withImgs) {
      onProgress({ phase: "vision", done: i, total: withImgs.length, name: biz.name });
      const r = await analyzeImages(biz.images, { maxImages: 8 });
      imagesAnalyzed += r.analyzed;
      for (const [k, v] of Object.entries(r.objects)) O.set(k, (O.get(k) || 0) + v);
      for (const [k, v] of Object.entries(r.labels)) L.set(k, (L.get(k) || 0) + v);
      for (const [k, v] of Object.entries(r.texts)) T.set(k, (T.get(k) || 0) + v);
      for (const im of (r.images || [])) if (im?.url) allImages.push(im);
      i++;
    }
    const top = (m, n) => [...m.entries()].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count).slice(0, n);
    let topObjects = top(O, 30), topLabels = top(L, 30);

    // Photos représentatives : on note chaque image selon la fréquence globale
    // des objets (et un peu des labels) qu'elle contient, et on garde les meilleures.
    const seenUrl = new Set();
    let sampleImages = allImages
      .filter(im => (im.objects?.length || im.labels?.length) && !seenUrl.has(im.url) && (seenUrl.add(im.url), true))
      .map(im => ({ ...im, score: (im.objects || []).reduce((s, o) => s + (O.get(o) || 0), 0) + 0.2 * (im.labels || []).reduce((s, l) => s + (L.get(l) || 0), 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 9)
      .map(im => ({ url: im.url, objects: (im.objects || []).slice(0, 4), labels: (im.labels || []).slice(0, 4) }));

    // Vision renvoie les objets/labels en anglais → on constitue d'abord la
    // liste complète (top + légendes des exemples), on dédoublonne, puis une
    // seule traduction (avec cache).
    if (translateConfigured()) {
      onProgress({ phase: "vision", done: withImgs.length, total: withImgs.length, name: "traduction" });
      try {
        const allEn = [...new Set([
          ...topObjects.map(x => x.term), ...topLabels.map(x => x.term),
          ...sampleImages.flatMap(im => [...im.objects, ...im.labels]),
        ])];
        const fr = await translate(allEn);
        const map = new Map(allEn.map((en, k) => [en, fr[k]]));
        const tr = en => { const t = map.get(en); return (t && t.toLowerCase() !== en.toLowerCase()) ? t.toLowerCase() : en; };
        const applyList = arr => arr.map(x => { const t = tr(x.term); return t !== x.term ? { ...x, term: t, original: x.term } : x; });
        topObjects = applyList(topObjects); topLabels = applyList(topLabels);
        sampleImages = sampleImages.map(im => ({ url: im.url, objects: im.objects.map(tr), labels: im.labels.map(tr) }));
      } catch { /* keep en */ }
    }
    visionAgg = {
      imagesAnalyzed, businessesAnalyzed: withImgs.length,
      photosSource: serpapi.configured() ? "SerpApi google_maps_photos + fiches" : "URLs des fiches",
      translated: translateConfigured(),
      topObjects, topLabels,
      topTexts: top(T, 40),
      sampleImages,
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
    titleKeyword: titleKeywordAnalysis(businesses, keyword, topN),
    descriptionKeywords: keywordStats(descriptions),
    snippetKeywords: keywordStats(snippets),
    reviewKeywords: keywordStats(reviewTexts),
    reviewTopics: placeTopicsAnalysis(businesses),
    citations,
    vision: visionAgg,
    sample: businesses.slice(0, 50).map(b => ({
      name: b.name, city: b.city, rank: b.rank, rating: b.rating,
      reviewsCount: b.reviewsCount, category: b.category,
      description: b.description ? b.description.slice(0, 300) : null,
    })),
  };

  report.descriptionGuide = descriptionGuide(report.descriptionKeywords, keyword, report.stats.descriptionLength);
  report.reviewGuide = reviewSemanticGuide(report.reviewTopics, report.reviewKeywords, keyword);

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
  const g = r.descriptionGuide;
  if (g) {
    if (g.targetLength) recs.push(`Rédiger une description d'environ ${g.targetLength.median} caractères (fourchette observée : ${g.targetLength.p25}–${g.targetLength.p75}).`);
    if (g.mustUse.length) recs.push(`Mots à intégrer impérativement dans la description (présents dans ≥ 60 % du top ${r.topN}) : ${g.mustUse.map(x => `${x.term} (${x.pct}%)`).join(", ")}.`);
    if (g.recommended.length) recs.push(`Mots recommandés (≥ 30 %) : ${g.recommended.slice(0, 12).map(x => x.term).join(", ")}.`);
    if (g.phrases.length) recs.push(`Expressions à reprendre : ${g.phrases.slice(0, 6).map(x => x.term).join(" / ")}.`);
  } else if (r.stats.descriptionLength) {
    recs.push(`Rédiger une description d'environ ${r.stats.descriptionLength.median} caractères (médiane observée).`);
  }
  if (r.titleKeyword?.recommendation) recs.push(r.titleKeyword.recommendation);
  if (r.categoryCombos?.recommendation) recs.push(r.categoryCombos.recommendation);
  else if (r.categories.length) recs.push(`Catégorie principale à privilégier : « ${r.categories[0].term} ».`);
  if (r.reviewTopics?.topics?.length) {
    recs.push(`Mots-clés des avis (chips Google) à reprendre dans vos réponses aux avis et à suggérer à vos clients : ${r.reviewTopics.topics.slice(0, 10).map(t => `${t.term} (${t.count})`).join(", ")}.`);
  }
  if (r.citations?.mustSubmit?.length) {
    recs.push(`Annuaires / sites de citations où être présent pour « ${r.keyword} » (apparaissent dans ≥ 50 % des SERP analysées) : ${r.citations.mustSubmit.map(d => d.domain).join(", ")}.`);
  } else if (r.citations?.domains?.length) {
    recs.push(`Principaux annuaires à viser pour « ${r.keyword} » : ${r.citations.domains.slice(0, 10).map(d => d.domain).join(", ")}.`);
  }
  if (r.vision) {
    if (r.vision.topObjects?.length) recs.push(`Objets à faire apparaître en priorité sur vos photos (les plus présents dans le top ${r.topN}) : ${r.vision.topObjects.slice(0, 8).map(o => `${o.term} (${o.count})`).join(", ")}.`);
    if (r.vision.topLabels?.length) recs.push(`Labels / ambiances d'image fréquents : ${r.vision.topLabels.slice(0, 8).map(o => o.term).join(", ")}.`);
    if (r.vision.topTexts?.length) recs.push(`Mots souvent écrits sur les photos du top ${r.topN} : ${r.vision.topTexts.slice(0, 10).map(o => o.term).join(", ")}.`);
  }
  return recs;
}

export default { runAudit };
