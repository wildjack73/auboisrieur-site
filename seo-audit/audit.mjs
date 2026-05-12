// Logique d'audit : orchestration + analyse de texte / statistiques.
import config from "./config.mjs";
import dataforseo from "./providers/dataforseo.mjs";
import valueserp from "./providers/valueserp.mjs";
import { analyzeImages, visionConfigured } from "./vision.mjs";
import serpapi from "./serpapi.mjs";
import { translate, translateConfigured } from "./translate.mjs";
import haloscan from "./haloscan.mjs";

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
function descriptionGuide(dk, keyword, lengthStats, wordStats) {
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
    targetWords: wordStats ? { median: wordStats.median, p25: wordStats.p25, p75: wordStats.p75 } : null,
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

function nameNorm(s) { return normalize(s).replace(/-/g, " ").replace(/\s+/g, " ").trim(); }
function wordCount(s) { return (String(s || "").trim().match(/\S+/g) || []).length; }

// Statistiques sur le NOM de la fiche : longueur en mots / caractères du top N.
function titleStats(businesses) {
  const names = businesses.map(b => b.name).filter(Boolean);
  return { count: names.length, words: numberStats(names.map(wordCount)), chars: numberStats(names.map(n => n.trim().length)) };
}

// Faut-il mettre le mot-clé (et/ou la ville) dans le NOM de la fiche ?
function titleKeywordAnalysis(businesses, keyword, topN) {
  const kwTokens = tokenize(keyword);
  const kwNorm = nameNorm(keyword);
  let withTitle = 0, hitsKw = 0, hitsCity = 0, hitsBoth = 0, anyToken = 0;
  const perRank = new Map();
  const examples = { with: [], without: [] };
  for (const b of businesses) {
    if (!b.name) continue;
    withTitle++;
    const tNorm = nameNorm(b.name);
    const tTokens = new Set(tokenize(b.name));
    const matched = kwTokens.filter(t => tTokens.has(t));
    const hasKw = (kwNorm && tNorm.includes(kwNorm)) || (kwTokens.length > 0 && matched.length === kwTokens.length);
    // ville : on teste le nom de ville et son premier mot (pour "Saint-…")
    const cNorm = nameNorm(b.city || "");
    const cFirst = cNorm.split(" ")[0] || "";
    const hasCity = !!cNorm && (tNorm.includes(cNorm) || (cFirst.length >= 4 && tNorm.includes(cFirst)));
    if (matched.length) anyToken++;
    if (hasKw) hitsKw++;
    if (hasCity) hitsCity++;
    if (hasKw && hasCity) hitsBoth++;
    const r = Number.isFinite(b.rank) ? b.rank : topN;
    const e = perRank.get(r) || { n: 0, kw: 0, city: 0, both: 0 }; e.n++; if (hasKw) e.kw++; if (hasCity) e.city++; if (hasKw && hasCity) e.both++; perRank.set(r, e);
    const bucket = (hasKw || hasCity) ? examples.with : examples.without;
    if (bucket.length < 8) bucket.push(b.name);
  }
  const pct = n => withTitle ? Math.round((n / withTitle) * 100) : 0;
  const pKw = pct(hitsKw), pCity = pct(hitsCity), pBoth = pct(hitsBoth);
  let recommendation = null;
  if (withTitle) {
    const verdict = pKw >= 60 ? "conseillé de l'intégrer au nom (en restant réaliste : Google sanctionne le name stuffing)"
      : pKw >= 25 ? "optionnel — ça peut aider mais ce n'est pas déterminant ici"
      : "pas nécessaire de l'ajouter au nom";
    recommendation = `${pKw}% des fiches du top ${topN} ont « ${keyword} » dans le nom (${pCity}% ont la ville, ${pBoth}% ont les deux) → ${verdict}.`;
  }
  return {
    businessesWithTitle: withTitle,
    keywordInTitlePct: pKw, cityInTitlePct: pCity, keywordAndCityInTitlePct: pBoth, anyTokenPct: pct(anyToken),
    byRank: [...perRank.entries()].map(([rank, v]) => ({ rank, n: v.n, withKw: v.kw, withCity: v.city, withBoth: v.both, pctKw: v.n ? Math.round((v.kw / v.n) * 100) : 0 })).sort((a, b) => a.rank - b.rank),
    examples,
    recommendation,
  };
}

// Fréquence des avis : à partir des avis récupérés (datés), estimation du
// rythme de nouveaux avis par mois et ancienneté du dernier avis.
function reviewFrequencyAnalysis(businesses) {
  const now = Date.now(), DAY = 86400000, MONTH = 30.44 * DAY, YEAR = 365.25 * DAY;
  const perBiz = [];
  for (const b of businesses) {
    const dates = (b.reviews || []).map(r => Date.parse(r.time)).filter(t => Number.isFinite(t) && t <= now + DAY);
    if (!dates.length) continue;
    dates.sort((a, b) => a - b);
    const first = dates[0], last = dates[dates.length - 1];
    const last12 = dates.filter(t => t >= now - 12 * MONTH).length;
    perBiz.push({
      name: b.name, rank: b.rank,
      lastReviewDays: Math.round((now - last) / DAY),
      ageYears: Math.round(((now - first) / YEAR) * 10) / 10,   // ancienneté ≈ 1er avis connu
      reviewsLast12m: last12, perMonth: Math.round((last12 / 12) * 10) / 10,
    });
  }
  if (!perBiz.length) return null;
  return {
    businessesWithDatedReviews: perBiz.length,
    perMonth: numberStats(perBiz.map(p => p.perMonth)),
    reviewsLast12m: numberStats(perBiz.map(p => p.reviewsLast12m)),
    lastReviewDays: numberStats(perBiz.map(p => p.lastReviewDays)),
    ageYears: numberStats(perBiz.map(p => p.ageYears)),
    perBiz: perBiz.slice(0, 30),
  };
}

// Audit "complétude de la fiche GMB" : revendiquée, attributs cochés, horaires.
function gmbProfileAnalysis(businesses, topN) {
  const claimedKnown = businesses.filter(b => typeof b.claimed === "boolean");
  const claimed = claimedKnown.filter(b => b.claimed).length;
  const attrMap = new Map();
  let withAttrs = 0;
  for (const b of businesses) { const a = b.attributes || []; if (a.length) withAttrs++; for (const x of new Set(a)) attrMap.set(x, (attrMap.get(x) || 0) + 1); }
  const attrBase = withAttrs || businesses.length || 1;
  const attributes = [...attrMap.entries()].map(([term, count]) => ({ term, count, pct: Math.round((count / attrBase) * 100) })).sort((a, b) => b.count - a.count).slice(0, 40);
  const mustHaveAttrs = attributes.filter(a => a.pct >= 50);
  const hw = businesses.map(b => b.workHours).filter(Boolean);
  const hoursPerWeek = numberStats(hw.map(w => w.hoursPerWeek));
  const daysOpen = numberStats(hw.map(w => w.daysOpen));
  const priceLevels = businesses.map(b => b.priceLevel).filter(p => p != null);
  const priceTally = [...priceLevels.reduce((m, p) => m.set(p, (m.get(p) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1]);
  if (!claimedKnown.length && !withAttrs && !hw.length) return null;
  const recParts = [];
  if (claimedKnown.length) recParts.push(`${Math.round((claimed / claimedKnown.length) * 100)}% des fiches du top ${topN} sont revendiquées`);
  if (mustHaveAttrs.length) recParts.push(`attributs à cocher (présents chez ≥ 50 % du top ${topN}) : ${mustHaveAttrs.slice(0, 10).map(a => a.term).join(", ")}`);
  if (hoursPerWeek) recParts.push(`amplitude horaire médiane : ${hoursPerWeek.median} h/sem sur ${daysOpen ? daysOpen.median : "?"} jours — un horaire large aide`);
  return {
    claimedPct: claimedKnown.length ? Math.round((claimed / claimedKnown.length) * 100) : null,
    businessesWithAttributes: withAttrs,
    attributes, mustHaveAttributes: mustHaveAttrs,
    hoursPerWeek, daysOpen,
    commonPriceLevel: priceTally.length ? priceTally[0][0] : null,
    recommendation: recParts.length ? recParts.join(" · ") + "." : null,
  };
}

// Engagement sur les avis : taux de réponse du propriétaire, délai de réponse,
// part d'avis négatifs (≤ 3/5). Calculé sur les avis récupérés (option avis).
function reviewEngagementAnalysis(businesses) {
  let total = 0, answered = 0, neg = 0; const delays = []; const perBiz = [];
  for (const b of businesses) {
    const rv = b.reviews || []; if (!rv.length) continue;
    let bt = 0, ba = 0;
    for (const r of rv) {
      total++; bt++;
      if (r.ownerAnswer) {
        answered++; ba++;
        if (r.time && r.ownerAnswerTime) { const d = (Date.parse(r.ownerAnswerTime) - Date.parse(r.time)) / 86400000; if (Number.isFinite(d) && d >= 0 && d < 400) delays.push(d); }
      }
      if (typeof r.rating === "number" && r.rating <= 3) neg++;
    }
    perBiz.push({ name: b.name, rank: b.rank, reviews: bt, answered: ba, answeredPct: bt ? Math.round((ba / bt) * 100) : 0 });
  }
  if (!total) return null;
  return {
    reviewsAnalyzed: total,
    ownerResponseRate: Math.round((answered / total) * 100),
    negativeReviewsPct: Math.round((neg / total) * 100),
    responseDelayDays: numberStats(delays),
    perBiz: perBiz.slice(0, 30),
  };
}

// Contrôles techniques des sites des fiches : HTTPS, viewport mobile, balisage
// schema.org LocalBusiness. (Récupère la page d'accueil de chaque site.)
const SCHEMA_RE = /"@type"\s*:\s*"\s*([a-z]*\s*business|localbusiness|organization|store|restaurant|professionalservice|dentist|hairsalon|beautysalon|legalservice|accountingservice|financialservice|medicalbusiness|homeandconstructionbusiness|automotivebusiness|foodestablishment|lodgingbusiness|realestateagent|travelagency)\s*"/i;
const SCHEMA_MICRO_RE = /itemtype\s*=\s*["']https?:\/\/schema\.org\/(localbusiness|organization|store|restaurant|[a-z]*business)/i;
async function siteTechAnalysis(domains, onProgress) {
  const list = [...new Set((domains || []).filter(Boolean))].slice(0, 30);
  if (!list.length) return null;
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    onProgress?.({ phase: "sitetech", done: i, total: list.length, name: list[i] });
    const r = { domain: list[i], ok: false, https: null, mobileViewport: null, localBusinessSchema: null };
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(`https://${list[i]}/`, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; ObjectifTop3/1.0)" } });
      clearTimeout(to);
      r.ok = res.ok; r.https = String(res.url || "").startsWith("https://");
      const html = (await res.text()).slice(0, 500000);
      r.mobileViewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html);
      r.localBusinessSchema = SCHEMA_RE.test(html) || SCHEMA_MICRO_RE.test(html);
    } catch { /* injoignable */ }
    rows.push(r);
  }
  const n = rows.length;
  const p = k => Math.round((rows.filter(x => x[k] === true).length / n) * 100);
  return { sitesChecked: n, reachablePct: p("ok"), httpsPct: p("https"), mobilePct: p("mobileViewport"), schemaPct: p("localBusinessSchema"), rows };
}

// Score de référence du top N : à quel point les fiches leaders respectent les
// bonnes pratiques GMB (0–100). Sert de "barre à atteindre" et met en évidence
// les pratiques quasi systématiques chez les leaders.
function referenceChecklist(businesses, report) {
  const checks = [];
  const add = (label, weight, ok, eligible) => {
    const elig = eligible ? businesses.filter(eligible) : businesses;
    if (!elig.length) return;
    checks.push({ label, weight, pct: Math.round((elig.filter(ok).length / elig.length) * 100), base: elig.length });
  };
  add("Fiche revendiquée", 8, b => b.claimed === true, b => typeof b.claimed === "boolean");
  add("Description présente", 6, b => !!(b.description && b.description.trim()));
  add("Description ≥ 250 caractères", 6, b => !!b.description && b.description.trim().length >= 250, b => !!(b.description && b.description.trim()));
  add("≥ 10 photos", 8, b => typeof b.photosCount === "number" && b.photosCount >= 10, b => typeof b.photosCount === "number");
  add("≥ 5 attributs cochés", 6, b => (b.attributes || []).length >= 5);
  add("Horaires renseignés", 6, b => !!(b.workHours && b.workHours.daysOpen >= 1), b => !!b.workHours);
  add("Catégorie(s) secondaire(s)", 6, b => (b.categories || []).filter(Boolean).length >= 1);
  add("Site web renseigné", 8, b => !!b.domain);
  add("Note ≥ 4,5/5", 10, b => typeof b.rating === "number" && b.rating >= 4.5, b => typeof b.rating === "number");
  add("≥ 50 avis", 8, b => typeof b.reviewsCount === "number" && b.reviewsCount >= 50, b => typeof b.reviewsCount === "number");
  add("≥ 100 avis", 6, b => typeof b.reviewsCount === "number" && b.reviewsCount >= 100, b => typeof b.reviewsCount === "number");
  add("Avis récent (< 30 j)", 6, b => { const ds = (b.reviews || []).map(r => Date.parse(r.time)).filter(Number.isFinite); return ds.length && (Date.now() - Math.max(...ds)) < 30 * 86400000; }, b => (b.reviews || []).some(r => r.time));
  add("Répond aux avis", 6, b => (b.reviews || []).some(r => r.ownerAnswer), b => (b.reviews || []).length > 0);
  if (report.titleKeyword?.businessesWithTitle) checks.push({ label: `« ${report.keyword} » dans le nom`, weight: 4, pct: report.titleKeyword.keywordInTitlePct, base: report.titleKeyword.businessesWithTitle });
  if (!checks.length) return null;
  const W = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const score = Math.round(checks.reduce((s, c) => s + c.weight * c.pct, 0) / W);
  checks.sort((a, b) => b.pct - a.pct || b.weight - a.weight);
  return { score, checks, essentials: checks.filter(c => c.pct >= 80).map(c => c.label) };
}

// Gros sites souvent reliés aux fiches (réseaux sociaux / agrégateurs / places
// de marché) qu'on EXCLUT quand on étudie le "vrai" site du business.
const SOCIAL_DOMAINS = new Set(["facebook.com", "fb.com", "fb.me", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "youtu.be", "tiktok.com", "pinterest.com", "pinterest.fr", "snapchat.com", "wa.me", "linktr.ee", "beacons.ai"]);
const AGGREGATOR_DOMAINS = new Set(["booking.com", "planity.com", "treatwell.fr", "treatwell.com", "fresha.com", "doctolib.fr", "doctolib.com", "pagesjaunes.fr", "mappy.com", "tripadvisor.fr", "tripadvisor.com", "yelp.com", "yelp.fr", "justacote.com", "starofservice.com", "malt.fr", "leboncoin.fr", "ubereats.com", "deliveroo.fr", "deliveroo.com", "thefork.fr", "thefork.com", "lafourchette.com", "trustpilot.com", "g.page", "google.com", "amazon.fr", "etsy.com", "wanteed.fr", "houzz.fr", "houzz.com", "allovoisins.com", "ootravaux.fr", "travaux.com", "habitatpresto.com", "izi-by-edf.fr", "needhelp.com", "frizbiz.com", "fr.trustpilot.com"]);

function classifyDomain(domain) {
  if (!domain) return "none";
  const d = String(domain).toLowerCase().replace(/^www\./, "");
  const inSet = set => [...set].some(p => d === p || d.endsWith("." + p));
  if (inSet(SOCIAL_DOMAINS)) return "social";
  if (inSet(AGGREGATOR_DOMAINS)) return "aggregator";
  return "own";
}

// Le "vrai" site web des fiches du top N : répartition (site propre vs page
// sociale/agrégateur), autorité (Domain Rank/backlinks via DataForSEO) et
// contrôles techniques (HTTPS, mobile, schema.org).
async function siteMetricsAnalysis(businesses, topN, onProgress) {
  const tally = { none: 0, social: 0, aggregator: 0, own: 0 };
  const ownDomains = []; const seen = new Set();
  for (const b of businesses) {
    const c = classifyDomain(b.domain);
    tally[c]++;
    if (c === "own" && b.domain && !seen.has(b.domain)) { seen.add(b.domain); ownDomains.push(b.domain); }
  }
  const list = ownDomains.slice(0, 40);
  const metrics = [];
  if (dataforseo.configured()) {
    for (let i = 0; i < list.length; i++) {
      onProgress?.({ phase: "sitemetrics", done: i, total: list.length, name: list[i] });
      try { const m = await dataforseo.domainMetrics(list[i]); if (m) metrics.push(m); } catch { /* skip */ }
    }
  }
  let tech = null;
  try { tech = await siteTechAnalysis(list, onProgress); } catch { /* skip */ }
  const tot = businesses.length || 1;
  const rank = numberStats(metrics.map(m => m.rank));
  const referringDomains = numberStats(metrics.map(m => m.referringDomains));
  const backlinks = numberStats(metrics.map(m => m.backlinks));
  const ownPct = Math.round((tally.own / tot) * 100);
  const recParts = [];
  if (metrics.length && rank) recParts.push(`Domain Rank médian ${rank.median}/1000${referringDomains ? `, ~${referringDomains.median} domaines référents` : ""}${backlinks ? `, ~${backlinks.median} backlinks` : ""}`);
  if (tech) recParts.push(`${tech.httpsPct}% en HTTPS, ${tech.mobilePct}% mobile-friendly, ${tech.schemaPct}% avec balisage schema.org LocalBusiness`);
  recParts.push(`${ownPct}% des fiches du top ${topN} ont un vrai site propre`);
  return {
    businesses: tot,
    breakdown: { ownSitePct: ownPct, socialOnlyPct: Math.round((tally.social / tot) * 100), aggregatorPct: Math.round((tally.aggregator / tot) * 100), noSitePct: Math.round((tally.none / tot) * 100) },
    sitesAnalyzed: metrics.length,
    rank, referringDomains, backlinks, tech,
    rows: metrics.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 40),
    recommendation: recParts.length
      ? `Sites des fiches du top ${topN} : ${recParts.join(" · ")}.`
      : `${ownPct}% des fiches du top ${topN} ont un vrai site propre.`,
  };
}

