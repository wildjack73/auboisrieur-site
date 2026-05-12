// Google Cloud Translation v2 — traduit des chaînes (par défaut en→fr),
// avec dédoublonnage + cache mémoire pour ne jamais retraduire un terme déjà vu.
import config from "./config.mjs";

const { apiKey, base } = config.translate;
const cache = new Map(); // "fr|en|texte" -> traduction

export function translateConfigured() { return !!apiKey; }
export function cacheSize() { return cache.size; }

// strings: string[] → string[] (même longueur). En cas d'échec : renvoie les originaux.
export async function translate(strings, { target = "fr", source = "en" } = {}) {
  if (!apiKey || !strings?.length) return strings || [];
  const ck = s => `${target}|${source}|${s}`;
  // 1) ne garder que les termes uniques ET non encore en cache
  const need = [...new Set(strings)].filter(s => !cache.has(ck(s)));
  // 2) un seul appel API pour tout le lot manquant (par paquets de 120 max)
  for (let i = 0; i < need.length; i += 120) {
    const batch = need.slice(i, i + 120);
    const params = new URLSearchParams();
    params.set("key", apiKey);
    params.set("target", target);
    if (source) params.set("source", source);
    params.set("format", "text");
    for (const q of batch) params.append("q", q);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      if (!res.ok) { for (const q of batch) cache.set(ck(q), q); continue; }
      const json = await res.json();
      const out = json?.data?.translations;
      if (Array.isArray(out) && out.length === batch.length) {
        batch.forEach((q, j) => cache.set(ck(q), out[j]?.translatedText || q));
      } else {
        for (const q of batch) cache.set(ck(q), q);
      }
    } catch { for (const q of batch) cache.set(ck(q), q); }
  }
  return strings.map(s => cache.get(ck(s)) ?? s);
}

// Traduit le champ `term` d'une liste [{term,count,...}] ; conserve l'original.
export async function translateTerms(items, opts) {
  if (!apiKey || !items?.length) return items || [];
  const fr = await translate(items.map(i => i.term), opts);
  return items.map((i, idx) => (fr[idx] && fr[idx].toLowerCase() !== i.term.toLowerCase())
    ? { ...i, term: fr[idx].toLowerCase(), original: i.term }
    : i);
}

export default { translate, translateTerms, translateConfigured, cacheSize };
