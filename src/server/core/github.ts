import type { ParsedReviewComment } from '@shared/schema';
import type { AppBindings } from '@server/env';

type InstallationTokenCacheRecord = {
  token: string;
  expiresAt: string;
};

type PullRequestRecord = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  user: { login: string };
};

function installationCacheKey(installationId: string) {
  return `install:${installationId}`;
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function base64UrlEncode(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createGitHubJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  const signatureString = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${header}.${payload}.${signatureString}`;
}

async function readCachedInstallationToken(env: Pick<AppBindings, 'APP_KV'>, installationId: string) {
  const cached = await env.APP_KV.get(installationCacheKey(installationId), 'json');
  return cached as InstallationTokenCacheRecord | null;
}

async function writeCachedInstallationToken(
  env: Pick<AppBindings, 'APP_KV'>,
  installationId: string,
  record: InstallationTokenCacheRecord,
) {
  const expiresAt = new Date(record.expiresAt).getTime();
  const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 300);
  await env.APP_KV.put(installationCacheKey(installationId), JSON.stringify(record), { expirationTtl: ttl });
}

export class GitHubClient {
  constructor(
    private readonly env: Pick<
      AppBindings,
      'APP_KV' | 'APP_PRIVATE_KEY' | 'GITHUB_APP_ID' | 'BOT_USERNAME'
    >,
    private readonly installationId: string,
  ) {}

  async getInstallationToken() {
    const cached = await readCachedInstallationToken(this.env, this.installationId);
    if (cached?.token) {
      return cached.token;
    }

    const jwt = await createGitHubJwt(this.env.GITHUB_APP_ID, this.env.APP_PRIVATE_KEY);
    const response = await fetch(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub installation token request failed with ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as { token: string; expires_at: string };
    await writeCachedInstallationToken(this.env, this.installationId, {
      token: data.token,
      expiresAt: data.expires_at,
    });

    return data.token;
  }

  private async request(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json') {
    const token = await this.getInstallationToken();
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
        ...(init.headers ?? {}),
      },
    });

    return response;
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const response = await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub pull request fetch failed with ${response.status}: ${errText}`);
    }

    return (await response.json()) as PullRequestRecord;
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number) {
    const response = await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {}, 'application/vnd.github.v3.diff');
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub diff fetch failed with ${response.status}: ${errText}`);
    }

    return response.text();
  }

  async getRepoFileOrNull(owner: string, repo: string, path: string) {
    const response = await this.request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub repo file fetch failed with ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as { content?: string; encoding?: string };
    if (!data.content) {
      return null;
    }

    return data.encoding === 'base64' ? atob(data.content.replace(/\n/g, '')) : data.content;
  }

  async createCheckRun(owner: string, repo: string, input: { headSha: string; title: string; summary: string; detailsUrl?: string }) {
    const response = await this.request(`/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Codra',
        head_sha: input.headSha,
        status: 'in_progress',
        details_url: input.detailsUrl,
        output: {
          title: input.title,
          summary: input.summary,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub check run creation failed with ${response.status}: ${errText}`);
    }

    return (await response.json()) as { id: number };
  }

  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    input: { title: string; summary: string; status?: 'in_progress' | 'completed'; conclusion?: 'success' | 'neutral' | 'failure' },
  ) {
    const response = await this.request(`/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: input.status ?? 'in_progress',
        conclusion: input.conclusion,
        completed_at: input.status === 'completed' ? new Date().toISOString() : undefined,
        output: {
          title: input.title,
          summary: input.summary,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub check run update failed with ${response.status}: ${errText}`);
    }
  }

  async createReview(
    owner: string,
    repo: string,
    pullNumber: number,
    input: {
      commitSha: string;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      body: string;
      comments: ParsedReviewComment[];
    },
  ) {
    const body = {
      commit_id: input.commitSha,
      event: input.event,
      body: input.body,
      comments: input.comments
        .filter((comment) => comment.position)
        .map((comment) => ({
          path: comment.path,
          position: comment.position,
          body: comment.body,
        })),
    };

    let response = await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 422 && body.comments.length > 0) {
      response = await this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          commit_id: input.commitSha,
          event: input.event,
          body: input.body,
          comments: [],
        }),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`GitHub review creation failed with ${response.status}: ${errText}`);
    }

    return (await response.json()) as { id: number };
  }

  async ensureLabel(owner: string, repo: string, name: string, color: string) {
    const listResponse = await this.request(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
    if (listResponse.ok) {
      return;
    }
    if (listResponse.status !== 404) {
      throw new Error(`GitHub label lookup failed with ${listResponse.status}`);
    }

    const createResponse = await this.request(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, color }),
    });

    if (!createResponse.ok && createResponse.status !== 422) {
      throw new Error(`GitHub label creation failed with ${createResponse.status}`);
    }
  }

  async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
    const response = await this.request(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ labels }),
    });

    if (!response.ok) {
      throw new Error(`GitHub label update failed with ${response.status}`);
    }
  }
}