// Audit Haloscan : volume de recherche "<métier> <ville>" par ville,
// métriques des sites des fiches (trust, domaines référents, mots-clés, trafic),
// et position du site de chaque fiche sur sa requête.
async function haloscanAnalysis({ keyword, cities, businesses, topN, onProgress }) {
  if (!haloscan.configured()) return null;
  // 1) volume du métier seul + par "métier + ville"
  let baseKeyword = null;
  try { baseKeyword = await haloscan.keywordOverview(keyword); } catch { /* skip */ }
  const kw = [];
  for (let i = 0; i < cities.length; i++) {
    onProgress?.({ phase: "haloscan", done: i, total: cities.length + 1, city: cities[i] });
    try { const o = await haloscan.keywordOverview(`${keyword} ${cities[i]}`); if (o) kw.push({ city: cities[i], ...o }); } catch { /* skip */ }
  }
  // 2) métriques + position des sites "propres" des fiches
  const seen = new Set(); const sites = [];
  for (const b of businesses) { if (classifyDomain(b.domain) === "own" && b.domain && !seen.has(b.domain)) { seen.add(b.domain); sites.push({ domain: b.domain, city: b.city }); } }
  const siteRows = [];
  const list = sites.slice(0, 40);
  for (let i = 0; i < list.length; i++) {
    onProgress?.({ phase: "haloscan", done: cities.length + i, total: cities.length + list.length, name: list[i].domain });
    let ov = null, pos = null;
    try { ov = await haloscan.domainOverview(list[i].domain); } catch { /* skip */ }
    try { pos = await haloscan.domainPosition(list[i].domain, `${keyword} ${list[i].city}`); } catch { /* skip */ }
    if (ov || pos != null) siteRows.push({ ...(ov || { domain: list[i].domain }), positionOnQuery: pos });
  }
  const vol = numberStats(kw.map(k => k.volume));
  const totalVolume = kw.reduce((s, k) => s + (k.volume || 0), 0);
  const trust = numberStats(siteRows.map(r => r.trust));
  const refDomains = numberStats(siteRows.map(r => r.referringDomains));
  const kwCount = numberStats(siteRows.map(r => r.keywordsCount));
  const traffic = numberStats(siteRows.map(r => r.traffic));
  const positions = numberStats(siteRows.map(r => r.positionOnQuery));
  const recParts = [];
  if (baseKeyword?.volume != null) recParts.push(`Volume « ${keyword} » : ${baseKeyword.volume}/mois`);
  if (totalVolume) recParts.push(`volume cumulé « ${keyword} + ville » sur ${kw.length} villes : ${totalVolume}/mois (médiane ${vol ? vol.median : "?"}/ville)`);
  if (trust) recParts.push(`sites du top ${topN} : trust médian ${trust.median}${refDomains ? `, ~${refDomains.median} domaines référents` : ""}${kwCount ? `, ~${kwCount.median} mots-clés positionnés` : ""}${traffic ? `, ~${traffic.median} visites/mois` : ""}`);
  return {
    baseKeyword, citiesQueried: kw.length,
    totalVolume, volumePerCity: vol,
    allintitle: numberStats(kw.map(k => k.allintitle)), kgr: numberStats(kw.map(k => k.kgr)),
    topCitiesByVolume: kw.filter(k => typeof k.volume === "number").sort((a, b) => b.volume - a.volume).slice(0, 25).map(k => ({ term: k.city, count: k.volume })),
    perCity: kw.map(k => ({ city: k.city, volume: k.volume, allintitle: k.allintitle, kgr: k.kgr, difficulty: k.difficulty })),
    sites: { analyzed: siteRows.length, trust, referringDomains: refDomains, keywordsCount: kwCount, traffic, positionOnQuery: positions, rows: siteRows.slice(0, 40) },
    recommendation: recParts.length ? recParts.join(" · ") + "." : "Aucune donnée Haloscan exploitable (vérifie la clé / les endpoints).",
  };
}

