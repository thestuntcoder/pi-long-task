const MAX_CAUSE_DEPTH = 10;

const NESTED_ERROR_KEYS = [
  "cause",
  "error",
  "errors",
  "innerError",
  "originalError",
  "underlyingError",
  "reason",
  "response",
  "$response",
  "$metadata",
  "diagnosticDetails",
  "payload",
] as const;

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNCLOSED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_SOCKET_CLOSED",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSIENT_TIMEOUT_CODES = new Set([
  "ECONNABORTED",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const RATE_LIMIT_CODES = new Set([
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "THROTTLED",
  "THROTTLING",
  "THROTTLING_EXCEPTION",
  "TOO_MANY_REQUESTS",
]);
const OVERLOAD_CODES = new Set(["CAPACITY_EXCEEDED", "OVERLOADED", "SERVER_OVERLOADED"]);
const SERVER_ERROR_CODES = new Set(["BAD_GATEWAY", "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE"]);
const DETERMINISTIC_TRANSPORT_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const AUTHENTICATION_CODES = new Set([
  "AUTHENTICATION_ERROR",
  "INVALID_API_KEY",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
]);
const AUTHORIZATION_CODES = new Set(["ACCESS_DENIED", "FORBIDDEN", "PERMISSION_DENIED"]);
const BILLING_CODES = new Set([
  "BILLING_ERROR",
  "BILLING_HARD_LIMIT_REACHED",
  "INSUFFICIENT_CREDITS",
  "PAYMENT_REQUIRED",
]);
const QUOTA_CODES = new Set([
  "FREE_USAGE_LIMIT_ERROR",
  "GO_USAGE_LIMIT_ERROR",
  "INSUFFICIENT_QUOTA",
  "MONTHLY_USAGE_LIMIT_REACHED",
  "QUOTA_EXCEEDED",
  "USAGE_LIMIT_REACHED",
  "USAGE_NOT_INCLUDED",
]);
const INVALID_MODEL_CODES = new Set(["INVALID_MODEL", "MODEL_NOT_FOUND", "MODEL_NOT_SUPPORTED", "UNKNOWN_MODEL"]);
const INVALID_REQUEST_CODES = new Set([
  "BAD_REQUEST",
  "CONTENT_POLICY_VIOLATION",
  "CONTEXT_LENGTH_EXCEEDED",
  "INVALID_ARGUMENT",
  "INVALID_REQUEST",
  "INVALID_REQUEST_ERROR",
  "MALFORMED_REQUEST",
  "SAFETY_VIOLATION",
  "UNSUPPORTED_VALUE",
  "VALIDATION_ERROR",
]);

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 523, 524, 525, 527, 529]);
const NON_RETRYABLE_HTTP_STATUSES = new Set([501, 505, 506, 507, 508, 509, 510, 511]);
const TRANSIENT_WEBSOCKET_CLOSE_CODES = new Set([1001, 1006, 1011, 1012, 1013, 1014]);
const NON_RETRYABLE_WEBSOCKET_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009, 1010]);

const AUTHENTICATION_PATTERN =
  /\b(?:authentication (?:failed|required|error)|invalid api[- ]?key|invalid (?:access |auth )?token|expired (?:access |auth )?token|token (?:has )?expired|missing api[- ]?key|unauthenticated|unauthorized)\b/i;
const AUTHORIZATION_PATTERN =
  /\b(?:access denied|authorization (?:failed|required|error)|forbidden|insufficient permissions?|not authorized|permission denied)\b/i;
const BILLING_PATTERN =
  /\b(?:billing|payment required|payment method|credit balance|credits? exhausted|insufficient credits?|out of (?:credits?|budget)|spend(?:ing)? limit)\b/i;
const QUOTA_PATTERN =
  /\b(?:FreeUsageLimitError|GoUsageLimitError|insufficient[_ -]?quota|monthly usage limit|weekly usage limit|daily usage limit|quota (?:has been )?(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached) (?:your )?(?:current )?quota|usage (?:quota|limit).*?(?:exceeded|exhausted|reached)|usage_not_included)\b/i;
const INVALID_MODEL_PATTERN =
  /\b(?:invalid model|model (?:does not exist|is not (?:available|supported)|not found)|unknown model|unsupported model)\b/i;
const INVALID_REQUEST_PATTERN =
  /\b(?:bad request|content policy violation|context (?:length|window).*(?:exceeded|too (?:large|long))|invalid (?:argument|parameter|request)|malformed request|request validation failed|safety violation|unsupported (?:parameter|value))\b/i;
