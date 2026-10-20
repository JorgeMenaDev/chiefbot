// What control passes on from one viewer of a shared screen. It reads the
// viewer's side of RFB (3.7 or 3.8 with security None or VNC auth, as noVNC
// speaks to x11vnc -nopw) message by message. Everything a viewer needs to
// watch goes on. Input (keys, pointer, clipboard, desktop size, power) goes on
// only while `input` says this viewer drives the screen. ClientInit always goes
// as shared, so no viewer can make the server drop the others.
//
// Returns the bytes to pass on, or null for bytes it cannot read: the caller
// then ends the stream, as there is no telling input from the rest any more.
export function viewerBytes() {
  let stage: "version" | "security" | "auth" | "init" | "messages" = "version";
  let pending = new Uint8Array(0);

  return (chunk: Uint8Array, input: boolean): Uint8Array | null => {
    pending = concat([pending, chunk]);
    const out: Uint8Array[] = [];
    while (pending.length > 0) {
      const next = nextUnit(stage, pending);
      if (next === "invalid") return null;
      if (next === "more") break;
      const unit = pending.subarray(0, next.length);
      pending = pending.slice(next.length);
      if (next.stage) stage = next.stage;
      if (next.kind === "watch" || input) out.push(next.replace ?? unit);
    }
    return concat(out);
  };
}

type Unit = { length: number; kind: "watch" | "input"; stage?: "security" | "auth" | "init" | "messages"; replace?: Uint8Array };

// The next unit of the viewer's stream: how long it is and whether it is input.
// "more" until all of it has arrived.
function nextUnit(stage: "version" | "security" | "auth" | "init" | "messages", bytes: Uint8Array): Unit | "more" | "invalid" {
  const need = (length: number, unit: Omit<Unit, "length">): Unit | "more" => (bytes.length < length ? "more" : { length, ...unit });
  switch (stage) {
    case "version": {
      if (bytes.length < 12) return "more";
      const version = new TextDecoder().decode(bytes.subarray(0, 12));
      return version === "RFB 003.008\n" || version === "RFB 003.007\n" ? { length: 12, kind: "watch", stage: "security" } : "invalid";
    }
    case "security":
      return bytes[0] === 1 ? { length: 1, kind: "watch", stage: "init" } : bytes[0] === 2 ? { length: 1, kind: "watch", stage: "auth" } : "invalid";
    case "auth":
      return need(16, { kind: "watch", stage: "init" });
    case "init":
      return { length: 1, kind: "watch", stage: "messages", replace: new Uint8Array([1]) };
    case "messages":
      return nextMessage(bytes, need);
  }
}

// One client-to-server message, by its type (RFC 6143 and the extensions noVNC sends).
function nextMessage(bytes: Uint8Array, need: (length: number, unit: Omit<Unit, "length">) => Unit | "more"): Unit | "more" | "invalid" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = (length: number, size: () => number, kind: Unit["kind"]) => (bytes.length < length ? "more" : need(size(), { kind }));
  switch (bytes[0]) {
    case 0: // SetPixelFormat
      return need(20, { kind: "watch" });
    case 2: // SetEncodings
      return header(4, () => 4 + 4 * view.getUint16(2), "watch");
    case 3: // FramebufferUpdateRequest
      return need(10, { kind: "watch" });
    case 4: // KeyEvent
      return need(8, { kind: "input" });
    case 5: // PointerEvent, 7 bytes when extended
      return header(2, () => ((bytes[1] ?? 0) & 0x80 ? 7 : 6), "input");
    case 6: // ClientCutText; a negative length is extended clipboard
      return header(8, () => 8 + Math.abs(view.getInt32(4)), "input");
    case 150: // EnableContinuousUpdates
      return need(10, { kind: "watch" });
    case 248: // ClientFence
      return header(9, () => 9 + (bytes[8] ?? 0), "watch");
    case 250: // XVP: shutdown, reboot, reset
      return need(4, { kind: "input" });
    case 251: // SetDesktopSize
      return header(8, () => 8 + 16 * (bytes[6] ?? 0), "input");
    case 255: // QEMU extended key event
      return bytes.length < 2 ? "more" : bytes[1] === 0 ? need(12, { kind: "input" }) : "invalid";
    default:
      return "invalid";
  }
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
