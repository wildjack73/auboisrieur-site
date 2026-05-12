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

  // Google Cloud Vision — clé API (OBJECT_LOCALIZATION + LABEL_DETECTION + TEXT_DETECTION)
  vision: {
    apiKey: env("GOOGLE_VISION_API_KEY", "AIzaSyBFQl62uqJu2jB2TnzeFwwAzkteR5WrMmk"),
    base: "https://vision.googleapis.com/v1",
  },

  // SerpApi — pour récupérer toutes les photos d'une fiche (engine google_maps_photos)
  serpapi: {
    apiKey: env("SERPAPI_KEY", "2a925c23f5296924649975221cacf27f0b9effa882dea75f9dc9c2b7095f3c3d"),
    base: "https://serpapi.com",
  },

  // Google Cloud Translation v2 — pour traduire en français les labels/objets Vision
  translate: {
    apiKey: env("GOOGLE_TRANSLATE_API_KEY", env("GOOGLE_VISION_API_KEY", "AIzaSyBFQl62uqJu2jB2TnzeFwwAzkteR5WrMmk")),
    base: "https://translation.googleapis.com/language/translate/v2",
  },

  // Haloscan (https://tool.haloscan.com) — clé API (JWT) ; auth via header haloscan-api-key
  haloscan: {
    apiKey: env("HALOSCAN_API_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoyMiwiZGF0ZSI6MTcxMTYyNjk0NTYzMywiaWF0IjoxNzExNjI2OTQ1LCJleHAiOjE3NDMxODQ1NDV9.MMF3zKq2R0yPoKaxnbNhXJVWOiORzi-URi_sMgGssTw"),
    base: "https://api.haloscan.com",
  },

  // Localisation / langue par défaut pour les requêtes SERP
  locationName: env("SEO_AUDIT_LOCATION", "France"),
  languageCode: env("SEO_AUDIT_LANGUAGE", "fr"),

  // Sécurité : nombre max de villes par audit (coût API)
  maxCitiesPerAudit: parseInt(env("SEO_AUDIT_MAX_CITIES", "500"), 10),

  // Port du serveur web
  port: parseInt(env("PORT", "8787"), 10),
};
