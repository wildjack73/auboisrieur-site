// Google Cloud Translation v2 — traduit des chaînes (par défaut en→fr).
import config from "./config.mjs";

const { apiKey, base } = config.translate;

export function translateConfigured() { return !!apiKey; }

// strings: string[] → string[] (même longueur). En cas d'échec, renvoie les originaux.
export async function translate(strings, { target = "fr", source = "en" } = {}) {
  if (!apiKey || !strings?.length) return strings || [];
  // dédoublonnage pour limiter le volume
  const uniq = [...new Set(strings)];
  const params = new URLSearchParams();
  params.set("key", apiKey);
  params.set("target", target);
  if (source) params.set("source", source);
  params.set("format", "text");
  for (const q of uniq) params.append("q", q);
  let json;
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) return strings;
    json = await res.json();
  } catch { return strings; }
  const out = json?.data?.translations;
  if (!Array.isArray(out) || out.length !== uniq.length) return strings;
  const map = new Map(uniq.map((s, i) => [s, out[i]?.translatedText || s]));
  return strings.map(s => map.get(s) || s);
}

// Traduit le champ `term` d'une liste [{term,count,...}] ; conserve l'original.
export async function translateTerms(items, opts) {
  if (!apiKey || !items?.length) return items || [];
  const fr = await translate(items.map(i => i.term), opts);
  return items.map((i, idx) => (fr[idx] && fr[idx].toLowerCase() !== i.term.toLowerCase())
    ? { ...i, term: fr[idx].toLowerCase(), original: i.term }
    : i);
}

export default { translate, translateTerms, translateConfigured };
