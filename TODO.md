# brAIn — Roadmap

Plan d'évolution post-audit. Chaque étape est checkable, ordonnée du moins
cher au plus structurant.

---

## Phase 1 — Extraction par domaines (les fondations)

Découpler le framework des nodes applicatifs. À la fin: `brAIn` (core
seul) + 1 repo par domaine. Le framework découvre les nodes installés
via npm.

- [x] **1.1 Étendre `TypeRegistry`** pour scanner aussi
  `node_modules/@brain/node-*` (en plus de `nodes/`). Implémentation:
  `scanInstalledPackages(nodeModulesDir)` qui parcourt les packages
  matchant `@brain/node-*` et registre leur `config.json`. Tests
  unitaires (4 nouveaux tests, tous verts).
- [x] **1.2 Boot du framework**: `BrainService.bootstrap()` appelle
  les deux scans (statique = `nodes/`, installé = remontée vers
  `node_modules/` parent par parent). Récap structuré dans le log
  `Registered node types { static: N, installed: M, types: [...] }`.
- [x] **1.3 Préparer les nodes pour publication npm**: chaque
  `nodes/<x>/package.json` a `version`, `description`, `license`,
  `files` (avec `dist/`, `config.json`, `ui/`, et pour voice/gaze le
  `server/app/` + requirements), `publishConfig: access=public`.
  `private: true` retiré.
