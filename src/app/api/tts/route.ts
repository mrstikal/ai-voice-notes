import { createTtsRouteHandler } from "@/lib/tts/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createTtsRouteHandler();
