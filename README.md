# JENA-FACTORY

Web-based monitoring dashboard for Flow-Next Ralph runs. Dark mission-control aesthetic.

## Quick Start

```bash
# Local (in a project with .flow/)
bun run server.ts

# With explicit project dir
bun run server.ts --project-dir /path/to/project --port 4242

# Install globally
./install.sh --project-dir /path/to/project
jena-factory
```

Open `http://localhost:4242`

## Features

- **Epic Overview** — Grid of all epics with task progress bars
- **Active Run Monitor** — Current task, iteration, verdict, duration
- **Token Costs** — Per-run, per-epic cost aggregation from Claude CLI result lines
- **Timeline** — Reverse-chronological iteration log
- **Live Updates** — SSE stream with 5s polling, auto-reconnect
- **Zero Dependencies** — Bun-native, no npm install needed

## API

| Route | Description |
|-------|-------------|
| `GET /` | Dashboard |
| `GET /api/epics` | Epics with task counts |
| `GET /api/tasks/:epicId` | Tasks for an epic |
| `GET /api/runs` | All runs (newest first) |
| `GET /api/runs/:runId` | Run detail with iterations |
| `GET /api/tokens` | Aggregated costs |
| `GET /api/status` | Active run status |
| `GET /api/events` | SSE stream |

## Remote Installation (Mac Mini)

```bash
ssh user@host
git clone git@github.com:jeni5888/jena-factory.git
cd jena-factory
./install.sh --project-dir /path/to/project
jena-factory
```

Access from LAN: `http://<host-ip>:4242`

## Requirements

- [Bun](https://bun.sh) >= 1.0
- A project with `.flow/` and `scripts/ralph/runs/`
