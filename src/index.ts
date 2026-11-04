import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext } from "agents";
import { chooseMove, parseMove, type Usage } from "./brain";
import { empty, legalMoves, play, render, result, checkMove, type Board, type Mark, type Result } from "./engine";

type Env = {
  Match: DurableObjectNamespace<Match>;
  Lobby: DurableObjectNamespace<Lobby>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  MODEL: string;
};

// Every entry is shown to spectators as text. kind is always "natural language" in v0;
// v1 adds "negotiation" and "protocol".
type Entry = {
  at: string;
  from: "opponent" | "house" | "referee";
  kind: "natural language";
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

type Summary = Pick<MatchState, "id" | "result" | "model" | "costUsd" | "updatedAt"> & { moves: number };

const MAX_TEXT = 500;
const MAX_LOG = 100; // ponytail: hard cap per match; a real game needs ~30 entries
const HOUSE_TRIES = 2;
const now = () => new Date().toISOString();

export class Match extends Agent<Env, MatchState> {
  initialState: MatchState = {
    id: "", board: empty(), result: null, opponent: "X", house: "O", model: "", log: [], costUsd: 0, lastCell: null, updatedAt: "",
  };
  private busy = false; // in memory: a second message while we wait on the LLM is refused

  // All WebSocket clients are spectators. Moves arrive only by RPC from the Worker.
  shouldConnectionBeReadonly(_c: Connection, _ctx: ConnectionContext) {
    return true;
  }

  private push(e: Omit<Entry, "at" | "kind">) {
    const s = this.state;
    const log = [...s.log, { at: now(), kind: "natural language" as const, ...e }].slice(-MAX_LOG);
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

  async handle(text: string): Promise<string> {
    if (this.busy) return "I'm still thinking about the last message. Send your move again in a moment.";
    this.busy = true;
    try {
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
    } catch (e) {
      console.error(`match ${this.name}:`, e);
      this.push({ from: "referee", text: "The house player could not respond. Try the move again." });
      throw e;
    } finally {
      this.busy = false;
      await this.report();
    }
  }

  // The LLM gets HOUSE_TRIES attempts at a legal move, then a random legal move is played.
  private async houseTurn(): Promise<string> {
    const { house } = this.state;
    for (let i = 0; i < HOUSE_TRIES; i++) {
      const c = await chooseMove(this.env, this.state.board, house);
      const err = checkMove(this.state.board, c.cell, house);
      if (!err) {
        this.push({ from: "house", text: c.say || `I take cell ${c.cell}.`, cell: c.cell!, llm: c.usage });
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

const rpcError = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function agentCard(origin: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Agora game engine",
    description: "Plays tic-tac-toe with other agents, in plain language. Every match can be watched live.",
    url: `${origin}/a2a`,
    preferredTransport: "JSONRPC",
    version: "0.0.1",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{
      id: "tic-tac-toe",
      name: "Tic-tac-toe",
      description: "Play a game. You are X and go first. Name a cell 1-9 (row by row from the top left) or describe it, e.g. 'the centre'. One A2A contextId is one match.",
      tags: ["game", "tic-tac-toe"],
      examples: ["Fancy a game of tic-tac-toe?", "I'll take the centre", "top right"],
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
  if (!text) return rpcError(body.id, -32602, "Invalid params: message needs a text part");
  const contextId: string = msg.contextId ?? crypto.randomUUID();
  if (!/^[\w-]{1,64}$/.test(contextId)) return rpcError(body.id, -32602, "Invalid params: contextId must be 1-64 of [A-Za-z0-9_-]");

  const match = await getAgentByName(env.Match, contextId);
  let reply: string;
  try {
    reply = await match.handle(text);
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
      parts: [{ kind: "text", text: reply }],
      metadata: { spectate: `${new URL(req.url).origin}/matches/${contextId}` },
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/agent-card.json") return Response.json(agentCard(url.origin));
    if (url.pathname === "/a2a" && req.method === "POST") return a2a(req, env);
    if (url.pathname.startsWith("/matches/")) return env.ASSETS.fetch(new URL("/match", url));
    // Only spectator WebSockets reach the agents directly; they are read-only.
    if (url.pathname.startsWith("/agents/") && req.headers.get("upgrade") === "websocket")
      return (await routeAgentRequest(req, env)) ?? new Response("Not found", { status: 404 });
    return new Response("Not found", { status: 404 });
  },
};
