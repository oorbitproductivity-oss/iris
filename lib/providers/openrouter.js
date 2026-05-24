// lib/providers/openrouter.js
//
// OpenRouter speaks the OpenAI Chat Completions wire format with a couple of
// extra recommended headers. We subclass the OpenAI adapter and override the
// constructor to wire up the right baseUrl + extra headers via fetchImpl.

const { OpenAIProvider } = require('./openai.js');

class OpenRouterProvider extends OpenAIProvider {
  constructor(config) {
    super(config);
    const originalFetch = this.fetchImpl;
    const referrer = (config && config.referrer) || 'https://iris-code.dev';
    const title = (config && config.title) || 'Iris Code';
    this.fetchImpl = (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (!headers.has('http-referer')) headers.set('http-referer', referrer);
      if (!headers.has('x-title')) headers.set('x-title', title);
      return originalFetch(url, { ...init, headers });
    };
  }
}

module.exports = { OpenRouterProvider };
