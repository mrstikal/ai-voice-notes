import { createScribeTokenRouteHandler } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createScribeTokenRouteHandler();
