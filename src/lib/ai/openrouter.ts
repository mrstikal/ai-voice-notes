import {
  UsageServiceError,
  getUsageService,
  type UsageOperationDto,
  type UsageService,
} from "./usage.ts";
import { ConfigurationError, loadConfig } from "../config.ts";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 60_000;
export const OPENROUTER_ERROR_BODY_MAX_BYTES = 64 * 1024;

export interface OpenRouterTransportRequest {
  readonly url: string;
  readonly apiKey: string;
  readonly body: string;
  readonly accept: string;
  readonly signal: AbortSignal;
}

export interface OpenRouterTransport {
  fetch(request: OpenRouterTransportRequest): Promise<Response>;
}

export interface OpenRouterRequestOptions {
  readonly path: string;
  readonly body: unknown;
  readonly operation: string;
  readonly model: string;
  readonly estimatedMaxCostUsd: number;
  readonly accept: string;
  readonly expectedContentType: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs?: number;
  readonly providerUsage?: Readonly<Record<string, unknown>>;
}

export interface OpenRouterResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly generationId: string | null;
  readonly status: number;
}

export interface OpenRouterClientOptions {
  readonly apiKey: string;
  readonly usage: UsageService;
  readonly baseUrl?: string;
  readonly transport?: OpenRouterTransport;
}

export class OpenRouterHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly providerStatus: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    providerStatus: number | null = null,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
    this.status = status;
    this.code = code;
    this.providerStatus = providerStatus;
  }
}

let testTransport: OpenRouterTransport | null = null;

export function setOpenRouterTransportForTests(
  transport: OpenRouterTransport | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Testovací OpenRouter transport lze nastavit pouze v NODE_ENV=test.",
    );
  }

  testTransport = transport;
}

export function getOpenRouterTransport(): OpenRouterTransport {
  if (process.env.NODE_ENV === "test") {
    if (testTransport) {
      return testTransport;
    }

    throw new OpenRouterHttpError(
      500,
      "unmocked_provider_call",
      "V testovacím režimu není povolený nemockovaný odchozí požadavek.",
    );
  }

  return createFetchTransport();
}

function createFetchTransport(): OpenRouterTransport {
  return {
    async fetch({ url, apiKey, body, accept, signal }) {
      return fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept,
        },
        body,
        redirect: "error",
        signal,
      });
    },
  };
}

function validatePath(path: string): string {
  if (
    !/^\/[a-z0-9/_-]+$/iu.test(path) ||
    path.includes("//") ||
    path.includes("..")
  ) {
    throw new OpenRouterHttpError(
      500,
      "invalid_request",
      "Cesta požadavku na OpenRouter je neplatná.",
    );
  }

  return path;
}

function normalizeContentType(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();

  return mediaType || null;
}

function contentTypeMatches(
  actual: string | null,
  expected: string,
): boolean {
  if (actual === null) {
    return false;
  }

  const normalizedExpected = expected.trim().toLowerCase();

  if (actual === normalizedExpected) {
    return true;
  }

  return normalizedExpected === "audio/mpeg" && actual === "audio/mp3";
}

