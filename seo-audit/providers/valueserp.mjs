// Adaptateur ValueSERP — reproduit les requêtes du bot ZennoPoster :
//   1) /search?q=<métier ville>&google_domain=google.fr&gl=fr&hl=fr
//      &include_answer_box=false&include_advertiser_info=true   → local pack + CID
//   2) /search?search_type=place_details&data_cid=<cid>&hl=fr   → catégories, etc.
import config from "../config.mjs";

const { apiKey, base } = config.valueserp;

function key() {
  if (!apiKey) throw new Error("ValueSERP non configuré (VALUESERP_API_KEY manquant).");
  return apiKey;
}

async function get(params) {
  const url = new URL(base + "/search");
  url.searchParams.set("api_key", key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ValueSERP → HTTP ${res.status}`);
  return res.json();
}

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Catégories d'une fiche : ValueSERP renvoie en général `category` (principale)
// et parfois des catégories supplémentaires dans `categories` ou `extensions`.
function extractCategories(d) {
  const out = [];
  if (d.category) out.push(String(d.category).trim());
  if (Array.isArray(d.categories)) for (const c of d.categories) { const s = String(c?.title || c || "").trim(); if (s) out.push(s); }
  if (Array.isArray(d.extensions)) for (const e of d.extensions) {
    // certaines fiches exposent les catégories secondaires comme extensions de type "category"
    if (e && /categor/i.test(e.type || "") && e.text) out.push(String(e.text).trim());
  }
  // dédoublonnage en conservant l'ordre
  return [...new Set(out.filter(Boolean))];
}

export async function localPack(keyword, city, limit = 3) {
  const json = await get({
    q: `${keyword} ${city}`.trim(),
    google_domain: "google.fr",
    gl: "fr",
    hl: "fr",
    include_answer_box: "false",
    include_advertiser_info: "true",
  });
  const items = (json.local_results || json.places_results || []).slice(0, limit);
  return items.map((it, idx) => ({
    name: it.title || null,
    cid: it.data_cid || it.cid || null,
    place_id: it.data_id || it.place_id || null,
    city,
    rank: it.position || idx + 1,
    rating: num(it.rating),
    reviewsCount: num(it.reviews),
    category: it.category || it.type || null,
    categories: it.category ? [String(it.category).trim()] : [],
    snippet: it.snippet || it.description || null,
    address: it.address || null,
    photosCount: null,
    images: it.thumbnail ? [it.thumbnail] : [],
    reviews: [],
  }));
}

export async function businessInfo(biz) {
  const cid = biz.cid;
  if (!cid) return biz;
  let json;
  try { json = await get({ search_type: "place_details", data_cid: cid, hl: "fr" }); }
  catch { return biz; }
  const d = json.place_details || {};
  const cats = extractCategories(d);
  const userReviews = d.user_reviews?.most_relevant || d.reviews || [];
  return {
    ...biz,
    description: d.description || biz.description || null,
    category: cats[0] || biz.category || null,
    categories: cats.length ? cats : (biz.categories || []),
    rating: biz.rating ?? num(d.rating),
    reviewsCount: biz.reviewsCount ?? num(d.reviews_count ?? d.reviews),
    photosCount: Array.isArray(d.photos) ? d.photos.length : (biz.photosCount ?? null),
    images: (d.photos || []).map(p => p?.image || p?.thumbnail || p).filter(Boolean).slice(0, 8),
    reviews: userReviews.map(r => ({
      text: r.snippet || r.text || r.review || "",
      rating: num(r.rating),
      time: r.date || r.iso_date || null,
    })).filter(r => r.text),
  };
}

// ValueSERP n'a pas d'API d'extraction d'avis dédiée : on réutilise ceux
// déjà renvoyés par place_details (récupérés dans businessInfo()).
export async function reviews(biz) {
  return biz.reviews || [];
}

export default { localPack, businessInfo, reviews };
