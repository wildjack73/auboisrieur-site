import Database from "better-sqlite3";
import http from "http";
const db = new Database("/var/www/adjuge/data/adjuge.db", { readonly: true });
db.pragma("query_only = true");

function search(p) {
  const terms = String(p.q||"").trim().toLowerCase().replace(/[^a-z0-9àâäéèêëïîôöùûüç\s-]/gi,"").split(/\s+/).filter(w=>w.length>1);
  const where = [], params = [];
  let from = "lots_fts", order = "";
  if (terms.length) {
    where.push("lots_fts MATCH ?");
    params.push(terms.map(t=>`"${t}"*`).join(" "));
  }
  if (p.cat) { where.push("category=?"); params.push(p.cat); }
  if (p.city) { where.push("city=?"); params.push(p.city); }
  if (p.minp>0) { where.push("price>=?"); params.push(p.minp); }
  if (p.maxp>0) { where.push("price<=?"); params.push(p.maxp); }
  if (p.deals) where.push("score>=1");
  const sql0 = `SELECT id,slug,title,category,city,price,thumb,score,sdate${terms.length?",rank":""} FROM ${from}`;
  const whereSql = where.length ? " WHERE "+where.join(" AND ") : "";
  if (p.sort==="ph") order=" ORDER BY price DESC";
  else if (p.sort==="pl") order=" ORDER BY price ASC";
  else if (p.sort==="deal") order=" ORDER BY score DESC, sdate DESC";
  else if (p.sort==="recent") order=" ORDER BY sdate DESC, score DESC";
  else order = terms.length ? " ORDER BY rank" : " ORDER BY sdate DESC";
  const rows = db.prepare(sql0+whereSql+order+" LIMIT ? OFFSET ?").all(...params, p.limit, p.offset);
  return rows.map(r=>({s:r.slug,t:r.title,p:r.price||0,c:r.category,v:r.city,img:r.thumb,ds:r.score,d:r.sdate}));
}

http.createServer((req,res)=>{
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","public, max-age=180");
  try {
    const u = new URL(req.url,"http://localhost");
    const g = k => u.searchParams.get(k)||"";
    const results = search({
      q:g("q"), cat:g("cat"), city:g("city"), sort:g("sort"),
      minp:parseInt(g("minp"))||0, maxp:parseInt(g("maxp"))||0,
      deals:g("deals")==="1",
      limit:Math.min(parseInt(g("limit"))||48,100), offset:parseInt(g("offset"))||0
    });
    res.end(JSON.stringify({results,count:results.length}));
  } catch(e){ res.statusCode=500; res.end(JSON.stringify({error:e.message,results:[]})); }
}).listen(3001,"127.0.0.1",()=>console.log("Search server :3001 (filtres)"));
