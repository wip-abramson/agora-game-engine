"""Render a spike run (log.jsonl in the given dir) as one static HTML page."""
import base64, hashlib, json, sys
from html import escape as e
from pathlib import Path

run = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
events = [json.loads(l) for l in (run / "log.jsonl").open()]
meta = next(x for x in events if x["kind"] == "meta")
calls = [x for x in events if x["kind"] == "call"]
msgs = [x for x in events if x["kind"] == "message"]
models, prices = meta["models"], meta["prices"]

def cost(who, toks):
    p = prices.get(models[who], {})
    return toks[0] * float(p.get("prompt", 0)) + toks[1] * float(p.get("completion", 0))

PHASE = {"natural-language": ("Natural language", "nl"), "negotiation": ("Negotiation", "neg"),
         "protocol": ("Protocol", "pd")}

def call_phase(c):
    ps = {m["phase"] for m in msgs if m["call"] == c["call"]}
    return "negotiation" if "negotiation" in ps else ("protocol" if "protocol" in ps else "natural-language")

def side(who, toks):
    if toks[0] or toks[1]:
        return f'<span class="by llm">{who}: LLM · {toks[0]:,} in / {toks[1]:,} out</span>'
    return f'<span class="by routine">{who}: routine · 0 tokens</span>'

def body(b):
    if isinstance(b, str):
        try: b = json.loads(b)
        except ValueError: return f"<pre>{e(b)}</pre>"
    return f"<pre>{e(json.dumps(b, indent=2))}</pre>"

# --- protocol document(s) and routines, from the final stores ------------------
final = calls[-1]
protocols = {}
for store, who in ((final["sender_store"], "shop"), (final["receiver_store"], "courier")):
    for h, p in store.items():
        protocols.setdefault(h, {"doc": p["document"], "routines": {}})["routines"][who] = p.get("implementation")

pd_html = ""
for h, p in protocols.items():
    recomputed = base64.b64encode(hashlib.sha1(p["doc"].encode()).digest()).decode()
    check = "matches" if recomputed == h else f"DOES NOT match ({recomputed})"
    routines = "".join(
        f'<div class="routine"><h4>{who}\'s routine <small>written by {e(models[who])}</small></h4>'
        f'<pre class="code">{e(code or "(none written)")}</pre></div>'
        for who, code in p["routines"].items())
    pd_html += f"""
<section class="card">
  <h2>Protocol document</h2>
  <p class="hash">ID <code>{e(h)}</code> · SHA1, base64 · recomputed from the text: <b>{check}</b></p>
  <pre class="doc">{e(p["doc"])}</pre>
  <div class="routines">{routines}</div>
</section>"""

# --- per-call chart --------------------------------------------------------------
peak = max(sum(c["shop_tokens"]) + sum(c["courier_tokens"]) for c in calls) or 1
bars = ""
for c in calls:
    s, k = sum(c["shop_tokens"]), sum(c["courier_tokens"])
    ph = PHASE[call_phase(c)][1]
    bars += (f'<a class="bar" href="#call-{c["call"]}" title="call {c["call"]}: {s + k:,} tokens">'
             f'<span class="stack"><i class="k {ph}" style="height:{k / peak * 100:.1f}%"></i>'
             f'<i class="s {ph}" style="height:{s / peak * 100:.1f}%"></i></span>'
             f'<b>{s + k:,}</b><em>{c["call"]}</em></a>')

# --- timeline --------------------------------------------------------------------
timeline, seen = "", {"shop": set(), "courier": set()}
for c in calls:
    label, cls = PHASE[call_phase(c)]
    ok = c["result"] == {"price_gbp": c["expected"], "eta_minutes": 35}
    notes = ""
    for who, store in (("shop", c["sender_store"]), ("courier", c["receiver_store"])):
        for h, p in store.items():
            for key, text, present in ((f"doc:{h}", "stored protocol", True),
                                       (f"code:{h}", "wrote a routine for protocol", p.get("implementation"))):
                if present and key not in seen[who]:
                    seen[who].add(key)
                    notes += f'<div class="event">{who} {text} <code>{e(h[:10])}…</code></div>'
    bubbles = ""
    for m in (m for m in msgs if m["call"] == c["call"]):
        req, res = m["request"], m["response"]
        ml, mc = PHASE[m["phase"]]
        bubbles += f"""
  <div class="msg out {mc}"><div class="who">shop → courier <span class="tag {mc}">{ml}</span> {side("shop", m["shop_tokens"])}</div>
    {body(req.get("body"))}
    <details><summary>Agora envelope</summary><pre>{e(json.dumps(req, indent=2))}</pre></details></div>
  <div class="msg in {mc}"><div class="who">courier → shop {side("courier", m["courier_tokens"])} <span class="secs">{m["secs"]}s</span></div>
    {body(res.get("body"))}
    <details><summary>Agora envelope</summary><pre>{e(json.dumps(res, indent=2))}</pre></details></div>"""
    t = c["task"]
    timeline += f"""
<section class="call" id="call-{c['call']}">
  <header><span class="n">Call {c['call']}</span><span class="tag {cls}">{label}</span>
    <span class="task">{e(t['pickup'])} → {e(t['dropoff'])}, {t['weight_kg']} kg</span>
    <span class="res {'ok' if ok else 'bad'}">{e(json.dumps(c['result']))} {'✓' if ok else '✗ expected ' + str(c['expected'])}</span>
    <span class="secs">{c['secs']}s · ${cost('shop', c['shop_tokens']) + cost('courier', c['courier_tokens']):.5f}</span></header>
  {bubbles}
  {notes}
</section>"""

