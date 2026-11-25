// The stage-demo poll (R11): every browser's last vote
// counts (by its server-stamped `from`); vote buttons only while artifact.viewer.canWrite.
import { createSignal, For, Show } from "solid-js";
import { render } from "@solidjs/web";
const art = window.artifact, OPTIONS = ["yes", "no"];
function App() {
  const [votes, setVotes] = createSignal({}), [canWrite, setCanWrite] = createSignal(null);
  art.ready.then((a) => setCanWrite(a.viewer.canWrite));
  art.room.onMessage((m) => {
    if (m.type === "history") { const v = {}; for (const x of m.messages) if (x.type === "vote") v[x.from] = x.option; setVotes(v); }
    else if (m.type === "vote") setVotes((v) => ({ ...v, [m.from]: m.option }));
  });
  const tally = (o) => Object.values(votes()).filter((x) => x === o).length;
  return (
    <main style="font-family: system-ui, sans-serif; padding: 24px">
      <p data-testid="can-write">{String(canWrite())}</p>
      <For each={OPTIONS}>{(o) => (
        <p>{o}: <b data-testid={`tally-${o}`}>{tally(o)}</b>{" "}
          <Show when={canWrite()}><button type="button" data-testid={`vote-${o}`} onClick={() => art.room.send({ type: "vote", option: o })}>vote {o}</button></Show>
        </p>
      )}</For>
    </main>
  );
}
render(() => <App />, document.getElementById("root"));
