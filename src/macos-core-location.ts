import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";

export interface MacCoreLocationDriver {
  authorizationStatus(): number;
  locationServicesEnabled(): boolean;
  requestWhenInUseAuthorization(): void;
  dispose(): void;
}

const CORE_LOCATION_FRAMEWORK = "/System/Library/Frameworks/CoreLocation.framework/CoreLocation";
const OBJC_RUNTIME = "/usr/lib/libobjc.A.dylib";

const require = createRequire(import.meta.url);

/**
 * Loads CoreLocation into the Electron browser process and keeps the
 * CLLocationManager in that process. This is intentionally not a helper
 * executable: macOS TCC must associate the request with the Arkme app bundle.
 */
export function createMacCoreLocationDriver(
  platform: NodeJS.Platform = process.platform
): MacCoreLocationDriver {
  if (platform !== "darwin") throw new Error("CoreLocation is only available on macOS");
  // Do not resolve the native addon at module load time. Windows and Linux
  // import the desktop main module too, but never need a CoreLocation driver.
  const koffi = require("koffi") as typeof import("koffi").default;
  const objcObject = koffi.pointer(koffi.opaque());
  const objcSelector = koffi.pointer(koffi.opaque());
  const objc = koffi.load(OBJC_RUNTIME);
  const coreLocation = koffi.load(CORE_LOCATION_FRAMEWORK);
  const objcGetClass = objc.func("objc_getClass", objcObject, ["str"]);
  const selRegisterName = objc.func("sel_registerName", objcSelector, ["str"]);
  const sendObject = objc.func("objc_msgSend", objcObject, [objcObject, objcSelector]);
  const sendBool = objc.func("objc_msgSend", "uint8_t", [objcObject, objcSelector]);
  const sendInt = objc.func("objc_msgSend", "int32_t", [objcObject, objcSelector]);
  const sendVoid = objc.func("objc_msgSend", "void", [objcObject, objcSelector]);

  const managerClass = objcGetClass("CLLocationManager");
  if (managerClass === null) throw new Error("CLLocationManager is unavailable");
  const allocatedManager = sendObject(managerClass, selRegisterName("alloc"));
  if (allocatedManager === null) throw new Error("CLLocationManager allocation failed");
  const manager = sendObject(allocatedManager, selRegisterName("init"));
  if (manager === null) throw new Error("CLLocationManager initialization failed");

  return new KoffiMacCoreLocationDriver({
    coreLocation,
    objc,
    manager,
    managerClass,
    authorizationStatusSelector: selRegisterName("authorizationStatus"),
    locationServicesEnabledSelector: selRegisterName("locationServicesEnabled"),
    releaseSelector: selRegisterName("release"),
    requestWhenInUseSelector: selRegisterName("requestWhenInUseAuthorization"),
    sendBool,
    sendInt,
    sendVoid
  });
}

class KoffiMacCoreLocationDriver implements MacCoreLocationDriver {
  private disposed = false;

  constructor(private readonly native: {
    // Retain the framework handle for at least as long as the Objective-C object.
    coreLocation: LibraryHandle;
    objc: LibraryHandle;
    manager: unknown;
    managerClass: unknown;
    authorizationStatusSelector: unknown;
    locationServicesEnabledSelector: unknown;
    releaseSelector: unknown;
    requestWhenInUseSelector: unknown;
    sendBool(receiver: unknown, selector: unknown): number;
    sendInt(receiver: unknown, selector: unknown): number;
    sendVoid(receiver: unknown, selector: unknown): void;
  }) {}

  authorizationStatus(): number {
    this.assertActive();
    return this.native.sendInt(
      this.native.manager,
      this.native.authorizationStatusSelector
    );
  }

  locationServicesEnabled(): boolean {
    this.assertActive();
    return this.native.sendBool(
      this.native.managerClass,
      this.native.locationServicesEnabledSelector
    ) !== 0;
  }

  requestWhenInUseAuthorization(): void {
    this.assertActive();
    this.native.sendVoid(this.native.manager, this.native.requestWhenInUseSelector);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.native.sendVoid(this.native.manager, this.native.releaseSelector);
    // CoreLocation is a process framework. Do not unload it while Electron is
    // still alive; releasing the manager is the owned-resource cleanup.
    void this.native.coreLocation;
    void this.native.objc;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("CLLocationManager is disposed");
  }
}
