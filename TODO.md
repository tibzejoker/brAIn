# TODO

État après audit externe (2026-04-30). On garde 4 chantiers, pas un de
plus. Chacun a un *pourquoi* clair — pas de cargo-cult, pas de
roadmap fleuve. Quand un point passe à `[x]`, il sort d'ici.

---

## 1. Préemption mid-handler — done

- [x] **`ctx.signal: AbortSignal`** dans `NodeContext`. Le runner crée
  un `AbortController` par itération, expose son signal au handler,
  et l'abort à la préemption.
- [x] **`PreemptionMonitor`** (`packages/core/src/runner/preemption.ts`)
  qui inspecte les unread peek à chaque arrivée bus pendant un handler
  en cours: si `incoming.criticality > active.maxCriticality +
  threshold`, abort + stash d'un `PreemptionContext`. Threshold default
  3, configurable via `config_overrides.preemption_threshold`.
- [x] **Wire-up sur tous les providers via Vercel AI SDK**:
  `generateText({ ..., abortSignal: ctx.signal })` dans `brain`,
  `llm-basic`, `memory-proxy`, `memory-consolidator`. Couvre
  Anthropic, OpenAI, Google, Ollama d'un coup (le SDK propage
  l'abort au fetch HTTP).
- [x] **Wire-up CLI agents**: `exec(..., { signal })` dans `llm-cli`,
  `spawn(..., { signal })` dans `developer`. SIGTERM-on-abort —
  claude / codex / gemini se font tuer si préemptés.
- [x] **Tests**: `tests/preemption.test.ts` — abort effectivement
  pendant un await, `wasPreempted=true` à l'itération suivante,
  `interrupting_message` + `previous_messages` peuplés, threshold
  par défaut respecté, override `preemption_threshold=0` honoré,
  les vrais bugs handler atterrissent toujours en DLQ.
- [x] **Test E2E avec un vrai LLM**:
  `tests/preemption-llm-e2e.test.ts` — gate `RUN_LLM_E2E=1`, spawn
  un `llm-basic` Ollama, déclenche un long generateText, envoie un
  msg crit 9 pendant le call, vérifie que le runner log "preempted"
  dans le buffer du node. **A révélé un vrai bug** que les tests
  unit n'attrapaient pas: les handlers comme `llm-basic` catch
  l'AbortError dans leur try/catch et retournent clean. Le runner
  ne voyait pas la préemption. Fix: détecter via `signal.aborted`
  après le handler, indépendamment de si l'abort a été propagé.

---

## 2. MCP — host + server

- [x] **`mcp-host` node** (`nodes/mcp-host/`): consomme N serveurs
  MCP externes via le SDK officiel `@modelcontextprotocol/sdk`. Au
  spawn, lit `config_overrides.servers: [{name, command, args, env}]`,
  spawn chacun en stdio (`StdioClientTransport`), discover les tools
  via `client.listTools()`. Sur le bus expose 2 topics :
  - `mcp.call` → payload `{server?, tool, arguments?}`, dispatch et
    répond sur `mcp.result`. AbortSignal (`ctx.signal`) propagé au
    `client.callTool` → préemption tue les calls MCP en cours.
  - `mcp.tools.list` → republie le toolset agrégé sur
    `mcp.tools.available` pour discovery.
- [x] **Tests** (`tests/mcp-host.test.ts`): fixture
  `tests/fixtures/mcp-echo-server.mjs` qui expose un tool `echo` via
  le Server SDK. 3 cas: discovery, tool call roundtrip, erreur
  structurée pour tool inconnu.
- [x] **Test E2E avec un vrai serveur public**:
  `tests/mcp-host-public-server-e2e.test.ts` — gate `RUN_MCP_E2E=1`,
  spawn `npx @modelcontextprotocol/server-filesystem` (l'impl de
  référence d'Anthropic), drive le mcp-host contre lui : discovery
  (read_file, write_file, list_directory…), `read_file`,
  write+read roundtrip. **A révélé un piège macOS**: le serveur
  realpath les paths avant sa check d'allow-list (/var/folders →
  /private/var/folders), donc on doit envoyer des paths déjà
  canonicalisés.