const DETERMINISTIC_TRANSPORT_PATTERN =
  /\b(?:certificate (?:has )?expired|certificate hostname mismatch|self[- ]signed certificate|unable to verify (?:the )?(?:first|leaf) certificate)\b/i;
const COORDINATOR_TIMEOUT_PATTERN =
  /\b(?:task|session|planner|reviewer|iteration|goal(?: loop)?) (?:exceeded|timed out|timeout|deadline)\b/i;
const TIMEOUT_PATTERN =
  /\b(?:connect(?:ion)?|fetch|gateway|headers?|idle|network|read|request|response|socket|upstream|websocket)[- ]?(?:timed? ?out|timeout)|\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:BODY|CONNECT|HEADERS)_TIMEOUT)\b|\bdeadline exceeded\b/i;
const STREAM_PATTERN =
  /\b(?:premature (?:close|end)|response body.*(?:aborted|terminated)|socket (?:connection )?(?:was )?(?:closed|disconnected|hung up)|stream (?:closed|disconnected|ended before|ended without|terminated)|terminated prematurely|unexpected end of (?:file|stream)|websocket (?:closed|disconnected|error|stream closed))\b|(?:^|\n)(?:TypeError: )?terminated(?:\n|$)|\bended without (?:a )?(?:terminal|response|message_stop)\b|\bother side closed\b|\bHTTP\/2 request did not get a response\b/i;
const TRANSPORT_PATTERN =
  /\b(?:connection (?:closed|error|lost|refused|reset)|DNS (?:error|failure|lookup failed)|failed to fetch|fetch failed|host (?:is )?unreachable|network.?error|network (?:connection )?(?:failed|failure|offline|unavailable)|socket hang up|transport (?:error|failed|failure)|upstream connect)\b|\b(?:EAI_AGAIN|ECONNABORTED|ECONNCLOSED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETRESET|ENETUNREACH|ENOTFOUND|EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET)\b/i;
const OVERLOAD_PATTERN =
  /\b(?:capacity (?:exceeded|temporarily unavailable)|overloaded|server busy|temporarily unavailable|please retry your request|try your request again|you can retry your request)\b/i;
const RATE_LIMIT_PATTERN =
  /\b(?:rate[- _]?limit(?:ed|ing|_exceeded)?|too many requests|ResourceExhausted|throttl(?:ed|ing))\b/i;
const SERVER_ERROR_PATTERN =
  /\b(?:bad gateway|gateway timeout|internal server error|service unavailable|server error)\b/i;

export type NetworkFailureReason =
  | "transport_error"
  | "request_timeout"
  | "stream_disconnected"
  | "provider_overloaded"
  | "rate_limited"
  | "server_error"
  | "cancelled"
  | "authentication"
  | "authorization"
  | "billing"
  | "quota_exhausted"
  | "invalid_model"
  | "invalid_request"
  | "http_client_error"
  | "non_retryable_server_error"
  | "unknown";

export interface NetworkFailureCauseMetadata {
  depth: number;
  name?: string;
  message?: string;
  code?: string;
  statusCode?: number;
}

/** Stable diagnostic data retained independently of provider-specific error classes. */
export interface NetworkFailureMetadata {
  name?: string;
  message: string;
  statusCode?: number;
  statusCodes: readonly number[];
  code?: string;
  codes: readonly string[];
  websocketCloseCode?: number;
  retryAfter?: string;
  retryAfterMs?: number;
  provider?: string;
  requestId?: string;
  causes: readonly NetworkFailureCauseMetadata[];
}

/** Coordinator-level decision made after Pi's own bounded retries are exhausted. */
export interface NetworkFailureClassification {
  recoverable: boolean;
  reason: NetworkFailureReason;
  /** The untouched value, retained for terminal failure propagation and detailed logging. */
  error: unknown;
  metadata: NetworkFailureMetadata;
}

interface ErrorCandidate extends NetworkFailureCauseMetadata {
  value: unknown;
  text: string;
  websocketCloseCode?: number;
  headers?: unknown;
  provider?: string;
  requestId?: string;
}

/**
 * Classify native, provider, SDK-wrapper, serialized, and nested-cause failures.
 *
 * Explicit deterministic evidence always wins over transient-looking wrapper
 * text. Unknown failures are deliberately fail-fast rather than guessed to be
 * network outages.
 */
