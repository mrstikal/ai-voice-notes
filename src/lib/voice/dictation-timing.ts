import { publicEnvInt } from "../env-limits.ts";

export const FINAL_COMMIT_TIMEOUT_MS = publicEnvInt(
  process.env.NEXT_PUBLIC_FINAL_COMMIT_TIMEOUT_MS,
  "NEXT_PUBLIC_FINAL_COMMIT_TIMEOUT_MS",
  1500,
);
export const FLUSH_SETTLE_MS = publicEnvInt(
  process.env.NEXT_PUBLIC_FLUSH_SETTLE_MS,
  "NEXT_PUBLIC_FLUSH_SETTLE_MS",
  150,
);
