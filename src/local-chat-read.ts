interface LocalChatReadContext {
  origin: string;
  cookie: string;
  signal: AbortSignal;
  valid(): boolean;
}

export async function readLocalChat(
  context: LocalChatReadContext,
  accountKey: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!input || typeof input !== 'object') throw new Error('本地消息读取参数无效');
  const { kind, sourceRef, limit, anchorId, surface } = input as Record<string, unknown>;
  let request: unknown;
  if (kind === 'viewport' && typeof surface === 'string' && surface.length <= 2048) {
    request = { operation: 'conversation.viewport.read', params: { accountKey, surface } };
  } else if (kind === 'timeline' && typeof sourceRef === 'string' && sourceRef.startsWith('arkme-source-v1.') && sourceRef.length <= 32768
    && typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
    && (anchorId === undefined || typeof anchorId === 'string' && anchorId.length > 0 && anchorId.length <= 1024)) {
    request = { operation: 'source.timeline', params: {
      sourceRef, limit, desktopLocal: true,
      cursor: { unified: { mode: 'initial', cacheOnly: true, ...(anchorId === undefined ? {} : { anchorId }) } },
    } };
  } else {
    throw new Error('本地消息读取参数无效');
  }
  if (!context.valid()) throw new Error('会话窗口已失效，请重新打开');
  // Node fetch has its own connection pool, separate from renderer Chromium.
  const response = await fetcher(new URL('/arkme-self/api', context.origin), {
    method: 'POST',
    headers: { Origin: context.origin, Cookie: context.cookie, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
    body: JSON.stringify(request),
  });
  const result: unknown = await response.json();
  if (!context.valid()) throw new Error('会话窗口已失效，请重新打开');
  return result;
}
