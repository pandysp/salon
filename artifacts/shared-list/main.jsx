// Shared team checklist on the room op log.
// Ported to the artifact SDK: the room comes from
// window.artifact.room (artifact-sdk.js, same shape as the bake-off room-client) instead of connect(room); the <form> became
// a button + Enter key (the iframe sandbox blocks form submission); a version label (__LABEL__, set at bundle time) and the
// viewer's name were added to the header. Everything else is the bake-off code.
// Ops sent to the room: {type:"add",id,title} {type:"set-done",id,done} {type:"edit",id,title} {type:"delete",id}
// Every tab folds history + live ops in seq order into one store, so all tabs converge.
import { createSignal, createStore, createMemo, reconcile, For, Show } from "solid-js";
import { render } from "@solidjs/web";
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

function applyOp(items, m) {
  if (m.type === "add") {
    if (typeof m.id !== "string" || items.some((i) => i.id === m.id)) return;
    items.push({ id: m.id, title: String(m.title ?? ""), done: false });
    return;
  }
  const idx = items.findIndex((i) => i.id === m.id);
  if (idx < 0) return;
  if (m.type === "set-done") items[idx].done = !!m.done;
  else if (m.type === "edit") items[idx].title = String(m.title ?? "");
  else if (m.type === "delete") items.splice(idx, 1);
}

function App() {
  const [status, setStatus] = createSignal("connecting");
  const [filter, setFilter] = createSignal("all");
  const [state, setState] = createStore({ items: [] });
  const conn = window.artifact.room;
  const [who, setWho] = createSignal("");
  window.artifact.ready.then((a) => setWho(a.viewer.name ?? a.viewer.id));
  conn.onStatus(setStatus);
  conn.onMessage((m) => {
    if (m.type === "history") {
      const folded = [];
      for (const op of m.messages) applyOp(folded, op);
      setState((s) => { reconcile(folded, "id")(s.items); });
    } else {
      setState((s) => { applyOp(s.items, m); });
    }
  });

  const counts = createMemo(() => {
    let done = 0;
    for (const i of state.items) if (i.done) done++;
    return { active: state.items.length - done, done };
  });
  const visible = createMemo(() => {
    const f = filter();
    return f === "all" ? state.items : state.items.filter((i) => (f === "done" ? i.done : !i.done));
  });

  let input;
  const add = () => {
    const title = input.value.trim();
    if (!title) return;
    conn.send({ type: "add", id: newId(), title });
    input.value = "";
    input.focus();
  };

  return (
    <main class="app">
      <header>
        <h1>Team checklist</h1>
        <span class="room" data-testid="app-version">{__LABEL__}</span>
        <span class="room" data-testid="app-viewer">{who()}</span>
        <span class="status" data-status={status()} data-testid="status">{status()}</span>
      </header>
      <div class="new">
        <input ref={(el) => (input = el)} data-testid="new-item-input" placeholder="What needs doing?" autocomplete="off"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" data-testid="add-item" onClick={add}>Add</button>
      </div>
      <nav class="bar">
        <div class="filters">
          {["all", "active", "done"].map((f) => (
            <button type="button" data-testid={`filter-${f}`} class={filter() === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div class="counts">
          <span><b data-testid="count-active">{counts().active}</b> active</span>
          <span><b data-testid="count-done">{counts().done}</b> done</span>
        </div>
      </nav>
      <Show when={state.items.length === 0}>
        <p class="empty" data-testid="empty-state">Nothing here yet. Add the first item above.</p>
      </Show>
      <ul class="list">
        <For each={visible()}>{(item) => <Row item={item} send={conn.send} />}</For>
      </ul>
    </main>
  );
}

function Row(props) {
  const [editing, setEditing] = createSignal(false);
  const item = props.item;
  const save = (el) => {
    const title = el.value.trim();
    if (title && title !== item.title) props.send({ type: "edit", id: item.id, title });
    setEditing(false);
  };
  return (
    <li class={item.done ? "row done" : "row"} data-testid="item">
      <input
        type="checkbox"
        data-testid="item-toggle"
        checked={item.done}
        onChange={(e) => {
          const want = e.currentTarget.checked;
          e.currentTarget.checked = item.done; // stay controlled: the room echo decides
          props.send({ type: "set-done", id: item.id, done: want });
        }}
      />
      <span class="title" data-testid="item-title">{item.title}</span>
      <Show
        when={editing()}
        fallback={<button type="button" class="ghost" data-testid="item-edit" onClick={() => setEditing(true)}>Edit</button>}
      >
        <input
          class="edit"
          data-testid="item-edit-input"
          ref={(el) => { el.value = item.title; setTimeout(() => { el.focus(); el.select(); }); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); save(e.currentTarget); }
            else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
        />
      </Show>
      <button type="button" class="ghost danger" data-testid="item-delete" onClick={() => props.send({ type: "delete", id: item.id })}>Delete</button>
    </li>
  );
}

render(() => <App />, document.getElementById("root"));
