# Diário Oficial do Recife - Busca via Chat

> Companion UI to [`do_recife_chat_flow`](../../crews/do_recife_chat_flow/), the CrewAI flow this app drives via AMP.

A thin Flask + Server-Sent-Events (SSE) chat UI for a CrewAI AMP flow (`DoRecifeChatFlow`) that answers questions over the *Diário Oficial do Recife*. Solarized Light theme, pt-BR interface, vanilla JS frontend with live word-by-word streaming and tool-activity indicators.

## How it works

```
Browser ──POST message──► Flask ──POST /kickoff (+webhooks block)──► CrewAI AMP
Browser ◄────SSE──────── Flask ◄──realtime event batches──── AMP (/api/webhook/<channel_id>)
```

- Each **channel** is an independent conversation. The most recent AMP execution id is stored per channel (`last_state_id`).
- On the **first** message in a channel, no restore id is sent. Every kickoff response's `kickoff_id` is saved as `last_state_id`; the **next** message passes it as the top-level `restoreFromStateId` field, then the value is overwritten with the new execution id. This chains conversation memory using the supported `restoreFromStateId` (fork) mechanism — see the [migration guide](https://docs.crewai.com/en/guides/flows/inputs-id-deprecation).
- The kickoff body registers a **per-kickoff realtime webhook** whose URL encodes the channel id (`{PUBLIC_BASE_URL}/api/webhook/<channel_id>`), so events route to the right channel without needing `execution_id` mapping.
- Subscribed events: `flow_started`, `flow_finished`, `llm_stream_chunk`, `tool_usage_started`, `tool_usage_finished`. `llm_stream_chunk` events that carry a `tool_call` (tool-argument fragments) are ignored. The final answer is persisted from the `flow_finished` result.
- **Watchdog fallback:** realtime webhooks have no delivery/ordering guarantee, so the tail of a stream (or even `flow_finished`) can be dropped. After each kickoff a thread watches for webhook silence; if no event arrives for ~10s and the execution isn't done, it polls `GET {DEPLOYMENT_URL}/status/{kickoff_id}` and finalizes from the authoritative result. The webhook `flow_finished` and the watchdog are deduped per kickoff, so whichever lands first wins.

## Requirements

