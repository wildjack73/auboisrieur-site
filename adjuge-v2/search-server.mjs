import Database from "better-sqlite3";
import http from "http";
const db = new Database("/var/www/adjuge/data/adjuge.db", { readonly: true });
db.pragma("query_only = true");

function search(p) {
  const terms = String(p.q||"").trim().toLowerCase().replace(/[^a-z0-9àâäéèêëïîôöùûüç\s-]/gi,"").split(/\s+/).filter(w=>w.length>1);
  const where = [], params = [];
  // Filtering by maison needs org_name, which lives in `lots` (not the FTS table) — join on id.
  // NB: FTS5 MATCH only accepts the real table name, never an alias — so keep `lots_fts`.
  const join = p.maison ? " JOIN lots l ON l.id=lots_fts.id" : "";
  if (terms.length) {
    where.push("lots_fts MATCH ?");
    params.push(terms.map(t=>`"${t}"*`).join(" "));
  }
  if (p.cat) { where.push("lots_fts.category=?"); params.push(p.cat); }
  if (p.city) { where.push("lots_fts.city=?"); params.push(p.city); }
  if (p.minp>0) { where.push("lots_fts.price>=?"); params.push(p.minp); }
  if (p.maxp>0) { where.push("lots_fts.price<=?"); params.push(p.maxp); }
  if (p.deals) where.push("lots_fts.score>=1");
  if (p.maison) { where.push("l.org_name=?"); params.push(p.maison); }
  // Recency filter: auction date within the last N days
  if (p.days>0) { where.push("lots_fts.sdate >= date('now', ?)"); params.push("-"+p.days+" days"); }
  const sql0 = `SELECT lots_fts.id,lots_fts.slug,lots_fts.title,lots_fts.category,lots_fts.city,lots_fts.price,lots_fts.thumb,lots_fts.score,lots_fts.sdate${terms.length?",rank AS rnk":""} FROM lots_fts${join}`;
  const whereSql = where.length ? " WHERE "+where.join(" AND ") : "";
  let order;
  if (p.sort==="ph") order=" ORDER BY lots_fts.price DESC";
  else if (p.sort==="pl") order=" ORDER BY lots_fts.price ASC";
  else if (p.sort==="deal") order=" ORDER BY lots_fts.score DESC, lots_fts.sdate DESC";
  else if (p.sort==="recent") order=" ORDER BY lots_fts.sdate DESC, lots_fts.score DESC";
  else order = terms.length ? " ORDER BY rnk" : " ORDER BY lots_fts.sdate DESC";
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
      q:g("q"), cat:g("cat"), city:g("city"), maison:g("maison"), sort:g("sort"),
      minp:parseInt(g("minp"))||0, maxp:parseInt(g("maxp"))||0,
      days:parseInt(g("days"))||0,
      deals:g("deals")==="1",
      limit:Math.min(parseInt(g("limit"))||48,100), offset:parseInt(g("offset"))||0
    });
    res.end(JSON.stringify({results,count:results.length}));
  } catch(e){ res.statusCode=500; res.end(JSON.stringify({error:e.message,results:[]})); }
}).listen(3001,"127.0.0.1",()=>console.log("Search server :3001 (filtres + maison)"));
