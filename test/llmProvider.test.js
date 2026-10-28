import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZaiSdkProvider,
  MockProvider,
  setDefaultProvider,
  getDefaultProvider,
  parseJsonResponse,
  chatJson,
} from '../src/explorer/llmProvider.js';

describe('llmProvider — MockProvider', () => {
  it('returns canned responses based on key match in user prompt', async () => {
    const mock = new MockProvider({
      'infer-flows': { flows: [{ name: 'login', startUrl: 'https://x.com', steps: [] }] },
    });
    const res = await mock.chat({
      system: 'sys',
      user: 'Please infer-flows for me',
      json: true,
    });
    assert.equal(res.ok, true);
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.flows[0].name, 'login');
  });

  it('matches keys against system prompt as well', async () => {
    const mock = new MockProvider({
      'summarize': 'This is a marketing site.',
    });
    const res = await mock.chat({
      system: 'You are a summarizer',
      user: 'anything',
      json: false,
    });
    assert.equal(res.ok, true);
    assert.equal(res.content, 'This is a marketing site.');
  });

  it('returns empty JSON {} when no key matches and json=true', async () => {
    const mock = new MockProvider({});
    const res = await mock.chat({ user: 'unmatched', json: true });
    assert.equal(res.ok, true);
    assert.equal(res.content, '{}');
  });

  it('records calls for assertion', async () => {
    const mock = new MockProvider({ foo: 'bar' });
    await mock.chat({ user: 'foo prompt' });
    await mock.chat({ user: 'foo again' });
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].user, 'foo prompt');
  });
});

describe('llmProvider — parseJsonResponse', () => {
  it('parses clean JSON', () => {
    const r = parseJsonResponse('{"a":1}');
    assert.equal(r.ok, true);
    assert.equal(r.data.a, 1);
  });

  it('strips ```json fences', () => {
    const r = parseJsonResponse('```json\n{"a":2}\n```');
    assert.equal(r.ok, true);
    assert.equal(r.data.a, 2);
  });

  it('strips bare ``` fences', () => {
    const r = parseJsonResponse('```\n{"a":3}\n```');
    assert.equal(r.ok, true);
    assert.equal(r.data.a, 3);
  });

  it('slices leading prose before JSON', () => {
    const r = parseJsonResponse('Here is the response:\n{"a":4}');
    assert.equal(r.ok, true);
    assert.equal(r.data.a, 4);
  });

  it('returns ok:false for non-JSON', () => {
    const r = parseJsonResponse('not json at all');
    assert.equal(r.ok, false);
    assert.match(r.error, /parse failed/i);
  });

  it('handles arrays', () => {
    const r = parseJsonResponse('[1, 2, 3]');
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, [1, 2, 3]);
  });

  it('handles null / empty input', () => {
    assert.equal(parseJsonResponse(null).ok, false);
    assert.equal(parseJsonResponse('').ok, false);
    assert.equal(parseJsonResponse(undefined).ok, false);
  });
});

describe('llmProvider — provider registry', () => {
  const originalDefault = Symbol('original');
  before(() => {
    // save default provider (don't trigger lazy init)
  });

  afterEach(() => {
    // Reset to fresh ZaiSdkProvider after each test
    setDefaultProvider(new ZaiSdkProvider());
  });

  it('setDefaultProvider rejects non-chat objects', () => {
    assert.throws(() => setDefaultProvider({}), /chat.*function/i);
    assert.throws(() => setDefaultProvider(null), /chat.*function/i);
  });

  it('getDefaultProvider returns the registered provider', () => {
    const mock = new MockProvider({ foo: 'bar' });
    setDefaultProvider(mock);
    assert.equal(getDefaultProvider(), mock);
  });

  it('chatJson uses the registered provider', async () => {
    const mock = new MockProvider({ 'test-key': { result: 42 } });
    setDefaultProvider(mock);
    const r = await chatJson({ system: 'sys', user: 'test-key' });
    assert.equal(r.ok, true);
    assert.equal(r.data.result, 42);
  });

  it('chatJson returns ok:false when provider errors', async () => {
    const failingMock = {
      name: 'failing',
      chat: async () => ({ ok: false, error: 'simulated failure' }),
    };
    setDefaultProvider(failingMock);
    const r = await chatJson({ user: 'anything' });
    assert.equal(r.ok, false);
    assert.match(r.error, /simulated failure/i);
  });

  it('chatJson returns ok:false when JSON parse fails', async () => {
    const mock = new MockProvider({});
    // Override chat to return non-JSON despite json=true
    mock.chat = async () => ({ ok: true, content: 'this is not json' });
    setDefaultProvider(mock);
    const r = await chatJson({ user: 'anything', json: true });
    assert.equal(r.ok, false);
  });
});

describe('ZaiSdkProvider', () => {
  it('has name "zai-sdk"', () => {
    const p = new ZaiSdkProvider();
    assert.equal(p.name, 'zai-sdk');
  });

  it('lazy-initializes the SDK client', async () => {
    const p = new ZaiSdkProvider();
    // Before any call, _zai should be null
    assert.equal(p._zai, null);
    // chat() should trigger initialization; if SDK fails to create (offline
    // env), it returns ok:false rather than throwing.
    const res = await p.chat({ user: 'hello' });
    // Either ok or not — depends on env. We just assert shape.
    assert.ok(typeof res.ok === 'boolean');
    if (!res.ok) {
      assert.ok(typeof res.error === 'string');
    } else {
      assert.ok(typeof res.content === 'string');
    }
  });
});