export function classifyNetworkFailure(error: unknown): NetworkFailureClassification {
  const candidates = collectCandidates(error);
  const metadata = buildMetadata(error, candidates);
  const allText = candidates
    .map((candidate) => candidate.text)
    .filter(Boolean)
    .join("\n");
  const normalizedCodes = metadata.codes.map(normalizeCode);

  const terminal = deterministicReason(metadata, normalizedCodes, allText);
  if (terminal) {
    return { recoverable: false, reason: terminal, error, metadata };
  }

  const recoverable = recoverableReason(metadata, normalizedCodes, allText);
  if (recoverable) {
    return { recoverable: true, reason: recoverable, error, metadata };
  }

  return { recoverable: false, reason: "unknown", error, metadata };
}

export function isRecoverableNetworkFailure(error: unknown): boolean {
  return classifyNetworkFailure(error).recoverable;
}

function deterministicReason(
  metadata: NetworkFailureMetadata,
  normalizedCodes: readonly string[],
  text: string,
): NetworkFailureReason | undefined {
  if (isCancellation(metadata, normalizedCodes, text)) return "cancelled";
  if (hasCode(normalizedCodes, AUTHENTICATION_CODES) || AUTHENTICATION_PATTERN.test(text)) return "authentication";
  if (hasCode(normalizedCodes, AUTHORIZATION_CODES) || AUTHORIZATION_PATTERN.test(text)) return "authorization";
  if (hasCode(normalizedCodes, BILLING_CODES) || BILLING_PATTERN.test(text)) return "billing";
  if (hasCode(normalizedCodes, QUOTA_CODES) || QUOTA_PATTERN.test(text)) return "quota_exhausted";
  if (hasCode(normalizedCodes, INVALID_MODEL_CODES) || INVALID_MODEL_PATTERN.test(text)) return "invalid_model";
  if (hasCode(normalizedCodes, INVALID_REQUEST_CODES) || INVALID_REQUEST_PATTERN.test(text)) return "invalid_request";
  if (hasCode(normalizedCodes, DETERMINISTIC_TRANSPORT_CODES) || DETERMINISTIC_TRANSPORT_PATTERN.test(text)) {
    return "unknown";
  }

  if (
    metadata.websocketCloseCode !== undefined &&
    NON_RETRYABLE_WEBSOCKET_CLOSE_CODES.has(metadata.websocketCloseCode)
  ) {
    return "invalid_request";
  }
  if (metadata.statusCodes.includes(401)) return "authentication";
  if (metadata.statusCodes.includes(403)) return "authorization";
  if (metadata.statusCodes.includes(402)) return "billing";
  if (metadata.statusCodes.includes(400)) return "invalid_request";
  if (metadata.statusCodes.some((status) => status >= 400 && status < 500 && !TRANSIENT_HTTP_STATUSES.has(status))) {
    return "http_client_error";
  }
  if (metadata.statusCodes.some((status) => NON_RETRYABLE_HTTP_STATUSES.has(status))) {
    return "non_retryable_server_error";
  }
  if (COORDINATOR_TIMEOUT_PATTERN.test(text)) return "unknown";
  return undefined;
}

function recoverableReason(
  metadata: NetworkFailureMetadata,
  normalizedCodes: readonly string[],
  text: string,
): NetworkFailureReason | undefined {
  if (metadata.statusCodes.includes(429)) return "rate_limited";
  if (metadata.statusCodes.some((status) => status === 408 || status === 425 || status === 504)) {
    return "request_timeout";
  }
  if (metadata.statusCodes.some((status) => TRANSIENT_HTTP_STATUSES.has(status))) return "server_error";
  if (metadata.websocketCloseCode !== undefined && TRANSIENT_WEBSOCKET_CLOSE_CODES.has(metadata.websocketCloseCode)) {
    return "stream_disconnected";
  }
  if (normalizedCodes.some((code) => TRANSIENT_NETWORK_CODES.has(code))) {
    return normalizedCodes.some((code) => TRANSIENT_TIMEOUT_CODES.has(code)) ? "request_timeout" : "transport_error";
  }
  if (TIMEOUT_PATTERN.test(text)) return "request_timeout";
  if (STREAM_PATTERN.test(text)) return "stream_disconnected";
  if (TRANSPORT_PATTERN.test(text)) return "transport_error";
  if (hasCode(normalizedCodes, RATE_LIMIT_CODES) || RATE_LIMIT_PATTERN.test(text)) return "rate_limited";
  if (hasCode(normalizedCodes, OVERLOAD_CODES) || OVERLOAD_PATTERN.test(text)) return "provider_overloaded";
  if (hasCode(normalizedCodes, SERVER_ERROR_CODES) || SERVER_ERROR_PATTERN.test(text) || hasTransientHttpText(text)) {
    return "server_error";
  }
  return undefined;
}

