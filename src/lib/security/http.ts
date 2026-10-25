import type { ZodType } from "zod";

import { validateStartupEnvironment } from "../config.ts";

export const NOTE_EDIT_MAX_BYTES = 1_048_576;
export const TOKEN_TOOL_MAX_BYTES = 16 * 1024;
export const MEETING_SAVE_MAX_BYTES = 3 * 1024 * 1024;
export const MEETING_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

export type MutationMethod = "POST" | "PATCH" | "DELETE";

export interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly [key: string]: unknown;
  };
}

export interface RateLimitOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  reset(key?: string): void;
}

export interface GuardedJsonRouteContext<TData, TRouteContext> {
  readonly request: Request;
  readonly data: TData;
  readonly appOrigin: string;
  readonly routeContext: TRouteContext | undefined;
}

export interface GuardedJsonRouteOptions<TData, TRouteContext> {
  readonly maxBytes: number;
  readonly schema: ZodType<TData>;
  readonly methods?: readonly MutationMethod[];
  readonly appOrigin?: string;
  readonly rateLimit?: RateLimitOptions & { readonly key?: string };
  readonly handler: (
    context: GuardedJsonRouteContext<TData, TRouteContext>,
  ) => Response | Promise<Response>;
}

export interface GuardedReadRouteOptions<TRouteContext> {
  readonly appOrigin?: string;
  readonly handler: (
    request: Request,
    routeContext: TRouteContext | undefined,
  ) => Response | Promise<Response>;
}

type ResolvedOrigin =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly response: Response };

function jsonResponse(
  status: number,
  body: unknown,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  if (headers) {
    new Headers(headers).forEach((value, key) => {
      responseHeaders.set(key, value);
    });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse(
    status,
    {
      error: { ...details, code, message },
    } satisfies ApiErrorPayload,
    headers,
  );
}

export function jsonOk(data: unknown, status = 200): Response {
  return jsonResponse(status, data);
}

function invalidConfigResponse(): Response {
  return jsonError(
    500,
    "invalid_config",
    "Konfigurace aplikace je neplatná.",
  );
}

function resolveAppOrigin(appOrigin?: string): ResolvedOrigin {
  if (appOrigin !== undefined && appOrigin.trim() === "") {
    return { ok: false, response: invalidConfigResponse() };
  }

  try {
    const env = appOrigin === undefined ? process.env : { APP_ORIGIN: appOrigin };

    return {
      ok: true,
      origin: validateStartupEnvironment(env).appOrigin,
    };
  } catch {
    return { ok: false, response: invalidConfigResponse() };
  }
}

export function checkLocalHost(
  request: Request,
  appOrigin: string,
): Response | null {
  if (appOrigin.trim() === "") {
    return invalidConfigResponse();
  }

  let parsedOrigin: URL;

  try {
    parsedOrigin = new URL(
      validateStartupEnvironment({ APP_ORIGIN: appOrigin }).appOrigin,
    );
  } catch {
    return invalidConfigResponse();
  }

  const expectedHost = parsedOrigin.host.toLowerCase();
  const actualHost = request.headers.get("host")?.trim().toLowerCase();

  if (!actualHost || actualHost !== expectedHost) {
    return jsonError(
      403,
      "invalid_host",
      "Neplatný Host požadavku. Aplikace přijímá pouze nakonfigurovaný loopback host.",
    );
  }

  return null;
}

export function checkMutationOrigin(
  request: Request,
  appOrigin: string,
): Response | null {
  const origin = request.headers.get("origin");

  if (origin === null || origin !== appOrigin) {
    return jsonError(
      403,
      "invalid_origin",
      "Požadavek musí mít přesný původ aplikace.",
    );
  }

  return null;
}

export function checkJsonContentType(request: Request): Response | null {
  const contentType = request.headers.get("content-type");

  if (!contentType) {
    return jsonError(
      415,
      "invalid_content_type",
      "Požadavek musí mít Content-Type application/json.",
    );
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") {
    return jsonError(
      415,
      "invalid_content_type",
      "Požadavek musí mít Content-Type application/json.",
    );
  }

  return null;
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Byte limit musí být kladné celé číslo.");
  }

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0) {
      return jsonError(
        400,
        "invalid_content_length",
        "Neplatná délka požadavku.",
      );
    }

    if (length > maxBytes) {
      return jsonError(
        413,
        "payload_too_large",
        `Požadavek překračuje povolený limit ${maxBytes} bajtů.`,
      );
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
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
        await reader.cancel().catch(() => undefined);
        return jsonError(
          413,
          "payload_too_large",
          `Požadavek překračuje povolený limit ${maxBytes} bajtů.`,
        );
      }

      chunks.push(value);
    }
  } catch {
    return jsonError(
      400,
      "body_read_failed",
      "Požadavek se nepodařilo přečíst.",
    );
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function parseJsonBody(
  body: Uint8Array,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly response: Response } {
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_utf8",
        "Tělo požadavku není platné UTF-8.",
      ),
    };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_json",
        "Tělo požadavku není platný JSON.",
      ),
    };
  }
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new RangeError("Rate limit musí být kladné celé číslo.");
  }

  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new RangeError("Rate-limit window musí být kladné celé číslo.");
  }

  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key) {
      const timestamp = now();
      const current = windows.get(key);

      if (!current || current.resetAt <= timestamp) {
        windows.set(key, {
          count: 1,
          resetAt: timestamp + options.windowMs,
        });
        return {
          allowed: true,
          remaining: options.limit - 1,
          retryAfterSeconds: 0,
        };
      }

      if (current.count >= options.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.resetAt - timestamp) / 1000),
          ),
        };
      }

      current.count += 1;

      return {
        allowed: true,
        remaining: options.limit - current.count,
        retryAfterSeconds: 0,
      };
    },
    reset(key) {
      if (key === undefined) {
        windows.clear();
      } else {
        windows.delete(key);
      }
    },
  };
}

