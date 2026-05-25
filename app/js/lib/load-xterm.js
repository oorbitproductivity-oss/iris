// app/js/lib/load-xterm.js
//
// Renderer-side dynamic loader for xterm.js + xterm-addon-fit.
//
// xterm publishes ES modules under app/js/lib/xterm/ — they are copied
// in by tools/copy-xterm.js as part of `npm install` (postinstall) so
// the renderer can load them without a bundler. If the files aren't
// there (fresh checkout, ran without postinstall, packaged build forgot
// the copy step), we resolve with `{ ok: false, error }` and the
// terminal pane shows a clear "feature unavailable — run npm install"
// message instead of throwing in the boot path.

export async function loadXterm() {
  try {
    // Use Function() to defer the import so static analysis doesn't try
    // to resolve the path at parse time (the file may legitimately not
    // exist on a fresh clone).
    const xterm = await import("./xterm/xterm.js").catch((err) => {
      throw new Error("xterm.js not vendored — run `npm install` to copy it: " + (err && err.message || err));
    });
    const fitMod = await import("./xterm/xterm-addon-fit.js").catch((err) => {
      throw new Error("xterm-addon-fit.js not vendored — run `npm install` to copy it: " + (err && err.message || err));
    });
    const Terminal = xterm.Terminal || (xterm.default && xterm.default.Terminal);
    const FitAddon = fitMod.FitAddon || (fitMod.default && fitMod.default.FitAddon);
    if (typeof Terminal !== "function") {
      return { ok: false, error: "xterm.js loaded but Terminal class missing" };
    }
    if (typeof FitAddon !== "function") {
      return { ok: false, error: "xterm-addon-fit loaded but FitAddon class missing" };
    }
    return { ok: true, Terminal, FitAddon };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
