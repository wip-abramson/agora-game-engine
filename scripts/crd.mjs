// Plays one Collective Risk Dilemma match over A2A.
// Usage: node --env-file=.dev.vars scripts/crd.mjs [baseUrl] [--llm] [--model ID] [--prompt "how to play"] [--skip ROUND --wait SECONDS]
//   default: a fixed policy that cooperates on odd rounds (taking turns)
//   --llm:   each round, an LLM (OpenRouter, OPENROUTER_API_KEY) reads the engine's prompt and chooses the move
//   --skip:  stay silent in that round for --wait seconds, to test the deadline
const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:8787";
const llm = args.includes("--llm");
const model = opt("--model") ?? "qwen/qwen3-235b-a22b-2507";
const style = opt("--prompt") ?? "You are an agent playing a repeated game. Play well.";
const skip = Number(opt("--skip")), wait = Number(opt("--wait") ?? 0);
const contextId = `crd-${llm ? "llm" : "demo"}-${Date.now()}`;

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

// One stateless call per round: the engine's prompt already carries the rules and the full history.
async function ask(prompt) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set (run with --env-file=.dev.vars)");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "system", content: style }, { role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

let reply = await send("Let's play the collective risk dilemma");
console.log(`${reply.split("\n")[0]}\n${llm ? `Player: ${model}\n` : ""}`);
for (let tries = 0; !/match is over/.test(reply) && tries < 30; tries++) {
  const round = Number(reply.match(/This is round (\d+)/)[1]);
  if (round === skip) {
    console.log(`(staying silent in round ${round} for ${wait}s)\n`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const move = llm ? await ask(reply) : round % 2 ? "C" : "D";
  const shown = llm ? (move.match(/<action>\s*[CD]\s*<\/action>/i)?.[0] ?? move.trim().slice(-80)) : move;
  reply = await send(move);
  console.log(`> round ${round}: ${shown}\n${reply.split("\n\nCOLLECTIVE")[0]}\n`);
}
