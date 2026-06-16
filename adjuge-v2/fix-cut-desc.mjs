import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const DRY = process.argv.includes("--dry");

// Existing ai_desc were stored cut at 800 chars (often mid-word). The text beyond
// is gone, so trim back to the last complete sentence for a clean ending.
function trimSentence(s) {
  s = String(s || "").trim();
  if (/[.!?»"’)]$/.test(s)) return s;            // already ends cleanly
  const dot = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
  if (dot > 60) return s.slice(0, dot + 1).trim();
  const sp = s.lastIndexOf(" ");
  return sp > 60 ? s.slice(0, sp).trim() + "…" : s;
}

const rows = db.prepare("SELECT id, ai_desc FROM lots WHERE sold=0 AND ai_desc IS NOT NULL AND length(ai_desc) >= 780").all();
const upd = db.prepare("UPDATE lots SET ai_desc=? WHERE id=?");
let n = 0;
const ex = [];
const tx = db.transaction(() => {
  for (const r of rows) {
    const t = trimSentence(r.ai_desc);
    if (t !== r.ai_desc && t.length > 80) {
      if (!DRY) upd.run(t, r.id);
      n++;
      if (ex.length < 4) ex.push("  …" + JSON.stringify(r.ai_desc.slice(-45)) + "  →  …" + JSON.stringify(t.slice(-45)));
    }
  }
});
tx();
console.log(`${DRY ? "[DRY] " : ""}${n} / ${rows.length} descriptions coupées nettoyées (fin de phrase propre)`);
console.log(ex.join("\n"));
db.close();
