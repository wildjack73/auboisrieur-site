// ─── Configuration de l'outil d'audit Google Local (top 3 / local pack) ─────
// Les valeurs sont surchargées par des variables d'environnement.

const env = (key, fallback = "") => process.env[key] || fallback;

export default {
  // Fournisseur SERP par défaut : "dataforseo" ou "valueserp"
  defaultProvider: env("SEO_AUDIT_PROVIDER", "valueserp"),

  // DataForSEO (https://dataforseo.com) — Basic auth login/password
  dataforseo: {
    login: env("DATAFORSEO_LOGIN"),
    password: env("DATAFORSEO_PASSWORD"),
    base: "https://api.dataforseo.com/v3",
  },

  // ValueSERP (https://www.valueserp.com) — clé API (mise en dur comme dans
  // le bot ZennoPoster ; surchargeable via la variable d'environnement).
  valueserp: {
    apiKey: env("VALUESERP_API_KEY", "A18E79F50D89498EB963320A15D6FBDE"),
    base: "https://api.valueserp.com",
  },

  // Google Cloud Vision — clé API (LABEL_DETECTION + OBJECT_LOCALIZATION)
  vision: {
    apiKey: env("GOOGLE_VISION_API_KEY"),
    base: "https://vision.googleapis.com/v1",
  },

  // Localisation / langue par défaut pour les requêtes SERP
  locationName: env("SEO_AUDIT_LOCATION", "France"),
  languageCode: env("SEO_AUDIT_LANGUAGE", "fr"),

  // Sécurité : nombre max de villes par audit (coût API)
  maxCitiesPerAudit: parseInt(env("SEO_AUDIT_MAX_CITIES", "500"), 10),

  // Port du serveur web
  port: parseInt(env("PORT", "8787"), 10),
};
