// The authoring-loop test page: a heading pi is asked to change.
import { render } from "@solidjs/web";
render(() => (
  <main style="font-family: system-ui, sans-serif; padding: 24px">
    <h1 data-testid="heading">Hello World</h1>
    <p data-testid="label">{__LABEL__}</p>
  </main>
), document.getElementById("root"));
