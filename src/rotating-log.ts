import { Writable } from "node:stream";
import { appendFile, rename, rm, stat } from "node:fs/promises";

/** Three bounded files; callers discard excess buffered diagnostics, never child output. */
export class RotatingLog extends Writable {
  private bytes: number | undefined;
  private nextWarningAt = 0;
  constructor(private readonly file: string, private readonly maximumBytes = 5 * 1024 * 1024) {
    super({ highWaterMark: 256 * 1024 });
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    void this.append(chunk).then(() => done(), () => {
      if (performance.now() >= this.nextWarningAt) {
        this.nextWarningAt = performance.now() + 60_000;
        process.stderr.write("arkme: diagnostic log write unavailable; output dropped\n");
      }
      done();
    });
  }
  private async append(chunk: Buffer): Promise<void> {
    if (this.destroyed) return;
    this.bytes = await stat(this.file).then(value => value.size, error => { if (error.code === "ENOENT") return 0; throw error; });
    if (this.destroyed) return;
    const bounded = chunk.subarray(Math.max(0, chunk.length - this.maximumBytes));
    if (this.bytes + bounded.length > this.maximumBytes) {
      await rm(`${this.file}.2`, { force: true });
      await rename(`${this.file}.1`, `${this.file}.2`).catch(error => { if (error.code !== "ENOENT") throw error; });
      await rename(this.file, `${this.file}.1`).catch(error => { if (error.code !== "ENOENT") throw error; });
      this.bytes = 0;
    }
    if (this.destroyed) return;
    await appendFile(this.file, bounded, { mode: 0o600 });
    this.bytes += bounded.length;
  }
}
