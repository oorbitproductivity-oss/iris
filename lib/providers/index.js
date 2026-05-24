// lib/providers/index.js
//
// Provider abstraction layer. Every model backend conforms to one shape:
//
//   const p = createProvider({ name, apiKey, baseUrl, model, fetchImpl });
//   const stream = p.chat({ messages, tools, system, options });
//   for await (const event of stream) { ... }
//
// `chat` returns an async iterable of normalized stream events:
//   { type: 'text', delta: string }
//   { type: 'tool_use', id, name, input }
//   { type: 'tool_result', id, output }              // from prior turn
//   { type: 'usage', input_tokens, output_tokens }
//   { type: 'stop', reason }                         // 'end_turn' | 'tool_use' | 'length' | 'error'
//   { type: 'error', error }
//
// Adapters do the wire-format translation. The rest of Iris Code (router,
// agent loop, CLI) only sees normalized events.

const { AnthropicProvider } = require('./anthropic.js');
const { OpenAIProvider } = require('./openai.js');
const { OpenRouterProvider } = require('./openrouter.js');
const { GoogleProvider } = require('./google.js');
const { OllamaProvider } = require('./ollama.js');
const { OpenAICompatibleProvider } = require('./openai-compatible.js');

/** Provider names we ship with. */
const KNOWN_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'ollama',
  'openai-compatible',
];

/** Default models per provider (overridable). */
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  openrouter: 'anthropic/claude-sonnet-4',
  google: 'gemini-2.5-pro',
  ollama: 'llama3.1:8b',
  'openai-compatible': 'gpt-4o',
};

/** Endpoints (used by adapters that don't accept a baseUrl explicitly). */
const DEFAULT_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  google: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
};

/**
 * Factory. Pass `name` and an options bag; returns a provider instance.
 * Throws if the name is unknown.
 *
 * @param {object} opts
 * @param {string} opts.name             Provider key.
 * @param {string} [opts.apiKey]         API key/token (not required for ollama).
 * @param {string} [opts.baseUrl]        Override base URL.
 * @param {string} [opts.model]          Default model for chat() calls that don't pass one.
 * @param {Function} [opts.fetchImpl]    Override fetch (for tests).
 */
function createProvider(opts) {
  if (!opts || !opts.name) {
    throw new Error('createProvider: opts.name is required');
  }
  const name = String(opts.name).toLowerCase();
  const baseUrl = opts.baseUrl || DEFAULT_ENDPOINTS[name];
  const model = opts.model || DEFAULT_MODELS[name];
  const config = { ...opts, name, baseUrl, model };

  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'openrouter':
      return new OpenRouterProvider(config);
    case 'google':
      return new GoogleProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`createProvider: unknown provider "${opts.name}". Known: ${KNOWN_PROVIDERS.join(', ')}`);
  }
}

module.exports = {
  createProvider,
  KNOWN_PROVIDERS,
  DEFAULT_MODELS,
  DEFAULT_ENDPOINTS,
};
