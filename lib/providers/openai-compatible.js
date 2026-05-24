// lib/providers/openai-compatible.js
//
// Generic adapter for any service that speaks the OpenAI Chat Completions
// wire format (LM Studio, vLLM, Together, Groq, Anyscale, etc.). The only
// thing the user has to provide is the `baseUrl`.

const { OpenAIProvider } = require('./openai.js');

class OpenAICompatibleProvider extends OpenAIProvider {}

module.exports = { OpenAICompatibleProvider };
