import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_APP_VERSION_CODE } from './app-version-code.js';

interface VersionHistory {
  pluginVersion: string;
  clientVersionCode: number;
  showClientVersionCode: boolean;
}

function validCode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_APP_VERSION_CODE;
}

/** Installation-scoped history, independent of the Harness's random HTTP port and account. */
export class ProductVersionHistory {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  observe(pluginVersion: unknown, clientVersionCode: number): Promise<boolean> {
    if (typeof pluginVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(pluginVersion)
      || !validCode(clientVersionCode)) return Promise.resolve(false);
    const result = this.pending.then(async () => {
      let previous: VersionHistory | undefined;
      try {
        const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
        if (value !== null && typeof value === 'object' && 'pluginVersion' in value
          && typeof value.pluginVersion === 'string' && 'clientVersionCode' in value
          && validCode(value.clientVersionCode) && 'showClientVersionCode' in value
          && typeof value.showClientVersionCode === 'boolean') previous = value as VersionHistory;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Plugin changes take precedence, including simultaneous upgrades and rollbacks.
      const showClientVersionCode = previous?.pluginVersion === pluginVersion
        && (clientVersionCode === previous.clientVersionCode ? previous.showClientVersionCode
          : clientVersionCode > previous.clientVersionCode);
      const next: VersionHistory = { pluginVersion, clientVersionCode, showClientVersionCode };
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.file);
      }
      return showClientVersionCode;
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
