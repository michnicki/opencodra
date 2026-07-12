import { vi } from 'vitest';

export type RecordedGitHubCall = {
  method: string;
  path: string;
  accept: string | null;
  body: any;
};

export type ReviewResponseScript = Array<{ status: number; id?: number }>;

export type GitHubFetchMockFixtures = {
  owner: string;
  repo: string;
  prNumber: number;
  pull: {
    number: number;
    title: string | null;
    body: string | null;
    draft: boolean;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    user: { login: string };
  };
  diff: string;
  /** Scripted status sequence for successive POST .../reviews calls. Defaults to a single 200. */
  reviewResponses?: ReviewResponseScript;
};

/**
 * Stubs global fetch so the real GitHubClient (core/github.ts) can run end-to-end
 * against a fake api.github.com. Every response is terminal (2xx/404/422) so
 * GitHubClient's retry/backoff logic never triggers a real-time sleep.
 */
export function installGitHubFetchMock(fixtures: GitHubFetchMockFixtures) {
  const calls: RecordedGitHubCall[] = [];
  const originalFetch = globalThis.fetch;
  const repoPrefix = `/repos/${fixtures.owner}/${fixtures.repo}`;
  const reviewsListPath = `${repoPrefix}/pulls/${fixtures.prNumber}/reviews`;
  const reviewResponses = fixtures.reviewResponses ?? [{ status: 200, id: 5150 }];
  let reviewCallIndex = 0;

  const existingLabels = new Map<string, string>();
  const issueLabels = new Set<string>();

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);

    if (url.hostname !== 'api.github.com') {
      // core/telemetry.ts fires a real POST to codra.run on every finalize; return a fast synthetic
      // response instead of letting it reach the real network from a test run.
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const accept = headers.get('Accept');
    let body: any = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    calls.push({ method, path: url.pathname, accept, body });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (method === 'GET' && url.pathname === `${repoPrefix}/pulls/${fixtures.prNumber}`) {
      if (accept === 'application/vnd.github.v3.diff') {
        return new Response(fixtures.diff, { status: 200 });
      }
      return json(fixtures.pull);
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/check-runs`) {
      return json({ id: 9001 }, 201);
    }

    if (method === 'PATCH' && /\/check-runs\/\d+$/.test(url.pathname)) {
      return json({});
    }

    if (method === 'GET' && url.pathname === reviewsListPath) {
      // findBotReviewForCommit's existing-review lookup (only hit when a finalize retries past
      // the posting step). No prior review exists in these fixtures.
      return json([]);
    }

    if (method === 'POST' && url.pathname === reviewsListPath) {
      const script = reviewResponses[Math.min(reviewCallIndex, reviewResponses.length - 1)];
      reviewCallIndex += 1;
      if (script.status >= 400) {
        return json({ message: 'Unprocessable Entity' }, script.status);
      }
      return json({ id: script.id ?? 5150 }, script.status);
    }

    const labelLookup = new RegExp(`^${repoPrefix}/labels/([^/]+)$`).exec(url.pathname);
    if (method === 'GET' && labelLookup) {
      const name = decodeURIComponent(labelLookup[1]);
      return existingLabels.has(name) ? json({ name }) : json({ message: 'Not Found' }, 404);
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/labels`) {
      existingLabels.set(body.name, body.color);
      return json({ name: body.name, color: body.color }, 201);
    }

    if (method === 'GET' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/labels`) {
      return json(Array.from(issueLabels, (name) => ({ name })));
    }

    if (method === 'POST' && url.pathname === `${repoPrefix}/issues/${fixtures.prNumber}/labels`) {
      for (const name of body?.labels ?? []) issueLabels.add(name);
      return json([]);
    }

    const labelRemoval = new RegExp(`^${repoPrefix}/issues/${fixtures.prNumber}/labels/([^/]+)$`).exec(url.pathname);
    if (method === 'DELETE' && labelRemoval) {
      issueLabels.delete(decodeURIComponent(labelRemoval[1]));
      return json([]);
    }

    return json({ message: `Unhandled mock GitHub route: ${method} ${url.pathname}` }, 404);
  }

  vi.stubGlobal('fetch', handler);

  return {
    calls,
    restore() {
      vi.stubGlobal('fetch', originalFetch);
    },
  };
}
