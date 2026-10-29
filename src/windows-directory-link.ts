import { createRequire } from 'node:module'
import { toNamespacedPath } from 'node:path'

let getAttributes: ((path: string) => number) | undefined

/** stat follows the target; Win32 attributes identify even a dangling junction. */
export function isWindowsDirectoryLink(path: string): boolean {
  if (getAttributes === undefined) {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
    const kernel = koffi.load('kernel32.dll')
    const query = kernel.func('__stdcall', 'GetFileAttributesW', 'uint32', ['str16'])
    const lastError = kernel.func('uint32 __stdcall GetLastError()')
    getAttributes = path => {
      const attributes = query(toNamespacedPath(path)) as number
      if (attributes === 0xffffffff) throw new Error(`Cannot inspect snapshot link attributes (Win32 ${lastError()}): ${path}`)
      return attributes
    }
  }
  return (getAttributes(path) & 0x10) !== 0
}
