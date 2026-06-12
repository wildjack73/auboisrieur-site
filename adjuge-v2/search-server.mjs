import Database from "better-sqlite3";
import http from "http";

const db = new Database("/var/www/adjuge/data/adjuge.db", { readonly: true });
db.pragma("query_only = true");

function search(q, cat, sort, limit, offset) {
  // Sanitize query for FTS5: keep words, add prefix matching
  const terms = String(q||"").trim().toLowerCase().replace(/[^a-z0-9àâäéèêëïîôöùûüç\s-]/gi,"").split(/\s+/).filter(w=>w.length>1);
  let rows;
  if (terms.length) {
    const ftsQuery = terms.map(t => `"${t}"*`).join(" ");
    let sql = `SELECT id,slug,title,category,city,price,thumb,score, rank FROM lots_fts WHERE lots_fts MATCH ?`;
    const params = [ftsQuery];
    if (cat) { sql += ` AND category=?`; params.push(cat); }
    if (sort === "ph") sql += ` ORDER BY price DESC`;
    else if (sort === "pl") sql += ` ORDER BY price ASC`;
    else if (sort === "deal") sql += ` ORDER BY score DESC, rank`;
    else sql += ` ORDER BY rank`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    rows = db.prepare(sql).all(...params);
  } else {
    let sql = `SELECT id,slug,title,category,city,price,thumb,score FROM lots_fts`;
    const params = [];
    if (cat) { sql += ` WHERE category=?`; params.push(cat); }
    if (sort === "ph") sql += ` ORDER BY price DESC`;
    else if (sort === "pl") sql += ` ORDER BY price ASC`;
    else sql += ` ORDER BY score DESC`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    rows = db.prepare(sql).all(...params);
  }
  return rows.map(r => ({ s:r.slug, t:r.title, p:r.price||0, c:r.category, v:r.city, img:r.thumb, ds:r.score }));
}

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  try {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("q") || "";
    const cat = url.searchParams.get("cat") || "";
    const sort = url.searchParams.get("sort") || "";
    const limit = Math.min(parseInt(url.searchParams.get("limit")||"48"), 100);
    const offset = parseInt(url.searchParams.get("offset")||"0");
    const results = search(q, cat, sort, limit, offset);
    res.end(JSON.stringify({ results, count: results.length }));
  } catch(e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message, results: [] }));
  }
});

server.listen(3001, "127.0.0.1", () => console.log("Search server on 127.0.0.1:3001"));
