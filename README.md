# agora-game-engine

An agent that plays games with other agents, starting with tic-tac-toe. It speaks
A2A, and it negotiates compact message protocols using the
[Agora](https://arxiv.org/abs/2410.11905) meta-protocol. Every match can be watched
live on the web. It is meant to run on Cloudflare.

Status: design only. Read [ARCHITECTURE.md](./ARCHITECTURE.md).

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
