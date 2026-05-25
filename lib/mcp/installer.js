// lib/mcp/installer.js
//
// Manages MCP server installs (which servers are enabled, with what scope and
// secret bindings) and produces the per-spawn runtime config the agent manager
// hands to the `claude` CLI via `--mcp-config <path>`.
//
// Storage
//   mcp-installs.json  (plaintext, in store.dataDir)
//     {
//       installs: [
//         {
//           id: "uuid",
//           slug: "github",
//           scope: "global" | "agent:<agentId>",
//           // Map of env var name (as declared in the catalog) to the id of an
//           // entry in store.getMcpSecrets() — values are never inlined here.
//           envBindings: { "GITHUB_PERSONAL_ACCESS_TOKEN": "<secretId>" },
//           // Optional non-secret config (e.g. allowed dir for filesystem MCP)
//           config: { "ALLOWED_DIR": "C:/work" },
//           addedAt: 1716553200000
//         }
//       ]
//     }
//
// Secret values themselves live in store.mcpSecrets (encrypted, AES-GCM /
// safeStorage — same pattern as API keys).
//
// Runtime config
//   At spawn time, `buildRuntimeConfig(agentId)` returns:
//     { configPath: <abs path>, envOverlay: { VAR: "literal value", ... } }
//   The temp file at `configPath` contains the merged set of servers with env
//   values referenced as ${VAR_NAME}; the actual secrets ride in via
//   envOverlay, which the agent manager merges into the spawn env.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RUNTIME_DIR_NAME = "mcp-runtime";

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return fallback;
  try { return JSON.parse(raw); }
  catch (err) {
    console.error("[mcp/installer] failed to parse", file, err);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class Installer {
  /**
   * @param {{ dataDir: string, registry: import('./registry').Registry, store: any }} opts
   */
  constructor({ dataDir, registry, store }) {
    if (!dataDir) throw new Error("Installer: dataDir required");
    if (!registry) throw new Error("Installer: registry required");
    if (!store) throw new Error("Installer: store required");
    this.dataDir = dataDir;
    this.registry = registry;
    this.store = store;
    this.installsFile = path.join(dataDir, "mcp-installs.json");
    this.runtimeDir = path.join(dataDir, RUNTIME_DIR_NAME);
    ensureDir(this.runtimeDir);
  }

  _load() {
    const data = readJson(this.installsFile, { installs: [] });
    if (!Array.isArray(data.installs)) data.installs = [];
    return data;
  }

  _save(data) {
    writeJson(this.installsFile, data);
  }

  /** Public list — strips nothing; envBindings hold ids only. */
  list() {
    return this._load().installs.slice();
  }

  /** Filter by scope: "global", "agent:<id>", or both. */
  listForAgent(agentId) {
    const installs = this._load().installs;
    const scopeStr = `agent:${agentId}`;
    return installs.filter((i) => i.scope === "global" || i.scope === scopeStr);
  }

  /**
   * Install (or update) a server.
   * @param {object} opts
   * @param {string} opts.slug       Catalog slug ("github", "playwright", …)
   * @param {string} [opts.scope]    "global" (default) or "agent:<agentId>"
   * @param {Object<string,string>} [opts.secrets]
   *   Map of env-var key → plaintext value. Each gets encrypted and stored.
   * @param {Object<string,string>} [opts.config]
   *   Map of non-secret config var → literal value.
   * @returns {object} the install record (with secret ids, not values)
   */
  install({ slug, scope = "global", secrets = {}, config = {} } = {}) {
    const server = this.registry.getServer(slug);
    if (!server) throw new Error(`unknown MCP server slug: ${slug}`);
    if (scope !== "global" && !/^agent:[\w-]+$/.test(scope)) {
      throw new Error(`invalid scope: ${scope}`);
    }
    // Validate required secrets are provided (only on first install).
    const required = (server.secrets || []).filter((s) => s.required).map((s) => s.key);
    const data = this._load();
    const existingIdx = data.installs.findIndex((i) => i.slug === slug && i.scope === scope);
    const existing = existingIdx >= 0 ? data.installs[existingIdx] : null;
    const envBindings = existing ? { ...existing.envBindings } : {};
    const cfg = existing ? { ...existing.config } : {};

    for (const def of (server.secrets || [])) {
      const provided = Object.prototype.hasOwnProperty.call(secrets, def.key);
      if (provided && typeof secrets[def.key] === "string" && secrets[def.key].length > 0) {
        // Rotate / create a new vault entry; drop the old one if any.
        if (envBindings[def.key]) {
          try { this.store.deleteMcpSecret(envBindings[def.key]); } catch {}
        }
        const rec = this.store.addMcpSecret({
          name: `${slug}/${def.key}`,
          value: secrets[def.key],
        });
        envBindings[def.key] = rec.id;
      }
      if (def.required && !envBindings[def.key]) {
        throw new Error(`missing required secret: ${def.key} (${def.label || def.key})`);
      }
    }
    for (const def of (server.config || [])) {
      if (Object.prototype.hasOwnProperty.call(config, def.key)) {
        cfg[def.key] = String(config[def.key]);
      }
      if (def.required && !cfg[def.key]) {
        throw new Error(`missing required config: ${def.key} (${def.label || def.key})`);
      }
    }

    const record = {
      id: existing ? existing.id : crypto.randomUUID(),
      slug,
      scope,
      envBindings,
      config: cfg,
      addedAt: existing ? existing.addedAt : Date.now(),
      updatedAt: Date.now(),
    };
    if (existing) data.installs[existingIdx] = record;
    else data.installs.push(record);
    this._save(data);
    // Suppress unused var lint for `required` — it's a documentation hint that
    // the loop above is the actual validator.
    void required;
    return record;
  }

  uninstall(installId) {
    const data = this._load();
    const rec = data.installs.find((i) => i.id === installId);
    if (!rec) return false;
    for (const secretId of Object.values(rec.envBindings || {})) {
      try { this.store.deleteMcpSecret(secretId); } catch {}
    }
    data.installs = data.installs.filter((i) => i.id !== installId);
    this._save(data);
    return true;
  }

  /**
   * Build the .mcp.json the CLI will read for this spawn.
   *
   * Returns { configPath, envOverlay } when at least one install is in scope;
   * returns null when there are no installs (so the agent manager can skip
   * passing --mcp-config entirely).
   *
   * Important: the file written to disk does NOT contain secret values. Each
   * env value is the literal string "${VAR_NAME}" — the actual value is in
   * envOverlay and is merged into the spawn process env, which the claude CLI
   * propagates to MCP server subprocesses.
   *
   * Substitution: claude code's --mcp-config supports ${ENV_VAR} substitution
   * in both env values and args (matches the VSCode MCP spec). For args, we
   * substitute at write time using non-secret config only (path-like values);
   * if an arg references a secret, we substitute it inline at write time and
   * shred the file immediately after spawn (handled by the agent manager).
   */
  buildRuntimeConfig(agentId) {
    const installs = this.listForAgent(agentId || "");
    if (!installs.length) return null;

    const mcpServers = {};
    const envOverlay = {};
    const filesToShred = [];

    for (const inst of installs) {
      const server = this.registry.getServer(inst.slug);
      if (!server || !server.command) continue;

      // Resolve env: catalog declares VAR -> ${VAR} placeholder; envBindings
      // resolves the actual value out of the encrypted vault into envOverlay.
      const envOut = {};
      for (const [envKey, placeholder] of Object.entries(server.env || {})) {
        envOut[envKey] = placeholder; // typically "${ENV_KEY}"
        const secretId = inst.envBindings[envKey];
        if (secretId) {
          const val = this.store.getMcpSecretValue(secretId);
          if (val != null) envOverlay[envKey] = val;
        } else if (inst.config && Object.prototype.hasOwnProperty.call(inst.config, envKey)) {
          envOverlay[envKey] = String(inst.config[envKey]);
        }
      }

      // Args: substitute ${VAR} from secrets + config + envOverlay so even
      // CLIs that don't honor env-substitution in arg positions (some MCP
      // servers take a connection string positionally) still receive the
      // resolved literal.
      const args = (server.args || []).map((arg) => {
        if (typeof arg !== "string") return arg;
        return arg.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key) => {
          const secretId = inst.envBindings[key];
          if (secretId) {
            const val = this.store.getMcpSecretValue(secretId);
            if (val != null) return val;
          }
          if (inst.config && Object.prototype.hasOwnProperty.call(inst.config, key)) {
            return String(inst.config[key]);
          }
          if (envOverlay[key] != null) return envOverlay[key];
          return match;
        });
      });

      // Per-server entry. claude CLI keys this by name; use slug for stability.
      mcpServers[inst.slug] = {
        command: server.command,
        args,
        env: envOut,
      };
    }

    if (Object.keys(mcpServers).length === 0) return null;

    const configPath = path.join(this.runtimeDir, `agent-${agentId || "global"}.json`);
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), "utf8");
    try { fs.chmodSync(configPath, 0o600); } catch {}
    filesToShred.push(configPath);

    return { configPath, envOverlay, filesToShred };
  }

  /** Best-effort cleanup of a runtime config file. */
  shred(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }
}

module.exports = { Installer };
