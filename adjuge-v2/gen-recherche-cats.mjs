import Database from "better-sqlite3";
import fs from "fs";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const cats = db.prepare("SELECT category, COUNT(*) c FROM lots WHERE sold=0 AND length(category)>0 GROUP BY category ORDER BY c DESC").all();
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
const opts = '<option value="">Toutes catégories</option>' + cats.map(c=>`<option value="${esc(c.category)}">${esc(c.category)} (${c.c.toLocaleString("fr-FR")})</option>`).join("");
let h = fs.readFileSync("/var/www/adjuge/site/recherche.html","utf-8");
// Replace everything between sc select tag and its close
h = h.replace(/(<select id="sc"[^>]*>)[\s\S]*?(<\/select>)/, `$1${opts}$2`);
fs.writeFileSync("/var/www/adjuge/site/recherche.html", h);
console.log("  🔎 "+cats.length+" catégories injectées dans le menu");
db.close();
