import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLLMJson } from '../src/llmJson.ts';

test('parses plain JSON', () => {
  assert.deepEqual(parseLLMJson('{"bugs": []}'), { bugs: [] });
});

test('strips ```json fences', () => {
  assert.deepEqual(parseLLMJson('```json\n{"action": "done"}\n```'), { action: 'done' });
});

test('strips bare ``` fences', () => {
  assert.deepEqual(parseLLMJson('```\n{"a": 1}\n```'), { a: 1 });
});

test('extracts the object from surrounding prose', () => {
  const raw = 'Sure! Here is the result:\n{"bugs": [{"title": "x"}]}\nLet me know if you need more.';
  assert.deepEqual(parseLLMJson(raw), { bugs: [{ title: 'x' }] });
});

test('handles fences plus prose together', () => {
  const raw = 'Analysis below.\n```json\n{"action": "click", "text": "Send"}\n```\nDone.';
  assert.deepEqual(parseLLMJson(raw), { action: 'click', text: 'Send' });
});

test('keeps nested braces intact', () => {
  const obj = { bugs: [{ title: 'a', meta: { nested: { deep: true } } }] };
  assert.deepEqual(parseLLMJson(`prefix ${JSON.stringify(obj)} suffix`), obj);
});

test('throws on empty response', () => {
  assert.throws(() => parseLLMJson(''));
});

test('throws when there is no JSON object', () => {
  assert.throws(() => parseLLMJson('I could not analyse this screenshot.'), /No JSON object/);
});

test('throws on malformed JSON inside braces', () => {
  assert.throws(() => parseLLMJson('{"bugs": [ }'));
});
