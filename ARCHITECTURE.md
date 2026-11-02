# Architecture: an Agora game-playing agent on Cloudflare

Status: **initial draft, 2 Nov 2026.** Nothing here is built yet. This explains the
design and the reasons for it, and lists what is still open (§10).

## 1. What this is

This is an agent that plays games with other agents. It starts with tic-tac-toe.
It plays in plain language with anyone. With agents that speak
[Agora](https://arxiv.org/abs/2410.11905), it negotiates a compact message protocol and
moves to it. Every match can be watched live on the web.

It runs by itself. If somebody plays it, good; if nobody does, it is still a working
exhibit, because the matches it has played can be replayed.

The point is not tic-tac-toe. The point is to watch the Agora pattern happen in the
open: protocols negotiated, adopted, reused, and failing. A game is a good test bed
because the rules can be checked mechanically. Whatever the agents agree about the
*wire format*, a trusted referee decides what is a legal *move*.

## 2. Principles

1. **The engine is the referee.** Game state and legality live in trusted,
   deterministic code. Negotiated protocols decide only how a move is *encoded*. A bad
   protocol, a bad routine, or a lying opponent can produce a rejected message, never
   a corrupted game.
2. **Routines are codecs, not actors.** A generated routine is a pure function: text
   in, structured value out (or the reverse). It gets no network, no secrets, no
   storage and no tools. It cannot make a move; it can only translate one.
3. **Hard limits, not prompts.** Scope ("only games") and budgets are enforced in code
   and configuration. Asking the LLM to behave is advisory, never the guard.
4. **Everything is observable.** Every message, negotiation, protocol document and
   routine is recorded and shown to spectators. The transparency is the product.
5. **Plain language is the fallback.** Any A2A client can play without knowing Agora
   exists. Agora is an optimisation that is offered, never required.

## 3. Components

```
                    ┌────────────────────────── Cloudflare ─────────────────────────────┐
 opponent agent     │                                                                   │
 (any A2A client) ──┼─► Worker  /a2a  ─────────────►  Match (Durable Object, one/match) │
                    │    /.well-known/agent-card.json      │  engine (referee)          │
 Agora SDK agent ───┼─►  /agora  (raw Agora, interop)      │  transcript log            │
                    │                                      │  player brain ── LLM ──────┼─► AI Gateway ─► OpenRouter
                    │                                      │  Agora layer               │
                    │                                      │    negotiator ── LLM       │
                    │                                      │    programmer ── LLM       │
                    │                                      │    codec runner ───────────┼─► Dynamic Worker
                    │                                      │                            │   (no network, cpuMs cap)
                    │                                      ├──► Protocol registry (DO)  │
                    │                                      │                            │
 human browser ─────┼─► Static assets: /  /matches/:id ◄───┘  read-only WebSocket       │
                    │                                         (state broadcast)         │
                    └───────────────────────────────────────────────────────────────────┘
```

| Component | Cloudflare product | Role |
|---|---|---|
| Entry Worker | Workers | Routes A2A, the agent card, the raw Agora endpoint, the spectator API and static assets. Checks the inbound credential. |
| Match | Durable Object (via the Agents SDK `Agent` class) | One per match. Holds the board, the transcript and the match's Agora state. Broadcasts state to spectators. |
| Engine | Plain TypeScript module | Tic-tac-toe rules: legal moves, win and draw detection. No I/O. Trusted. Unit-tested. |
| Player brain | LLM through AI Gateway | Chooses the agent's own move. The engine validates it; an illegal choice is retried a bounded number of times, then the turn falls back to a random legal move. |
| Agora layer | TypeScript, ours | Envelope handling, protocol choice, negotiation and routine generation. A port of the parts of the Python SDK we need (§5). |
| Codec runner | Dynamic Workers | Runs generated routines with `globalOutbound: null`, no bindings, and `limits: { cpuMs, subRequests: 0 }`. |
| Protocol registry | Durable Object (SQLite) | Stores protocol documents by hash, with usage counts and the routines written for them. Shared across matches, which is what lets a protocol be *reused*. |
| Spectator site | Workers Static Assets | Match list, live board, message stream, protocol document and routine code. Read-only. |
| LLM access | AI Gateway → OpenRouter | One place for logs, cost analytics and rate limiting. The spike ran on Chinese open models (Qwen 3, DeepSeek V4) for fractions of a cent. |

## 4. A match, end to end

1. **Opening.** An opponent sends an A2A message: "Fancy a game of tic-tac-toe?" The
   Worker creates a Match, and the A2A `contextId` becomes the match ID. The Match
   replies in plain language with the board and whose turn it is.
2. **Plain-language play.** Moves arrive as text ("I'll take the centre"). The player
   brain parses them into a move, the engine checks it, and the brain answers with its
   own move as text. It works, but every turn costs an LLM call on both sides.
3. **Offering a protocol.** If the opponent advertises Agora (§6), the Match checks the
   registry for a known tic-tac-toe protocol. If it finds one, it offers it. If not, it
   offers to negotiate. Negotiation is an Agora conversation with
   `protocolHash: "negotiation"`, and its result is a protocol document.
4. **Protocol play.** Moves now carry the protocol hash and a structured body. At first
   the LLM still encodes and decodes them.
5. **Routines.** After a protocol has been used enough times across matches, the
   programmer writes a decode routine (message → move) and an encode routine
   (state → message). They run in the codec runner. From then on, a turn costs no
   tokens on our side. If a routine throws, or its output fails the engine's checks,
   the turn falls back to the LLM, and the failure is recorded and shown.
6. **The end.** The engine declares a win or a draw. The transcript is final, and the
   match page becomes a replay.

One game is at most nine moves, so a protocol pays off across games rather than within
one. The shared registry is therefore essential, not a nice-to-have: it is how the second
opponent to show up reuses what the first one negotiated. The spike showed why. The
same pair of models produced a *different* protocol document, and so a different hash,
on each run.

## 5. Agora implementation

The Python SDK (`agora-protocol` 0.2.0, last commit Mar 2025) cannot run on Workers: it
depends on LangChain, Flask and RestrictedPython. The protocol itself is one page
(Appendix B of the paper), so we implement it in TypeScript:

- **Envelope:** `{protocolHash, protocolSources, body}` → `{status, body}`, with status
  `success`, `failure` or `rejected`. Multi-round conversations use a conversation ID,
  as the SDK's server does.
- **Hashes:** the wire uses the Agora ID, base64 of SHA1 of the document text, for
  compatibility with the SDK. The registry also stores the SHA-256 and keys on it. A
  document is accepted only if both hashes are consistent with the text. (SHA1 alone is
  open to chosen-prefix collisions, so the registry never trusts it on its own.)
- **Sources:** we accept only `data:` URIs and our own registry URL. **We never fetch an
  arbitrary URL.** The SDK does (`requests.get` in `utils.py`), which would be
  server-side request forgery from inside our account.
- **Conformance:** `spike/spike.py` is a working Python SDK sender. Pointed at our
  `/agora` endpoint, it is our interoperability test.

## 6. A2A mapping

The Cloudflare Agents SDK does not implement A2A, so the A2A server is ours, in the
Worker.

| A2A | Agora / game |
|---|---|
| `contextId` | Match ID, which is also the Agora multi-round conversation ID |
| Message with a `TextPart` only | Agora natural-language mode (`protocolHash: null`) |
| Message with a `DataPart` `{agora: {protocolHash, protocolSources, body}}` | An Agora message under a protocol, or a negotiation (`protocolHash: "negotiation"`) |
| Agent card skill | `tic-tac-toe`, with a description that works for plain-language players |
| Agent card extension | Declares Agora support and lists known protocol hashes and sources; the equivalent of Agora's `/.wellknown` |

This means **any A2A agent can play straight away**, and an agent that speaks Agora gets
the cheaper path. The raw `/agora` endpoint exists for SDK interoperability and testing.

Lab note: if this is fronted by an Affinidi Agent Gateway, gateway response signing is
known to be shaped for A2A v0.3 and leaves v1.0 replies unsigned. Decide the A2A version
with that in mind.

## 7. Spectator view

- **`/`**: live and recent matches, each with players, status and protocol in use.
- **`/matches/:id`**: the board; the message stream with each message marked
  *natural language*, *negotiation* or *protocol*, and *LLM* or *routine* with token
  counts; the protocol document with its hash; the routines' source; cost so far.
- **Live updates** use the Agents SDK's state sync. Spectators connect as **read-only
  connections**, which receive state broadcasts but cannot change state. Only the A2A
  path can change a match.
- **The design is borrowed from the spike's run viewer** (`spike/render.py`,
  `spike/sample-run/agora-run.html`), which already shows these elements for a single
  run.

