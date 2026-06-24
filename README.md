# Diário Oficial do Recife

A CrewAI monorepo that ingests the *Diário Oficial do Recife* (DO) into a vector
store and answers questions over it via a chat UI. It's a [uv workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/):
the CrewAI projects live under `crews/` and share one lockfile/virtualenv, while
the Flask UI in `frontend/` is a standalone app deployed separately.

## Layout

```
crews/
  do_recife_embedder/    Flow: PDFs -> chunks -> embeddings -> MongoDB Atlas vector store
  do_recife_chat_crew/   Crew: researcher (vector search) + reporter, sequential RAG
  do_recife_chat_flow/   Flow: conversational RAG with @persist(); deployed to CrewAI AMP
frontend/                Standalone Flask + SSE chat UI for the AMP-deployed flow
bin/start                Runs the frontend behind an ngrok tunnel (local dev)
```

The data pipeline: `do_recife_embedder` populates the MongoDB Atlas collection
(`do-recife`), and both `do_recife_chat_crew` and `do_recife_chat_flow` query it
with `text-embedding-3-large` vectors to ground their answers.

## Prerequisites

- Python 3.13.12 (see `.python-version`)
- [uv](https://docs.astral.sh/uv/)
- A MongoDB Atlas cluster with a vector index, plus OpenAI and Anthropic API keys
- [ngrok](https://ngrok.com/) (only for running the frontend locally)

## Setup

```bash
cp .env.example .env        # fill in the keys below
uv sync --all-packages      # install every crew into the shared .venv
```

Root `.env` (used by the crews):

| Key | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | LLM for the chat agents |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-large`) |
| `MONGODB_CONNECTION_STRING` | Atlas cluster holding the DO vector store |
| `CREWAI_TRACING_ENABLED` | Dev tracing toggle |

## Running the crews

Each crew is a workspace member. Invoke them by **module path** (`python -m`),
which targets a specific crew unambiguously:

```bash
# Embed PDFs placed in crews/do_recife_embedder/src/do_recife_embedder/data/
uv run --package do_recife_embedder python -m do_recife_embedder.main

# One-shot RAG answer from the crew
uv run --package do_recife_chat_crew python -m do_recife_chat_crew.main

# Run the conversational flow locally
uv run --package do_recife_chat_flow python -m do_recife_chat_flow.main
```

> Note: avoid the bare console scripts (`kickoff`, `run_crew`, `plot`, ...) from
> the repo root. All three crews define those same names, so in the shared
> workspace venv they collide and resolve to a single crew. The `python -m`
> form above is collision-proof; or run a crew from inside its own folder.

VS Code debug configs for each crew live in `.vscode/launch.json`.

## Frontend + AMP

The UI in `frontend/` is a thin Flask + SSE client; the real work runs in
`do_recife_chat_flow` deployed on CrewAI AMP. Deploy the flow, then point the UI
at it:

```bash
cd crews/do_recife_chat_flow && crewai deploy create   # one-time
cp frontend/ui_do_recife/.env.example frontend/ui_do_recife/.env   # fill in AMP creds
bin/start                                              # Flask + ngrok tunnel
```

See [frontend/ui_do_recife/README.md](frontend/ui_do_recife/README.md) for the
full communication model (kickoff, realtime webhooks, SSE) and Heroku deploy.
