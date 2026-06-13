import fs from "fs";
const SITE = "/var/www/adjuge/site";
const today = new Date().toISOString().split("T")[0];
const files = fs.readdirSync(SITE + "/maison").filter(f => f.endsWith(".html"));
const u = [`<url><loc>https://auboisrieur.fr/maisons.html</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`];
for (const f of files) {
  u.push(`<url><loc>https://auboisrieur.fr/maison/${f}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
}
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + u.join("\n") + "\n</urlset>";
fs.writeFileSync(SITE + "/sitemap-maisons.xml", xml);

let idx = fs.readFileSync(SITE + "/sitemap.xml", "utf-8");
if (!idx.includes("sitemap-maisons.xml")) {
  idx = idx.replace("</sitemapindex>", `  <sitemap><loc>https://auboisrieur.fr/sitemap-maisons.xml</loc><lastmod>${today}</lastmod></sitemap>\n</sitemapindex>`);
  fs.writeFileSync(SITE + "/sitemap.xml", idx);
  console.log("Index updated with sitemap-maisons.xml");
} else {
  console.log("Index already references sitemap-maisons.xml");
}
console.log("sitemap-maisons.xml: " + u.length + " URLs");