- [ ] **Endpoint `/mcp` côté API**: expose chaque node brAIn comme
  tool MCP pour qu'un client externe (Claude Desktop, Cursor) drive
  brAIn comme un MCP server. Pas implémenté pour l'instant — l'usage
  primaire est *consume*, pas *expose*. Suite si besoin.
- [ ] **Section dédiée dans le README** côté authoring + architecture
  (à faire avec le repositionnement #3).

---

## 3. README — repositionner — done

- [x] **Nouvelle baseline acronyme**: brAIn = **Bus-Reactive Ambient
  Intelligent Nodes**. Chaque mot porte du sens technique
  (Bus = primitive, Reactive = exec model, Ambient = many-to-many
  context, Intelligent = LLM-aware, Nodes = unité). L'ancien
  "Bridged Reactive Artificial Intelligence Network" était plein de
  filler.
- [x] **Hero pitch sur la différence many-to-many vs chat / cron**:
  tableau "Existing pattern" qui contraste chat-driven (LangGraph,
  AutoGen) + cron-driven (Cowork, OpenAI scheduled) vs daemon
  ambient brAIn. Le différenciant n'est plus "perception" mais le
  set de primitives qui rend les agents ambient possibles.
- [x] **Engine condensé**: bus + runners + préemption RTOS + agent
  distribué + MCP + observability, chacun ≤ 15 lignes avec un focus
  sur ce que le primitive permet (preemption RTSP-style verifié end
  -to-end Ollama 65s → 809ms).
- [x] **Perception ramenée en showcase** plutôt qu'en hero:
  section "Showcase: ambient perception" après le moteur, avec le
  rappel "same primitives would host Slack-listener, IoT, monitoring
  …" pour ouvrir l'imagination.
- [x] **Tableau "What this is not"**: vs LangGraph, AutoGen, ROS2 —
  daemon, many-to-many bus, criticality preemption, LLM-native,
  distribution cross-machine, MCP host, causal trace + replay.
  Définit le scope par les frontières.
- [x] **Sections sur-détaillées coupées**: lifecycle, persistence,
  authority en 3-4 lignes max. README final 450 lignes (depuis 650).

---

## 4. Vidéo de démo (futur)

**Pourquoi** : un projet qui vit sans démo visuelle ne sort jamais
du bruit. Voice + gaze + intent + brain qui réagit en live, c'est
exactement le genre de chose qui se montre en 60 secondes et défonce
n'importe quelle landing page de framework agentique.

- [ ] **Script du scénario**: 3 personnes dans la pièce, gaze détecte
  qui regarde qui, voice transcrit qui parle, intent corrèle "qui
  s'adresse à qui", brain commente / répond quand on s'adresse à
  lui. Le dashboard live en split-screen montre les events sur le
  bus + le graphe + les traces causales.
- [ ] **Capture**: macOS QuickTime ou OBS, camera externe + screen
  capture du dashboard.
- [ ] **Montage**: ~60 s, voiceover ou texte d'overlay.
- [ ] **Embed** : top du README + GitHub repo description.

---

## 5. Mode invité (guest) — quand deux brains rejoignent le même bus

**Pourquoi** : aujourd'hui, quand brain B `Join hub` chez brain A, le
bus est bien partagé (NATS) mais **chaque dashboard ne voit que sa
propre `InstanceRegistry`**. L'`AgentDirectory` affiche l'autre
comme "remote agent" mais pas les nodes qui y tournent. Résultat :
asymétrique, confus, et les UIs des nodes pointent dans le vide
parce que la join URI ne transporte que `nats://` pas l'URL HTTP du
hub. On veut passer à **Option A** : le joiner devient un client
visuel du hub (mêmes datas, même graph, mêmes UIs), tout en gardant
ses nodes locaux toujours actifs et visibles sur demande.

### Backend (hub)

- [ ] **`http_url` dans `GET /network/transport`** : l'API calcule sa
  base URL (LAN IP + `process.env.PORT ?? 3000`) et la surface dans
  `TransportInfo`. Champ aussi présent dans `joined_hub.http_url`
  côté joiner pour qu'il sache où taper.
- [ ] **`joinExternalBroker(url, token, hubName, httpUrl)`** prend
  `httpUrl` et le persiste dans `data/external-broker.json` à côté
  de l'URL NATS — survit aux restarts.
- [ ] **CORS** activé sur l'API NestJS (origin = `*` ou whitelist
  des origins joiners via le broker token en bearer). Sans CORS le
  dashboard du joiner se prend des erreurs `Access-Control-Allow-Origin`.
