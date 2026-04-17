#!/usr/bin/env node
// Auto-score lots under 200€ as score 0 (not worth AI scoring)
import Database from "better-sqlite3";
const db = new Database("/var/www/adjuge/data/adjuge.db");

const r = db.prepare("UPDATE lots SET ai_deal_score=0 WHERE sold=0 AND ai_deal_score=-1 AND (estimate_high IS NULL OR estimate_high<=200)").run();
console.log("  ⚡ Auto score 0:", r.changes, "lots (< 200€)");

const remaining = db.prepare("SELECT COUNT(*) as c FROM lots WHERE sold=0 AND ai_deal_score=-1").get();
console.log("  🎯 Remaining for AI scoring:", remaining.c, "lots (> 200€)");

db.close();
