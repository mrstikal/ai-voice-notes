import { NextResponse } from "next/server";

import { checkHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await checkHealth();

  return NextResponse.json(
    { status: result.ok ? "ok" : "error", message: result.message },
    {
      status: result.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
