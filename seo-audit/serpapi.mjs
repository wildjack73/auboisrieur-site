// SerpApi — récupère les photos d'une fiche Google Maps (engine google_maps_photos).
import config from "./config.mjs";

const { apiKey, base } = config.serpapi;

export function configured() { return !!apiKey; }

// dataId : l'identifiant Google Maps au format "0x...:0x..." (renvoyé par ValueSERP
// comme place_id). On accepte aussi un place_id ChIJ... que SerpApi sait résoudre.
export async function getPlacePhotos(dataId, { max = 24 } = {}) {
  if (!apiKey || !dataId) return [];
  const url = new URL(base + "/search.json");
  url.searchParams.set("engine", "google_maps_photos");
  url.searchParams.set("data_id", dataId);
  url.searchParams.set("api_key", apiKey);
  let json;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    json = await res.json();
  } catch { return []; }
  const photos = json.photos || json.photos_results || [];
  return photos.map(p => p?.image || p?.thumbnail || p).filter(Boolean).slice(0, max);
}

export default { getPlacePhotos, configured };
