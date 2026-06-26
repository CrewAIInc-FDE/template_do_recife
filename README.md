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

Run from anywhere in the repo — `uv run` syncs the shared `.venv` first:

```bash
uv run kickoff_embedder   # embed PDFs
uv run kickoff_crew        # one-shot RAG answer
uv run kickoff_flow        # run the conversational flow locally
```

To target a single crew explicitly (e.g. for its own `plot`/`replay`/`train`),
add `--package`:

```bash
uv run --package do_recife_chat_flow kickoff
```

> Note: avoid the bare colliding scripts (`kickoff`, `run_crew`, `plot`) from
> the repo root — all three crews define those same names. The named
> `kickoff_embedder` / `kickoff_crew` / `kickoff_flow` above are the safe way.

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
