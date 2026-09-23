import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

/** Thinking levels accepted by the supported Pi SDK, in increasing reasoning-budget order. */
export const SUPPORTED_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof SUPPORTED_THINKING_LEVELS)[number];

/** Preserve the historical planner and worker default unless the policy is confident work is straightforward. */
export const DEFAULT_THINKING_FALLBACK_LEVEL: ThinkingLevel = "high";
export const DEFAULT_STRAIGHTFORWARD_THINKING_LEVEL: ThinkingLevel = "low";

export type ThinkingTaskKind = "planner" | "worker";
export type ThinkingClassification = "straightforward" | "complex" | "risky" | "ambiguous" | "not_evaluated";
export type ThinkingSelectionSource = "explicit" | "adaptive" | "fallback";

export type ThinkingPolicySignalKind =
  | "destructive_operation"
  | "security_or_privacy"
  | "production_or_release"
  | "payments_or_financial"
  | "data_migration"
  | "concurrency"
  | "architecture_or_cross_component"
  | "large_scope"
  | "uncertainty"
  | "explicitly_straightforward"
  | "documentation_only"
  | "localized_change";

export interface AdaptiveThinkingPolicyOptions {
  taskKind: ThinkingTaskKind;
  /** Planner request text or other primary task instructions. */
  inputText?: string;
  /** Optional worker metadata. These fields are classified together with inputText. */
  taskTitle?: string;
  taskSection?: string;
  /** A caller or parsed configuration value. Presence always bypasses classification. */
  explicitThinkingLevel?: string;
  /** Levels supported by the active model/provider. Unknown values are ignored. */
  supportedThinkingLevels?: readonly string[];
  /** Defaults to the historical `high` behavior. */
  fallbackThinkingLevel?: ThinkingLevel;
  /** Defaults to `low`; selection is clamped to the supplied supported levels. */
  straightforwardThinkingLevel?: ThinkingLevel;
}

export interface AdaptiveThinkingSelection {
  thinkingLevel: string;
  source: ThinkingSelectionSource;
  classification: ThinkingClassification;
  signals: readonly ThinkingPolicySignalKind[];
}

/**
 * Reads Pi's model capability metadata when a concrete model is already
 * available. Undefined means resolution is deferred to Pi's session factory,
 * which performs the same provider-aware clamping after model discovery.
 */
export function supportedThinkingLevelsForModel(model: unknown): readonly string[] | undefined {
  if (!isModelCapabilityRecord(model)) {
    return undefined;
  }
  return getSupportedThinkingLevels(model as Model<Api>);
}

interface SignalRule {
  kind: ThinkingPolicySignalKind;
  expression: RegExp;
}

const RISK_RULES: readonly SignalRule[] = [
  {
    kind: "destructive_operation",
    expression:
      /\b(?:delete|destroy|drop|truncate|purge|erase|wipe)\b[^.\n]{0,48}\b(?:data|database|table|records?|storage|volume|files?)\b|\b(?:force[ -]?push|reset\s+--hard)\b/i,
  },
  {
    kind: "security_or_privacy",
    expression:
      /\b(?:auth(?:entication|orization)?|permissions?|access control|credentials?|secrets?|encrypt(?:ion|ed)?|security|vulnerabilit(?:y|ies)|personally identifiable|pii|personal data|privacy)\b/i,
  },
  {
    kind: "production_or_release",
    expression:
      /\b(?:production|prod environment|deploy(?:ment|ing)?|release|rollout|rollback|incident|outage|zero[ -]?downtime)\b/i,
  },
  {
    kind: "payments_or_financial",
    expression: /\b(?:payments?|billing|invoices?|financial|money|refunds?|charges?|ledger|tax)\b/i,
  },
  {
    kind: "data_migration",
    expression: /\b(?:data|database|schema)\s+migrat(?:e|ion|ing)\b|\b(?:backfill|schema change)\b/i,
  },
  {
    kind: "concurrency",
    expression: /\b(?:concurren(?:cy|t)|race condition|deadlock|thread safety|distributed lock|idempotency)\b/i,
  },
];

const COMPLEXITY_RULES: readonly SignalRule[] = [
  {
    kind: "architecture_or_cross_component",
    expression:
      /\b(?:architect(?:ure|ural)?|system design|cross[ -](?:component|service|package|module)|multiple (?:components|services|packages|modules|repositories)|distributed system|backwards? compatib(?:le|ility)|public api)\b/i,
  },
  {
    kind: "large_scope",
    expression:
      /\b(?:large[ -]?scale|repository[ -]?wide|codebase[ -]?wide|end[ -]?to[ -]?end|across the (?:repository|codebase|system)|all (?:components|services|packages|modules|callers|implementations)|entire (?:repository|codebase|system|application))\b/i,
  },
];

const AMBIGUITY_RULES: readonly SignalRule[] = [
  {
    kind: "uncertainty",
    expression:
      /\b(?:investigate|diagnose|research|unknown|unclear|ambiguous|as needed|best approach|root cause|determine (?:how|why|whether)|figure out|not (?:simple|straightforward))\b/i,
  },
];

const STRAIGHTFORWARD_RULES: readonly SignalRule[] = [
  {
    kind: "explicitly_straightforward",
    expression: /\b(?:simple|straightforward|trivial|small|low[ -]?risk|mechanical|single[ -]file)\b/i,
  },
  {
    kind: "documentation_only",
    expression:
      /\b(?:fix|correct|update|add|edit|rename|remove)\b[^.\n]{0,48}\b(?:typos?|spelling|wording|comment|comments|readme|documentation|docs?)\b/i,
  },
  {
    kind: "localized_change",
    expression:
      /\b(?:rename (?:a |one |the )?(?:variable|symbol|function|method)|add (?:a |one )?(?:focused |unit )?test|update (?:a |one |the )?(?:constant|label|message)|format (?:a |one |the )?(?:file|document))\b/i,
  },
];

