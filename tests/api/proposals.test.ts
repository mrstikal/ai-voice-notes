import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createProposal } from "@/app/api/notes/[id]/proposals/route";
import { GET as getProposal } from "@/app/api/notes/[id]/proposals/[proposalId]/route";
import { POST as rejectProposal } from "@/app/api/notes/[id]/proposals/[proposalId]/reject/route";
import {
  EditProposalNotFoundError,
  type CreatedEditProposalDto,
  type EditProposalDto,
} from "@/lib/notes/proposals";

const service = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("@/lib/notes/proposals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes/proposals")>();

  return {
    ...actual,
    getEditProposalService: () => service,
  };
});

const APP_ORIGIN = "http://127.0.0.1:3000";
const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";

const operation = {
  type: "replace_sentence" as const,
  target: { startPhrase: "První", endPhrase: "věta" },
  text: "Nová věta.",
};

function proposalDto(
  overrides: Partial<EditProposalDto> = {},
): EditProposalDto {
  return {
    id: PROPOSAL_ID,
    noteId: NOTE_ID,
    noteTitle: "Testovací poznámka",
    expectedVersion: 1,
    originalHash: "a".repeat(64),
    operation,
    beforeMd: "První věta. Druhá věta.",
    afterMd: "Nová věta. Druhá věta.",
    selectedCandidate: null,
    status: "pending",
    expiresAt: new Date("2026-10-27T10:05:00.000Z"),
    createdAt: new Date("2026-10-27T10:00:00.000Z"),
    updatedAt: new Date("2026-10-27T10:00:00.000Z"),
    diff: {
      start: 0,
      end: 5,
      prefix: "",
      removed: "První",
      inserted: "Nová",
      suffix: " věta. Druhá věta.",
    },
    ...overrides,
  };
}

function createdDto(
  overrides: Partial<CreatedEditProposalDto> = {},
): CreatedEditProposalDto {
  return {
    ...proposalDto(),
    confirmationNonce: "raw-ui-nonce",
    ...overrides,
  };
}

function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | null>;
    contentType?: string | null;
  } = {},
): Request {
  const headers = new Headers({
    host: "127.0.0.1:3000",
    origin: APP_ORIGIN,
  });

  if (options.body !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
  }

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  return new Request(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function createContext() {
  return { params: Promise.resolve({ id: NOTE_ID }) };
}

function proposalContext() {
  return {
    params: Promise.resolve({ id: NOTE_ID, proposalId: PROPOSAL_ID }),
  };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };

  return body.error?.code ?? "";
}

describe("proposal API", () => {
  beforeAll(() => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a 201 proposal and returns the raw UI nonce only in this response", async () => {
    service.create.mockResolvedValue(createdDto());

    const response = await createProposal(
      request(`/api/notes/${NOTE_ID}/proposals`, {
        method: "POST",
        body: { operation, expectedVersion: 1 },
      }),
      createContext(),
    );

    expect(response.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(NOTE_ID, {
      operation,
      expectedVersion: 1,
    });

    const body = (await response.json()) as CreatedEditProposalDto & {
      confirmationNonce: string;
    };
    expect(body.confirmationNonce).toBe("raw-ui-nonce");
    expect(body).toMatchObject({
      id: PROPOSAL_ID,
      noteId: NOTE_ID,
      status: "pending",
      expectedVersion: 1,
    });
  });

  it("returns GET and reject payloads without a nonce", async () => {
    service.get.mockResolvedValue(proposalDto());
    service.reject.mockResolvedValue(proposalDto({ status: "rejected" }));

    const get = await getProposal(
      request(`/api/notes/${NOTE_ID}/proposals/${PROPOSAL_ID}`),
      proposalContext(),
    );
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as Record<string, unknown>;
    expect(getBody).toMatchObject({ id: PROPOSAL_ID, status: "pending" });
    expect(getBody).not.toHaveProperty("confirmationNonce");

    const reject = await rejectProposal(
      request(`/api/notes/${NOTE_ID}/proposals/${PROPOSAL_ID}/reject`, {
        method: "POST",
        body: {},
      }),
      proposalContext(),
    );
    expect(reject.status).toBe(200);
    const rejectBody = (await reject.json()) as Record<string, unknown>;
    expect(rejectBody).toMatchObject({ status: "rejected" });
    expect(rejectBody).not.toHaveProperty("confirmationNonce");
  });

  it("maps a missing proposal to 404 without mutating anything", async () => {
    service.get.mockRejectedValue(new EditProposalNotFoundError());

    const response = await getProposal(
      request(`/api/notes/${NOTE_ID}/proposals/${PROPOSAL_ID}`),
      proposalContext(),
    );

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("proposal_not_found");
  });

  it("rejects missing/wrong origin, non-JSON content and an unbound candidate", async () => {
    const missingOrigin = await createProposal(
      request(`/api/notes/${NOTE_ID}/proposals`, {
        method: "POST",
        body: { operation, expectedVersion: 1 },
        headers: { origin: null },
      }),
      createContext(),
    );
    expect(missingOrigin.status).toBe(403);
    expect(await errorCode(missingOrigin)).toBe("invalid_origin");

    const wrongOrigin = await createProposal(
      request(`/api/notes/${NOTE_ID}/proposals`, {
        method: "POST",
        body: { operation, expectedVersion: 1 },
        headers: { origin: "http://evil.example" },
      }),
      createContext(),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(await errorCode(wrongOrigin)).toBe("invalid_origin");

    const wrongContentType = await createProposal(
      request(`/api/notes/${NOTE_ID}/proposals`, {
        method: "POST",
        body: { operation, expectedVersion: 1 },
        contentType: "text/plain",
      }),
      createContext(),
    );
    expect(wrongContentType.status).toBe(415);
    expect(await errorCode(wrongContentType)).toBe("invalid_content_type");

    const unboundCandidate = await createProposal(
      request(`/api/notes/${NOTE_ID}/proposals`, {
        method: "POST",
        body: { operation, candidateId: "p0:s0" },
      }),
      createContext(),
    );
    expect(unboundCandidate.status).toBe(400);
    expect(await errorCode(unboundCandidate)).toBe("invalid_shape");
    expect(service.create).not.toHaveBeenCalled();
  });
});
