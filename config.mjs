// ─── Configuration du site ──────────────────────────────────────────────────
// Les valeurs peuvent être surchargées par des variables d'environnement (GitHub Secrets)

const env = (key, fallback = "") => process.env[key] || fallback;

export default {
  // Amazon Affilié
  amazonTag: env("AMAZON_TAG", "clubjouetdm-21"),
  amazonDomain: "www.amazon.fr",

  // Google AdSense
  adsenseId: env("ADSENSE_ID", "ca-pub-7172863085566977"),
  adSlots: {
    header: env("AD_SLOT_HEADER"),
    sidebar: env("AD_SLOT_SIDEBAR"),
    inArticle: env("AD_SLOT_INARTICLE"),
    betweenLots: env("AD_SLOT_BETWEENLOTS"),
  },

  // Google Analytics
  gaId: env("GA_ID"),  // ex: "G-XXXXXXXXXX"

  // Site
  siteName: env("SITE_NAME", "Enchères Archives"),
  siteDescription: "Résultats de ventes aux enchères en France — Prix, photos, estimations",
  siteUrl: env("SITE_URL", "https://auboisrieur.fr"),

  // FTP Hostinger
  ftp: {
    enabled: !!env("FTP_HOST"),  // Activé automatiquement si FTP_HOST est défini
    host: env("FTP_HOST"),
    user: env("FTP_USER"),
    password: env("FTP_PASSWORD"),
    remotePath: env("FTP_REMOTE_PATH", "/public_html"),
    secure: env("FTP_SECURE") === "true",
  },

  // Limites
  similarLotsCount: 6,
  lotsPerCategoryPage: 50,
};
