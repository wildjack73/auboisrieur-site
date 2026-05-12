#!/usr/bin/env node
// Serveur web de l'outil d'audit Google Local (top 3 / local pack).
//   node server.mjs            → http://localhost:8787
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "./config.mjs";
import { runAudit, runListingAudit } from "./audit.mjs";
import { visionConfigured } from "./vision.mjs";
import { TOP_CITIES } from "./cities.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  let rel = req.url.split("?")[0];
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: "not found" });
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/meta") {
    return send(res, 200, {
      defaultProvider: config.defaultProvider,
      providers: ["dataforseo", "valueserp"],
      visionAvailable: visionConfigured(),
      maxCities: config.maxCitiesPerAudit,
      topCities: TOP_CITIES,
    });
  }

  if (url.pathname === "/api/audit" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: "JSON invalide" }); }

    const cities = Array.isArray(body.cities) && body.cities.length
      ? body.cities.map(s => String(s).trim()).filter(Boolean)
      : TOP_CITIES;
    const opts = {
      keyword: String(body.keyword || "").trim(),
      cities,
      topN: Math.min(20, Math.max(1, parseInt(body.topN, 10) || 3)),
      providerName: body.provider || config.defaultProvider,
      withReviews: !!body.withReviews,
      withVision: !!body.withVision,
      withCitations: !!body.withCitations,
      withSiteMetrics: !!body.withSiteMetrics,
      withHaloscan: !!body.withHaloscan,
    };

    // Server-Sent Events : progression + résultat final
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("start", { cities: cities.length, ...opts, keyword: opts.keyword });

    try {
      const report = await runAudit({ ...opts, onProgress: p => emit("progress", p) });
      emit("done", report);
    } catch (e) {
      emit("error", { error: String(e.message || e) });
    }
    res.end();
    return;
  }

  if (url.pathname === "/api/listing-audit" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: "JSON invalide" }); }
    const opts = {
      keyword: String(body.keyword || "").trim(),
      city: String(body.city || "").trim(),
      target: { placeId: String(body.placeId || "").trim() || null, cid: String(body.cid || "").trim() || null, name: String(body.name || "").trim() || null },
      providerName: body.provider || config.defaultProvider,
      withGrid: !!body.withGrid,
    };
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("start", { keyword: opts.keyword, city: opts.city });
    try {
      const report = await runListingAudit({ ...opts, onProgress: p => emit("progress", p) });
      emit("done", report);
    } catch (e) { emit("error", { error: String(e.message || e) }); }
    res.end();
    return;
  }

  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, { error: "method not allowed" });
});

server.listen(config.port, () => {
  console.log(`Objectif Top 3 — http://localhost:${config.port}`);
  console.log(`Fournisseur par défaut : ${config.defaultProvider} | Vision : ${visionConfigured() ? "activée" : "désactivée"}`);
});
