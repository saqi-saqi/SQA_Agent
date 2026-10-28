/**
 * llmProvider.js — pluggable LLM provider interface for the Explorer.
 *
 * The Explorer never calls an SDK directly; it calls this module. That way:
 *   • Tests can inject a MockProvider with canned responses
 *   • Users can swap z-ai-web-dev-sdk for OpenAI / Anthropic / local Llama
 *     by writing a thin adapter and calling setDefaultProvider(adapter).
 *
 * Provider interface:
 *   {
 *     name:    string,
 *     chat:    async ({ system, user, json, temperature }) =>
 *                { ok: true,  content: string } |
 *                { ok: false, error: string }
 *   }
 *
 * `json: true` tells the provider to enforce JSON-only output. The caller
 * still parses — providers may wrap JSON in markdown fences despite the
 * instruction, so we strip fences defensively in parseJsonResponse().
 *
 * NOTE: z-ai-web-dev-sdk is loaded lazily — the project doesn't depend on
 * it being installed at import time. Tests use MockProvider and never
 * trigger the lazy import; production users install the SDK and call
 * `await ZaiSdkProvider.create()` (or just use the default).
 */

// ─── provider registry ───────────────────────────────────────────────

let defaultProvider = null;

export function setDefaultProvider(provider) {
  if (!provider || typeof provider.chat !== 'function') {
    throw new Error('Provider must have a chat() function');
  }
  defaultProvider = provider;
}

export function getDefaultProvider() {
  if (!defaultProvider) {
    defaultProvider = new ZaiSdkProvider();
  }
  return defaultProvider;
}

// ─── default provider: z-ai-web-dev-sdk (lazy import) ────────────────

export class ZaiSdkProvider {
  constructor() {
    this.name = 'zai-sdk';
    this._zai = null;
    this._initPromise = null;
  }

  /**
   * Explicit initialization — useful if the caller wants to fail fast
   * when the SDK isn't installed. Returns the same instance.
   */
  async create() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        // Lazy import so the project compiles + tests run without the SDK
        // installed. The SDK is required only when the default provider
        // is actually used (i.e. production runs against a real LLM).
        const ZAIModule = await import('z-ai-web-dev-sdk').catch(err => {
          throw new Error(
            `z-ai-web-dev-sdk is not installed. Install it with 'npm i z-ai-web-dev-sdk' ` +
            `or call setDefaultProvider() with a different provider. Original error: ${err.message}`
          );
        });
        const ZAI = ZAIModule.default || ZAIModule;
        this._zai = await ZAI.create();
        return this._zai;
      })();
    }
    return this._initPromise;
  }

  async chat({ system, user, json = false, temperature = 0.2 }) {
    try {
      const zai = await this.create();

      // The skill examples use role:'assistant' for the system message
      // (z-ai-web-dev-sdk quirk). We follow the same convention here.
      const messages = [];
      if (system) {
        messages.push({
          role: 'assistant',
          content: json
            ? `${system}\n\nRespond with valid JSON only. No markdown fences, no prose.`
            : system,
        });
      }
      messages.push({ role: 'user', content: user });

      const completion = await zai.chat.completions.create({
        model: process.env.SQA_LLM_MODEL || 'glm-4.7-flash',
        messages,
        thinking: { type: 'disabled' },
        temperature,
      });

      const content = completion?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        return { ok: false, error: 'Empty LLM response' };
      }
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
}

// ─── mock provider (for tests) ───────────────────────────────────────

/**
 * MockProvider — returns canned responses based on a key matched against
 * the user prompt. Lets tests drive the Explorer deterministically.
 *
 * Usage:
 *   const mock = new MockProvider({
 *     'infer-flows':  { flows: [...] },
 *     'infer-api':    { endpoints: [...] },
 *     'summarize':    { pages: [...] },
 *   });
 *   setDefaultProvider(mock);
 *
 * Keys are matched by substring against the user prompt.
 */
export class MockProvider {
  constructor(responses = {}) {
    this.name = 'mock';
    this.responses = responses;
    this.calls = [];  // record of all invocations for assertions
  }

  async chat({ system, user, json = false }) {
    this.calls.push({ system, user, json });

    for (const [key, value] of Object.entries(this.responses)) {
      if (user.includes(key) || (system && system.includes(key))) {
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        return { ok: true, content };
      }
    }
    // Default: return empty JSON object so callers can still parse
    return { ok: true, content: json ? '{}' : '' };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Defensive JSON parse — strips markdown fences + leading/trailing prose.
 * Returns { ok: true, data } | { ok: false, error }.
 */
export function parseJsonResponse(content) {
  if (!content || typeof content !== 'string') {
    return { ok: false, error: 'No content to parse' };
  }

  let text = content.trim();

  // Strip ```json ... ``` or ``` ... ``` fences
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // If there's still leading prose, try to slice from the first { or [
  const firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) {
    text = text.slice(firstBrace);
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}

/**
 * High-level helper: ask the LLM for JSON, parse, return data.
 * Falls back to {} on error (and logs).
 */
export async function chatJson({ system, user, temperature }, opts = {}) {
  const provider = opts.provider || getDefaultProvider();
  const res = await provider.chat({ system, user, json: true, temperature });
  if (!res.ok) {
    return { ok: false, error: res.error, data: null };
  }
  const parsed = parseJsonResponse(res.content);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, data: null, raw: res.content };
  }
  return { ok: true, data: parsed.data, raw: res.content };
}
