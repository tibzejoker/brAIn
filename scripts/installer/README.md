# create-brain

One-command bootstrap for a [brAIn](https://github.com/tibzejoker/brAIn) dev workspace.

```bash
npm create brain
# or:
npx create-brain
```

Lays out:

```
brain/                     # default folder name (override: `npm create brain my-folder`)
├── brAIn/                 # framework — git clone tibzejoker/brAIn
├── brAIn-store/           # marketplace registry — git clone tibzejoker/brAIn-store
└── storeprojects/         # empty — populated at runtime by `pnpm brain pull <name>`
```

Then runs `pnpm install` inside `brAIn/` (downloads the bundled
`nats-server` Go binary, builds `@brain/sdk`, `@brain/core`,
`@brain/agent`), and **launches `pnpm start`**. One command, end-to-end.

API on http://localhost:3000, Dashboard on http://localhost:5173.
First boot takes ~1 min — the auto-seed clones a few sister repos.

## Options

| Flag | Default | What it does |
|---|---|---|
| `--no-start` | launches | Stop after install — don't auto-launch |
| `--no-install` | install runs | Skip `pnpm install` (implies `--no-start`) |
| `-h`, `--help` | — | Show help |

## Re-launching later

```bash
cd brain/brAIn
./run            # unix
run.cmd          # windows
```

## Requirements

- **Node 20+** — same engines field as the framework itself
- **git** — for the two clones
- **pnpm** — auto-bootstrapped via `corepack` if missing

## License

MIT — Copyright © 2026 Thibaut Léaux.
