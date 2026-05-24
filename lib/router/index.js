// lib/router/index.js
//
// The smart router. Given the user's message + recent context, picks one of:
//   - manual      one model call, no tools, no loop          (cheap, fast)
//   - quick-tool  ≤5 tool calls, no autonomous follow-on     (medium)
//   - agentic     full Hermes loop with memory + skills      (heavy)
//
// Strategy: a fast heuristic ruleset handles 90% of cases (the obvious
// "rename this var" → manual; "build me X" → agentic). For ambiguous ones
// we call the configured LLM with a one-shot classifier prompt. Either way
// we return one of the three labels.
//
// Hard overrides (slash commands / flags / GUI buttons) bypass this entirely
// and are wired up by the caller; the router itself only sees the model's
// view of the request.

'use strict';

const fs = require('fs');
const path = require('path');

const ROUTES = ['manual', 'quick-tool', 'agentic'];
const DEFAULT_ROUTE = 'quick-tool';

class Router {
  constructor({ provider, examplesFile } = {}) {
    this.provider = provider || null;
    this.examplesFile = examplesFile || path.join(__dirname, 'prompts.md');
  }

  /**
   * Synchronous fast-path heuristics. Returns a route name or null if the
   * heuristics aren't confident.
   */
  fastClassify(userText) {
    if (!userText || typeof userText !== 'string') return DEFAULT_ROUTE;
    const t = userText.trim();
    const lower = t.toLowerCase();
    const wc = t.split(/\s+/).length;

    // Very short, obviously-conversational asks → manual.
    const manualVerbs = ['rename', 'explain', 'what is', 'what does', 'why does', 'define', 'tldr', 'summarize'];
    if (wc <= 25 && manualVerbs.some((v) => lower.startsWith(v) || lower.startsWith('please ' + v))) {
      return 'manual';
    }

    // "build me", "implement", "set up the X feature" → agentic.
    const agenticTriggers = [
      'build me', 'implement', 'set up', 'scaffold', 'create a new', 'add a feature',
      'add support for', 'wire up', 'refactor the whole', 'migrate', 'port to',
      'design and implement', 'do the rest', 'finish the implementation',
    ];
    if (agenticTriggers.some((s) => lower.includes(s))) return 'agentic';

    // Quick-tool triggers: searches, single greps, run-the-X commands.
    const quickTriggers = [
      'find every', 'grep for', 'search for', 'list all', 'run the tests',
      'run tests', 'open the', 'show me the', 'where is', 'which file',
    ];
    if (quickTriggers.some((s) => lower.includes(s))) return 'quick-tool';

    // Long, multi-paragraph requests usually need the agent.
    if (t.length > 600 || /\n.*\n.*\n/.test(t)) return 'agentic';

    return null;
  }

  /**
   * Async classifier. Uses fast heuristics first; falls back to the LLM if
   * the heuristic is unsure. Always resolves to a valid route.
   */
  async classify(userText, _historyMessages = []) {
    const fast = this.fastClassify(userText);
    if (fast) return fast;

    if (!this.provider) return DEFAULT_ROUTE;

    // LLM classifier — one tiny call, no tools.
    const system = this._systemPrompt();
    const messages = [{ role: 'user', content: `User message:\n"""\n${userText}\n"""\n\nReply with exactly one word: manual, quick-tool, or agentic.` }];
    let out = '';
    try {
      const stream = this.provider.chat({
        messages,
        system,
        options: { maxTokens: 8 },
      });
      for await (const ev of stream) {
        if (ev.type === 'text') out += ev.delta;
        if (ev.type === 'stop' || ev.type === 'error') break;
      }
    } catch {
      return DEFAULT_ROUTE;
    }
    const label = out.trim().toLowerCase().match(/(manual|quick-tool|agentic)/);
    return label ? label[1] : DEFAULT_ROUTE;
  }

  _systemPrompt() {
    // The prompts.md file is editable by users for tuning.
    if (fs.existsSync(this.examplesFile)) {
      try { return fs.readFileSync(this.examplesFile, 'utf8'); } catch {}
    }
    return DEFAULT_SYSTEM_PROMPT;
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are a router. Classify the user's coding request into exactly one of:

- manual      One model call, no tools. For short conversational or explanatory asks.
- quick-tool  Up to ~5 tool calls, no autonomous loop. For searches, single runs, lookups.
- agentic    Full autonomous loop. For multi-step build, implement, refactor, or migration work.

Examples:
- "rename this variable to snake_case" -> manual
- "what does this regex do?" -> manual
- "find every TODO in src/" -> quick-tool
- "run the tests and tell me which pass" -> quick-tool
- "build the auth flow with email verification" -> agentic
- "refactor the whole router module to support streaming" -> agentic

Reply with exactly one word: manual, quick-tool, or agentic.`;

module.exports = { Router, ROUTES, DEFAULT_ROUTE };
