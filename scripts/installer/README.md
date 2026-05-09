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

Then runs `pnpm install` inside `brAIn/`, which downloads the bundled
`nats-server` Go binary for your platform and builds `@brain/sdk`,
`@brain/core`, and `@brain/agent`.

## Next steps

```bash
cd brain/brAIn
./run            # unix
run.cmd          # windows
```

API on http://localhost:3000, Dashboard on http://localhost:5173.

## Options

| Flag | Default | What it does |
|---|---|---|
| `--no-install` | install runs | Skip the final `pnpm install` |
| `-h`, `--help` | — | Show help |

## Requirements

- **Node 20+** — same engines field as the framework itself
- **git** — for the two clones
- **pnpm** — auto-bootstrapped via `corepack` if missing

## License

MIT — Copyright © 2026 Thibaut Léaux.
