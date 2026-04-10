# brAIn

**Bridged Reactive Artificial Intelligence Network**

Framework de nodes autonomes interconnectés, inspiré du fonctionnement du cerveau humain. Chaque node est une unité d'exécution abstraite (LLM, code pur, service MCP, ou un mix) qui tourne en boucle, communique avec les autres via un bus de messages pub/sub, et peut être interrompu, reconfiguré ou créé dynamiquement à l'exécution.

```
  ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ██████╔╝██║  ██║██║  ██║██║██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
```

---

## Concepts

- **Node** — Unité d'exécution autonome qui tourne en boucle. Peut être un LLM, du code pur, un wrapper MCP, ou un mix. Chaque node est un package indépendant avec son propre handler.
- **Bus pub/sub** — Les nodes communiquent via des topics avec wildcard matching (`alerts.*`). Chaque souscription a sa propre mailbox configurable (taille max, politique de rétention).
- **Criticité** — Chaque message porte un niveau de criticité (0-10) qui détermine la préemption : un message plus critique que l'itération en cours interrompt le node.
- **Autorité** — 3 niveaux (basic, elevated, root) contrôlent qui peut spawn, kill, rewire les autres nodes.
- **Hot-reload** — Les types de nodes sont des packages installables à la volée. Un node "developer" peut créer de nouveaux types à runtime.
- **Transport-agnostic** — Un node peut tourner en local (worker thread) ou à distance (container Docker sur le réseau).

Voir [ARCHITECTURE.md](./ARCHITECTURE.md) pour le design complet.

---

## Structure du projet

```
brAIn/
├── packages/
│   ├── sdk/          @brain/sdk        Types, interfaces, contrat des nodes
│   ├── core/         @brain/core       Moteur : bus, runner, registry, authority
│   ├── api/          @brain/api        NestJS REST + WebSocket gateway
│   └── dashboard/    @brain/dashboard  React + React Flow monitoring UI
├── nodes/
│   ├── clock/        Node horloge (publie l'heure chaque seconde)
│   ├── echo/         Node debug (log + republish les messages reçus)
│   └── _dynamic/     Types de nodes créés dynamiquement à runtime
├── docker-compose.yml
├── ARCHITECTURE.md
└── package.json
```

---

## Prérequis

- **Node.js** >= 20
- **pnpm** >= 9
- **Docker** + **Docker Compose** (pour Redis/PostgreSQL, optionnel en dev)

---

## Installation

```bash
git clone <repo-url> brAIn
cd brAIn
pnpm install
pnpm build
```

---

## Lancement

```bash
# Tout lancer (API + Dashboard en parallèle)
pnpm start
```

Le backend démarre sur `http://localhost:3000`, le dashboard sur `http://localhost:5173`.

Pour lancer les services séparément :

```bash
pnpm dev:api        # Backend NestJS seul
pnpm dev:dashboard  # Frontend Vite seul
```

Pour lancer Redis et PostgreSQL (optionnel, pas requis pour le dev) :

```bash
docker compose up -d
```

---

## Scripts disponibles

| Commande | Description |
|---|---|
| `pnpm start` | Lance API + Dashboard en parallèle |
| `pnpm dev:api` | Lance le backend NestJS (watch mode) |
| `pnpm dev:dashboard` | Lance le frontend Vite (HMR) |
| `pnpm build` | Build tous les packages |
| `pnpm lint` | ESLint strict sur tout le monorepo |
| `pnpm lint:fix` | Auto-fix les erreurs de lint |
| `pnpm clean` | Supprime tous les `dist/` |

---

## API

### Nodes (instances)

```
GET    /nodes              Liste toutes les instances
GET    /nodes/:id          Détail d'un node
POST   /nodes              Spawn un node    { type, name, subscriptions? }
DELETE /nodes/:id           Kill un node
POST   /nodes/:id/stop     Stop un node
POST   /nodes/:id/start    Relance un node stoppé
POST   /nodes/:id/wake     Réveille un node en veille
```

### Types

```
GET    /types              Liste les types de nodes enregistrés
GET    /types/:name        Détail d'un type + instances actives
POST   /types/register     Enregistre un nouveau type  { path }
DELETE /types/:name         Désenregistre un type
```

### Network

```
GET    /network            Snapshot complet du réseau (nodes + souscriptions)
GET    /network/messages   Historique des messages  ?last=N&topic=X&min_criticality=N
```

### WebSocket (Socket.IO)

Events temps réel poussés au dashboard :

| Event | Payload |
|---|---|
| `node:spawned` | NodeInfo |
| `node:killed` | `{ nodeId, reason? }` |
| `node:state_changed` | `{ nodeId, from, to }` |
| `message:published` | Message |

---

## Créer un node

Chaque node est un package dans `nodes/` avec 3 fichiers minimum :

**`config.json`**
```json
{
  "name": "my-node",
  "description": "What this node does",
  "tags": ["utility"],
  "default_authority": 0,
  "default_priority": 1,
  "default_subscriptions": [{ "topic": "some.topic" }],
  "supports_transport": ["process"]
}
```

**`src/handler.ts`**
```typescript
import type { NodeHandler } from "@brain/sdk";

export const handler: NodeHandler = async (ctx) => {
  // ctx.messages    — messages non-lus
  // ctx.publish()   — publier sur un topic
  // ctx.subscribe() — s'abonner à un topic
  // ctx.sleep()     — se mettre en veille
  // ctx.callLLM()   — appeler un LLM
  // ctx.callTool()  — appeler un service MCP
  // ctx.state       — état local persistant entre itérations

  for (const msg of ctx.messages) {
    ctx.publish("output.topic", {
      type: "text",
      criticality: 0,
      payload: { content: `Processed: ${JSON.stringify(msg.payload)}` },
    });
  }
};
```

**`package.json`**
```json
{
  "name": "@brain/node-my-node",
  "version": "0.1.0",
  "private": true,
  "main": "dist/handler.js",
  "scripts": { "build": "tsc" },
  "dependencies": { "@brain/sdk": "workspace:*" }
}
```

Puis `pnpm install && pnpm build` — le type est automatiquement détecté au démarrage du framework.

---

## Stack

| Couche | Technologie |
|---|---|
| SDK | TypeScript (types purs) |
| Core | TypeScript, pino, eventemitter3, uuid |
| API | NestJS, Socket.IO |
| Dashboard | React 19, React Flow, d3-force, Tailwind v4 |
| Bus | In-memory (Redis pub/sub prévu) |
| Monorepo | pnpm workspaces |
| Lint | ESLint strict (0 any, 0 console, no eslint-disable) |

---

## Lint

ESLint est configuré de manière stricte :

- `no-explicit-any` — zéro any
- `no-console` — error (utiliser pino ou NestJS Logger)
- `noInlineConfig` — interdit les `eslint-disable` dans le code
- `prefer-readonly` — readonly forcé
- `no-non-null-assertion` — pas de `!`
- `consistent-type-imports` — `import type` obligatoire
- `react-hooks/exhaustive-deps` — error
- `explicit-function-return-type` — types de retour explicites

---

## Licence

MIT