tot = {w: [sum(c[f"{w}_tokens"][i] for c in calls) for i in (0, 1)] for w in ("shop", "courier")}
total_cost = cost("shop", tot["shop"]) + cost("courier", tot["courier"])
free = sum(1 for c in calls if not any(c["shop_tokens"] + c["courier_tokens"]))

html = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Agora run — negotiation and execution</title>
<style>
:root {{ --ink:#1d2330; --mute:#6b7383; --line:#e3e6ec; --bg:#f7f8fa;
  --nl:#c9832e; --neg:#7a5cc4; --pd:#2f8f6b; }}
* {{ box-sizing:border-box }} body {{ margin:0; font:15px/1.5 system-ui, sans-serif; color:var(--ink); background:var(--bg) }}
main {{ max-width:1000px; margin:0 auto; padding:32px 20px 80px }}
h1 {{ font-size:26px; margin:0 0 4px }} h2 {{ font-size:18px; margin:0 0 12px }} h4 {{ margin:0 0 6px; font-size:14px }}
small, .sub {{ color:var(--mute); font-weight:400 }}
.stats {{ display:flex; gap:12px; flex-wrap:wrap; margin:20px 0 }}
.stat {{ background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 14px }}
.stat b {{ display:block; font-size:20px }} .stat span {{ color:var(--mute); font-size:13px }}
.card, .call {{ background:#fff; border:1px solid var(--line); border-radius:10px; padding:18px; margin:16px 0 }}
.chart {{ display:flex; gap:10px; align-items:flex-end; height:180px; padding-top:10px }}
.bar {{ flex:1; display:flex; flex-direction:column; align-items:center; text-decoration:none; color:var(--ink); height:100% }}
.stack {{ flex:1; width:100%; display:flex; flex-direction:column; justify-content:flex-end; background:var(--bg); border-radius:4px; overflow:hidden }}
.stack i {{ display:block }} .stack i.s {{ opacity:.55 }}
.nl {{ --c:var(--nl) }} .neg {{ --c:var(--neg) }} .pd {{ --c:var(--pd) }}
.stack i {{ background:var(--c) }}
.bar b {{ font-size:12px; margin-top:4px }} .bar em {{ font-size:12px; color:var(--mute); font-style:normal }}
.legend {{ font-size:13px; color:var(--mute); margin-top:10px }} .legend i {{ display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--c); margin:0 4px 0 12px }}
.tag {{ font-size:12px; font-weight:600; color:#fff; background:var(--c); padding:2px 8px; border-radius:20px; white-space:nowrap }}
.call header {{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px }}
.call .n {{ font-weight:700 }} .task {{ color:var(--mute) }} .secs {{ color:var(--mute); font-size:13px; margin-left:auto }}
.res {{ font-family:ui-monospace, monospace; font-size:13px }} .ok {{ color:var(--pd) }} .bad {{ color:#c0392b }}
.msg {{ border-left:3px solid var(--c); background:var(--bg); border-radius:6px; padding:10px 12px; margin:8px 0; max-width:88% }}
.msg.in {{ margin-left:auto }}
.who {{ font-size:13px; font-weight:600; display:flex; gap:8px; align-items:center; flex-wrap:wrap }}
.by {{ font-weight:400; font-size:12px; padding:1px 6px; border-radius:4px }} .llm {{ background:#fdeee0; color:#8a4b12 }} .routine {{ background:#e0f3ea; color:#1d6b4c }}
pre {{ white-space:pre-wrap; word-break:break-word; font:13px/1.45 ui-monospace, monospace; margin:6px 0 0 }}
details summary {{ cursor:pointer; font-size:12px; color:var(--mute); margin-top:6px }}
.doc {{ background:#fbfaf6; border:1px solid var(--line); border-radius:6px; padding:14px }}
.code {{ background:#1d2330; color:#e6e9ef; border-radius:6px; padding:12px; max-height:420px; overflow:auto }}
.routines {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:16px }}
@media (max-width:760px) {{ .routines {{ grid-template-columns:1fr }} }}
.hash {{ font-size:13px; color:var(--mute) }}
.event {{ font-size:13px; background:#eef0f6; border-radius:6px; padding:6px 10px; margin-top:8px }}
</style></head><body><main>
<h1>Agora run: shop ↔ courier</h1>
<p class="sub">Shop (sender) on <code>{e(models['shop'])}</code> · courier (receiver) on <code>{e(models['courier'])}</code> · agora-protocol SDK, run locally</p>
<div class="stats">
  <div class="stat"><b>{len(calls)}</b><span>calls</span></div>
  <div class="stat"><b>{free}</b><span>calls with no LLM at all</span></div>
  <div class="stat"><b>{sum(tot['shop']) + sum(tot['courier']):,}</b><span>LLM tokens, total</span></div>
  <div class="stat"><b>${total_cost:.4f}</b><span>cost, OpenRouter list price</span></div>
</div>
<section class="card"><h2>LLM tokens per call <small>(darker: courier · lighter: shop)</small></h2>
<div class="chart">{bars}</div>
<div class="legend"><i class="nl"></i>natural language<i class="neg"></i>negotiation<i class="pd"></i>protocol</div></section>
{pd_html}
<h2 style="margin-top:28px">Timeline</h2>
{timeline}
</main></body></html>"""
(run / "agora-run.html").write_text(html)
print(run / "agora-run.html")
