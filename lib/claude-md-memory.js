// lib/memory.js
//
// CLAUDE.md memory-file helpers, factored out of main.js so the IPC layer and
// the remote-access server can share the same implementation.

const fs = require("fs");
const path = require("path");

function safeMemoryPath(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  if (!path.isAbsolute(cwd)) return null;
  return path.join(cwd, "CLAUDE.md");
}

function readMemory(cwd) {
  const p = safeMemoryPath(cwd);
  if (!p) return { ok: false, error: "invalid cwd" };
  try {
    if (!fs.existsSync(p)) return { ok: true, content: "", path: p, existed: false };
    const content = fs.readFileSync(p, "utf8");
    return { ok: true, content, path: p, existed: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err), path: p };
  }
}

function writeMemory(cwd, content) {
  const p = safeMemoryPath(cwd);
  if (!p) return { ok: false, error: "invalid cwd" };
  if (typeof content !== "string") return { ok: false, error: "content must be string" };
  try {
    if (!fs.existsSync(cwd)) return { ok: false, error: "cwd does not exist" };
    fs.writeFileSync(p, content, "utf8");
    return { ok: true, path: p, bytes: Buffer.byteLength(content, "utf8") };
  } catch (err) {
    return { ok: false, error: String(err.message || err), path: p };
  }
}

module.exports = { safeMemoryPath, readMemory, writeMemory };
