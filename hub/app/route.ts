export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ name: "Claude Usage Hub", ok: true }, { headers: { "Cache-Control": "no-store" } });
}
