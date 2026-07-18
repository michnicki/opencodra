import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { chromium } from 'playwright';

const host = '127.0.0.1';
const port = 4177;
const baseUrl = `http://${host}:${port}`;
const outputDir = 'docs/design/renders';

const now = new Date('2026-07-18T10:00:00.000Z');
const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();

const jobs = [
  {
    id: '6fb7e938-e982-4f2e-8e7c-2a56cf09fb1d',
    owner: 'opencodra',
    repo: 'console',
    prNumber: 184,
    prTitle: 'Harden webhook signature verification',
    prAuthor: 'mara',
    commitSha: 'dc891da',
    trigger: 'auto',
    status: 'done',
    verdict: 'approve',
    fileCount: 12,
    commentCount: 3,
    totalInputTokens: 18420,
    totalOutputTokens: 2240,
    createdAt: ago(18),
    updatedAt: ago(11),
    startedAt: ago(17),
    finishedAt: ago(11),
    errorMessage: null,
    overallConfidenceScore: 0.94,
    steps: [],
  },
  {
    id: '37fb12ef-4ee6-47f7-96df-a1553f80ee88',
    owner: 'opencodra',
    repo: 'review-engine',
    prNumber: 412,
    prTitle: 'Add repository-aware confidence thresholds',
    prAuthor: 'alex',
    commitSha: 'd94f80a',
    trigger: 'mention',
    status: 'running',
    verdict: null,
    fileCount: 8,
    commentCount: 0,
    totalInputTokens: 9320,
    totalOutputTokens: 610,
    createdAt: ago(8),
    updatedAt: ago(2),
    startedAt: ago(7),
    finishedAt: null,
    errorMessage: null,
    overallConfidenceScore: null,
    steps: [
      { name: 'prepare', status: 'done', startedAt: ago(7), finishedAt: ago(6), error: null },
      { name: 'review', status: 'running', startedAt: ago(6), finishedAt: null, error: null },
      { name: 'finalize', status: 'pending', startedAt: null, finishedAt: null, error: null },
    ],
  },
  {
    id: '73f5b030-30fa-4592-9e1a-736d55778743',
    owner: 'platform',
    repo: 'edge-runtime',
    prNumber: 96,
    prTitle: 'Reduce cold-start latency in queue workers',
    prAuthor: 'samira',
    commitSha: '2848abe',
    trigger: 'auto',
    status: 'done',
    verdict: 'comment',
    fileCount: 21,
    commentCount: 7,
    totalInputTokens: 31640,
    totalOutputTokens: 4810,
    createdAt: ago(74),
    updatedAt: ago(61),
    startedAt: ago(72),
    finishedAt: ago(61),
    errorMessage: null,
    overallConfidenceScore: 0.88,
    steps: [],
  },
  {
    id: 'd7a15c66-bca4-4ab6-a433-fb338ffdb978',
    owner: 'infrastructure',
    repo: 'deployments',
    prNumber: 238,
    prTitle: 'Rotate production model credentials',
    prAuthor: 'noah',
    commitSha: '6d74f3e',
    trigger: 'auto',
    status: 'done',
    verdict: 'approve',
    fileCount: 5,
    commentCount: 1,
    totalInputTokens: 7210,
    totalOutputTokens: 840,
    createdAt: ago(142),
    updatedAt: ago(136),
    startedAt: ago(141),
    finishedAt: ago(136),
    errorMessage: null,
    overallConfidenceScore: 0.97,
    steps: [],
  },
];

const stats = {
  totals: { jobs: 1284, inputTokens: 8_420_500, outputTokens: 1_920_400, comments: 3847 },
  trend: [],
  verdicts: [
    { verdict: 'approve', count: 846 },
    { verdict: 'comment', count: 438 },
  ],
  models: [],
  topRepos: [],
  statuses: [
    { status: 'done', count: 1268 },
    { status: 'running', count: 16 },
  ],
  triggers: [],
  severities: [],
  categories: [],
  performance: { avgDurationMs: 48_200, p95DurationMs: 92_100, avgConfidence: 0.91 },
};

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Vite process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await mkdir(outputDir, { recursive: true });

const server = spawn('node_modules/.bin/vite', ['--host', host, '--port', String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});

// `spawn` reports a failure to launch (e.g. ENOENT for a missing vite binary) via an async
// 'error' event, not a synchronous throw. Without a listener that event would crash the process
// with an unhandled error, so surface it and mark a failed exit; waitForServer's timeout is the
// backstop that unblocks the run.
let serverSpawnError = null;
server.on('error', (err) => {
  serverSpawnError = err;
  console.error('Failed to start Vite dev server:', err);
});

let browser;
try {
  await waitForServer(baseUrl);
  browser = await chromium.launch({ headless: true });

  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1050 },
      colorScheme: theme,
      deviceScaleFactor: 1,
    });

    await context.addInitScript(({ selectedTheme }) => {
      localStorage.setItem('codra-theme', selectedTheme);
      localStorage.setItem('codra-sidebar-collapsed', 'false');
      Date.now = () => new Date('2026-07-18T10:00:00.000Z').getTime();
      let seed = 42;
      Math.random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    }, { selectedTheme: theme });

    // Catch-all fallback registered FIRST (lowest priority — Playwright evaluates routes in
    // reverse registration order, so the specific stubs below override this). Any dashboard
    // fetch to an endpoint we did not explicitly stub (job detail, comments, repo metadata,
    // profile, etc.) is short-circuited with an empty 404 so no request escapes to a real
    // backend with the stubbed identity.
    await context.route('**/api/**', (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not stubbed' }),
    }));

    await context.route('**/api/auth/session', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          provider: 'github',
          githubUserId: 1842,
          login: 'thomas',
          name: 'Thomas Michnicki',
          avatarUrl: null,
          email: 'thomas@example.com',
          signedInAt: ago(240),
        },
      }),
    }));
    await context.route('**/api/stats**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ stats }),
    }));
    await context.route('**/api/jobs**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jobs, total: jobs.length }),
    }));

    const page = await context.newPage();
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Review operations' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${outputDir}/dashboard-${theme}.png`,
      fullPage: true,
    });
    await context.close();
  }
} finally {
  await browser?.close();
  // Only signal the child if it actually launched and is still running; killing a process that
  // never spawned (serverSpawnError) or already exited is a no-op that can throw on some platforms.
  if (!serverSpawnError && server.pid !== undefined && server.exitCode === null) {
    server.kill('SIGTERM');
  }
}

console.log(`Rendered ${outputDir}/dashboard-light.png`);
console.log(`Rendered ${outputDir}/dashboard-dark.png`);