function collectCandidates(root: unknown): ErrorCandidate[] {
  const candidates: ErrorCandidate[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number) => {
    if (value === undefined || value === null || depth > MAX_CAUSE_DEPTH) return;
    if (typeof value !== "object") {
      const message = String(value);
      candidates.push({ value, depth, message, text: message });
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    const name = stringValue(record.name) ?? (value instanceof Error ? value.name : undefined);
    const message = errorMessage(record, value);
    const statusCode = extractStatusCode(record, message);
    const code = extractCode(record);
    const websocketCloseCode = extractWebSocketCloseCode(record, name, message);
    const text = candidateText(record, { name, message, code, statusCode });
    candidates.push({
      value,
      depth,
      name,
      message,
      code,
      statusCode,
      websocketCloseCode,
      text,
      headers: record.headers,
      provider: stringValue(record.provider) ?? stringValue(record.providerId),
      requestId: extractRequestId(record),
    });

    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested, depth + 1);
    }
    for (const key of NESTED_ERROR_KEYS) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        for (const item of nested) visit(item, depth + 1);
      } else if (nested !== value) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(root, 0);
  return candidates;
}

function buildMetadata(error: unknown, candidates: readonly ErrorCandidate[]): NetworkFailureMetadata {
  const statuses = unique(
    candidates.flatMap((candidate) => (candidate.statusCode === undefined ? [] : [candidate.statusCode])),
  );
  const codes = unique(candidates.flatMap((candidate) => (candidate.code === undefined ? [] : [candidate.code])));
  const root = candidates[0];
  const headerMetadata = candidates.map((candidate) => retryHeaders(candidate.headers)).find(Boolean);
  const retryAfter = headerMetadata?.retryAfter ?? firstString(candidates, "retryAfter");
  const retryAfterMs = headerMetadata?.retryAfterMs ?? firstFiniteNumber(candidates, "retryAfterMs");
  const message = root?.message || root?.text || fallbackMessage(error, statuses[0]);

  return {
    name: root?.name,
    message,
    statusCode: statuses[0],
    statusCodes: statuses,
    code: codes[0],
    codes,
    websocketCloseCode: candidates.find((candidate) => candidate.websocketCloseCode !== undefined)?.websocketCloseCode,
    retryAfter,
    retryAfterMs,
    provider: candidates.find((candidate) => candidate.provider)?.provider,
    requestId:
      candidates.find((candidate) => candidate.requestId)?.requestId ??
      candidates.map((candidate) => requestIdFromHeaders(candidate.headers)).find(Boolean),
    causes: candidates.map(({ depth, name, message: causeMessage, code, statusCode }) => ({
      depth,
      name,
      message: causeMessage,
      code,
      statusCode,
    })),
  };
}

function errorMessage(record: Record<string, unknown>, value: object): string | undefined {
  return (
    stringValue(record.message) ??
    stringValue(record.errorMessage) ??
    stringValue(record.statusText) ??
    (value instanceof Error ? value.message : undefined)
  );
}

function candidateText(
  record: Record<string, unknown>,
  fields: { name?: string; message?: string; code?: string; statusCode?: number },
): string {
  const values: unknown[] = [
    fields.name,
    fields.message,
    fields.code,
    fields.statusCode === undefined ? undefined : `HTTP ${fields.statusCode}`,
    record.type,
    typeof record.status === "string" ? record.status : undefined,
    record.statusText,
    typeof record.body === "string" ? record.body : undefined,
    typeof record.details === "string" ? record.details : undefined,
  ];
  return unique(values.flatMap((value) => (typeof value === "string" && value ? [value] : []))).join(": ");
}

function extractStatusCode(record: Record<string, unknown>, message: string | undefined): number | undefined {
  const direct = [record.statusCode, record.status, nestedNumber(record.$metadata, "httpStatusCode")];
  for (const value of direct) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return statusFromText(message);
}

