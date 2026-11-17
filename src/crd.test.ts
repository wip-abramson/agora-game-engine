import { expect, test } from "vitest";
import { BOTS, baselines, botMove, drawBots, history, metrics, parseMove, payoff, rng, simulate, type Cell } from "./crd";
// Actions of the original Python bots on random histories (scripts/crd_fixtures.py).
import fixtures from "./crd.fixtures.json";

test("the TypeScript bots match the Python originals move for move", () => {
  for (const { bot, opp, draws, my } of fixtures as { bot: string; opp: number[]; draws: number[]; my: string[] }[]) {
    const draw = draws[Symbol.iterator]();
    const play = BOTS[bot].make(() => draw.next().value!);
    const got: string[] = [];
    for (let t = 0; t < 10; t++) got.push(play({ t, my: got.map((a) => a === "C"), opp: opp.slice(0, t) }));
    expect(got, `${bot} on opp=${opp}`).toEqual(my);
  }
});

test("payoffs: D pays 1, C pays 0, plus k when at least m cooperate; a timeout pays 0", () => {
  const rd: Cell[] = ["C", "C", "D", null];
  expect([0, 1, 2, 3].map((s) => payoff(rd, s))).toEqual([2, 2, 3, 0]);
  const miss: Cell[] = ["C", "D", "D", null];
  expect([0, 1, 2, 3].map((s) => payoff(miss, s))).toEqual([0, 1, 1, 0]);
});

test("metrics: payoff, hit-rate and share of the group's cooperation", () => {
  const moves: Cell[][] = [["C", "C", "D", "D"], ["D", "D", "C", "C"], [null, "C", "D", "D"]];
  expect(metrics(moves, 0)).toEqual({ payoff: 2 + 3 + 0, hitRate: 2 / 3, burden: 1 / 5 });
  expect(metrics([["D", "D", "D", "D"]], 0).burden).toBeNull();
});

test("bot replay is deterministic for a seed", () => {
  const moves: Cell[][] = [["C", "D", "C", "D"], ["D", "D", "D", "D"]];
  for (const b of Object.keys(BOTS)) expect(botMove(b, 42, moves, 1)).toBe(botMove(b, 42, moves, 1));
  expect(simulate("fable-collective-1", 5)).toEqual(simulate("fable-collective-1", 5));
  expect(new Set(drawBots(rng(1))).size).toBe(3);
});

test("collective house bots reach the threshold more often than selfish ones", () => {
  const b = baselines(40);
  expect(b.collective.hitRate).toBeGreaterThan(b.selfish.hitRate);
  expect(b.collective.burden!).toBeGreaterThan(b.selfish.burden!);
});

test("moves are read strictly", () => {
  expect(parseMove("C")).toBe("C");
  expect(parseMove(" defect. ")).toBe("D");
  expect(parseMove("I'll weigh it up...\n<action>C</action>")).toBe("C");
  expect(parseMove("I will cooperate rather than defect")).toBeNull();
  expect(parseMove("CD")).toBeNull();
});

test("history table", () => {
  expect(history([], 0)).toMatch(/No rounds/);
  expect(history([[null, "C", "C", "D"]], 0)).toContain("| 1 | none (timed out) | 2 | 0 |");
});
