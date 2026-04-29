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
- [~] **2.5 Store-candidates** (partial — pragmatic v1):
  `StoreService.listCandidates()` scanne le `TypeRegistry` pour les
  types `origin: "dynamic"` (créés par le node `developer`) avec un
  `dist/handler.js` build, et synthétise un manifest `StoreNode`
  prêt à coller dans `brAIn-store/registry.json`. Endpoint REST
  `GET /store/candidates` + section "Local candidates" dans le
  StorePanel avec un bouton "Copy registry entry" qui copie le JSON
  dans le presse-papier. **Reste à faire** (différé): auto-PR contre
  `tibzejoker/brAIn-store` via `gh` — demande une auth GitHub côté
  serveur dont la conception n'est pas figée. Le bouton "Copy" suffit
  pour boucler la chaine création → partage manuellement.

---

## Phase 3 — Transport `web` (any-language nodes via HTTP/WS)

Plus général que stdio Python: un node = un service HTTP/WS qui parle
le protocole brAIn. N'importe quelle stack (Python FastAPI, Go, Rust,
JS) peut implémenter un node. Auth bearer token. Distribuable
nativement (le node peut être sur une autre machine ou en container).

- [x] **3.1 SDK étendu**: `TransportMode = "process" | "container" | "web"`,
  nouvelle interface `WebTransportConfig`, `NodeTypeConfig.web?: WebTransportConfig`.
- [x] **3.2 Protocole WS** documenté dans `web-runner.ts` (frames
  bidirectionnelles JSON: `messages` / `ping` côté framework, `publish` /
  `subscribe` / `unsubscribe` / `sleep` / `log` / `pong` côté node).
- [x] **3.3 `WebRunner`** créé dans `packages/core/src/runner/web-runner.ts`.
  WS persistant avec reconnect backoff, ping/pong heartbeat, dispatch
  via `runner-factory.ts` quand `transport === "web"` ou
  `config_overrides.web` présent.
- [x] **3.4 `loadHandler` + `spawnNode` + `restoreNodes`** sautent le
  module JS quand le transport est web (handler stub `() => Promise.resolve()`).
  Le bloc `web` du `config.json` est mergé dans `config_overrides.web`
  au spawn.
- [x] **3.5 SDK Python `brain-web`** (`packages/python-sdk/`):
  `BrainNode` avec `@node.on(topic)`, `publish/subscribe/sleep/log`
  asyncio. `attach(app)` enregistre la route `/brain/ws` sur n'importe
  quel app FastAPI. **Bug FastAPI subtil rencontré**: le paramètre du
  handler doit être typé `WebSocket` (pas `Any`) sinon FastAPI 403e
  silencieusement — fix documenté dans le commentaire.
- [x] **3.6 Demo `nodes/calc-py/`**: ~50 lignes Python, eval AST safe.
  E2e validé: spawn via API → WS s'ouvre → publish `calc.request`
  depuis un autre node → calc-py évalue → `calc.result` revient sur le
  bus avec metadata `{expression, value}`.

---

## Phase 4 — Bus distribué (NATS) + remote agent

Le pari le plus ambitieux. Justifie le "N" du sigle.

- [x] **4.1 Abstraire `BusService`**: nouvelle interface
  `IBusService` (`packages/core/src/bus/bus.interface.ts`) qui liste
  publish / subscribe / mailbox / history / event-emitter. `BusService`
  l'implémente. Tous les call-sites (`SleepService`, `BaseRunner`,
  `BrainService`, lifecycle) pris en référence par interface; swap de
  backend = changement d'une ligne au constructeur.
- [x] **4.2 `NatsBusService`** (`packages/core/src/bus/nats-bus.service.ts`):
  même contract que l'in-memory bus, plus un client NATS qui pousse
  chaque publish sur `<prefix>.<topic>` et reçoit toutes les autres.
  Anti-loop par origin id, traduction wildcard (filtre côté brAIn,
  NATS subscribe est `>` greedy). 9 tests local-routing + 3 tests
  d'intégration cross-instance avec un vrai `nats-server` (skip auto
  si binaire absent). Tous verts.
- [x] **4.3 `brAIn-agent` daemon** (`packages/agent/`, ~250 lignes TS):
  binaire `brain-agent` config par env (`BRAIN_NATS_URL`, etc.). Boot
  une `BrainService` câblée sur `NatsBusService`, scanne ses node types
  locaux, annonce sur `brain.agents.discover` toutes les 10s.
  `AgentDirectory` côté API collecte les annonces avec TTL pour
  surfacer une liste live des agents. `BrainService` accepte maintenant
  un bus injectable au constructeur. 2 tests d'intégration verts
  (annonce reçue + bus cross-process).
