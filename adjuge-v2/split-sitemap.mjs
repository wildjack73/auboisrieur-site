import fs from "fs";
const SITE_DIR = "/var/www/adjuge/site";
const raw = fs.readFileSync(SITE_DIR + "/sitemap.xml", "utf-8");
const urls = raw.match(/<url>[\s\S]*?<\/url>/g) || [];
console.log("Total URLs:", urls.length);

const LIMIT = 45000;
const sitemaps = [];

for (let i = 0; i < urls.length; i += LIMIT) {
  const chunk = urls.slice(i, i + LIMIT);
  const idx = Math.floor(i / LIMIT) + 1;
  const name = "sitemap-" + idx + ".xml";
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + chunk.join("\n") + "\n</urlset>";
  fs.writeFileSync(SITE_DIR + "/" + name, xml);
  sitemaps.push(name);
  console.log(name + ": " + chunk.length + " URLs");
}

// Create sitemap index
const today = new Date().toISOString().split("T")[0];
let idx = '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
sitemaps.forEach(s => {
  idx += '  <sitemap><loc>https://auboisrieur.fr/' + s + '</loc><lastmod>' + today + '</lastmod></sitemap>\n';
});
idx += '</sitemapindex>';
fs.writeFileSync(SITE_DIR + "/sitemap.xml", idx);
console.log("\nSitemap index created with " + sitemaps.length + " sitemaps");
