import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext } from "agents";
import { chooseMove, parseMove, type Usage } from "./brain";
import { baselines, botMove, cooperators, drawBots, G, history, hit, metrics, parseMove as parseCrdMove, payoff, position, rng, RULES, type Baselines, type Cell, type Metrics } from "./crd";
import { empty, legalMoves, play, render, result, checkMove, type Board, type Mark, type Result } from "./engine";
import * as ttt from "./protocol";

type Env = {
  Match: DurableObjectNamespace<Match>;
  Lobby: DurableObjectNamespace<Lobby>;
  Crd: DurableObjectNamespace<Crd>;
  CRD_ROUND_SECONDS?: string;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  MODEL: string;
};

// Every entry is shown to spectators as text. "protocol" marks a turn sent as an Agora protocol message.
type Entry = {
  at: string;
  from: "opponent" | "house" | "referee";
  kind: "natural language" | "protocol";
  text: string;
  cell?: number;
  llm?: Usage;
};

type MatchState = {
  id: string;
  board: Board;
  result: Result;
  opponent: Mark; // the A2A caller
  house: Mark;
  model: string;
  log: Entry[];
  costUsd: number;
  lastCell: number | null;
  updatedAt: string;
};

type Summary = Pick<MatchState, "id" | "result" | "model" | "costUsd" | "updatedAt"> & { moves: number; game?: "crd"; note?: string };

const MAX_TEXT = 500;
const MAX_LOG = 100; // ponytail: hard cap per match; a real game needs ~30 entries
const HOUSE_TRIES = 2;
const now = () => new Date().toISOString();

export class Match extends Agent<Env, MatchState> {
  initialState: MatchState = {
    id: "", board: empty(), result: null, opponent: "X", house: "O", model: "", log: [], costUsd: 0, lastCell: null, updatedAt: "",
  };
  private busy = false; // in memory: a second message while we wait on the LLM is refused
  private kind: Entry["kind"] = "natural language"; // of the turn being handled

  // All WebSocket clients are spectators. Moves arrive only by RPC from the Worker.
  shouldConnectionBeReadonly(_c: Connection, _ctx: ConnectionContext) {
    return true;
  }

  private push(e: Omit<Entry, "at" | "kind">) {
    const s = this.state;
    const log = [...s.log, { at: now(), kind: this.kind, ...e }].slice(-MAX_LOG);
    this.setState({ ...s, id: this.name, model: this.env.MODEL, log, costUsd: s.costUsd + (e.llm?.costUsd ?? 0), updatedAt: now() });
  }

  private move(cell: number, mark: Mark) {
    const board = play(this.state.board, cell, mark);
    this.setState({ ...this.state, board, result: result(board), lastCell: cell });
  }

  private status(): string {
    const { result: r, house } = this.state;
    if (r === "draw") return "It's a draw. Use a new contextId to play again.";
    if (r) return `${r === house ? "I win" : "You win"}! Use a new contextId to play again.`;
    return `You are ${this.state.opponent}. Your move: name a cell (1-9).`;
  }

  private reply(lead: string) {
    return `${lead}\n\n${render(this.state.board)}\n\n${this.status()}`.trim();
  }

  // One turn at a time; every turn ends with a lobby report.
  private async turn<T>(kind: Entry["kind"], busy: T, fn: () => Promise<T>): Promise<T> {
    if (this.busy) return busy;
    this.busy = true;
    this.kind = kind;
    try {
      return await fn();
    } catch (e) {
      console.error(`match ${this.name}:`, e);
      this.push({ from: "referee", text: "The house player could not respond. Try the move again." });
      throw e;
    } finally {
      this.busy = false;
      await this.report();
    }
  }

  handle(text: string): Promise<string> {
    return this.turn("natural language", "I'm still thinking about the last message. Send your move again in a moment.", async () => {
      text = text.slice(0, MAX_TEXT);
      if (this.state.result) return this.reply("This game is finished.");
      this.push({ from: "opponent", text });

      const parsed = await parseMove(this.env, this.state.board, this.state.opponent, text);
      if (parsed.cell === null) {
        this.push({ from: "referee", text: "No move found in the message.", llm: parsed.usage });
        return this.reply("Let's play tic-tac-toe. You go first.");
      }
      const err = checkMove(this.state.board, parsed.cell, this.state.opponent);
      if (err) {
        this.push({ from: "referee", text: `Rejected cell ${parsed.cell}: ${err}.`, cell: parsed.cell, llm: parsed.usage });
        return this.reply(`I can't accept cell ${parsed.cell}: ${err}.`);
      }
      this.push({ from: "referee", text: `Opponent takes cell ${parsed.cell}.`, cell: parsed.cell, llm: parsed.usage });
      this.move(parsed.cell, this.state.opponent);
      if (this.state.result) return this.reply("");

      return this.reply(await this.houseTurn());
    });
  }

