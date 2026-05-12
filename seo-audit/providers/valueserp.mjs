// Adaptateur ValueSERP — local pack (Google Places) + détails de fiche.
//   1) /search?q=<métier ville>&google_domain=google.fr&gl=fr&hl=fr   → local pack + CID
//   2) /search?search_type=place_details&data_cid=<cid>&hl=fr          → desc, catégories,
//      review_topics (chips Google), attributs, horaires, etc.
import config from "../config.mjs";

const { apiKey, base } = config.valueserp;

function key() {
  if (!apiKey) throw new Error("ValueSERP non configuré (VALUESERP_API_KEY manquant).");
  return apiKey;
}

async function get(params, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = new URL(base + "/search");
      url.searchParams.set("api_key", key());
      for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
      const res = await fetch(url);
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.request_info && json.request_info.success === false)) {
        lastErr = new Error(`ValueSERP → ${res.status} ${json?.request_info?.message || ""}`.trim());
        // erreurs transitoires "(G)" : on retente
        if (attempt < retries) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
        throw lastErr;
      }
      return json || {};
    } catch (e) {
      lastErr = e;
      if (attempt < retries && /HTTP|fetch|network|ECONN|ETIMEDOUT|timeout/i.test(String(e.message))) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function host(u) { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return null; } }

// ── Local pack pour "<métier> <ville>" ──────────────────────────────────────
export async function localPack(keyword, city, limit = 3) {
  const json = await get({
    q: `${keyword} ${city}`.trim(),
    google_domain: "google.fr", gl: "fr", hl: "fr",
  });
  const items = (json.local_results || json.places_results || []).slice(0, limit);
  return items.map((it, idx) => ({
    name: it.title || null,
    cid: it.data_cid || it.cid || null,
    place_id: it.data_id || it.place_id || null,           // souvent absent ici, complété par place_details
    city,
    rank: it.position || idx + 1,
    rating: num(it.rating),
    reviewsCount: num(it.reviews),
    category: it.business_type || it.category || it.type || null,
    categories: it.business_type ? [String(it.business_type).trim()] : [],
    snippet: it.snippet || it.description || null,
    address: it.address || null,
    website: it.link || it.website || null,
    domain: (it.link || it.website) ? host(it.link || it.website) : null,
    latitude: it.gps_coordinates?.latitude ?? it.coordinates?.latitude ?? null,
    longitude: it.gps_coordinates?.longitude ?? it.coordinates?.longitude ?? null,
    photosCount: null,
    images: it.thumbnail ? [it.thumbnail] : [],
    reviews: [],
  }));
}

// ── Local pack à un point GPS (grille de visibilité) ────────────────────────
// NB : le ciblage par coordonnées de ValueSERP est moins fiable que DataForSEO.
export async function localPackAtCoord(keyword, lat, lng, limit = 20, zoom = 14) {
  const json = await get({
    search_type: "places", q: keyword,
    location_coordinates: `${lat},${lng}`,
    ll: `@${lat},${lng},${zoom}z`,
    google_domain: "google.fr", gl: "fr", hl: "fr",
  });
  const items = (json.places_results || json.local_results || []).slice(0, limit);
  return items.map((it, idx) => ({
    name: it.title || null, cid: it.data_cid || it.cid || null, place_id: it.data_id || it.place_id || null,
    rank: it.position || idx + 1, rating: num(it.rating), reviewsCount: num(it.reviews),
  }));
}

