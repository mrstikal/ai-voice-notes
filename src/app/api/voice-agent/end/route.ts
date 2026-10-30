import { createVoiceAgentEndRouteHandler } from "@/lib/voice-agent/openai-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createVoiceAgentEndRouteHandler();
