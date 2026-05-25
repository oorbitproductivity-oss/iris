// lib/agent-manager.js
// Manages N concurrent `claude` CLI subprocesses, one per agent.
// One special agent with id "iris" is the master orchestrator and is always present.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { getIrisSystemPrompt, buildIrisContext, getWorkerAppendPrompt } = require("./iris.js");
const { Journal } = require("./memory/journal.js");

const IRIS_ID = "iris";
const IRIS_NAME = "Iris";

// ── Cost accounting (v0.5 Feature 5) ─────────────────────────
// Public pricing per million tokens. Numbers track Anthropic's posted rates as
// of 2025-Q4 — easy to keep up-to-date in one place. cache_read is billed at
// 10% of base input, cache_creation at 125%.
//
//   model key → { in, out } USD per 1M tokens
const COST_RATES = {
  sonnet: { in: 3, out: 15 },
  opus:   { in: 15, out: 75 },
  haiku:  { in: 0.8, out: 4 },
};
// Resolve a user-facing model name ("sonnet"/"opus"/"haiku") OR a raw CLI
// model id ("claude-sonnet-4-6", "claude-opus-4-7"…) to a rate row. Defaults
// to sonnet pricing when nothing matches — better to under-warn slightly than
// fail loudly mid-turn.
function resolveRate(model) {
  if (!model) return COST_RATES.sonnet;
  const s = String(model).toLowerCase();
  if (s.includes("opus")) return COST_RATES.opus;
  if (s.includes("haiku")) return COST_RATES.haiku;
  return COST_RATES.sonnet;
}

/**
 * Compute USD cost for a single turn given the SDK's `usage` block plus the
 * model used. Exported for testability — the per-turn rule is small enough
 * that a unit test is the right way to catch pricing-table edits.
 *
 *   usage: { input_tokens, output_tokens,
 *            cache_read_input_tokens, cache_creation_input_tokens }
 */
function computeTurnCostUsd(usage, model) {
  if (!usage || typeof usage !== "object") return 0;
  const rate = resolveRate(model);
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheCreate = Number(usage.cache_creation_input_tokens || 0);
  // Per Anthropic: cache read ~ 10% of base input cost, cache create ~ 125%.
  const usd =
    (inTok / 1e6) * rate.in +
    (outTok / 1e6) * rate.out +
    (cacheRead / 1e6) * rate.in * 0.1 +
    (cacheCreate / 1e6) * rate.in * 1.25;
  return usd;
}

/**
 * Threshold-crossing detector. Returns `{ crossed }` where `crossed` is
 * `"warn"` when this turn pushes the session past 80% of budget for the
 * FIRST time, `"exceeded"` when it pushes past 100% for the FIRST time, or
 * `null` otherwise.
 *
 * Caller is expected to keep the `state` argument around between calls —
 * `state.warnedAt80` and `state.warnedAt100` are mutated to record that the
 * thresholds have already fired this session.
 *
 * Exported for testability.
 */
function detectBudgetCrossing(prevUsd, currentUsd, budgetUsd, state) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { crossed: null };
  if (!state || typeof state !== "object") state = {};
  const warnLimit = budgetUsd * 0.8;
  // 100% crossing wins over 80% if both happen on the same turn (a single
  // very expensive turn could push past both thresholds at once).
  if (currentUsd >= budgetUsd && !state.warnedAt100) {
    state.warnedAt100 = true;
    // Once we've hit 100, the 80% warning is moot.
    state.warnedAt80 = true;
    return { crossed: "exceeded" };
  }
  if (currentUsd >= warnLimit && !state.warnedAt80) {
    state.warnedAt80 = true;
    return { crossed: "warn" };
  }
  return { crossed: null };
}

function now() {
  return Date.now();
}

function truncate(s, max = 140) {
  if (!s) return "";
  const flat = String(s).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

const CLAUDE_NOT_INSTALLED_MESSAGE =
  "Claude Code CLI is not installed on this machine.\n\n" +
  "Install Node.js first if needed (https://nodejs.org), then run in a terminal:\n" +
  "  npm install -g @anthropic-ai/claude-code\n\n" +
  "Once installed, run `claude` once to log in, then restart Iris Code.\n\n" +
  "Docs: https://docs.claude.com/en/docs/claude-code/overview";

// Recognize the various ways the OS reports "claude binary missing" so we can
// swap the raw shell/Node error for an actionable install message before it
// reaches the user.
function isClaudeMissingError(text) {
  if (!text) return false;
  const s = String(text);
  return (
    /ENOENT/i.test(s) ||
    /is not recognized as an internal or external command/i.test(s) ||
    /command not found/i.test(s) ||
    /\bno such file or directory\b/i.test(s)
  );
}

// PATHEXT walk to find the `claude` binary on PATH. Returns { path, needsShell }
// or null. Resolving upfront lets us pick the correct spawn mode on the FIRST
// attempt — critical on Windows where claude is shimmed by npm as `claude.cmd`
// and Node's CVE-2024-27980 mitigation refuses to spawn .cmd without shell:true,
// causing a failed first spawn whose async `close` (libuv -4058 / UV_ENOENT)
// then races and clobbers the successful retry.
function resolveClaudeBinary() {
  const isWin = process.platform === "win32";
  const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];
  const extraPath = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".local",
    "bin"
  );
  const parts = ((process.env.PATH || "") + path.delimiter + extraPath).split(path.delimiter);
  for (const p of parts) {
    if (!p) continue;
    for (const ext of exts) {
      const cand = path.join(p, "claude" + ext);
      try {
        if (fs.existsSync(cand)) {
          const lower = cand.toLowerCase();
          const needsShell = isWin && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
          return { path: cand, needsShell };
        }
      } catch {}
    }
  }
  return null;
}

