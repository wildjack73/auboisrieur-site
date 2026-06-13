import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const DRY = process.argv.includes("--dry");

const STOP = new Set(["lot","objet","objets","art","curiosites","voiture","voitures","particuliere","particulieres","vente","ventes","invendu","invendus","frais","acheteur","destockage","instruments","musique","bijoux","pierres","precieuses","mobilier","ancien","ancienne","vins","spiritueux","verrerie","cristallerie","maroquinerie","luxe","ceramiques","porcelaine","arts","asie","militaria","alcopa","auction","estimation","euros","sans","avec","pour","dans","sur","les","des","une","cette","alcopa"]);

const norm = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
const tokens = s => norm(s).match(/[a-z0-9]{4,}/g) || [];

// Candidates: AI title carries the giveup "Estimation ... €" signature
const cands = db.prepare("SELECT id, clean_title, title, ai_title FROM lots WHERE sold=0 AND ai_title LIKE '%Estimation%€' AND length(clean_title)>15").all();

const reset = db.prepare("UPDATE lots SET ai_title=NULL, ai_desc=NULL, ai_deal_analysis=NULL, ai_price_analysis='', ai_faq='[]', ai_deal_score=-1 WHERE id=?");

let toReset = 0, kept = 0;
const resetEx = [], keptEx = [];

const run = db.transaction(() => {
  for (const l of cands) {
    const at = norm(l.ai_title);
    const ctToks = tokens(l.clean_title).filter(t => !STOP.has(t));
    // meaningful word from the real title present in the AI title?
    const overlap = ctToks.some(t => at.includes(t));
    if (ctToks.length > 0 && !overlap) {
      // AI title is disconnected from the real object → broken giveup title
      if (!DRY) reset.run(l.id);
      toReset++;
      if (resetEx.length < 12) resetEx.push(`  RESET  "${(l.clean_title||"").slice(0,45)}"  <=  "${l.ai_title}"`);
    } else {
      kept++;
      if (keptEx.length < 8) keptEx.push(`  KEEP   "${(l.clean_title||"").slice(0,45)}"  =>  "${l.ai_title}"`);
    }
  }
});
run();

console.log(`\nCandidates (Estimation-signature + rich clean_title): ${cands.length}`);
console.log(`RESET (broken giveup titles): ${toReset}`);
console.log(`KEEP  (ai_title references the object): ${kept}`);
console.log("\n--- examples RESET ---\n" + resetEx.join("\n"));
console.log("\n--- examples KEEP ---\n" + keptEx.join("\n"));
console.log(DRY ? "\n[DRY RUN — nothing written]" : "\n[APPLIED — these lots will be re-scored on next pipeline cycle]");
db.close();