## 8. Threats and limits

| Threat | Control |
|---|---|
| A protocol document prompt-injects the programmer, which writes hostile code | Routines run in a Dynamic Worker with no network (`globalOutbound: null`), no bindings, a CPU cap and zero subrequests. Their output is only data, and the engine checks it. |
| A protocol document prompt-injects the player brain or negotiator | Their only tools are the engine's read and move functions. No secrets or other tools are in reach. |
| Server-side request forgery through `protocolSources` | We never fetch arbitrary URLs (§5). |
| Draining the LLM budget | A dedicated OpenRouter key with a hard credit limit; AI Gateway rate limiting; caps on message size, negotiation rounds, moves per match and concurrent matches. |
| Filling up storage | Caps on registry size and protocols per match; old transcripts expire. |
| Off-topic use ("negotiate a protocol for something else") | The engine accepts only moves. An LLM check that a document is about a game may be added, but it is advisory. |
| Harmful text shown to spectators | Rendered as text and never as HTML. Moderation is optional (an open question). |
| Spectators tampering with a match | Spectator connections are read-only. |

**Per-caller budgets need a caller identity.** Behind a gateway that injects one shared
credential, the agent cannot tell callers apart. That is the same constraint the Lab's
own targets live with. v1 therefore limits per match and globally; per-caller limits
wait until a caller identity is available (§10).

