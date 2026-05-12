// Google Cloud Vision — analyse des photos des fiches :
//   OBJECT_LOCALIZATION (objets), LABEL_DETECTION (labels/ambiances),
//   TEXT_DETECTION (mots écrits sur les images).
import config from "./config.mjs";

const { apiKey, base } = config.vision;

export function visionConfigured() { return !!apiKey; }

const empty = () => ({ objects: {}, labels: {}, texts: {}, analyzed: 0 });

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
  const bump = (m, k) => { k = String(k || "").toLowerCase().trim(); if (k) m[k] = (m[k] || 0) + 1; };
  for (const r of json.responses || []) {
    if (r.error) continue;
    out.analyzed++;
    for (const o of r.localizedObjectAnnotations || []) bump(out.objects, o.name);
    for (const l of r.labelAnnotations || []) bump(out.labels, l.description);
    const full = r.textAnnotations?.[0]?.description || r.fullTextAnnotation?.text || "";
    const seen = new Set();
    for (const w of words(full)) { if (seen.has(w)) continue; seen.add(w); bump(out.texts, w); }
  }
  return out;
}

export default { analyzeImages, visionConfigured };