const EXPLICIT_ITEM_COUNT_RE =
  /\b(\d{1,6})\s+(?:separate(?:ly)?\s+)?(?:tasks?|todos?|deliverables?|items?|features?|components?|services?|modules?|files?|endpoints?|requirements?)\b/gi;
const ENUMERATED_ITEM_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,6}[.)]\s+)\S.*$/gm;
const LARGE_ITEM_COUNT = 5;

/**
 * Classifies only deterministic, conservative textual signals. Risk and
 * complexity always win over straightforward wording; unknown or conflicting
 * input remains ambiguous so callers retain the historical high budget.
 */
export function classifyThinkingTask(
  options: Pick<AdaptiveThinkingPolicyOptions, "taskKind" | "inputText" | "taskTitle" | "taskSection">,
): { classification: Exclude<ThinkingClassification, "not_evaluated">; signals: ThinkingPolicySignalKind[] } {
  const text = [options.taskTitle, options.inputText, options.taskSection]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  if (!text) {
    return { classification: "ambiguous", signals: [] };
  }

  const riskSignals = matchingSignals(text, RISK_RULES);
  const complexitySignals = matchingSignals(text, COMPLEXITY_RULES);
  if (hasLargeScopeCount(text, options.taskKind === "planner") && !complexitySignals.includes("large_scope")) {
    complexitySignals.push("large_scope");
  }
  const ambiguitySignals = matchingSignals(text, AMBIGUITY_RULES);
  const straightforwardSignals = matchingSignals(text, STRAIGHTFORWARD_RULES);
  const signals = [...riskSignals, ...complexitySignals, ...ambiguitySignals, ...straightforwardSignals];

  if (riskSignals.length > 0) {
    return { classification: "risky", signals };
  }
  if (complexitySignals.length > 0) {
    return { classification: "complex", signals };
  }
  if (ambiguitySignals.length > 0 || straightforwardSignals.length === 0) {
    return { classification: "ambiguous", signals };
  }
  return { classification: "straightforward", signals };
}

/**
 * Resolves an adaptive thinking level while preserving explicit caller and
 * configuration values exactly. Adaptive and fallback values are always
 * selected from the recognized levels supported by the active model/provider.
 */
export function resolveAdaptiveThinkingLevel(options: AdaptiveThinkingPolicyOptions): AdaptiveThinkingSelection {
  if (options.explicitThinkingLevel !== undefined) {
    return {
      thinkingLevel: options.explicitThinkingLevel,
      source: "explicit",
      classification: "not_evaluated",
      signals: [],
    };
  }

  const classified = classifyThinkingTask(options);
  const fallback = options.fallbackThinkingLevel ?? DEFAULT_THINKING_FALLBACK_LEVEL;
  if (classified.classification !== "straightforward") {
    return {
      thinkingLevel: nearestSupportedThinkingLevel(fallback, options.supportedThinkingLevels, fallback),
      source: "fallback",
      ...classified,
    };
  }

  const straightforward = options.straightforwardThinkingLevel ?? DEFAULT_STRAIGHTFORWARD_THINKING_LEVEL;
  return {
    thinkingLevel: nearestSupportedThinkingLevel(straightforward, options.supportedThinkingLevels, fallback),
    source: "adaptive",
    ...classified,
  };
}

function isModelCapabilityRecord(value: unknown): value is { reasoning: boolean } {
  return (
    typeof value === "object" && value !== null && typeof (value as { reasoning?: unknown }).reasoning === "boolean"
  );
}

function matchingSignals(text: string, rules: readonly SignalRule[]): ThinkingPolicySignalKind[] {
  return rules.filter((rule) => rule.expression.test(text)).map((rule) => rule.kind);
}

function hasLargeScopeCount(text: string, includeEnumeration: boolean): boolean {
  EXPLICIT_ITEM_COUNT_RE.lastIndex = 0;
  for (const match of text.matchAll(EXPLICIT_ITEM_COUNT_RE)) {
    if (Number.parseInt(match[1], 10) >= LARGE_ITEM_COUNT) {
      return true;
    }
  }
  if (!includeEnumeration) {
    // Worker TODO sections routinely contain Status and Verify checklists. They
    // are metadata, not independent deliverables, unless the text says so.
    return false;
  }
  ENUMERATED_ITEM_RE.lastIndex = 0;
  return [...text.matchAll(ENUMERATED_ITEM_RE)].length >= LARGE_ITEM_COUNT;
}

function nearestSupportedThinkingLevel(
  desired: ThinkingLevel,
  supplied: readonly string[] | undefined,
  safeFallback: ThinkingLevel,
): string {
  const suppliedSet = supplied ? new Set(supplied) : undefined;
  const supported = suppliedSet
    ? SUPPORTED_THINKING_LEVELS.filter((level) => suppliedSet.has(level))
    : [...SUPPORTED_THINKING_LEVELS];

  if (supported.length === 0 && suppliedSet?.has("off")) {
    return "off";
  }
  // Invalid or empty capability metadata is ambiguous. Preserve the historical
  // safe fallback instead of lowering reasoning based on unsupported data.
  if (supported.length === 0) {
    return safeFallback;
  }

  const desiredIndex = SUPPORTED_THINKING_LEVELS.indexOf(desired);
  return supported.find((level) => SUPPORTED_THINKING_LEVELS.indexOf(level) >= desiredIndex) ?? supported.at(-1)!;
}
