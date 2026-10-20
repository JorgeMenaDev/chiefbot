import { expect, test } from "bun:test";
import { viewerBytes } from "./rfbViewer.ts";

// noVNC's opening bytes to x11vnc -nopw: RFB 3.8, security None, ClientInit.
const handshake = [...new TextEncoder().encode("RFB 003.008\n"), 1, 1];
const watch = [3, 1, 0, 0, 0, 0, 5, 0, 3, 32]; // FramebufferUpdateRequest
const encodings = [2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 7]; // SetEncodings: Raw, Tight
const key = [4, 1, 0, 0, 0, 0, 0, 0x61]; // KeyEvent: "a" down
const pointer = [5, 1, 0, 10, 0, 20]; // PointerEvent: left button at 10,20
const paste = [6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]; // ClientCutText: "hi"

const run = (chunks: number[][], input: boolean) => {
  const pass = viewerBytes();
  return chunks.map((chunk) => pass(new Uint8Array(chunk), input));
};
const bytes = (out: Array<Uint8Array | null>) => out.flatMap((chunk): Array<number | "end"> => (chunk ? [...chunk] : ["end"]));

test("a viewer who does not drive gets the screen but its keys, pointer and clipboard never reach the computer", () => {
  const out = run([handshake, encodings, watch, key, pointer, paste, watch], false);

  expect(bytes(out)).toEqual([...handshake, ...encodings, ...watch, ...watch]);
});

test("the viewer who drives passes everything, also messages split across frames or sent together", () => {
  const stream = [...handshake, ...watch, ...key, ...pointer, ...paste];

  const out = run([stream.slice(0, 5), stream.slice(5, 21), stream.slice(21, 30), stream.slice(30)], true);

  expect(bytes(out)).toEqual(stream);
});

test("a viewer cannot ask for the screen alone: its ClientInit always says shared", () => {
  const out = run([[...handshake.slice(0, -1), 0]], false);

  expect(bytes(out)).toEqual(handshake);
});

test("bytes it cannot read end the stream: another protocol version, security type or message type", () => {
  expect(bytes(run([[...new TextEncoder().encode("RFB 003.003\n")]], true))).toEqual(["end"]);
  expect(bytes(run([[...handshake.slice(0, 12), 16]], true))).toEqual(["end"]);
  expect(bytes(run([handshake, [99, 0, 0, 0]], true)).at(-1)).toBe("end");
});

test("a clipboard longer than 1 MB ends the stream at its header, so no viewer can make control hold its bytes", () => {
  const header = (length: number) => [6, 0, 0, 0, ...[24, 16, 8, 0].map((shift) => (length >>> shift) & 0xff)];

  expect(bytes(run([handshake, header(2 ** 20 + 1)], true)).at(-1)).toBe("end");
  expect(bytes(run([handshake, header(-(2 ** 20 + 1) >>> 0)], true)).at(-1)).toBe("end");
  expect(bytes(run([handshake, [...header(2), 0x68, 0x69]], true))).toEqual([...handshake, ...header(2), 0x68, 0x69]);
});