  // An Agora protocol message: {protocolHash, protocolSources, body} in, {status, body} out.
  // The house knows one protocol and never negotiates; any other hash is refused.
  handleProtocol(hash: unknown, body: unknown): Promise<{ status: string; body: string }> {
    return this.turn("protocol", { status: "error", body: "Busy with the last message. Send it again in a moment." }, async () => {
      const text = (typeof body === "string" ? body : JSON.stringify(body) ?? "").slice(0, MAX_TEXT);
      this.push({ from: "opponent", text });
      if (hash !== ttt.HASH) {
        this.push({ from: "referee", text: `Refused protocol ${String(hash).slice(0, 64)}: not one the house knows.` });
        return { status: "rejected", body: `Unknown protocol. This engine accepts ${ttt.HASH} (${ttt.PATH}).` };
      }
      const switched = `Opponent switched to Agora protocol tic-tac-toe-move (${ttt.HASH}).`;
      if (!this.state.log.some((e) => e.text === switched)) this.push({ from: "referee", text: switched });

      const out = (status: ttt.Reply["status"], cell: number | null, error?: string) => ({
        status: "success",
        body: JSON.stringify({ status, cell, board: ttt.boardString(this.state.board), result: this.state.result, ...(error && { error }) }),
      });
      if (this.state.result) return out("over", null);
      const d = ttt.decode(text, this.state.board, this.state.opponent);
      if ("error" in d) {
        this.push({ from: "referee", text: `Rejected: ${d.error}.` });
        return out("invalid", null, d.error);
      }
      this.push({ from: "referee", text: `Opponent takes cell ${d.cell}.`, cell: d.cell });
      this.move(d.cell, this.state.opponent);
      if (this.state.result) return out("ok", null);
      await this.houseTurn();
      return out("ok", this.state.lastCell);
    });
  }

  // The LLM gets HOUSE_TRIES attempts at a legal move, then a random legal move is played.
  private async houseTurn(): Promise<string> {
    const { house } = this.state;
    for (let i = 0; i < HOUSE_TRIES; i++) {
      const c = await chooseMove(this.env, this.state.board, house);
      const err = checkMove(this.state.board, c.cell, house);
      if (!err) {
        const said = this.kind === "protocol" ? JSON.stringify({ cell: c.cell }) : c.say || `I take cell ${c.cell}.`;
        this.push({ from: "house", text: said, cell: c.cell!, llm: c.usage });
        this.move(c.cell!, house);
        return `${c.say} (I take cell ${c.cell}.)`.trim();
      }
      this.push({ from: "referee", text: `House tried cell ${c.cell}: ${err}.`, llm: c.usage });
    }
    const moves = legalMoves(this.state.board);
    const cell = moves[Math.floor(Math.random() * moves.length)];
    this.push({ from: "referee", text: `House fell back to a random legal move: cell ${cell}.`, cell });
    this.move(cell, house);
    return `I take cell ${cell}.`;
  }

  private async report() {
    if (!this.state.id) return;
    const { id, result: r, model, costUsd, updatedAt, board } = this.state;
    const lobby = await getAgentByName(this.env.Lobby, "main");
    await lobby.upsert({ id, result: r, model, costUsd, updatedAt, moves: board.filter(Boolean).length });
  }
}

// ---- Collective Risk Dilemma: one A2A caller plus three house bots, anonymous ----

type CrdState = {
  id: string;
  game: "crd";
  moves: Cell[][]; // completed rounds; seat 0 is the A2A caller
  seats: string[]; // house bot names stay hidden until the match ends
  deadline: string | null;
  done: boolean;
  log: { at: string; from: "agent" | "referee"; text: string }[];
  result: { you: Metrics; baselines: Baselines } | null;
  seen: number; // rounds the caller had been told about at its last reply
  updatedAt: string;
};

const HIDDEN = ["you", "house", "house", "house"];

export class Crd extends Agent<Env, CrdState> {
  initialState: CrdState = {
    id: "", game: "crd", moves: [], seats: HIDDEN, deadline: null, done: false, log: [], result: null, seen: 0, updatedAt: "",
  };

  shouldConnectionBeReadonly() {
    return true;
  }

  active() {
    return !!this.state.id;
  }

  // Kept out of state: state is broadcast to spectators, and a player could read its opponents from it.
  private async secret() {
    return (await this.ctx.storage.get<{ bots: string[]; seeds: number[] }>("secret"))!;
  }

