# brAIn — Architecture

Framework de nodes autonomes interconnectés, inspiré du fonctionnement du cerveau humain. Chaque node est une unité d'exécution abstraite (LLM, code pur, service externe, ou un mix) qui tourne en boucle, communique avec les autres via un bus de messages pub/sub, et peut être interrompu, reconfiguré ou créé dynamiquement à l'exécution. Les nodes sont des packages indépendants, installables à la volée, pouvant tourner en local ou sur des machines distantes via Docker.

---

## Table des matières

- [Vue d'ensemble](#vue-densemble)
- [Concepts fondamentaux](#concepts-fondamentaux)
  - [Node](#node)
  - [Node type vs node instance](#node-type-vs-node-instance)
  - [Handler — le coeur d'un node](#handler--le-coeur-dun-node)
  - [NodeContext — l'interface du handler](#nodecontext--linterface-du-handler)
  - [Exemples de handlers](#exemples-de-handlers)
  - [Sugar : createLLMHandler](#sugar--createllmhandler)
  - [Message](#message)
  - [Topic](#topic)
  - [Criticité et priorité](#criticité-et-priorité)
  - [Autorité](#autorité)
- [Cycle de vie d'un node](#cycle-de-vie-dun-node)
  - [Boucle principale](#boucle-principale)
  - [États d'un node](#états-dun-node)
  - [Idle throttle](#idle-throttle)
- [Système de communication](#système-de-communication)
  - [Bus pub/sub](#bus-pubsub)
  - [Mailbox et rétention](#mailbox-et-rétention)
  - [Lecture des messages](#lecture-des-messages)
  - [Format des messages](#format-des-messages)
  - [Types de payload](#types-de-payload)
  - [Patterns de topics](#patterns-de-topics)
- [Système de préemption](#système-de-préemption)
  - [Principe](#principe)
  - [Flow détaillé](#flow-détaillé)
  - [Réponse partielle et continuité](#réponse-partielle-et-continuité)
  - [Anti-thrashing](#anti-thrashing)
- [Tools des nodes](#tools-des-nodes)
  - [Tools de communication](#tools-de-communication)
  - [Tools de cycle de vie](#tools-de-cycle-de-vie)
  - [Tools de réseau](#tools-de-réseau)
  - [Tools d'inspection](#tools-dinspection)
  - [Tools de fichiers](#tools-de-fichiers)
  - [Tools de node types (hot-reload)](#tools-de-node-types-hot-reload)
  - [Pas de tools de mémoire](#pas-de-tools-de-mémoire-dans-le-framework)
- [Système d'autorité et permissions](#système-dautorité-et-permissions)
- [Inspection du réseau](#inspection-du-réseau)
- [Architecture monorepo](#architecture-monorepo)
  - [Structure du projet](#structure-du-projet)
  - [Le SDK (@brain/sdk)](#le-sdk-brainsdk)
  - [Contrat d'un node package](#contrat-dun-node-package)
  - [Node types statiques vs dynamiques](#node-types-statiques-vs-dynamiques)
  - [Le developer node](#le-developer-node)
  - [Hot-reload](#hot-reload)
- [Transport et déploiement](#transport-et-déploiement)
  - [Deux modes de transport](#deux-modes-de-transport)
  - [Architecture Docker (réseau)](#architecture-docker-réseau)
  - [Le SDK abstrait le transport](#le-sdk-abstrait-le-transport)
  - [Spawn en mode container](#spawn-en-mode-container)
  - [Nodes distribués sur plusieurs machines](#nodes-distribués-sur-plusieurs-machines)
- [Stack technique](#stack-technique)
- [Architecture backend (NestJS)](#architecture-backend-nestjs)
- [Architecture frontend (React)](#architecture-frontend-react)

---

## Vue d'ensemble

brAIn est un framework qui permet de faire tourner en parallèle un ensemble de **nodes autonomes** — LLM, code pur, services externes, ou n'importe quel mix. Ces nodes communiquent entre eux via un bus de messages asynchrone, exactement comme les différentes régions du cerveau communiquent via des signaux.

Le framework est **totalement abstrait** : il ne contient aucune logique métier. Il fournit uniquement la plomberie — communication, cycle de vie, priorités, permissions — et ce sont les nodes eux-mêmes qui décident de leur comportement via leur handler.

### Principes directeurs

1. **Souveraineté du node** — Chaque node décide de ses actions. Le framework exécute, il ne décide pas.
2. **Communication découplée** — Les nodes ne se connaissent pas directement. Ils publient et s'abonnent à des topics.
3. **Toujours actif** — Un node tourne en permanence, même à vide. Il peut choisir de se mettre en veille, mais c'est sa décision (ou celle d'un node autorisé).
4. **Préemption par priorité** — Un message plus prioritaire que l'itération en cours interrompt le node et relance une nouvelle itération enrichie.
5. **Topologie dynamique** — Des nodes peuvent être créés, détruits, reconfigurés et reconnectés à la volée par n'importe quel node ayant l'autorité suffisante.
6. **Packages isolés** — Chaque type de node est un package indépendant avec ses propres dépendances, installable à la volée.
7. **Transport-agnostic** — Un node peut tourner en local (worker thread) ou à distance (container Docker sur le réseau). Le handler ne sait pas et n'a pas besoin de savoir.

---

## Concepts fondamentaux

### Node

Un node est l'unité fondamentale du système. C'est une **unité d'exécution abstraite** qui :

- Possède un **handler** — une fonction async qui définit son comportement
- Tourne dans une **boucle infinie** (le framework appelle le handler à chaque itération)
- Peut utiliser un LLM, du code pur, des services MCP, ou n'importe quel mix
- Maintient un **état local** persistant entre itérations
- Est abonné à un ou plusieurs **topics** pour recevoir des messages
- Publie des messages sur des topics pour communiquer avec les autres nodes

Un node n'est **pas forcément un LLM**. C'est juste une boucle avec un handler. Exemples :
- Un node "horloge" qui publie l'heure chaque seconde (code pur, zéro LLM, zéro token)
- Un node "capture audio" qui fait du FFT et du VAD en continu (code pur + MCP STT)
- Un node "conscience" qui est un LLM qui reçoit les messages et arbitre (LLM pur)
- Un node "analyste audio" qui pré-traite en code puis passe au LLM pour décision (mix)

Chaque node instance possède :

| Champ | Description |
|---|---|
| `id` | Identifiant unique (UUID) |
| `type` | Référence au node type (le package source) |
| `name` | Nom lisible (ex: `"conscience"`, `"audio-capture"`) |
| `tags` | Liste de capacités/labels (ex: `["vision", "analysis", "realtime"]`) |
| `authority_level` | Niveau d'autorité (détermine les actions accessibles sur le réseau) |
| `state` | État courant (`active`, `sleeping`, `stopped`, `terminated`) |
| `priority` | Priorité de base du node (influence le scheduling) |
| `subscriptions` | Liste des topics auxquels le node est abonné (avec config mailbox) |
| `transport` | Mode d'exécution (`process` ou `container`) |
| `spawned_by` | ID du node parent (si créé dynamiquement) |
| `ttl` | Durée de vie optionnelle (pour les nodes temporaires) |
| `created_at` | Timestamp de création |

### Node type vs node instance

Distinction fondamentale :

- **Node type** = un package dans `nodes/` (le code, le handler, les deps). C'est le blueprint, le template.
- **Node instance** = un node qui tourne, créé à partir d'un type. On peut avoir 5 instances du type `llm-basic` avec des system prompts différents.

```typescript
// Le type "llm-basic" est défini une fois dans nodes/llm-basic/
// On peut en spawner plusieurs instances :
spawn_node({ type: "llm-basic", name: "conscience", config_overrides: { model: "claude-opus-4-6", ... } });
spawn_node({ type: "llm-basic", name: "planning", config_overrides: { model: "claude-sonnet-4-6", ... } });
spawn_node({ type: "llm-basic", name: "reflexion", config_overrides: { model: "claude-haiku-4-5-20251001", ... } });
```

### Handler — le coeur d'un node

Le handler est une **fonction async** qui reçoit un `NodeContext` et fait ce qu'elle veut. Le framework l'appelle à chaque itération de la boucle. C'est la seule chose qui différencie un node d'un autre.

```typescript
type NodeHandler = (ctx: NodeContext) => Promise<void>;
```

Le handler est **souverain** : il peut appeler un LLM, ou pas. Il peut appeler un serveur MCP, ou pas. Il peut faire du calcul pur. Le framework s'en fiche — il gère la boucle, le buffer de messages, la préemption et le cycle de vie.

### NodeContext — l'interface du handler

Le contexte est l'interface que le framework expose au handler à chaque itération :

```typescript
interface NodeContext {
  // === Messages ===
  messages: Message[];                    // Tous les non-lus (raccourci par défaut)
  readMessages(opts?: {
    topic?: string,                       // Filtrer par topic
    limit?: number,                       // Max N messages
    mode?: "unread" | "latest" | "all",   // Non-lus, les N derniers, ou tout le buffer
    min_criticality?: number,             // Filtrer par criticité
    peek?: boolean,                       // Si true, ne marque PAS comme lu
  }): Message[];

  // === Communication ===
  publish(topic: string, message: Omit<Message, "id" | "from" | "timestamp">): void;
  subscribe(topic: string, mailbox?: MailboxConfig): void;
  unsubscribe(topic: string): void;

  // === Cycle de vie ===
  sleep(conditions: WakeCondition[]): void;

  // === LLM (optionnel — le handler choisit s'il veut appeler un LLM) ===
  callLLM(opts: {
    model?: string,                       // Défaut : config du node
    system?: string,
    messages?: any[],
    tools?: ToolDefinition[],
  }): Promise<LLMResponse>;

  // === Outils externes / MCP ===
  callTool(server: string, tool: string, params: any): Promise<any>;

  // === Fichiers partagés ===
  readFile(id: string): Promise<FileContent>;
  writeFile(name: string, content: string, opts?: FileOpts): Promise<FileRef>;
  listFiles(filter?: FileFilter): Promise<FileInfo[]>;

  // === État local persistant entre itérations ===
  state: Record<string, any>;

  // === Metadata ===
  node: NodeInfo;                         // Info sur le node courant
  iteration: number;                      // Numéro d'itération
  wasPreempted: boolean;                  // True si cette itération résulte d'une préemption
  preemptionContext?: PreemptionContext;   // Détails de l'interruption si applicable
}
```

### Exemples de handlers

**Node horloge** — Code pur, zéro LLM, zéro token :

```typescript
async function clockHandler(ctx: NodeContext) {
  ctx.publish("time.tick", {
    type: "text",
    criticality: 0,
    payload: { content: new Date().toISOString() }
  });
}
// Enregistré avec interval: "1s"
```

**Node capture audio** — Code pur avec appel MCP pour le STT :

```typescript
async function audioCaptureHandler(ctx: NodeContext) {
  const buffer = await ctx.state.mic.read(1024);
  const spectrum = fft(buffer);
  const hasVoice = detectVAD(spectrum);

  if (hasVoice) {
    const result = await ctx.callTool("stt-server", "transcribe", { audio: buffer });
    ctx.publish("audio.speech", {
      type: "text",
      criticality: 3,
      payload: { content: result.text, metadata: { speaker: result.speaker, confidence: result.confidence } }
    });
  }
  // Pas de voix → rien ne se passe, le node continue de tourner
}
```

**Node analyste** — LLM qui décide en fonction des messages :

```typescript
async function audioAnalystHandler(ctx: NodeContext) {
  if (ctx.messages.length === 0) {
    // Rien à analyser, se met en veille jusqu'au prochain message audio
    ctx.sleep([{ type: "topic", value: "audio.speech" }]);
    return;
  }

  const response = await ctx.callLLM({
    system: "Tu analyses les transcriptions audio. Si quelqu'un s'adresse au système, publie une alerte.",
    messages: ctx.messages,
    tools: [publishTool, subscribeTool, sleepTool]
  });

  // Le framework exécute automatiquement les tool calls du LLM
}
```

**Node mixte** — Code qui pré-traite, LLM qui décide :

```typescript
async function smartFilterHandler(ctx: NodeContext) {
  // Étape 1 : pré-traitement en code (pas de tokens)
  const msgs = ctx.readMessages({ topic: "raw.data.*", mode: "unread" });
  const anomalies = msgs.filter(m => detectAnomaly(m.payload.content));

  if (anomalies.length === 0) return; // Rien d'intéressant

  // Étape 2 : seulement les anomalies passent au LLM (économie de tokens)
  const response = await ctx.callLLM({
    system: "Voici des anomalies détectées. Évalue leur gravité et décide quoi alerter.",
    messages: anomalies.map(a => ({ role: "user", content: JSON.stringify(a.payload) })),
    tools: [publishTool]
  });
}
```

### Sugar : createLLMHandler

Pour le cas le plus courant (un node full-LLM), un helper évite le boilerplate :

```typescript
function createLLMHandler(config: {
  model: string,
  system_prompt: string,
  tools: ToolDefinition[],
  mcp_servers?: string[]
}): NodeHandler {
  return async (ctx) => {
    const allTools = [
      ...config.tools,
      ...(config.mcp_servers ? await getMCPTools(config.mcp_servers) : [])
    ];

    const response = await ctx.callLLM({
      model: config.model,
      system: config.system_prompt,
      messages: ctx.messages,
      tools: allTools
    });

    // Les tool calls sont exécutées automatiquement par le framework
  };
}
```

### Message

Un message est l'unité de communication entre nodes. Tout échange passe par des messages publiés sur des topics.

```typescript
interface Message {
  id: string;                          // UUID unique du message
  from: string;                        // ID du node émetteur
  topic: string;                       // Topic de publication
  type: "text" | "file" | "alert";     // Type de contenu
  criticality: number;                 // 0-10, niveau de criticité
  payload: TextPayload | FilePayload | AlertPayload;
  timestamp: number;                   // Unix timestamp ms
  reply_to?: string;                   // ID du message auquel on répond (optionnel)
  ttl?: number;                        // Durée de vie du message en ms (optionnel)
  metadata?: Record<string, any>;      // Données arbitraires (optionnel)
}
```

### Topic

Un topic est un canal de communication nommé. Les nodes publient sur des topics et s'abonnent à des topics. Le nommage suit une convention hiérarchique avec un système de wildcard :

```
alerts.audio              → un topic spécifique
alerts.*                  → matche tout ce qui commence par "alerts." (tous niveaux de profondeur)
my.deep.nested.topic      → les topics peuvent avoir autant de niveaux que nécessaire
```

Le wildcard `*` matche **tout** ce qui suit le préfixe. `alerts.*` matche `alerts.audio`, `alerts.audio.urgent`, `alerts.vision.motion.fast`, etc. Simple et intuitif.

Les noms de topics sont **totalement libres**. Le framework n'impose aucune convention. Les nodes décident de leur propre convention de nommage. Quelques exemples (non prescriptifs) :

```
# Un node audio pourrait publier sur :
audio.detected.speech
audio.detected.noise

# Un node conscience pourrait écouter :
*.urgent
audio.*

# Deux nodes pourraient convenir d'un canal privé :
private.node-a.node-b
```

### Criticité et priorité

Deux concepts distincts mais liés :

**Criticité** (0-10) — Attribut d'un **message**. Indique l'urgence du contenu.

| Niveau | Signification | Exemple |
|---|---|---|
| 0-2 | Information, log, bruit de fond | "Température ambiante : 22°C" |
| 3-4 | Notification normale | "Nouveau fichier reçu" |
| 5-6 | Important, requiert attention | "Tâche assignée, réponse attendue" |
| 7-8 | Urgent, interrompt les activités en cours | "Anomalie détectée dans le flux audio" |
| 9-10 | Critique, priorité absolue | "Menace immédiate détectée", "Ordre de shutdown" |

**Priorité** — Attribut d'une **itération** en cours. La priorité d'une itération est égale à la criticité maximale des messages qu'elle traite. C'est cette valeur qui détermine si un nouveau message entrant doit déclencher une préemption.

### Autorité

L'autorité détermine quels tools un node peut appeler. Trois niveaux :

| Niveau | Nom | Droits |
|---|---|---|
| 0 | `basic` | Communication, fichiers, auto-sleep |
| 1 | `elevated` | + spawn/kill/stop/start d'autres nodes, rewire, wake, inspection |
| 2 | `root` | + modifier l'autorité d'autres nodes, register/unregister node types, shutdown réseau |

Un node ne peut modifier que des nodes de niveau d'autorité **inférieur** au sien. Un node `root` peut tout faire. L'autorité est attribuée à la création du node et ne peut être modifiée que par un node `root`.

---

## Cycle de vie d'un node

### Boucle principale

Le framework exécute cette boucle pour chaque node :

```
┌─────────────────────────────────────────────────┐
│                 NODE LOOP                        │
├─────────────────────────────────────────────────┤
│                                                 │
│  1. COLLECT                                     │
│     ├─ Collecter les messages des mailboxes     │
│     ╰─ Construire le NodeContext                │
│                                                 │
│  2. EXECUTE HANDLER                             │
│     ├─ await node.handler(ctx)                  │
│     ├─ Le handler fait ce qu'il veut :          │
│     │   code pur, callLLM(), callTool(), etc.   │
│     ╰─ Pendant l'exécution : le framework       │
│        surveille les messages entrants pour      │
│        préemption éventuelle                     │
│                                                 │
│  3. POST-ITERATION                              │
│     ├─ Si sleep() appelé → passage en veille    │
│     ├─ Persister le state local                 │
│     ╰─ Appliquer idle throttle si aucun message │
│                                                 │
│  4. REPEAT                                      │
│     ╰─ Retour à l'étape 1                      │
│                                                 │
└─────────────────────────────────────────────────┘
```

### États d'un node

```
                    spawn
                      │
                      v
              ┌──────────────┐
              │    ACTIVE     │◄──────────────────────────┐
              │  (handler loop)│                            │
              └──┬─────────┬─┘                            │
                 │         │                              │
      sleep()   │         │  stop_node()                 │
      (self)    │         │  (ordre externe)              │
                v         v                              │
  ┌──────────────┐    ┌──────────────┐                   │
  │   SLEEPING    │    │   STOPPED     │                   │
  │ (écoute seule)│    │ (coupé, muet) │                   │
  └──────┬───────┘    └──────┬───────┘                   │
         │                   │                            │
         │ wake              │ start_node()               │
         │ (message match    │ (ordre externe)             │
         │  ou wake_node())  │                            │
         ╰───────────────────╰────────────────────────────┘
                 │
      kill_node()│ ou ttl expiré (depuis n'importe quel état)
                 v
          ┌──────────────┐
          │  TERMINATED   │
          │  (supprimé)   │
          └──────────────┘
```

**ACTIVE** — Le node exécute sa boucle complète. Chaque itération consomme des ressources (tokens si LLM, CPU si code).

**SLEEPING** — Décidé par le node **lui-même** (via le tool `sleep`). Le node ne fait plus d'appels handler mais le framework continue de recevoir les messages sur ses topics abonnés et les évalue contre les `wake_conditions` définies par le node. Dès qu'une condition est remplie, le node repasse en ACTIVE avec le message déclencheur dans son buffer. La veille consomme **zéro token**. C'est l'équivalent de "fermer les yeux" — le node choisit de se reposer.

**STOPPED** — Décidé par un **node externe** ayant l'autorité (via le tool `stop_node`). Le node est coupé : plus de handler **et** plus d'écoute de messages. Les messages sur ses topics sont ignorés (ou bufferisés selon la config). Il ne peut être relancé que par un ordre externe (`start_node`). C'est l'équivalent d'une anesthésie — le node ne décide pas, on lui impose.

**TERMINATED** — Le node est détruit et retiré du réseau. Ses abonnements sont supprimés. Son historique peut être archivé pour audit. Irréversible. Si le node tourne dans un container Docker, le container est stoppé et supprimé.

### Idle throttle

Un node actif sans messages à traiter tourne "à vide". Pour limiter la consommation de ressources, le framework applique un **throttle progressif** transparent pour le node :

```
Itération avec messages    → délai avant prochaine itération : 0ms (immédiat)
1ère itération idle        → délai : 1s
2ème itération idle        → délai : 2s
3ème itération idle        → délai : 5s
4ème+ itération idle       → délai : 10s (plafond)

Dès qu'un message arrive   → reset du throttle, itération immédiate
```

Le node ne perçoit pas ce throttle. Pour lui, il tourne en continu. Mais côté framework, on espace les appels handler quand il n'y a rien à traiter. Si un message arrive pendant un délai de throttle, le délai est annulé et l'itération est lancée immédiatement.

---

## Système de communication

### Bus pub/sub

Le coeur de la communication est un bus de messages pub/sub (publish/subscribe) inspiré de ROS (Robot Operating System). Les nodes ne se connaissent pas directement — ils publient sur des topics et s'abonnent à des topics.

```
Node A ──publish──► [topic: alerts.audio] ──deliver──► Node C (abonné à alerts.*)
                                           ──deliver──► Node D (abonné à alerts.audio)

Node B ──publish──► [topic: tasks.report]  ──deliver──► Node C (abonné à tasks.*)
```

Le bus est géré par un **broker central** côté framework (Redis pub/sub + BullMQ pour les queues prioritaires). Le broker :

1. Reçoit les messages publiés (depuis des nodes locaux via IPC ou distants via WebSocket)
2. Évalue les abonnements (avec résolution des wildcards)
3. Route les messages vers les **mailboxes** des nodes abonnés
4. Gère la persistance (historique des messages pour le tracing)
5. Évalue les `wake_conditions` des nodes en veille
6. Déclenche les préemptions si nécessaire

### Mailbox et rétention

Chaque souscription a sa propre **mailbox** — un buffer de messages avec une politique de rétention configurable. C'est le node (ou celui qui le configure) qui décide combien de messages garder et lesquels jeter quand c'est plein.

```typescript
interface MailboxConfig {
  max_size: number;           // Nombre max de messages dans la mailbox
  retention:
    | "latest"                // Quand plein : écraser les plus anciens (FIFO)
    | "lowest_priority"       // Quand plein : écraser le message de criticité la plus basse
}
```

Exemples :

```typescript
// L'heure : on ne veut que la dernière valeur
subscribe("time.tick", { max_size: 1, retention: "latest" })

// Alertes : on garde les 50 dernières, on jette les moins critiques si plein
subscribe("alerts.*", { max_size: 50, retention: "lowest_priority" })

// Un flux de données : on garde 200 messages, FIFO classique
subscribe("raw.data.*", { max_size: 200, retention: "latest" })
```

La mailbox par défaut (si non spécifiée) : `{ max_size: 100, retention: "latest" }`.

### Lecture des messages

Le handler peut lire ses mailboxes de plusieurs façons via `ctx.readMessages()` :

```typescript
ctx.readMessages({
  topic?: string,                       // Filtrer par topic (pattern avec wildcard)
  limit?: number,                       // Max N messages
  mode?: "unread" | "latest" | "all",   // Mode de lecture
  min_criticality?: number,             // Filtrer par criticité minimum
  peek?: boolean,                       // Si true, ne marque PAS comme lu
})
```

**Modes de lecture :**

| Mode | Comportement |
|---|---|
| `"unread"` (défaut) | Retourne les messages non encore lus et les marque comme lus |
| `"latest"` | Retourne les N derniers messages de la mailbox (lus ou non) |
| `"all"` | Retourne tout le contenu de la mailbox |

**Le raccourci `ctx.messages`** est équivalent à `ctx.readMessages({ mode: "unread" })` — tous les non-lus de toutes les mailboxes.

**`peek: true`** permet de regarder sans consommer. Utile pour :
- Un node d'inspection qui veut voir ce qui se passe sans interférer
- Un handler qui veut décider s'il traite maintenant ou s'il attend plus de messages

Exemples concrets dans un handler :

```typescript
// Juste la dernière heure
const [time] = ctx.readMessages({ topic: "time.tick", mode: "latest", limit: 1 });

// Tous les non-lus, triés par criticité
const msgs = ctx.readMessages({ mode: "unread" });

// Regarder les alertes sans les marquer comme lues
const alerts = ctx.readMessages({ topic: "alerts.*", mode: "all", peek: true });

// Que les messages critiques
const urgent = ctx.readMessages({ min_criticality: 7, mode: "unread" });
```

### Format des messages

Chaque message transite dans une enveloppe standardisée :

```typescript
interface Message {
  id: string;
  from: string;
  topic: string;
  type: "text" | "file" | "alert";
  criticality: number;          // 0-10
  payload: Payload;
  timestamp: number;
  reply_to?: string;
  ttl?: number;
  metadata?: Record<string, any>;
}
```

### Types de payload

**Text** — Message textuel simple.

```typescript
interface TextPayload {
  content: string;
}
```

**File** — Référence vers un fichier partagé. Le fichier est stocké dans un espace de stockage partagé accessible à tous les nodes.

```typescript
interface FilePayload {
  file_id: string;             // Référence unique au fichier
  filename: string;            // Nom original
  mime_type: string;           // Type MIME
  size: number;                // Taille en bytes
  description?: string;        // Description textuelle du contenu
}
```

**Alert** — Message d'alerte avec contexte structuré.

```typescript
interface AlertPayload {
  title: string;               // Titre court de l'alerte
  description: string;         // Description détaillée
  source_context?: string;     // Contexte de l'émetteur au moment de l'alerte
  suggested_action?: string;   // Action suggérée par l'émetteur
  requires_ack?: boolean;      // Si true, l'émetteur attend un accusé de réception
}
```

### Patterns de topics

Le framework **n'impose aucune convention** de nommage. Les topics sont des chaînes libres avec une hiérarchie par points. Ce sont les nodes eux-mêmes qui établissent leurs conventions en fonction de leur rôle.

C'est un choix de design délibéré : la mémoire, les tâches, les alertes — tout ça ce sont des **nodes**, pas des features du framework. Un node "mémoire courte" et un node "mémoire longue" sont juste deux nodes qui s'abonnent à des topics qu'ils ont définis entre eux. Le framework ne sait pas ce qu'est de la "mémoire" — il sait juste router des messages.

---

## Système de préemption

### Principe

Chaque itération d'un node a une **priorité courante** égale à la criticité maximale des messages qu'elle traite. Si un message arrive avec une criticité **strictement supérieure** à la priorité courante pendant que le handler s'exécute, le framework déclenche une **préemption** :

1. L'exécution en cours est annulée (stream LLM cancel, ou signal au handler)
2. La réponse partielle est sauvegardée
3. Les tool calls déjà exécutées sont notées
4. Une nouvelle itération est lancée avec tout le contexte (anciens messages + nouveau message urgent + réponse partielle + historique des tools exécutés)
5. Le handler (ou le LLM) arbitre sur ce qu'il fait de cette situation

### Flow détaillé

```
Temps ──────────────────────────────────────────────────────►

Buffer:  [MsgA prio:3] [MsgB prio:5]
              │              │
              ╰──────┬───────╯
                     │
         ┌───────────▼────────────┐
         │  Itération lancée      │
         │  Contexte: [A, B]      │
         │  prio_run = 5          │
         │                        │
         │  Handler en cours...   │
         │  ├─ tool_call_1 ✓      │
         │  ├─ traitement...      │   ◄── MsgC arrive (prio:4)
         │  │                     │       4 < 5 → buffer pour plus tard
         │  │                     │
         │  ├─ traitement...      │   ◄── MsgD arrive (prio:8)
         │  │                     │       8 > 5 → PREEMPT !
         │  │                     │
         │  ╳ CANCEL              │
         └────────────────────────┘
                     │
                     ▼
         ┌────────────────────────────────────┐
         │  Nouvelle itération                │
         │  Contexte: [A, B, C, D]            │
         │  + "Réponse interrompue :          │
         │    tool_call_1 exécuté (résultat), │
         │    traitement partiel : '...' "    │
         │  + "Interrompu par MsgD (prio:8)"  │
         │  prio_run = 8                      │
         │                                    │
         │  Handler décide quoi faire...      │
         └────────────────────────────────────┘
```

### Réponse partielle et continuité

Quand une itération est interrompue, il est crucial de conserver le travail déjà effectué. Le `preemptionContext` dans le NodeContext inclut :

```
--- INTERRUPTION ---
Ton itération précédente a été interrompue par un message de criticité supérieure.

Actions déjà effectuées durant l'itération interrompue :
- tool_call: publish(topic="tasks.assign", ...) → succès
- texte généré (partiel) : "J'ai analysé la situation et je pense que..."

Messages que tu traitais : [MsgA (prio:3), MsgB (prio:5)]

Nouveau message ayant causé l'interruption :
- MsgD (prio:8) sur topic "alerts.audio" : "Détection d'une voix agressive..."

Messages supplémentaires arrivés entre-temps :
- MsgC (prio:4) sur topic "tasks.report" : "Rapport terminé..."

Tu as maintenant tout le contexte. Décide de la marche à suivre.
--- FIN INTERRUPTION ---
```

Le LLM voit tout : ce qu'il avait commencé, ce qui l'a interrompu, et les autres messages en attente. Il est libre de :
- Abandonner son travail précédent et traiter l'urgence
- Traiter l'urgence puis reprendre où il en était
- Fusionner si les sujets sont liés
- Déléguer l'urgence à un autre node et continuer son travail

### Anti-thrashing

Si des messages haute priorité arrivent en rafale, on risque un cycle cancel-relaunch-cancel-relaunch qui gaspille des tokens sans jamais finir une itération. Deux mécanismes de protection :

**Debounce de préemption** — Quand une préemption est déclenchée, un délai de grâce de **500ms** est appliqué avant de relancer l'itération. Pendant ce délai, tous les messages entrants sont accumulés dans le buffer. Cela permet de battre plusieurs alertes urgentes en une seule itération.

**Compteur de préemptions** — Si un node est preempté plus de **3 fois consécutives** sans terminer une itération, le framework injecte un message système : "Tu as été interrompu N fois consécutives. Considère une réponse courte et ciblée." Cela guide le LLM vers des réponses plus concises dans les situations de haute pression.

---

## Tools des nodes

Chaque node dispose d'un ensemble de tools qu'il peut appeler via des tool calls LLM ou directement dans son handler via le `NodeContext`. Le framework exécute ces tools et retourne le résultat. Certains tools sont disponibles pour tous les nodes, d'autres nécessitent un niveau d'autorité minimum.

### Tools de communication

Disponibles pour tous les nodes (autorité `basic`+).

#### `publish`

Publie un message sur un topic.

```typescript
publish({
  topic: string,              // Topic de publication
  type: "text" | "file" | "alert",
  criticality: number,        // 0-10
  payload: {
    // TextPayload
    content?: string,
    // FilePayload
    file_id?: string,
    filename?: string,
    mime_type?: string,
    description?: string,
    // AlertPayload
    title?: string,
    description?: string,
    source_context?: string,
    suggested_action?: string,
    requires_ack?: boolean
  },
  reply_to?: string,          // ID du message auquel on répond
  ttl?: number                // Durée de vie du message en ms
})
// Retour : { message_id: string, delivered_to: number }
```

#### `subscribe`

Ajoute un abonnement à un topic avec configuration de mailbox.

```typescript
subscribe({
  topic: string,              // Pattern de topic (supporte wildcard *)
  min_criticality?: number,   // Filtre optionnel : ne recevoir que les messages >= ce niveau
  mailbox?: {
    max_size?: number,        // Taille max de la mailbox (défaut: 100)
    retention?: "latest" | "lowest_priority"  // Politique quand plein (défaut: "latest")
  }
})
// Retour : { subscription_id: string, topic: string }
```

#### `unsubscribe`

Retire un abonnement.

```typescript
unsubscribe({
  topic?: string,             // Pattern de topic à désabonner
  subscription_id?: string    // Ou l'ID direct de la souscription
})
// Retour : { removed: boolean }
```

### Tools de cycle de vie

#### `sleep` (autorité `basic`+)

Met le node en veille. Le node cesse d'exécuter son handler mais continue d'écouter les messages. Il se réveille quand une condition est remplie.

```typescript
sleep({
  wake_on: Array<{
    type: "topic",
    value: string,            // Pattern de topic
    min_criticality?: number  // Optionnel : seulement si criticité >= N
  } | {
    type: "timer",
    value: string             // Durée (ex: "5m", "1h", "30s")
  } | {
    type: "any"               // N'importe quel message sur un topic abonné
  }>
})
// Retour : { status: "sleeping", wake_conditions: [...] }
// Le node se réveille avec le message déclencheur dans son contexte
```

#### `spawn_node` (autorité `elevated`+)

Crée une nouvelle instance d'un node type enregistré.

```typescript
spawn_node({
  type: string,               // Le node type (package) à instancier
  name: string,
  tags?: string[],
  subscriptions?: Array<{ topic: string, mailbox?: MailboxConfig }>,
  priority?: number,
  ttl?: string,               // Durée de vie optionnelle (ex: "10m", "1h")
  authority_level?: number,   // 0 par défaut, max = créateur - 1 (sauf root)
  transport?: "process" | "container",  // Mode d'exécution (défaut: "process")
  config_overrides?: Record<string, any>,  // Config spécifique à l'instance (model, system_prompt, etc.)
  initial_message?: string    // Premier message injecté au démarrage
})
// Retour : { node_id: string, name: string, status: "active", transport: string }
```

#### `kill_node` (autorité `elevated`+)

Arrête et supprime un node. Le node cible doit avoir une autorité **strictement inférieure** au node appelant.

```typescript
kill_node({
  node_id: string,
  reason?: string             // Raison de l'arrêt (loggée)
})
// Retour : { killed: boolean, node_id: string }
```

#### `wake_node` (autorité `elevated`+)

Réveille un node en veille, même si ses wake_conditions ne sont pas remplies.

```typescript
wake_node({
  node_id: string,
  message?: string            // Message injecté au réveil
})
// Retour : { woken: boolean, node_id: string, previous_state: string }
```

#### `stop_node` (autorité `elevated`+)

Coupe un node de force. Le node passe en état STOPPED : plus de handler, plus d'écoute de messages. Seul un `start_node` peut le relancer. Le node cible doit avoir une autorité strictement inférieure.

```typescript
stop_node({
  node_id: string,
  reason?: string,            // Raison (loggée et visible au node au redémarrage)
  buffer_messages?: boolean   // Si true, les messages continuent d'être bufferisés (défaut: false)
})
// Retour : { stopped: boolean, node_id: string }
```

#### `start_node` (autorité `elevated`+)

Relance un node en état STOPPED. Le node repart en ACTIVE avec, optionnellement, les messages bufferisés pendant l'arrêt.

```typescript
start_node({
  node_id: string,
  message?: string            // Message injecté au redémarrage
})
// Retour : { started: boolean, node_id: string, buffered_messages: number }
```

### Tools de réseau

#### `rewire` (autorité `elevated`+)

Modifie les abonnements d'un autre node. Permet de reconfigurer la topologie du réseau dynamiquement.

```typescript
rewire({
  node_id: string,
  add_subscriptions?: Array<{ topic: string, mailbox?: MailboxConfig }>,
  remove_subscriptions?: string[],
  replace_subscriptions?: Array<{ topic: string, mailbox?: MailboxConfig }>
})
// Retour : { node_id: string, subscriptions: string[] }
```

#### `set_authority` (autorité `root` uniquement)

Modifie le niveau d'autorité d'un node.

```typescript
set_authority({
  node_id: string,
  authority_level: number     // 0, 1 ou 2
})
// Retour : { node_id: string, authority_level: number, previous: number }
```

### Tools d'inspection

Disponibles pour tout node avec autorité `elevated`+. Permettent d'introspecter l'état du réseau.

#### `inspect_network`

Retourne un snapshot du graphe complet ou filtré du réseau.

```typescript
inspect_network({
  filter?: {
    tags?: string[],
    state?: "active" | "sleeping" | "stopped" | "all",
    authority_level?: number,
    spawned_by?: string,
    transport?: "process" | "container"
  },
  depth?: number,
  from_node?: string,
  include_edges?: boolean
})
```

Retourne une représentation textuelle du graphe lisible par le LLM :

```
Network snapshot (12 nodes, 34 edges):

[conscience] ACTIVE prio=10 auth=root transport=process tags=[orchestration, decision]
  ├─ subscribes: alerts.*, status.*, conscience.inbox
  ├─ publishes: orders.*, conscience.broadcast
  ╰─ last_activity: 2s ago

[audio-detection] ACTIVE prio=5 auth=basic transport=container tags=[audio, perception]
  ├─ subscribes: raw.audio
  ├─ publishes: alerts.audio, events.audio.*
  ╰─ last_activity: 150ms ago

[planning] SLEEPING wake_on=[tasks.assign, alerts.* >= 7] prio=6 auth=basic transport=process
  ├─ subscribes: tasks.assign, context.update
  ├─ publishes: tasks.plan, tasks.report
  ╰─ last_activity: 45s ago

[temp-reflection-a3f] ACTIVE prio=3 auth=basic transport=container (dynamic)
  ├─ spawned_by: conscience | ttl: 4m32s remaining
  ├─ subscribes: tasks.reflect.a3f
  ├─ publishes: tasks.reflect.a3f.result
  ╰─ last_activity: 1s ago
```

#### `find_nodes`

Recherche des nodes par capacité, tags, ou patterns d'abonnement.

```typescript
find_nodes({
  query?: string,
  tags?: string[],
  subscribes_to?: string,
  publishes_on?: string,
  state?: "active" | "sleeping" | "stopped" | "all",
  transport?: "process" | "container",
  capabilities?: string[]
})
// Retour : liste de nodes avec leurs métadonnées
```

#### `inspect_node`

Retourne le détail complet d'un node spécifique.

```typescript
inspect_node({
  node_id: string,
  include: Array<
    "subscriptions" |
    "publications" |
    "history" |
    "state" |
    "config" |
    "stats"
  >
})
```

#### `trace_message`

Retourne l'historique des messages sur un topic ou entre des nodes spécifiques.

```typescript
trace_message({
  topic?: string,
  from?: string,
  to?: string,
  last?: number,              // N derniers messages (défaut: 20)
  since?: number,
  min_criticality?: number
})
// Retour : liste de messages avec émetteur, destinataires, timestamps
```

### Tools de fichiers

Disponibles pour tous les nodes (autorité `basic`+). Les fichiers sont stockés dans un espace partagé accessible à tous les nodes (local ou S3 selon le déploiement).

#### `write_file`

```typescript
write_file({
  filename: string,
  content: string,
  mime_type?: string,
  description?: string
})
// Retour : { file_id: string, filename: string, size: number }
```

#### `read_file`

```typescript
read_file({
  file_id: string
})
// Retour : { content: string, filename: string, mime_type: string, metadata: {...} }
```

#### `list_files`

```typescript
list_files({
  filter?: {
    created_by?: string,
    mime_type?: string,
    filename_pattern?: string
  }
})
// Retour : liste de fichiers avec métadonnées
```

### Tools de node types (hot-reload)

Ces tools permettent de gérer les types de nodes disponibles dans le framework. Ils sont la base du système de hot-reload et d'auto-extension du réseau.

#### `register_node_type` (autorité `root`)

Enregistre un nouveau type de node à partir d'un package existant sur le filesystem. Le framework le valide, le charge, et le rend disponible pour `spawn_node`.

```typescript
register_node_type({
  path: string,               // Chemin vers le dossier du node package
  build?: boolean,            // Lancer le build avant de charger (défaut: true)
  docker_build?: boolean      // Construire aussi l'image Docker (défaut: false)
})
// Retour : { type: string, status: "registered", available_transports: ["process", "container"?] }
```

#### `unregister_node_type` (autorité `root`)

Retire un type de node du framework. Les instances en cours peuvent être tuées ou laissées en l'état.

```typescript
unregister_node_type({
  type: string,
  kill_instances?: boolean    // Tuer toutes les instances de ce type (défaut: false)
})
// Retour : { unregistered: boolean, killed_instances: number }
```

#### `list_node_types` (autorité `elevated`+)

Liste tous les types de nodes enregistrés.

```typescript
list_node_types({
  filter?: {
    origin?: "static" | "dynamic",
    tags?: string[]
  }
})
// Retour : liste de types avec metadata (nom, tags, origin, nombre d'instances actives)
```

### Pas de tools de mémoire dans le framework

La mémoire **n'est pas un tool du framework**. C'est un **node** comme un autre. Un node "mémoire courte" est juste un handler avec un state persistant ou une DB, abonné à des topics que les autres nodes utilisent pour lui parler.

Pourquoi ? Parce que le framework doit rester abstrait. Si on code `memory_store` en dur, on fige une vision de ce qu'est la mémoire. En laissant ça au niveau des nodes :

- On peut avoir un node "mémoire courte" (contexte récent, rapide, volatile) et un node "mémoire longue" (persistance fichier/DB, plus lent, résumé)
- On peut avoir un node "mémoire émotionnelle" qui ne retient que les événements à haute criticité
- On peut avoir un node "index" qui sait où chercher dans les autres mémoires
- Chaque implémentation de mémoire peut être un modèle LLM différent, ou même pas un LLM du tout (un node "outil" qui wrap une base vectorielle par exemple)

Le même raisonnement s'applique aux tâches, à la planification, etc. Le framework fournit : **publish, subscribe, fichiers, spawn, kill, stop, start, inspect, register/unregister node types**. Tout le reste est émergent.

---

## Système d'autorité et permissions

Le système d'autorité est volontairement simple. Chaque node a un `authority_level` (0, 1 ou 2) qui détermine quels tools il peut appeler.

### Matrice de permissions

| Tool | basic (0) | elevated (1) | root (2) |
|---|---|---|---|
| publish, subscribe, unsubscribe | oui | oui | oui |
| sleep (soi-même) | oui | oui | oui |
| read_file, write_file, list_files | oui | oui | oui |
| set_tags (soi-même) | oui | oui | oui |
| inspect_network, find_nodes, inspect_node, trace_message | non | oui | oui |
| list_node_types | non | oui | oui |
| spawn_node | non | oui (auth enfant ≤ 0) | oui (auth enfant ≤ 1) |
| kill_node, wake_node | non | oui (cible auth < 1) | oui (cible auth < 2) |
| stop_node, start_node | non | oui (cible auth < 1) | oui (cible auth < 2) |
| rewire | non | oui (cible auth < 1) | oui (toute cible) |
| register_node_type, unregister_node_type | non | non | oui |
| set_authority | non | non | oui |

### Règles

1. Un node ne peut **jamais** élever sa propre autorité.
2. Un node ne peut agir (kill, wake, rewire, stop, start) que sur des nodes de niveau **strictement inférieur**.
3. Un node `root` peut tout faire sauf se kill lui-même (sécurité).
4. Les tools non autorisés ne sont **pas visibles** dans le prompt du node — il ne sait même pas qu'ils existent.
5. Si un node tente d'appeler un tool pour lequel il n'a pas l'autorité (ne devrait pas arriver vu le point 4), le framework retourne une erreur.
6. Seuls les nodes `root` peuvent enregistrer de nouveaux types de nodes (register/unregister), car c'est l'équivalent d'injecter du code dans le système.

---

## Inspection du réseau

L'inspection est la capacité d'un node autorisé (elevated+) à observer l'état du réseau en temps réel. C'est l'équivalent d'un `kubectl` ou `htop` pour le réseau de nodes.

**Snapshot du graphe** — `inspect_network()` sans filtre retourne le graphe complet. C'est la vue "god mode" que le node conscience utilise pour comprendre l'état global. Le format de retour est optimisé pour être lu par un LLM : textuel, hiérarchique, avec les informations les plus pertinentes en premier (état, priorité, transport, activité récente).

**Recherche de nodes** — `find_nodes()` permet des requêtes ciblées :
- "Quel node sait traiter de l'audio ?" → `find_nodes({ tags: ["audio"] })`
- "Qui écoute les alertes ?" → `find_nodes({ subscribes_to: "alerts.*" })`
- "Quels nodes sont stoppés ?" → `find_nodes({ state: "stopped" })`
- "Quels nodes tournent en container ?" → `find_nodes({ transport: "container" })`

**Inspection individuelle** — `inspect_node()` permet de plonger dans un node spécifique : état, abonnements, historique, statistiques (tokens consommés, messages envoyés/reçus, temps de réponse moyen).

**Trace des messages** — `trace_message()` permet d'auditer les flux de communication : les N derniers messages sur un topic, entre deux nodes, filtrés par criticité.

---

## Architecture monorepo

### Structure du projet

```
brAIn/
├── packages/
│   ├── sdk/                              # @brain/sdk — types, contrat, client
│   │   ├── src/
│   │   │   ├── types.ts                  # NodeHandler, NodeContext, Message, etc.
│   │   │   ├── config.ts                 # NodeConfig interface
│   │   │   ├── client.ts                 # BrainClient (connexion au framework)
│   │   │   ├── transport/
│   │   │   │   ├── ipc.transport.ts      # Transport IPC (worker thread / child process)
│   │   │   │   └── ws.transport.ts       # Transport WebSocket (container / distant)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── core/                             # @brain/core — le moteur
│   │   ├── src/
│   │   │   ├── runner/                   # NodeRunner, boucle, preemption
│   │   │   ├── bus/                      # Broker pub/sub, mailboxes, wildcards
│   │   │   ├── registry/                 # Registry des types + instances
│   │   │   ├── authority/                # Permissions
│   │   │   ├── inspection/               # Introspection réseau
│   │   │   ├── storage/                  # Fichiers partagés
│   │   │   ├── loader/                   # Chargement dynamique des node packages
│   │   │   ├── transport/                # Gestion IPC + WebSocket côté framework
│   │   │   └── docker/                   # Docker API (build, run, stop containers)
│   │   └── package.json
│   │
│   ├── api/                              # @brain/api — NestJS gateway
│   │   ├── src/
│   │   │   ├── rest/                     # CRUD nodes, config, fichiers, node types
│   │   │   ├── ws/                       # WebSocket gateway (events temps réel)
│   │   │   └── app.module.ts
│   │   └── package.json
│   │
│   └── dashboard/                        # @brain/dashboard — React frontend
│       ├── src/
│       │   ├── components/
│       │   │   ├── NetworkGraph/         # React Flow
│       │   │   ├── NodePanel/
│       │   │   ├── MessageLog/
│       │   │   ├── NodeCreator/
│       │   │   └── NodeTypeManager/      # Gestion des types installés
│       │   └── App.tsx
│       └── package.json
│
├── nodes/                                # Node packages — chacun isolé
│   ├── clock/                            # Statique : horloge simple
│   │   ├── src/
│   │   │   └── handler.ts
│   │   ├── config.json
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── llm-basic/                        # Statique : node LLM générique
│   │   ├── src/
│   │   │   └── handler.ts
│   │   ├── config.json
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── developer/                        # Statique : le meta-node qui crée d'autres nodes
│   │   ├── src/
│   │   │   └── handler.ts
│   │   ├── config.json
│   │   ├── Dockerfile
│   │   └── package.json
│   └── _dynamic/                         # Types créés à runtime par le developer node
│       └── .gitkeep
│
├── docker-compose.yml                    # Orchestration : framework + redis + postgres
├── package.json                          # Workspace root
├── pnpm-workspace.yaml                   # workspaces: ["packages/*", "nodes/*"]
└── ARCHITECTURE.md
```

### Le SDK (@brain/sdk)

Le SDK est le seul lien entre un node package et le framework. Il fournit :

1. **Les types TypeScript** — `NodeHandler`, `NodeContext`, `Message`, `NodeConfig`, etc. Zéro logique, juste le contrat.
2. **Le BrainClient** — Un client qui connecte le node au framework. Il abstrait le transport (IPC ou WebSocket) et expose la même interface `NodeContext` dans les deux cas.

```typescript
// Ce qui tourne DANS le container (ou le worker) du node
import { BrainClient } from "@brain/sdk";

const brain = new BrainClient({
  // Le SDK détecte automatiquement le mode de transport via les env vars
  // BRAIN_TRANSPORT=ipc   → IPC (worker thread)
  // BRAIN_TRANSPORT=ws    → WebSocket
  // BRAIN_FRAMEWORK_URL   → URL du framework (si ws)
  // BRAIN_NODE_ID         → ID de l'instance
  // BRAIN_NODE_TOKEN      → Token d'auth
});

// Le handler est importé depuis le package
import { handler } from "./handler";

brain.run(handler);  // Lance la boucle : attend les messages, appelle le handler
```

Le SDK est **ultra léger** — il n'embarque ni LLM SDK, ni Redis, ni rien de lourd. Ces dépendances sont dans le handler du node s'il en a besoin.

### Contrat d'un node package

Chaque node package exporte un handler et un config :

```typescript
// nodes/clock/src/handler.ts
import type { NodeHandler } from "@brain/sdk";

export const handler: NodeHandler = async (ctx) => {
  ctx.publish("time.tick", {
    type: "text",
    criticality: 0,
    payload: { content: new Date().toISOString() }
  });
};
```

```json
// nodes/clock/config.json
{
  "name": "clock",
  "description": "Publie l'heure sur un topic à intervalle régulier",
  "tags": ["utility", "time"],
  "default_authority": 0,
  "default_priority": 1,
  "default_subscriptions": [],
  "interval": "1s",
  "supports_transport": ["process", "container"]
}
```

```dockerfile
# nodes/clock/Dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
CMD ["node", "dist/main.js"]
```

Le `main.js` c'est toujours le même pattern : importer le SDK, se connecter au framework, lancer le handler.

### Node types statiques vs dynamiques

Le registry distingue deux origines de types :

| Type | Origine | Rechargeable | Supprimable par un node |
|---|---|---|---|
| **static** | Présent dans `nodes/` au boot | Oui (file watcher) | Non |
| **dynamic** | Créé par un node (developer) à runtime, stocké dans `nodes/_dynamic/` | Oui | Oui (par root) |

Les types statiques c'est le développeur humain qui les pose. Les types dynamiques c'est le réseau qui les crée. Les deux cohabitent dans le même registry.

Le config.json d'un type dynamique inclut un champ `origin` :

```json
{
  "name": "image-analyzer",
  "origin": "dynamic",
  "created_by": "developer-node-abc",
  "created_at": "2026-04-10T14:32:00Z",
  "validated": true,
  "tags": ["vision", "analysis"]
}
```

### Le developer node

Le developer node est un node statique spécial : un LLM capable de **créer de nouveaux types de nodes** à la volée. C'est le meta-node, celui qui permet au réseau de s'auto-étendre.

Son flow :

```
1. Reçoit une demande : "J'ai besoin d'un node qui analyse des images"
2. Crée un dossier dans nodes/_dynamic/image-analyzer-{uuid}/
3. Écrit handler.ts en s'appuyant sur @brain/sdk
4. Écrit config.json
5. Écrit package.json avec les deps nécessaires
6. npm install
7. tsc --noEmit pour valider la compilation
8. Si erreur → relit, corrige, retry
9. (Optionnel) docker build si le type doit supporter le mode container
10. Appelle register_node_type({ path: "nodes/_dynamic/image-analyzer-{uuid}" })
11. Publie un message : "Nouveau type disponible : image-analyzer"
12. Se kill ou attend la prochaine tâche
```

Ses tools spéciaux (en plus des tools standard) :

```typescript
write_project_file({ path, content })    // Écrire des fichiers dans un workspace
read_project_file({ path })              // Relire ce qu'il a écrit
exec_command({ cmd, cwd })               // npm install, tsc, docker build
register_node_type({ path })             // Dire au framework "charge ce type"
```

**Sécurité** : le developer node a l'autorité `root` (car `register_node_type` l'exige). Les types dynamiques qu'il crée sont validés avant chargement (compilation TypeScript, scan de patterns dangereux). Les instances créées à partir de types dynamiques tournent par défaut en mode **container** pour l'isolation. Un quota limite le nombre de types créables par heure.

### Hot-reload

Le framework charge les types de nodes dynamiquement via deux mécanismes :

1. **File watcher** (chokidar) — Surveille le dossier `nodes/`. Si un nouveau dossier apparaît (copié manuellement, `git clone`, etc.), le framework le détecte, le valide et le charge automatiquement.

2. **Tool `register_node_type`** — Un node (developer ou root) appelle explicitement le tool. Le framework charge le type immédiatement.

Pour installer un nouveau type de node manuellement :

```bash
# Option 1 : copier le dossier
cp -r mon-nouveau-node/ brAIn/nodes/

# Option 2 : git clone
cd brAIn/nodes && git clone https://github.com/user/brain-node-weather

# Option 3 : via le developer node (auto-extension)
# Le developer node écrit le code et appelle register_node_type()
```

Le framework ne redémarre pas — le nouveau type est disponible immédiatement pour `spawn_node`.

---

## Transport et déploiement

### Deux modes de transport

Chaque node instance peut tourner dans l'un de ces deux modes :

| Mode | Quand | Comment | Latence | Isolation |
|---|---|---|---|---|
| **process** | Nodes statiques de confiance, dev local | Worker thread / child process, même machine | ~1ms | Moyenne (même machine) |
| **container** | Nodes dynamiques, code non-trusté, prod, nodes distants | Container Docker, réseau | ~5-20ms | Forte (filesystem, réseau, resources isolés) |

Le handler ne sait pas dans quel mode il tourne. Le SDK abstrait le transport.

### Architecture Docker (réseau)

En mode container, le framework et les nodes communiquent via le réseau Docker :

```
┌──────────────────────────────────────────────────────────┐
│  Docker Network: brain-net                                │
│                                                          │
│  ┌───────────────┐     ┌──────────┐   ┌──────────────┐  │
│  │  brain-core    │     │  redis    │   │  postgres    │  │
│  │  (framework)   │◄───►│  :6379   │   │  :5432       │  │
│  │  :3000         │     └──────────┘   └──────────────┘  │
│  └──────┬────────┘                                       │
│         │ WebSocket                                      │
│    ┌────┼──────────┬──────────┬──────────┐               │
│    │    │          │          │          │               │
│    ▼    ▼          ▼          ▼          ▼               │
│  ┌────┐ ┌────┐  ┌─────┐  ┌─────────┐  ┌──────────┐    │
│  │clk │ │llm │  │audio│  │developer│  │ dynamic  │    │
│  │node│ │node│  │node │  │node     │  │ node     │    │
│  └────┘ └────┘  └─────┘  └─────────┘  └──────────┘    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Chaque node container :
1. Démarre avec les env vars `BRAIN_FRAMEWORK_URL`, `BRAIN_NODE_ID`, `BRAIN_NODE_TOKEN`
2. Se connecte en WebSocket au framework (`brain-core:3000`)
3. Le SDK reçoit les messages et appelle le handler
4. Les appels `ctx.publish()`, `ctx.readMessages()`, etc. transitent par le WebSocket

### Le SDK abstrait le transport

```typescript
// Dans @brain/sdk/src/client.ts
export class BrainClient {
  private transport: Transport;

  constructor() {
    // Auto-détection du mode de transport
    if (process.env.BRAIN_TRANSPORT === "ipc") {
      this.transport = new IPCTransport();    // parentPort / stdin-stdout
    } else {
      this.transport = new WSTransport(process.env.BRAIN_FRAMEWORK_URL);
    }
  }

  async run(handler: NodeHandler) {
    await this.transport.connect();

    while (true) {
      const ctx = await this.transport.receiveContext();   // Attend les messages
      await handler(ctx);                                   // Exécute le handler
      await this.transport.sendResults(ctx);               // Renvoie les résultats
    }
  }
}
```

Le node ne sait jamais s'il est un worker thread local ou un container sur une machine à l'autre bout du réseau. L'interface est identique.

### Spawn en mode container

Quand un node appelle `spawn_node` avec `transport: "container"`, le framework :

```typescript
// Côté framework
async spawnContainer(type: string, config: NodeInstanceConfig) {
  const container = await docker.createContainer({
    Image: `brain-node-${type}`,
    Env: [
      `BRAIN_TRANSPORT=ws`,
      `BRAIN_FRAMEWORK_URL=ws://brain-core:3000`,
      `BRAIN_NODE_ID=${generateId()}`,
      `BRAIN_NODE_TOKEN=${generateToken()}`,
    ],
    NetworkMode: "brain-net",
    // Resource limits pour l'isolation
    HostConfig: {
      Memory: config.memory_limit || 512 * 1024 * 1024,   // 512MB par défaut
      CpuShares: config.cpu_shares || 256,
    }
  });
  await container.start();
  // Le container se connecte automatiquement au framework via WebSocket
}
```

### Nodes distribués sur plusieurs machines

Grâce au transport WebSocket, un node peut tourner **n'importe où** du moment qu'il peut se connecter au framework :

```
Machine A (serveur principal)          Machine B (GPU server)
┌──────────────────────┐               ┌──────────────────────┐
│  brain-core :3000    │◄──── WS ─────►│  node: vision        │
│  redis               │               │  (GPU, PyTorch)      │
│  postgres            │               └──────────────────────┘
│  node: conscience    │
│  node: clock         │               Machine C (edge device)
│  node: planning      │               ┌──────────────────────┐
└──────────────────────┘◄──── WS ─────►│  node: audio-capture │
                                        │  (microphone local)  │
                                        └──────────────────────┘
```

Le framework voit tous les nodes de la même façon. Le bus route les messages de manière transparente — un message publié par le node `audio-capture` sur Machine C arrive dans la mailbox du node `conscience` sur Machine A via le broker Redis.

C'est la même architecture que ROS distribué : un seul master (le framework), des nodes partout sur le réseau.

---

## Stack technique

| Couche | Technologie | Rôle |
|---|---|---|
| **SDK** | TypeScript | Types + client de connexion au framework |
| **Frontend** | React + TypeScript | Interface de monitoring et configuration |
| **Graphe visuel** | @xyflow/react (React Flow) | Visualisation interactive du réseau de nodes |
| **Temps réel frontend** | WebSocket (Socket.IO) | Mise à jour live de l'état du réseau |
| **API Gateway** | NestJS (REST + WebSocket Gateway) | Point d'entrée HTTP et WebSocket |
| **Node runtime** | Worker threads / Docker containers | Exécution isolée de chaque node |
| **Message bus** | Redis Pub/Sub | Communication inter-nodes temps réel |
| **Queues prioritaires** | BullMQ (Redis) | Gestion des priorités et préemption |
| **Registry** | Redis | État des nodes, types, abonnements, topologie |
| **Persistance** | PostgreSQL | Configuration des nodes, logs, historique des messages |
| **Stockage fichiers** | Système de fichiers local / S3 | Fichiers partagés entre nodes |
| **Containers** | Docker (Dockerode) | Gestion des containers nodes distants/isolés |
| **LLM** | Anthropic SDK / OpenAI SDK | Appels aux modèles (dans les nodes, pas le framework) |
| **Monorepo** | pnpm workspaces | Gestion des packages |

---

## Architecture backend (NestJS)

### Modules principaux

```
packages/core/src/
├── runner/
│   ├── node-runner.ts                # Boucle principale d'un node
│   ├── node-runner.factory.ts        # Crée un runner selon le transport
│   └── preemption.service.ts         # Logique de préemption + anti-thrashing
├── bus/
│   ├── bus.service.ts                # Broker pub/sub central
│   ├── bus.queue.ts                  # Queues prioritaires (BullMQ)
│   ├── bus.matcher.ts                # Résolution des wildcards de topics
│   └── mailbox.ts                    # Gestion des mailboxes par souscription
├── registry/
│   ├── type-registry.ts              # Registry des node types (packages installés)
│   ├── instance-registry.ts          # Registry des instances en cours
│   └── node.entity.ts                # Modèle de données
├── authority/
│   ├── authority.service.ts          # Vérification des permissions
│   └── authority.guard.ts            # Guard pour les tools
├── inspection/
│   ├── inspection.service.ts         # Logique d'inspection du réseau
│   └── inspection.formatter.ts       # Formatage texte pour LLM
├── storage/
│   └── file.service.ts               # Gestion des fichiers partagés
├── transport/
│   ├── ipc.adapter.ts                # Communication avec les worker threads
│   ├── ws.adapter.ts                 # Communication avec les containers distants
│   └── transport.factory.ts          # Sélection du transport
├── loader/
│   ├── loader.service.ts             # Chargement dynamique des node packages
│   ├── watcher.service.ts            # File watcher sur nodes/
│   └── validator.service.ts          # Validation des types avant chargement
└── docker/
    ├── docker.service.ts             # API Docker (build, run, stop, remove)
    └── docker.builder.ts             # Build d'images depuis les node packages

packages/api/src/
├── rest/
│   ├── nodes.controller.ts           # CRUD instances
│   ├── types.controller.ts           # CRUD node types
│   ├── files.controller.ts           # Upload/download fichiers
│   └── network.controller.ts         # Inspection, trace
├── ws/
│   ├── node.gateway.ts               # WebSocket gateway pour les nodes (transport)
│   └── dashboard.gateway.ts          # WebSocket gateway pour le frontend (events)
└── app.module.ts
```

### Isolation des nodes

Chaque node tourne dans un environnement isolé selon son transport :

**Mode process** — Worker thread (ou child process). Communication par IPC (message port). Le `NodeRunner` tourne dans le worker et communique avec le framework dans le thread principal.

**Mode container** — Container Docker sur le réseau `brain-net`. Communication par WebSocket. Le container exécute le SDK (`BrainClient`) qui se connecte au framework.

```
NodeRunner (un par node, côté framework)
├── Exécute la boucle : collect → dispatch au handler → post-iteration
├── Construit le NodeContext à chaque itération
├── Maintient les mailboxes de messages
├── Gère le throttle idle
├── Communique avec le bus via le BusService
├── Dispatche l'exécution au handler via le transport (IPC ou WS)
├── Gère la préemption (cancel + relance avec contexte enrichi)
╰── En mode container : gère la connexion WebSocket avec le container
```

Si un node crash, seul son worker/container est affecté. Le registry le détecte et peut le redémarrer ou le signaler au réseau.

---

## Architecture frontend (React)

### Vue principale

L'interface est centrée sur un **graphe interactif** (React Flow) montrant tous les nodes et leurs connexions en temps réel.

```
┌─────────────────────────────────────────────────────┐
│  brAIn — Network Monitor                   [+ Node] │
├─────────┬───────────────────────────────────────────┤
│         │                                           │
│  Nodes  │        ┌───────────┐                      │
│  -----  │        │ conscience│                      │
│  ● cons │   ┌───►│  ACTIVE   │◄───┐                │
│  ● audio│   │    └─────┬─────┘    │                │
│  ◐ plan │   │          │          │                │
│  ● temp │   │          ▼          │                │
│         │   │    ┌───────────┐    │                │
│  Types  │   │    │  planning │    │                │
│  -----  │   │    │ SLEEPING  │    │                │
│  clock  │   │    └───────────┘    │                │
│  llm    │   │                     │                │
│  dev    │   │   ┌──────────┐  ┌──────────┐        │
│         │   ╰───│  audio   │  │  temp    │        │
│         │       │  ACTIVE  │  │  ACTIVE  │        │
│         │       │ container│  │ container│        │
│         │       └──────────┘  └──────────┘        │
│         │                                          │
├─────────┴──────────────────────────────────────────┤
│  Message log  │  [alerts.*]  prio:8                │
│  13:42:01 audio → alerts.audio "Voix détectée"     │
│  13:42:01 conscience ← alerts.audio (preempted)    │
│  13:42:00 conscience → tasks.assign "Planifier..." │
└────────────────────────────────────────────────────┘
```

### Composants clés

- **NetworkGraph** — Graphe React Flow avec les nodes comme blocs et les souscriptions comme edges. Mis à jour en temps réel via WebSocket. Indique le mode de transport (process/container) et la machine hôte.
- **NodePanel** — Panneau latéral affichant le détail d'un node sélectionné (état, config, historique, stats, transport).
- **MessageLog** — Flux temps réel des messages circulant dans le réseau, filtrable par topic/criticité/node.
- **NodeCreator** — Formulaire de création d'un nouveau node : sélection du type, choix du transport, config.
- **NodeTypeManager** — Gestion des types installés : liste, install, uninstall, voir les instances.
- **TopologyEditor** — Interface pour rewire manuellement des nodes (drag & drop des edges).

### Temps réel

Le frontend se connecte au backend via WebSocket (Socket.IO). Le backend pousse :
- Les changements d'état des nodes (actif, veille, stoppé, terminé)
- Les messages circulant sur le bus (pour le message log)
- Les événements de préemption
- Les créations/destructions de nodes et containers
- Les changements de topologie (rewire)
- Les enregistrements/désenregistrements de types (hot-reload)

Le frontend ne fait **aucune** action directe sur les nodes — il passe toujours par l'API REST ou WebSocket du backend, qui vérifie les permissions.
