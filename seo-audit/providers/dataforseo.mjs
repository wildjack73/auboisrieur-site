// Adaptateur DataForSEO — local pack (Google Maps), infos fiche (GMB), avis.
import config from "../config.mjs";

const { login, password, base } = config.dataforseo;

export function configured() { return !!(login && password); }

function authHeader() {
  if (!login || !password) {
    throw new Error("DataForSEO non configuré (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD manquants).");
  }
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Authorization": authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} → HTTP ${res.status}`);
  const json = await res.json();
  if (json.status_code && json.status_code !== 20000) {
    throw new Error(`DataForSEO ${path} → ${json.status_code} ${json.status_message}`);
  }
  return json;
}

function firstResult(json) {
  return json?.tasks?.[0]?.result?.[0] || null;
}

// ── Local pack : top N résultats Google Maps pour "<métier> <ville>" ─────────
export async function localPack(keyword, city, limit = 3) {
  const json = await post("/serp/google/maps/live/advanced", [{
    keyword: `${keyword} ${city}`,
    location_name: config.locationName,
    language_code: config.languageCode,
    depth: 20,
  }]);
  const result = firstResult(json);
  const items = (result?.items || []).filter(i => i.type === "maps_search").slice(0, limit);
  return items.map((it, idx) => ({
    name: it.title || null,
    cid: it.cid || null,
    place_id: it.place_id || null,
    city,
    rank: idx + 1,
    rating: it.rating?.value ?? null,
    reviewsCount: it.rating?.votes_count ?? null,
    category: it.category || null,
    categories: it.additional_categories || (it.category ? [it.category] : []),
    snippet: it.snippet || null,
    address: it.address || null,
    website: it.url || null,
    domain: it.domain || (it.url ? hostname(it.url) : null),
    photosCount: null,
    images: [],
    reviews: [],
  }));
}

// ── Infos fiche GMB : description "du propriétaire", catégories, photos ──────
export async function businessInfo(biz) {
  const kw = biz.cid ? `cid:${biz.cid}` : `${biz.name} ${biz.city}`;
  let result;
  try {
    const json = await post("/business_data/google/my_business_info/live", [{
      keyword: kw,
      location_name: config.locationName,
      language_code: config.languageCode,
    }]);
    result = firstResult(json);
  } catch (e) {
    return biz; // best-effort
  }
  const it = (result?.items || [])[0];
  if (!it) return biz;
  // place_topics : mots-clés que Google extrait des avis ({ "sujet": nb_mentions })
  const placeTopics = (it.place_topics && typeof it.place_topics === "object")
    ? Object.entries(it.place_topics)
        .map(([term, count]) => ({ term: String(term).trim(), count: Number(count) || 0 }))
        .filter(t => t.term).sort((a, b) => b.count - a.count)
    : (biz.placeTopics || []);
  // attributs GMB cochés (available_attributes : { groupe: [attribut, …] })
  const attrs = [];
  const av = it.attributes?.available_attributes;
  if (av && typeof av === "object") for (const list of Object.values(av)) if (Array.isArray(list)) for (const a of list) { const s = String(a || "").trim(); if (s) attrs.push(s); }
  // horaires : timetable { lundi: [{open:{hour,minute}, close:{hour,minute}}, …] }
  let workHours = null;
  const tt = it.work_time?.work_hours?.timetable;
  if (tt && typeof tt === "object") {
    let hoursPerWeek = 0, daysOpen = 0;
    for (const day of Object.values(tt)) {
      if (!Array.isArray(day) || !day.length) continue;
      daysOpen++;
      for (const slot of day) {
        const o = slot?.open, c = slot?.close;
        if (o && c) { const h = (c.hour + (c.minute || 0) / 60) - (o.hour + (o.minute || 0) / 60); if (h > 0) hoursPerWeek += h; }
      }
    }
    workHours = { daysOpen, hoursPerWeek: Math.round(hoursPerWeek * 10) / 10 };
  }
  return {
    ...biz,
    claimed: typeof it.is_claimed === "boolean" ? it.is_claimed : biz.claimed,
    attributes: attrs.length ? attrs : (biz.attributes || []),
    priceLevel: it.price_level ?? biz.priceLevel ?? null,
    workHours: workHours ?? biz.workHours ?? null,
    description: it.description || biz.description || null,
    category: biz.category || it.category || null,
    categories: (biz.categories?.length ? biz.categories : (it.additional_categories || [])),
    rating: biz.rating ?? it.rating?.value ?? null,
    reviewsCount: biz.reviewsCount ?? it.rating?.votes_count ?? null,
    photosCount: it.total_photos ?? it.photos_count ?? null,
    placeTopics,
    images: (it.images || []).map(im => im?.url || im).filter(Boolean).slice(0, 8),
  };
}

