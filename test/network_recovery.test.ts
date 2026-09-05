import assert from "node:assert/strict";
import test from "node:test";

import { classifyNetworkFailure } from "../src/network_failure.ts";
import {
  NetworkOutageExpiredError,
  NetworkRecoveryAbortedError,
  equalNetworkRetryJitter,
  networkRetryDelayMs,
  recoverNetworkOperation,
  type NetworkRecoveryEvent,
  type NetworkRecoverySleep,
} from "../src/network_recovery.ts";
import { NETWORK_RECOVERY_TIMEOUT_POLICY, type NetworkRecoveryConfig } from "../src/network_recovery_config.ts";

const identityJitter = (delayMs: number): number => delayMs;

function config(overrides: Partial<NetworkRecoveryConfig> = {}): NetworkRecoveryConfig {
  return {
    enabled: true,
    baseDelayMs: 100,
    maxDelayMs: 250,
    maxOutageMs: 10_000,
    timeoutPolicy: NETWORK_RECOVERY_TIMEOUT_POLICY,
    ...overrides,
  };
}

function transient(message = "fetch failed"): Error {
  return new TypeError(message);
}

test("calculates exact capped exponential delays without overflow", () => {
  const recoveryConfig = config();
  const delays = [1, 2, 3, 4, 5, 10_000].map((retryCount) =>
    networkRetryDelayMs(retryCount, recoveryConfig, { jitter: identityJitter }),
  );
  assert.deepEqual(delays, [100, 200, 250, 250, 250, 250]);
  assert.throws(() => networkRetryDelayMs(0, recoveryConfig), /positive safe integer/);
});

test("equal jitter is deterministic, bounded, and custom jitter cannot exceed the cap", () => {
  const recoveryConfig = config({ baseDelayMs: 100, maxDelayMs: 100 });
  assert.equal(networkRetryDelayMs(1, recoveryConfig, { random: () => 0 }), 50);
  assert.equal(networkRetryDelayMs(1, recoveryConfig, { random: () => 0.5 }), 75);
  assert.equal(networkRetryDelayMs(1, recoveryConfig, { random: () => 1 }), 100);
  assert.equal(networkRetryDelayMs(1, recoveryConfig, { jitter: (delayMs) => delayMs + 5_000 }), 100);
  assert.equal(networkRetryDelayMs(1, recoveryConfig, { jitter: () => -20 }), 0);
  assert.throws(() => equalNetworkRetryJitter(100, () => Number.NaN, 1), /finite number between 0 and 1/);
});

test("tracks outage timing, network retries, and lifecycle independently of ordinary attempts", async () => {
  let currentTimeMs = 1_000;
  const sleeps: number[] = [];
  const events: NetworkRecoveryEvent[] = [];
  const retryContexts: Array<{ retryCount: number; elapsedMs: number; networkWaitMs: number }> = [];
  let operationCalls = 0;
  const sleep: NetworkRecoverySleep = async (delayMs) => {
    sleeps.push(delayMs);
    currentTimeMs += delayMs;
  };

  const outcome = await recoverNetworkOperation({
    initialFailure: transient(),
    config: config({ maxOutageMs: null }),
    now: () => currentTimeMs,
    sleep,
    jitter: identityJitter,
    onEvent: (event) => events.push(event),
    retry: async (context) => {
      retryContexts.push({
        retryCount: context.retryCount,
        elapsedMs: context.elapsedMs,
        networkWaitMs: context.networkWaitMs,
      });
      operationCalls += 1;
      if (operationCalls < 4) throw transient("socket disconnected");
      return "online";
    },
  });

  assert.equal(outcome.value, "online");
  assert.deepEqual(sleeps, [100, 200, 250, 250]);
  assert.deepEqual(retryContexts, [
    { retryCount: 1, elapsedMs: 100, networkWaitMs: 100 },
    { retryCount: 2, elapsedMs: 300, networkWaitMs: 300 },
    { retryCount: 3, elapsedMs: 550, networkWaitMs: 550 },
    { retryCount: 4, elapsedMs: 800, networkWaitMs: 800 },
  ]);
  assert.equal(outcome.outage.retryCount, 4);
  assert.equal(outcome.outage.outageStartedAtMs, 1_000);
  assert.equal(outcome.outage.elapsedMs, 800);
  assert.equal(outcome.outage.networkWaitMs, 800);
  assert.equal(outcome.outage.nextRetryAtMs, undefined);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "outage_started",
      "retry_scheduled",
      "retry_started",
      "retry_failed",
      "retry_scheduled",
      "retry_started",
      "retry_failed",
      "retry_scheduled",
      "retry_started",
      "retry_failed",
      "retry_scheduled",
      "retry_started",
      "recovered",
      "cleanup",
    ],
  );
  assert.equal(events[1]?.state.nextRetryAtMs, 1_100);
  assert.equal(events.at(-1)?.state.retryCount, 4);
});

