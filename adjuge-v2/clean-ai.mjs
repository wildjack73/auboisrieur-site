import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");

const norm = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
const brands = ["chanel","hermes","birkin","kelly","louis vuitton","vuitton","gucci","prada","dior","rolex","cartier","omega","breitling","patek philippe","rolls royce","ferrari","porsche","lamborghini","bugatti"];

const lots = db.prepare("SELECT id, title, clean_title, ai_title FROM lots WHERE ai_title IS NOT NULL AND length(ai_title)>3").all();
const clearAi = db.prepare("UPDATE lots SET ai_title=NULL WHERE id=?");
let cleared = 0;
const tx = db.transaction(() => {
  for (const l of lots) {
    const orig = norm((l.title||"")+" "+(l.clean_title||""));
    const ai = norm(l.ai_title);
    for (const b of brands) {
      if (ai.includes(b) && !orig.includes(b)) { clearAi.run(l.id); cleared++; break; }
    }
  }
});
tx();
// Belt & suspenders: clear any NaN that slipped in
db.prepare("UPDATE lots SET ai_price_analysis=NULL WHERE ai_price_analysis LIKE '%NaN%'").run();
db.prepare("UPDATE lots SET ai_deal_analysis=NULL WHERE ai_deal_analysis LIKE '%NaN%'").run();
if (cleared > 0) console.log("  🧠 " + cleared + " titres IA hallucinés annulés");
db.close();
