import Database from "better-sqlite3";
import fs from "fs";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const SITE = "/var/www/adjuge/site";

// Department centroids (lat,lng) for fallback positioning of new cities
const DEPT = {"01":[46.2,5.2],"02":[49.6,3.6],"03":[46.3,3.4],"04":[44.1,6.2],"05":[44.7,6.3],"06":[43.9,7.2],"07":[44.8,4.4],"08":[49.7,4.7],"09":[42.9,1.6],"10":[48.3,4.1],"11":[43.1,2.4],"12":[44.3,2.6],"13":[43.5,5.1],"14":[49.1,-0.3],"15":[45.1,2.7],"16":[45.7,0.2],"17":[45.7,-0.8],"18":[47.1,2.5],"19":[45.3,1.8],"21":[47.4,4.8],"22":[48.4,-2.8],"23":[46.1,2.0],"24":[45.1,0.7],"25":[47.2,6.4],"26":[44.7,5.1],"27":[49.1,1.0],"28":[48.4,1.4],"29":[48.2,-4.1],"2a":[41.9,8.9],"2b":[42.4,9.2],"30":[43.9,4.3],"31":[43.4,1.4],"32":[43.7,0.6],"33":[44.8,-0.6],"34":[43.6,3.4],"35":[48.1,-1.7],"36":[46.8,1.6],"37":[47.3,0.7],"38":[45.3,5.6],"39":[46.7,5.7],"40":[44.0,-0.8],"41":[47.6,1.3],"42":[45.7,4.2],"43":[45.1,3.8],"44":[47.3,-1.6],"45":[47.9,2.2],"46":[44.6,1.6],"47":[44.3,0.6],"48":[44.5,3.5],"49":[47.5,-0.6],"50":[49.1,-1.2],"51":[49.0,4.1],"52":[48.1,5.1],"53":[48.1,-0.7],"54":[48.7,6.2],"55":[49.0,5.4],"56":[47.8,-2.8],"57":[49.0,6.7],"58":[47.1,3.5],"59":[50.5,3.2],"60":[49.4,2.5],"61":[48.6,0.1],"62":[50.5,2.3],"63":[45.7,3.1],"64":[43.3,-0.8],"65":[43.1,0.2],"66":[42.6,2.7],"67":[48.6,7.5],"68":[47.9,7.3],"69":[45.8,4.6],"70":[47.6,6.1],"71":[46.7,4.5],"72":[48.0,0.2],"73":[45.5,6.4],"74":[46.0,6.4],"75":[48.86,2.35],"76":[49.6,1.0],"77":[48.6,3.0],"78":[48.8,1.9],"79":[46.5,-0.3],"80":[49.9,2.4],"81":[43.8,2.1],"82":[44.0,1.4],"83":[43.4,6.2],"84":[44.0,5.1],"85":[46.7,-1.4],"86":[46.6,0.5],"87":[45.9,1.3],"88":[48.2,6.4],"89":[47.8,3.6],"90":[47.6,6.9],"91":[48.5,2.2],"92":[48.85,2.2],"93":[48.9,2.5],"94":[48.8,2.5],"95":[49.1,2.2]};

// Extract existing coords from current carte.html
let oldCoords = {};
try {
  const old = fs.readFileSync(SITE+"/carte.html","utf-8");
  const m = old.match(/\[\{"city".*?\}\]/);
  if (m) JSON.parse(m[0]).forEach(c => { oldCoords[c.city] = [c.lat, c.lng]; });
} catch(e){}

// Current counts from DB
const cities = db.prepare("SELECT city, MAX(postcode) pc, COUNT(*) cnt FROM lots WHERE sold=0 AND length(city)>2 GROUP BY city HAVING cnt>=3 ORDER BY cnt DESC").all();

const data = [];
for (const c of cities) {
  const dept = (c.pc||"").substring(0,2).toLowerCase();
  let coords = oldCoords[c.city];
  if (!coords && DEPT[dept]) {
    // jitter around dept centroid so markers don't overlap
    const seed = c.city.length;
    coords = [DEPT[dept][0] + (seed%7-3)*0.04, DEPT[dept][1] + (seed%5-2)*0.05];
  }
  if (!coords) continue; // skip foreign/unknown
  data.push({city:c.city, lat:coords[0], lng:coords[1], cnt:c.cnt, dept});
}

// Inject into template (replace old array)
let html = fs.readFileSync(SITE+"/carte.html","utf-8");
html = html.replace(/\[\{"city".*?\}\]/, JSON.stringify(data));
// Update the "X villes" counter text
html = html.replace(/[0-9]+ villes avec des invendus/, data.length + " villes avec des invendus");
fs.writeFileSync(SITE+"/carte.html", html);
console.log("  🗺️ Carte régénérée:", data.length, "villes (Nice:", (data.find(d=>d.city==="Nice")||{}).cnt, "lots)");
db.close();
