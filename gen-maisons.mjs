import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DB = "/var/www/adjuge/data/adjuge.db";
const SITE = "/var/www/adjuge/site";
const URL = "https://auboisrieur.fr";
const db = new Database(DB, { readonly: true });

const slugify = t => String(t||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").substring(0,80);
const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const fp = n => Number(n||0).toLocaleString("fr-FR");

const GTM = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-MDW75MLB');</script>`;

const NAV = `<nav class="sticky top-0 z-50 backdrop-blur-2xl bg-[#09090f]/85 border-b border-white/[0.04]"><div class="max-w-7xl mx-auto px-4 md:px-6 flex items-center justify-between h-16"><a href="/" class="flex items-center gap-2.5"><div class="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-lg font-black">A</div><span class="text-xl font-extrabold text-white">Adjugé<span class="text-indigo-400">!</span> <span class="text-[#39FF14]">In</span>vendu<span class="text-amber-400">!</span></span></a><div class="hidden md:flex items-center gap-1 text-[0.82rem]"><a href="/" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Invendus</a><a href="/categories.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Catégories</a><a href="/villes.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Villes</a><a href="/maisons.html" class="px-4 py-2 rounded-lg text-white font-semibold bg-white/[0.04]">Maisons</a><a href="/blog.html" class="px-4 py-2 rounded-lg text-gray-300 hover:text-white hover:bg-white/[0.04] transition font-medium">Blog</a><a href="/bonnes-affaires.html" class="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/20 text-amber-400 font-semibold text-xs">🔥 Bonnes affaires</a></div></div></nav>`;

const FOOT = `<footer class="border-t border-white/[0.04] mt-16 py-8 text-center text-xs text-gray-600"><a href="/" class="text-gray-400 hover:text-white">Adjugé ! Invendu !</a> · <a href="/maisons.html" class="text-gray-400 hover:text-white">Maisons de vente</a> · <a href="/categories.html" class="text-gray-400 hover:text-white">Catégories</a></footer>`;

const STYLE = `<style>*{box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#09090f;color:#d4d4dc;margin:0}a{text-decoration:none}select{color-scheme:dark}.card{background:#14141e;border:1px solid rgba(255,255,255,0.05);border-radius:16px;overflow:hidden;transition:all .25s}.card:hover{border-color:rgba(129,140,248,0.15);box-shadow:0 12px 40px rgba(0,0,0,.4)}.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:.7rem;font-weight:700}.deal-fire{background:linear-gradient(135deg,#f59e0b,#ef4444);color:#000;box-shadow:0 2px 8px rgba(0,0,0,.4)}.deal-super{background:#2563eb;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.45)}.deal-good{background:#16a34a;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.45)}.prose p{margin:.8rem 0;line-height:1.7;color:#9ca3af}.faq{background:#14141e;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:1.2rem;margin:.8rem 0}.faq h3{color:#e4e4ec;font-size:.95rem;margin:0 0 .4rem}.faq p{margin:0;color:#9ca3af;font-size:.88rem}</style>`;

const maisons = db.prepare(`SELECT org_name, org_email, org_phone, org_address, MAX(city) city, MAX(postcode) pc,
  COUNT(*) total, SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) unsold,
  SUM(CASE WHEN sold=1 THEN 1 ELSE 0 END) sold,
  AVG(CASE WHEN sold=0 AND estimate_high>0 THEN estimate_high END) avg_est
  FROM lots WHERE length(org_name)>3 GROUP BY org_name HAVING unsold>0 ORDER BY unsold DESC`).all();

fs.mkdirSync(path.join(SITE,"maison"), { recursive: true });
const sitemapUrls = [`<url><loc>${URL}/maisons.html</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`];
let count = 0;

for (const m of maisons) {
  const slug = slugify(m.org_name);
  const lots = db.prepare("SELECT * FROM lots WHERE sold=0 AND org_name=? AND (length(clean_title)>3 OR length(title)>3 OR length(ai_title)>3) ORDER BY ai_deal_score DESC, estimate_high DESC LIMIT 36").all(m.org_name);
  if (!lots.length) continue;

  // Top categories of this maison
  const topCats = db.prepare("SELECT category, COUNT(*) c FROM lots WHERE sold=0 AND org_name=? AND length(category)>0 GROUP BY category ORDER BY c DESC LIMIT 5").all(m.org_name);
  const deals = db.prepare("SELECT COUNT(*) c FROM lots WHERE sold=0 AND org_name=? AND ai_deal_score>=1").get(m.org_name).c;
  const ville = m.city ? esc(m.city) : "";

  const lotCards = lots.map(l => {
    const t = (l.ai_title&&l.ai_title.length>3)?l.ai_title:(l.clean_title||l.title||l.category||"Lot invendu");
    const ds = l.ai_deal_score||0;
    const badge = ds>=3?'<span class="badge deal-fire" style="position:absolute;top:8px;right:8px">🔥 TOP</span>':ds>=2?'<span class="badge deal-super" style="position:absolute;top:8px;right:8px">⭐ Super</span>':ds>=1?'<span class="badge deal-good" style="position:absolute;top:8px;right:8px">Bonne affaire</span>':'';
    const est = (l.estimate_low&&l.estimate_high)?`<div style="color:#818cf8;font-weight:600;font-size:.85rem;margin-top:4px">${fp(l.estimate_low)} – ${fp(l.estimate_high)} €</div>`:'';
    let h = `<a href="/lot/${esc(l.slug)}.html" class="card block relative" style="text-decoration:none">`;
    if (l.thumb) h += `<div style="aspect-ratio:4/3;overflow:hidden;background:#0d0d14;border-radius:12px 12px 0 0"><img src="${esc(l.thumb)}" alt="${esc(t)}" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>`;
    h += badge + `<div style="padding:12px"><h3 style="color:#e4e4ec;font-size:.82rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(t)}</h3>${est}<div style="color:#6b7280;font-size:.7rem;margin-top:4px">${esc(l.category||"")}</div></div></a>`;
    return h;
  }).join("");

  const catLinks = topCats.map(c => `<a href="/categorie/${slugify(c.category)}.html" class="px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-xs text-gray-300 hover:text-white transition">${esc(c.category)} <span class="text-gray-600">${c.c}</span></a>`).join("");

  // Unique intro paragraph
  const catList = topCats.slice(0,3).map(c=>c.category.toLowerCase()).join(", ");
  const intro = `<strong class="text-white">${esc(m.org_name)}</strong> est une maison de vente aux enchères${ville?` située à ${ville}`:""}. Retrouvez ici <strong class="text-white">${fp(m.unsold)} lots invendus</strong> actuellement disponibles${catList?`, principalement en ${esc(catList)}`:""}. Ces objets n'ont pas trouvé preneur lors des ventes et peuvent souvent être acquis en dessous de leur estimation en contactant directement la maison.${deals?` Notre algorithme a identifié <strong class="text-amber-400">${fp(deals)} bonnes affaires</strong> parmi eux.`:""}`;

  const title = `${esc(m.org_name)} — Invendus & résultats de ventes aux enchères${ville?` (${ville})`:""}`;
  const metaDesc = `${fp(m.unsold)} lots invendus chez ${esc(m.org_name)}${ville?` à ${ville}`:""}. Consultez les invendus, estimations et bonnes affaires — contactez la maison pour négocier.`;

  const orgSchema = JSON.stringify({"@context":"https://schema.org","@type":"Organization","name":m.org_name,"email":m.org_email||undefined,"telephone":m.org_phone||undefined,"address":ville?{"@type":"PostalAddress","addressLocality":m.city,"postalCode":m.pc||undefined}:undefined});
  const faqSchema = JSON.stringify({"@context":"https://schema.org","@type":"FAQPage","mainEntity":[
    {"@type":"Question","name":`Comment acheter un lot invendu chez ${m.org_name} ?`,"acceptedAnswer":{"@type":"Answer","text":`Contactez directement ${m.org_name}${m.org_phone?` au ${m.org_phone}`:""}${m.org_email?` ou par email à ${m.org_email}`:""} pour connaître la disponibilité du lot et faire une offre. Les invendus se négocient souvent en dessous de l'estimation.`}},
    {"@type":"Question","name":`Combien de lots invendus chez ${m.org_name} ?`,"acceptedAnswer":{"@type":"Answer","text":`${fp(m.unsold)} lots invendus sont actuellement répertoriés${ville?` pour cette maison à ${ville}`:""}.`}},
    {"@type":"Question","name":`Où se situe ${m.org_name} ?`,"acceptedAnswer":{"@type":"Answer","text":m.org_address?`${m.org_name} est située à ${m.org_address}.`:`${m.org_name}${ville?` est située à ${ville}`:""}.`}}
  ]});

  const html = `<!DOCTYPE html><html lang="fr" class="dark"><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg" type="image/svg+xml">${GTM}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Adjugé</title><meta name="description" content="${esc(metaDesc)}"><link rel="canonical" href="${URL}/maison/${slug}.html"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><script src="https://cdn.tailwindcss.com"></script>${STYLE}<script type="application/ld+json">${orgSchema}</script><script type="application/ld+json">${faqSchema}</script></head><body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MDW75MLB" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>${NAV}
<div class="max-w-7xl mx-auto px-4 md:px-6 py-8">
<nav class="text-sm text-gray-500 mb-6"><a href="/" class="hover:text-white">Invendus</a> › <a href="/maisons.html" class="hover:text-white">Maisons de vente</a> › <span class="text-gray-400">${esc(m.org_name)}</span></nav>
<div class="card p-6 mb-6"><h1 class="text-2xl md:text-3xl font-bold text-white mb-3">${esc(m.org_name)}</h1>
<div class="prose mb-4"><p>${intro}</p></div>
<div class="flex flex-wrap gap-4 text-sm mb-4">
${m.org_phone?`<a href="tel:${esc(m.org_phone)}" style="color:#818cf8" class="flex items-center gap-2">📞 ${esc(m.org_phone)}</a>`:""}
${m.org_email?`<a href="mailto:${esc(m.org_email)}" style="color:#818cf8" class="flex items-center gap-2">✉️ ${esc(m.org_email)}</a>`:""}
${m.org_address?`<span class="text-gray-400">📍 ${esc(m.org_address)}</span>`:""}
</div>
${catLinks?`<div class="flex flex-wrap gap-2">${catLinks}</div>`:""}
</div>
<h2 class="text-lg font-bold text-white mb-4">${fp(m.unsold)} lots invendus${ville?` à ${ville}`:""}</h2>
<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">${lotCards}</div>
${m.unsold>36?`<div class="text-center mt-8"><a href="/recherche.html" class="inline-block px-8 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition text-sm">Voir tous les invendus →</a></div>`:""}
<section class="mt-12 max-w-3xl">
<h2 class="text-lg font-bold text-white mb-3">Acheter un invendu chez ${esc(m.org_name)}</h2>
<div class="faq"><h3>Comment acheter un lot invendu chez ${esc(m.org_name)} ?</h3><p>Contactez directement la maison${m.org_phone?` au ${esc(m.org_phone)}`:""}${m.org_email?` ou par email`:""} pour connaître la disponibilité et faire une offre. Les invendus se négocient souvent 10 à 25% sous l'estimation.</p></div>
<div class="faq"><h3>Combien de lots invendus sont disponibles ?</h3><p>${fp(m.unsold)} lots invendus sont actuellement répertoriés${ville?` pour ${esc(m.org_name)} à ${ville}`:""}, dont ${fp(deals)} identifiés comme de bonnes affaires.</p></div>
${m.org_address?`<div class="faq"><h3>Où se situe ${esc(m.org_name)} ?</h3><p>${esc(m.org_address)}.</p></div>`:""}
</section>
</div>${FOOT}</body></html>`;

  fs.writeFileSync(path.join(SITE,"maison",slug+".html"), html);
  sitemapUrls.push(`<url><loc>${URL}/maison/${slug}.html</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  count++;
}

// Index page
const idxCards = maisons.filter(m=>m.unsold>0).map(m=>{
  const slug=slugify(m.org_name);
  return `<a href="/maison/${slug}.html" class="card block p-5"><h3 class="text-white font-bold text-sm">${esc(m.org_name)}</h3><div style="color:#818cf8;font-size:.75rem;font-weight:600;margin-top:4px">${fp(m.unsold)} invendus</div>${m.city?`<div style="color:#6b7280;font-size:.72rem;margin-top:2px">📍 ${esc(m.city)}</div>`:""}</a>`;
}).join("");
const idxHtml = `<!DOCTYPE html><html lang="fr" class="dark"><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg" type="image/svg+xml">${GTM}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Maisons de vente aux enchères en France — Invendus | Adjugé</title><meta name="description" content="${count} maisons de vente aux enchères en France. Consultez les lots invendus par maison (Alcopa, Osenat, Jura Enchères, Fenel...) et trouvez des bonnes affaires."><link rel="canonical" href="${URL}/maisons.html"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><script src="https://cdn.tailwindcss.com"></script>${STYLE}</head><body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MDW75MLB" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>${NAV}<div class="max-w-7xl mx-auto px-4 md:px-6 py-8"><h1 class="text-2xl font-bold text-white mb-2">Maisons de vente aux enchères</h1><p class="text-gray-400 mb-8">${count} maisons de vente en France avec des lots invendus disponibles. Cliquez pour voir les invendus et contacter directement la maison.</p><div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">${idxCards}</div></div>${FOOT}</body></html>`;
fs.writeFileSync(path.join(SITE,"maisons.html"), idxHtml);

// Append maison URLs to sitemap.xml (before </urlset>)
try {
  let sm = fs.readFileSync(path.join(SITE,"sitemap.xml"),"utf-8");
  if (sm.includes("</urlset>") && !sm.includes("/maison/")) {
    sm = sm.replace("</urlset>", sitemapUrls.join("\n")+"\n</urlset>");
    fs.writeFileSync(path.join(SITE,"sitemap.xml"), sm);
  }
} catch(e){}

console.log("  🏛️ Maisons: "+count+" pages générées (+ index + sitemap)");
db.close();
