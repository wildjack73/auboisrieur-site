// Google Cloud Vision — analyse des photos des fiches :
//   OBJECT_LOCALIZATION (objets), LABEL_DETECTION (labels/ambiances),
//   TEXT_DETECTION (mots écrits sur les images).
import config from "./config.mjs";

const { apiKey, base } = config.vision;

export function visionConfigured() { return !!apiKey; }

const empty = () => ({ objects: {}, labels: {}, texts: {}, analyzed: 0, images: [] });

function words(text) {
  return (text || "")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .match(/[a-z0-9][a-z0-9'’.-]{2,}/g) || [];
}

// Analyse une liste d'URL d'images → comptages agrégés { objects, labels, texts, analyzed }.
// Chaque terme est compté une fois par image où il apparaît.
export async function analyzeImages(urls, { maxImages = 8 } = {}) {
  if (!apiKey || !urls?.length) return empty();
  const slice = [...new Set(urls)].slice(0, maxImages);
  const requests = slice.map(u => ({
    image: { source: { imageUri: u } },
    features: [
      { type: "OBJECT_LOCALIZATION", maxResults: 10 },
      { type: "LABEL_DETECTION", maxResults: 10 },
      { type: "TEXT_DETECTION", maxResults: 1 },
    ],
  }));
  let json;
  try {
    const res = await fetch(`${base}/images:annotate?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) return empty();
    json = await res.json();
  } catch { return empty(); }

  const out = empty();
  const norm = k => String(k || "").toLowerCase().trim();
  const bump = (m, k) => { k = norm(k); if (k) m[k] = (m[k] || 0) + 1; };
  (json.responses || []).forEach((r, idx) => {
    if (!r || r.error) return;
    out.analyzed++;
    const objs = [...new Set((r.localizedObjectAnnotations || []).map(o => norm(o.name)).filter(Boolean))];
    const labs = [...new Set((r.labelAnnotations || []).map(l => norm(l.description)).filter(Boolean))];
    for (const o of objs) bump(out.objects, o);
    for (const l of labs) bump(out.labels, l);
    const full = r.textAnnotations?.[0]?.description || r.fullTextAnnotation?.text || "";
    const seen = new Set();
    for (const w of words(full)) { if (seen.has(w)) continue; seen.add(w); bump(out.texts, w); }
    out.images.push({ url: slice[idx], objects: objs, labels: labs });
  });
  return out;
}

export default { analyzeImages, visionConfigured };
