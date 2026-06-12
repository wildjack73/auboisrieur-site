import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");

function slugify(t) { return String(t||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").substring(0,80); }

// Only invendus with bad slug that now have a usable title
const lots = db.prepare("SELECT id, slug, ai_title, clean_title, title FROM lots WHERE sold=0 AND slug LIKE '-%'").all();
const upd = db.prepare("UPDATE lots SET slug=? WHERE id=?");
let changed = 0;
const tx = db.transaction(() => {
  for (const l of lots) {
    const best = (l.ai_title&&l.ai_title.length>3)?l.ai_title:(l.clean_title&&l.clean_title.length>3)?l.clean_title:l.title;
    const base = slugify(best);
    if (!base) continue;
    const newSlug = base + "-" + l.id;
    if (newSlug !== l.slug) { upd.run(newSlug, l.id); changed++; }
  }
});
tx();
if (changed > 0) console.log(`  🔗 ${changed} slugs régénérés`);
db.close();
