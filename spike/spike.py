"""Spike: does the agora-protocol SDK go NL -> negotiated protocol -> routine?

Two agents in one process: a courier (receiver, Flask on :5055) and a shop
(sender). Thresholds are set low so every stage happens within a few calls.
Run from a fresh directory; storage JSON lands in ./.agora/.
"""
import json, sys, threading, time
import agora
import os
from langchain_openai import ChatOpenAI
from langchain_core.callbacks import UsageMetadataCallbackHandler

# Via OpenRouter. Different models per side, as in the paper.
MODELS = {"shop": sys.argv[1] if len(sys.argv) > 1 else "anthropic/claude-sonnet-5.5",
          "courier": sys.argv[2] if len(sys.argv) > 2 else "deepseek/deepseek-v4-pro"}
CALLS = int(sys.argv[3]) if len(sys.argv) > 3 else 8

usage = {"courier": UsageMetadataCallbackHandler(), "shop": UsageMetadataCallbackHandler()}
def toolformer(who):
    return agora.toolformers.LangChainToolformer(
        ChatOpenAI(model=MODELS[who], max_tokens=4096, callbacks=[usage[who]],
                   base_url="https://openrouter.ai/api/v1",
                   api_key=os.environ["OPENROUTER_API_KEY"]))

# --- wire log ------------------------------------------------------------------
# Every Agora message goes through requests.post in the sender's transporter.
import requests, urllib.request
import agora.sender.components.transporter as _tp
LOG = open("log.jsonl", "w")
def log(**e):
    LOG.write(json.dumps({"t": time.time(), **e}, default=str) + "\n"); LOG.flush()
current = {"call": 0}
_last_shop = [None]
_real_post = requests.post
def logged_post(url, json=None, **kw):
    shop_before = snapshot("shop"); courier_before = snapshot("courier")
    composed = [a - b for a, b in zip(shop_before, _last_shop[0] or shop_before)]
    t = time.time()
    r = _real_post(url, json=json, **kw)
    courier_after = snapshot("courier")
    h = json.get("protocolHash") if json else None
    log(kind="message", call=current["call"], url=url, request=json, response=r.json(),
        phase="negotiation" if h == "negotiation" else ("natural-language" if h is None else "protocol"),
        shop_tokens=composed, courier_tokens=[a - b for a, b in zip(courier_after, courier_before)],
        secs=round(time.time() - t, 2))
    _last_shop[0] = snapshot("shop")
    return r
_tp.requests = type("R", (), {"post": staticmethod(logged_post), "delete": staticmethod(requests.delete)})

def snapshot(who):
    u = usage[who].usage_metadata
    return sum(v.get("input_tokens", 0) for v in u.values()), \
           sum(v.get("output_tokens", 0) for v in u.values())

prices = {m["id"]: m["pricing"] for m in json.load(urllib.request.urlopen("https://openrouter.ai/api/v1/models"))["data"]
          if m["id"] in MODELS.values()}
log(kind="meta", models=MODELS, prices=prices)

# --- courier: the receiver ---------------------------------------------------
tool_calls = []
def quote_delivery(pickup: str, dropoff: str, weight_kg: float) -> dict:
    """Quote a courier delivery.

    Args:
        pickup: Pickup address
        dropoff: Drop-off address
        weight_kg: Parcel weight in kilograms

    Returns:
        A dictionary with price_gbp (float) and eta_minutes (int)
    """
    tool_calls.append((pickup, dropoff, weight_kg))
    return {"price_gbp": round(4.5 + 1.2 * weight_kg, 2), "eta_minutes": 35}

receiver = agora.Receiver.make_default(
    toolformer("courier"), tools=[quote_delivery],
    storage_path="./.agora/receiver.json", implementation_threshold=2)
threading.Thread(target=lambda: agora.ReceiverServer(receiver).run(port=5055),
                 daemon=True).start()
time.sleep(2)

# --- shop: the sender ---------------------------------------------------------
sender = agora.Sender.make_default(
    toolformer("shop"), storage_path="./.agora/sender.json",
    protocol_threshold=1, negotiation_threshold=2, implementation_threshold=1)

@sender.task()
def get_delivery_quote(pickup: str, dropoff: str, weight_kg: float) -> dict:
    """
    Get a delivery quote from a courier.

    Parameters:
      pickup: Pickup address
      dropoff: Drop-off address
      weight_kg: Parcel weight in kilograms

    Returns:
      A dictionary with price_gbp (float) and eta_minutes (int)
    """
    pass

def stored(path):
    try: return json.load(open(path))["protocols"]
    except Exception: return {}

jobs = [("1 High St, London", "22 Park Rd, London", w) for w in (1, 2.5, 4, 0.5, 3, 6, 1.5, 2, 5, 7)]
for i, (p, d, w) in enumerate(jobs[:CALLS], 1):
    current["call"] = i; _last_shop[0] = snapshot("shop")
    before = [snapshot("shop"), snapshot("courier")]
    n_tool = len(tool_calls)
    t = time.time()
    try:
        out = get_delivery_quote(p, d, w, target="http://localhost:5055")
    except Exception as e:  # keep going: a failure is a finding
        out = f"ERROR {type(e).__name__}: {e}"
    after = [snapshot("shop"), snapshot("courier")]
    # tokens the shop spent after the last message (e.g. writing its routine, parsing the reply)
    log(kind="call", call=i, task={"pickup": p, "dropoff": d, "weight_kg": w}, result=out,
        expected=round(4.5 + 1.2 * w, 2), tool_called=len(tool_calls) > n_tool,
        shop_tokens=[a - b for a, b in zip(after[0], before[0])],
        courier_tokens=[a - b for a, b in zip(after[1], before[1])], secs=round(time.time() - t, 1),
        sender_store=stored("./.agora/sender.json"), receiver_store=stored("./.agora/receiver.json"))
    llm = {who: (a[0] - b[0], a[1] - b[1]) for who, b, a in zip(("shop", "courier"), before, after)}
    print(json.dumps({"call": i, "weight": w, "result": out, "secs": round(time.time() - t, 1),
                      "tokens_in_out": llm, "tool_called": len(tool_calls) > n_tool}, default=str),
          flush=True)

print("MODELS", json.dumps(MODELS))
print("TOTAL", json.dumps({w: snapshot(w) for w in usage}))
