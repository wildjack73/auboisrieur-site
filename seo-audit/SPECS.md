# Objectif Top 3 — Spécifications techniques

> Outil d'audit de visibilité locale (Google Business Profile / « local pack »).
> Tagline : *« votre place sur le podium »*. Dossier : `seo-audit/`. Node ≥ 18, **aucune dépendance npm** (`npm start` = `node server.mjs`).

---

## 1. APIs externes & endpoints

### ValueSERP — `https://api.valueserp.com` · auth : `?api_key=…`
| Endpoint (GET) | Paramètres | Usage / fonction |
|---|---|---|
| `/search` | `q=<métier ville>&google_domain=google.fr&gl=fr&hl=fr` | local pack (`local_results`) → `localPack` |
| `/search` | `search_type=place_details&data_cid=<CID>&hl=fr` | détails fiche (`place_details` : `description`, `category`/`type`, `review_topics`, `known_attributes`, `hours`, `unclaimed`, `data_id`, `gps_coordinates`) → `businessInfo` |
| `/search` | `search_type=places&q=<métier>&ll=@lat,lng,14z&location_coordinates=lat,lng&gl=fr&hl=fr` | local pack à un point GPS → `localPackAtCoord` (grille de visibilité) |
| `/search` | `q=<métier ville>&num=100` | résultats organiques (`organic_results`) → `organicResults` (audit citations) |

- Retries automatiques sur l'erreur transitoire « (G) » (`request_info.success === false`).
- ⚠️ Le paramètre `include_advertiser_info` a été **retiré** : il provoquait une erreur systématique.
- La catégorie GMB est dans `business_type` (et non `category`).

### DataForSEO — `https://api.dataforseo.com/v3` · auth : HTTP Basic `login:password`
| Endpoint (POST) | Body | Usage / fonction |
|---|---|---|
| `/serp/google/maps/live/advanced` | `[{keyword:"<métier> <ville>", location_name:"France", language_code:"fr", depth:20}]` (ou `location_coordinate:"lat,lng,14"`) | top local pack → `localPack` / `localPackAtCoord` |
| `/serp/google/organic/live/advanced` | `[{keyword:"<métier> <ville>", location_name:"France", language_code:"fr", device:"desktop", os:"windows", depth:100}]` | organiques → `organicResults` |
| `/business_data/google/my_business_info/live` | `[{keyword:"cid:<CID>", location_name:"France", language_code:"fr"}]` | `description`, `category`, `additional_categories`, **`place_topics`**, **`attributes.available_attributes`**, **`work_time`** (horaires), `is_claimed`, `total_photos`, `price_level`, `phone`, `questions_and_answers_count`, `latitude/longitude` → `businessInfo` |
| `/business_data/google/reviews/task_post` + `task_get/<id>` | `[{place_id|keyword:"cid:..", language_code:"fr", location_name:"France", depth:50}]` (polling ≤ 60 s) | texte des avis, `rating`, `timestamp`, **`owner_answer`** → `reviews` |
| `/backlinks/summary/live` | `[{target:"<domain>", internal_list_limit:1, backlinks_status_type:"live", include_subdomains:true}]` | `rank` (Domain Rank 0–1000), `backlinks`, `referring_domains`, `referring_main_domains` → `domainMetrics` |

- Retries sur erreurs non-4xx (les 4xx, ex. 40100 auth, ne sont pas retentées).
- Quand un autre provider SERP est utilisé mais que DataForSEO est configuré, l'outil **complète** chaque fiche avec les données DataForSEO (place_topics, attributs, horaires, claimed, nb de photos, etc.).

### Google Cloud Vision — `https://vision.googleapis.com/v1` · auth : `?key=…`
- `POST /images:annotate?key=…` — body `{ requests:[{ image:{source:{imageUri:<url>}}, features:[{type:"OBJECT_LOCALIZATION",maxResults:10},{type:"LABEL_DETECTION",maxResults:10},{type:"TEXT_DETECTION",maxResults:1}] }, … ] }` → objets localisés, labels, texte OCR → `analyzeImages` (batch, ≤ 8 images/fiche, ≤ 25 fiches/audit).

