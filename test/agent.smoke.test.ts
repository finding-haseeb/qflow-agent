import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ROOT, startFixtureSite, startMockGemini, MOCK_SUMMARY, MOCK_VISUAL_BUG_TITLE, type TestServer,
} from './helpers.ts';

let site: TestServer;
let gemini: Awaited<ReturnType<typeof startMockGemini>>;
let workDir: string;

before(async () => {
  site = await startFixtureSite();
  gemini = await startMockGemini();
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qflow-smoke-'));
});

after(async () => {
  await site?.close();
  await gemini?.close();
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

const runAgent = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  // Agent writes output/ relative to cwd, so run it in a temp dir to keep the repo clean
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'qaAgent.mjs')], {
    cwd: workDir,
    env: {
      ...process.env,
      QFLOW_NON_INTERACTIVE: '1',
      QFLOW_URL: site.url,
      QFLOW_SCOPE: 'Smoke test',
      GEMINI_API_KEY: 'test-key',
      GEMINI_BASE_URL: gemini.url,
      QFLOW_LLM_MIN_DELAY_MS: '0',
      QFLOW_SETTLE_MS: '200',
      NAV_TIMEOUT_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});

test('agent runs a full scan end-to-end against a local site with a mocked LLM', { timeout: 300_000 }, async () => {
  const { code, stdout, stderr } = await runAgent();
  const ctx = `\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${stderr.slice(-2000)}`;

  assert.equal(code, 0, `agent exited with ${code}${ctx}`);
  assert.doesNotMatch(stdout, /LLM (vision )?call failed|vision fallback failed/, `LLM calls to the mock failed${ctx}`);

  const summary = stdout.match(/Scan complete -- (\d+) bug\(s\) found/);
  assert.ok(summary, `missing final summary${ctx}`);
  assert.match(stdout, /Workflows: \d+ total, \d+ passed, \d+ failed/);

  // The LLM exploration loop ran: scroll once, then stopped after two consecutive "done"s
  assert.match(stdout, /LLM action: scroll/);
  assert.match(stdout, /LLM has finished autonomous exploration/);
  assert.equal(gemini.getActionCalls(), 3);

  const runId = stdout.match(/Run ID : (\S+)/)?.[1];
  assert.ok(runId, `missing Run ID${ctx}`);
  const runDir = path.join(workDir, 'output', runId);
  const report = await fs.readFile(path.join(runDir, 'report.md'), 'utf-8');

  assert.match(report, /^# QA Test Report/);
  assert.ok(report.includes(site.url), 'report names the target URL');
  assert.match(report, /\| Scope \| Smoke test \|/);
  assert.match(report, new RegExp(`\\| Bugs Found \\| \\*\\*${summary[1]}\\*\\* \\|`), 'report bug count matches stdout');

  // Heuristic engine caught the deliberately broken image
  assert.match(report, /broken image/i);
  // The fenced, prose-wrapped mock reply was parsed into an AI bug
  assert.ok(report.includes(`[AI Visual] ${MOCK_VISUAL_BUG_TITLE}`), 'AI visual bug from mock is in the report');
  // The executive summary came from the mock LLM
  assert.ok(report.includes(MOCK_SUMMARY), 'executive summary from mock is in the report');

  const shots = await fs.readdir(path.join(runDir, 'screenshots'));
  assert.ok(shots.some(f => f.startsWith('baseline-desktop')), 'baseline screenshot saved');
  assert.ok(shots.length >= 3, `expected several screenshots, got ${shots.length}`);

  // Every screenshot linked from the report exists on disk
  const linked = [...report.matchAll(/\]\((screenshots\/[^)]+)\)/g)].map(m => m[1]);
  assert.ok(linked.length > 0, 'report links screenshots');
  for (const rel of linked) await fs.access(path.join(runDir, decodeURIComponent(rel)));
});