function sanitizeGenerationId(value: string | null): string | null {
  const trimmed = value?.trim();

  if (
    !trimmed ||
    trimmed.length > 200 ||
    /[\s\x00-\x1f\x7f]/u.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

async function markUnknownQuietly(
  usage: UsageService,
  reservationId: string,
  providerUsage: Readonly<Record<string, unknown>>,
): Promise<void> {
  await usage.markUnknown(reservationId, providerUsage).catch(() => undefined);
}

async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new OpenRouterHttpError(
          504,
          "openrouter_timeout",
          "OpenRouter neodpověděl včas. Zkuste to znovu.",
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function mapTransportError(
  error: unknown,
  aborted: boolean,
): OpenRouterHttpError {
  if (error instanceof OpenRouterHttpError) {
    return error;
  }

  if (aborted || (error instanceof Error && error.name === "AbortError")) {
    return new OpenRouterHttpError(
      504,
      "openrouter_timeout",
      "OpenRouter neodpověděl včas. Zkuste to znovu.",
    );
  }

  return new OpenRouterHttpError(
    502,
    "openrouter_network_error",
    "Spojení s OpenRouter se nepodařilo. Zkuste to znovu.",
  );
}

function mapProviderStatus(status: number): OpenRouterHttpError {
  switch (status) {
    case 401:
      return new OpenRouterHttpError(
        502,
        "openrouter_auth_failed",
        "OpenRouter odmítl přihlašovací údaj. Zkontrolujte OPENROUTER_API_KEY.",
        status,
      );
    case 402:
      return new OpenRouterHttpError(
        502,
        "openrouter_insufficient_credits",
        "OpenRouter nemá dostatek kreditu pro tento požadavek.",
        status,
      );
    case 403:
      return new OpenRouterHttpError(
        502,
        "openrouter_forbidden",
        "OpenRouter odmítl požadavek. Zkontrolujte oprávnění klíče.",
        status,
      );
    case 404:
      return new OpenRouterHttpError(
        502,
        "openrouter_model_unavailable",
        "OpenRouter nemá dostupný zvolený model nebo hlas.",
        status,
      );
    case 429:
      return new OpenRouterHttpError(
        503,
        "openrouter_rate_limited",
        "OpenRouter dočasně omezil požadavky. Zkuste to znovu později.",
        status,
      );
    default:
      return new OpenRouterHttpError(
        502,
        "openrouter_error",
        "OpenRouter požadavek odmítl. Zkuste to znovu.",
        status,
      );
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (Number.isSafeInteger(length) && length > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenRouterHttpError(
        502,
        "openrouter_response_too_large",
        "Odpověď OpenRouter překračuje povolený limit.",
      );
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new OpenRouterHttpError(
          502,
          "openrouter_response_too_large",
          "Odpověď OpenRouter překračuje povolený limit.",
        );
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OpenRouterHttpError) {
      throw error;
    }

    void reader.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(
      502,
      "openrouter_network_error",
      "Odpověď OpenRouter se nepodařilo přečíst.",
    );
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly usage: UsageService;
  private readonly baseUrl: string;
  private readonly transport: OpenRouterTransport | null;

  constructor(options: OpenRouterClientOptions) {
    const apiKey = options.apiKey.trim();

    if (apiKey === "") {
      throw new OpenRouterHttpError(
        503,
        "openrouter_not_configured",
        "OpenRouter není nakonfigurovaný. Doplňte OPENROUTER_API_KEY do .env.local.",
      );
    }

    this.apiKey = apiKey;
    this.usage = options.usage;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE_URL).replace(
      /\/+$/u,
      "",
    );
    this.transport = options.transport ?? null;
  }

  async request(
    options: OpenRouterRequestOptions,
  ): Promise<OpenRouterResponse> {
    const path = validatePath(options.path);
    let serializedBody: string;

    try {
      serializedBody = JSON.stringify(options.body);
    } catch {
      throw new OpenRouterHttpError(
        500,
        "invalid_request",
        "Požadavek na OpenRouter nelze serializovat.",
      );
    }

    if (serializedBody === undefined) {
      throw new OpenRouterHttpError(
        500,
        "invalid_request",
        "Požadavek na OpenRouter nelze serializovat.",
      );
    }

    const timeoutMs = options.timeoutMs ?? OPENROUTER_DEFAULT_TIMEOUT_MS;

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new OpenRouterHttpError(
        500,
        "invalid_request",
        "Timeout požadavku na OpenRouter je neplatný.",
      );
    }

    if (
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1
    ) {
      throw new OpenRouterHttpError(
        500,
        "invalid_request",
        "Limit odpovědi OpenRouter je neplatný.",
      );
    }

    const transport = this.transport ?? getOpenRouterTransport();
    let reservation: UsageOperationDto;

    try {
      reservation = await this.usage.reserve({
        operation: options.operation,
        provider: "openrouter",
        model: options.model,
        estimatedMaxCostUsd: options.estimatedMaxCostUsd,
      });
    } catch (error) {
      if (error instanceof UsageServiceError) {
        throw error;
      }

      throw new OpenRouterHttpError(
        503,
        "database_unavailable",
        "Databázi využití se nepodařilo načíst. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
      );
    }

    const controller = new AbortController();
    const responseState: {
      meta: {
        readonly status: number;
        readonly contentType: string | null;
        readonly generationId: string | null;
      } | null;
    } = { meta: null };
    let outcome: { readonly response: Response; readonly bytes: Uint8Array };

    try {
      outcome = await runWithDeadline(
        async (signal) => {
          const response = await transport.fetch({
            url: `${this.baseUrl}${path}`,
            apiKey: this.apiKey,
            body: serializedBody,
            accept: options.accept,
            signal,
          });
          responseState.meta = {
            status: response.status,
            contentType: normalizeContentType(
              response.headers.get("content-type"),
            ),
            generationId: sanitizeGenerationId(
              response.headers.get("x-generation-id"),
            ),
          };
          const isSuccess = response.status >= 200 && response.status < 300;
          const readLimit = isSuccess
            ? options.maxResponseBytes
            : Math.min(
                options.maxResponseBytes,
                OPENROUTER_ERROR_BODY_MAX_BYTES,
              );
          const bytes = await readBoundedResponse(response, readLimit);

          return { response, bytes };
        },
        timeoutMs,
        controller,
      );
    } catch (error) {
      const chargeReason =
        error instanceof OpenRouterHttpError &&
        error.code === "openrouter_response_too_large"
          ? "provider_response_read_failed"
          : "provider_request_failed";
      const meta = responseState.meta;
      await markUnknownQuietly(this.usage, reservation.id, {
        ...options.providerUsage,
        ...(meta === null
          ? {}
          : {
              httpStatus: meta.status,
              contentType: meta.contentType,
              generationId: meta.generationId,
            }),
        chargeReason,
      });
      throw mapTransportError(error, controller.signal.aborted);
    }

    const { response, bytes } = outcome;
    const contentType = normalizeContentType(
      response.headers.get("content-type"),
    );
    const generationId = sanitizeGenerationId(
      response.headers.get("x-generation-id"),
    );
    const isSuccess = response.status >= 200 && response.status < 300;

    if (!isSuccess) {
      await markUnknownQuietly(this.usage, reservation.id, {
        ...options.providerUsage,
        httpStatus: response.status,
        contentType,
        byteLength: bytes.byteLength,
        generationId,
        chargeReason: "provider_request_failed",
      });
      throw mapProviderStatus(response.status);
    }

    if (!contentTypeMatches(contentType, options.expectedContentType)) {
      await markUnknownQuietly(this.usage, reservation.id, {
        ...options.providerUsage,
        httpStatus: response.status,
        contentType,
        byteLength: bytes.byteLength,
        generationId,
        chargeReason: "invalid_provider_response",
      });
      throw new OpenRouterHttpError(
        502,
        "openrouter_invalid_response",
        "OpenRouter nevrátil očekávaný typ odpovědi.",
      );
    }

    try {
      await this.usage.markUnknown(reservation.id, {
        ...options.providerUsage,
        httpStatus: response.status,
        contentType,
        byteLength: bytes.byteLength,
        generationId,
        chargeReason: "openrouter_cost_not_reported",
      });
    } catch {
      throw new OpenRouterHttpError(
        503,
        "openrouter_usage_settlement_failed",
        "Odpověď byla vytvořena, ale využití se nepodařilo zapsat. Zkuste to znovu.",
      );
    }

    return {
      bytes,
      contentType: contentType ?? "",
      generationId,
      status: response.status,
    };
  }
}

export function getOpenRouterClient(): OpenRouterClient {
  const config = loadConfig();
  let usage: UsageService;

  try {
    usage = getUsageService();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }

    throw new OpenRouterHttpError(
      503,
      "database_unavailable",
      "Databáze není dostupná. Zkontrolujte DATABASE_URL a spuštěnou databázi.",
    );
  }

  return new OpenRouterClient({
    apiKey: config.openRouterApiKey ?? "",
    usage,
  });
}
