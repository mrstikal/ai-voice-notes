import {
  createGuardedJsonRoute,
  jsonOk,
} from "@/lib/security/http";
import {
  getNoteService,
  saveMeetingInputSchema,
  toNoteErrorResponse,
  type SaveMeetingInput,
  type SaveMeetingResult,
} from "@/lib/notes/service";
import { MEETING_SAVE_MAX_BYTES } from "@/lib/meetings/save-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MeetingSaveService {
  saveMeeting(input: SaveMeetingInput): Promise<SaveMeetingResult>;
}

export function createMeetingSaveHandler(service: MeetingSaveService) {
  return createGuardedJsonRoute({
    maxBytes: MEETING_SAVE_MAX_BYTES,
    schema: saveMeetingInputSchema,
    methods: ["POST"],
    rateLimit: {
      limit: 5,
      windowMs: 60_000,
      key: "meeting-save",
    },
    handler: async ({ data }) => {
      try {
        const result = await service.saveMeeting(data);

        return jsonOk(result, result.duplicate ? 200 : 201);
      } catch (error) {
        return toNoteErrorResponse(error);
      }
    },
  });
}

export const POST = createMeetingSaveHandler({
  saveMeeting: (input) => getNoteService().saveMeeting(input),
});
