(function(){
  var sq=document.getElementById("sq"), sc=document.getElementById("sc"), sso=document.getElementById("sso");
  var grid=document.getElementById("sgrid"), more=document.getElementById("smore"), countEl=document.getElementById("scount");
  if(!grid||!sq) return;
  var offset=0, loading=false, exhausted=false, curQ="", curCat="", curSort="";

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
    if(d.c)h+='<div style="color:#6b7280;font-size:0.7rem;margin-top:4px">'+d.c+'</div>';
    if(d.v)h+='<div style="color:#6b7280;font-size:0.65rem">📍 '+d.v+'</div>';
    h+='</div></a>';
    return h;
  }

  function fetchPage(reset){
    if(loading||(exhausted&&!reset))return;
    loading=true;
    if(reset){offset=0;exhausted=false;}
    var url="/api/search?q="+encodeURIComponent(curQ)+"&cat="+encodeURIComponent(curCat)+"&sort="+curSort+"&limit=48&offset="+offset;
    fetch(url).then(function(r){return r.json()}).then(function(j){
      if(reset)grid.innerHTML="";
      (j.results||[]).forEach(function(d){grid.insertAdjacentHTML("beforeend",lotHtml(d))});
      offset+=(j.results||[]).length;
      if(!j.results||j.results.length<48)exhausted=true;
      countEl.textContent = curQ ? (offset + (exhausted?"":"+") + " résultat"+(offset>1?"s":"")+" pour « "+curQ+" »") : (offset + (exhausted?"":"+") + " lots");
      more.style.display = exhausted ? "none" : "block";
      loading=false;
    }).catch(function(){loading=false;countEl.textContent="Erreur de recherche";});
  }

  function doSearch(){
    curQ=sq.value.trim(); curCat=sc.value; curSort=sso.value;
    var p=new URLSearchParams();
    if(curQ)p.set("q",curQ);
    history.replaceState(null,"",p.toString()?"?"+p:location.pathname);
    fetchPage(true);
  }

  var obs=new IntersectionObserver(function(e){if(e[0].isIntersecting)fetchPage(false)},{rootMargin:"600px"});
  obs.observe(more);

  var timer;
  sq.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(doSearch,300)});
  sc.addEventListener("change",doSearch);
  sso.addEventListener("change",doSearch);

  var params=new URLSearchParams(location.search);
  if(params.get("q")){sq.value=params.get("q");}
  doSearch();
})();
