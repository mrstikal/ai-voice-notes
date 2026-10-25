import { z } from "zod";

export const emptyJsonObjectSchema = z.object({}).strict();

export const noteMutationPayloadSchema = z
  .object({
    title: z.string(),
    contentMd: z.string(),
  })
  .strict();

export const tokenRequestSchema = emptyJsonObjectSchema;

export const toolRequestSchema = z
  .object({
    query: z.string().min(1),
  })
  .strict();

export const meetingSavePayloadSchema = z
  .object({
    requestId: z.string(),
    transcript: z.string(),
  })
  .strict();

export type NoteMutationPayload = z.infer<typeof noteMutationPayloadSchema>;
export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type MeetingSavePayload = z.infer<typeof meetingSavePayloadSchema>;
