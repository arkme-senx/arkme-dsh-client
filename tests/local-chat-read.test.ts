import { expect, it, vi } from 'vitest';
import { readLocalChat } from '../src/local-chat-read.js';

it('only forwards fixed local reads and rechecks the window before returning message bodies', async () => {
  let valid = true;
  const context = { origin: 'http://127.0.0.1:4000', cookie: 'local-session', signal: new AbortController().signal, valid: () => valid };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, value: [] }))
    .mockImplementationOnce(async () => { valid = false; return Response.json({ ok: true, value: ['old account'] }); });
  await expect(readLocalChat(context, 'test:3016', { kind: 'remote', sourceRef: 'arkme-source-v1.fixture', limit: 40 }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await readLocalChat(context, 'test:3016', { kind: 'viewport', surface: 'main', accountKey: 'test:9999' }, fetcher);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
    operation: 'conversation.viewport.read', params: { accountKey: 'test:3016', surface: 'main' },
  });
  await expect(readLocalChat(context, 'test:3016', { kind: 'timeline', sourceRef: 'arkme-source-v1.fixture', limit: 40, desktopLocal: false }, fetcher)).rejects.toThrow('会话窗口已失效');
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
    operation: 'source.timeline', params: {
      sourceRef: 'arkme-source-v1.fixture', limit: 40, desktopLocal: true,
      cursor: { unified: { mode: 'initial', cacheOnly: true } },
    },
  });
});
