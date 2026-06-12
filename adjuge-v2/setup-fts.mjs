import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");

const lots = db.prepare("SELECT id, slug, ai_title, clean_title, title, category, city, estimate_high, thumb, ai_deal_score FROM lots WHERE sold=0").all();

// Atomic rebuild: build new table, swap in transaction (no downtime for readers)
db.exec("DROP TABLE IF EXISTS lots_fts_new");
db.exec(`CREATE VIRTUAL TABLE lots_fts_new USING fts5(
  id UNINDEXED, slug UNINDEXED, title, category, city,
  price UNINDEXED, thumb UNINDEXED, score UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
)`);
const ins = db.prepare("INSERT INTO lots_fts_new (id,slug,title,category,city,price,thumb,score) VALUES (?,?,?,?,?,?,?,?)");
const fill = db.transaction(() => {
  for (const l of lots) {
    const t = (l.ai_title&&l.ai_title.length>3)?l.ai_title:(l.clean_title&&l.clean_title.length>3)?l.clean_title:(l.title||"");
    ins.run(l.id, l.slug, t, l.category||"", l.city||"", l.estimate_high||0, l.thumb||"", l.ai_deal_score||0);
  }
});
fill();
// Swap atomically
const swap = db.transaction(() => {
  db.exec("DROP TABLE IF EXISTS lots_fts");
  db.exec("ALTER TABLE lots_fts_new RENAME TO lots_fts");
});
swap();
console.log("  🔍 FTS index: " + lots.length.toLocaleString("fr-FR") + " lots");
db.close();
