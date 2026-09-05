import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNetworkFailure,
  isRecoverableNetworkFailure,
  type NetworkFailureReason,
} from "../src/network_failure.ts";

function codedError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function assertReason(error: unknown, recoverable: boolean, reason: NetworkFailureReason): void {
  const classification = classifyNetworkFailure(error);
  assert.equal(classification.recoverable, recoverable, classification.metadata.message);
  assert.equal(classification.reason, reason);
  assert.equal(classification.error, error);
}

test("classifies native fetch, DNS, and nested transport errors while retaining their chain", () => {
  const dnsError = codedError("getaddrinfo ENOTFOUND api.example.test", "ENOTFOUND");
  const fetchError = new TypeError("fetch failed", { cause: dnsError });
  const wrapped = new Error("Worker provider request failed", { cause: fetchError });

  const classification = classifyNetworkFailure(wrapped);
  assert.equal(classification.recoverable, true);
  assert.equal(classification.reason, "transport_error");
  assert.equal(classification.error, wrapped);
  assert.equal(classification.metadata.message, "Worker provider request failed");
  assert.equal(classification.metadata.name, "Error");
  assert.deepEqual(classification.metadata.codes, ["ENOTFOUND"]);
  assert.deepEqual(
    classification.metadata.causes.map(({ depth, name, message, code }) => ({ depth, name, message, code })),
    [
      { depth: 0, name: "Error", message: "Worker provider request failed", code: undefined },
      { depth: 1, name: "TypeError", message: "fetch failed", code: undefined },
      { depth: 2, name: "Error", message: "getaddrinfo ENOTFOUND api.example.test", code: "ENOTFOUND" },
    ],
  );
});

test("recognizes representative Node, undici, and textual connectivity failures", () => {
  for (const code of [
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "UND_ERR_SOCKET",
  ]) {
    assertReason(codedError(`transport failed: ${code}`, code), true, "transport_error");
  }

  for (const message of [
    "NetworkError when attempting to fetch resource",
    "Failed to fetch",
    "upstream connect error: connection refused",
    "socket hang up",
    "the other side closed the connection",
  ]) {
    assert.equal(isRecoverableNetworkFailure(message), true, message);
  }
});

test("classifies request timeouts separately from coordinator task timeouts", () => {
  for (const error of [
    codedError("connect ETIMEDOUT", "ETIMEDOUT"),
    codedError("headers timeout", "UND_ERR_HEADERS_TIMEOUT"),
    new DOMException("The request timed out", "TimeoutError"),
    "504 Gateway Timeout",
    { status: 408, message: "Request Timeout" },
  ]) {
    assertReason(error, true, "request_timeout");
  }

  assertReason(new Error("planner session timed out after 30 minutes"), false, "unknown");
  assertReason(new Error("task exceeded 60s timeout"), false, "unknown");
});

test("recognizes socket, WebSocket, and premature stream termination", () => {
  const cases: unknown[] = [
    new Error("socket connection was closed"),
    new Error("WebSocket stream closed before response.completed"),
    new Error("Anthropic stream ended before message_stop"),
    new TypeError("terminated"),
    new Error("stream ended without a terminal response event"),
    new Error("HTTP/2 request did not get a response"),
    { name: "WebSocketCloseError", message: "WebSocket closed with code 1006", code: 1006 },
  ];
  for (const error of cases) assertReason(error, true, "stream_disconnected");

  assertReason(
    { name: "WebSocketCloseError", message: "WebSocket closed with code 1008", closeCode: 1008 },
    false,
    "invalid_request",
  );
  assertReason(
    { name: "WebSocketCloseError", message: "WebSocket closed: message too large", closeCode: 1009 },
    false,
    "invalid_request",
  );
});

test("classifies temporary 429 overloads but rejects quota and billing exhaustion", () => {
  const temporaryCases: unknown[] = [
    { status: 429, message: "Too many requests" },
    { statusCode: 429, error: { type: "rate_limit_error", message: "Rate limit exceeded" } },
    { message: "HTTP 429: ResourceExhausted; retry later" },
    { stopReason: "error", errorMessage: "Provider returned error: 429 too many requests" },
    { status: "RESOURCE_EXHAUSTED", code: "RESOURCE_EXHAUSTED", message: "temporarily throttled" },
  ];
  for (const error of temporaryCases) assertReason(error, true, "rate_limited");

  const terminalCases: Array<[unknown, NetworkFailureReason]> = [
    [{ status: 429, error: { code: "insufficient_quota", message: "Quota exceeded" } }, "quota_exhausted"],
    [{ status: 429, body: '{"type":"FreeUsageLimitError"}' }, "quota_exhausted"],
    [{ status: 429, message: "Monthly usage limit reached; enable available balance" }, "quota_exhausted"],
    [{ status: 429, message: "Billing hard limit reached" }, "billing"],
    [{ status: 429, message: "Insufficient credits" }, "billing"],
  ];
  for (const [error, reason] of terminalCases) assertReason(error, false, reason);
});

test("classifies retryable provider overload and HTTP server responses", () => {
  const cases: Array<[unknown, NetworkFailureReason]> = [
    [{ status: 500, message: "Internal Server Error" }, "server_error"],
    [{ statusCode: 502, message: "Bad Gateway" }, "server_error"],
    [{ $metadata: { httpStatusCode: 503 }, message: "Service unavailable" }, "server_error"],
    [{ $response: { statusCode: 504, body: "Gateway timeout" }, message: "request failed" }, "request_timeout"],
    [new Error("The provider is overloaded, please try again"), "provider_overloaded"],
    [{ code: "server_overloaded", message: "capacity exceeded" }, "provider_overloaded"],
    [new Error("Provider returned error: 503"), "server_error"],
    [{ status: 529, message: "Overloaded" }, "server_error"],
  ];
  for (const [error, reason] of cases) assertReason(error, true, reason);
});

