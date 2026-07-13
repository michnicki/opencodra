import { vi } from 'vitest';

export type RecordedBitbucketCall = {
  url: string;
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
};

export type BitbucketMockResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

type ResponseFactory = (
  call: RecordedBitbucketCall,
) => BitbucketMockResponse | Response | Promise<BitbucketMockResponse | Response>;

export type BitbucketFetchMockOptions = {
  getPullRequestResponses?: BitbucketMockResponse[];
  getPullRequestDiffResponse?: BitbucketMockResponse;
  listPullRequestCommentsResponse?: BitbucketMockResponse;
  postPullRequestCommentResponses?: BitbucketMockResponse[];
  approvePullRequestResponse?: BitbucketMockResponse;
  upsertCodeInsightsReportResponse?: BitbucketMockResponse;
  postCommitBuildStatusResponse?: BitbucketMockResponse;
  responseSequence?: Array<BitbucketMockResponse | Response | ResponseFactory>;
};

const defaultPullRequest = {
  id: 42,
  title: 'Add Bitbucket support',
  description: 'Review Bitbucket pull requests.',
  draft: false,
  source: {
    branch: { name: 'feature/bitbucket' },
    commit: { hash: 'head123' },
  },
  destination: {
    branch: { name: 'main' },
    commit: { hash: 'base123' },
  },
  author: { username: 'alice' },
  state: 'OPEN',
};

function toResponse(spec: BitbucketMockResponse) {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers);
  const body = spec.body ?? {};

  if (typeof body === 'string') {
    return new Response(body, { status, headers });
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Stubs only api.bitbucket.org so the real BitbucketClient can be exercised end-to-end without
 * network traffic. Scripted responses make retry behavior observable while terminal defaults keep
 * endpoint tests fast and deterministic.
 */
export function installBitbucketFetchMock(options: BitbucketFetchMockOptions = {}) {
  const calls: RecordedBitbucketCall[] = [];
  const originalFetch = globalThis.fetch;
  const responseSequence = [...(options.responseSequence ?? [])];
  const getPullRequestResponses = [...(options.getPullRequestResponses ?? [])];
  const postPullRequestCommentResponses = [...(options.postPullRequestCommentResponses ?? [])];

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname !== 'api.bitbucket.org' || !url.pathname.startsWith('/2.0/')) {
      throw new Error(`Unexpected non-Bitbucket fetch in test: ${rawUrl}`);
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const call = {
      url: url.toString(),
      method,
      path: `${url.pathname}${url.search}`,
      authorization: headers.get('Authorization'),
      body,
    };
    calls.push(call);

    const scripted = responseSequence.shift();
    if (scripted) {
      const value = typeof scripted === 'function' ? await scripted(call) : scripted;
      return value instanceof Response ? value : toResponse(value);
    }

    if (method === 'GET' && /\/pullrequests\/\d+$/.test(url.pathname)) {
      return toResponse(getPullRequestResponses.shift() ?? { body: defaultPullRequest });
    }
    if (method === 'GET' && /\/pullrequests\/\d+\/diff$/.test(url.pathname)) {
      return toResponse(options.getPullRequestDiffResponse ?? {
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n',
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (method === 'GET' && /\/pullrequests\/\d+\/comments$/.test(url.pathname)) {
      return toResponse(options.listPullRequestCommentsResponse ?? {
        body: { values: [{ id: 7, content: { raw: 'Existing comment' } }] },
      });
    }
    if (method === 'POST' && /\/pullrequests\/\d+\/comments$/.test(url.pathname)) {
      return toResponse(postPullRequestCommentResponses.shift() ?? { status: 201, body: { id: 8 } });
    }
    if (method === 'POST' && /\/pullrequests\/\d+\/approve$/.test(url.pathname)) {
      return toResponse(options.approvePullRequestResponse ?? { status: 200, body: {} });
    }
    if (method === 'PUT' && /\/commit\/[^/]+\/reports\/codra-review$/.test(url.pathname)) {
      return toResponse(options.upsertCodeInsightsReportResponse ?? { status: 200, body: {} });
    }
    if (method === 'POST' && /\/commit\/[^/]+\/statuses\/build$/.test(url.pathname)) {
      return toResponse(options.postCommitBuildStatusResponse ?? { status: 201, body: {} });
    }

    return toResponse({ status: 404, body: { error: { message: `Unhandled mock route: ${method} ${url.pathname}` } } });
  }

  vi.stubGlobal('fetch', handler);

  return {
    calls,
    restore() {
      vi.stubGlobal('fetch', originalFetch);
    },
  };
}

export function expectBitbucketGet(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'GET' || call.path !== path) {
    throw new Error(`Expected GET ${path}, received ${call.method} ${call.path}`);
  }
}

export function expectBitbucketPost(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'POST' || call.path !== path) {
    throw new Error(`Expected POST ${path}, received ${call.method} ${call.path}`);
  }
}

export function expectBitbucketPut(call: RecordedBitbucketCall, path: string) {
  if (call.method !== 'PUT' || call.path !== path) {
    throw new Error(`Expected PUT ${path}, received ${call.method} ${call.path}`);
  }
}