- [x] **1.4 Créer `brAIn-perception` repo** sur GitHub
  ([tibzejoker/brAIn-perception](https://github.com/tibzejoker/brAIn-perception),
  public, MIT). Code copié (voice + gaze + intent + seeds + scripts +
  setup-py.mjs cross-platform), pushé sur `main`. Workspace pnpm
  autonome.
- [x] **1.5 + 1.6 Cross-repo workspace + suppression in-tree**:
  `pnpm-workspace.yaml` du repo `brAIn` pointe sur
  `../brAIn-perception/nodes/*`, les workspace deps `@brain/core` /
  `@brain/sdk` se résolvent vers le sibling. `nodes/voice|gaze|intent`
  supprimés du repo `brAIn`. `BrainService.bootstrap()` accepte
  maintenant un array de directories. `app.module.ts` ajoute
  automatiquement les paths sibling conventionnels (brAIn-perception,
  brAIn-memory, brAIn-reasoning, brAIn-tools) s'ils existent — pas
  besoin d'env var.
- [x] **1.7 Vérif end-to-end**: API boot → `Registered node types
  { static: 19, dirs: [brAIn/nodes, brAIn-perception/nodes], types:
  [..., gaze, intent, voice] }`. Spawn d'un node intent → mini-server
  HTTP sur :8767 répond (`status: ok`). DELETE → cleanup propre.
- [ ] **1.8 Extraire les autres domaines** (différé — les 3 domaines
  restants sont fortement intriqués: brain dépend de memory-proxy via
  topic aliases, etc. À faire après que le store de phase 2 soit
  validé sur perception).
- [ ] **1.9 Mise à jour README** du repo `brAIn` post-extraction
  (différé jusqu'à 1.8 complète).

---

## Phase 2 — Store / registry des nodes

Permettre l'installation de nodes depuis le dashboard, sur le modèle
plugin. Pose les bases pour les nodes générés par `developer`.

- [x] **2.1 Créer le repo `brAIn-store`**
  ([tibzejoker/brAIn-store](https://github.com/tibzejoker/brAIn-store)).
  `registry.json` v1 + `registry.schema.json` (validable). Initial:
  perception (voice, gaze, intent) → `brAIn-perception`. README explique
  comment proposer un node via PR.
- [x] **2.2 + 2.3 Routes REST côté API** (`packages/core/src/store/`
  + `packages/api/src/rest/store.controller.ts`):
  - `GET /store/index` → registry brut, cache 60s, override via
    `BRAIN_STORE_URL`.
  - `GET /store/nodes` → registry décoré avec `installed` / `install_path`
    (true si le repo parent est checkouté en sibling et que le subpath
    a un `config.json`).
  - `POST /store/install {package_name}` → `git clone --depth 1` du repo
    parent en sibling de brAIn s'il manque, puis `typeRegistry.scanDirectory`
    pour enregistrer les nouveaux types. Retourne `installed` /
    `already_present` / `failed` avec message + nombre de types nouvellement
    enregistrés.
- [x] **2.4 Onglet "Store" dans le dashboard**
  (`packages/dashboard/src/components/StorePanel.tsx`): liste les nodes
  du registry avec dot status (installed / not), badges (`py`, `ollama`,
  `ui`), bouton "Install" qui appelle l'endpoint, banner de feedback,
  refresh manuel. Ajout d'un item "⊞ Store" dans le menu nav.
- [ ] **2.5 Adapter le `developer` node** pour publier ses
  créations: génération auto d'un `package.json` + push sur un repo
  GitHub temporaire (ou private gist) + ajout au store via PR
  automatique sur `brAIn-store`.

---

## Phase 3 — Transport `python`

Permettre des nodes natifs Python sans bridge HTTP, sur le modèle
JSON-stdio. Débloque le pattern "node ML pur Python".

- [ ] **3.1 Étendre `TransportMode`** dans le SDK:
  `"process" | "container" | "remote" | "python"`.
- [ ] **3.2 Créer `packages/python-sdk/`**: une mini-lib Python
  (~200 lignes) qui parle au framework via stdio JSON.
  Side: handler async, ctx.publish, ctx.subscribe, ctx.state.
- [ ] **3.3 Créer un `PythonRunner`** dans `packages/core/src/runner/`
  qui spawn `python -m brain_sdk.run <node-dir>` et bridge les
  messages bus ↔ stdio.
- [ ] **3.4 Exemple de node Python**: extraire l'embedder de
  memory-vector en node Python pur.

---

## Phase 4 — Bus distribué (NATS) + remote agent

Le pari le plus ambitieux. Justifie le "N" du sigle.

- [ ] **4.1 Abstraire `BusService`** derrière une interface (déjà
  bien isolé, vérifier).
- [ ] **4.2 Implémenter `NatsBusService`** comme adapter alternatif
  (publish → `nats publish`, subscribe → `nats subscribe`). Conserver
  l'in-memory bus comme fallback dev.
- [ ] **4.3 Créer `brAIn-agent`** (~500 lignes Node ou Go), daemon
  léger installable sur n'importe quelle machine. Au boot: connect
  au NATS, annonce ses capacités, attend des spawn-requests.
- [ ] **4.4 Étendre le `transport` à `"remote"`**: le runner remote
  spawn un node sur un agent distant via un message NATS au lieu
  d'un child_process local.
- [ ] **4.5 Dashboard**: vue "agents connectés" + ability à choisir
  où spawner un node (local / agent X).
- [ ] **4.6 Doc**: setup NATS + déploiement agent sur Raspberry Pi.

---

## Phase 5 — Transport `container`

Ségrégation propre pour la prod. Optionnel, peut être fait en
parallèle de la phase 4.

- [ ] **5.1 Créer un `ContainerRunner`** qui build l'image au spawn
  (`docker build` depuis le repo du node si pas déjà construit) et
  fait `docker run` avec network host ou bridge configurable.
- [ ] **5.2 Standard de `Dockerfile`** par node: chaque node publié
  doit shipper un `Dockerfile` qui expose le port et déclare le
  port + healthcheck.
- [ ] **5.3 Volumes pour les models ML**: convention
  `~/.brain/models/` mounté en read-only dans tous les containers.
- [ ] **5.4 Tests d'isolation**: vérifier qu'un node compromis ne
  peut pas lire les autres DB SQLite, accéder à l'host network, etc.

---

## Phase 6 — Tracing + observabilité (recommandation critique)

Pour répondre à la critique "pub/sub = enfer à debugger en prod".

- [ ] **6.1 Tracing causal**: chaque message porte un `trace_id` +
  `parent_message_id`. Le bus log la chaîne complète.
- [ ] **6.2 Dead-letter queue**: messages qui causent un crash
  handler 3x sont déplacés dans un mailbox dédié pour inspection.
- [ ] **6.3 Backpressure metrics**: par souscription, exposer
  `mailbox_depth`, `drop_rate` au dashboard.
- [ ] **6.4 Replay**: fonction "replay this trace" qui re-publie
  les messages d'un trace passé (pour debug).

---

## Décisions à acter

- [ ] Garder le mot "Network" dans le sigle? Si phase 4 est faite,
  oui clairement. Sinon, soit on le tue (BRAIN = Bridged Reactive AI
  Node-runtime?), soit on assume que c'est ambitieux et que la
  phase 4 est en plan public.
- [ ] Sandboxing du `developer` node: quelle stratégie? VM léger
  (firecracker), container avec capabilities réduites, ou juste
  doc warning "à utiliser avec des CLI agents de confiance"?
- [ ] Niveau d'effort sur la phase 6 — c'est l'investissement le
  moins fun mais le plus différenciant à long terme.
