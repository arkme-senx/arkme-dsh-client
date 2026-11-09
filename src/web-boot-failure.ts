// Executed in an isolated world of the authenticated Harness main frame.
// Only the boot surface owns this diagnostic; ordinary app content is ignored.
export function observeWebBootFailure(afterReady = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // The Web bundle constructs this direct child synchronously before loadURL resolves.
    const boot = document.querySelector('#root > [data-dsh-boot]');
    const container = boot?.parentElement;
    if (!boot || !container) return resolve(null);
    const observer = new MutationObserver(inspect);
    const timer = afterReady ? setTimeout(() => {
      observer.disconnect();
      reject(new Error("Harness Web boot did not finish after recovery"));
    }, 30_000) : undefined;
    function finish(message: string | null) {
      observer.disconnect();
      clearTimeout(timer);
      resolve(message);
    }
    function inspect() {
      if (!boot?.isConnected) return finish(null);
      for (const element of boot.querySelectorAll('*')) {
        if (element.childElementCount || element.textContent !== 'Failed to load plugins') continue;
        const message = element.parentElement?.lastElementChild?.textContent;
        if (message?.startsWith('web boot: ') && message.length <= 4096) finish(message);
        return;
      }
    }
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    inspect();
  });
}

export function activationFailurePackages(message: string): string[] | undefined {
  const [header, ...rows] = message.split(/\r?\n/);
  if (rows.length === 0 || rows.length > 32 ||
      header !== `web boot: ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} did not activate`) return;
  const names = new Set<string>();
  for (const row of rows) {
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*): (?:loading|failed|disposed|unloading|pending \(waiting for services?: [^\r\n]+\)|import failed(?:[: (].*)?)$/.exec(row);
    if (!match || names.has(match[1]!)) return;
    names.add(match[1]!);
  }
  return [...names];
}