test("deterministic status, code, and message evidence overrides transient wrapper text", () => {
  const cases: Array<[unknown, NetworkFailureReason]> = [
    [{ status: 400, message: "request timeout is invalid" }, "invalid_request"],
    [{ status: 401, message: "Service temporarily unavailable" }, "authentication"],
    [{ status: 402, message: "Payment Required" }, "billing"],
    [{ status: 403, message: "Provider overloaded" }, "authorization"],
    [{ status: 404, message: "Model not found" }, "invalid_model"],
    [{ status: 409, message: "Conflict" }, "http_client_error"],
    [{ status: 422, message: "Validation failed" }, "http_client_error"],
    [{ status: 501, message: "Not Implemented" }, "non_retryable_server_error"],
    [{ code: "invalid_api_key", message: "network error" }, "authentication"],
    [{ code: "permission_denied", message: "connection reset" }, "authorization"],
    [{ code: "model_not_found", message: "server error" }, "invalid_model"],
    [{ code: "invalid_request_error", message: "please retry your request" }, "invalid_request"],
  ];
  for (const [error, reason] of cases) assertReason(error, false, reason);

  const wrapped = new Error("Provider returned 503 after retries", {
    cause: { status: 401, error: { code: "invalid_token", message: "token expired" } },
  });
  assertReason(wrapped, false, "authentication");
});

test("covers the complete fail-fast taxonomy independently of transient wrapper messages", () => {
  const cases: Array<[label: string, error: unknown, reason: NetworkFailureReason]> = [
    ["authentication", { status: 401, code: "INVALID_API_KEY", message: "connection reset" }, "authentication"],
    ["authorization", { status: 403, code: "PERMISSION_DENIED", message: "service unavailable" }, "authorization"],
    ["billing", { status: 402, code: "PAYMENT_REQUIRED", message: "temporarily unavailable" }, "billing"],
    ["quota exhaustion", { status: 429, code: "INSUFFICIENT_QUOTA", message: "too many requests" }, "quota_exhausted"],
    ["invalid model", { status: 404, code: "MODEL_NOT_FOUND", message: "provider overloaded" }, "invalid_model"],
    ["invalid request", { status: 400, code: "INVALID_ARGUMENT", message: "fetch failed" }, "invalid_request"],
    ["other client error", { status: 422, message: "connection reset" }, "http_client_error"],
    ["non-retryable server error", { status: 501, message: "service unavailable" }, "non_retryable_server_error"],
    ["deterministic TLS error", codedError("socket reset: certificate has expired", "CERT_HAS_EXPIRED"), "unknown"],
  ];

  for (const [label, error, reason] of cases) {
    const classification = classifyNetworkFailure(error);
    assert.equal(classification.recoverable, false, label);
    assert.equal(classification.reason, reason, label);
    assert.equal(classification.error, error, label);
  }
});

test("abort and unknown programming failures are never treated as outages", () => {
  assertReason(new DOMException("This operation was aborted", "AbortError"), false, "cancelled");
  assertReason(codedError("request aborted", "ABORT_ERR"), false, "cancelled");
  assertReason(
    new TypeError("fetch failed", { cause: codedError("certificate has expired", "CERT_HAS_EXPIRED") }),
    false,
    "unknown",
  );
  assertReason(new TypeError("Cannot read properties of undefined"), false, "unknown");
  assertReason(new Error("worker crashed"), false, "unknown");
});

test("preserves HTTP retry, provider, request, and nested response metadata", () => {
  const responseError = {
    name: "PiMessagesResponseError",
    message: "503 Service Unavailable: overloaded",
    code: "server_overloaded",
    provider: "radius",
    diagnosticDetails: {
      status: 503,
      headers: {
        "retry-after": "2.5",
        "x-request-id": "req-nested-123",
      },
    },
  };

  const classification = classifyNetworkFailure(new Error("Reviewer session failed", { cause: responseError }));
  assert.equal(classification.recoverable, true);
  assert.equal(classification.reason, "server_error");
  assert.equal(classification.metadata.statusCode, 503);
  assert.deepEqual(classification.metadata.statusCodes, [503]);
  assert.equal(classification.metadata.code, "server_overloaded");
  assert.equal(classification.metadata.provider, "radius");
  assert.equal(classification.metadata.requestId, "req-nested-123");
  assert.equal(classification.metadata.retryAfter, "2.5");
  assert.equal(classification.metadata.retryAfterMs, 2500);
  assert.ok(classification.metadata.causes.some((cause) => cause.statusCode === 503));
});

test("handles AggregateError and cyclic wrappers without losing nested causes", () => {
  const aggregate = new AggregateError(
    [codedError("connect refused", "ECONNREFUSED"), codedError("host unreachable", "EHOSTUNREACH")],
    "All provider connections failed",
  );
  const wrapper: { message: string; cause?: unknown } = { message: "provider failed", cause: aggregate };
  wrapper.cause = Object.assign(aggregate, { cause: wrapper });

  const classification = classifyNetworkFailure(wrapper);
  assert.equal(classification.recoverable, true);
  assert.equal(classification.reason, "transport_error");
  assert.deepEqual(classification.metadata.codes, ["ECONNREFUSED", "EHOSTUNREACH"]);
  assert.equal(classification.metadata.causes.length, 4);
});