// Position du SITE de la fiche dans le SERP organique de "<métier> <ville>"
// (nécessite l'audit citations actif, qui fournit les résultats organiques).
function websiteRankAnalysis(businesses, organicByCity, topN) {
  if (!organicByCity?.length) return null;
  const byCity = new Map(organicByCity.map(o => [o.city, o.items || []]));
  const rows = [];
  let withSite = 0, ranked = 0, top10 = 0, top20 = 0;
  for (const b of businesses) {
    if (!b.domain) continue;
    withSite++;
    const items = byCity.get(b.city) || [];
    let best = null;
    for (const it of items) {
      if (it.domain && (it.domain === b.domain || it.domain.endsWith("." + b.domain) || b.domain.endsWith("." + it.domain))) {
        if (best == null || (Number.isFinite(it.rank) && it.rank < best)) best = Number.isFinite(it.rank) ? it.rank : best ?? 999;
      }
    }
    if (best != null) { ranked++; if (best <= 10) top10++; if (best <= 20) top20++; }
    rows.push({ name: b.name, city: b.city, rank: b.rank, domain: b.domain, organicRank: best });
  }
  if (!withSite) return null;
  const pct = n => Math.round((n / withSite) * 100);
  const ranks = rows.map(r => r.organicRank).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const median = ranks.length ? ranks[Math.floor((ranks.length - 1) / 2)] : null;
  return {
    businessesWithSite: withSite,
    rankedPct: pct(ranked), top10Pct: pct(top10), top20Pct: pct(top20),
    medianOrganicRank: median,
    rows: rows.slice(0, 40),
    recommendation: ranked
      ? `${pct(top10)}% des fiches du top ${topN} ont aussi leur site web en page 1 sur « <métier> <ville> » (rang organique médian : ${median}) → avoir un site qui se positionne sur la requête locale aide nettement.`
      : `Les sites des fiches du top ${topN} ne se positionnent pas dans les ${organicByCity[0]?.items?.length || 100} premiers résultats organiques → le classement local ne dépend pas ici du site web.`,
  };
}

