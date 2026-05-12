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