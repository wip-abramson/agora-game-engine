# agora-game-engine

An agent that plays games with other agents, starting with tic-tac-toe. It speaks
A2A, and it negotiates compact message protocols using the
[Agora](https://arxiv.org/abs/2410.11905) meta-protocol. Every match can be watched
live on the web. It is meant to run on Cloudflare.

Status: **v0**, plain-language play over A2A with a live spectator view, local only. No Agora yet
(that is v1). Read [ARCHITECTURE.md](./ARCHITECTURE.md).

## Prerequisites

- Node.js 22 or later (required by Wrangler)
- An [OpenRouter](https://openrouter.ai) API key for the house player's LLM
- For the spike only: [uv](https://docs.astral.sh/uv/) and Python 3.12

## Run v0 locally

```bash
npm install
echo 'OPENROUTER_API_KEY=sk-or-...' > .dev.vars   # gitignored; the house player's LLM
npm test                                         # engine rules
npm run dev                                      # http://localhost:8787
node scripts/play.mjs                            # plays one match over A2A and prints the spectator URL
```

- `/.well-known/agent-card.json`: the A2A v0.3 agent card. `POST /a2a`: JSON-RPC `message/send`. One `contextId` is one match.
- `/`: the live match list. `/matches/:id`: the live board and message stream (read-only WebSockets).
- `src/engine.ts` is the referee, `src/brain.ts` is the LLM player (OpenRouter, model in `wrangler.jsonc`), `src/index.ts` holds the Worker, the `Match` and `Lobby` agents, and A2A.

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY   # paste the key when prompted
npx wrangler deploy                          # prints the workers.dev URL
node scripts/play.mjs https://<your-worker>.workers.dev
```

Anyone can call `/a2a` and each move costs LLM tokens, so set a spending limit on the
OpenRouter key.

## Spike

`spike/` is the experiment that showed the Agora Python SDK working end to end, from
plain language to a negotiated protocol to generated routines.

```bash
uv venv -p 3.12 venv && VIRTUAL_ENV=$PWD/venv uv pip install agora-protocol langchain-openai
export OPENROUTER_API_KEY=...        # or source it from a file
mkdir run && cd run
../venv/bin/python ../spike/spike.py qwen/qwen3-235b-a22b-2507 deepseek/deepseek-v4-flash 8
../venv/bin/python ../spike/render.py .   # writes agora-run.html
```

`spike/sample-run/` holds the log, the protocol stores and the rendered page from the
2 Nov 2026 run.

## Licence

Apache-2.0. See [LICENSE](./LICENSE).
