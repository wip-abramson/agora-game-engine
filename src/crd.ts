// Collective Risk Dilemma: rules, house bots, metrics, and the text an agent sees. Pure, no I/O.
// Rules and bots follow emergent_llm (games/collective_risk.py, strategies/collective_risk/*.py).
export type Move = "C" | "D";
export type Cell = Move | null; // null = the player timed out: no contribution, payoff 0
export const G = { n: 4, m: 2, k: 2, rounds: 10 } as const;

export const cooperators = (round: Cell[]) => round.filter((a) => a === "C").length;
export const hit = (round: Cell[]) => cooperators(round) >= G.m;
export const payoff = (round: Cell[], seat: number) =>
  round[seat] === null ? 0 : (round[seat] === "D" ? 1 : 0) + (hit(round) ? G.k : 0);

// ---- House bots. Each is a factory: fresh state per match, called once per round in order. ----

type View = { t: number; my: boolean[]; opp: number[] }; // my[i] = I cooperated, opp[i] = others who cooperated
type Bot = (h: View) => Move;
type Factory = (rand: () => number) => Bot;
const C = "C", D = "D";
const { n, m, k, rounds: r } = G;
const mine = (h: View, i: number) => (h.my.at(i) ? 1 : 0);

// claude-fable-5 COLLECTIVE_1: Threshold-Anchored Conditional Cooperator.
const fableCollective1: Factory = (rand) => {
  let failed = 0, lockdown = false, sinceRestart = 0;
  return ({ t, opp }) => {
    if (t === 0) return C;
    const co = opp.at(-1)!;
    if (co < m - 2) failed++;
    else { failed = 0; lockdown = false; }
    if (t === r - 1) return co >= m - 1 ? C : D;
    if (co >= m + 1) return D;
    if (co >= m - 1) return C;
    if (failed >= 3 && co < m - 2) lockdown = true;
    if (lockdown) {
      if (++sinceRestart >= Math.ceil(r / 4)) { sinceRestart = 0; return C; }
      return D;
    }
    return rand() < (co + 1) / m ? C : D;
  };
};

// claude-fable-5 COLLECTIVE_2: Threshold-Anchored Conditional Cooperator (variant).
const fableCollective2: Factory = (rand) => (h) => {
  const { t, opp, my } = h;
  if (t === 0) return C;
  const o = opp.at(-1)!, myLast = my.at(-1)!;
  const successLast = o + (myLast ? 1 : 0) >= m;
  if (t === r - 1) return m - 2 <= o && o <= m ? C : D;
  let margin = 0;
  for (let i = Math.max(0, t - 3); i < t; i++) if (opp[i] + (my[i] ? 1 : 0) < m) { margin = 1; break; }
  if (t === r - 2) margin = Math.max(margin, 1);
  if (!myLast && !successLast && o >= m - 2) return C;
  if (o >= m + margin) return D;
  if (o >= m - 2) return C;
  if (t >= 3) {
    let allBad = true;
    for (let i = t - 3; i < t; i++) if (opp[i] + (my[i] ? 1 : 0) >= m || opp[i] >= m - 2) { allBad = false; break; }
    if (allBad) return D;
  }
  return rand() < (o + 1) / m ? C : D;
};

// claude-fable-5 SELFISH_1: Pivotal Contributor with Endgame Defection.
const fableSelfish1: Factory = () => {
  let ohat = (n - 1) * (m / n), punishUntil = -1, probed = false, abandoned = false;
  return (h) => {
    const { t, opp, my } = h;
    if (t === 0) return m <= Math.ceil((n + 1) / 2) && k >= 1.5 ? C : D;
    const o = opp.at(-1)!;
    ohat = 0.6 * o + 0.4 * ohat;
    if (o >= m - 2) probed = false;
    if ((m as number) === n) { if (o < n - 1) abandoned = true; return abandoned ? D : C; }
    if (t >= 3 && punishUntil < t) {
      let failed3 = true;
      for (const j of [-1, -2, -3]) if (!(my.at(j) && opp.at(j)! + mine(h, j) < m)) { failed3 = false; break; }
      if (failed3) punishUntil = t + 1;
    }
    if (t <= punishUntil) return D;
    if (t === r - 1) return (o === m - 1 || o === m - 2) && k > 1 ? C : D;
    if (t >= 2 && !my.at(-1) && opp.at(-2)! >= m && o === m - 1) return C;
    if (o >= m) return D;
    if (o >= m - 2) return C;
    if (o === m - 3 && k >= 3 && t < r / 2) return C;
    if (ohat >= m - 2 && k >= 2 && !probed) { probed = true; return C; }
    return D;
  };
};

