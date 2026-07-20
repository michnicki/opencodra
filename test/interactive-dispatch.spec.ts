// Phase 11 Plan 06 — the queue-consumer kind branch (CMD-07, D-03/D-05/D-09). A kind='command' or
// kind='qa' message is dispatched INLINE (non-Workflow): the consumer constructs a provider via the
// jobless VcsService.forProvider factory, rebuilds a full CommentContext from message.interactive
// (body + workspace included so reject persists reason=body), and calls executeCommand /
// answerQuestion. A transient failure retries (bounded by the 3-attempt consumer); a deterministic
// one is acked. A no-kind message still reaches REVIEW_WORKFLOW.create byte-identically (NREG-01).

import { vi } from 'vitest';
import { defaultRepoConfig } from '@shared/schema';
import { RetryableModelError } from '@server/services/model';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const { forProviderMock, executeCommandMock, answerQuestionMock, loadRepoConfigMock, maintenanceMock } = vi.hoisted(() => ({
  forProviderMock: vi.fn(),
  executeCommandMock: vi.fn(),
  answerQuestionMock: vi.fn(),
  loadRepoConfigMock: vi.fn(),
  maintenanceMock: vi.fn(),
}));

vi.mock('@server/services/vcs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/services/vcs')>();
  return {
    ...actual,
    VcsService: Object.assign(actual.VcsService, { forProvider: forProviderMock }),
  };
});

vi.mock('@server/core/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/commands')>();
  return { ...actual, executeCommand: executeCommandMock };
});

vi.mock('@server/core/qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/qa')>();
  return { ...actual, answerQuestion: answerQuestionMock };
});

vi.mock('@server/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/config')>();
  return { ...actual, loadRepoConfig: loadRepoConfigMock };
});

// Avoid touching Postgres for the pre/post-batch maintenance sweeps — this suite exercises only the
// consumer's dispatch routing, not DB maintenance.
vi.mock('@server/core/job-recovery', () => ({
  runBestEffortJobMaintenance: maintenanceMock,
}));

import worker from '@server/index';

function makeMessage(body: unknown, attempts = 1) {
  return { body, ack: vi.fn(), retry: vi.fn(), attempts };
}

async function runQueue(env: any, message: any) {
  await worker.queue({ messages: [message] } as any, env, {} as ExecutionContext);
}

const commandBody = {
  kind: 'command' as const,
  deliveryId: 'del-cmd-1',
  provider: 'github' as const,
  owner: 'octo',
  repo: 'hello',
  prNumber: 12,
  installationId: '123',
  interactive: {
    commandName: 'reject' as const,
    authorId: 'u1',
    authorLogin: 'user1',
    body: '@codra-app reject not a real bug',
    workspace: 'octo',
    commentRef: 'c1',
    parentRef: 'p1',
    findingRef: 'f1',
    sourceCommentRef: 'c1',
  },
};

const qaBody = {
  kind: 'qa' as const,
  deliveryId: 'del-qa-1',
  provider: 'github' as const,
  owner: 'octo',
  repo: 'hello',
  prNumber: 12,
  installationId: '123',
  interactive: {
    question: 'why is this slow?',
    authorId: 'u1',
    body: '@codra-app why is this slow?',
    workspace: 'octo',
  },
};

dbDescribe('queue consumer — interactive kind branch (11-06)', () => {
  beforeEach(() => {
    forProviderMock.mockReset();
    executeCommandMock.mockReset();
    answerQuestionMock.mockReset();
    loadRepoConfigMock.mockReset();
    maintenanceMock.mockReset();

    maintenanceMock.mockResolvedValue(undefined);
    forProviderMock.mockResolvedValue({ name: 'github' });
    loadRepoConfigMock.mockResolvedValue({ parsedJson: defaultRepoConfig, enabled: true });
    executeCommandMock.mockResolvedValue(undefined);
    answerQuestionMock.mockResolvedValue({ answered: true });
  });

  it('command message dispatches executeCommand inline with a reconstructed CommentContext (D-09) and never a Workflow', async () => {
    const env = createTestEnv();
    const message = makeMessage(commandBody);

    await runQueue(env, message);

    expect(forProviderMock).toHaveBeenCalledTimes(1);
    expect(forProviderMock.mock.calls[0][1]).toMatchObject({
      provider: 'github',
      installationId: '123',
      workspace: 'octo',
      repo: 'hello',
    });

    expect(executeCommandMock).toHaveBeenCalledTimes(1);
    const ctx = executeCommandMock.mock.calls[0][3];
    // body + workspace survive the queue hop so reject persists reason=body (non-null), D-09.
    expect(ctx.body).toBe(commandBody.interactive.body);
    expect(ctx.workspace).toBe('octo');
    expect(ctx.authorId).toBe('u1');
    expect(ctx.prNumber).toBe(12);
    const cmd = executeCommandMock.mock.calls[0][2];
    expect(cmd.name).toBe('reject');

    expect(answerQuestionMock).not.toHaveBeenCalled();
    expect((env.REVIEW_WORKFLOW as any).created).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('qa message dispatches answerQuestion inline and never a Workflow', async () => {
    const env = createTestEnv();
    const message = makeMessage(qaBody);

    await runQueue(env, message);

    expect(answerQuestionMock).toHaveBeenCalledTimes(1);
    const qaCtx = answerQuestionMock.mock.calls[0][2];
    expect(qaCtx.question).toBe('why is this slow?');
    expect(qaCtx.workspace).toBe('octo');
    expect(qaCtx.prNumber).toBe(12);

    expect(executeCommandMock).not.toHaveBeenCalled();
    expect((env.REVIEW_WORKFLOW as any).created).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('a TRANSIENT dispatch failure calls message.retry() (never acked-and-lost)', async () => {
    const env = createTestEnv();
    executeCommandMock.mockRejectedValueOnce(new RetryableModelError('provider temporarily unavailable'));
    const message = makeMessage(commandBody, 1);

    await runQueue(env, message);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect((env.REVIEW_WORKFLOW as any).created).toHaveLength(0);
  });

  it('a DETERMINISTIC dispatch failure is logged and acked (never retried)', async () => {
    const env = createTestEnv();
    executeCommandMock.mockRejectedValueOnce(new Error('malformed finding ref'));
    const message = makeMessage(commandBody, 1);

    await runQueue(env, message);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect((env.REVIEW_WORKFLOW as any).created).toHaveLength(0);
  });

  it('a transient failure on the final attempt is acked rather than retried forever', async () => {
    const env = createTestEnv();
    executeCommandMock.mockRejectedValueOnce(new RetryableModelError('unavailable'));
    const message = makeMessage(commandBody, 3); // attempts >= 3 -> stop retrying

    await runQueue(env, message);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('a no-kind message still reaches REVIEW_WORKFLOW.create (NREG-01)', async () => {
    const env = createTestEnv();
    const message = makeMessage({ deliveryId: 'del-evt-1', eventName: 'pull_request' });

    await runQueue(env, message);

    expect((env.REVIEW_WORKFLOW as any).created).toHaveLength(1);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(answerQuestionMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
