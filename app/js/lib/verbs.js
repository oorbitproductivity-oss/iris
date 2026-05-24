// verbs.js -- Rotating activity words for Iris.
//
// Two lists: THINKING (before first token / between tool uses) and DOING
// (while text is streaming). A `Rotator` cycles through the chosen list
// every ~2.5s so the UI feels alive.

export const THINKING = [
  "Thinking",
  "Pondering",
  "Considering",
  "Reflecting",
  "Reasoning",
  "Deliberating",
  "Mulling",
  "Contemplating",
  "Ruminating",
  "Cogitating",
  "Plotting",
  "Charting",
];

export const DOING = [
  "Weaving",
  "Forging",
  "Drafting",
  "Crafting",
  "Composing",
  "Building",
  "Spinning",
  "Threading",
  "Wiring",
  "Tracing",
  "Shaping",
  "Knitting",
  "Working",
];

export function pickWord(list, seed = 0) {
  return list[Math.abs(seed | 0) % list.length];
}

/** Creates a rotator that calls `onTick(word)` every `intervalMs` ms. */
export function createRotator({ list, onTick, intervalMs = 2500 } = {}) {
  let i = Math.floor(Math.random() * (list?.length || 1));
  let mode = "thinking"; // or "doing"
  let timer = null;
  let active = false;
  let currentList = list || THINKING;

  function tick() {
    if (!active) return;
    onTick?.(currentList[i % currentList.length]);
    i++;
  }

  function start(initialMode = "thinking") {
    if (active) {
      setMode(initialMode);
      return;
    }
    active = true;
    setMode(initialMode);
    tick();
    timer = setInterval(tick, intervalMs);
  }

  function setMode(next) {
    if (mode === next && currentList) return;
    mode = next;
    currentList = next === "doing" ? DOING : THINKING;
    i = Math.floor(Math.random() * currentList.length);
    if (active) tick();
  }

  function stop() {
    active = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, setMode, stop, isActive: () => active };
}

/** Format an elapsed-ms value as a short human string. */
export function shortElapsed(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