- [x] **4.4 `transport: "remote"`**: nouvelle valeur dans le SDK +
  `target_agent_id` dans `NodeInstanceConfig` + champ optionnel `id?`
  pour qu'API et agent référencent le même instance id. La lifecycle
  intercepte les spawns remote: `dispatchRemoteSpawn` (`brain-remote.ts`)
  publie une spawn-request sur `brain.agents.<id>.spawn`, retourne un
  stub `NodeInfo`, et mémoïse `node_id → agent_id` dans
  `BrainService.remoteNodes`. `killNode` route via NATS sur
  `brain.agents.<id>.kill` quand l'id est dans cette map. L'`Agent`
  s'abonne aux deux topics et appelle ses `spawnNode`/`killNode` locaux.
  **E2e validé**: 1 test full-cycle (API spawn remote → agent héberge
  le runner → message bus voyage cross-process → kill via API →
  l'agent supprime son instance).
- [x] **4.5 Dashboard — onglet "Agents"**: vue live des agents
  connectés sur le bus partagé.
  - `AgentDirectory` (déjà présent côté agent) déplacé dans
    `@brain/core/src/agents/agent-directory.ts` pour que l'API puisse
    s'abonner au topic d'annonce sans dépendre de `@brain/agent`.
  - `BrainService` instancie l'annuaire dans son constructeur
    (`brain.agents = new AgentDirectory(this.bus); attach()`) et l'API
    expose `GET /agents` (`AgentsController`).
  - L'API peut désormais joindre le bus distribué: si
    `BRAIN_NATS_URL` est défini, `app.module.ts` instancie un
    `NatsBusService` partagé et le passe au `BrainService` (sinon le
    bus en mémoire reste la valeur par défaut).
  - `AgentsPanel` (icône ⚯ dans le menu) poll `GET /agents` toutes les
    3 s, affiche host / pid / uptime / types[], avec un état vide qui
    explique comment câbler NATS.
  - **E2e validé**: `nats-server` + API (NATS) + `brain-agent` →
    `curl /agents` retourne l'annonce avec les 17 types locaux du
    brAIn et un `ts` qui se rafraîchit toutes les 10 s.
- [x] **4.5b Spawn ciblé depuis le dashboard**: `NodeCreator` fetch
  `/agents` à l'ouverture et affiche un select "Target" (Local +
  chaque agent vivant). Sélectionner un agent envoie automatiquement
  `transport: "remote"` + `target_agent_id` au `POST /nodes`.
  **E2e validé**: API+NATS+agent → `curl POST /nodes` avec
  `transport=remote` → l'agent log `agent: spawned remote node
  locally` avec le même id que celui retourné par l'API.
- [x] **4.5c Control plane distant**: les ops d'état lifecycle
  (`stop`, `start`, `wake`) routent automatiquement vers l'agent
  hôte quand le node est `transport: "remote"`. `dispatchRemoteAction`
  publie `brain.agents.<id>.<action>` et met à jour optimistement
  l'état local. L'agent souscrit aux topics `.stop/.start/.wake` (en
  plus de `.spawn/.kill`) et appelle ses brainService locaux. Les
  nodes distants sont aussi enregistrés dans `instanceRegistry` côté
  API → ils apparaissent dans `/network` (et donc le graphe du
  dashboard) avec `target_agent_id`. **Test**: nouveau cas dans
  `tests/remote-spawn.test.ts` qui spawn un echo distant, applique
  stop puis start puis kill et vérifie l'état des deux côtés.
- [x] **4.5e Cleanup des nodes zombies**: `AgentDirectory` étend
  EventEmitter et émet `agent:added` / `agent:expired` via une sweep
  périodique. `BrainService` souscrit à `agent:expired` et appelle
  `dropExpiredAgentNodes(agentId)` qui retire toute remote-node
  enregistrée pour cet agent (de `remoteNodes` + `instanceRegistry`).
  Sans ça, un agent qui crashe laissait ses nodes en zombie dans le
  graphe du dashboard. Le constructeur de `BrainService` accepte
  désormais un `opts.agentDirectory` pour configurer TTL et sweep
  interval (utile en test). **Test**: nouveau cas dans
  `tests/agent.test.ts` qui injecte une seule annonce, spawn un node
  remote dessus, et vérifie qu'il disparaît passé le TTL.
- [x] **4.5d Read-back distant** (logs / mailbox): `NatsBusService`
  expose `requestRemote()` + `respondToRequests()` (NATS request-reply
  natif). L'agent répond aux subjects `brain.agents.<id>.read.logs`
  / `.read.mailboxes`. Le controller consomme les variantes async
  `getNodeLogsAny` / `getNodeMailboxesAny` sur `BrainService`, qui
  routent automatiquement local vs distant. Bonus: `consumeRemote`
  filtre maintenant les payloads non-enveloppe pour ne pas envoyer
  les RPC dans le router de bus. **Test**: nouveau cas dans
  `tests/remote-spawn.test.ts` qui spawn un echo distant, lui envoie
  un message, puis lit logs + mailboxes via l'API et vérifie que
  les deux remontent les bonnes données depuis l'agent.

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

- [x] **6.1 Tracing causal**: chaque message porte un `trace_id` +
  `parent_id`. Le bus alloue un trace_id à la racine et hérite via
  `parent_id`. Le runner injecte automatiquement `parent_id` quand un
  handler appelle `ctx.publish` / `ctx.respond`. Le `WebRunner` propage
  via les frames pour préserver la chaîne au-delà du process. Endpoint
  `GET /network/traces/:trace_id` renvoie la chaîne ordonnée.
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