// ── Safety: destructive-command detection ────────────────────────────
// Pattern-match tool inputs before the agent gets to act on them. Patterns
// err on the side of false positives — better to pause once than to wipe a
// drive once.
const DANGER_BASH_PATTERNS = [
  { rx: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|--recursive\s+|--force\s+|-rf?\s+\/|-rf?\s+~)/, reason: "Recursive/forced rm" },
  { rx: /\brm\s+-[a-zA-Z]*\s+\/(\s|$|\*)/, reason: "rm targeting filesystem root" },
  { rx: /\b(del|erase)\s+\/[sqf]/i, reason: "Windows recursive del" },
  { rx: /\brmdir\s+\/s/i, reason: "Windows recursive rmdir" },
  { rx: /\bRemove-Item\b[^|]*-Recurse\b[^|]*-Force\b/i, reason: "PowerShell Remove-Item -Recurse -Force" },
  { rx: /\bformat\s+[a-z]:/i, reason: "Drive format" },
  { rx: /\bmkfs(\.|\s)/i, reason: "mkfs (filesystem create)" },
  { rx: /\bdd\b[^|]*\bof=/, reason: "dd write to device" },
  { rx: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb" },
  { rx: /\bchmod\s+-R\s+0+/, reason: "Recursive chmod 000" },
  { rx: /\bchown\s+-R\b/, reason: "Recursive chown" },
  { rx: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard" },
  { rx: /\bgit\s+clean\s+-[a-z]*f/, reason: "git clean -f" },
  { rx: /\bgit\s+push\s+(-f|--force)/, reason: "git push --force" },
  { rx: /\bgit\s+checkout\s+(\.|--)/, reason: "git checkout discarding changes" },
  { rx: /\bsudo\b/, reason: "sudo escalation" },
  { rx: />\s*\/dev\/(sd|nvme|hd)/, reason: "Write to raw block device" },
  { rx: /\bdrop\s+(table|database)\b/i, reason: "SQL DROP" },
  { rx: /\btruncate\s+table\b/i, reason: "SQL TRUNCATE" },
  { rx: /\bnpm\s+publish\b/, reason: "npm publish (irreversible release)" },
  { rx: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "System power command" },
];

const DANGER_PATH_PATTERNS = [
  { rx: /^\/(bin|sbin|etc|boot|root|usr|var\/(lib|log|run))\b/, reason: "System path" },
  { rx: /^[A-Z]:\\Windows\b/i, reason: "Windows system path" },
  { rx: /\.ssh[\\/](id_|authorized_keys|known_hosts)/i, reason: "SSH credential file" },
  { rx: /\.aws[\\/]credentials/i, reason: "AWS credentials" },
  { rx: /\.git[\\/]config$/i, reason: ".git/config" },
];

/**
 * Inspect a tool invocation and return a danger record or null.
 * @returns {{ reason: string, kind: "bash" | "edit" | "write" | "delete" } | null}
 */
function checkDanger(toolName, input) {
  if (!input || typeof input !== "object") return null;
  const name = String(toolName || "").toLowerCase();

  if (name === "bash") {
    const cmd = String(input.command || "");
    for (const p of DANGER_BASH_PATTERNS) {
      if (p.rx.test(cmd)) return { reason: p.reason, kind: "bash" };
    }
    return null;
  }

  if (name === "write" || name === "edit" || name === "multiedit" || name === "notebookedit") {
    const file = String(input.file_path || input.notebook_path || "");
    if (file) {
      for (const p of DANGER_PATH_PATTERNS) {
        if (p.rx.test(file)) return { reason: `${p.reason}: ${file}`, kind: "write" };
      }
    }
    // Detect "delete entire file" Edit patterns (replacing whole file with empty).
    if (name === "edit" && input.new_string === "" && typeof input.old_string === "string" && input.old_string.length > 200) {
      return { reason: "Edit wipes large block of content", kind: "edit" };
    }
    return null;
  }

  return null;
}

class AgentManager {
  constructor({ store, dataDir, broadcast, mcpInstaller = null }) {
    if (!store) throw new Error("AgentManager: store is required");
    if (!dataDir) throw new Error("AgentManager: dataDir is required");
    if (typeof broadcast !== "function") {
      throw new Error("AgentManager: broadcast must be a function");
    }
    this.store = store;
    this.dataDir = dataDir;
    this.broadcast = broadcast;
    /** Optional: lib/mcp/installer.js Installer. When set + mcpEnabled in
     *  settings, the spawned claude CLI gets --mcp-config pointed at a
     *  per-agent runtime file and an env overlay carrying the resolved
     *  secrets for any MCP server installed for this agent. */
    this.mcpInstaller = mcpInstaller;

    /** @type {Record<string, AgentRecord>} */
    this.agents = {};
    /** Live child processes keyed by agent id. */
    this.procs = new Map();
    /** Per-agent transient state for the currently streaming assistant turn. */
    this.streams = new Map();
    /**
     * Per-agent cost tracking (v0.5 Feature 5). One entry per agent that has
     * sent at least one turn.
     *
     *   { sessionId, usd, budgetUsd, warnedAt80, warnedAt100 }
     *
     * `usd` is reset whenever sessionId changes or the agent's costBudgetUsd
     * is reconfigured by the renderer (we treat a budget change as a fresh
     * accounting window so the user gets a clean run after raising the cap).
     */
    this._costsByAgent = new Map();
  }

  // ── Lifecycle ──

  bootstrap() {
    this.agents = this.store.getAgents() || {};

    // Ensure the Iris agent exists.
    if (!this.agents[IRIS_ID]) {
      const irisHome = path.join(this.dataDir, "iris-home");
      if (!fs.existsSync(irisHome)) fs.mkdirSync(irisHome, { recursive: true });
      const settings = this.store.getSettings();
      this.agents[IRIS_ID] = {
        id: IRIS_ID,
        role: "iris",
        name: IRIS_NAME,
        cwd: irisHome,
        model: settings.irisModel || "sonnet",
        status: "idle",
        lastActivity: 0,
        lastText: "",
        createdAt: now(),
        sessionId: null,
      };
      this.store.saveAgents(this.agents);
    } else {
      // Make sure Iris's home dir still exists.
      const irisHome = this.agents[IRIS_ID].cwd;
      if (irisHome && !fs.existsSync(irisHome)) {
        fs.mkdirSync(irisHome, { recursive: true });
      }
      // Force role + name canonical.
      this.agents[IRIS_ID].role = "iris";
      this.agents[IRIS_ID].name = this.agents[IRIS_ID].name || IRIS_NAME;
      this.agents[IRIS_ID].status = "idle";
    }
  }

  shutdown() {
    for (const [id, proc] of this.procs.entries()) {
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        console.error(`[agent-manager] error killing process for ${id}:`, err);
      }
    }
    this.procs.clear();
    this.streams.clear();
  }

  // ── Read API ──

  /** Returns AgentSummary[] — Iris first, then workers by createdAt desc. */
  list() {
    const all = Object.values(this.agents).map((a) => this._toSummary(a));
    const iris = all.filter((a) => a.id === IRIS_ID);
    const workers = all
      .filter((a) => a.id !== IRIS_ID)
      .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return [...iris, ...workers];
  }

  /** Returns AgentFull with messages, or null if not found. */
  get(id) {
    const a = this.agents[id];
    if (!a) return null;
    return {
      ...this._toSummary(a),
      messages: this.store.getMessages(id),
    };
  }

  // ── Create / Delete ──

  create({ name, cwd, initialPrompt, model, apiKeyId, sandbox, importFiles } = {}) {
    if (!name) {
      throw new Error("AgentManager.create: name is required");
    }
    const settings = this.store.getSettings();
    const id = crypto.randomUUID();

    // Resolve working dir. If sandbox=true, allocate a private dir under
    // dataDir/sandboxes/<id> and optionally copy `importFiles` (array of
    // absolute paths) into it. The user's original cwd is remembered on
    // the record so we can export results back later.
    let resolvedCwd = cwd ? String(cwd) : (settings.defaultCwd || "");
    let sandboxDir = null;
    const sourceDir = resolvedCwd || null;
    if (sandbox) {
      sandboxDir = path.join(this.dataDir, "sandboxes", id);
      if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });
      if (Array.isArray(importFiles)) {
        for (const f of importFiles) {
          try {
            const dest = path.join(sandboxDir, path.basename(f));
            fs.copyFileSync(f, dest);
          } catch (err) {
            console.error("[agent-manager] sandbox import failed for", f, err);
          }
        }
      } else if (resolvedCwd && fs.existsSync(resolvedCwd)) {
        // No explicit list: shallow-copy regular files from sourceDir into sandbox.
        try {
          const entries = fs.readdirSync(resolvedCwd, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isFile()) continue;
            if (e.name.startsWith(".")) continue;
            try {
              fs.copyFileSync(path.join(resolvedCwd, e.name), path.join(sandboxDir, e.name));
            } catch (err) {
              console.error("[agent-manager] sandbox auto-import failed for", e.name, err);
            }
          }
        } catch (err) {
          console.error("[agent-manager] sandbox auto-import dir read failed:", err);
        }
      }
      resolvedCwd = sandboxDir;
    }

    if (!resolvedCwd) {
      throw new Error("AgentManager.create: cwd is required (or pick sandbox mode)");
    }

    // Non-sandbox path: make sure the working directory actually exists on disk.
    // Node spawn() reports a missing cwd as ENOENT on the executable — a confusing
    // failure mode — so we eagerly mkdir -p here. If creation itself fails, surface
    // a clear error instead of letting the spawn fail cryptically later.
    if (!sandbox) {
      try {
        if (!fs.existsSync(resolvedCwd)) {
          fs.mkdirSync(resolvedCwd, { recursive: true });
        }
      } catch (err) {
        throw new Error(
          `Working directory "${resolvedCwd}" does not exist and could not be created: ${err.message || err}`
        );
      }
    }

    const agent = {
      id,
      role: "worker",
      name: String(name),
      cwd: resolvedCwd,
      model: model || settings.model || "sonnet",
      status: "idle",
      lastActivity: now(),
      lastText: "",
      createdAt: now(),
      sessionId: null,
      apiKeyId: apiKeyId || null,
      sandbox: !!sandbox,
      sandboxDir,
      sourceDir,
      // v0.5 Feature 5: per-thread cost budget. Seeded from settings so a
      // user with a global default ceiling gets it on every new thread.
      costBudgetUsd: typeof settings.defaultCostBudgetUsd === "number"
        ? settings.defaultCostBudgetUsd
        : null,
      costBudgetAction: null,
    };
    this.agents[id] = agent;
    this.store.saveAgents(this.agents);
    this.store.saveMessages(id, []);
    this.broadcast({ type: "agent:created", agent: this._toSummary(agent) });

    if (initialPrompt && String(initialPrompt).trim()) {
      // Fire-and-forget — sendMessage handles its own broadcasting.
      this.sendMessage(id, String(initialPrompt));
    }
    return this._toSummary(agent);
  }

  /** Update mutable fields on an existing agent. Returns updated summary, or null. */
  update(id, patch) {
    const a = this.agents[id];
    if (!a) return null;
    if (!patch || typeof patch !== "object") return this._toSummary(a);
    const allowed = ["name", "model", "cwd", "apiKeyId", "costBudgetUsd", "costBudgetAction"];
    let budgetChanged = false;
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        if (k === "costBudgetUsd" && a.costBudgetUsd !== patch[k]) budgetChanged = true;
        a[k] = patch[k];
      }
    }
    // Reset the "already fired" markers when the user raises/lowers the
    // ceiling — they explicitly want a fresh accounting window.
    if (budgetChanged) {
      const existing = this._costsByAgent.get(id);
      if (existing) {
        existing.warnedAt80 = false;
        existing.warnedAt100 = false;
      }
    }
    this.store.saveAgents(this.agents);
    this.broadcast({ type: "agent:updated", agent: this._toSummary(a) });
    return this._toSummary(a);
  }

  delete(id) {
    if (id === IRIS_ID) {
      console.error("[agent-manager] refusing to delete iris agent");
      return false;
    }
    const proc = this.procs.get(id);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        console.error(`[agent-manager] error killing ${id} during delete:`, err);
      }
      this.procs.delete(id);
      this.streams.delete(id);
    }
    const sandboxDir = this.agents[id] && this.agents[id].sandboxDir;
    if (this.agents[id]) {
      delete this.agents[id];
    }
    this._costsByAgent.delete(id);
    this.store.deleteAgent(id);
    // Clean up sandbox dir if any.
    if (sandboxDir) {
      try { fs.rmSync(sandboxDir, { recursive: true, force: true }); }
      catch (err) { console.error("[agent-manager] sandbox cleanup failed:", err); }
    }
    this.broadcast({ type: "agent:deleted", id });
    return true;
  }

  // ── Safety: halt the run if a destructive tool input is detected ──

  _maybeHaltForDanger(agent, entry) {
    if (!entry || !entry.toolEntry) return;
    // Don't double-fire — once we've flagged this tool use, leave it alone.
    if (entry.toolEntry.dangerous) return;
    const danger = checkDanger(entry.name, entry.input);
    if (!danger) return;

    entry.toolEntry.dangerous = true;
    entry.toolEntry.dangerReason = danger.reason;

    const settings = this.store.getSettings();
    const mode = settings.safetyMode || "halt";

    this.broadcast({
      type: "tool_dangerous",
      id: agent.id,
      useId: entry.useId,
      tool: entry.name,
      reason: danger.reason,
      kind: danger.kind,
      halted: mode === "halt",
    });

    if (mode === "halt") {
      // Tear down the subprocess BEFORE the model has a chance to execute the
      // command. The user can either resume the agent (and re-send) or rewrite
      // the prompt. Either way, the destructive command does not run.
      try {
        const proc = this.procs.get(agent.id);
        if (proc) proc.kill("SIGTERM");
      } catch (err) {
        console.error(`[agent-manager] error halting ${agent.id}:`, err);
      }
      agent.status = "idle";
      this.store.saveAgents(this.agents);
      this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });
    }
  }

  // ── Run control ──

  stop(id) {
    const proc = this.procs.get(id);
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        console.error(`[agent-manager] error stopping ${id}:`, err);
      }
    }
    const a = this.agents[id];
    if (a) {
      a.status = "idle";
      this.store.saveAgents(this.agents);
      this.broadcast({ type: "agent:updated", agent: this._toSummary(a) });
    }
  }

  /** No-op if running; otherwise the next sendMessage will resume by sessionId. */
  resume(id) {
    if (this.procs.has(id)) return;
    const a = this.agents[id];
    if (!a) return;
    // Nothing to do — sendMessage already checks a.sessionId and adds --resume.
  }

  sendMessage(id, message) {
    const agent = this.agents[id];
    if (!agent) {
      console.error(`[agent-manager] sendMessage: unknown agent ${id}`);
      this.broadcast({ type: "error", id, message: `Unknown agent: ${id}` });
      return;
    }
    if (!message || !String(message).trim()) {
      this.broadcast({ type: "error", id, message: "Empty message" });
      return;
    }
    if (this.procs.has(id)) {
      this.broadcast({ type: "error", id, message: "Agent is busy" });
      return;
    }

    const userText = String(message);

    // Persist the user message and echo it back to the UI right away.
    const messages = this.store.getMessages(id);
    messages.push({ role: "user", text: userText, ts: now() });
    this.store.saveMessages(id, messages);
    this.broadcast({ type: "user", id, text: userText });

    // For Iris, prepend the live context block — workers + persistent journal.
    let prompt = userText;
    if (id === IRIS_ID) {
      const workers = this.list().filter((a) => a.id !== IRIS_ID);
      let journalSummary = null;
      try {
        const journal = new Journal({ dataDir: this.dataDir });
        journalSummary = journal.buildSummary();
      } catch {}
      const ctx = buildIrisContext(workers, journalSummary);
      prompt = ctx + "\n\n" + userText;
    }

    this._spawnClaude(agent, prompt);
  }

  // ── Internals ──

  _toSummary(a) {
    return {
      id: a.id,
      role: a.role,
      name: a.name,
      cwd: a.cwd,
      model: a.model,
      status: a.status || "idle",
      lastActivity: a.lastActivity || 0,
      lastText: a.lastText || "",
      createdAt: a.createdAt || 0,
      sessionId: a.sessionId || null,
      apiKeyId: a.apiKeyId || null,
      sandbox: !!a.sandbox,
      sandboxDir: a.sandboxDir || null,
      sourceDir: a.sourceDir || null,
      // v0.5 Feature 5: budget surfaces to renderer so the cost pill can
      // colorize and show the configured ceiling.
      costBudgetUsd: typeof a.costBudgetUsd === "number" ? a.costBudgetUsd : null,
      costBudgetAction: a.costBudgetAction || null,
    };
  }

  /** Copy files from a worker's sandbox back to its sourceDir (or a custom target). */
  exportSandbox(id, targetDir, files) {
    const a = this.agents[id];
    if (!a || !a.sandboxDir) return { ok: false, error: "no sandbox" };
    const target = targetDir || a.sourceDir;
    if (!target) return { ok: false, error: "no target dir" };
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });

    const list = Array.isArray(files) && files.length > 0
      ? files
      : fs.readdirSync(a.sandboxDir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);

    const written = [];
    for (const name of list) {
      try {
        const src = path.join(a.sandboxDir, path.basename(name));
        const dst = path.join(target, path.basename(name));
        fs.copyFileSync(src, dst);
        written.push(dst);
      } catch (err) {
        console.error("[agent-manager] export failed for", name, err);
      }
    }
    return { ok: true, written, target };
  }

  /** List file names in the sandbox dir for inspection in UI. */
  listSandboxFiles(id) {
    const a = this.agents[id];
    if (!a || !a.sandboxDir || !fs.existsSync(a.sandboxDir)) return [];
    try {
      return fs.readdirSync(a.sandboxDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(a.sandboxDir, e.name));
          return { name: e.name, size: st.size, modified: st.mtime.getTime() };
        });
    } catch (err) {
      console.error("[agent-manager] listSandboxFiles failed:", err);
      return [];
    }
  }

  _buildArgs(agent, prompt, { mcpConfigPath = null } = {}) {
    const settings = this.store.getSettings();
    // Plan mode: when toggled ON for this worker, run the CLI in its native
    // read-only planning mode. The CLI restricts the agent to read-only tools
    // and exposes ExitPlanMode for presenting a plan. Iris is conversational
    // already and is not affected.
    const planOn = !!(
      agent.id !== IRIS_ID &&
      settings.planModeByAgent &&
      settings.planModeByAgent[agent.id]
    );
    const permissionMode = planOn
      ? "plan"
      : (settings.permissionMode === "bypassPermissions")
        ? "bypassPermissions"
        : "acceptEdits";
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      permissionMode,
    ];
    if (agent.model) args.push("--model", agent.model);
    // Match the reasoning depth of an interactive Claude Code session.
    const effort = settings.effort || "high";
    if (effort && effort !== "default") args.push("--effort", effort);
    if (agent.sessionId) args.push("--resume", agent.sessionId);
    if (agent.id === IRIS_ID) {
      args.push(
        "--system-prompt",
        getIrisSystemPrompt({ userPlatform: process.platform, dataDir: this.dataDir })
      );
      // Iris is conversational; restrict to safe read-only tools.
      args.push("--tools", "Read,Glob,Grep,WebFetch,WebSearch");
    } else {
      // Worker agents — append (don't replace) so they keep Claude Code's
      // default coding behavior, plus our TL;DR rule and any user-defined
      // systemPromptExtras from settings.
      const appendText = getWorkerAppendPrompt({ extras: settings.systemPromptExtras });
      if (appendText) args.push("--append-system-prompt", appendText);
      if (agent.sourceDir && agent.sandbox) {
        // Sandbox workers — also expose the source workspace so CLAUDE.md and
        // reference files are reachable (read access is enough).
        args.push("--add-dir", agent.sourceDir);
      }
    }
    // MCP runtime config — passed for both Iris and workers when the installer
    // produced a config for this agent. The file lives in dataDir and is shred
    // after the process closes (see _attachProc).
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }
    return args;
  }

  /**
   * Resolve MCP runtime config for this agent. Returns null when MCP is
   * disabled in settings, no installer is wired in, or no servers are
   * installed for this agent. Caller is responsible for invoking
   * `mcpInstaller.shred(configPath)` after the spawned process exits.
   */
  _resolveMcpRuntime(agent) {
    if (!this.mcpInstaller) return null;
    try {
      const settings = this.store.getSettings();
      if (settings.mcpEnabled === false) return null;
      return this.mcpInstaller.buildRuntimeConfig(agent.id);
    } catch (err) {
      console.warn("[agent-manager] MCP runtime resolve failed:", err.message);
      return null;
    }
  }

  _spawnClaude(agent, prompt) {
    const mcp = this._resolveMcpRuntime(agent);
    const args = this._buildArgs(agent, prompt, {
      mcpConfigPath: mcp ? mcp.configPath : null,
    });

    // Pre-flight: cwd must exist, else spawn fails with a misleading
    // "spawn cmd.exe ENOENT" (Node reports a missing cwd as ENOENT on the
    // executable). Catch it here so the user gets an actionable message.
    if (!agent.cwd || !fs.existsSync(agent.cwd)) {
      this.broadcast({
        type: "error",
        id: agent.id,
        message: `Working directory does not exist: ${agent.cwd || "(unset)"}`,
      });
      agent.status = "error";
      this.store.saveAgents(this.agents);
      this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });
      return;
    }

    // Resolve the claude binary BEFORE spawning. If we don't, on Windows the
    // first spawn against claude.cmd will fail with ENOENT (CVE-2024-27980
    // mitigation refuses .cmd without shell:true) and then a stale `close`
    // event with libuv code -4058 races the retry and broadcasts a bogus
    // "claude exited with code -4058" — see Riley's bug report.
    const resolved = resolveClaudeBinary();
    if (!resolved) {
      this.broadcast({ type: "error", id: agent.id, message: CLAUDE_NOT_INSTALLED_MESSAGE });
      agent.status = "error";
      this.store.saveAgents(this.agents);
      this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });
      return;
    }

    const env = {
      ...process.env,
      PATH:
        (process.env.PATH || "") +
        path.delimiter +
        path.join(process.env.USERPROFILE || process.env.HOME || "", ".local", "bin"),
      // Raise the per-response output ceiling. With --effort high, the
      // thinking budget alone can push past the default 32k. 64k keeps long
      // research/refactor turns from getting cut off.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "64000",
    };

    // API-key mode: pick per-agent key, else fall back to settings.defaultApiKeyId.
    // When unset, do NOT touch ANTHROPIC_API_KEY — claude CLI will use the
    // user's existing OAuth subscription.
    const settings = this.store.getSettings();
    const apiKeyId = agent.apiKeyId || settings.defaultApiKeyId || null;
    if (apiKeyId) {
      const value = this.store.getApiKeyValue(apiKeyId);
      if (value) {
        env.ANTHROPIC_API_KEY = value;
      } else {
        console.warn(`[agent-manager] api key id ${apiKeyId} not resolvable; falling back to subscription`);
      }
    } else {
      // Make sure no stale env var leaks through and accidentally bills the user.
      delete env.ANTHROPIC_API_KEY;
    }

    // MCP secret overlay — values resolved out of the encrypted vault. The
    // .mcp.json on disk references env vars by ${NAME}; the actual values
    // ride here and the claude CLI propagates them to MCP subprocesses.
    if (mcp && mcp.envOverlay) {
      Object.assign(env, mcp.envOverlay);
    }

    // On Windows .cmd: spawn through shell from the first attempt. Passing the
    // bare name "claude" (not the absolute path) lets cmd.exe do PATHEXT lookup
    // and avoids the quote-the-path-with-spaces problem.
    const spawnOpts = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: agent.cwd,
      env,
      shell: resolved.needsShell,
    };

    let proc;
    try {
      proc = spawn("claude", args, spawnOpts);
    } catch (err) {
      console.error(`[agent-manager] spawn(claude) threw for ${agent.id}:`, err);
      this._handleSpawnFailure(agent, err);
      return;
    }

    // Skip the retry path when we already used shell on first attempt — there's
    // nothing better to fall back to.
    this._attachProc(agent, proc, args, /*retriedWithShell=*/ resolved.needsShell, mcp);
  }

  _attachProc(agent, proc, args, retriedWithShell, mcpRuntime = null) {
    const id = agent.id;
    this.procs.set(id, proc);
    if (mcpRuntime) this._mcpRuntimeByAgent = this._mcpRuntimeByAgent || new Map();
    if (mcpRuntime) this._mcpRuntimeByAgent.set(id, mcpRuntime);

    const stream = {
      stdoutBuf: "",
      stderrBuf: "",
      assistantText: "",
      tools: [],
      sessionAnnounced: false,
      resultReceived: false,
      spawnError: null,
    };
    this.streams.set(id, stream);

    agent.status = "running";
    agent.lastActivity = now();
    this.store.saveAgents(this.agents);
    this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });

    proc.stdout.on("data", (chunk) => this._onStdout(agent, chunk));
    proc.stderr.on("data", (chunk) => {
      const s = this.streams.get(id);
      if (s) s.stderrBuf += chunk.toString();
    });

    proc.on("error", (err) => {
      console.error(`[agent-manager] child error for ${id}:`, err);
      const s = this.streams.get(id);
      if (s) s.spawnError = err;

      // Windows quirk: `claude` may be `claude.cmd`. If ENOENT, retry with shell:true once.
      if (
        !retriedWithShell &&
        err &&
        (err.code === "ENOENT" || /ENOENT/i.test(String(err.message || "")))
      ) {
        // Detach listeners from the dead proc BEFORE kicking off the retry.
        // Otherwise the failed first attempt's async `close` (libuv -4058 on
        // Windows) races the retry and broadcasts a stale exit code that
        // clobbers the live retry's session. The stale-close guard in
        // _onClose is the primary defense; this is belt-and-suspenders.
        proc.removeAllListeners("close");
        proc.removeAllListeners("error");
        try { proc.stdout && proc.stdout.removeAllListeners(); } catch {}
        try { proc.stderr && proc.stderr.removeAllListeners(); } catch {}
        this.procs.delete(id);
        this.streams.delete(id);
        this._spawnClaudeWithShell(agent, args);
        return;
      }

      const raw = err.message || String(err);
      const message = isClaudeMissingError(raw) || (err && err.code === "ENOENT")
        ? CLAUDE_NOT_INSTALLED_MESSAGE
        : `Could not start Claude CLI: ${raw}`;
      this.broadcast({ type: "error", id, message });
    });

    proc.on("close", (code) => {
      try {
        if (this._mcpRuntimeByAgent && this._mcpRuntimeByAgent.has(id)) {
          const rt = this._mcpRuntimeByAgent.get(id);
          this._mcpRuntimeByAgent.delete(id);
          if (rt && this.mcpInstaller && Array.isArray(rt.filesToShred)) {
            for (const f of rt.filesToShred) this.mcpInstaller.shred(f);
          }
        }
      } catch (err) {
        console.warn("[agent-manager] mcp shred failed:", err.message);
      }
      this._onClose(agent, code, proc);
    });
  }

  _spawnClaudeWithShell(agent, args) {
    const env = {
      ...process.env,
      PATH:
        (process.env.PATH || "") +
        path.delimiter +
        path.join(process.env.USERPROFILE || process.env.HOME || "", ".local", "bin"),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || "64000",
    };
    const settings = this.store.getSettings();
    const apiKeyId = agent.apiKeyId || settings.defaultApiKeyId || null;
    if (apiKeyId) {
      const value = this.store.getApiKeyValue(apiKeyId);
      if (value) env.ANTHROPIC_API_KEY = value;
    } else {
      delete env.ANTHROPIC_API_KEY;
    }
    // Re-resolve MCP runtime — args already carry --mcp-config from the first
    // attempt, but the runtime file may have been shred'd by a stale close.
    const mcp = this._resolveMcpRuntime(agent);
    if (mcp && mcp.envOverlay) Object.assign(env, mcp.envOverlay);
    let proc;
    try {
      proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: agent.cwd,
        env,
        shell: true,
      });
    } catch (err) {
      console.error(`[agent-manager] retry spawn(claude, shell:true) threw for ${agent.id}:`, err);
      this._handleSpawnFailure(agent, err);
      return;
    }
    this._attachProc(agent, proc, args, /*retriedWithShell=*/ true, mcp);
  }

  _handleSpawnFailure(agent, err) {
    const id = agent.id;
    this.procs.delete(id);
    this.streams.delete(id);
    agent.status = "error";
    this.store.saveAgents(this.agents);
    const raw = err && err.message ? err.message : String(err);
    const message = isClaudeMissingError(raw) || (err && err.code === "ENOENT")
      ? CLAUDE_NOT_INSTALLED_MESSAGE
      : `Could not start Claude CLI: ${raw}`;
    this.broadcast({ type: "error", id, message });
    this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });
  }

  _onStdout(agent, chunk) {
    const id = agent.id;
    const stream = this.streams.get(id);
    if (!stream) return;

    stream.stdoutBuf += chunk.toString();
    const lines = stream.stdoutBuf.split("\n");
    stream.stdoutBuf = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch (err) {
        // stream-json is line-delimited JSON. Drop garbage lines, but log them.
        console.error(`[agent-manager] non-JSON line from ${id}:`, trimmed.slice(0, 200));
        continue;
      }
      this._handleEvent(agent, evt);
    }
  }

  _handleEvent(agent, evt) {
    const id = agent.id;
    const stream = this.streams.get(id);
    if (!stream) return;

    if (!stream.blocksByIndex) stream.blocksByIndex = new Map();
    if (!stream.toolsByUseId) stream.toolsByUseId = new Map();

    // 1) system init → session id
    if (evt.type === "system" && evt.subtype === "init") {
      const sid = evt.session_id || null;
      if (sid) {
        // Session id changed (fresh run after restart, or a /clear) — clear
        // the cumulative-cost accumulator so budgets gate the new session
        // rather than counting against ancient turns.
        const prevCost = this._costsByAgent.get(id);
        if (prevCost && prevCost.sessionId && prevCost.sessionId !== sid) {
          this._costsByAgent.delete(id);
        }
        agent.sessionId = sid;
        this.store.saveAgents(this.agents);
      }
      if (!stream.sessionAnnounced) {
        stream.sessionAnnounced = true;
        this.broadcast({
          type: "session",
          id,
          sessionId: sid,
          model: evt.model || agent.model,
        });
      }
      return;
    }

    // 2) Streaming sub-events from the SDK (partial-message protocol).
    if (evt.type === "stream_event" && evt.event) {
      const ev = evt.event;

      // New assistant turn — reset per-message block tracking.
      if (ev.type === "message_start") {
        stream.blocksByIndex.clear();
        return;
      }

      // A new content block opened — could be a text run or a tool_use call.
      if (ev.type === "content_block_start") {
        const idx = ev.index;
        const cb = ev.content_block || {};
        const entry = { type: cb.type, index: idx };

        if (cb.type === "tool_use") {
          entry.useId = cb.id;
          entry.name = cb.name;
          entry.partialJson = "";
          entry.input = cb.input && Object.keys(cb.input).length ? cb.input : {};

          const toolEntry = {
            useId: cb.id,
            name: cb.name,
            input: entry.input,
            status: "started",
            ts: now(),
          };
          stream.tools.push(toolEntry);
          stream.toolsByUseId.set(cb.id, toolEntry);
          entry.toolEntry = toolEntry;

          this.broadcast({
            type: "tool",
            id,
            useId: cb.id,
            tool: cb.name,
            input: entry.input,
          });
        }
        stream.blocksByIndex.set(idx, entry);
        return;
      }

      // Streaming delta — either text or tool-input JSON arriving char-by-char.
      if (ev.type === "content_block_delta") {
        const delta = ev.delta || {};
        const entry = stream.blocksByIndex.get(ev.index);

        if (delta.type === "text_delta") {
          const text = delta.text || "";
          stream.assistantText += text;
          this.broadcast({ type: "delta", id, text });
          return;
        }

        if (delta.type === "thinking_delta") {
          // Extended thinking content (opus + --effort). Surface it so the
          // user can see the model's reasoning live.
          this.broadcast({ type: "thinking", id, text: delta.thinking || "" });
          return;
        }

        if (delta.type === "input_json_delta" && entry && entry.type === "tool_use") {
          entry.partialJson += delta.partial_json || "";
          let parsed;
          try {
            parsed = JSON.parse(entry.partialJson);
          } catch {
            parsed = undefined;
          }
          if (parsed !== undefined) {
            entry.input = parsed;
            if (entry.toolEntry) entry.toolEntry.input = parsed;
            this._maybeHaltForDanger(agent, entry);
          }
          this.broadcast({
            type: "tool_input",
            id,
            useId: entry.useId,
            input: entry.input,
            partial: entry.partialJson,
          });
          return;
        }
        return;
      }

      // Block closed — finalize tool input by parsing the full accumulated JSON.
      if (ev.type === "content_block_stop") {
        const entry = stream.blocksByIndex.get(ev.index);
        if (entry && entry.type === "tool_use") {
          try {
            entry.input = JSON.parse(entry.partialJson || "{}");
          } catch {
            // Keep whatever we last successfully parsed.
          }
          if (entry.toolEntry) entry.toolEntry.input = entry.input;
          this._maybeHaltForDanger(agent, entry);
          this.broadcast({
            type: "tool_input",
            id,
            useId: entry.useId,
            input: entry.input,
            final: true,
          });
        }
        return;
      }

      // message_delta / message_stop — nothing for the UI to render.
      return;
    }

    // 3) Tool results come back as a "user" message between assistant turns.
    if (evt.type === "user" && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (!block || block.type !== "tool_result") continue;
        const useId = block.tool_use_id;
        const ok = !block.is_error;
        let preview = "";
        if (typeof block.content === "string") {
          preview = block.content;
        } else if (Array.isArray(block.content)) {
          preview = block.content
            .map((c) => (c && c.type === "text" ? c.text : ""))
            .filter(Boolean)
            .join("\n");
        }
        const snippet = String(preview || "").slice(0, 600).trim();
        const toolEntry = stream.toolsByUseId.get(useId);
        if (toolEntry) {
          toolEntry.status = ok ? "done" : "error";
          toolEntry.result = snippet;
        }
        this.broadcast({
          type: "tool_result",
          id,
          useId,
          ok,
          result: snippet,
        });
      }
      return;
    }

    // 4) result — final assistant message
    if (evt.type === "result") {
      stream.resultReceived = true;
      const text = typeof evt.result === "string" ? evt.result : stream.assistantText;
      const durationMs = evt.duration_ms;
      // Forward token usage to the renderer so the cost tracker can update
      // per-thread totals. The claude CLI sends usage under evt.usage with
      // input_tokens / output_tokens / cache_read_input_tokens /
      // cache_creation_input_tokens fields — pass through whatever's there.
      const usage = evt.usage && typeof evt.usage === "object" ? evt.usage : null;

      // Persist assistant message.
      const messages = this.store.getMessages(id);
      messages.push({
        role: "assistant",
        text,
        ts: now(),
        tools: stream.tools.slice(),
        usage,
      });
      this.store.saveMessages(id, messages);

      // Update agent summary.
      agent.lastActivity = now();
      agent.lastText = truncate(text, 140);
      this.store.saveAgents(this.agents);

      this.broadcast({ type: "result", id, text, durationMs, usage });
      this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });

      // v0.5 Feature 5: cumulative session cost + budget threshold detection.
      // Computed AFTER the result event so the renderer's cost tracker can
      // tally up its own per-turn totals first; the cost:* events arrive
      // immediately after.
      try {
        const turnUsd = computeTurnCostUsd(usage, agent.model);
        let costRec = this._costsByAgent.get(id);
        if (!costRec) {
          costRec = {
            sessionId: agent.sessionId || null,
            usd: 0,
            warnedAt80: false,
            warnedAt100: false,
          };
          this._costsByAgent.set(id, costRec);
        }
        // If sessionId rolled over mid-flight, treat the new turn as the
        // first of a fresh accounting window.
        if (costRec.sessionId && agent.sessionId && costRec.sessionId !== agent.sessionId) {
          costRec.sessionId = agent.sessionId;
          costRec.usd = 0;
          costRec.warnedAt80 = false;
          costRec.warnedAt100 = false;
        } else if (!costRec.sessionId && agent.sessionId) {
          costRec.sessionId = agent.sessionId;
        }
        const prevUsd = costRec.usd;
        costRec.usd = prevUsd + turnUsd;

        // Always emit a session-cost update so the renderer can size the
        // progress bar in real time.
        this.broadcast({
          type: "cost:session",
          id,
          currentUsd: costRec.usd,
          turnUsd,
          budgetUsd: typeof agent.costBudgetUsd === "number" ? agent.costBudgetUsd : null,
        });

        const budget = typeof agent.costBudgetUsd === "number" ? agent.costBudgetUsd : null;
        if (budget && budget > 0) {
          const det = detectBudgetCrossing(prevUsd, costRec.usd, budget, costRec);
          if (det.crossed === "warn") {
            this.broadcast({
              type: "cost:warn",
              id,
              currentUsd: costRec.usd,
              budgetUsd: budget,
              percent: 0.8,
            });
          } else if (det.crossed === "exceeded") {
            this.broadcast({
              type: "cost:exceeded",
              id,
              currentUsd: costRec.usd,
              budgetUsd: budget,
            });
          }
        }
      } catch (err) {
        console.warn("[agent-manager] cost accounting failed:", err.message);
      }
      return;
    }
  }

  _onClose(agent, code, proc) {
    const id = agent.id;

    // Stale-close guard (Riley's bug). On Windows, a failed first spawn against
    // claude.cmd can emit `close` with libuv code -4058 AFTER the retry has
    // already populated this.procs with a fresh, live proc under the same id.
    // Without this check, the dead proc's close fires _onClose against the
    // live retry's stream and broadcasts "claude exited with code -4058",
    // killing a session that's still running fine.
    if (proc && this.procs.has(id) && this.procs.get(id) !== proc) {
      console.warn(`[agent-manager] ignoring stale close (code=${code}) from replaced proc for ${id}`);
      return;
    }

    const stream = this.streams.get(id);
    this.procs.delete(id);

    if (stream && !stream.resultReceived) {
      // No `result` arrived. If we have stderr, surface it as an error.
      const stderrTrim = (stream.stderrBuf || "").trim();
      if ((code !== 0 || stderrTrim) && !stream.assistantText) {
        let msg;
        if (isClaudeMissingError(stderrTrim)) {
          msg = CLAUDE_NOT_INSTALLED_MESSAGE;
        } else if (stderrTrim) {
          msg = stderrTrim.slice(0, 500);
        } else {
          msg = `claude exited with code ${code}`;
        }
        this.broadcast({ type: "error", id, message: msg });
        agent.status = "error";
      } else if (stream.assistantText) {
        // Partial text but no result event — persist what we have.
        const messages = this.store.getMessages(id);
        messages.push({
          role: "assistant",
          text: stream.assistantText,
          ts: now(),
          tools: stream.tools.slice(),
        });
        this.store.saveMessages(id, messages);
        agent.lastActivity = now();
        agent.lastText = truncate(stream.assistantText, 140);
        agent.status = "idle";
      } else {
        agent.status = "idle";
      }
    } else {
      agent.status = "idle";
    }

    this.streams.delete(id);
    this.store.saveAgents(this.agents);
    this.broadcast({ type: "done", id, code: typeof code === "number" ? code : -1 });
    this.broadcast({ type: "agent:updated", agent: this._toSummary(agent) });
  }
}

module.exports = {
  AgentManager,
  // Exported for tests/cost-tracker.test.js — pure helpers, no side effects.
  computeTurnCostUsd,
  detectBudgetCrossing,
  COST_RATES,
};
