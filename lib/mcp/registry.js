// lib/mcp/registry.js
//
// MCP marketplace catalog. The canonical source is a static JSON file served
// from iris-code.pages.dev/mcp-catalog.json (no backend, no auth). A bundled
// copy ships inside the app so the marketplace works offline and on first
// run before any network call.
//
// Refreshed on demand with a 24-hour cache. The remote file is only allowed
// to ADD servers and update display metadata — `slug`, `command`, and `args`
// from the bundled copy take precedence so a compromised CDN cannot redirect
// an existing entry to a malicious package.

const fs = require("fs");
const path = require("path");
const https = require("https");

const CATALOG_URL = "https://iris-code.pages.dev/mcp-catalog.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BUNDLED_PATH = path.join(__dirname, "catalog-bundled.json");

function loadBundled() {
  try {
    const raw = fs.readFileSync(BUNDLED_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.servers)) {
      return { version: 0, servers: [] };
    }
    return data;
  } catch (err) {
    console.error("[mcp/registry] failed to load bundled catalog:", err);
    return { version: 0, servers: [] };
  }
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          finish(new Error(`http ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) {
            req.destroy();
            finish(new Error("response too large"));
          }
        });
        res.on("end", () => {
          try { finish(null, JSON.parse(body)); }
          catch (err) { finish(new Error("invalid json")); }
        });
      });
      req.on("error", (err) => finish(err));
      req.on("timeout", () => { req.destroy(); finish(new Error("timeout")); });
    } catch (err) {
      finish(err);
    }
  });
}

// Merge: bundled entries always win on the executable surface (command, args,
// env keys). Remote can update display fields and add new entries we don't
// know about. This is the safety net against a compromised catalog redirecting
// "github" to `npx evil-payload`.
function mergeCatalogs(bundled, remote) {
  if (!remote || !Array.isArray(remote.servers)) return bundled;
  const bySlug = new Map();
  for (const s of bundled.servers || []) {
    bySlug.set(s.slug, { ...s, source: "bundled" });
  }
  for (const r of remote.servers) {
    if (!r || typeof r.slug !== "string") continue;
    const existing = bySlug.get(r.slug);
    if (existing) {
      // Allow remote to refresh display fields only.
      bySlug.set(r.slug, {
        ...existing,
        description: typeof r.description === "string" ? r.description : existing.description,
        installCount: Number.isFinite(r.installCount) ? r.installCount : existing.installCount,
        tags: Array.isArray(r.tags) ? r.tags : existing.tags,
        featured: typeof r.featured === "boolean" ? r.featured : existing.featured,
        homepage: typeof r.homepage === "string" ? r.homepage : existing.homepage,
      });
    } else {
      // New entry from remote. Mark its source so the UI can show a "from
      // catalog" badge and so the user knows it isn't bundled-and-vetted.
      bySlug.set(r.slug, { ...r, source: "remote" });
    }
  }
  return {
    version: Math.max(bundled.version || 0, remote.version || 0),
    updatedAt: remote.updatedAt || bundled.updatedAt,
    servers: Array.from(bySlug.values()),
  };
}

class Registry {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cachePath = path.join(dataDir, "mcp-catalog-cache.json");
    this.bundled = loadBundled();
    this.merged = this.bundled;
    this.lastFetchAt = 0;
    this._loadCache();
  }

  _loadCache() {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const cached = JSON.parse(raw);
      if (cached && cached.fetchedAt && cached.catalog) {
        this.lastFetchAt = cached.fetchedAt;
        this.merged = mergeCatalogs(this.bundled, cached.catalog);
      }
    } catch (err) {
      console.warn("[mcp/registry] cache load failed:", err.message);
    }
  }

  _saveCache(remote) {
    try {
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify({ fetchedAt: Date.now(), catalog: remote }, null, 2),
        "utf8"
      );
    } catch (err) {
      console.warn("[mcp/registry] cache save failed:", err.message);
    }
  }

  /** Returns the currently-merged catalog (bundled + cached remote). */
  getCatalog() {
    return this.merged;
  }

  /** Returns a single server by slug or null. */
  getServer(slug) {
    return (this.merged.servers || []).find((s) => s.slug === slug) || null;
  }

  /**
   * Force-refresh the remote catalog. Caller can pass `{ force: true }` to
   * bypass the 24-hour TTL. Returns the merged catalog on success, or the
   * existing one on failure (network problems must never break the UI).
   */
  async refresh({ force = false } = {}) {
    if (!force && Date.now() - this.lastFetchAt < CACHE_TTL_MS) {
      return this.merged;
    }
    try {
      const remote = await fetchJson(CATALOG_URL);
      this.lastFetchAt = Date.now();
      this.merged = mergeCatalogs(this.bundled, remote);
      this._saveCache(remote);
    } catch (err) {
      console.warn("[mcp/registry] refresh failed, keeping cached:", err.message);
    }
    return this.merged;
  }
}

module.exports = { Registry, loadBundled, mergeCatalogs };
