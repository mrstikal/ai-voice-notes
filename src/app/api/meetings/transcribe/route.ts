import { createMeetingTranscribeHandlers } from "@/lib/meetings/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createMeetingTranscribeHandlers();

export function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

export function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
