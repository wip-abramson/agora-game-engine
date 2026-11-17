// Plays one full match against the agent over A2A: opens in plain language, then switches to the
// Agora protocol the agent card advertises (after showing that an unknown protocol is refused).
// Usage: node scripts/play.mjs [baseUrl] [matchId]
const base = process.argv[2] ?? "http://localhost:8787";
const contextId = process.argv[3] ?? `demo-${Date.now()}`;
const order = [5, 1, 9, 3, 7, 2, 4, 6, 8];

async function send(part) {
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: crypto.randomUUID(), method: "message/send",
      params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), contextId, parts: [part] } },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  const p = body.result.parts[0];
  return p.kind === "text" ? p.text : p.data.agora;
}
const say = async (text) => { const r = await send({ kind: "text", text }); console.log(`> ${text}\n${r}\n`); return r; };
const agora = async (protocolHash, protocolSources, body) => {
  const r = await send({ kind: "data", data: { agora: { protocolHash, protocolSources, body } } });
  console.log(`> [${protocolHash}] ${body}\n${JSON.stringify(r)}\n`);
  return r;
};

const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
const proto = card.capabilities.extensions.find((x) => x.uri === "https://agoraprotocol.org").params.protocols[0];
console.log(`Spectate: ${base}/matches/${contextId}\nAdvertised protocol: ${proto.name} ${proto.protocolHash}\n`);

await say("Fancy a game of tic-tac-toe?");
let reply = await say("I'll take the centre");
if (/again|finished/.test(reply)) process.exit(0);

await agora("bm90LWEtcmVhbC1wcm90b2NvbA==", [], JSON.stringify({ cell: 1 })); // refused: unknown hash

// The board in the plain-language reply shows free cells as their numbers.
let free = new Set(order.filter((c) => new RegExp(`(^|[ |])${c}([ |]|$)`, "m").test(reply)));
for (const cell of order) {
  if (!free.has(cell)) continue;
  const r = await agora(proto.protocolHash, proto.protocolSources, JSON.stringify({ cell }));
  const out = JSON.parse(r.body);
  if (out.result) { console.log(`Result: ${out.result}`); break; }
  free = new Set([...out.board].flatMap((c, i) => (c === "." ? [i + 1] : [])));
}