test("bounded outages expire at the deadline without starting a late retry", async () => {
  let currentTimeMs = 0;
  const sleeps: number[] = [];
  const events: NetworkRecoveryEvent[] = [];
  let retries = 0;

  await assert.rejects(
    recoverNetworkOperation({
      initialFailure: transient(),
      config: config({ maxOutageMs: 250 }),
      now: () => currentTimeMs,
      jitter: identityJitter,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        currentTimeMs += delayMs;
      },
      onEvent: (event) => events.push(event),
      retry: async () => {
        retries += 1;
        throw transient();
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NetworkOutageExpiredError);
      assert.equal(error.outage.elapsedMs, 250);
      assert.equal(error.outage.networkWaitMs, 250);
      assert.equal(error.lastFailure instanceof TypeError, true);
      return true;
    },
  );

  assert.deepEqual(sleeps, [100, 150]);
  assert.equal(retries, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "outage_started",
      "retry_scheduled",
      "retry_started",
      "retry_failed",
      "expiry_scheduled",
      "outage_expired",
      "cleanup",
    ],
  );
});

test("bounded outage deadlines abort retry execution", async () => {
  let currentTimeMs = 0;
  let retrySignal: AbortSignal | undefined;
  const eventTypes: string[] = [];

  await assert.rejects(
    recoverNetworkOperation({
      initialFailure: transient(),
      config: config({ maxOutageMs: 250 }),
      now: () => currentTimeMs,
      jitter: identityJitter,
      sleep: async (delayMs) => {
        currentTimeMs += delayMs;
      },
      deadlineSleep: async (delayMs) => {
        currentTimeMs += delayMs;
      },
      retry: async (context) => {
        retrySignal = context.signal;
        return await new Promise<string>(() => {});
      },
      onEvent: (event) => eventTypes.push(event.type),
    }),
    (error: unknown) => {
      assert.ok(error instanceof NetworkOutageExpiredError);
      assert.equal(error.outage.elapsedMs, 250);
      return true;
    },
  );

  assert.equal(retrySignal?.aborted, true);
  assert.equal(retrySignal?.reason instanceof NetworkOutageExpiredError, true);
  assert.deepEqual(eventTypes, ["outage_started", "retry_scheduled", "retry_started", "outage_expired", "cleanup"]);
});

test("a cancelled non-cooperative deadline cannot emit stale events after recovery cleanup", async () => {
  let releaseDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });
  const eventTypes: string[] = [];

  const result = await recoverNetworkOperation({
    initialFailure: transient(),
    config: config({ baseDelayMs: 1, maxDelayMs: 1, maxOutageMs: 1_000 }),
    jitter: identityJitter,
    sleep: async () => {},
    deadlineSleep: async () => deadline,
    retry: async () => "online",
    onEvent: (event) => eventTypes.push(event.type),
  });

  assert.equal(result.value, "online");
  assert.deepEqual(eventTypes, ["outage_started", "retry_scheduled", "retry_started", "recovered", "cleanup"]);
  releaseDeadline();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    eventTypes,
    ["outage_started", "retry_scheduled", "retry_started", "recovered", "cleanup"],
    "an ignored deadline abort must not publish expiry after cleanup",
  );
});

