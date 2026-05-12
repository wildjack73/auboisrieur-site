// Adaptateur ValueSERP — local pack (Google Places) + détails de fiche.
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

export async function localPack(keyword, city, limit = 3) {
  const json = await get({
    search_type: "places",
    q: keyword,
    location: `${city},${config.locationName}`,
    hl: config.languageCode,
    gl: "fr",
  });
  const items = (json.places_results || json.local_results || []).slice(0, limit);
  return items.map((it, idx) => ({
    name: it.title || null,
    cid: it.data_cid || it.cid || null,
    place_id: it.data_id || it.place_id || null,
    city,
    rank: idx + 1,
    rating: num(it.rating),
    reviewsCount: num(it.reviews),
    category: it.category || it.type || null,
    categories: it.category ? [it.category] : (it.types || []),
    snippet: it.snippet || it.description || null,
    address: it.address || null,
    photosCount: null,
    images: it.thumbnail ? [it.thumbnail] : [],
    reviews: [],
  }));
}

export async function businessInfo(biz) {
  if (!biz.place_id) return biz;
  let json;
  try { json = await get({ search_type: "place_details", data_id: biz.place_id, hl: config.languageCode }); }
  catch { return biz; }
  const d = json.place_details || {};
  return {
    ...biz,
    description: d.description || biz.description || null,
    category: biz.category || d.category || (d.categories && d.categories[0]) || null,
    categories: (biz.categories?.length ? biz.categories : (d.categories || [])),
    rating: biz.rating ?? num(d.rating),
    reviewsCount: biz.reviewsCount ?? num(d.reviews),
    photosCount: Array.isArray(d.photos) ? d.photos.length : (biz.photosCount ?? null),
    images: (d.photos || []).map(p => p?.image || p).filter(Boolean).slice(0, 8),
    reviews: (d.reviews || d.user_reviews || []).map(r => ({
      text: r.snippet || r.text || "",
      rating: num(r.rating),
      time: r.date || null,
    })).filter(r => r.text),
  };
}

// ValueSERP ne propose pas d'extraction d'avis dédiée : les quelques avis
// renvoyés par place_details sont déjà inclus dans businessInfo().
export async function reviews(biz) {
  return biz.reviews || [];
}

export default { localPack, businessInfo, reviews };
