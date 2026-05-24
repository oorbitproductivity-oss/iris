// Standalone backend smoke test.
// Spawns the real `claude` subprocess via AgentManager and verifies the
// stream-json pipeline + Iris orchestrator setup, plus the new
// per-agent apiKeyId / sandbox fields.

const path = require("path");
const fs = require("fs");
const os = require("os");

const { Store } = require("./lib/store.js");
const { AgentManager } = require("./lib/agent-manager.js");

const TMP = path.join(os.tmpdir(), "iris-smoke-" + Date.now());
fs.mkdirSync(TMP, { recursive: true });
console.log("[smoke] data dir:", TMP);

const store = new Store(TMP);
const events = [];
const broadcast = (e) => {
  events.push(e);
  const tail =
    e.type === "delta" ? JSON.stringify(e.text).slice(0, 60) :
    e.type === "agent:created" || e.type === "agent:updated" ? `(${e.agent && e.agent.id})` :
    (e.id || "");
  console.log("[event]", e.type, tail, e.message || "");
};

const manager = new AgentManager({ store, dataDir: TMP, broadcast });
manager.bootstrap();

console.log("[smoke] agents after bootstrap:", manager.list().map((a) => a.id));

// Quick store smoke: API keys round-trip
const k1 = store.addApiKey({ name: "Smoke key", value: "sk-test-1234567890" });
const keys = store.getApiKeys();
const val = store.getApiKeyValue(k1.id);
console.log("[smoke] key list:", keys.map((k) => `${k.name}(${k.hint})`));
console.log("[smoke] key resolved value matches:", val === "sk-test-1234567890");
store.deleteApiKey(k1.id);

// Sandbox creation (no spawn yet)
const sandboxAgent = manager.create({
  name: "Smoke sandbox",
  cwd: null,
  sandbox: true,
  initialPrompt: "",
});
const sbxDir = sandboxAgent.sandboxDir;
console.log("[smoke] sandbox dir exists:", fs.existsSync(sbxDir), sbxDir);
manager.delete(sandboxAgent.id);
console.log("[smoke] sandbox cleaned:", !fs.existsSync(sbxDir));

// End-to-end: ask Iris
console.log("[smoke] sending test prompt to iris...");
manager.sendMessage("iris", "Reply with exactly two words: hello world");

const start = Date.now();
const timeout = 60000;
const poll = setInterval(() => {
  const elapsed = Date.now() - start;
  const done = events.find((e) => e.type === "done" && e.id === "iris");
  const result = events.find((e) => e.type === "result" && e.id === "iris");
  const err = events.find((e) => e.type === "error" && e.id === "iris");

  if (done || err || elapsed > timeout) {
    clearInterval(poll);
    console.log("\n[smoke] -- summary --");
    console.log("  events:", events.length);
    console.log("  delta count:", events.filter((e) => e.type === "delta").length);
    console.log("  result:", result ? JSON.stringify(result.text).slice(0, 120) : "(none)");
    console.log("  error:", err ? err.message : "(none)");
    console.log("  done:", done ? `code=${done.code}` : "(none)");
    console.log("  duration:", elapsed + "ms");

    manager.shutdown();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

    if (err || (done && done.code !== 0) || !result) {
      console.error("FAIL");
      process.exit(1);
    }
    console.log("PASS");
    process.exit(0);
  }
}, 250);
