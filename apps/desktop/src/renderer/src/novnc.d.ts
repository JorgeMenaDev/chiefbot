// The part of noVNC's RFB client (@novnc/novnc 1.7, core/rfb.js) this app uses.
// @types/novnc__novnc types the old "lib/rfb" path, not the package's export.
declare module "@novnc/novnc" {
  export default class RFB {
    // Draws the remote screen into `target` and connects to `url` (RFB over WebSocket).
    constructor(target: HTMLElement, url: string);
    // True: the screen is shown but mouse and keyboard are not sent.
    viewOnly: boolean;
    // Scale the remote screen to fit `target`.
    scaleViewport: boolean;
    addEventListener(type: "connect" | "disconnect", listener: () => void): void;
    disconnect(): void;
  }
}
