/** Only the game's blank bootstrap and its exact same-origin document are allowed. */
export function acceptsGamePopup(url: string, name: string, source: string, origin: string | null): boolean {
  try {
    return origin !== null && new URL(source).origin === origin && url === 'about:blank'
      && /^arkme-game-[a-f0-9-]{36}$/.test(name);
  } catch { return false; }
}
export function acceptsGameDocument(url: string, origin: string | null): boolean {
  try {
    const target = new URL(url);
    return origin !== null && target.origin === origin && !target.search && !target.hash
      && /^\/[A-Za-z0-9/_-]+\/game\/index\.html$/.test(target.pathname);
  } catch { return false; }
}
