import Database from "better-sqlite3";
import fs from "fs";
const db = new Database("/var/www/adjuge/data/adjuge.db");
const SITE = "/var/www/adjuge/site";
const N = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().trim();

// Coordonnées précises des principales villes (lat,lng)
const CC = {
"lyon":[45.764,4.835],"paris":[48.857,2.352],"marseille":[43.296,5.370],"celles-sur-belle":[46.260,-0.207],
"la meziere":[48.213,-1.797],"le mans":[48.007,0.199],"saint-mariens":[45.107,-0.418],"rambouillet":[48.644,1.830],
"dampierre-sur-boutonne":[46.018,-0.357],"moreuil":[49.775,2.486],"l'absie":[46.620,-0.628],"bordeaux":[44.838,-0.579],
"toulouse":[43.605,1.444],"maignelay-montigny":[49.555,2.520],"bethune":[50.530,2.640],"nantes":[47.218,-1.554],
"portets":[44.706,-0.517],"nice":[43.710,7.262],"soissons":[49.382,3.323],"decines-charpieu":[45.769,4.957],
"fleville-devant-nancy":[48.640,6.214],"dijon":[47.322,5.041],"monaco":[43.738,7.424],"caudan":[47.800,-3.350],
"sainte-genevieve-des-bois":[48.634,2.340],"esvres":[47.276,0.770],"chambery":[45.564,5.917],"brive-la-gaillarde":[45.158,1.533],
"bruxelles":[50.847,4.357],"plerin":[48.539,-2.768],"bretigny-sur-orge":[48.610,2.305],"genicourt":[49.107,2.058],
"joigny":[47.983,3.399],"neuilly-sur-seine":[48.884,2.270],"nanterre":[48.892,2.207],"cannes":[43.553,7.017],
"limoges":[45.834,1.262],"nancy":[48.692,6.184],"la rochelle":[46.160,-1.151],"aix-en-provence":[43.529,5.447],
"toulon":[43.124,5.928],"reims":[49.258,4.032],"rouen":[49.443,1.099],"le havre":[49.494,0.108],"vichy":[46.127,3.425],
"coutances":[49.045,-1.446],"fecamp":[49.758,0.374],"longuenesse":[50.731,2.236],"chaumont":[48.111,5.139],
"saint-jean-de-la-ruelle":[47.913,1.873],"venette":[49.428,2.806],"corbas":[45.667,4.910],"villeurbanne":[45.766,4.880],
"montauban":[44.018,1.355],"tarbes":[43.233,0.072],"rodez":[44.349,2.575],"agen":[44.203,0.616],"pau":[43.300,-0.370],
"lille":[50.629,3.057],"amiens":[49.894,2.296],"metz":[49.119,6.176],"strasbourg":[48.573,7.752],"besancon":[47.238,6.024],
"grenoble":[45.188,5.724],"clermont-ferrand":[45.777,3.087],"angers":[47.478,-0.563],"tours":[47.394,0.684],
"orleans":[47.902,1.909],"caen":[49.183,-0.370],"perpignan":[42.689,2.895],"montpellier":[43.611,3.877],
"rennes":[48.117,-1.677],"brest":[48.390,-4.486],"saint-malo":[48.649,-2.026],"quimper":[47.996,-4.098],
"vannes":[47.658,-2.760],"lorient":[47.748,-3.367],"laval":[48.070,-0.770],"poitiers":[46.580,0.340],
"angouleme":[45.649,0.156],"niort":[46.324,-0.464],"bourges":[47.081,2.399],"chartres":[48.444,1.489],
"troyes":[48.297,4.075],"beaune":[47.025,4.840],"auxerre":[47.798,3.573],"macon":[46.307,4.829],"valence":[44.933,4.892],
"avignon":[43.949,4.806],"nimes":[43.837,4.360],"beziers":[43.344,3.215],"albi":[43.928,2.148],"cahors":[44.448,1.441],
"nevers":[46.990,3.159],"moulins":[46.566,3.333],"vesoul":[47.622,6.154],"belfort":[47.638,6.864],"colmar":[48.079,7.358],
"mulhouse":[47.750,7.340],"epinal":[48.174,6.452],"charleville-mezieres":[49.766,4.720],"saint-etienne":[45.439,4.387],
"annecy":[45.899,6.129],"bayonne":[43.493,-1.475],"biarritz":[43.483,-1.559],"montargis":[47.998,2.732],
"argenteuil":[48.947,2.247],"versailles":[48.804,2.130],"vire normandie":[48.838,-0.890],"mayenne":[48.300,-0.615],
"moze-sur-louet":[47.339,-0.562],"vendeville":[50.572,3.075],"brasles":[49.047,3.430],"le raincy":[48.897,2.524],
"fontainebleau":[48.405,2.701],"dunkerque":[51.034,2.377],"maubeuge":[50.279,3.973],"laon":[49.564,3.624],
"rochefort sur mer":[45.942,-0.962],"agen":[44.203,0.616],"riom":[45.894,3.113],"thonon-les-bains":[46.371,6.479],
"sainte-genevieve":[49.276,2.196],"caudan":[47.800,-3.350],"joigny":[47.983,3.399],"l'isle adam":[49.107,2.227],
"soissons":[49.382,3.323],"rambouillet":[48.644,1.830],"bretigny-sur-orge":[48.610,2.305]
};

