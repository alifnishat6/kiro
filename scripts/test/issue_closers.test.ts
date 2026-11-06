import { Octokit } from '@octokit/rest';

jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-01-15T12:00:00Z');
const target = { owner: 'test-owner', repo: 'test-repo', issue_number: 42 };

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function labelEvent(label: string, days: number) {
  return { event: 'labeled', label: { name: label }, created_at: daysAgo(days) };
}

function makeClient() {
  return {
    issues: {
      listForRepo: jest.fn(),
      listEvents: jest.fn(),
      listComments: jest.fn().mockResolvedValue({ data: [] }),
      createComment: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      removeLabel: jest.fn().mockResolvedValue({}),
      addLabels: jest.fn().mockResolvedValue({}),
    },
    reactions: { listForIssueComment: jest.fn().mockResolvedValue({ data: [] }) },
  };
}

describe.each([
  { script: 'close_duplicates', label: 'duplicate', threshold: 3 },
  { script: 'close_stale', label: 'pending-response', threshold: 7 },
])('$script production entry point', ({ script, label, threshold }) => {
  let client: ReturnType<typeof makeClient>;
  let originalEnv: NodeJS.ProcessEnv;

  const candidate = (number = 42) => ({ number, title: 'Issue', labels: [{ name: label }] });

  async function run(expectedExit = 0) {
    // These CLI modules start on import; process.exit signals completion of main().
    const completed = new Promise<number>((resolve) => {
      jest.spyOn(process, 'exit').mockImplementation((code) => {
        resolve(Number(code));
        return undefined as never;
      });
    });
    jest.isolateModules(() => {
      require(`../${script}`);
    });
    expect(await completed).toBe(expectedExit);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      REPOSITORY_OWNER: target.owner,
      REPOSITORY_NAME: target.repo,
      GITHUB_TOKEN: 'test-token',
    };
    client = makeClient();
    client.issues.listForRepo.mockResolvedValue({ data: [candidate()] });
    client.issues.listEvents.mockResolvedValue({ data: [labelEvent(label, threshold)] });
    jest.mocked(Octokit).mockImplementation(() => client as unknown as Octokit);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('closes at the exact age threshold, after posting an explanation', async () => {
    await run();

    expect(client.issues.listForRepo).toHaveBeenCalledWith({
      owner: target.owner, repo: target.repo, state: 'open', labels: label, per_page: 100,
    });
    expect(client.issues.createComment).toHaveBeenCalledTimes(1);
    expect(client.issues.createComment).toHaveBeenCalledWith({
      ...target, body: expect.stringContaining('automatically closed'),
    });
    expect(client.issues.update).toHaveBeenCalledTimes(1);
    expect(client.issues.update).toHaveBeenCalledWith({ ...target, state: 'closed' });
    expect(client.issues.createComment.mock.invocationCallOrder[0])
      .toBeLessThan(client.issues.update.mock.invocationCallOrder[0]);
  });

  it('does not close even one millisecond before the threshold', async () => {
    const event = labelEvent(label, threshold);
    event.created_at = new Date(NOW.getTime() - threshold * DAY + 1).toISOString();
    client.issues.listEvents.mockResolvedValue({ data: [event] });

    await run();

    expect(client.issues.createComment).not.toHaveBeenCalled();
    expect(client.issues.update).not.toHaveBeenCalled();
  });

  it('uses the latest application of the target label, not an older application', async () => {
    client.issues.listEvents.mockResolvedValue({ data: [
      labelEvent(label, 1), labelEvent('other-label', 20), labelEvent(label, 15),
    ] });

    await run();

    expect(client.issues.update).not.toHaveBeenCalled();
  });

  it('skips issues whose target label was removed', async () => {
    client.issues.listForRepo.mockResolvedValue({ data: [{ ...candidate(), labels: ['other-label'] }] });

    await run();

    expect(client.issues.listEvents).not.toHaveBeenCalled();
    expect(client.issues.update).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unavailable'])('does not close when label history is %s', async (history) => {
    if (history === 'missing') {
      client.issues.listEvents.mockResolvedValue({ data: [labelEvent('other-label', 20)] });
    } else {
      client.issues.listEvents.mockRejectedValue(new Error('Timeline unavailable'));
    }

    await run();

    expect(client.issues.createComment).not.toHaveBeenCalled();
    expect(client.issues.update).not.toHaveBeenCalled();
  });

  it('does not close if the explanation cannot be posted, and continues to the next issue', async () => {
    client.issues.listForRepo.mockResolvedValue({ data: [candidate(), candidate(43)] });
    client.issues.createComment.mockRejectedValueOnce(new Error('Forbidden'));

    await run();

    expect(client.issues.createComment).toHaveBeenCalledTimes(2);
    expect(client.issues.update).toHaveBeenCalledTimes(1);
    expect(client.issues.update).toHaveBeenCalledWith({ ...target, issue_number: 43, state: 'closed' });
  });

  if (script === 'close_duplicates') {
    const detection = {
      id: 100, body: 'Potential Duplicate Detected\n#123: Original issue', created_at: daysAgo(4),
    };

    it.each(['comment', 'thumbs-down'])('sends a disputed duplicate back to triage after a %s', async (response) => {
      const comments = response === 'comment'
        ? [detection, { id: 101, body: 'This is different', created_at: daysAgo(1) }]
        : [detection];
      client.issues.listComments.mockResolvedValue({ data: comments });
      client.reactions.listForIssueComment.mockResolvedValue({ data: [{ content: '-1' }] });

      await run();

      expect(client.issues.removeLabel).toHaveBeenCalledWith({ ...target, name: 'duplicate' });
      expect(client.issues.addLabels).toHaveBeenCalledWith({ ...target, labels: ['pending-triage'] });
      expect(client.issues.createComment).not.toHaveBeenCalled();
      expect(client.issues.update).not.toHaveBeenCalled();
      if (response === 'thumbs-down') {
        expect(client.reactions.listForIssueComment).toHaveBeenCalledWith({
          owner: target.owner, repo: target.repo, comment_id: detection.id, per_page: 100,
        });
      }
    });

    it('links the original issue when closing an undisputed duplicate', async () => {
      client.issues.listComments.mockResolvedValue({ data: [detection] });
      client.reactions.listForIssueComment.mockResolvedValue({ data: [{ content: '+1' }] });

      await run();

      expect(client.issues.createComment).toHaveBeenCalledWith({
        ...target, body: expect.stringContaining('duplicate of #123'),
      });
      expect(client.issues.update).toHaveBeenCalledWith({ ...target, state: 'closed' });
      expect(client.issues.removeLabel).not.toHaveBeenCalled();
    });
  } else {
    it('preserves an issue with a recent comment even when its label is old', async () => {
      client.issues.listComments.mockResolvedValue({ data: [{ created_at: daysAgo(1) }] });

      await run();

      expect(client.issues.createComment).not.toHaveBeenCalled();
      expect(client.issues.update).not.toHaveBeenCalled();
    });

    it.each(['labeled', 'unlabeled'])('resets inactivity on a recent %s event', async (event) => {
      client.issues.listEvents.mockResolvedValue({ data: [
        labelEvent(label, 10), { ...labelEvent('other-label', 1), event },
      ] });

      await run();

      expect(client.issues.update).not.toHaveBeenCalled();
    });
  }
});
