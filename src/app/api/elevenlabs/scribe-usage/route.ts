import { createScribeUsageRouteHandler } from "@/lib/elevenlabs/scribe-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createScribeUsageRouteHandler();