// extrait des attributs GMB lisibles parmi known_attributes
const ATTR_RE = /accessib|payment|amenit|service_option|crowd|highlight|offering|planning|health|from_the_business|popular_for|atmosphere|dining_option|getting_here|recycling|activities|children|pets|parking/i;
function extractAttributes(known) {
  if (!Array.isArray(known)) return [];
  const out = [];
  for (const a of known) {
    const id = String(a?.attribute || "");
    if (!ATTR_RE.test(id)) continue;
    const label = String(a?.value || a?.name || "").trim();
    if (label && !/^non$|^no$/i.test(label)) out.push(label);
  }
  return [...new Set(out)].slice(0, 40);
}
function extractHours(hours) {
  if (!Array.isArray(hours)) return null;
  let daysOpen = 0, hoursPerWeek = 0;
  for (const d of hours) {
    const v = String(d?.value || "").trim();
    if (!v || /ferm|closed/i.test(v)) continue;
    if (/24[\s/]?24|24 hours|ouvert 24/i.test(v)) { daysOpen++; hoursPerWeek += 24; continue; }
    daysOpen++;
    for (const m of v.matchAll(/(\d{1,2})[:h](\d{2})\s*[–\-—à]\s*(\d{1,2})[:h](\d{2})/g)) {
      const h = (+m[3] + +m[4] / 60) - (+m[1] + +m[2] / 60);
      if (h > 0) hoursPerWeek += h; else if (h < 0) hoursPerWeek += h + 24; // passe minuit
    }
  }
  return daysOpen ? { daysOpen, hoursPerWeek: Math.round(hoursPerWeek * 10) / 10 } : null;
}

// ── Détails d'une fiche (place_details) ─────────────────────────────────────
export async function businessInfo(biz) {
  const cid = biz.cid;
  if (!cid) return biz;
  let d;
  try { const json = await get({ search_type: "place_details", data_cid: cid, hl: "fr" }); d = json.place_details || {}; }
  catch { return biz; }
  const placeTopics = Array.isArray(d.review_topics)
    ? d.review_topics.map(t => ({ term: String(t.topic_name || t.name || "").trim(), count: Number(t.count) || 0 })).filter(t => t.term)
    : (biz.placeTopics || []);
  const attributes = extractAttributes(d.known_attributes);
  const workHours = extractHours(d.hours);
  return {
    ...biz,
    description: d.description || biz.description || null,
    category: biz.category || d.category || d.type || null,
    categories: (biz.categories?.length ? biz.categories : (Array.isArray(d.categories) ? d.categories : [])),
    rating: biz.rating ?? num(d.rating),
    reviewsCount: biz.reviewsCount ?? num(d.reviews),
    photosCount: Array.isArray(d.photos) ? d.photos.length : (biz.photosCount ?? null),
    placeTopics,
    attributes: attributes.length ? attributes : (biz.attributes || []),
    claimed: typeof d.unclaimed === "boolean" ? !d.unclaimed : (biz.claimed ?? null),
    workHours: workHours || biz.workHours || null,
    website: d.website || biz.website || null,
    domain: biz.domain || (d.website ? host(d.website) : null),
    place_id: biz.place_id || d.data_id || null,
    latitude: biz.latitude ?? d.gps_coordinates?.latitude ?? null,
    longitude: biz.longitude ?? d.gps_coordinates?.longitude ?? null,
    images: (Array.isArray(d.photos) ? d.photos : []).map(p => p?.image || p?.thumbnail || p).filter(Boolean).slice(0, 8),
    reviews: (Array.isArray(d.user_reviews?.most_relevant) ? d.user_reviews.most_relevant
      : (Array.isArray(d.user_reviews) ? d.user_reviews : (Array.isArray(d.reviews) ? d.reviews : []))).map(r => ({
        text: r.snippet || r.text || r.review || "", rating: num(r.rating), time: r.date || r.iso_date || null,
        ownerAnswer: r.response?.text || r.owner_answer || null,
      })).filter(r => r.text),
  };
}

// Pas d'API d'extraction d'avis dédiée chez ValueSERP : on réutilise ceux de place_details.
export async function reviews(biz) { return biz.reviews || []; }

// SERP organique pour "<métier> <ville>" → domaines (annuaires / citations).
export async function organicResults(keyword, city) {
  const json = await get({ q: `${keyword} ${city}`.trim(), google_domain: "google.fr", gl: "fr", hl: "fr", num: "100" });
  return (json.organic_results || []).map(o => ({
    domain: o.domain || host(o.link),
    url: o.link || null, title: o.title || null, rank: o.position || null,
  })).filter(x => x.domain);
}

export default { localPack, localPackAtCoord, businessInfo, reviews, organicResults };