export function createGuardedJsonRoute<TData, TRouteContext = unknown>(
  options: GuardedJsonRouteOptions<TData, TRouteContext>,
): (request: Request, routeContext?: TRouteContext) => Promise<Response> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError("Byte limit musí být kladné celé číslo.");
  }

  const methods = new Set<MutationMethod>(
    options.methods ?? ["POST", "PATCH", "DELETE"],
  );
  const limiter = options.rateLimit
    ? createRateLimiter(options.rateLimit)
    : null;

  return async (request, routeContext) => {
    if (!methods.has(request.method as MutationMethod)) {
      return jsonError(
        405,
        "method_not_allowed",
        "Tento endpoint přijímá pouze mutační požadavky.",
      );
    }

    const resolved = resolveAppOrigin(options.appOrigin);
    if (!resolved.ok) {
      return resolved.response;
    }

    const hostError = checkLocalHost(request, resolved.origin);
    if (hostError) {
      return hostError;
    }

    const originError = checkMutationOrigin(request, resolved.origin);
    if (originError) {
      return originError;
    }

    const contentTypeError = checkJsonContentType(request);
    if (contentTypeError) {
      return contentTypeError;
    }

    if (limiter) {
      const decision = limiter.check(options.rateLimit?.key ?? "local");

      if (!decision.allowed) {
        return jsonError(
          429,
          "rate_limited",
          "Příliš mnoho požadavků. Zkuste to znovu později.",
          { "Retry-After": String(decision.retryAfterSeconds) },
        );
      }
    }

    const body = await readBoundedBody(request, options.maxBytes);
    if (body instanceof Response) {
      return body;
    }

    const parsedJson = parseJsonBody(body);
    if (!parsedJson.ok) {
      return parsedJson.response;
    }

    const parsed = options.schema.safeParse(parsedJson.value);
    if (!parsed.success) {
      return jsonError(400, "invalid_shape", "Neplatný tvar požadavku.");
    }

    try {
      return await options.handler({
        request,
        data: parsed.data,
        appOrigin: resolved.origin,
        routeContext,
      });
    } catch {
      return jsonError(
        500,
        "internal_error",
        "Požadavek se nepodařilo zpracovat.",
      );
    }
  };
}

export function createGuardedReadHandler<TRouteContext = unknown>(
  options: GuardedReadRouteOptions<TRouteContext>,
): (request: Request, routeContext?: TRouteContext) => Promise<Response> {
  return async (request, routeContext) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(
        405,
        "method_not_allowed",
        "Tento endpoint přijímá pouze čtecí požadavky.",
      );
    }

    const resolved = resolveAppOrigin(options.appOrigin);
    if (!resolved.ok) {
      return resolved.response;
    }

    const hostError = checkLocalHost(request, resolved.origin);
    if (hostError) {
      return hostError;
    }

    try {
      return await options.handler(request, routeContext);
    } catch {
      return jsonError(
        500,
        "internal_error",
        "Požadavek se nepodařilo zpracovat.",
      );
    }
  };
}
