import { expect, test } from "vitest";
import { checkMove, empty, legalMoves, play, render, result, toMove, type Board } from "./engine";

const board = (s: string): Board => [...s].map((c) => (c === "." ? null : (c as "X" | "O")));

test("X moves first, then O", () => {
  expect(toMove(empty())).toBe("X");
  expect(toMove(play(empty(), 5, "X"))).toBe("O");
});

test("rejects illegal moves", () => {
  const b = play(empty(), 5, "X");
  expect(checkMove(b, 5, "O")).toMatch(/taken/);
  expect(checkMove(b, 1, "X")).toMatch(/O's turn/);
  expect(checkMove(b, 0, "O")).toMatch(/1 to 9/);
  expect(checkMove(b, 10, "O")).toMatch(/1 to 9/);
  expect(checkMove(b, 2.5, "O")).toMatch(/1 to 9/);
  expect(checkMove(b, "3", "O")).toMatch(/1 to 9/);
  expect(() => play(b, 5, "O")).toThrow();
  expect(checkMove(b, 1, "O")).toBeNull();
});

test("detects rows, columns, diagonals", () => {
  expect(result(board("XXXOO...."))).toBe("X");
  expect(result(board("OXXOX.O.."))).toBe("O");
  expect(result(board("X.O.XO..X"))).toBe("X");
  expect(result(board("XXO.O.O.X"))).toBe("O");
});

test("detects a draw and an unfinished game", () => {
  expect(result(board("XOXXOOOXX"))).toBe("draw");
  expect(result(board("XO......."))).toBeNull();
});

test("no moves after the game ends", () => {
  const won = board("XXXOO....");
  expect(checkMove(won, 6, "O")).toMatch(/over/);
});

test("legal moves and rendering", () => {
  const b = board("X...O....");
  expect(legalMoves(b)).toEqual([2, 3, 4, 6, 7, 8, 9]);
  expect(render(b)).toBe("X | 2 | 3\n---------\n4 | O | 6\n---------\n7 | 8 | 9");
});
