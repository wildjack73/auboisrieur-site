import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");

// ── STEP 0: Assign category from category_id when category name is missing ──
// Build category_id → most common category name mapping from lots that have both
const mapping = {};
const rows = db.prepare("SELECT category_id, category, COUNT(*) as c FROM lots WHERE category_id IS NOT NULL AND length(category)>0 GROUP BY category_id, category ORDER BY category_id, c DESC").all();
for (const r of rows) {
  if (!mapping[r.category_id]) mapping[r.category_id] = r.category;
}
const fixCatStmt = db.prepare("UPDATE lots SET category=? WHERE id=?");
const noCat = db.prepare("SELECT id, category_id FROM lots WHERE (category IS NULL OR length(category)=0) AND category_id IS NOT NULL").all();
let catAssigned = 0;
const txCat = db.transaction(() => {
  for (const l of noCat) {
    if (mapping[l.category_id]) { fixCatStmt.run(mapping[l.category_id], l.id); catAssigned++; }
  }
});
txCat();
if (catAssigned > 0) console.log(`  📂 ${catAssigned} catégories attribuées via category_id`);

const fixes = [
  // Vin/bouteilles dans Luminaires, Pendules, Bijoux, Informatique
  `UPDATE lots SET category = 'Vins & Spiritueux' WHERE category NOT IN ('Vins & Spiritueux') AND (
    title LIKE '%bouteill%' OR title LIKE '%champagn%' OR title LIKE '%cognac%'
    OR title LIKE '%whisky%' OR title LIKE '%armagnac%' OR title LIKE '%rhum%'
    OR title LIKE '%château%' OR title LIKE '%domaine%' OR title LIKE '%cuvée%'
    OR title LIKE '%millésim%' OR title LIKE '%bourgogn%' OR title LIKE '%bordeaux%'
    OR title LIKE '%pommard%' OR title LIKE '%meursault%' OR title LIKE '%gevrey%'
    OR title LIKE '%romanée%' OR title LIKE '%chambertin%' OR title LIKE '%pauillac%'
    OR title LIKE '%saint-émilion%' OR title LIKE '%médoc%' OR title LIKE '%petrus%'
    OR title LIKE '%magnum%' OR title LIKE '% cru %' OR title LIKE '%spiritueux%'
  ) AND title NOT LIKE '%lustre%' AND title NOT LIKE '%lampe%' AND title NOT LIKE '%applique%'`,

  // Montres/bijoux mal catégorisés
  `UPDATE lots SET category = 'Bijoux & Pierres Précieuses' WHERE category NOT IN ('Bijoux & Pierres Précieuses','Bijoux - Montres') AND (
    title LIKE '%ROLEX%' OR title LIKE '%Rolex%' OR title LIKE '%CARTIER%'
    OR title LIKE '%Cartier%' OR title LIKE '%CHOPARD%' OR title LIKE '%BREITLING%'
    OR title LIKE '%PATEK PHILIPPE%' OR title LIKE '%AUDEMARS PIGUET%'
    OR title LIKE '%TAG HEUER%' OR title LIKE '%OMEGA Seamaster%'
    OR title LIKE '%OMEGA Speedmaster%' OR title LIKE '%IWC%montre%'
    OR title LIKE '%VACHERON%' OR title LIKE '%TUDOR%montre%'
    OR clean_title LIKE '%Rolex%' OR clean_title LIKE '%Cartier%' OR clean_title LIKE '%Chopard%'
  )`,

  // Montres dans Vins → Bijoux
  `UPDATE lots SET category='Bijoux & Pierres Précieuses' WHERE category='Vins & Spiritueux' AND (lower(title) LIKE '%montre%' OR lower(clean_title) LIKE '%montre%')`,

  // Noms de domaine → catégorie dédiée (souvent mal rangés en Vins)
  `UPDATE lots SET category='Noms de domaine' WHERE title LIKE 'Nom de domaine%' OR clean_title LIKE 'Nom de domaine%'`,

  // Jouets/voitures miniatures dans Objets d'art → Jouets & Modélisme
  `UPDATE lots SET category='Jouets & Modélisme' WHERE category='Objets d''art & Curiosités' AND (
    lower(title) LIKE '%dinky%' OR lower(title) LIKE '%modèle réduit%' OR lower(title) LIKE '%modele reduit%'
    OR lower(title) LIKE '%à pédale%' OR lower(title) LIKE '%miniature%' OR lower(title) LIKE '%jouet%'
    OR title LIKE '%JEP %' OR title LIKE '%CIJ %' OR title LIKE '%DINKY%'
    OR lower(title) LIKE '%solido%' OR lower(title) LIKE '%bburago%' OR lower(title) LIKE '%burago%'
    OR lower(title) LIKE '%joustra%' OR lower(title) LIKE '%fleischmann%' OR lower(title) LIKE '%norev%'
    OR lower(title) LIKE '%majorette%' OR lower(title) LIKE '%corgi%' OR lower(title) LIKE '%matchbox%'
    OR lower(title) LIKE '%maquette%' OR lower(title) LIKE '%modèles réduits%'
  )`,

  // Livres dans Numismatique
  `UPDATE lots SET category = 'Livres & Manuscrits' WHERE category = 'Numismatique' AND (
    title LIKE '%livre%' OR title LIKE '%Livre%' OR title LIKE '%ouvrage%'
    OR title LIKE '%manuscrit%' OR title LIKE '%édition%' OR title LIKE '%reliure%'
    OR title LIKE '%atlas%' OR title LIKE '%dictionnaire%' OR title LIKE '%encyclop%'
    OR title LIKE '%tome%' OR title LIKE '%volume%'
  )`,

  // Tableaux dans Pendules
  `UPDATE lots SET category = 'Tableaux, Dessins & Estampes' WHERE category = 'Pendules & Horloges' AND (
    title LIKE '%tableau%' OR title LIKE '%Tableau%' OR title LIKE '%huile sur%'
    OR title LIKE '%aquarelle%' OR title LIKE '%lithograph%' OR title LIKE '%estampe%'
    OR title LIKE '%gravure%' OR title LIKE '%peinture%' OR title LIKE '%toile%'
  )`,

  // Normalize city names
  `UPDATE lots SET city = 'Toulouse' WHERE city = 'TOULOUSE'`,
  `UPDATE lots SET city = 'Nantes' WHERE city = 'NANTES'`,
  `UPDATE lots SET city = 'Meaux' WHERE city = 'MEAUX'`,
  `UPDATE lots SET city = 'Paris' WHERE city = 'PARIS'`,
  `UPDATE lots SET city = 'Bordeaux' WHERE city = 'BORDEAUX'`,
  `UPDATE lots SET city = 'Brasles' WHERE city = 'BRASLES'`,
  `UPDATE lots SET city = 'Lyon' WHERE city = 'LYON'`,

  // Delete lots without any usable content (no title AND no description)
  `DELETE FROM lots WHERE sold=0 AND (title IS NULL OR length(title)<3) AND (clean_title IS NULL OR length(clean_title)<3) AND (ai_title IS NULL OR length(ai_title)<3) AND (description IS NULL OR length(description)<3)`,
];

let total = 0;
for (const sql of fixes) {
  const r = db.prepare(sql).run();
  if (r.changes > 0) total += r.changes;
}
console.log(`  🧹 Post-ingest cleanup: ${total} corrections`);
db.close();
