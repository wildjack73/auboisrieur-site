// Adaptateur Haloscan (https://api.haloscan.com) — volume de mots-clés,
// métriques de domaine, position d'un domaine sur un mot-clé.
// NB : les chemins/paramètres ci-dessous suivent l'API publique Haloscan ;
// le parsing est défensif (plusieurs noms de champs possibles). À ajuster si
// la doc diffère — toutes les fonctions renvoient null en cas d'échec.
import config from "./config.mjs";

const { apiKey, base } = config.haloscan;

export function configured() { return !!apiKey; }

async function post(path, body) {
  if (!apiKey) throw new Error("Haloscan non configuré (HALOSCAN_API_KEY manquant).");
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "haloscan-api-key": apiKey, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Haloscan ${path} → HTTP ${res.status}`);
  return res.json();
}

const numOf = v => (typeof v === "number" && Number.isFinite(v)) ? v : (typeof v === "string" && v.trim() !== "" && !isNaN(+v) ? +v : null);
function pick(obj, ...keys) { for (const k of keys) { const v = numOf(obj?.[k]); if (v != null) return v; } return null; }
function unwrap(json) {
  if (!json) return null;
  const r = json.result ?? json.results ?? json.data ?? json;
  return Array.isArray(r) ? (r[0] ?? null) : r;
}

// Volume & difficulté d'un mot-clé
export async function keywordOverview(keyword, langCountry = "fr-fr") {
  let o;
  try { o = unwrap(await post("/api/keywords/overview", { keyword, lang_country: langCountry, requested_data: ["volume", "competition", "kgr", "allintitle", "keyword_difficulty", "cpc"] })); }
  catch { return null; }
  if (!o) return null;
  return {
    keyword,
    volume: pick(o, "volume", "search_volume", "monthly_volume", "vol"),
    allintitle: pick(o, "allintitle", "allintitle_count"),
    kgr: pick(o, "kgr", "keyword_golden_ratio"),
    competition: pick(o, "competition", "competition_index"),
    difficulty: pick(o, "keyword_difficulty", "difficulty", "kd"),
    cpc: pick(o, "cpc"),
  };
}

// Métriques d'un domaine (autorité, domaines référents, mots-clés, trafic)
export async function domainOverview(domain) {
  let o;
  try { o = unwrap(await post("/api/domains/overview", { input: domain })); }
  catch { return null; }
  if (!o) return null;
  return {
    domain,
    trust: pick(o, "trust", "trust_flow", "domain_trust", "authority", "domain_authority"),
    citationFlow: pick(o, "citation_flow"),
    referringDomains: pick(o, "referring_domains", "ref_domains", "backlinks_refdomains", "nb_referring_domains"),
    backlinks: pick(o, "backlinks", "backlinks_count", "nb_backlinks"),
    keywordsCount: pick(o, "keywords", "keywords_count", "nb_keywords", "positioned_keywords", "organic_keywords"),
    traffic: pick(o, "traffic", "estimated_traffic", "organic_traffic", "estimated_visits"),
    trafficValue: pick(o, "traffic_value", "estimated_traffic_value", "traffic_cost"),
  };
}

// Meilleure position d'un domaine sur un mot-clé (filtre les positions du domaine)
export async function domainPosition(domain, keyword, langCountry = "fr-fr") {
  let json;
  try { json = await post("/api/domains/positions", { input: domain, keywords: [keyword], lang_country: langCountry }); }
  catch { return null; }
  const r = json?.result ?? json?.results ?? json?.data ?? json;
  const arr = Array.isArray(r) ? r : (r?.positions || r?.items || []);
  let best = null;
  for (const it of (arr || [])) {
    const kw = (it?.keyword || it?.query || "").toString().toLowerCase();
    if (kw && kw !== keyword.toLowerCase()) continue;
    const p = pick(it, "position", "pos", "rank");
    if (p != null && (best == null || p < best)) best = p;
  }
  return best;
}

export default { configured, keywordOverview, domainOverview, domainPosition };
