/**
 * Prepares a picture the user chose for a subscription: decodes it in the browser, crops it to a centred square, shrinks it to
 * 128 x 128 and re-encodes it. Re-encoding drops any metadata (location, camera, ...) and guarantees what is uploaded is a plain,
 * small raster image whatever the original was; the server checks it again and never trusts this step.
 */
export const ICON_PIXELS = 128;
export const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 40 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

export class IconImageError extends Error {}

export interface Decoder {
  decode(file: Blob): Promise<{ width: number; height: number; draw(ctx: CanvasRenderingContext2D, sx: number, sy: number, side: number): void; close(): void }>;
  canvas(size: number): { getContext(kind: '2d'): CanvasRenderingContext2D | null; toBlob(cb: (b: Blob | null) => void, type: string, quality?: number): void };
}

export const browserDecoder: Decoder = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, sx, sy, side) => ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, ICON_PIXELS, ICON_PIXELS),
      close: () => bitmap.close(),
    };
  },
  canvas(size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  },
};

const encode = (canvas: ReturnType<Decoder['canvas']>, type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function prepareIconImage(file: File | Blob, decoder: Decoder = browserDecoder): Promise<Blob> {
  if (!ACCEPTED.includes(file.type)) throw new IconImageError('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_ORIGINAL_BYTES) throw new IconImageError('That image is too large. Choose one under 8 MB.');
  let source;
  try {
    source = await decoder.decode(file);
  } catch {
    throw new IconImageError('That file could not be read as an image.');
  }
  try {
    if (source.width < 1 || source.height < 1) throw new IconImageError('That image is empty.');
    const side = Math.min(source.width, source.height);
    const canvas = decoder.canvas(ICON_PIXELS);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new IconImageError('Your browser can’t prepare images here.');
    source.draw(ctx, Math.floor((source.width - side) / 2), Math.floor((source.height - side) / 2), side);
    // Prefer WebP (small); fall back to PNG where the browser can't encode it. Lower the quality until it fits.
    for (const [type, quality] of [['image/webp', 0.9], ['image/webp', 0.75], ['image/webp', 0.55], ['image/png', undefined]] as const) {
      const blob = await encode(canvas, type, quality);
      if (blob && ACCEPTED.includes(blob.type) && blob.size <= MAX_UPLOAD_BYTES) return blob;
    }
    throw new IconImageError('That image is too detailed to shrink small enough. Try a simpler one.');
  } finally {
    source.close();
  }
}