function statusFromText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const patterns = [
    /(?:^|\b)HTTP(?:\s+status)?\s*[:=]?\s*(\d{3})\b/i,
    /\bstatus(?:\s+code)?\s*[:=]?\s*(\d{3})\b/i,
    /\b(?:API )?error\s*\((\d{3})\)/i,
    /\bprovider returned error\D*(\d{3})\b/i,
    /^\s*(\d{3})(?:\s|:|-)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (value >= 100 && value <= 599) return value;
  }
  return undefined;
}

function extractCode(record: Record<string, unknown>): string | undefined {
  for (const value of [record.code, record.errno, record.errorCode, record.error_code, record.type]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractWebSocketCloseCode(
  record: Record<string, unknown>,
  name: string | undefined,
  message: string | undefined,
): number | undefined {
  const direct = record.closeCode ?? record.close_code;
  if (typeof direct === "number" && Number.isInteger(direct) && direct >= 1000 && direct <= 4999) return direct;
  if (/websocket/i.test(`${name ?? ""} ${message ?? ""}`)) {
    if (typeof record.code === "number" && record.code >= 1000 && record.code <= 4999) return record.code;
    const match = /(?:close(?:d)?(?: with)?(?: code)?|code)\D*(\d{4})\b/i.exec(message ?? "");
    if (match) return Number(match[1]);
  }
  return undefined;
}

function extractRequestId(record: Record<string, unknown>): string | undefined {
  return (
    stringValue(record.requestId) ??
    stringValue(record.request_id) ??
    stringValue(record.requestID) ??
    stringValue(record["x-request-id"])
  );
}

function retryHeaders(headers: unknown): { retryAfter?: string; retryAfterMs?: number } | undefined {
  const retryAfterMsRaw = headerValue(headers, "retry-after-ms");
  const retryAfterRaw = headerValue(headers, "retry-after");
  const directMs = finiteNumber(retryAfterMsRaw);
  if (directMs !== undefined) return { retryAfter: retryAfterRaw, retryAfterMs: Math.max(0, directMs) };
  if (retryAfterRaw === undefined) return undefined;
  const seconds = finiteNumber(retryAfterRaw);
  return {
    retryAfter: retryAfterRaw,
    retryAfterMs: seconds === undefined ? undefined : Math.max(0, seconds * 1000),
  };
}

function requestIdFromHeaders(headers: unknown): string | undefined {
  return headerValue(headers, "x-request-id") ?? headerValue(headers, "request-id");
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if ("get" in headers && typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" && value ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) return String(value);
  }
  return undefined;
}

function firstString(candidates: readonly ErrorCandidate[], key: string): string | undefined {
  for (const candidate of candidates) {
    if (!candidate.value || typeof candidate.value !== "object") continue;
    const value = (candidate.value as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function firstFiniteNumber(candidates: readonly ErrorCandidate[], key: string): number | undefined {
  for (const candidate of candidates) {
    if (!candidate.value || typeof candidate.value !== "object") continue;
    const value = (candidate.value as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isCancellation(metadata: NetworkFailureMetadata, codes: readonly string[], text: string): boolean {
  return (
    metadata.name === "AbortError" ||
    codes.includes("ABORT_ERR") ||
    codes.includes("ERR_ABORTED") ||
    /\b(?:operation|request|session) (?:was )?aborted\b|\baborted by (?:outer )?signal\b/i.test(text)
  );
}

function hasTransientHttpText(text: string): boolean {
  for (const pattern of [
    /(?:^|\b)HTTP(?:\s+status)?\s*[:=]?\s*(429|500|502|503|504|522|523|524|525|527|529)\b/gi,
    /\bstatus(?:\s+code)?\s*[:=]?\s*(429|500|502|503|504|522|523|524|525|527|529)\b/gi,
    /^\s*(429|500|502|503|504|522|523|524|525|527|529)(?:\s|:|-)/g,
  ]) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function hasCode(codes: readonly string[], expected: ReadonlySet<string>): boolean {
  return codes.some((code) => expected.has(code));
}

function normalizeCode(code: string): string {
  return code
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function nestedNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "number" ? nested : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fallbackMessage(error: unknown, status: number | undefined): string {
  if (status !== undefined) return `HTTP ${status}`;
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  try {
    const serialized = JSON.stringify(error);
    if (serialized) return serialized;
  } catch {
    // Fall through to the always-safe coercion below.
  }
  return String(error);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
