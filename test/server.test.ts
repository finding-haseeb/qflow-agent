import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ROOT, getFreePort, waitFor, startFixtureSite, startMockGemini, type TestServer } from './helpers.ts';

type ServerHandle = { base: string; proc: ChildProcess; stop: () => Promise<void> };

/** Boot dist/server.mjs on a free port. Gemini is pointed at a local mock so no real API calls are made. */
const startServer = async (extraEnv: Record<string, string>): Promise<ServerHandle> => {
  const port = await getFreePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout!.on('data', d => { output += d; });
  proc.stderr!.on('data', d => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined), 10_000);
  } catch (err) {
    proc.kill();
    throw new Error(`Server did not start: ${err}\n${output}`);
  }
  return {
    base,
    proc,
    stop: () => new Promise(resolve => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
    }),
  };
};

describe('server (auth disabled)', () => {
  let srv: ServerHandle;
  let gemini: TestServer;
  let site: TestServer;
  const createdOutputDirs: string[] = [];

  before(async () => {
    gemini = await startMockGemini();
    site = await startFixtureSite();
    srv = await startServer({
      GEMINI_API_KEY: 'test-key',
      GEMINI_BASE_URL: gemini.url,
      QFLOW_LLM_MIN_DELAY_MS: '0',
      QFLOW_SETTLE_MS: '200',
    });
  });

  after(async () => {
    await srv?.stop();
    await gemini?.close();
    await site?.close();
    for (const dir of createdOutputDirs) await fs.rm(path.join(ROOT, dir), { recursive: true, force: true });
  });

  test('serves landing page, dashboard and static assets', async () => {
    for (const p of ['/', '/app.html', '/marked.min.js']) {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 200, p);
    }
    const html = await (await fetch(srv.base + '/')).text();
    assert.match(html, /QFlow/);
  });

  test('GET /api/health reports ok', async () => {
    const body = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
  });

  test('GET /auth/me returns the local user when auth is off', async () => {
    const body = await (await fetch(`${srv.base}/auth/me`)).json();
    assert.deepEqual(body, { user: 'local', avatar: '', authEnabled: false });
  });

  test('GET /auth/login redirects straight to the dashboard', async () => {
    const res = await fetch(`${srv.base}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/app.html');
  });

  test('POST /auth/logout clears the session cookie', async () => {
    const res = await fetch(`${srv.base}/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /qflow_session=;.*Max-Age=0/);
  });

  test('POST /api/scan rejects a missing URL', async () => {
    const res = await fetch(`${srv.base}/api/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'URL is required' });
  });

  test('unknown scan ids return 404 on every scan route', async () => {
    for (const p of ['', '/logs', '/report', '/download']) {
      const res = await fetch(`${srv.base}/api/scans/does-not-exist${p}`);
      assert.equal(res.status, 404, p || '(details)');
    }
    const cancel = await fetch(`${srv.base}/api/scans/does-not-exist/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 404);
  });

  test('scan lifecycle: start, live logs over WebSocket, 409 on concurrent scan, cancel', async () => {
    const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws`);
    const messages: { scanId: string; type: string; line?: string; status?: string; cancelled?: boolean }[] = [];
    ws.on('message', d => messages.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    try {
      const start = await fetch(`${srv.base}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: site.url, scope: 'server test' }),
      });
      assert.equal(start.status, 200);
      const { scanId } = await start.json();
      assert.match(scanId, /^scan-\d+$/);

      // The agent prints its Run ID early; the server parses it into outputDir
      const details = await waitFor(async () => {
        const d = await (await fetch(`${srv.base}/api/scans/${scanId}`)).json();
        return d.outputDir ? d : undefined;
      });
      createdOutputDirs.push(details.outputDir);
      assert.equal(details.status, 'running');
      assert.equal(details.url, site.url);
      assert.equal(details.scope, 'server test');

      const busy = await fetch(`${srv.base}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: site.url }),
      });
      assert.equal(busy.status, 409);

      const list = await (await fetch(`${srv.base}/api/scans`)).json();
      assert.equal(list.scans[0].id, scanId);

      const logs = await (await fetch(`${srv.base}/api/scans/${scanId}/logs`)).json();
      assert.ok(logs.logs.some((l: string) => l.includes('Run ID :')), 'logs include Run ID');
      assert.ok(messages.some(m => m.scanId === scanId && m.type === 'log'), 'log lines were broadcast over WebSocket');

      const cancel = await fetch(`${srv.base}/api/scans/${scanId}/cancel`, { method: 'POST' });
      assert.equal(cancel.status, 200);
      await waitFor(async () => (messages.some(m => m.type === 'complete' && m.cancelled) ? true : undefined));

      const after = await (await fetch(`${srv.base}/api/scans/${scanId}`)).json();
      assert.equal(after.status, 'error');
      assert.ok(after.completedAt >= after.startedAt);

      const again = await fetch(`${srv.base}/api/scans/${scanId}/cancel`, { method: 'POST' });
      assert.equal(again.status, 400);
    } finally {
      ws.close();
    }
  });
});

describe('server (GitHub auth enabled)', () => {
  let srv: ServerHandle;

  before(async () => {
    srv = await startServer({ GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' });
  });
  after(async () => { await srv?.stop(); });

  test('API routes require a session', async () => {
    for (const p of ['/api/scans', '/api/scans/x', '/api/scans/x/logs', '/auth/me']) {
      const res = await fetch(srv.base + p);
      assert.equal(res.status, 401, p);
    }
    const scan = await fetch(`${srv.base}/api/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"http://x"}',
    });
    assert.equal(scan.status, 401);
  });

  test('a forged session cookie is rejected', async () => {
    const res = await fetch(`${srv.base}/api/scans`, { headers: { cookie: 'qflow_session=forged' } });
    assert.equal(res.status, 401);
  });

  test('health and public pages stay open', async () => {
    assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);
    assert.equal((await fetch(`${srv.base}/`)).status, 200);
  });

  test('/auth/login redirects to GitHub OAuth with the client id', async () => {
    const res = await fetch(`${srv.base}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'test-client');
    assert.match(loc.searchParams.get('state') ?? '', /^[0-9a-f]{32}$/);
  });

  test('/auth/callback without a code is a 400', async () => {
    const res = await fetch(`${srv.base}/auth/callback`);
    assert.equal(res.status, 400);
  });

  test('WebSocket connections without a session are closed with 4001', async () => {
    const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws`);
    const code = await new Promise<number>(resolve => ws.once('close', c => resolve(c)));
    assert.equal(code, 4001);
  });
});