const DEPT = {"01":[46.2,5.2],"02":[49.6,3.6],"03":[46.3,3.4],"04":[44.1,6.2],"05":[44.7,6.3],"06":[43.7,7.15],"07":[44.8,4.4],"08":[49.7,4.7],"09":[42.9,1.6],"10":[48.3,4.1],"11":[43.1,2.4],"12":[44.3,2.6],"13":[43.5,5.1],"14":[49.1,-0.3],"15":[45.1,2.7],"16":[45.7,0.2],"17":[45.7,-0.8],"18":[47.1,2.5],"19":[45.3,1.8],"21":[47.4,4.8],"22":[48.4,-2.8],"23":[46.1,2.0],"24":[45.1,0.7],"25":[47.2,6.4],"26":[44.7,5.1],"27":[49.1,1.0],"28":[48.4,1.4],"29":[48.2,-4.1],"30":[43.9,4.3],"31":[43.4,1.4],"32":[43.7,0.6],"33":[44.8,-0.6],"34":[43.6,3.4],"35":[48.1,-1.7],"36":[46.8,1.6],"37":[47.3,0.7],"38":[45.3,5.6],"39":[46.7,5.7],"40":[44.0,-0.8],"41":[47.6,1.3],"42":[45.7,4.2],"43":[45.1,3.8],"44":[47.3,-1.6],"45":[47.9,2.2],"46":[44.6,1.6],"47":[44.3,0.6],"48":[44.5,3.5],"49":[47.5,-0.6],"50":[49.1,-1.2],"51":[49.0,4.1],"52":[48.1,5.1],"53":[48.1,-0.7],"54":[48.7,6.2],"55":[49.0,5.4],"56":[47.8,-2.8],"57":[49.0,6.7],"58":[47.1,3.5],"59":[50.5,3.2],"60":[49.4,2.5],"61":[48.6,0.1],"62":[50.5,2.3],"63":[45.7,3.1],"64":[43.3,-0.8],"65":[43.1,0.2],"66":[42.6,2.7],"67":[48.6,7.5],"68":[47.9,7.3],"69":[45.8,4.6],"70":[47.6,6.1],"71":[46.7,4.5],"72":[48.0,0.2],"73":[45.5,6.4],"74":[46.0,6.4],"75":[48.86,2.35],"76":[49.6,1.0],"77":[48.6,3.0],"78":[48.8,1.9],"79":[46.5,-0.3],"80":[49.9,2.4],"81":[43.8,2.1],"82":[44.0,1.4],"83":[43.4,6.2],"84":[44.0,5.1],"85":[46.7,-1.4],"86":[46.6,0.5],"87":[45.9,1.3],"88":[48.2,6.4],"89":[47.8,3.6],"90":[47.6,6.9],"91":[48.5,2.2],"92":[48.85,2.2],"93":[48.9,2.5],"94":[48.8,2.5],"95":[49.1,2.2]};

const cities = db.prepare("SELECT city, MAX(postcode) pc, COUNT(*) cnt FROM lots WHERE sold=0 AND length(city)>2 GROUP BY city HAVING cnt>=3 ORDER BY cnt DESC").all();
const data = [];
for (const c of cities) {
  const key = N(c.city);
  const dept = (c.pc||"").substring(0,2);
  let co = CC[key];
  if (!co && DEPT[dept]) { const s=c.city.length; co=[DEPT[dept][0]+(s%7-3)*0.05, DEPT[dept][1]+(s%5-2)*0.06]; }
  if (!co) continue;
  data.push({city:c.city, lat:co[0], lng:co[1], cnt:c.cnt, dept});
}
let html = fs.readFileSync(SITE+"/carte.html","utf-8");
html = html.replace(/\[\{"city".*?\}\]/, JSON.stringify(data));
html = html.replace(/[0-9]+ villes avec des invendus/, data.length + " villes avec des invendus");
fs.writeFileSync(SITE+"/carte.html", html);
const nice = data.find(d=>d.city==="Nice");
console.log("  🗺️ Carte:", data.length, "villes | Nice:", nice?`${nice.cnt} lots @ ${nice.lat},${nice.lng}`:"absent");
db.close();
