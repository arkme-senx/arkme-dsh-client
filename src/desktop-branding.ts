import type { ArkmeAppIdentity } from "./app-identity.js";

export const BRANDING_LOCALE_CHANNEL = "arkme-desktop:branding-locale";
export const BRANDING_SNAPSHOT_CHANNEL = "arkme-desktop:branding-snapshot";
export type BrandLocale = "zh" | "en";
export interface DesktopBrand {
  locale: BrandLocale;
  name: string;
  icon: "jiwo.png" | "arkme.png";
}

export function resolveBrandLocale(locale: string): BrandLocale {
  return /^zh(?:[-_]|$)/i.test(locale) ? "zh" : "en";
}

export function resolveDesktopBrand(locale: BrandLocale, identity: ArkmeAppIdentity): DesktopBrand {
  return {
    locale,
    name: identity.protocol === "arkme" ? (locale === "zh" ? "即我" : "Arkme") : identity.appName,
    icon: locale === "zh" ? "jiwo.png" : "arkme.png"
  };
}

/** Two bundled images, one presentation owner. No preference, path or image from IPC. */
export class DesktopBranding {
  private current: DesktopBrand | undefined;
  constructor(
    private readonly identity: ArkmeAppIdentity,
    private readonly apply: (brand: DesktopBrand) => void
  ) {}

  snapshot(): DesktopBrand | null { return this.current ?? null; }

  setLocale(value: unknown): boolean {
    if (value !== "zh" && value !== "en") return false;
    if (this.current?.locale === value) return true;
    const brand = resolveDesktopBrand(value, this.identity);
    this.apply(brand);
    this.current = brand;
    return true;
  }
}

export function registerDesktopBrandingIpc<TEvent>(
  ipc: {
    handle(channel: string, listener: (event: TEvent, value: unknown) => unknown): void;
    on(channel: string, listener: (event: TEvent & { returnValue: unknown }) => void): void;
  },
  branding: DesktopBranding,
  authorized: (event: TEvent, write: boolean) => boolean,
  onError: (error: unknown) => void
): void {
  ipc.handle(BRANDING_LOCALE_CHANNEL, (event, value) => {
    if (!authorized(event, true)) return false;
    try { return branding.setLocale(value); }
    catch (error) { onError(error); return false; }
  });
  ipc.on(BRANDING_SNAPSHOT_CHANNEL, event => {
    event.returnValue = authorized(event, false) ? branding.snapshot() : null;
  });
}