// claude-fable-5 SELFISH_2: conditional pivotality, endgame defection, exploitation test.
const fableSelfish2: Factory = () => {
  let E: number | null = null, shutdown = false;
  return (h) => {
    const { t, opp, my } = h;
    if (t === 0) return k > 1 && m <= Math.ceil(n / 2) + 1 ? C : D;
    const oPrev = opp.at(-1)!;
    E = E === null ? oPrev : 0.6 * oPrev + 0.4 * E;
    const myPrev = my.at(-1)!;
    const totalPrev = oPrev + (myPrev ? 1 : 0);
    const lastThree = (ok: (tot: number) => boolean) =>
      [1, 2, 3].every((i) => my.at(-i) && ok(opp.at(-i)! + mine(h, -i)));
    if (!shutdown && t >= 3 && lastThree((tot) => tot < m)) shutdown = true;
    if (shutdown) {
      if (oPrev >= m - 1) shutdown = false;
      else return D;
    }
    if (!myPrev && totalPrev === m - 1) return C;
    if (t < r - 1 && t >= 3 && lastThree((tot) => tot >= m + 2)) return D;
    if (t === r - 1) return m - 1 <= E && E < m ? C : D;
    if (E >= m + 0.5) return D;
    if (E >= m - 1.5) return C;
    return D;
  };
};

// gpt-5.4-mini COLLECTIVE_1: cooperate while the group stays near the threshold.
const gptCollective1: Factory = () => {
  let exited = false, failed = 0;
  return ({ t, opp }) => {
    if (t === 0) return C;
    if (exited) return D;
    const last = opp.at(-1) ?? 0;
    if (t === r - 1) {
      if (last + 1 >= m) return C;
      exited = true;
      return D;
    }
    const recent = opp.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg + 1 >= m - 1 || last + 1 >= m) { failed = 0; return C; }
    if (++failed >= 2) { exited = true; return D; }
    return C;
  };
};

// gpt-5.4-mini COLLECTIVE_2: cooperate unless two rounds in a row fall well short.
const gptCollective2: Factory = () => (h) => {
  const { t, opp } = h;
  if (t <= 1) return C;
  const last = opp.at(-1)! + mine(h, -1), prev = opp.at(-2)! + mine(h, -2);
  if (last >= Math.max(0, m - 1)) return C;
  if (last <= Math.max(0, m - 2) && prev <= Math.max(0, m - 2)) return D;
  return C;
};

// gpt-5.4-mini SELFISH_1: always defect.
const gptSelfish1: Factory = () => () => D;

// gpt-5.4-mini SELFISH_2: cooperate only when likely pivotal.
const gptSelfish2: Factory = () => ({ t, opp }) => (t > 0 && opp.at(-1) === m - 1 ? C : D);

export const BOTS: Record<string, { kind: "collective" | "selfish"; make: Factory }> = {
  "fable-collective-1": { kind: "collective", make: fableCollective1 },
  "fable-collective-2": { kind: "collective", make: fableCollective2 },
  "gpt-collective-1": { kind: "collective", make: gptCollective1 },
  "gpt-collective-2": { kind: "collective", make: gptCollective2 },
  "fable-selfish-1": { kind: "selfish", make: fableSelfish1 },
  "fable-selfish-2": { kind: "selfish", make: fableSelfish2 },
  "gpt-selfish-1": { kind: "selfish", make: gptSelfish1 },
  "gpt-selfish-2": { kind: "selfish", make: gptSelfish2 },
};

// Seeded PRNG (mulberry32), so a bot's coin flips can be replayed exactly.
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const view = (moves: Cell[][], seat: number, t: number): View => ({
  t,
  my: moves.slice(0, t).map((rd) => rd[seat] === "C"),
  opp: moves.slice(0, t).map((rd) => cooperators(rd) - (rd[seat] === "C" ? 1 : 0)),
});

// The bot's move for round moves.length. Bots keep state, so it replays the match from round 0
// with the same seed; that keeps the Durable Object state plain JSON.
export function botMove(name: string, seed: number, moves: Cell[][], seat: number): Move {
  const bot = BOTS[name].make(rng(seed));
  let move: Move = D;
  for (let t = 0; t <= moves.length; t++) move = bot(view(moves, seat, t));
  return move;
}

