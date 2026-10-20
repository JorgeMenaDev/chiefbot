// Starts the built server, on port 3000 only. The gateway routes /acme-ui to
// localhost:3000 and its CORS allows only http://localhost:3000, so the UI
// refuses any other port instead of half working there.
const port = process.env.PORT ?? "3000";
if (port !== "3000") {
  console.error(`acme-ui runs only on port 3000, not ${port}: the gateway and its CORS expect 3000.`);
  process.exit(1);
}
await import("./server.js");