// ── SERP organique : domaines qui ressortent pour "<métier> <ville>" ────────
// (annuaires / sites de citations NAP : Doctolib, PagesJaunes, StarOfService…)
export async function organicResults(keyword, city, depth = 100) {
  const json = await post("/serp/google/organic/live/advanced", [{
    keyword: `${keyword} ${city}`.trim(),
    location_name: config.locationName,
    language_code: config.languageCode,
    device: "desktop", os: "windows", depth,
  }]);
  const result = firstResult(json);
  const out = [];
  for (const it of (result?.items || [])) {
    if ((it.type === "organic" || it.type === "compare_sites_element") && it.domain) {
      out.push({ domain: it.domain, url: it.url || null, title: it.title || null, rank: it.rank_absolute ?? it.rank_group ?? null });
    }
    // blocs imbriqués (ex. "people also search", comparateurs)
    if (Array.isArray(it.items)) for (const sub of it.items) {
      const dom = sub.domain || (sub.url ? hostname(sub.url) : null);
      if (dom) out.push({ domain: dom, url: sub.url || null, title: sub.title || null, rank: null });
    }
  }
  return out;
}

function hostname(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } }

// ── Avis : texte des avis (task-based, borné dans le temps) ──────────────────
export async function reviews(biz, { depth = 50, timeoutMs = 60000 } = {}) {
  const task = { language_code: config.languageCode, location_name: config.locationName, depth };
  if (biz.place_id) task.place_id = biz.place_id;
  else if (biz.cid) task.keyword = `cid:${biz.cid}`;
  else task.keyword = `${biz.name} ${biz.city}`;

  let postJson;
  try { postJson = await post("/business_data/google/reviews/task_post", [task]); }
  catch { return []; }
  const id = postJson?.tasks?.[0]?.id;
  if (!id) return [];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const res = await fetch(`${base}/business_data/google/reviews/task_get/${id}`, {
        headers: { "Authorization": authHeader() },
      });
      const json = await res.json();
      const result = firstResult(json);
      if (result?.items) {
        return result.items.map(r => ({
          text: r.review_text || "",
          rating: r.rating?.value ?? null,
          time: r.timestamp || null,
        })).filter(r => r.text);
      }
    } catch { /* keep polling */ }
  }
  return [];
}

// ── Métriques d'un domaine (autorité du site) via l'API Backlinks ───────────
export async function domainMetrics(domain) {
  if (!domain) return null;
  let r;
  try {
    const json = await post("/backlinks/summary/live", [{
      target: domain, internal_list_limit: 1,
      backlinks_status_type: "live", include_subdomains: true,
    }]);
    r = firstResult(json);
  } catch { return null; }
  if (!r) return null;
  return {
    domain,
    rank: r.rank ?? null,                       // Domain Rank DataForSEO (0–1000)
    backlinks: r.backlinks ?? null,
    referringDomains: r.referring_domains ?? null,
    referringMainDomains: r.referring_main_domains ?? null,
    referringPages: r.referring_pages ?? null,
    firstSeen: r.first_seen ?? null,
  };
}

export default { localPack, businessInfo, reviews, organicResults, domainMetrics, configured };
