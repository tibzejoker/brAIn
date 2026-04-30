# TODO

État après audit externe (2026-04-30). On garde 4 chantiers, pas un de
plus. Chacun a un *pourquoi* clair — pas de cargo-cult, pas de
roadmap fleuve. Quand un point passe à `[x]`, il sort d'ici.

---

## 1. Préemption mid-handler — pour de vrai

**Aujourd'hui** le SDK définit `PreemptionContext` mais le runner n'en
fait jamais usage. Le handler tourne jusqu'au bout même si un message
de criticité plus haute arrive entre-temps. Une revendication
non-implémentée vaut moins que pas de revendication.

**Décision binaire** : on l'implémente, ou on sort le scaffold.
Tranchons pour l'implémenter — c'est le primitive qui rend cohérent le
modèle "agent ambient temps-réel" face à un workflow LangGraph
classique.

- [ ] **AbortSignal propagé dans `NodeContext`**: `ctx.signal:
  AbortSignal` que le handler peut check (et qu'on passe aux fetch /
  LLM streams).
- [ ] **Politique d'interrupt dans le runner**: à chaque message
  arrivé pendant un handler en cours, comparer
  `incoming.criticality > active.criticality + threshold` (seuil
  configurable, default = 3). Si oui → `controller.abort()` + on
  rappelle le handler avec `ctx.preemption: PreemptionContext`.
- [ ] **Capture partial_response** sur LLM streaming: accumuler les
  chunks reçus côté `ctx.callLLM` et les exposer au moment de
  l'abort.
- [ ] **Tests**: handler 5 s, interrupt à 2 s par msg crit 9, vérifier
  que le second appel reçoit un `PreemptionContext` non-vide.
- [ ] **Doc**: ajouter le pattern "handler préemptable" dans la
  section *Authoring a node* du README.

---

## 2. MCP — host + server

**Pourquoi** : en 2026 c'est l'API tools standard de facto. Tout
framework agentique qui ne parle pas MCP s'isole de l'écosystème
Claude Desktop / Cursor / Cline / etc. Pour un agent ambient qui
veut consommer des capacités tierces (Slack, GitHub, Notion, FS),
c'est non-négociable.

- [ ] **`mcp-host` node**: connecte un serveur MCP externe
  (stdio ou HTTP), expose ses tools sur le bus comme topics
  `mcp.<server>.<tool>`. Le brain peut les appeler via
  `publish_message`.
- [ ] **Endpoint `/mcp` côté API**: expose chaque node brAIn comme
  un tool MCP — un agent extérieur (Claude Desktop) peut driver
  brAIn comme n'importe quel MCP server.
- [ ] **Tests**: roundtrip avec un MCP server de référence (par ex.
  `@modelcontextprotocol/server-everything`).
- [ ] **Section dédiée dans le README** côté authoring + architecture.

---

## 3. README — repositionner

**Critique honnête à acter** : le README actuel pitche un
"orchestration framework générique brain-inspired", catégorie morte
en 2026 face à LangGraph / AutoGen / Mastra. Mais le code a un vrai
angle libre : **agent ambient embodied** (voice + gaze + intent
correlator + brain réactif sur bus). Pivot le pitch dessus, le reste
devient le substrat (NATS, agents, mailboxes), pas le titre.

- [ ] **Tuer "Bridged Reactive Artificial Intelligence Network"**
  comme baseline. Remplacer par un sous-titre direct du genre
  "Ambient agent runtime — your LLM lives among your sensors".
- [ ] **Sortir le marketing "loosely modeled after the brain"**.
  Remplacer par une généalogie technique honnête : actor model
  (OTP), event-driven daemons, NATS bus, ROS-style topics. Le
  lecteur ingénieur prend ça plus au sérieux qu'une métaphore.
- [ ] **Lead avec le stack perception**: voice + gaze + intent en
  premier dans la doc, parce que c'est l'angle défendable. Le bus,
  les runners, la persistance, le distributed runtime → en *Engine*
  plus bas.
- [ ] **Réduire les sections sur-détaillées** (lifecycle, persistence,
  authority): chacune en 3-4 lignes max, lien vers ARCHITECTURE.md
  pour le détail. Aujourd'hui le README fait 650 lignes — viser
  300-400.
- [ ] **Tableau "ce que c'est / ce que ce n'est pas"**: vs LangGraph,
  vs ROS, vs AutoGen. Définir le scope par les frontières.

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
