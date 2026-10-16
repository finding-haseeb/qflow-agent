import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type TestServer = { url: string; close: () => Promise<void> };

const listen = async (handler: http.RequestListener): Promise<TestServer> => {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
};

export const getFreePort = async () => {
  const s = await listen(() => {});
  const port = Number(new URL(s.url).port);
  await s.close();
  return port;
};

export const waitFor = async <T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000, intervalMs = 200): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) { lastErr = err; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastErr ? `: ${lastErr}` : ''}`);
};

/** A tiny local website for the agent to scan, with one deliberately broken image */
export const startFixtureSite = () => listen((req, res) => {
  const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body><nav><a href="/">Home</a> <a href="/about">About</a></nav><main>${body}</main></body></html>`;

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Fixture Home', `
      <h1>Fixture Home</h1>
      <img src="/missing.png" alt="Broken on purpose" width="50" height="50">
      <form><label>Email <input type="email" name="email"></label><button type="submit">Send</button></form>`));
  } else if (req.url === '/about') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('About', '<h1>About</h1><p>About page.</p>'));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

export const MOCK_VISUAL_BUG_TITLE = 'Mock visual bug from fake Gemini';
export const MOCK_SUMMARY = 'MOCK EXECUTIVE SUMMARY';

/**
 * Fake Gemini REST endpoint (POST /v1beta/models/{model}:generateContent).
 * Picks a canned reply from the prompt text, so the agent's whole LLM path runs offline.
 */
export const startMockGemini = async () => {
  const prompts: string[] = [];
  let actionCalls = 0;

  const reply = (prompt: string): string => {
    if (prompt.includes('"action": "click|fill|scroll')) {
      actionCalls++;
      return actionCalls === 1
        ? JSON.stringify({ action: 'scroll', reasoning: 'Scroll to check below-the-fold content' })
        : JSON.stringify({ action: 'done', reasoning: 'Everything has been tested' });
    }
    if (prompt.includes('executive summary')) return `## ${MOCK_SUMMARY}\n\nThe fixture site looks fine.`;
    if (prompt.includes('evaluating the result of a test action')) return '{"bugs": []}';
    if (prompt.includes('USER-FACING QA BUG REPORT')) {
      // Fenced and wrapped in prose, the way real models often answer
      return 'Here is the report:\n```json\n' + JSON.stringify({
        bugs: [{ title: MOCK_VISUAL_BUG_TITLE, severity: 'Low', description: 'Injected by the test mock.', category: 'Layout' }],
      }) + '\n```';
    }
    return 'This is a simple static test website with a form and a nav bar.';
  };

  const server = await listen((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes(':generateContent')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"code":404,"message":"not found"}}');
        return;
      }
      const parsed = JSON.parse(body) as { contents: { parts: { text?: string }[] }[] };
      const prompt = parsed.contents.flatMap(c => c.parts).map(p => p.text ?? '').join('\n');
      prompts.push(prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: reply(prompt) }] }, finishReason: 'STOP', index: 0 }],
      }));
    });
  });

  return { ...server, prompts, getActionCalls: () => actionCalls };
};
