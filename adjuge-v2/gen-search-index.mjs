import Database from "better-sqlite3";
import fs from "fs";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const SITE_DIR = "/var/www/adjuge/site";

const lots = db.prepare(`
  SELECT slug, ai_title, clean_title, title, estimate_low, estimate_high, category, city, thumb, ai_deal_score
  FROM lots WHERE sold=0
`).all();

const index = lots.map(l => {
  const t = (l.ai_title && l.ai_title.length>3) ? l.ai_title : (l.clean_title && l.clean_title.length>3) ? l.clean_title : (l.title||"");
  const o = { s: l.slug, t: t.substring(0,80) };
  if (l.estimate_high) o.p = Math.round(l.estimate_high);
  if (l.category) o.c = l.category;
  if (l.city) o.v = l.city;
  if (l.thumb) o.img = l.thumb;
  if (l.ai_deal_score > 0) o.ds = l.ai_deal_score;
  return o;
});

const out = "window.__SD=" + JSON.stringify(index) + ";";
fs.writeFileSync(SITE_DIR + "/search-data.js", out);
const mb = (out.length/1024/1024).toFixed(1);
console.log(`Index recherche: ${index.length.toLocaleString("fr-FR")} lots, ${mb} MB`);
db.close();
