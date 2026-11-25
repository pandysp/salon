// Shell-side room socket, modelled on the bake-off
// room-client.js: reconnects every 500 ms, queues sends while closed; the server re-sends history on every (re)connect.
export function connectRoom(path, { onMessage, onStatus }) {
  let ws, closed = false;
  const queue = [];
  const open = () => {
    onStatus("connecting");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
    ws.onopen = () => { onStatus("connected"); while (queue.length) ws.send(queue.shift()); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => { onStatus("closed"); if (!closed) setTimeout(open, 500); };
  };
  open();
  return {
    send(msg) { const s = JSON.stringify(msg); if (ws.readyState === WebSocket.OPEN) ws.send(s); else queue.push(s); },
    close() { closed = true; ws.close(); },
  };
}
