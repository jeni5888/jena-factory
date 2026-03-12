# JenaAI-Factory

Futuristic mission control dashboard for Ralph autonomous runs. Dark sci-fi aesthetic with real-time monitoring.

## Quick Start

```bash
bun run server.ts --project-dir /path/to/project
# Open http://localhost:4242
```

## Features

- **Epic Cards** — Horizontal grid with progress bars, costs, status badges (SHIP/WIP/BLOCKED)
- **Live Tool Feed** — Real-time streaming of tool calls (Bash, Edit, Read, Grep...) with icons
- **Subagent Tracker** — Running/completed subagents with token usage and duration
- **Token/Cost Panel** — Total, per-run, per-iteration costs with cache hit rate bar
- **Tool Distribution** — Horizontal bar chart of tool usage frequency
- **Model Breakdown** — Per-model token stats (input/output/cache)
- **Elapsed Timer** — Live HH:MM:SS ticker since run start
- **Iteration Timeline** — Reverse-chronological with verdicts (SHIP/REWORK/BLOCKED) and costs
- **Task Detail** — Click epics to see tasks with status, evidence (commits/tests/PRs)
- **Run History** — Past runs with iteration count, verdict, cost
- **Error Feed** — Permission denials, rate limits, failures
- **Global Progress** — Top progress bar with task completion percentage
- **SSE Live Updates** — 2s polling with incremental tool feed updates
- **Zero Dependencies** — Bun-native, no npm install needed

## API

| Route | Description |
|-------|-------------|
| `GET /` | Dashboard |
| `GET /api/epics` | Epics with task counts |
| `GET /api/tasks/:epicId` | Tasks with state/evidence |
| `GET /api/runs` | All runs (newest first) |
| `GET /api/runs/:runId` | Run detail with iterations |
| `GET /api/runs/:runId/tools` | Tool usage aggregation |
| `GET /api/runs/:runId/agents` | Subagent history |
| `GET /api/live` | Active iteration deep parse (tools, agents, tokens) |
| `GET /api/tokens` | Aggregated costs with model breakdown |
| `GET /api/status` | Active run status |
| `GET /api/events` | SSE stream |

## Install

```bash
./install.sh --project-dir /path/to/project
jena-factory
```

## Requirements

- [Bun](https://bun.sh) >= 1.0
- A project with `.flow/` and `scripts/ralph/runs/`
