// The compose health check. The dev login in proxy.ts skips it.
export function GET() {
  return new Response("ok");
}
