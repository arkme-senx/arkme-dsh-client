export const WINDOWS_BADGE_DOT_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAVklEQVR4nGNgGJTgv7VBKRCfAeKfUAxilxKjURmq+D8ODJJTxmcAPs1wQ/A5m5BmGMb0DpG243YFNLCINeAnTQyg2AuUBSLF0Qg1gLKEhOYd0pPygAAAr4IfzDYKVvYAAAAASUVORK5CYII=";

export interface BadgeDotImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
}

export function createWindowsBadgeDotImage<TImage extends BadgeDotImage>(
  factory: { createFromDataURL(dataUrl: string): TImage }
): TImage {
  const image = factory.createFromDataURL(WINDOWS_BADGE_DOT_DATA_URL);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== 16 || size.height !== 16) {
    throw new Error("Windows badge dot PNG could not be decoded as a 16x16 image");
  }
  return image;
}
