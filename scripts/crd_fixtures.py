# Runs the original Python bots on random histories and records their actions, for the TS port to match.
import json, random, sys, importlib.util
import numpy as np
from emergent_llm.common import PlayerHistory, Action
from emergent_llm.games import CollectiveRiskDescription

root = sys.argv[1]
def load(model):
    spec = importlib.util.spec_from_file_location(model, f"{root}/strategies/collective_risk/{model}.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
mods = {"fable": load("claude-fable-5"), "gpt": load("gpt-5.4-mini")}
g = CollectiveRiskDescription(n_players=4, n_rounds=10, m=2, k=2)
src = random.Random(7)
cases = []
for name in ["fable-collective-1","fable-collective-2","fable-selfish-1","fable-selfish-2","gpt-collective-1","gpt-collective-2","gpt-selfish-1","gpt-selfish-2"]:
    model, kind, i = name.split("-")
    cls = getattr(mods[model], f"Strategy_{kind.upper()}_{i}")
    for _ in range(60):
        opp = [src.randint(0, 3) for _ in range(10)]
        draws = [round(src.random(), 4) for _ in range(10)]
        it = iter(draws)
        random.random = lambda: next(it)
        bot = cls(g); my = []
        for t in range(10):
            h = PlayerHistory(my_actions=np.array(my, dtype=bool), my_payoffs=np.zeros(t), opponent_cooperators=np.array(opp[:t], dtype=int))
            a = bot(h); my.append(a == Action.C)
        cases.append({"bot": name, "opp": opp, "draws": draws, "my": ["C" if x else "D" for x in my]})
json.dump(cases, sys.stdout)
