// Read-only spectator socket for an agent instance. The server marks every connection read-only.
export function spectate(agent, name, onState, statusEl) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const connect = () => {
    const ws = new WebSocket(`${proto}://${location.host}/agents/${agent}/${encodeURIComponent(name)}`);
    ws.onopen = () => { statusEl.textContent = "● live"; statusEl.className = "live"; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "cf_agent_state") onState(m.state);
    };
    ws.onclose = () => { statusEl.textContent = "○ reconnecting"; statusEl.className = "dead"; setTimeout(connect, 2000); };
  };
  connect();
}
export const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
export const usd = (x) => `$${!x ? "0" : x < 0.01 ? x.toPrecision(2) : x.toFixed(4)}`;
export const outcome = (r) => (r === "draw" ? "draw" : r ? `${r} won` : "in play");