test("unlimited mode continues beyond bounded durations until recovery", async () => {
  let currentTimeMs = 0;
  let retries = 0;
  const outcome = await recoverNetworkOperation({
    initialFailure: transient(),
    config: config({ maxOutageMs: null, baseDelayMs: 1_000, maxDelayMs: 1_000 }),
    now: () => currentTimeMs,
    jitter: identityJitter,
    sleep: async (delayMs) => {
      currentTimeMs += delayMs;
    },
    retry: async () => {
      retries += 1;
      if (retries < 20) throw transient();
      return retries;
    },
  });

  assert.equal(outcome.value, 20);
  assert.equal(outcome.outage.elapsedMs, 20_000);
  assert.equal(outcome.outage.outageExpiresAtMs, undefined);
});

test("fails fast for disabled recovery and deterministic retry failures", async () => {
  const initial = transient();
  let calls = 0;
  await assert.rejects(
    recoverNetworkOperation({
      initialFailure: initial,
      config: config({ enabled: false }),
      retry: async () => {
        calls += 1;
      },
    }),
    (error) => error === initial,
  );
  assert.equal(calls, 0);

  const authError = Object.assign(new Error("invalid API key"), { status: 401 });
  const eventTypes: string[] = [];
  await assert.rejects(
    recoverNetworkOperation({
      initialFailure: initial,
      config: config(),
      jitter: () => 0,
      sleep: async () => {},
      retry: async () => {
        throw authError;
      },
      onEvent: (event) => eventTypes.push(event.type),
    }),
    (error) => error === authError,
  );
  assert.deepEqual(eventTypes, ["outage_started", "retry_scheduled", "retry_started", "failed", "cleanup"]);
  assert.equal(classifyNetworkFailure(authError).recoverable, false);
});

test("cancellation is prompt even when injected sleep ignores the signal", async () => {
  const controller = new AbortController();
  let sleepStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    sleepStarted = resolve;
  });
  const eventTypes: string[] = [];
  let retries = 0;
  const recovery = recoverNetworkOperation({
    initialFailure: transient(),
    config: config({ maxOutageMs: null }),
    signal: controller.signal,
    jitter: identityJitter,
    sleep: async () => {
      sleepStarted();
      return await new Promise<void>(() => {});
    },
    retry: async () => {
      retries += 1;
    },
    onEvent: (event) => eventTypes.push(event.type),
  });

  await started;
  controller.abort("stop waiting");
  await assert.rejects(recovery, (error: unknown) => {
    assert.ok(error instanceof NetworkRecoveryAbortedError);
    assert.equal(error.name, "AbortError");
    assert.equal(error.reason, "stop waiting");
    return true;
  });
  assert.equal(retries, 0);
  assert.deepEqual(eventTypes, ["outage_started", "retry_scheduled", "cancelled", "cleanup"]);
});

test("cancellation aborts retry execution and does not wait for a non-cooperative retry", async () => {
  const controller = new AbortController();
  let retryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  let callbackSignal: AbortSignal | undefined;
  const eventTypes: string[] = [];
  const recovery = recoverNetworkOperation({
    initialFailure: transient(),
    config: config({ maxOutageMs: null }),
    signal: controller.signal,
    jitter: () => 0,
    sleep: async () => {},
    retry: async (context) => {
      callbackSignal = context.signal;
      retryStarted();
      return await new Promise<string>(() => {});
    },
    onEvent: (event) => eventTypes.push(event.type),
  });

  await started;
  controller.abort(new Error("cancel active probe"));
  await assert.rejects(recovery, (error: unknown) => {
    assert.ok(error instanceof NetworkRecoveryAbortedError);
    assert.match(error.message, /cancel active probe/);
    return true;
  });
  assert.equal(callbackSignal, controller.signal);
  assert.equal(callbackSignal?.aborted, true);
  assert.deepEqual(eventTypes, ["outage_started", "retry_scheduled", "retry_started", "cancelled", "cleanup"]);
});

test("pre-cancellation prevents outage hooks and retries", async () => {
  const controller = new AbortController();
  controller.abort("already stopped");
  let eventCount = 0;
  await assert.rejects(
    recoverNetworkOperation({
      initialFailure: transient(),
      config: config(),
      signal: controller.signal,
      retry: async () => "unexpected",
      onEvent: () => {
        eventCount += 1;
      },
    }),
    NetworkRecoveryAbortedError,
  );
  assert.equal(eventCount, 0);
});