// Audit "note des avis" : quelle note moyenne / minimale viser pour entrer
// dans le top N, par position, avec la distribution des notes.
function ratingTarget(businesses, topN) {
  const rated = businesses.filter(b => typeof b.rating === "number" && Number.isFinite(b.rating));
  if (!rated.length) return null;
  const ratings = rated.map(b => b.rating).sort((a, b) => a - b);
  const counts = rated.map(b => b.reviewsCount).filter(n => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null;
  const avg = a => a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null;
  const byRankMap = new Map();
  for (const b of rated) { const r = Number.isFinite(b.rank) ? b.rank : topN; (byRankMap.get(r) || byRankMap.set(r, []).get(r)).push(b); }
  const byRank = [...byRankMap.entries()].sort((a, b) => a[0] - b[0]).map(([rank, list]) => {
    const rr = list.map(x => x.rating);
    const cc = list.map(x => x.reviewsCount).filter(n => typeof n === "number");
    return { rank, n: list.length, avgRating: avg(rr), minRating: Math.min(...rr), avgReviews: cc.length ? Math.round(avg(cc)) : null };
  });
  const buckets = [["5.0", r => r >= 5], ["4.9", r => r >= 4.9 && r < 5], ["4.8", r => r >= 4.8 && r < 4.9], ["4.5–4.7", r => r >= 4.5 && r < 4.8], ["4.0–4.4", r => r >= 4 && r < 4.5], ["< 4.0", r => r < 4]];
  const distribution = buckets.map(([label, fn]) => ({ term: label, count: ratings.filter(fn).length })).filter(b => b.count);
  const floor = ratings[0], median = q(ratings, 0.5), p25 = q(ratings, 0.25), max = ratings[ratings.length - 1];
  const minReviews = counts.length ? counts[0] : null, medianReviews = q(counts, 0.5);
  return {
    businessesRated: rated.length, avg: avg(ratings), floor, median, p25, max,
    minReviews, medianReviews, byRank, distribution,
    recommendation: `Note à atteindre : au moins ${floor}/5 (la plus basse du top ${topN}), idéalement ≥ ${median}/5 (médiane du top ${topN})` +
      (minReviews != null ? `, avec au moins ${minReviews} avis (idéalement ${medianReviews}+).` : "."),
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
  // Exemples d'avis "souhaités" à suggérer aux clients (en intégrant la sémantique du top N)
  const pickN = (arr, n, off = 0) => arr.slice(off, off + n).join(", ");
  const t = mustMention.map(m => m.term);
  const sampleReviews = [
    `J'ai fait appel à [nom] pour ${keyword} à [ville] et je recommande vivement. ${pickN(t, 3) ? pickN(t, 3) + " au rendez-vous. " : ""}Une équipe à l'écoute et un travail soigné — je reviendrai sans hésiter !`,
    `Très satisfait·e de [nom] ! ${pickN(t, 2, 3) ? pickN(t, 2, 3) + " impeccables, " : ""}prestation ${keyword} de qualité, accueil chaleureux et bons conseils. Je conseille à 100 %.`,
    `[nom] — ${keyword} sérieux et professionnel à [ville]. ${pickN(t, 3, 5) ? pickN(t, 3, 5) + ". " : ""}Merci pour votre réactivité et votre gentillesse, rien à redire.`,
  ].filter(s => s && s.length > 30);
  return { mustMention, alsoUseful, fromReviewText, words, responseTemplate, sampleReviews };
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
    withReviews = false, withVision = false, withCitations = false, withSiteMetrics = false, withHaloscan = false,
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
  let citations = null, organicByCity = null;
  if (withCitations && typeof provider.organicResults === "function") {
    const byCity = [];
    let i = 0;
    for (const city of limitedCities) {
      onProgress({ phase: "citations", done: i, total: limitedCities.length, city });
      try { byCity.push({ city, items: await provider.organicResults(keyword, city) }); }
      catch (e) { byCity.push({ city, items: [] }); }
      i++;
    }
    organicByCity = byCity;
    citations = citationsAnalysis(byCity);
  }

  // Métriques des sites web des fiches (optionnel) — DataForSEO Backlinks
  let siteMetrics = null;
  if (withSiteMetrics) {
    try { siteMetrics = await siteMetricsAnalysis(businesses, topN, onProgress); } catch { /* skip */ }
  }

  // Haloscan (optionnel) : volume mots-clés + métriques/positions des sites
  let haloscanData = null;
  if (withHaloscan) {
    try { haloscanData = await haloscanAnalysis({ keyword, cities: limitedCities, businesses, topN, onProgress }); } catch { /* skip */ }
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
      descriptionWords: numberStats(descriptions.map(d => wordCount(d))),
    },
    title: titleStats(businesses),
    gmbProfile: gmbProfileAnalysis(businesses, topN),
    ratingTarget: ratingTarget(businesses, topN),
    reviewFrequency: reviewFrequencyAnalysis(businesses),
    reviewEngagement: reviewEngagementAnalysis(businesses),
    websiteRank: websiteRankAnalysis(businesses, organicByCity, topN),
    siteMetrics,
    haloscan: haloscanData,
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
      reviewsCount: b.reviewsCount, category: b.category, domain: b.domain || null,
      description: b.description ? b.description.slice(0, 300) : null,
    })),
  };

  report.descriptionGuide = descriptionGuide(report.descriptionKeywords, keyword, report.stats.descriptionLength, report.stats.descriptionWords);
  report.reviewGuide = reviewSemanticGuide(report.reviewTopics, report.reviewKeywords, keyword);
  report.referenceChecklist = referenceChecklist(businesses, report);

  // Recommandations dérivées + résumé "accessible"
  report.recommendations = buildRecommendations(report);
  report.summary = buildSummary(report);
  return report;
}