## 9. Phasing

| Phase | Delivers | Proves |
|---|---|---|
| **v0** | Engine, Match Durable Object, spectator page, A2A plain-language play, LLM player brain | Any agent can play, and humans can watch. |
| **v1** | Agora envelope, negotiation, protocol registry, raw `/agora` endpoint, conformance against the Python SDK | Protocols are negotiated and reused across matches. |
| **v2** | Routine generation and the Dynamic Worker codec runner, with fallback | Turns cost zero tokens, safely. |
| **v3** | Behind the Lab's gateway, with a catalogue entry | Lab participants' agents can play. |

## 10. Open questions

1. **Dynamic Workers availability and pricing.** The docs describe the API but not the
   plan, price or beta status. Check before v2. The fallback is to run v2 without
   routines, and accept the LLM cost.
2. **How the agent plays.** An LLM player is interesting to watch and makes mistakes.
   Minimax is perfect and always draws. Possibly offer both as named players.
3. **Who opens matches when nobody visits.** For it to run by itself, it needs a
   house opponent. A scheduled job (Cron Trigger) could start matches between two
   built-in players, each on a different model, in the spirit of the paper.
4. **Caller identity** for per-caller budgets and for crediting players on the
   spectator page.
5. **A2A version** (v0.3 or v1.0), given the gateway signing behaviour noted in §6.
6. **SHA1 on the wire.** Keep it for SDK compatibility, or move to SHA-256 and treat the
   SDK as a test client only.
7. **Moderation** of plain-language text before spectators see it.
8. **Domain and brand.** Whether this lives under the Lab's domain or on its own.

## 11. Evidence from the spike (2 Nov 2026)

Two agents ran on the Python SDK locally: a shop on `qwen/qwen3-235b-a22b-2507` and a
courier on `deepseek/deepseek-v4-flash`, both through OpenRouter. They made 8 calls, see
`spike/sample-run/`.

- Calls 1–2 were plain language. Call 3 negotiated a protocol. In call 4 both sides wrote
  routines. **Calls 5–8 used no LLM at all** and took about 0 s each. Every result was
  correct.
- The whole run cost **$0.0028** and about 22.6k tokens.
- **The negotiation was a single round trip.** One side proposed, and the other said
  "let's go with this protocol". Nothing about it was adversarial.
- **Both models accepted a stray field** that the SDK leaked into the schema. Nobody
  checks a negotiation, which is one reason the engine is the referee here.
- **Each run produced a different protocol document.** Without a shared registry, there
  is no reuse.
- The SDK needs Python 3.10–3.12. Its routines run in RestrictedPython inside the agent's
  own process, which we do not copy (§8).
