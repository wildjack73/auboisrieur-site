// Google Cloud Vision — détection d'objets / labels sur les photos des fiches.
import config from "./config.mjs";

const { apiKey, base } = config.vision;

export function visionConfigured() {
  return !!apiKey;
}

// Analyse une liste d'URL d'images. Retourne un comptage agrégé { label: count }.
export async function analyzeImages(urls, { maxImages = 6 } = {}) {
  if (!apiKey || !urls?.length) return { labels: {}, analyzed: 0 };
  const slice = urls.slice(0, maxImages);
  const requests = slice.map(u => ({
    image: { source: { imageUri: u } },
    features: [
      { type: "LABEL_DETECTION", maxResults: 10 },
      { type: "OBJECT_LOCALIZATION", maxResults: 10 },
    ],
  }));
  let json;
  try {
    const res = await fetch(`${base}/images:annotate?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) return { labels: {}, analyzed: 0 };
    json = await res.json();
  } catch { return { labels: {}, analyzed: 0 }; }

  const labels = {};
  let analyzed = 0;
  for (const r of json.responses || []) {
    if (r.error) continue;
    analyzed++;
    for (const l of r.labelAnnotations || []) {
      const name = (l.description || "").toLowerCase();
      if (name) labels[name] = (labels[name] || 0) + 1;
    }
    for (const o of r.localizedObjectAnnotations || []) {
      const name = (o.name || "").toLowerCase();
      if (name) labels[name] = (labels[name] || 0) + 1;
    }
  }
  return { labels, analyzed };
}

export default { analyzeImages, visionConfigured };
