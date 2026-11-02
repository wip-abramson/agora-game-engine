// Plays one full match against the agent over A2A, as a plain-language opponent.
// Usage: node scripts/play.mjs [baseUrl] [matchId]
const base = process.argv[2] ?? "http://localhost:8787";
const contextId = process.argv[3] ?? `demo-${Date.now()}`;
const say = {
  5: "I'll take the centre", 1: "top left please", 9: "bottom right corner", 3: "the top right square",
  7: "bottom left", 2: "top middle", 4: "middle left", 6: "middle right", 8: "bottom middle",
};

async function send(text) {
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send",
      params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), contextId, parts: [{ kind: "text", text }] } },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result.parts[0].text;
}

console.log(`Spectate: ${base}/matches/${contextId}\n`);
let reply = await send("Fancy a game of tic-tac-toe?");
console.log(`> Fancy a game of tic-tac-toe?\n${reply}\n`);
for (const cell of Object.keys(say)) {
  if (/again|finished/.test(reply)) break;
  // Only name cells the board still shows as free (empty cells are shown as their number).
  if (!new RegExp(`(^|[ |])${cell}([ |]|$)`, "m").test(reply)) continue;
  reply = await send(say[cell]);
  console.log(`> ${say[cell]}\n${reply}\n`);
}