// Résumé en langage clair : un constat + une liste d'actions classées par priorité.
function buildSummary(r) {
  const A = []; const add = (priority, text) => { if (text) A.push({ priority, text }); };
  const N = r.topN;
  if (r.reviewEngagement && r.reviewEngagement.ownerResponseRate >= 30) add("haute", `Répondre à tous vos avis (les fiches du top ${N} répondent à ${r.reviewEngagement.ownerResponseRate}%).`);
  if (r.ratingTarget) add("haute", `Obtenir une note d'au moins ${r.ratingTarget.median}/5 et environ ${r.ratingTarget.medianReviews != null ? r.ratingTarget.medianReviews : (r.stats.reviewsCount ? r.stats.reviewsCount.median : "plusieurs dizaines d'")} avis — c'est le niveau du top ${N}.`);
  if (r.reviewFrequency?.perMonth) add("haute", `Récolter ~${r.reviewFrequency.perMonth.median} nouvel(s) avis par mois et répondre à chacun ; ne pas laisser passer plus de ~${r.reviewFrequency.lastReviewDays.p75} jours sans nouvel avis.`);
  if (r.categoryCombos?.mainCategory) add("haute", `Choisir comme catégorie principale « ${r.categoryCombos.mainCategory} »${r.categoryCombos.secondaryCategories?.length ? ` et ajouter en secondaires : ${r.categoryCombos.secondaryCategories.join(", ")}` : ""}.`);
  if (r.descriptionGuide?.mustUse?.length) add("moyenne", `Rédiger une description d'environ ${r.descriptionGuide.targetLength ? r.descriptionGuide.targetLength.median : 750} caractères${r.descriptionGuide.targetWords ? ` (~${r.descriptionGuide.targetWords.median} mots)` : ""} en y intégrant : ${r.descriptionGuide.mustUse.slice(0, 8).map(x => x.term).join(", ")}.`);
  if (r.titleKeyword && r.titleKeyword.keywordInTitlePct >= 60) add("moyenne", `Faire apparaître « ${r.keyword} » dans le nom de la fiche (${r.titleKeyword.keywordInTitlePct}% du top ${N} le font) — sans abuser.`);
  if (r.gmbProfile?.mustHaveAttributes?.length) add("moyenne", `Cocher les attributs : ${r.gmbProfile.mustHaveAttributes.slice(0, 8).map(x => x.term).join(", ")}.`);
  if (r.stats.photosCount?.count) add("moyenne", `Mettre au moins ${r.stats.photosCount.median} photos.`);
  if (r.vision?.topObjects?.length) add("basse", `Montrer sur les photos en priorité : ${r.vision.topObjects.slice(0, 5).map(o => o.term).join(", ")}.`);
  if (r.reviewTopics?.topics?.length) add("basse", `Inciter les clients à mentionner dans leurs avis : ${r.reviewTopics.topics.slice(0, 6).map(t => t.term).join(", ")} (et reprendre ces mots dans vos réponses).`);
  if (r.citations?.mustSubmit?.length) add("basse", `S'inscrire sur les annuaires : ${r.citations.mustSubmit.slice(0, 8).map(d => d.domain).join(", ")}.`);
  if (r.siteMetrics?.rank?.median || r.haloscan?.sites?.trust?.median || r.haloscan?.sites?.keywordsCount?.median) add("basse", `Renforcer le site web (liens / contenu) : le top ${N} a des sites mieux référencés que la moyenne.`);
  const ord = { haute: 0, moyenne: 1, basse: 2 };
  A.sort((a, b) => ord[a.priority] - ord[b.priority]);
  const bits = [];
  if (r.ratingTarget) bits.push(`une note ≈ ${r.ratingTarget.median}/5`);
  if (r.ratingTarget?.medianReviews != null) bits.push(`≈ ${r.ratingTarget.medianReviews} avis`);
  else if (r.stats.reviewsCount) bits.push(`≈ ${r.stats.reviewsCount.median} avis`);
  if (r.categoryCombos?.mainCategory) bits.push(`la catégorie « ${r.categoryCombos.mainCategory} »`);
  if (r.descriptionGuide?.targetLength) bits.push(`une description d'≈ ${r.descriptionGuide.targetLength.median} caractères`);
  const headline = `D'après l'analyse de ${r.businesses.total} fiches du top ${N} sur ${r.cities.requested} ville(s) pour « ${r.keyword} », les établissements bien placés ont en moyenne ${bits.join(", ")}${r.referenceChecklist ? ` et un score de complétude de fiche de ${r.referenceChecklist.score}/100` : ""}. Voici, par ordre de priorité, ce qu'il faut faire pour s'en rapprocher.`;
  return { headline, actions: A };
}

