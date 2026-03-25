#!/usr/bin/env node
/**
 * Adjugé v2 — Ingest (runs on VPS)
 * Reads JSON from stdin (piped from scraper) → inserts into SQLite
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "adjuge.db");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function initDb() {
  ensureDir(path.dirname(DB_PATH));
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY,
      title TEXT,
      clean_title TEXT,
      description TEXT,
      category TEXT,
      category_id INTEGER,
      sold INTEGER NOT NULL DEFAULT 0,
      price REAL,
      estimate_low REAL,
      estimate_high REAL,
      starting_price REAL,
      commission_rate REAL,
      sale_date TEXT,
      sale_id INTEGER,
      org_name TEXT,
      org_email TEXT,
      org_phone TEXT,
      org_address TEXT,
      city TEXT,
      postcode TEXT,
      slug TEXT UNIQUE,
      thumb TEXT,
      photos TEXT,
      ai_title TEXT,
      ai_desc TEXT,
      ai_deal_score INTEGER DEFAULT -1,
      ai_deal_analysis TEXT,
      ai_price_analysis TEXT,
      ai_faq TEXT,
      ai_tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lots_sold ON lots(sold);
    CREATE INDEX IF NOT EXISTS idx_lots_category ON lots(category);
    CREATE INDEX IF NOT EXISTS idx_lots_city ON lots(city);
    CREATE INDEX IF NOT EXISTS idx_lots_sale_date ON lots(sale_date);
    CREATE INDEX IF NOT EXISTS idx_lots_slug ON lots(slug);
    CREATE INDEX IF NOT EXISTS idx_lots_deal_score ON lots(ai_deal_score);
  `);
  return db;
}

// Read all stdin
let data = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  const lots = JSON.parse(data);
  console.log(`📥 Réception de ${lots.length} lots`);

  const db = initDb();

  const upsert = db.prepare(`
    INSERT INTO lots (
      id, title, clean_title, description, category, category_id,
      sold, price, estimate_low, estimate_high, starting_price, commission_rate,
      sale_date, sale_id, org_name, org_email, org_phone, org_address,
      city, postcode, slug, thumb, photos, updated_at
    ) VALUES (
      @id, @title, @clean_title, @description, @category, @category_id,
      @sold, @price, @estimate_low, @estimate_high, @starting_price, @commission_rate,
      @sale_date, @sale_id, @org_name, @org_email, @org_phone, @org_address,
      @city, @postcode, @slug, @thumb, @photos, datetime('now')
    ) ON CONFLICT(id) DO UPDATE SET
      sold = excluded.sold,
      price = COALESCE(excluded.price, lots.price),
      updated_at = datetime('now')
  `);

  let inserted = 0, updated = 0;
  const insertMany = db.transaction((items) => {
    for (const lot of items) {
      const existing = db.prepare("SELECT id FROM lots WHERE id = ?").get(lot.id);
      upsert.run({
        ...lot,
        photos: JSON.stringify(lot.photos || []),
      });
      if (existing) updated++; else inserted++;
    }
  });

  insertMany(lots);

  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN sold=1 THEN 1 ELSE 0 END) as sold_count,
      SUM(CASE WHEN sold=0 THEN 1 ELSE 0 END) as unsold_count
    FROM lots
  `).get();

  console.log(`✅ ${inserted} insérés, ${updated} mis à jour`);
  console.log(`📊 Base: ${stats.total} lots (${stats.sold_count} vendus, ${stats.unsold_count} invendus)`);

  db.close();
});
