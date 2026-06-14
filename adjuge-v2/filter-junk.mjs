import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const DRY = process.argv.includes("--dry");

// Pure administrative notices or non-presented lots scraped as a "lot title".
// These have no real object — hide them from every listing via sold=2 (all
// listing queries filter sold=0). Runs each scrape (ingest resets sold=0).
const JUNK = [
  /^\s*la\s+cr[ée]ation\s+du\s+compte/i,        // "LA CREATION DU COMPTE SIA EST OBLIGATOIRE..."
  /^\s*ce\s+lot\s+est\s+vendu\s+par\b/i,         // "CE LOT EST VENDU PAR SELAS LAGRANGE (frais...)"
  /^\s*frais\s+acheteur\b/i,                      // "FRAIS ACHETEUR A 8% HT..."
  /^\s*attention\b.{0,15}vente\s+sav/i,           // "ATTENTION – Vente SAV Lots vendus en l'état"
  /^\s*vente\s+sav\s+non\s+test/i,                // "Vente SAV non testé vendu en l'état - MERCI..."
  /merci\s+de\s+lire\s+attentiv/i,                // notices ending in "MERCI DE LIRE ATTENTIVEMENT"
  /^\s*lot\s+(non|pas)\s+venu\b/i,                // "Lot Non Venu", "Lot Pas Venu"
  /^\s*non\s+venu\b/i,                            // "Non Venu Non Venu"
  /^\s*lot\s+retir[ée]/i,                         // "Lot Retiré"
  /^\s*lot\s+annul[ée]/i,                         // "Lot Annulé"
];

const isJunk = t => JUNK.some(re => re.test(t || ""));

const lots = db.prepare("SELECT id, clean_title, title FROM lots WHERE sold=0").all();
const upd = db.prepare("UPDATE lots SET sold=2 WHERE id=?");
let n = 0;
const ex = [];
const tx = db.transaction(() => {
  for (const l of lots) {
    const t = l.clean_title || l.title || "";
    if (isJunk(t)) {
      if (!DRY) upd.run(l.id);
      n++;
      if (ex.length < 15) ex.push("  " + JSON.stringify(t.slice(0, 70)));
    }
  }
});
tx();
console.log(`\n${DRY ? "[DRY] " : ""}Lots parasites détectés : ${n} / ${lots.length} invendus`);
console.log("Exemples :\n" + ex.join("\n"));
console.log(DRY ? "\n[DRY RUN — rien modifié]" : `\n🗑️ ${n} lots masqués (sold=2)`);
db.close();