// ════════════════════════════════════════════════════════════════════════════
//  Mode "Audit d'une fiche" : score /100 + note A→F + rang + concurrents + plan
// ════════════════════════════════════════════════════════════════════════════
const SCORE_WEIGHTS = { profile: 20, reviews: 25, photos: 15, posts: 10, qa: 10, services: 10, attributes: 10 };

function gradeFromScore(s) { return s >= 85 ? "A" : s >= 70 ? "B" : s >= 55 ? "C" : s >= 40 ? "D" : "F"; }
function clamp100(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function reviewDates(b) { return (b.reviews || []).map(r => Date.parse(r.time)).filter(t => Number.isFinite(t) && t <= Date.now() + 864e5); }
function recentReviews(b, days) { const c = Date.now() - days * 864e5; return reviewDates(b).filter(t => t >= c).length; }
function ownerResponseRate(b) { const rv = b.reviews || []; if (!rv.length) return null; return Math.round((rv.filter(r => r.ownerAnswer).length / rv.length) * 100); }
function negativeReviewPct(b) { const rv = (b.reviews || []).filter(r => typeof r.rating === "number"); if (!rv.length) return null; return Math.round((rv.filter(r => r.rating <= 3).length / rv.length) * 100); }

function scoreListing(me, pack, rank) {
  const comp = pack.filter(b => b !== me);
  const compReviews = comp.map(b => b.reviewsCount).filter(n => typeof n === "number" && n > 0).sort((a, b) => a - b);
  const compMedReviews = compReviews.length ? compReviews[Math.floor((compReviews.length - 1) / 2)] : null;
  const cats = {};

  // ── Profil (revendiquée, description, horaires, catégories secondaires) ──
  {
    const issues = [], recs = [];
    let s = 0;
    if (me.claimed === true) s += 30; else if (me.claimed === false) { issues.push("Fiche non revendiquée"); recs.push("Revendiquer la fiche dans Google Business Profile"); }
    else s += 18; // inconnu : on suppose revendiquée (souvent le cas dans le top)
    const dl = me.description ? me.description.trim().length : 0;
    if (dl >= 250) s += 40; else if (dl > 0) { s += 22; issues.push(`Description courte (${dl} car.)`); recs.push("Étoffer la description (≥ 250 caractères, avec vos mots-clés)"); }
    else { issues.push("Description absente"); recs.push("Ajouter une description détaillée pour améliorer la visibilité"); }
    if (me.workHours && me.workHours.daysOpen >= 1) s += 15; else { issues.push("Horaires non renseignés"); recs.push("Renseigner vos horaires d'ouverture"); }
    if ((me.categories || []).filter(Boolean).length >= 1) s += 15; else { issues.push("Pas de catégorie secondaire"); recs.push("Ajouter des catégories secondaires pertinentes"); }
    cats.profile = { label: "Profil & description", weight: SCORE_WEIGHTS.profile, score: clamp100(s), issues, recommendations: recs };
  }
  // ── Avis & note ──────────────────────────────────────────────────────────
  {
    const issues = [], recs = [];
    let s = 0;
    const r = me.rating;
    if (typeof r === "number") { if (r >= 4.8) s += 35; else if (r >= 4.5) s += 30; else if (r >= 4) s += 18; else { s += 5; issues.push(`Note faible (${r}/5)`); recs.push("Travailler la qualité de service pour remonter la note"); } }
    const rc = me.reviewsCount;
    if (typeof rc === "number") {
      if (compMedReviews != null) { const ratio = rc / Math.max(1, compMedReviews); s += clamp100(Math.min(1, ratio) * 30); if (ratio < 0.6) { issues.push(`Moins d'avis que les concurrents (${rc} vs ~${compMedReviews})`); recs.push("Lancer une stratégie de collecte d'avis auprès de chaque client"); } }
      else { s += rc >= 50 ? 30 : rc >= 20 ? 20 : 10; if (rc < 20) recs.push("Collecter plus d'avis (objectif : 50+)"); }
    } else recs.push("Collecter des avis clients régulièrement");
    const r30 = recentReviews(me, 30);
    if (r30 >= 3) s += 20; else if (r30 >= 1) { s += 10; issues.push(`Peu d'avis récents (${r30} sur 30 j)`); recs.push("Maintenir un flux régulier de nouveaux avis"); }
    else { issues.push("Aucun avis sur les 30 derniers jours"); recs.push("Relancer la collecte d'avis — la récence compte beaucoup"); }
    const orr = ownerResponseRate(me);
    if (orr != null) { s += clamp100((orr / 100) * 15); if (orr < 90) { issues.push(`Taux de réponse aux avis : ${orr}%`); recs.push("Répondre à tous les avis (objectif 90 %+) pour montrer l'engagement"); } }
    else recs.push("Répondre systématiquement aux avis");
    cats.reviews = { label: "Avis & note", weight: SCORE_WEIGHTS.reviews, score: clamp100(s), issues, recommendations: recs };
  }
  // ── Photos ───────────────────────────────────────────────────────────────
  {
    const issues = [], recs = [];
    const pc = me.photosCount;
    let s;
    if (typeof pc === "number") { s = clamp100((pc / 25) * 100); if (pc < 25) { issues.push(`${pc} photos seulement`); recs.push("Ajouter des photos (objectif : 25+, variées : extérieur, intérieur, équipe, réalisations)"); } }
    else { s = 50; recs.push("Ajouter régulièrement des photos variées (objectif : 25+)"); }
    cats.photos = { label: "Photos", weight: SCORE_WEIGHTS.photos, score: clamp100(s), issues, recommendations: recs };
  }
  // ── Google Posts (non vérifiable via API) ────────────────────────────────
  cats.posts = { label: "Google Posts", weight: SCORE_WEIGHTS.posts, score: 0, verified: false, issues: ["Pas vérifiable via l'API — supposé absent"], recommendations: ["Publier régulièrement des posts Google (actus, offres) pour rester actif"] };
  // ── Questions / Réponses ─────────────────────────────────────────────────
  {
    const qa = me.questionsAndAnswersCount;
    if (typeof qa === "number" && qa > 0) cats.qa = { label: "Questions / Réponses", weight: SCORE_WEIGHTS.qa, score: clamp100((qa / 8) * 100), issues: qa < 5 ? [`Peu de Q&R (${qa})`] : [], recommendations: qa < 5 ? ["Pré-remplir la section Q&R avec 5–10 questions fréquentes"] : [] };
    else cats.qa = { label: "Questions / Réponses", weight: SCORE_WEIGHTS.qa, score: 0, verified: typeof qa === "number", issues: ["Section Q&R vide"], recommendations: ["Pré-remplir la section Q&R avec 5–10 questions fréquentes"] };
  }
  // ── Services / Produits (non vérifiable) ─────────────────────────────────
  cats.services = { label: "Services / Produits", weight: SCORE_WEIGHTS.services, score: 0, verified: false, issues: ["Pas vérifiable via l'API — supposé absent"], recommendations: ["Lister vos services / produits sur la fiche"] };
  // ── Attributs ────────────────────────────────────────────────────────────
  {
    const ac = (me.attributes || []).length;
    const issues = [], recs = [];
    const s = clamp100((ac / 10) * 100);
    if (ac < 5) { issues.push(`Peu d'attributs (${ac})`); recs.push("Cocher les attributs essentiels (accessibilité PMR, Wi-Fi, parking, moyens de paiement…)"); }
    if (ac < 10) recs.push("Compléter tous les attributs pertinents pour un meilleur appariement");
    cats.attributes = { label: "Attributs", weight: SCORE_WEIGHTS.attributes, score: s, issues, recommendations: recs };
  }

  const totalW = Object.values(cats).reduce((a, c) => a + c.weight, 0);
  const score = clamp100(Object.values(cats).reduce((a, c) => a + c.score * c.weight, 0) / totalW);
  return { score, grade: gradeFromScore(score), categories: cats, compMedianReviews: compMedReviews };
}

function listingActionPlan(scorecard, me) {
  const items = [];
  for (const c of Object.values(scorecard.categories)) {
    for (const rec of (c.recommendations || [])) {
      let impact = "Faible";
      if (c.weight >= 20 && c.score < 70) impact = "Élevé";
      else if ((c.weight >= 15 && c.score < 70) || (c.weight >= 20 && c.score < 85)) impact = "Moyen";
      items.push({ text: rec, category: c.label, impact });
    }
  }
  const ord = { "Élevé": 0, "Moyen": 1, "Faible": 2 };
  items.sort((a, b) => ord[a.impact] - ord[b.impact]);
  return items.slice(0, 12);
}

// opts: { keyword, city, target:{placeId,cid,name}, providerName, onProgress }
export async function runListingAudit(opts) {
  const { keyword, city = "", target = {}, providerName = config.defaultProvider, onProgress = () => {} } = opts;
  if (!keyword || !keyword.trim()) throw new Error("Mot-clé (métier) requis.");
  if (!target.placeId && !target.cid && !target.name) throw new Error("Indique le Place ID, le CID ou le nom de la fiche.");
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Fournisseur inconnu : ${providerName}`);
  const query = city ? `${keyword} ${city}`.trim() : keyword.trim();

  onProgress({ phase: "serp", done: 0, total: 1 });
  const pack = await provider.localPack(keyword, city, 10);
  onProgress({ phase: "serp", done: 1, total: 1 });
  if (!pack.length) throw new Error(`Aucun résultat pour « ${query} ».`);

  const norm = s => normalize(s || "");
  let idx = -1;
  if (target.placeId) idx = pack.findIndex(b => b.place_id && b.place_id === target.placeId);
  if (idx < 0 && target.cid) idx = pack.findIndex(b => b.cid && String(b.cid) === String(target.cid));
  if (idx < 0 && target.name) { const t = norm(target.name); idx = pack.findIndex(b => b.name && (norm(b.name).includes(t) || t.includes(norm(b.name)))); }
  let me = idx >= 0 ? pack[idx] : (target.placeId || target.cid ? { name: target.name || null, place_id: target.placeId || null, cid: target.cid || null, city, rank: null, rating: null, reviewsCount: null, category: null, categories: [], images: [], reviews: [] } : null);
  if (!me) throw new Error(`Fiche introuvable dans le top 10 de « ${query} » — précise le Place ID ou le CID.`);
  const rank = (idx >= 0 ? (me.rank ?? idx + 1) : null);

  onProgress({ phase: "infos", done: 0, total: 2 });
  try { me = await provider.businessInfo(me); } catch { /* keep base */ }
  onProgress({ phase: "reviews", done: 1, total: 2 });
  try { const rv = await provider.reviews(me, { depth: 100 }); if (rv?.length) me.reviews = rv; } catch { /* skip */ }
  if (providerName !== "dataforseo" && dataforseo.configured() && me.cid) {
    try {
      const d = await dataforseo.businessInfo(me);
      me = { ...me, placeTopics: me.placeTopics?.length ? me.placeTopics : d.placeTopics, description: me.description || d.description, claimed: me.claimed ?? d.claimed, attributes: (me.attributes && me.attributes.length) ? me.attributes : d.attributes, workHours: me.workHours || d.workHours, phone: me.phone || d.phone, questionsAndAnswersCount: me.questionsAndAnswersCount ?? d.questionsAndAnswersCount, website: me.website || d.website, domain: me.domain || d.domain };
    } catch { /* skip */ }
  }
  const scorecard = scoreListing(me, pack, rank);
  const actionPlan = listingActionPlan(scorecard, me);
  const competitors = pack.map((b, i) => ({
    rank: b.rank ?? i + 1, name: b.name, isMe: i === idx,
    rating: b.rating ?? null, reviewsCount: b.reviewsCount ?? null, photosCount: b.photosCount ?? null,
    category: b.category || null, address: b.address || null,
    beaten: (rank != null && (b.rank ?? i + 1) != null) ? (i !== idx && rank < (b.rank ?? i + 1)) : null,
  }));

  return {
    mode: "listing", keyword, city, query, provider: providerName, generatedAt: new Date().toISOString(),
    business: {
      name: me.name, address: me.address || null, city, place_id: me.place_id || null, cid: me.cid || null, phone: me.phone || null,
      rank, rating: me.rating ?? null, reviewsCount: me.reviewsCount ?? null, photosCount: me.photosCount ?? null,
      category: me.category || null, categories: me.categories || [], website: me.website || me.domain || null,
      description: me.description || null, descriptionLength: me.description ? me.description.trim().length : 0,
      claimed: me.claimed ?? null, attributesCount: (me.attributes || []).length, attributes: (me.attributes || []).slice(0, 40),
      workHours: me.workHours || null, qaCount: me.questionsAndAnswersCount ?? null,
    },
    headline: { reviews: me.reviewsCount ?? null, rating: me.rating ?? null, photos: me.photosCount ?? null, recent30d: recentReviews(me, 30), responseRate: ownerResponseRate(me), negativePct: negativeReviewPct(me), rank },
    score: scorecard.score, grade: scorecard.grade, scoreWeights: SCORE_WEIGHTS, categories: scorecard.categories,
    competitors, compMedianReviews: scorecard.compMedianReviews,
    actionPlan,
  };
}

function buildRecommendations(r) {
  const recs = [];
  if (r.referenceChecklist) recs.push(`Score de complétude moyen des fiches du top ${r.topN} : ${r.referenceChecklist.score}/100 — c'est la barre à atteindre.${r.referenceChecklist.essentials.length ? ` Pratiques quasi systématiques chez les leaders : ${r.referenceChecklist.essentials.slice(0, 8).join(", ")}.` : ""}`);
  if (r.reviewEngagement) recs.push(`Réponses aux avis : les fiches du top ${r.topN} répondent à ${r.reviewEngagement.ownerResponseRate}% des avis${r.reviewEngagement.responseDelayDays ? ` (en ~${r.reviewEngagement.responseDelayDays.median} j en médiane)` : ""} — réponds à tous tes avis, vite. (${r.reviewEngagement.negativeReviewsPct}% d'avis ≤ 3/5 chez les leaders.)`);
  if (r.ratingTarget) {
    recs.push(r.ratingTarget.recommendation);
    if (r.ratingTarget.medianReviews != null) recs.push(`Nombre d'avis à atteindre : ≥ ${r.ratingTarget.minReviews} (minimum du top ${r.topN}), cible ${r.ratingTarget.medianReviews} (médiane)${r.stats.reviewsCount ? `, top ${r.topN} jusqu'à ${r.stats.reviewsCount.max} avis` : ""}.`);
  } else {
    if (r.stats.reviewsCount) recs.push(`Viser au moins ${r.stats.reviewsCount.median} avis (médiane du top ${r.topN}), idéalement ${r.stats.reviewsCount.p75}+.`);
    if (r.stats.rating) recs.push(`Note moyenne du top ${r.topN} : ${r.stats.rating.avg}/5 — rester au-dessus de ${r.stats.rating.p25}/5.`);
  }
  if (r.stats.photosCount && r.stats.photosCount.count) recs.push(`Nombre de photos à atteindre : médiane ${r.stats.photosCount.median} (top ${r.topN} : ${r.stats.photosCount.min}–${r.stats.photosCount.max}).`);
  if (r.reviewFrequency?.perMonth) recs.push(`Fréquence d'avis à tenir : ~${r.reviewFrequency.perMonth.median} nouveau(x) avis / mois (médiane du top ${r.topN}) ; dernier avis du top ${r.topN} : il y a ${r.reviewFrequency.lastReviewDays.median} j en médiane — ne pas laisser passer plus de ~${r.reviewFrequency.lastReviewDays.p75} j sans nouvel avis.`);
  if (r.reviewFrequency?.ageYears) recs.push(`Ancienneté des fiches du top ${r.topN} : ~${r.reviewFrequency.ageYears.median} ans d'avis (la plus jeune : ${r.reviewFrequency.ageYears.min} an(s)) — une fiche récente peut percer, mais l'historique compte ; commence à collecter des avis dès maintenant.`);
  const g = r.descriptionGuide;
  if (g) {
    if (g.targetLength) recs.push(`Rédiger une description d'environ ${g.targetLength.median} caractères${g.targetWords ? ` (~${g.targetWords.median} mots)` : ""} — fourchette observée : ${g.targetLength.p25}–${g.targetLength.p75} car.`);
    if (g.mustUse.length) recs.push(`Mots à intégrer impérativement dans la description (présents dans ≥ 60 % du top ${r.topN}) : ${g.mustUse.map(x => `${x.term} (${x.pct}%)`).join(", ")}.`);
    if (g.recommended.length) recs.push(`Mots recommandés (≥ 30 %) : ${g.recommended.slice(0, 12).map(x => x.term).join(", ")}.`);
    if (g.phrases.length) recs.push(`Expressions à reprendre : ${g.phrases.slice(0, 6).map(x => x.term).join(" / ")}.`);
  } else if (r.stats.descriptionLength) {
    recs.push(`Rédiger une description d'environ ${r.stats.descriptionLength.median} caractères (médiane observée).`);
  }
  if (r.title?.words) recs.push(`Longueur du nom de la fiche : ~${r.title.words.median} mots / ${r.title.chars.median} caractères (médiane du top ${r.topN}).`);
  if (r.gmbProfile?.recommendation) recs.push(r.gmbProfile.recommendation);
  if (r.titleKeyword?.recommendation) recs.push(r.titleKeyword.recommendation);
  if (r.websiteRank?.recommendation) recs.push(r.websiteRank.recommendation);
  if (r.siteMetrics?.recommendation) recs.push(r.siteMetrics.recommendation);
  if (r.haloscan?.recommendation) recs.push("Haloscan — " + r.haloscan.recommendation);
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
