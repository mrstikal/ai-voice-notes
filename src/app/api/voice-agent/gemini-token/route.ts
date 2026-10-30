import { createGeminiTokenRouteHandler } from "@/lib/voice-agent/gemini-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createGeminiTokenRouteHandler();