// Three house bots, drawn without replacement.
export function drawBots(rand: () => number): string[] {
  const names = Object.keys(BOTS);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, n - 1);
}

// ---- Metrics for one seat over a match ----

export type Metrics = { payoff: number; hitRate: number; burden: number | null };

export function metrics(moves: Cell[][], seat: number): Metrics {
  const mineC = moves.filter((rd) => rd[seat] === "C").length;
  const allC = moves.reduce((s, rd) => s + cooperators(rd), 0);
  return {
    payoff: moves.reduce((s, rd) => s + payoff(rd, seat), 0),
    hitRate: moves.filter(hit).length / moves.length,
    burden: allC ? mineC / allC : null, // share of the group's cooperation you supplied; fair = 1/n
  };
}

// A whole bot-only match, seat 0 = `first`, the other seats drawn as in a live match.
export function simulate(first: string, seed: number): Cell[][] {
  const rand = rng(seed);
  const seats = [first, ...drawBots(rand)];
  const seeds = seats.map(() => Math.floor(rand() * 2 ** 32));
  const moves: Cell[][] = [];
  while (moves.length < r) moves.push(seats.map((b, i) => botMove(b, seeds[i], moves, i)));
  return moves;
}

// What a collective or a selfish house bot averages in the participant's seat. Fixed seed, so
// the baselines are the same on every request.
export type Baselines = Record<"collective" | "selfish", Metrics>;
let cached: Baselines | null = null;
export function baselines(per = 250): Baselines {
  if (cached && per === 250) return cached;
  const out = {} as Baselines;
  for (const kind of ["collective", "selfish"] as const) {
    const ms = Object.keys(BOTS).filter((b) => BOTS[b].kind === kind)
      .flatMap((b, i) => Array.from({ length: per }, (_, j) => metrics(simulate(b, i * 100003 + j), 0)));
    const avg = (f: (x: Metrics) => number) => ms.reduce((s, x) => s + f(x), 0) / ms.length;
    out[kind] = { payoff: avg((x) => x.payoff), hitRate: avg((x) => x.hitRate), burden: avg((x) => x.burden ?? 0) };
  }
  if (per === 250) cached = out;
  return out;
}

// ---- What the agent sees, and how its reply is read ----

export const RULES =
  `COLLECTIVE RISK DILEMMA. ${n} players, ${r} rounds. Each round every player chooses, at the same time, ` +
  `C (cooperate: contribute your endowment to a shared project) or D (defect: keep it).\n` +
  `- D pays 1. C pays 0.\n` +
  `- If at least ${m} of the ${n} players choose C, every player also gets ${k}.\n` +
  `- A round you do not answer before its deadline pays you 0 and counts as not cooperating.\n` +
  `You are anonymous, and so are the others: you only see how many of the other ${n - 1} cooperated each round.`;

export function history(moves: Cell[][], seat: number): string {
  if (!moves.length) return "No rounds have been played yet.";
  const rows = moves.map((rd, i) => {
    const me = rd[seat] ?? "none (timed out)";
    const others = cooperators(rd) - (rd[seat] === "C" ? 1 : 0);
    return `| ${i + 1} | ${me} | ${others} | ${payoff(rd, seat)} |`;
  });
  return ["| round | my_action | opponent_cooperators | my_payoff |", "|---|---|---|---|", ...rows].join("\n");
}

export function position(t: number): string {
  const left = r - t - 1;
  if (t === r - 1) return `This is round ${r} of ${r}, the final round.`;
  return `This is round ${t + 1} of ${r}. There ${left === 1 ? "is 1 round" : `are ${left} rounds`} remaining after this one.`;
}

// Accepts "C", "D", "cooperate", "defect" as the whole reply, or a trailing <action>C|D</action>.
// Anything else is refused rather than guessed: the referee never infers a move.
export function parseMove(text: string): Move | null {
  const tag = [...text.matchAll(/<action>\s*([CD])\s*<\/action>/gi)].at(-1);
  if (tag) return tag[1].toUpperCase() as Move;
  const word = text.trim().replace(/[.!"'`*]/g, "").toLowerCase();
  if (word === "c" || word === "cooperate") return C;
  if (word === "d" || word === "defect") return D;
  return null;
}
