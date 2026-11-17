// The one Agora protocol the house knows: a tic-tac-toe move as JSON. Decoded with no LLM.
// Agora identifies a protocol by base64(sha1(document)); the caller names it in protocolHash.
import { checkMove, type Board, type Result } from "./engine";

export const DOC = `---
name: tic-tac-toe-move
description: Play one tic-tac-toe move against the Agora game engine and get the house's reply.
multiround: false
---
# Tic-tac-toe move

The caller plays X and moves first. One A2A contextId is one match.

## Request (body)
A JSON object: {"cell": n}, where n is an integer 1-9, numbered row by row from the top left.

## Response (body)
A JSON object:
- "status": "ok" (move accepted), "invalid" (move refused; see "error") or "over" (the game had already ended).
- "cell": the house's reply move (1-9), or null if the house did not move.
- "board": 9 characters, row by row: "X", "O" or "." for empty.
- "result": "X", "O", "draw" or null while the game is still on.
- "error": a reason, only when status is "invalid".
`;

// Recomputed from DOC in protocol.test.ts, so an edit to DOC that forgets this fails the tests.
export const HASH = "2OSWoPpTzeB+J1xTS34Gizd8Bqk=";
export const PATH = "/protocols/tic-tac-toe-move.md";

export type Reply = { status: "ok" | "invalid" | "over"; cell: number | null; board: string; result: Result; error?: string };

export const boardString = (b: Board) => b.map((c) => c ?? ".").join("");

// Returns the requested cell, or an error for the caller.
export function decode(body: unknown, b: Board, mark: "X" | "O"): { cell: number } | { error: string } {
  let cell: unknown;
  try {
    cell = typeof body === "string" ? JSON.parse(body)?.cell : undefined;
  } catch {
    return { error: "body is not JSON" };
  }
  const err = checkMove(b, cell, mark);
  return err ? { error: err } : { cell: cell as number };
}
