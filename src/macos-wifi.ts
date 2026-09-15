import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let readSsid: ((interfaceName: string) => string | undefined) | undefined;

/** Read only the active association. CoreWLAN returns nil without location authorization. */
export function macWifiSsid(interfaceName: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    readSsid ??= createReader();
    return readSsid(interfaceName);
  } catch { return undefined; }
}

function createReader(): (interfaceName: string) => string | undefined {
  const koffi = require("koffi") as typeof import("koffi").default;
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  const wlan = koffi.load("/System/Library/Frameworks/CoreWLAN.framework/CoreWLAN");
  const getClass = objc.func("objc_getClass", "void *", ["str"]);
  const selector = objc.func("sel_registerName", "void *", ["str"]);
  const send = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const sendString = objc.func("objc_msgSend", "void *", ["void *", "void *", "str"]);
  const sendObject = objc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]);
  const utf8 = objc.func("objc_msgSend", "str", ["void *", "void *"]);
  const client = send(getClass("CWWiFiClient"), selector("sharedWiFiClient"));
  return interfaceName => {
    // Keep both framework handles alive with the process-scoped shared client.
    void wlan; void objc;
    const name = sendString(getClass("NSString"), selector("stringWithUTF8String:"), interfaceName);
    const networkInterface = sendObject(client, selector("interfaceWithName:"), name);
    if (networkInterface === null) return undefined;
    const ssid = send(networkInterface, selector("ssid"));
    if (ssid === null) return undefined;
    const value = utf8(ssid, selector("UTF8String"));
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
}
