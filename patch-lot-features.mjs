import fs from "fs";
let c = fs.readFileSync("/var/www/adjuge/scripts/build.mjs", "utf-8");
const D = "$";
let log = [];

// ── 1. Prix conseillé pour négocier — inséré avant <!-- Contact --> ──
const contactMarker = `        <!-- Contact -->`;
const prixBox = `        ${D}{lot.estimate_low ? \`
        <div class="rounded-xl p-4 border border-amber-500/20" style="background:rgba(245,158,11,0.06)">
          <div class="text-xs font-bold text-amber-400 mb-1 flex items-center gap-1">🏷️ Prix conseillé pour négocier</div>
          <div class="text-2xl font-black text-white">${D}{formatPrice(Math.round(lot.estimate_low*0.75))} – ${D}{formatPrice(Math.round(lot.estimate_high*0.9))} €</div>
          <div class="text-[0.7rem] text-gray-500 mt-1">Une offre 10–25% sous l'estimation est souvent acceptée sur un invendu. Contactez la maison de vente pour proposer votre prix.</div>
        </div>\` : ''}

        <!-- Contact -->`;
if (c.includes(contactMarker)) { c = c.replace(contactMarker, prixBox); log.push("✓ Prix conseillé ajouté à la fiche"); }
else log.push("✗ marqueur Contact non trouvé");

// ── 2. Lots similaires (client-side via API) — inséré avant footer ──
const footerMarker = `</article>\n\n${D}{footerHtml()}`;
const similar = `</article>

<div class="max-w-7xl mx-auto px-4 md:px-6 pb-12">
  <h2 class="text-xl font-bold text-white mb-6">Lots similaires</h2>
  <div id="similarGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4"></div>
</div>
<script>
(function(){
  var cat=${D}{JSON.stringify(lot.category||"")}, cur=${D}{JSON.stringify(lot.slug||"")};
  if(!cat)return;
  fetch("/api/search?cat="+encodeURIComponent(cat)+"&sort=deal&limit=8").then(function(r){return r.json()}).then(function(j){
    var g=document.getElementById("similarGrid");if(!g)return;var n=0;
    (j.results||[]).forEach(function(d){
      if(d.s===cur||n>=6)return;n++;
      var b=d.ds>=3?'<span class="badge deal-fire" style="position:absolute;top:8px;right:8px">🔥</span>':d.ds>=2?'<span class="badge deal-super" style="position:absolute;top:8px;right:8px">⭐</span>':d.ds>=1?'<span class="badge deal-good" style="position:absolute;top:8px;right:8px">✓</span>':'';
      var h='<a href="/lot/'+d.s+'.html" class="card block relative" style="text-decoration:none">';
      if(d.img)h+='<div style="aspect-ratio:4/3;overflow:hidden;background:#0d0d14;border-radius:12px 12px 0 0"><img src="'+d.img+'" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>';
      h+=b+'<div style="padding:10px"><div style="color:#e4e4ec;font-size:0.75rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'+(d.t||"Lot")+'</div>';
      if(d.p)h+='<div style="color:#818cf8;font-size:0.8rem;font-weight:600;margin-top:3px">'+d.p.toLocaleString("fr-FR")+' €</div>';
      h+='</div></a>';
      g.insertAdjacentHTML("beforeend",h);
    });
    if(n===0)g.parentNode.style.display="none";
  }).catch(function(){g.parentNode.style.display="none";});
})();
</script>

${D}{footerHtml()}`;
if (c.includes(footerMarker)) { c = c.replace(footerMarker, similar); log.push("✓ Lots similaires ajoutés à la fiche"); }
else log.push("✗ marqueur footer fiche non trouvé");

fs.writeFileSync("/var/www/adjuge/scripts/build.mjs", c);
console.log(log.join("\n"));
