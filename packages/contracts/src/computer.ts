// The ports a bot computer listens on itself, inside its own network namespace, with
// each one's protocol and what it is for. An engineer's template stack joins that namespace, so control
// refuses a template that binds one of them (docs/templates.md). This is the one
// list: the worker reads it, and infra/computer/build.ts writes it into the image as
// ports.env (VNC_PORT=5900), which infra/computer/start.sh reads. No imports, so
// build.ts can read it before any package is installed.
//   vnc  x11vnc, the screen, on loopback; the worker pipes it to control for each viewer
export const computerPorts = {
  vnc: { port: 5900, protocol: "tcp", use: "its screen (VNC)" },
} as const;