  private push(from: "agent" | "referee", text: string, patch: Partial<CrdState> = {}) {
    const log = [...this.state.log, { at: now(), from, text: text.slice(0, MAX_TEXT) }].slice(-MAX_LOG);
    this.setState({ ...this.state, ...patch, log, updatedAt: now() });
  }

  private async start() {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const rand = rng(seed);
    const bots = drawBots(rand);
    await this.ctx.storage.put("secret", { bots, seeds: bots.map(() => Math.floor(rand() * 2 ** 32)) });
    this.setState({ ...this.initialState, id: this.name });
    await this.armDeadline();
  }

  private async armDeadline() {
    const secs = Number(this.env.CRD_ROUND_SECONDS ?? 120);
    this.setState({ ...this.state, deadline: new Date(Date.now() + secs * 1000).toISOString() });
    await this.schedule(secs, "expire", { round: this.state.moves.length });
  }

  // Plays the round with the caller's move (null = timed out) and the bots' moves.
  private async resolve(move: Cell) {
    const { bots, seeds } = await this.secret();
    const moves = this.state.moves;
    const round = [move, ...bots.map((b, i) => botMove(b, seeds[i], moves, i + 1))];
    const all = [...moves, round];
    this.setState({ ...this.state, moves: all });
    this.push("referee", this.roundLine(all.length - 1));
    if (all.length < G.rounds) return this.armDeadline();
    this.setState({ ...this.state, done: true, deadline: null, seats: ["you", ...bots], result: { you: metrics(all, 0), baselines: baselines() } });
  }

  private roundLine(t: number) {
    const rd = this.state.moves[t];
    const met = hit(rd) ? "threshold met" : "threshold missed";
    return `Round ${t + 1}: you ${rd[0] ?? "timed out"}, ${cooperators(rd)} of ${G.n} cooperated, ${met}. You scored ${payoff(rd, 0)}.`;
  }

  async expire({ round }: { round: number }) {
    if (this.state.done || this.state.moves.length !== round) return; // the caller answered in time
    await this.resolve(null);
    await this.report();
  }

  private prompt(lead: string) {
    const { moves } = this.state;
    this.setState({ ...this.state, seen: moves.length });
    return `${lead}\n\n${RULES}\n\nYour history:\n${history(moves, 0)}\n\n${position(moves.length)} ` +
      `Reply with C or D, or end your reply with <action>C</action> or <action>D</action>. ` +
      `Deadline: ${this.state.deadline}.`;
  }

  private summary(spectate: string) {
    const { you, baselines: b } = this.state.result!;
    const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
    return `The match is over.\n\n${history(this.state.moves, 0)}\n\n` +
      `Your payoff: ${you.payoff} (house collective bots average ${b.collective.payoff.toFixed(1)}, selfish ${b.selfish.payoff.toFixed(1)}).\n` +
      `Group threshold hit-rate: ${pct(you.hitRate)} (collective ${pct(b.collective.hitRate)}, selfish ${pct(b.selfish.hitRate)}).\n` +
      `Your share of the group's cooperation: ${pct(you.burden)} (fair is ${pct(1 / G.n)}; collective ${pct(b.collective.burden)}, selfish ${pct(b.selfish.burden)}).\n` +
      `You played against: ${this.state.seats.slice(1).join(", ")}.\nFull match: ${spectate}\nUse a new contextId to play again.`;
  }

  async handle(text: string, spectate: string): Promise<string> {
    try {
      if (!this.state.id) {
        await this.start();
        this.push("agent", text);
        return this.prompt(`Welcome to the Collective Risk Dilemma. You are playing ${G.n - 1} house bots. Watch live: ${spectate}`);
      }
      if (this.state.done) return this.summary(spectate);
      this.push("agent", text);
      const move = parseCrdMove(text);
      if (!move) return this.prompt("I couldn't read a move. Reply with just C or D.");
      await this.resolve(move);
      if (this.state.done) return this.summary(spectate);
      // Every round resolved since the last reply, including any that timed out.
      const lead = this.state.moves.map((_, t) => this.roundLine(t)).slice(this.state.seen).join("\n");
      return this.prompt(lead);
    } finally {
      await this.report();
    }
  }

  private async report() {
    const { id, moves, done, updatedAt, result } = this.state;
    if (!id) return;
    const lobby = await getAgentByName(this.env.Lobby, "main");
    await lobby.upsert({
      id, game: "crd", result: null, model: "house bots", costUsd: 0, updatedAt, moves: moves.length,
      note: done ? `payoff ${result!.you.payoff}` : `round ${moves.length + 1} of ${G.rounds}`,
    });
  }
}

// The match list on the home page.
export class Lobby extends Agent<Env, { matches: Summary[] }> {
  initialState = { matches: [] as Summary[] };
  shouldConnectionBeReadonly() {
    return true;
  }
  upsert(m: Summary) {
    const rest = this.state.matches.filter((x) => x.id !== m.id);
    this.setState({ matches: [m, ...rest].slice(0, 50) });
  }
}

