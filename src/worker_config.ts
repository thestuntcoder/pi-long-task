export interface ParsedWorkerRuntimeConfig {
  modelName?: string;
  maxAttemptsPerTask?: number;
  taskTimeoutMs?: number;
  maxBashTimeoutMs?: number;
  workerSessionReuseEnabled?: boolean;
  workerSessionReuseContextThresholdPercent?: number;
}

type MutableWorkerRuntimeConfig = ParsedWorkerRuntimeConfig & { provider?: string; model?: string };

const MODEL_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._~:+/@-]*/;
const STOP_WORDS = new Set([
  "and",
  "as",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "per",
  "please",
  "task",
  "tasks",
  "the",
  "to",
  "use",
  "with",
  "worker",
  "workers",
]);

export function parseWorkerRuntimeConfig(text: string): ParsedWorkerRuntimeConfig {
  const state: MutableWorkerRuntimeConfig = {};

  parseLineDirectives(text, state);
  parseNaturalLanguageDirectives(text, state);

  const modelName = combineProviderAndModel(state.provider, state.model);
  return {
    ...(modelName ? { modelName } : {}),
    ...(state.maxAttemptsPerTask !== undefined ? { maxAttemptsPerTask: state.maxAttemptsPerTask } : {}),
    ...(state.taskTimeoutMs !== undefined ? { taskTimeoutMs: state.taskTimeoutMs } : {}),
    ...(state.maxBashTimeoutMs !== undefined ? { maxBashTimeoutMs: state.maxBashTimeoutMs } : {}),
    ...(state.workerSessionReuseEnabled !== undefined
      ? { workerSessionReuseEnabled: state.workerSessionReuseEnabled }
      : {}),
    ...(state.workerSessionReuseContextThresholdPercent !== undefined
      ? { workerSessionReuseContextThresholdPercent: state.workerSessionReuseContextThresholdPercent }
      : {}),
  };
}

function parseLineDirectives(text: string, state: MutableWorkerRuntimeConfig): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s{0,3}>+\s?/, "").trim();
    const match = line.match(
      /^(?:[-*+]\s*)?(?:(pi\s+long\s+task|long\s+task|worker|workers?|task)\s+)?([a-z][a-z\s-]{0,40})\s*(?::|=)\s*(.+)$/i,
    );
    if (!match) {
      continue;
    }

    const prefix = normalizeWords(match[1] ?? "");
    const key = normalizeWords(match[2] ?? "");
    const fullKey = normalizeWords(`${prefix} ${key}`);
    const value = match[3] ?? "";

    applyDirective(fullKey, value, state);
  }
}

