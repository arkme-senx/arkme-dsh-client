import { createRequire } from 'node:module';
import type { NativeVideoClipboard } from './video-clipboard.js';

const require = createRequire(import.meta.url);
const stale = () => new Error('剪贴板已更新，请重新点击复制视频');
export function windowsFileDropBytes(file: string): Buffer {
  const names = Buffer.from(`${file}\0\0`, 'utf16le');
  const header = Buffer.alloc(20); // DROPFILES: offset, POINT, fNC, fWide.
  header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16);
  return Buffer.concat([header, names]);
}
export interface WindowsVideoClipboardApi {
  sequence(): number; open(hwnd: bigint): boolean; close(): void; empty(): boolean;
  allocate(size: number): unknown; fill(memory: unknown, bytes: Buffer): void;
  free(memory: unknown): void; setFiles(memory: unknown): boolean; files(): string[];
}
export function windowsVideoClipboard(api: WindowsVideoClipboardApi): NativeVideoClipboard {
  return { supported: true, revision: () => api.sequence(), files: () => api.files(),
    write(file, revision, handle) {
      if (!handle || (handle.length !== 4 && handle.length !== 8)) throw new Error('视频复制窗口已失效');
      const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
      if (!hwnd) throw new Error('视频复制窗口已失效');
      const bytes = windowsFileDropBytes(file), memory = api.allocate(bytes.length);
      if (!memory) throw new Error('视频剪贴板内存分配失败');
      let transferred = false, opened = false;
      try {
        api.fill(memory, bytes);
        if (!api.open(hwnd)) throw new Error('剪贴板正忙，请重试');
        opened = true;
        if (api.sequence() !== revision) throw stale();
        if (!api.empty() || !api.setFiles(memory)) throw new Error('视频复制失败，请重试');
        transferred = true; // SetClipboardData owns GMEM_MOVEABLE only after success.
      } finally { if (opened) api.close(); if (!transferred) api.free(memory); }
    } };
}
function createWindows(): NativeVideoClipboard {
  const k = require('koffi') as typeof import('koffi').default;
  const user = k.load('user32.dll'), kernel = k.load('kernel32.dll'), shell = k.load('shell32.dll');
  const sequence = user.func('uint32 __stdcall GetClipboardSequenceNumber()');
  const open = user.func('int __stdcall OpenClipboard(uintptr_t hwnd)');
  const close = user.func('int __stdcall CloseClipboard()');
  const empty = user.func('int __stdcall EmptyClipboard()');
  const get = user.func('void * __stdcall GetClipboardData(uint32 format)');
  const set = user.func('void * __stdcall SetClipboardData(uint32 format, void *memory)');
  const alloc = kernel.func('void * __stdcall GlobalAlloc(uint32 flags, size_t size)');
  const lock = kernel.func('void * __stdcall GlobalLock(void *memory)');
  const unlock = kernel.func('int __stdcall GlobalUnlock(void *memory)');
  const free = kernel.func('void * __stdcall GlobalFree(void *memory)');
  const query = shell.func('uint32 __stdcall DragQueryFileW(void *drop, uint32 index, _Out_ uint16 *buffer, uint32 size)');
  return windowsVideoClipboard({ sequence, open: hwnd => !!open(hwnd), close: () => { close(); }, empty: () => !!empty(),
    allocate: size => alloc(2, size), // GMEM_MOVEABLE.
    fill: (memory, bytes) => {
      const pointer = lock(memory); if (!pointer) throw new Error('视频剪贴板内存不可用');
      try { k.encode(pointer, k.array('uint8_t', bytes.length), bytes); } finally { unlock(memory); }
    },
    free: memory => { free(memory); }, setFiles: memory => set(15, memory) !== null,
    files: () => {
      if (!open(0)) throw new Error('剪贴板正忙，请重试');
      try {
        const drop = get(15); if (!drop) return [];
        const count: number = query(drop, 0xffffffff, null, 0);
        if (count > 4096) throw new Error('剪贴板文件过多');
        const files: string[] = [];
        for (let i = 0; i < count; i++) {
          const length: number = query(drop, i, null, 0);
          if (length > 32767) throw new Error('剪贴板文件路径过长');
          const value = new Uint16Array(length + 1); query(drop, i, value, value.length);
          files.push(Buffer.from(value.buffer).subarray(0, length * 2).toString('utf16le'));
        }
        return files;
      } finally { close(); }
    } });
}
function createMac(pasteboardName?: string): NativeVideoClipboard {
  const k = require('koffi') as typeof import('koffi').default;
  const objc = k.load('/usr/lib/libobjc.A.dylib');
  const appkit = k.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const cls = objc.func('objc_getClass', 'void *', ['str']);
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const send = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const object = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const objects = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *', 'void *']);
  const string = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'str']);
  const utf8 = objc.func('objc_msgSend', 'str', ['void *', 'void *']);
  const integer = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
  const at = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'unsigned long']);
  const bool = objc.func('objc_msgSend', 'uint8', ['void *', 'void *']);
  const write = objc.func('objc_msgSend', 'uint8', ['void *', 'void *', 'void *']);
  const ns = (text: string) => string(cls('NSString'), sel('stringWithUTF8String:'), text);
  const withBoard = <T>(work: (board: unknown) => T): T => {
    void appkit; // Keep loaded libraries alive for every Objective-C dispatch.
    const pool = send(send(cls('NSAutoreleasePool'), sel('alloc')), sel('init'));
    try {
      const board = pasteboardName === undefined ? send(cls('NSPasteboard'), sel('generalPasteboard'))
        : object(cls('NSPasteboard'), sel('pasteboardWithName:'), ns(pasteboardName));
      if (!board) throw new Error('系统剪贴板不可用');
      return work(board);
    } finally { send(pool, sel('drain')); }
  };
  return { supported: true,
    revision: () => withBoard(board => Number(integer(board, sel('changeCount')))),
    files: () => withBoard(board => {
      const classes = object(cls('NSArray'), sel('arrayWithObject:'), cls('NSURL'));
      const urls = objects(board, sel('readObjectsForClasses:options:'), classes, null);
      const count = urls ? Number(integer(urls, sel('count'))) : 0;
      if (count > 4096) throw new Error('剪贴板文件过多');
      const paths: string[] = [];
      for (let i = 0; i < count; i++) {
        const url = at(urls, sel('objectAtIndex:'), i);
        if (bool(url, sel('isFileURL'))) paths.push(utf8(send(url, sel('path')), sel('UTF8String')));
      }
      return paths;
    }),
    write: (file, revision) => withBoard(board => {
      const url = object(cls('NSURL'), sel('fileURLWithPath:'), ns(file));
      const urls = object(cls('NSArray'), sel('arrayWithObject:'), url);
      if (!url || !urls) throw new Error('视频文件引用无效');
      if (Number(integer(board, sel('changeCount'))) !== revision) throw stale();
      integer(board, sel('clearContents'));
      if (!write(board, sel('writeObjects:'), urls)) throw new Error('视频复制失败，请重试');
    }),
  };
}

/** Named pasteboards are only a native fixture seam; production always uses the general board. */
export function createNativeVideoClipboard(platform: NodeJS.Platform = process.platform, pasteboardName?: string): NativeVideoClipboard {
  if (platform === 'darwin') return createMac(pasteboardName);
  if (platform === 'win32') return createWindows();
  return { supported: false, revision: () => 0, files: () => [], write: () => { throw new Error('当前平台暂不支持复制视频'); } };
}