- [ ] **Snapshot bus** (`brain.network.snapshot`) : le hub publie sa
  registry (NodeInfo[] + edges) toutes les ~3s + sur événement
  spawn/kill/state_change. Permet aux joiners d'avoir une vue
  temps-réel sans devoir poller REST. Inclut `hub_id`, `hub_label`,
  `http_url`. Criticality 0, retain ~5s.

### Frontend (joiner)

- [ ] **`api/request.ts`** : BASE devient dynamique. Si
  `transport.joined_hub.http_url` est set ET `mode === "external"`,
  toutes les requêtes partent vers cette base au lieu du même
  origin. Stocker dans un module singleton initialisé par l'app
  shell avant tout `request()`.
- [ ] **`api/socket.ts`** : `io(hubApiUrl, …)` en mode external (pas
  `io("/")`). Permet au dashboard d'écouter les events Socket.IO
  du hub directement.
- [ ] **`NodeUiModal.tsx`** : iframe `src = hubApiUrl + "/nodes/" + id + "/ui/"`
  en mode external. Sans ça les UIs des nodes du hub renvoient un
  404 contre l'API locale.
- [ ] **Bannière de contexte** en haut du dashboard quand
  `mode === "external"` : "Connected to <hubName> · viewing <hubLabel>'s
  network · Disconnect" — clarifie immédiatement qu'on est invité.
- [ ] **Bouton "Mine (N nodes)"** : peek temporaire sur la registry
  locale (re-fetch contre localhost) dans un modal/overlay léger,
  pour vérifier ses nodes sans quitter le hub.

### Join URI enrichie

- [ ] **Format étendu** : `brain://join?url=nats://…&token=…&api=http://192.168.1.16:3000`.
  Le QR + le snippet copy-paste du panneau Distributed génèrent
  cette forme. `JoinHubModal.applyUri` parse `api=` et le passe au
  POST `/network/transport/external`.
- [ ] **Champ "API URL" optionnel** dans la modal pour fallback
  manuel quand on a uniquement le `nats://`.

### Spawn en mode invité

- [ ] **Vérifier que ça marche tout seul** : si toutes les requêtes
  du dashboard pointent vers le hub, alors `POST /nodes` part vers
  le hub → le node spawn chez le hub → son UI est servie par le hub
  → tout est cohérent. Pas de proxy bus à coder. À tester
  rigoureusement avant de considérer cette étape close.

### Tests

- [ ] **E2E manuel** : démarrer deux brains sur la même LAN, rejoindre
  l'un depuis l'autre, vérifier le graph, spawn un node, ouvrir son
  UI, send des messages, déconnecter, retour propre au local.
- [ ] **Test automatisé** (si faisable) : deux APIs sur des ports
  différents partagent un NATS, le joiner appelle `/network` et reçoit
  bien la registry du hub.

### Note d'UX déjà faite

- [x] **Badge "me" violet** sur la bounding box du host local dans
  `HostGroup.tsx` (palette : violet pour `local`, accent pour
  `active-agent`, slate pour `passive`). Identification immédiate
  de soi dans n'importe quelle vue multi-host.

---

## Ce qui sort de la TODO (différé indéfiniment)

- Phase 1.8 (extraction memory/reasoning/tools en siblings) : décision
  actée, on ne fait pas. Le shape "engine + curated nodes" est valide.
- Phase 2.5 auto-PR via gh : feature dev/contribution, pas dans le
  chemin produit.
- Phase 5 Docker / container transport : différée, NATS + agents
  couvre déjà la distribution.
- 6.1b/6.2/6.2b/6.3/6.4 (observabilité avancée): toutes shippées,
  cf git log.




todo aussi

faire un template de dev node avec les bonnes pratiques et adapter pour que au debut de la creation ca fasse un copier collé du template dans le bon dossier et l'ia part avec ca, ca consommera moins de tokens.

faire des petits jeux pour profiter du de l'ui et de la puissance d'un llm. des jeux au tour par tour ou avec interaction réguliere sur temps dattente.
exemples de jeux : pendu, morpion, puissance 4, bataille navale, tamagoshi (genre un pet quoi sans le nom tamagoshi), 