import fs from "fs";
const D = "$";
let log = [];

// ── A. build.mjs : noindex fiches sans vrai titre + exclusion sitemap ──
let c = fs.readFileSync("/var/www/adjuge/scripts/build.mjs", "utf-8");

// A1. Add hasRealTitle var after the title line in buildLotPage
const titleLine = `  const title = (lot.ai_title && lot.title && lot.title.length > 5) ? lot.ai_title : (lot.clean_title || lot.title || lot.category || "Lot invendu");`;
const titleLinePlus = titleLine + `\n  const hasRealTitle = !!((lot.ai_title && lot.ai_title.length > 2) || (lot.clean_title && lot.clean_title.length > 2) || (lot.title && lot.title.length > 2));`;
if (c.includes(titleLine)) { c = c.replace(titleLine, titleLinePlus); log.push("✓ hasRealTitle ajouté"); }
else log.push("✗ ligne title non trouvée");

// A2. Inject noindex into the htmlHead extra arg (before og:image line)
const ogLine = `    ${D}{photos[0] ? \`<meta property="og:image" content="${D}{photos[0]}">\` : ''}`;
const ogLineNoindex = `    ${D}{hasRealTitle ? '' : '<meta name="robots" content="noindex,follow">'}\n` + ogLine;
if (c.includes(ogLine)) { c = c.replace(ogLine, ogLineNoindex); log.push("✓ noindex conditionnel ajouté"); }
else log.push("✗ ligne og:image non trouvée");

// A3. Exclude no-title lots from sitemap
const allSlugsLine = `  const allSlugs = db.prepare("SELECT slug FROM lots WHERE sold=0").all();`;
const allSlugsFiltered = `  const allSlugs = db.prepare("SELECT slug FROM lots WHERE sold=0 AND (length(COALESCE(ai_title,''))>2 OR length(COALESCE(clean_title,''))>2 OR length(COALESCE(title,''))>2)").all();`;
if (c.includes(allSlugsLine)) { c = c.replace(allSlugsLine, allSlugsFiltered); log.push("✓ sitemap exclut lots sans titre"); }
else log.push("✗ allSlugs non trouvé");

fs.writeFileSync("/var/www/adjuge/scripts/build.mjs", c);

// ── B. fix-cats-post-ingest.mjs : supprimer le DELETE destructeur ──
let p = fs.readFileSync("/var/www/adjuge/scripts/fix-cats-post-ingest.mjs", "utf-8");
const delLine = `  // Delete lots without any usable content (no title AND no description)
  \`DELETE FROM lots WHERE sold=0 AND (title IS NULL OR length(title)<3) AND (clean_title IS NULL OR length(clean_title)<3) AND (ai_title IS NULL OR length(ai_title)<3) AND (description IS NULL OR length(description)<3)\`,`;
if (p.includes(delLine)) { p = p.replace(delLine, `  // (Plus de DELETE — les lots sans titre sont gardés en noindex pour éviter les 404 sur des URLs déjà indexées)`); log.push("✓ DELETE retiré du post-ingest"); }
else log.push("✗ DELETE post-ingest non trouvé");
fs.writeFileSync("/var/www/adjuge/scripts/fix-cats-post-ingest.mjs", p);

console.log(log.join("\n"));