function parseNaturalLanguageDirectives(text: string, state: MutableWorkerRuntimeConfig): void {
  captureTokens(
    text,
    /\bworker\s+(?:model|provider\/model)\s*(?:is|=|:|to|as)?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi,
    (token) => {
      state.model = token;
    },
  );
  captureTokens(
    text,
    /\b(?:use|using|with|set|run(?:ning)?)\s+(?:the\s+)?(?:worker\s+)?model\s*(?:to|as|is|=|:)?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi,
    (token) => {
      state.model = token;
    },
  );
  captureTokens(text, /\bmodel\s*(?:=|:)\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi, (token) => {
    state.model = token;
  });

  captureTokens(
    text,
    /\bworker\s+provider\s*(?:is|=|:|to|as)?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi,
    (token) => {
      state.provider = token;
    },
  );
  captureTokens(text, /\bprovider\s*(?:=|:)\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi, (token) => {
    state.provider = token;
  });
  captureTokens(
    text,
    /\b(?:use|using|with|set)\s+(?:the\s+)?(?:worker\s+)?provider\s*(?:to|as|is|=|:)?\s*[`'"]?([A-Za-z0-9][A-Za-z0-9._~:+/@-]*)/gi,
    (token) => {
      state.provider = token;
    },
  );

  captureNumbers(
    text,
    /\b(?:max(?:imum)?\s+)?(?:worker\s+|task\s+)?attempts?\s*(?:per\s+task)?\s*(?:is|=|:|to|at)?\s*(\d+)/gi,
    (value) => {
      state.maxAttemptsPerTask = value;
    },
  );
  captureNumbers(text, /\b(\d+)\s+(?:worker\s+|task\s+)?attempts?\b/gi, (value) => {
    state.maxAttemptsPerTask = value;
  });
  captureNumbers(text, /\btry\s+(?:each\s+task\s+)?(?:up\s+to\s+)?(\d+)\s+times\b/gi, (value) => {
    state.maxAttemptsPerTask = value;
  });

  captureDurations(
    text,
    /\b(?<!bash\s)(?<!max\s)(?:worker\s+|task\s+)?timeout\s*(?:is|=|:|to|of)?\s*(\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?)/gi,
    (value) => {
      state.taskTimeoutMs = value;
    },
  );
  captureDurations(
    text,
    /\b(\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h))\s+(?:worker\s+|task\s+)?timeout\b/gi,
    (value) => {
      state.taskTimeoutMs = value;
    },
  );
  captureDurations(
    text,
    /\b(?:max\s+)?bash\s+timeout\s*(?:is|=|:|to|of)?\s*(\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?)/gi,
    (value) => {
      state.maxBashTimeoutMs = value;
    },
  );

  for (const match of text.matchAll(
    /\b(?:worker\s+)?session\s+reuse(?:\s+is|\s*=|\s*:|\s+to)?\s+(enabled|disabled|on|off|true|false)\b/gi,
  )) {
    const enabled = booleanSetting(match[1] ?? "");
    if (enabled !== undefined) state.workerSessionReuseEnabled = enabled;
  }
  for (const match of text.matchAll(
    /\b(?:worker\s+)?(?:session\s+)?reuse\s+context(?:\s+usage)?\s+threshold\s*(?:is|=|:|to|of)?\s*(\d+(?:\.\d+)?)\s*%/gi,
  )) {
    const threshold = percentageFromText(match[1] ?? "");
    if (threshold !== undefined) state.workerSessionReuseContextThresholdPercent = threshold;
  }
}

function applyDirective(key: string, value: string, state: MutableWorkerRuntimeConfig): void {
  if (/\breuse\b/.test(key) && /\b(?:threshold|context)\b/.test(key)) {
    const threshold = percentageFromText(value);
    if (threshold !== undefined) {
      state.workerSessionReuseContextThresholdPercent = threshold;
    }
    return;
  }

  if (/\breuse\b/.test(key)) {
    const enabled = booleanSetting(value);
    if (enabled !== undefined) {
      state.workerSessionReuseEnabled = enabled;
    }
    return;
  }

  if (/\bprovider\b/.test(key)) {
    const token = modelToken(value);
    if (token) {
      state.provider = token;
    }
    return;
  }

  if (/\bmodel\b/.test(key)) {
    const token = modelToken(value);
    if (token) {
      state.model = token;
    }
    return;
  }

  if (/\b(?:attempt|attempts|retry|retries)\b/.test(key)) {
    const attempts = positiveIntegerFromText(value);
    if (attempts !== undefined) {
      state.maxAttemptsPerTask = attempts;
    }
    return;
  }

  if (/\bbash\b/.test(key) && /\btimeout\b/.test(key)) {
    const timeout = durationMsFromText(value, { allowBareSeconds: true });
    if (timeout !== undefined) {
      state.maxBashTimeoutMs = timeout;
    }
    return;
  }

  if (/\btimeout\b/.test(key)) {
    const timeout = durationMsFromText(value, { allowBareSeconds: true });
    if (timeout !== undefined) {
      state.taskTimeoutMs = timeout;
    }
  }
}

function captureTokens(text: string, pattern: RegExp, apply: (token: string) => void): void {
  for (const match of text.matchAll(pattern)) {
    const token = modelToken(match[1] ?? "");
    if (token) {
      apply(token);
    }
  }
}

function captureNumbers(text: string, pattern: RegExp, apply: (value: number) => void): void {
  for (const match of text.matchAll(pattern)) {
    const value = positiveIntegerFromText(match[1] ?? "");
    if (value !== undefined) {
      apply(value);
    }
  }
}

function captureDurations(text: string, pattern: RegExp, apply: (value: number) => void): void {
  for (const match of text.matchAll(pattern)) {
    const value = durationMsFromText(match[1] ?? "", { allowBareSeconds: true });
    if (value !== undefined) {
      apply(value);
    }
  }
}

function combineProviderAndModel(provider: string | undefined, model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  if (model.includes("/") || !provider) {
    return model;
  }
  return `${provider}/${model}`;
}

function modelToken(value: string): string | undefined {
  const trimmed = trimDirectiveValue(value);
  const match = MODEL_TOKEN_RE.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const token = match[0].replace(/[.,;:]+$/g, "");
  return token && !STOP_WORDS.has(token.toLowerCase()) ? token : undefined;
}

function trimDirectiveValue(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+/, "")
    .replace(/['"`]+$/, "")
    .trim();
}

function positiveIntegerFromText(value: string): number | undefined {
  const match = /\d+/.exec(value);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[0], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function percentageFromText(value: string): number | undefined {
  const match = /\d+(?:\.\d+)?/.exec(value);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : undefined;
}

function booleanSetting(value: string): boolean | undefined {
  const normalized = trimDirectiveValue(value).toLowerCase().split(/\s+/)[0];
  if (normalized === "enabled" || normalized === "on" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "disabled" || normalized === "off" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

function durationMsFromText(value: string, options: { allowBareSeconds: boolean }): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?\b/i.exec(
    value,
  );
  if (!match) {
    return undefined;
  }

  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }

  const unit = (match[2] ?? "").toLowerCase();
  if (!unit && !options.allowBareSeconds) {
    return undefined;
  }

  const multiplier = durationMultiplier(unit || "seconds");
  const milliseconds = Math.round(amount * multiplier);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function durationMultiplier(unit: string): number {
  if (unit === "ms" || unit.startsWith("millisecond") || unit.startsWith("msec")) {
    return 1;
  }
  if (unit === "h" || unit.startsWith("hour") || unit.startsWith("hr")) {
    return 60 * 60 * 1000;
  }
  if (unit === "m" || unit.startsWith("minute") || unit.startsWith("min")) {
    return 60 * 1000;
  }
  return 1000;
}

function normalizeWords(value: string): string {
  return value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
