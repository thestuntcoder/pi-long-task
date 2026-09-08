# Planner thinking-level default

Pi Long Task uses `high` as the TODO planner's default thinking level. This is a planner-only default: worker sessions continue to use their existing `high` default, and goal discovery/review thinking settings are unchanged.

## Evaluation

The selection considered every thinking level supported by the current Pi SDK (`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`) against two representative request shapes:

- **Simple:** a small implementation request needing a few ordered tasks and focused verification.
- **Complex:** 24 separately assignable stories needing dependencies, constraints, and verification retained across task boundaries.

| Level     | Simple-plan assessment                | Complex-plan assessment                         | Default decision                      |
| --------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| `minimal` | Lowest latency, least planning margin | Too little margin for dependency-heavy plans    | Not selected                          |
| `low`     | Adequate only for routine breakdowns  | Too little margin for broad constraint handling | Not selected                          |
| `medium`  | Good speed and adequate basic plans   | Less margin for a large structured plan         | Not selected                          |
| `high`    | Moderate latency, strong plan quality | Strong quality without an extreme budget        | **Selected quality/speed balance**    |
| `xhigh`   | More reasoning than simple plans need | High quality, but increased timeout risk        | Available only when explicitly chosen |
| `max`     | Highest supported reasoning budget    | Highest latency and model-dependent benefit     | Available only when explicitly chosen |

Provider and model latency vary, so this choice does not depend on a hard-coded benchmark or model judgment. Deterministic planner timeout scaling handles request size separately; thinking level is not adapted from semantic complexity.

## Override paths and compatibility

- `runCoordinator({ todoThinking })` controls initial TODO creation, its repair attempt, and steering plan revisions. If omitted, it resolves to `high` once in coordinator runtime options.
- `runTodoPlanner({ thinkingLevel })` accepts direct programmatic overrides. If omitted, it uses `high`.
- Every explicit supported value is forwarded unchanged, including `xhigh` and `max`.
- `taskThinking`, worker `thinkingLevel` options, and goal-loop discovery/reviewer thinking options are separate and are not affected by the planner default.
