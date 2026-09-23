# Adaptive planner and worker thinking levels

Pi Long Task selects planner and worker thinking levels adaptively when the caller does not provide an explicit override. The policy is centralized in `src/thinking_policy.ts`; coordinator and direct SDK entry points use the same selection rules.

The historical `high` planner and worker constants remain conservative compatibility fallbacks. They are not a promise that every request without an override will run at `high`.

## Policy goals

The policy balances latency with safety:

- confidently straightforward, localized work may begin at a lower supported reasoning level;
- complex, risky, uncertain, conflicting, or unclassified work retains the `high` fallback;
- explicit caller configuration is authoritative;
- adaptive retries can spend more reasoning without exceeding model/provider capabilities; and
- missing or unusable classification information, and unusable concrete capability metadata, fail conservatively instead of lowering reasoning.

Classification is deterministic and based on conservative task text and metadata signals. Examples of straightforward work include a focused documentation correction or another clearly small localized change. Architecture-spanning work, destructive or security-sensitive operations, production changes, payments, migrations, concurrency, broad scope, and uncertainty retain more reasoning. These are examples for maintainers, not a stable public keyword list: rules may evolve without making any individual phrase a supported API.

## Selection and capability bounds

The recognized reasoning order is:

```text
minimal → low → medium → high → xhigh → max
```

For a first attempt, confident straightforward work targets `low`; all other classifications target the conservative `high` fallback. Selection then moves upward as needed to a level supported by the active model/provider. It never selects an adaptive level above that provider's highest supported level.

Special fallback behavior is intentional:

- a model that reports no reasoning support stays at `off`;
- an explicitly supplied invalid or empty capability list keeps `high`, because a safe supported maximum cannot be inferred;
- when no concrete model is available yet, capability clamping is deferred to Pi's session factory after model discovery;
- missing or ambiguous task text keeps `high`; and
- an explicit value is returned exactly, even when it is provider-specific or absent from recognized capability metadata. The downstream provider remains responsible for handling its own explicit values.

## Override precedence

Override presence bypasses classification and retry escalation. The supported entry points are:

| Entry point        | Planner override | Worker override |
| ------------------ | ---------------- | --------------- |
| `runCoordinator()` | `todoThinking`   | `taskThinking`  |
| `runTodoPlanner()` | `thinkingLevel`  | Not applicable  |
| `runWorkerTask()`  | Not applicable   | `thinkingLevel` |

`todoThinking` and `taskThinking` are independent. Setting one does not affect the other. Goal discovery and reviewer thinking settings are also separate from this policy.

The public `pi_long_task` tool schema does not currently expose thinking-level fields. These override names are for programmatic coordinator/SDK callers; tool users receive adaptive selection automatically.

## Retry escalation

Attempt 1 uses the ordinary adaptive result. Each subsequent adaptive retry advances one position through the levels actually supported by the active model/provider and clamps at its maximum. For example, a model exposing only `low` and `high` uses `low`, then `high`, then remains at `high`. A conservative `high` first attempt advances to `xhigh` and then `max` only when those levels are supported.

Escalation applies at the retry boundaries owned by Pi Long Task:

- ordinary worker task attempts;
- coordinator-level worker network recovery retries;
- planner output repair attempts; and
- coordinator-level planner network recovery retries, including steering planners.

Explicit overrides remain unchanged at every boundary. Network recovery continues to use its independent retry counter and does not consume ordinary worker attempts or alter timeout accounting. Planner repairs retain their existing one-repair limit. Healthy partial worker continuation can remain in the same compatible session; when supported by the session, its adaptive thinking level is updated in place.

Pi's own provider-request retry machinery remains separate. Pi Long Task escalates only where it owns a fresh attempt or can update the active planner session between prompts.

## Integration guidance

Call the shared policy with all available context and preserve whether a value was explicit:

```ts
const selection = resolveAdaptiveThinkingLevel({
  taskKind: "worker",
  inputText: globalInstructions,
  taskTitle: task.title,
  taskSection: task.section,
  explicitThinkingLevel: taskThinking,
  supportedThinkingLevels: supportedThinkingLevelsForModel(model),
  attempt,
});
```

Do not pass a previously adaptive result back as an explicit user override unless the caller also carries adaptive-source metadata. Otherwise later retry boundaries cannot distinguish a selected value from an authoritative override. Do not infer provider support from the level names alone when concrete model metadata is available.

Thinking selection and planner timeout scaling are independent. A lower thinking level never shortens the planner deadline, and an adaptive timeout extension does not force a higher thinking level.

## Regression coverage

The relevant suites are:

- `test/thinking_policy.test.ts` for classification, fallback, override, and capability behavior;
- `test/planner_thinking_level.test.ts` for planner and worker integration;
- `test/thinking_retry.test.ts` for ordinary, repair, and network retry escalation; and
- `test/thinking_compatibility.test.ts` for historical defaults, configuration precedence, non-reasoning models, and sparse provider capabilities.

Run `npm run check` after policy or integration changes. A native credentialed smoke remains available through `npm run smoke:native` when release validation requires provider execution.