- Python >= 3.13
- [uv](https://docs.astral.sh/uv/)
- [ngrok](https://ngrok.com/) with a reserved domain (default `do-recife.ngrok.app`) so AMP can reach the webhook endpoint
- A deployed `DoRecifeChatFlow` on CrewAI AMP

## Setup

### 0. Deploy the flow to AMP (one-time)

This UI is a thin client; the actual work runs in the `do_recife_chat_flow` flow
on CrewAI AMP. Deploy it from the monorepo, then read its credentials:

```bash
cd crews/do_recife_chat_flow
crewai deploy create     # first time; pushes the flow to AMP
crewai deploy push       # subsequent updates
```

From the AMP dashboard for that deployment, copy:

- the deployment **base URL** → `DEPLOYMENT_URL`
- a **bearer token / API key** → `DEPLOYMENT_KEY`

`WEBHOOK_TOKEN` is a secret you choose: the UI sends it to AMP in the kickoff
`webhooks.authentication` block and then requires AMP to echo it back on each
inbound webhook, so it just has to be a non-empty shared value.

### 1. Configure the UI

1. Copy `.env.example` to `.env` (in this `ui_do_recife/` folder) and fill it in:

   | Key | Purpose |
   | --- | --- |
   | `DEPLOYMENT_URL` | CrewAI AMP deployment base URL |
   | `DEPLOYMENT_KEY` | AMP API key (bearer) used to call `/kickoff` |
   | `WEBHOOK_TOKEN` | Shared secret AMP sends back as the webhook bearer token |
   | `PUBLIC_BASE_URL` | Public URL AMP can reach (the ngrok tunnel), e.g. `https://do-recife.ngrok.app` |
   | `NGROK_DOMAIN` | Reserved ngrok domain used by `bin/start` |
   | `PORT` | Local Flask port (default `5005`) |

2. From the **monorepo root**, start everything (installs the frontend deps into
   an isolated `frontend/.venv`, runs Flask, opens the ngrok tunnel):

   ```bash
   bin/start                         # uses NGROK_DOMAIN / PORT from .env
   bin/start --ngrok-domain my.ngrok.app --port 5005   # or override
   ```

3. Open `http://localhost:5005` (or `https://do-recife.ngrok.app`), create a conversation, and start asking questions.

### Running Flask only (no tunnel)

```bash
uv sync --project frontend
uv run --project frontend python frontend/ui_do_recife/app.py
```

Without a public tunnel, AMP cannot deliver webhook events, so streaming/responses will not appear.

## Deploy to Heroku (via git subtree)

The UI is self-contained in `frontend/` (its own `pyproject.toml` / `uv.lock`, excluded from the uv workspace — no CrewAI deps). The monorepo root is reserved for the crews/AMP, so **only the `frontend/` subtree is deployed** using the official `heroku/python` buildpack plus `git subtree` (no third-party buildpacks). The buildpack installs from `frontend/uv.lock` and `Procfile` serves the app with gunicorn — no ngrok needed in prod, the public dyno URL is the webhook target.

Run all commands from the **monorepo root**.

```bash
# 1) One-time: point a `heroku` git remote at your app.
#    If the app ALREADY exists in your account (the common case):
heroku git:remote -a <your-ui-app>
#    Only if you need to create a brand-new app (requires a verified
#    Heroku account, i.e. payment info on file):
# heroku create <your-ui-app>

# 2) One-time: buildpack + config vars.
heroku buildpacks:set heroku/python -a <your-ui-app>
heroku config:set -a <your-ui-app> \
  DEPLOYMENT_URL=... DEPLOYMENT_KEY=... WEBHOOK_TOKEN=...

# 3) Deploy the frontend/ subdirectory (commit your changes first).
git subtree push --prefix frontend heroku main
# If rejected (non-fast-forward), force-push the split:
git push heroku "$(git subtree split --prefix frontend main)":refs/heads/main --force
```

> The `heroku git:remote` step is the one that's easy to miss: without it,
> `git subtree push ... heroku` fails with
> `fatal: 'heroku' does not appear to be a git repository` because no `heroku`
> remote exists yet (only `origin`). `heroku create` would add it
> automatically, but if you skipped `create` (existing app) or it errored, run
> `heroku git:remote -a <your-ui-app>` to attach it.

- **Keep `web` at a single dyno** (`heroku ps:scale web=1`). SSE subscribers, the status watchdog, and in-flight response state live in-process, so multiple workers/dynos break streaming. The `Procfile` already pins `--workers 1` and uses threaded workers for concurrent SSE connections.
- `PORT` is injected by Heroku — don't set it; `NGROK_DOMAIN` is unused in prod.
- `PUBLIC_BASE_URL` is **optional**: when unset, the webhook callback URL is derived per-request from the incoming host (`ProxyFix` honors Heroku's `X-Forwarded-Proto`/`Host`), so AMP webhooks just work on the dyno's `*.herokuapp.com` URL. Set it only behind a custom domain.
- SQLite lives on the dyno's **ephemeral** disk and resets on every restart/redeploy — fine for a demo, not durable storage.

## Project layout

```
app.py              Flask server: pages, channel API, kickoff, SSE, webhook receiver
db/__init__.py      SQLite layer (channels + messages, last_state_id chaining)
templates/index.html
static/css/style.css   Solarized Light theme
static/js/app.js       Frontend: SSE handling, streaming renderer, tool activity
static/img/            logo.png (horizontal), logo_mark.jpg (crest), tool.svg
bin/start              Launches Flask + ngrok (local dev)
Procfile               Heroku web process (gunicorn, single worker)
app.json               Heroku config-var manifest / one-click deploy
```
