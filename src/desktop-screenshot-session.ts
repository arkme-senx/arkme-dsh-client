import type {ScreenshotWindowRect} from './screenshot-window-geometry.js';
export interface ScreenshotFrame { contentBase64: string; width: number; height: number; windows?: ScreenshotWindowRect[] }
/** A single capture lease. No image or result survives a scope/owner change. */
export class ScreenshotSession {
 private frames = new Map<number, ScreenshotFrame>();
 private selected: number | undefined;
 private closed = false;
 constructor(readonly owner: number, readonly requestId: string, readonly scope: string) {}
 ownedBy(owner: number, requestId: unknown): boolean { return !this.closed && owner === this.owner && requestId === this.requestId; }
 add(id: number, frame: ScreenshotFrame): boolean { if (this.closed) return false; this.frames.set(id, frame); return true; }
 context(id: number, scope: string): ScreenshotFrame | null {
  return !this.closed && scope === this.scope && (this.selected === undefined || this.selected === id) ? this.frames.get(id) ?? null : null;
 }
 select(id: number, scope: string): boolean { if (!this.context(id, scope)) return false; this.selected = id; return true; }
 close(): void { this.closed = true; this.frames.clear(); }
}
export function decodeScreenshotPng(value: unknown): Buffer {
 if (typeof value !== 'string' || value.length > 48 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('无效的截图文件');
 const bytes = Buffer.from(value, 'base64');
 if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('无效的 PNG 截图');
 const width=bytes.readUInt32BE(16), height=bytes.readUInt32BE(20);
 if (!width || !height || width>16384 || height>16384 || width*height>64_000_000) throw new Error('截图尺寸过大');
 return bytes;
}