### Google Cloud Translation v2 — `https://translation.googleapis.com/language/translate/v2`
- `POST /` (form-encoded) — `key=…&target=fr&source=en&format=text&q=…&q=…` → traduit en FR les labels/objets Vision → `translate` / `translateTerms`. Dédoublonnage + cache mémoire (un terme déjà traduit n'est jamais retraduit). Réutilise par défaut la clé Vision.

### SerpApi — `https://serpapi.com`
- `GET /search.json?engine=google_maps_photos&data_id=<0x…:0x…>&api_key=…` → toutes les photos d'une fiche → `getPlacePhotos` (best-effort, marche surtout avec le `data_id` fourni par ValueSERP).

### Haloscan — `https://api.haloscan.com` · auth : header `haloscan-api-key`
| Endpoint (POST) | Body | Usage / fonction |
|---|---|---|
| `/api/keywords/overview` | `{keyword, lang_country:"fr-fr", requested_data:["volume","competition","kgr","allintitle","keyword_difficulty","cpc"]}` | volume mensuel, allintitle, KGR, difficulté, CPC → `keywordOverview` |
| `/api/domains/overview` | `{input:"<domain>"}` | trust, citation_flow, referring_domains, backlinks, nb mots-clés positionnés, trafic estimé → `domainOverview` |
| `/api/domains/positions` | `{input:"<domain>", keywords:["<kw>"], lang_country:"fr-fr"}` | meilleure position du domaine sur la requête → `domainPosition` |

- ⚠️ Chemins/paramètres/champs codés d'après la doc publique Haloscan ; parsing **défensif** (plusieurs noms de champ possibles, échec → `null` non bloquant). À valider au premier run réel.

---

## 2. Clés API & configuration (`seo-audit/config.mjs`)

Toutes surchargeables par variable d'environnement.

| Service | Variable d'env | Valeur par défaut codée |
|---|---|---|
| ValueSERP | `VALUESERP_API_KEY` | `A18E79F50D89498EB963320A15D6FBDE` |
| DataForSEO | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | *(aucune — secrets GitHub / shell)* |
| Google Vision | `GOOGLE_VISION_API_KEY` | `AIzaSyBFQl62uqJu2jB2TnzeFwwAzkteR5WrMmk` |
| Google Translate | `GOOGLE_TRANSLATE_API_KEY` | *(= la clé Vision par défaut)* |
| SerpApi | `SERPAPI_KEY` | `2a925c23f5296924649975221cacf27f0b9effa882dea75f9dc9c2b7095f3c3d` |
| Haloscan | `HALOSCAN_API_KEY` | JWT valide jusqu'en 2036 (cf. `config.mjs`) |

Autres réglages : `SEO_AUDIT_PROVIDER` (`valueserp` par défaut), `SEO_AUDIT_LOCATION` (`France`), `SEO_AUDIT_LANGUAGE` (`fr`), `SEO_AUDIT_MAX_CITIES` (`500`), `PORT` (`8787`).

> ⚠️ **Sécurité** : ces clés sont en clair dans le dépôt → garder le repo **privé**, et régénérer une clé si elle a été exposée publiquement.

---

## 3. Mini-audits

### Mode « Audit du marché » (1 run = tout, agrégé sur N villes ; 198 villes par défaut, éditables)

| # | Mini-audit | Contenu | Source / option | Champ rapport |
|---|---|---|---|---|
| 1 | Note & nombre d'avis à atteindre | médiane / plancher / max, distribution des notes, détail par position #1/#2/#3 | SERP | `ratingTarget` |
| 2 | Rythme & ancienneté des avis | avis/mois, ancienneté du dernier avis, âge des fiches (1ᵉʳ avis) ; + taux de réponse propriétaire, % d'avis ≤ 3/5 | option « avis » (DataForSEO Reviews) | `reviewFrequency`, `reviewEngagement` |
| 3 | Catégories | combinaisons exactes (principale ; secondaires) pondérées par position + catégories isolées ; reco catégorie principale | SERP / business info | `categoryCombos`, `categories` |
| 4 | Nom de la fiche | % du top N avec métier / ville / les deux dans le nom, longueur (mots & car.), par position, exemples | SERP | `titleKeyword`, `title` |
| 5 | Description | longueur cible (car. + mots), mots « à mettre » ≥ 60 % / « recommandés » ≥ 30 % / « optionnels » 15–30 %, expressions, modèle de description généré | business info | `descriptionGuide`, `descriptionKeywords` |
| 6 | Avis — sémantique | étiquettes Google des avis (`place_topics`, total des mentions), mots du texte des avis, modèle de réponse aux avis, exemples d'avis « idéaux » | business info / reviews | `reviewTopics`, `reviewGuide`, `reviewKeywords` |
| 7 | Complétude de la fiche GMB | % revendiquées, attributs les plus cochés, amplitude horaire (h/sem + jours), niveau de prix | business info | `gmbProfile` |
| 8 | Photos | objets / labels-ambiances (traduits FR) / mots écrits sur les images + photos représentatives | option « photos » (SerpApi + Vision + Translate) | `vision` |
| 9 | Citations / annuaires où être présent | domaines qui ressortent en organique pour « métier + ville », classés par nb de villes ; liste « à soumettre en priorité » | option « citations » (SERP organique) | `citations` |
| 10 | Position du site des fiches | % du top N dont le site est en page 1 sur « métier + ville », rang organique médian | option « citations » | `websiteRank` |
| 11 | Métriques des sites web | Domain Rank / backlinks / domaines référents + checks HTTPS / mobile / schema.org LocalBusiness + répartition vrai site / page sociale / agrégateur / pas de site | option « métriques sites » (DataForSEO Backlinks + fetch HTML) | `siteMetrics` |
| 12 | Haloscan | volume « métier » et « métier + ville » par ville (cumulé, médiane/ville, top villes) + trust / trafic / nb mots-clés positionnés / position des sites | option « Haloscan » | `haloscan` |
| 13 | Le top 3 ville par ville | tableau des fiches réellement classées (nom, note, avis, catégorie, description) | SERP | `sample` |
| 14 | Score de référence du top N /100 | complétude moyenne des fiches + checklist des pratiques quasi systématiques (≥ 80 % des leaders) | dérivé | `referenceChecklist` |
| 15 | Synthèse « En clair » | constat + plan d'actions classées Priorité / Important / Bonus + lexique débutant | dérivé | `summary`, `recommendations` |

### Mode « Audit d'une fiche » (scorecard d'un établissement — métier + ville + Place ID / CID / nom)

- **Score /100 + note A→F** + **rang exact** sur la requête (recherché dans le top 10). *(`scoreListing`)*
- **Score pondéré par critère** : Profil & description 20 % · Avis & note 25 % · Photos 15 % · Google Posts 10 % · Questions/Réponses 10 % · Services/Produits 10 % · Attributs 10 % (chacun 0–100, avec problèmes détectés).
  - Posts / Services / (Q&R si non exposée) : non vérifiables via API → comptés « supposé absent », avec reco de les ajouter (comme les outils du marché type robot-speed).
- **Carte d'en-tête** : avis · note · photos · taux de réponse aux avis · avis des 30 derniers jours.
- **Plan d'action priorisé** : Impact Élevé / Moyen / Faible, avec la catégorie.
- **Tableau des concurrents** : top 10 de la requête, fiche auditée surlignée.
- **Grille de visibilité géographique 5×5** : rang Google Maps à 25 points GPS autour de l'adresse → carte colorée + % de la zone où la fiche est dans le top 3. Option « grille géo » (DataForSEO recommandé). *(`geoGrid`)*
- **PDF dédié** de cet audit.

---

## 4. Sorties & architecture

- **UI** : 3 onglets — *Audit du marché* / *Audit d'une fiche* / *Paramètres* (liste de villes éditable, valeurs par défaut des audits, lexique).
- **PDF pro** : couverture pleine page (bande accent, titre, 6 « facts ») → sommaire numéroté → chapitres (un par mini-audit empilé) → **modules numérotés** (titre + phrase d'explication débutant + données + encadré « 💡 Conseil »), palette homogène bleu marine (`#13294b`) / accent (`#2563eb`), tableaux propres, A4. Génération via `Ctrl+P → Enregistrer en PDF` (décocher « En-têtes et pieds de page », garder « Graphiques d'arrière-plan »). *(Paged.js envisagé pour passer en qualité « livre » : numéros de page, en-têtes courants, sommaire avec n° de page.)*
- **CSV** : `audit;section;terme;valeur;pct_fiches`, par audit ou consolidé (UTF-8 BOM, séparateur `;`).
- **`seo-audit/exemple-rapport.html`** : rapport d'exemple autonome (s'ouvre dans un navigateur sans serveur ; généré à partir d'un vrai audit « expert comptable »).
- **Endpoints du serveur local** (`server.mjs`) :
  - `GET /` → l'UI
  - `GET /api/meta` → config (providers dispo, Vision dispo, maxCities, liste de villes)
  - `POST /api/audit` → SSE : `event: start|progress|done|error` (rapport « marché »)
  - `POST /api/listing-audit` → SSE : idem (scorecard d'une fiche)
- **Fichiers** :
  - `server.mjs` — serveur HTTP + SSE de progression
  - `audit.mjs` — toute la logique (orchestration, analyses, scoring, recommandations, résumé)
  - `providers/dataforseo.mjs`, `providers/valueserp.mjs` — adaptateurs SERP
  - `vision.mjs`, `translate.mjs`, `serpapi.mjs`, `haloscan.mjs` — adaptateurs des autres API
  - `cities.mjs` — liste de villes par défaut (~198 communes)
  - `config.mjs` — clés API & réglages (env-overridable)
  - `public/index.html` — interface (UI + rendu des rapports + export PDF/CSV)
  - `package.json` — `{"name":"objectif-top-3","type":"module","scripts":{"start":"node server.mjs"}}`

---

## 5. Lancer en local

```bash
# Node ≥ 18 requis
git clone <repo>
cd <repo>/seo-audit
# (optionnel, pour les données DataForSEO)
export DATAFORSEO_LOGIN=...
export DATAFORSEO_PASSWORD=...
npm start          # = node server.mjs
# → http://localhost:8787
```

Sans `DATAFORSEO_*`, l'outil tourne avec ValueSERP seul (les chips d'avis riches, le texte des avis, l'ancienneté, le nb de photos et les attributs détaillés viennent de DataForSEO).
