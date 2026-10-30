import { describe, expect, it } from "vitest";

import { describeProposalResult } from "../../src/lib/voice-agent/proposal-result";

describe("P50 proposal result messaging", () => {
  it("announces the actual applied version, not an optimistic success", () => {
    const messaging = describeProposalResult({
      kind: "applied",
      noteId: "note-a",
      noteTitle: "První",
      noteVersion: 7,
      proposalId: "proposal-1",
    });

    expect(messaging.notice).toContain("verzi 7");
    expect(messaging.text).toContain("skutečný serverový výsledek");
    expect(messaging.text).toContain("verzi 7");
    expect(messaging.text).not.toContain("návrh byl připraven");
  });

  it("announces rejection without a change", () => {
    const messaging = describeProposalResult({
      kind: "rejected",
      noteId: "note-a",
      noteTitle: "První",
      proposalId: "proposal-1",
    });

    expect(messaging.notice).toContain("nezapsal žádnou změnu");
    expect(messaging.text).toContain("zamítnutí");
    expect(messaging.text).toContain("skutečný serverový výsledek");
  });

  it("does not claim the note is unchanged when the server says it was already applied", () => {
    const messaging = describeProposalResult({
      code: "proposal_already_applied",
      kind: "failed",
      message: "Návrh už byl aplikován. Poznámka se znovu nezmění.",
      noteId: "note-a",
      noteTitle: "První",
      proposalId: "proposal-1",
    });

    expect(messaging.text).toContain("už byl dříve aplikován");
    expect(messaging.text).toContain("nic nového nezapsal");
    expect(messaging.text).not.toContain("Poznámka se nezměnila");
  });

  it("does not claim the note is unchanged when it was concurrently changed or deleted", () => {
    const messaging = describeProposalResult({
      code: "proposal_conflict",
      kind: "failed",
      message: "Poznámka byla mezitím smazána.",
      noteId: "note-a",
      noteTitle: "První",
      proposalId: "proposal-1",
    });

    expect(messaging.text).toContain("změnila nebo byla smazána");
    expect(messaging.text).not.toContain("Poznámka se nezměnila");
  });

  it("speaks a conflict as a failure and forbids a success claim", () => {
    const messaging = describeProposalResult({
      code: "proposal_stale",
      kind: "failed",
      message: "Poznámka byla mezitím změněna.",
      noteId: "note-a",
      noteTitle: "První",
      proposalId: "proposal-1",
    });

    expect(messaging.notice).toBe("Poznámka byla mezitím změněna.");
    expect(messaging.text).toContain("odmítl");
    expect(messaging.text).toContain("zastaralý");
    expect(messaging.text).toContain("nic nezapsal");
    expect(messaging.text).toContain("skutečný serverový výsledek");
  });
});
