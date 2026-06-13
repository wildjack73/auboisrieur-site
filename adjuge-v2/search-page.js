(function(){
  var sq=document.getElementById("sq"), sc=document.getElementById("sc"), sso=document.getElementById("sso");
  var sminp=document.getElementById("sminp"), smaxp=document.getElementById("smaxp"), sdeals=document.getElementById("sdeals"), sreset=document.getElementById("sreset");
  var grid=document.getElementById("sgrid"), more=document.getElementById("smore"), countEl=document.getElementById("scount");
  if(!grid||!sq) return;
  var offset=0, loading=false, exhausted=false;

  // Maison context (when arriving from a maison-de-vente page): set once, kept across filters.
  var initParams=new URLSearchParams(location.search);
  var maison=initParams.get("maison")||"";
  var days=parseInt(initParams.get("days"))||0;

  function daysLabel(n){return n===1?"dernier jour":n+" derniers jours";}

  function setupDaysChip(){
    var el=document.getElementById("sdayschip");
    if(!days){ if(el)el.remove(); return; }
    var h1=document.querySelector("h1"); if(!h1) return;
    if(!el){
      el=document.createElement("div"); el.id="sdayschip";
      el.style.cssText="margin:-0.25rem 0 1rem;font-size:0.85rem;color:#9ca3af";
      h1.parentNode.insertBefore(el, (document.getElementById("smaison")||h1).nextSibling);
    }
    el.innerHTML='📅 Mis aux enchères : <strong style="color:#e4e4ec">'+daysLabel(days)+'</strong> · '+
      '<a href="#" id="sdaysclear" style="color:#818cf8">Toutes les dates</a>';
    document.getElementById("sdaysclear").addEventListener("click",function(e){e.preventDefault();days=0;setupDaysChip();apply();});
  }

  function slugify(t){return String(t||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").substring(0,80);}

  function setupMaisonBanner(){
    if(!maison) return;
    document.title="Invendus de "+maison+" | Adjugé";
    var h1=document.querySelector("h1");
    if(h1) h1.textContent="Invendus de "+maison;
    if(!document.getElementById("smaison")){
      var b=document.createElement("div");
      b.id="smaison";
      b.style.cssText="margin:-0.5rem 0 1rem;font-size:0.85rem;color:#9ca3af";
      b.innerHTML='🏛️ Vous filtrez les invendus de <strong style="color:#e4e4ec">'+maison+'</strong> · '+
        '<a href="/maison/'+slugify(maison)+'.html" style="color:#818cf8">Voir la fiche maison</a> · '+
        '<a href="/recherche.html" style="color:#818cf8">Voir tous les invendus</a>';
      h1&&h1.parentNode.insertBefore(b,h1.nextSibling);
    }
  }

  function lotHtml(d){
    var badge="";
    if(d.ds>=3)badge='<span class="badge deal-fire" style="position:absolute;top:8px;right:8px">🔥 TOP</span>';
    else if(d.ds>=2)badge='<span class="badge deal-super" style="position:absolute;top:8px;right:8px">⭐ Super</span>';
    else if(d.ds>=1)badge='<span class="badge deal-good" style="position:absolute;top:8px;right:8px">Bonne affaire</span>';
    var h='<a href="/lot/'+d.s+'.html" class="card block group relative" style="text-decoration:none">';
    if(d.img)h+='<div style="aspect-ratio:4/3;overflow:hidden;background:#0d0d14;border-radius:12px 12px 0 0"><img src="'+d.img+'" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>';
    else h+='<div style="aspect-ratio:4/3;background:#0d0d14;display:flex;align-items:center;justify-content:center;border-radius:12px 12px 0 0;color:#374151">📷</div>';
    h+=badge+'<div style="padding:12px"><h3 style="color:#e4e4ec;font-size:0.82rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'+(d.t||"Lot")+'</h3>';
    if(d.p)h+='<div style="color:#818cf8;font-size:0.85rem;font-weight:600;margin-top:4px">'+d.p.toLocaleString("fr-FR")+' €</div>';
    if(d.d)h+='<div style="color:rgba(251,146,60,0.7);font-size:0.65rem;margin-top:4px">📅 Invendu le '+d.d.split("-").reverse().join("/")+'</div>';
    if(d.c)h+='<div style="color:#6b7280;font-size:0.7rem">'+d.c+(d.v?' · 📍 '+d.v:'')+'</div>';
    h+='</div></a>';
    return h;
  }

  function buildUrl(){
    var p=new URLSearchParams();
    if(sq.value.trim())p.set("q",sq.value.trim());
    if(sc.value)p.set("cat",sc.value);
    if(sso.value)p.set("sort",sso.value);
    if(sminp.value)p.set("minp",sminp.value);
    if(smaxp.value)p.set("maxp",smaxp.value);
    if(sdeals.checked)p.set("deals","1");
    if(maison)p.set("maison",maison);
    if(days)p.set("days",days);
    return p;
  }

  function fetchPage(reset){
    if(loading||(exhausted&&!reset))return;
    loading=true;
    if(reset){offset=0;exhausted=false;}
    var p=buildUrl(); p.set("limit","48"); p.set("offset",offset);
    fetch("/api/search?"+p.toString()).then(function(r){return r.json()}).then(function(j){
      if(reset)grid.innerHTML="";
      (j.results||[]).forEach(function(d){grid.insertAdjacentHTML("beforeend",lotHtml(d))});
      offset+=(j.results||[]).length;
      if(!j.results||j.results.length<48)exhausted=true;
      more.style.display=exhausted?"none":"block";
      if(offset===0){
        countEl.textContent="Aucun résultat";
        grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:3rem 1rem;color:#9ca3af">'+
          '<div style="font-size:2.5rem;margin-bottom:.5rem">🔍</div>'+
          '<div style="font-size:1.05rem;color:#e4e4ec;font-weight:700;margin-bottom:.35rem">Aucun lot ne correspond</div>'+
          '<div style="font-size:.9rem;margin-bottom:1.2rem">Essayez un autre mot-clé, élargissez la fourchette de prix, ou retirez des filtres.</div>'+
          '<button id="semptyreset" style="padding:.6rem 1.4rem;border-radius:.6rem;background:#4f46e5;color:#fff;font-weight:600;border:none;cursor:pointer">Réinitialiser les filtres</button>'+
          '</div>';
        var eb=document.getElementById("semptyreset"); if(eb&&sreset)eb.addEventListener("click",function(){sreset.click();});
      } else {
        countEl.textContent=offset+(exhausted?"":"+")+" résultat"+(offset>1?"s":"");
      }
      loading=false;
    }).catch(function(){loading=false;countEl.textContent="Erreur";});
  }

  function apply(){
    var p=buildUrl();
    history.replaceState(null,"",p.toString()?"?"+p:location.pathname);
    fetchPage(true);
  }

  var obs=new IntersectionObserver(function(e){if(e[0].isIntersecting)fetchPage(false)},{rootMargin:"600px"});
  obs.observe(more);

  var timer;
  sq.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(apply,300)});
  [sc,sso].forEach(function(el){el.addEventListener("change",apply)});
  [sminp,smaxp].forEach(function(el){el.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(apply,500)})});
  sdeals.addEventListener("change",apply);
  if(sreset)sreset.addEventListener("click",function(){sq.value="";sc.value="";sso.value="recent";sminp.value="";smaxp.value="";sdeals.checked=false;days=0;setupDaysChip();apply();});

  // Init from URL
  if(initParams.get("q"))sq.value=initParams.get("q");
  if(initParams.get("cat"))sc.value=initParams.get("cat");
  if(initParams.get("sort"))sso.value=initParams.get("sort"); else sso.value=maison?"deal":"recent";
  if(initParams.get("minp"))sminp.value=initParams.get("minp");
  if(initParams.get("maxp"))smaxp.value=initParams.get("maxp");
  if(initParams.get("deals")==="1")sdeals.checked=true;
  setupMaisonBanner();
  setupDaysChip();
  apply();
})();
