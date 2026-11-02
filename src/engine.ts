// Tic-tac-toe rules. The referee: pure, no I/O. Cells are 1-9, row by row.
export type Mark = "X" | "O";
export type Board = (Mark | null)[]; // length 9, index = cell - 1
export type Result = Mark | "draw" | null;

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export const empty = (): Board => Array(9).fill(null);

// X always moves first.
export const toMove = (b: Board): Mark => (b.filter(Boolean).length % 2 === 0 ? "X" : "O");

export const legalMoves = (b: Board): number[] =>
  b.flatMap((c, i) => (c ? [] : [i + 1]));

export function result(b: Board): Result {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? "draw" : null;
}

// Returns an error message, or null if the move is legal.
export function checkMove(b: Board, cell: unknown, mark: Mark): string | null {
  if (result(b)) return "the game is over";
  if (mark !== toMove(b)) return `it is ${toMove(b)}'s turn`;
  if (!Number.isInteger(cell) || (cell as number) < 1 || (cell as number) > 9) return "cells are numbered 1 to 9";
  if (b[(cell as number) - 1]) return `cell ${cell} is taken`;
  return null;
}

export function play(b: Board, cell: number, mark: Mark): Board {
  const err = checkMove(b, cell, mark);
  if (err) throw new Error(err);
  const next = [...b];
  next[cell - 1] = mark;
  return next;
}

// Empty cells show their number, so a reader can name a move.
export const render = (b: Board): string =>
  [0, 3, 6].map((r) => b.slice(r, r + 3).map((c, i) => c ?? String(r + i + 1)).join(" | ")).join("\n---------\n");
