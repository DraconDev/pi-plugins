/**
 * A minimal, dependency-free PNG codec and resampler.
 *
 * This lives in `src/` rather than in the benchmark because product code needs
 * it too: `src/preview-composer.ts` decodes a generated image to place it inside
 * a cell-grid preview, and the benchmark's terminal renderer measures the same
 * pixels a terminal displays. One implementation means the raster the judge is
 * shown and the raster the composer builds are produced by the same maths.
 *
 * Non-interlaced 8-bit RGB/RGBA only, in and out. Greyscale, palette, 16-bit and
 * interlaced inputs are rejected loudly rather than mis-decoded, because a
 * silently wrong pixel is worse than a loud failure in a measurement path.
 */
import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/**
 * The largest decoded image this will attempt.
 *
 * A PNG declares its own dimensions, and those dimensions decide the size of
 * the allocation. 16 megapixels is comfortably past anything a terminal shows -
 * the renderer resamples down to a few hundred cells - and it turns a 62-byte
 * file claiming 40000x40000 from a 4.8 GB allocation attempt into a clear error.
 */
const MAX_PNG_PIXELS = 16_000_000;
const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced 8-bit PNG into { width, height, data } where data is
 * RGB triplets. Greyscale, palette, 16-bit and interlaced inputs are rejected
 * loudly rather than mis-decoded.
 */
export interface RgbImage {
  width: number;
  height: number;
  /** RGB triplets: `width * height * 3` bytes. */
  data: Buffer;
}

export function decodePng(bytes: Buffer): RgbImage {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG");
  let offset = 8;
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    // A declared length is a claim, not a fact. Truncating silently turned a
    // short IHDR into `undefined` fields coerced to NaN, and an over-long one
    // walked `offset` past the buffer and ended the loop with no error at all.
    if (offset + 12 + length > bytes.length) {
      throw new Error(`PNG chunk ${type} claims ${length} bytes but only ${bytes.length - offset - 8} remain.`);
    }
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    // The chunk's CRC is the one integrity field a decoder can check for free,
    // and it is the field the file format puts there for exactly this. It was
    // read by `encodePng` and never by `decodePng`: a bit flip in a stored CRC
    // decoded as if nothing had happened, and the same flip inside the
    // compressed data surfaced as a zlib error rather than a PNG integrity
    // error. This decoder feeds the benchmark's *measured* raster, so a
    // truncated or bit-rotted image was judged as valid input instead of
    // raising.
    const declaredCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== declaredCrc) {
      throw new Error(`PNG chunk ${type} fails its CRC check.`);
    }
    if (type === "IHDR") {
      if (length < 13) throw new Error(`PNG IHDR is ${length} bytes; the header is 13.`);
      header = {
        width: body.readUInt32BE(0), height: body.readUInt32BE(4),
        bitDepth: body[8], colorType: body[9], interlace: body[12],
      };
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  if (header.bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${header.bitDepth}`);
  if (header.colorType !== 2 && header.colorType !== 6) throw new Error(`Unsupported PNG colour type ${header.colorType}`);
  if (header.interlace !== 0) throw new Error("Interlaced PNGs are not supported");
  const channels = header.colorType === 6 ? 4 : 3;
  // The declared dimensions decide the allocation, so they are checked before it
  // is made. A 62-byte file claiming 40000x40000 RGB asks for 4.8 GB: without
  // this the allocation is attempted and only fails later, when the truncated
  // IDAT cannot satisfy the filter check.
  if (header.width < 1 || header.height < 1) throw new Error(`PNG dimensions ${header.width}x${header.height} are not positive.`);
  const stride = header.width * channels;
  const pixels = header.height * stride;
  if (pixels > MAX_PNG_PIXELS) {
    throw new Error(`PNG is ${header.width}x${header.height} (${pixels} bytes of pixels); the limit is ${MAX_PNG_PIXELS}.`);
  }
  // `maxOutputSize` bounds the inflate itself, so a small IDAT cannot expand
  // past the image the header claims. Not every zlib binding in Node exposes it,
  // so it is added defensively and the post-check below is the real guarantee.
  const inflateOptions = { maxOutputSize: pixels + header.height };
  const raw = (inflateSync as (input: Buffer, options?: Record<string, unknown>) => Buffer)(Buffer.concat(idat), inflateOptions);
  if (raw.length < pixels + header.height) {
    throw new Error(`PNG data is shorter than its header claims (${raw.length} of ${pixels + header.height}).`);
  }
  const out = Buffer.alloc(pixels);
  let position = 0;
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[position];
    position += 1;
    const line = raw.subarray(position, position + stride);
    position += stride;
    const target = row * stride;
    const previous = target - stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? out[target + index - channels]! : 0;
      const up = row > 0 ? out[previous + index]! : 0;
      const upLeft = row > 0 && index >= channels ? out[previous + index - channels]! : 0;
      let value = line[index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      out[target + index] = value & 0xff;
    }
  }
  if (channels === 4) {
    const rgb = Buffer.alloc(header.width * header.height * 3);
    for (let pixel = 0; pixel < header.width * header.height; pixel += 1) {
      rgb[pixel * 3] = out[pixel * 4];
      rgb[pixel * 3 + 1] = out[pixel * 4 + 1];
      rgb[pixel * 3 + 2] = out[pixel * 4 + 2];
    }
    return { width: header.width, height: header.height, data: rgb };
  }
  return { width: header.width, height: header.height, data: out };
}

/** Encode 8-bit RGB pixels as a non-interlaced PNG. */
export function encodePng({ width, height, data }: RgbImage): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    data.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Area-average resample. For a pure downscale every destination pixel is the
 * mean of the source rectangle it covers, which is the correct reconstruction
 * kernel here; a point sample would alias thin strokes into noise.
 */
export function resampleArea({ width, height, data }: RgbImage, targetWidth: number, targetHeight: number): RgbImage {
  if (targetWidth < 1 || targetHeight < 1) throw new Error("Target dimensions must be positive");
  const out = Buffer.alloc(targetWidth * targetHeight * 3);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * scaleX)));
      let r = 0, g = 0, b = 0, samples = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * width + sx) * 3;
          r += data[index]!;
          g += data[index + 1]!;
          b += data[index + 2]!;
          samples += 1;
        }
      }
      const target = (y * targetWidth + x) * 3;
      out[target] = Math.round(r / samples);
      out[target + 1] = Math.round(g / samples);
      out[target + 2] = Math.round(b / samples);
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