// ---- A2A v0.3, JSON-RPC over HTTP, message/send only ----

const CRD_START = /collective[ -]?risk|\bcrd\b/i;

const rpcError = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function agentCard(origin: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Agora game engine",
    description: "Plays tic-tac-toe and the Collective Risk Dilemma with other agents, in plain language. Every match can be watched live.",
    url: `${origin}/a2a`,
    preferredTransport: "JSONRPC",
    version: "0.0.1",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      // Agora: send a DataPart {agora: {protocolHash, protocolSources, body}} instead of text to use a protocol.
      extensions: [{
        uri: "https://agoraprotocol.org",
        description: "Agora protocols this engine accepts in place of plain language. Reply is a DataPart {agora: {status, body}}.",
        required: false,
        params: { protocols: [{ name: "tic-tac-toe-move", skill: "tic-tac-toe", protocolHash: ttt.HASH, protocolSources: [`${origin}${ttt.PATH}`] }] },
      }],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [{
      id: "tic-tac-toe",
      name: "Tic-tac-toe",
      description: "Play a game. You are X and go first. Name a cell 1-9 (row by row from the top left) or describe it, e.g. 'the centre'. One A2A contextId is one match.",
      tags: ["game", "tic-tac-toe"],
      examples: ["Fancy a game of tic-tac-toe?", "I'll take the centre", "top right"],
    }, {
      id: "collective-risk",
      name: "Collective Risk Dilemma",
      description: "A 10-round, 4-player game against 3 house bots. Each round, reply C (cooperate) or D (defect); if at least 2 of 4 cooperate, everyone gains. Start with a message that names the game. One A2A contextId is one match; each reply carries the next round's prompt.",
      tags: ["game", "social-dilemma", "cooperation"],
      examples: ["Let's play the collective risk dilemma", "C", "D"],
    }],
  };
}

async function a2a(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(body?.id, -32600, "Invalid request");
  if (body.method !== "message/send") return rpcError(body.id, -32601, `Method not found: ${body.method}`);

  const msg = body.params?.message;
  const text = Array.isArray(msg?.parts)
    ? msg.parts.filter((p: any) => p?.kind === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n")
    : "";
  const agora = Array.isArray(msg?.parts) ? msg.parts.find((p: any) => p?.kind === "data" && p.data?.agora)?.data.agora : undefined;
  if (!text && !agora) return rpcError(body.id, -32602, "Invalid params: message needs a text part or an Agora data part");
  const contextId: string = msg.contextId ?? crypto.randomUUID();
  if (!/^[\w-]{1,64}$/.test(contextId)) return rpcError(body.id, -32602, "Invalid params: contextId must be 1-64 of [A-Za-z0-9_-]");

  // A context is a CRD match if one is already running under it, or if its first message names the game.
  const origin = new URL(req.url).origin;
  const crd = await getAgentByName(env.Crd, contextId);
  const isCrd = (await crd.active()) || CRD_START.test(text);
  const spectate = `${origin}/${isCrd ? "crd" : "matches"}/${contextId}`;
  let reply: string | { status: string; body: string };
  try {
    if (agora && isCrd) reply = { status: "rejected", body: "This engine has no protocol for the Collective Risk Dilemma; reply in text." };
    else if (agora) reply = await (await getAgentByName(env.Match, contextId)).handleProtocol(agora.protocolHash, agora.body);
    else reply = isCrd ? await crd.handle(text, spectate) : await (await getAgentByName(env.Match, contextId)).handle(text);
  } catch {
    return rpcError(body.id, -32603, "Internal error: the house player could not respond. Try again.");
  }
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result: {
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      contextId,
      parts: [typeof reply === "string" ? { kind: "text", text: reply } : { kind: "data", data: { agora: reply } }],
      metadata: { spectate },
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/agent-card.json") return Response.json(agentCard(url.origin));
    if (url.pathname === "/a2a" && req.method === "POST") return a2a(req, env);
    if (url.pathname === ttt.PATH) return new Response(ttt.DOC, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    if (url.pathname.startsWith("/matches/")) return env.ASSETS.fetch(new URL("/match", url));
    if (url.pathname.startsWith("/crd/")) return env.ASSETS.fetch(new URL("/crd", url));
    // Only spectator WebSockets reach the agents directly; they are read-only.
    if (url.pathname.startsWith("/agents/") && req.headers.get("upgrade") === "websocket")
      return (await routeAgentRequest(req, env)) ?? new Response("Not found", { status: 404 });
    return new Response("Not found", { status: 404 });
  },
};
