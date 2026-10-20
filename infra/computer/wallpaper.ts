// The bot computer's wallpaper: soft grey waves over a light grey gradient,
// drawn at build time (build.ts --dist-only writes dist/wallpaper.png) at the
// screen's size, so start.sh sets it with no scaling.
import { deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

const top: Rgb = [246, 246, 248];
const bottom: Rgb = [226, 227, 232];

// Back to front. Each fills below its edge, y = base + the sum of its sines (as
// fractions of the screen), with `color` fading from `alpha` at the edge to
// nothing `depth` below it.
type Sine = readonly [amplitude: number, periods: number, phase: number];
const waves: ReadonlyArray<{ base: number; sines: readonly Sine[]; color: Rgb; alpha: number; depth: number }> = [
  { base: 0.5, sines: [[0.07, 0.8, 0.4], [0.02, 2.1, 1.3]], color: [255, 255, 255], alpha: 0.55, depth: 0.35 },
  { base: 0.62, sines: [[0.06, 1.1, 2.4], [0.015, 2.7, 0.2]], color: [208, 210, 217], alpha: 0.45, depth: 0.3 },
  { base: 0.74, sines: [[0.05, 0.9, 4.1], [0.02, 1.9, 2.8]], color: [255, 255, 255], alpha: 0.6, depth: 0.3 },
  { base: 0.86, sines: [[0.04, 1.3, 5.6], [0.01, 3.1, 0.9]], color: [196, 199, 207], alpha: 0.4, depth: 0.2 },
];

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
];

// A PNG (8-bit RGB, no interlace) of the wallpaper at width × height.
export function wallpaper(width: number, height: number): Uint8Array {
  // Each row is a filter byte (0: none) and then its pixels.
  const stride = 1 + width * 3;
  const pixels = new Uint8Array(stride * height);
  for (let x = 0; x < width; x++) {
    const layers = waves.map((wave) => ({
      ...wave,
      edge: height * wave.sines.reduce((y, [amplitude, periods, phase]) => y + amplitude * Math.sin((2 * Math.PI * periods * x) / width + phase), wave.base),
    }));
    for (let y = 0; y < height; y++) {
      let color = mix(top, bottom, y / (height - 1));
      for (const { edge, color: waveColor, alpha, depth } of layers) {
        const below = y + 0.5 - edge;
        // The edge's own pixels are covered as far as the edge crosses them, so it is smooth.
        const coverage = Math.min(Math.max(below + 0.5, 0), 1);
        const fade = Math.max(1 - below / (depth * height), 0);
        color = mix(color, waveColor, alpha * coverage * fade);
      }
      pixels.set(color.map(Math.round), y * stride + 1 + x * 3);
    }
  }
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8); // bits per channel
  header.setUint8(9, 2); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(header.buffer)),
    chunk("IDAT", deflateSync(pixels, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

// One PNG chunk: its data's length, its type, the data and the CRC of type and data.
function chunk(type: string, data: Uint8Array) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
  return frame;
}
