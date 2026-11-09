import { createRequire } from "node:module";

/** Redirect a desktop shortcut launch only while our installer owns its progress window. */
export function focusWindowsUpdateWindow(): boolean {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi").default;
  const user = koffi.load("user32.dll");
  const find = user.func("__stdcall", "FindWindowW", "void *", ["str16", "str16"]);
  const window = find("#32770", "即我正在更新");
  if (!window) return false;
  const property = user.func("__stdcall", "GetPropW", "void *", ["void *", "str16"]);
  if (!property(window, "cc.jiwo.arkme.update.active")) return false;
  user.func("__stdcall", "ShowWindowAsync", "bool", ["void *", "int"])(window, 9);
  user.func("__stdcall", "SetForegroundWindow", "bool", ["void *"])(window);
  return true;
}
