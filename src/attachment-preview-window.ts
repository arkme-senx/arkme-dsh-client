export const attachmentPreviewName = "arkme-attachment-preview";
export function acceptsPreviewPopup(url: string, name: string, source: string, origin: string | null): boolean {
  try { return url === "about:blank" && name === attachmentPreviewName && origin !== null && new URL(source).origin === origin; }
  catch { return false; }
}
type Bounds = { x: number; y: number; width: number; height: number };
export function previewBounds(saved: Bounds | undefined, area: Bounds): Bounds {
  const width = Math.min(area.width, Math.max(560, saved?.width ?? 800));
  const height = Math.min(area.height, Math.max(400, saved?.height ?? 600));
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(saved?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height))),
  };
}
