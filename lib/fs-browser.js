// lib/fs-browser.js
//
// Filesystem helpers for the remote-access server: a depth-bounded directory
// tree + safe single-file read. Both operations are restricted to paths that
// fall under one of the *agent-owned* roots (each agent's cwd and sandboxDir).
// Even with a valid bearer token, remote clients cannot read arbitrary files
// outside the workspaces they already had access to via the desktop UI.

const fs = require("fs");
const path = require("path");

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

// Directories we never include in trees — these blow up depth/result size
// and are rarely interesting to look at from a phone.
const IGNORE_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".cache",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".turbo",
  ".vercel",
  ".idea",
  ".vscode",
]);

function normalizePath(p) {
  if (typeof p !== "string" || !p) return null;
  try {
    return path.resolve(p);
  } catch {
    return null;
  }
}

// Returns true iff `target` is `root` itself or a descendant of `root`.
// Both inputs must already be normalized absolute paths.
function isPathUnder(target, root) {
  if (!target || !root) return false;
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return true;
}

// Build the allow-list of roots from current agents. Includes both their
// working directories and their sandbox directories.
function getAllowedRoots(manager) {
  if (!manager || typeof manager.list !== "function") return [];
  const agents = manager.list();
  const set = new Set();
  for (const a of agents) {
    const cwd = normalizePath(a.cwd);
    if (cwd && fs.existsSync(cwd)) set.add(cwd);
    const sandbox = normalizePath(a.sandboxDir);
    if (sandbox && fs.existsSync(sandbox)) set.add(sandbox);
  }
  return [...set];
}

function isAllowed(targetPath, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  return roots.some((r) => isPathUnder(targetPath, r));
}

function listTree(cwd, opts = {}) {
  const depth = Math.max(0, Math.min(4, Number(opts.depth) || 2));
  const showHidden = !!opts.showHidden;
  const target = normalizePath(cwd);
  if (!target) return { ok: false, error: "invalid_path" };
  if (!isAllowed(target, opts.roots || [])) return { ok: false, error: "not_allowed" };
  if (!fs.existsSync(target)) return { ok: false, error: "not_found" };

  function walk(dir, d) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return { name: path.basename(dir) || dir, path: dir, type: "dir", error: String(err.code || err.message) };
    }
    const children = [];
    for (const e of entries) {
      if (!showHidden && e.name.startsWith(".")) continue;
      if (e.isDirectory() && IGNORE_DIR_NAMES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d > 0) {
          children.push(walk(full, d - 1));
        } else {
          children.push({ name: e.name, path: full, type: "dir", truncated: true });
        }
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        children.push({ name: e.name, path: full, type: "file", size });
      } else if (e.isSymbolicLink()) {
        children.push({ name: e.name, path: full, type: "symlink" });
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === "dir") return -1;
        if (b.type === "dir") return 1;
      }
      return a.name.localeCompare(b.name);
    });
    return { name: path.basename(dir) || dir, path: dir, type: "dir", children };
  }

  return { ok: true, tree: walk(target, depth) };
}

function readFileForRemote(filePath, opts = {}) {
  const target = normalizePath(filePath);
  if (!target) return { ok: false, error: "invalid_path" };
  if (!isAllowed(target, opts.roots || [])) return { ok: false, error: "not_allowed" };

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, error: "not_a_file" };
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, error: "too_large", size: stat.size, maxSize: MAX_FILE_BYTES };
  }

  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (err) {
    return { ok: false, error: String(err.code || err.message) };
  }

  // Heuristic: if the first 8 KiB contain a NUL byte, treat as binary.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  const isBinary = sample.includes(0);

  if (isBinary) {
    return {
      ok: true,
      path: target,
      size: stat.size,
      encoding: "base64",
      content: buf.toString("base64"),
      mtime: stat.mtimeMs,
    };
  }
  return {
    ok: true,
    path: target,
    size: stat.size,
    encoding: "utf8",
    content: buf.toString("utf8"),
    mtime: stat.mtimeMs,
  };
}

module.exports = {
  MAX_FILE_BYTES,
  normalizePath,
  isPathUnder,
  getAllowedRoots,
  isAllowed,
  listTree,
  readFileForRemote,
};
