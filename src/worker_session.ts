import { coverageGoalAction, coverageGoalVerification, parseCoverageGoal } from "./coverage_goal.ts";
import { hasTaskResult, hasTaskResultStatus, isDoneStatus, parseReportedStatus } from "./result_writer.ts";
import type { Task } from "./todo_parser.ts";

export interface WorkerTaskPromptOptions {
  todoPath: string;
  task: Pick<Task, "taskId" | "title" | "section">;
  attempt: number;
  commitRequested: boolean;
  previousAttempts?: string;
  globalInstructions?: string;
  goal?: string;
  maxBashTimeoutSeconds: number;
}

export interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
}

export function taskLabel(task: Pick<Task, "taskId" | "title">): string {
  return `TODO ${task.taskId} — ${task.title}`;
}

export function buildTaskPrompt(options: WorkerTaskPromptOptions): string {
  const commitText = options.commitRequested
    ? "Commit mode is enabled: complete your assigned work and report status accurately; Pi Long Task will commit eligible completed work after your session if needed. Do not run git commit."
    : "Do not run git commit. Pi Long Task was started with commits disabled.";

  const previousAttempts = (options.previousAttempts || "").trim();
  const previousText = previousAttempts
    ? `
Previous attempts for this same assigned task are below. Use them only as continuity for this task:

\`\`\`text
${previousAttempts}
\`\`\`
`
    : "";

  const globalInstructions = (options.globalInstructions || "").trim();
  const globalText = globalInstructions
    ? `
Global instructions from the TODO file apply to this task:

\`\`\`markdown
${globalInstructions}
\`\`\`
`
    : "";

  const goal = (options.goal || "").trim();
  const coverageGoal = parseCoverageGoal(goal);
  const coverageGoalText = coverageGoal
    ? `

Coverage goal guidance:
- ${coverageGoalAction(coverageGoal)}
- ${coverageGoalVerification(coverageGoal)} Prefer the project-specific coverage script when available (for example, \`npm run test:coverage\`, \`npm run coverage\`, or \`npm test -- --coverage\`).`
    : "";
  const goalText = goal
    ? `

Long task goal:

\`\`\`text
${goal}
\`\`\`${coverageGoalText}`
    : "";

  return `You are one Pi SDK worker session assigned to exactly one TODO task.

Assigned TODO file path: \`${options.todoPath}\`
Assigned task: \`${taskLabel(options.task)}\`
Attempt: ${options.attempt}${goalText}

Rules:
- Work only on the assigned task below. Do not start or fix other TODO tasks.
- Pi Long Task is responsible for marking TODO progress. Do not edit \`${options.todoPath}\` unless it is directly necessary for the assigned task implementation itself.
- Do not edit \`TASK_RESULT.md\`; Pi Long Task writes it.
- ${commitText}
- If you need to stop because context is high or the work is blocked, leave the repository in a safe state and report \`status: partial\` or \`status: blocked\`.
- Use the repository's AGENTS.md/project instructions.
- Run focused verification commands when practical.
- Do not run bash commands with timeout greater than ${options.maxBashTimeoutSeconds.toFixed(0)} seconds. For long full-suite checks, run once with a bounded timeout and report any timeout/failure in TASK_RESULT instead of continuing indefinitely.
- If TODO-file global instructions restrict scope, obey them strictly. If the task appears to require out-of-scope code changes, stop and report \`status: blocked\` instead of changing those files.

${globalText}Assigned task content only:

\`\`\`markdown
${options.task.section.trimEnd()}
\`\`\`
${previousText}
When you are finished, your final assistant message must end with this machine-readable block:

TASK_RESULT:
status: done|partial|blocked|failed
summary: <short summary>
changes:
- <changed item or "none">
verification:
- <command/result or "not run">
remaining:
- <remaining item or "none">

Only use \`status: done\` if the assigned task is fully complete and verified as far as practical.`.trim();
}

export const buildAssignedTaskPrompt = buildTaskPrompt;

export function buildTimeLimitMessage(seconds: number): string {
  return `Pi Long Task notice: this worker session has reached its ${seconds.toFixed(0)}s time budget.
Stop after the current safe point. Do not start more implementation work.
Finish with the required TASK_RESULT block now.
Use \`status: done\` only if the assigned task is actually complete; otherwise use \`status: partial\`.`;
}

export function buildShutdownMessage(percent: number): string {
  return `Pi Long Task notice: context usage is ${percent.toFixed(1)}%, above the 85% shutdown threshold.
Stop after the current safe point. Do not start more implementation work.
Leave files in a safe state and finish with the required TASK_RESULT block.
Use \`status: done\` only if the assigned task is actually complete; otherwise use \`status: partial\`.`;
}

export function buildCompactionInstructions(task: Pick<Task, "taskId" | "title">): string {
  return `Keep only information needed to finish assigned task ${taskLabel(task)}: relevant files inspected,
edits made, verification run, failures, and remaining steps. Drop unrelated details.`;
}

export function assistantMessageText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") {
    return "";
  }

  const { content } = message;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    const text = textFromContentPart(item);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("");
}

export function lastAssistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const text = assistantMessageText(messages[idx]);
    if (text) {
      return text;
    }
  }
  return "";
}

export function assistantTextFromEvent(event: unknown): string {
  if (!isRecord(event)) {
    return "";
  }

  const fromMessages = lastAssistantTextFromMessages(event.messages);
  if (fromMessages) {
    return fromMessages;
  }

  const fromMessage = assistantMessageText(event.message);
  if (fromMessage) {
    return fromMessage;
  }

  const fromDelta = textFromDeltaEvent(event);
  if (fromDelta) {
    return fromDelta;
  }

  return assistantMessageText(event);
}

export function lastAssistantTextFromEvents(events: unknown): string {
  if (!Array.isArray(events)) {
    return "";
  }

  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const text = assistantTextFromEvent(events[idx]);
    if (text) {
      return text;
    }
  }
  return "";
}

export const extractAssistantTextFromMessage = assistantMessageText;
export const extractLastAssistantTextFromMessages = lastAssistantTextFromMessages;
export const extractAssistantTextFromEvent = assistantTextFromEvent;
export const extractLastAssistantTextFromEvents = lastAssistantTextFromEvents;

export const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const DEFAULT_WORKER_THINKING_LEVEL = "high";
export const DEFAULT_TASK_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_GRACEFUL_SHUTDOWN_SECONDS = 60;

export interface WorkerSessionLike {
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  steer?(text: string): Promise<void>;
  followUp?(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort?(): Promise<void> | void;
  abortBash?(): void;
  compact?(customInstructions?: string): Promise<unknown>;
  dispose?(): void;
  getLastAssistantText?(): string | undefined;
  getSessionStats?(): unknown | Promise<unknown>;
  getContextUsage?(): unknown;
  sessionFile?: string;
  sessionId?: string;
  isStreaming?: boolean;
  isBashRunning?: boolean;
  messages?: unknown[];
}

export interface WorkerSessionFactoryResult {
  session: WorkerSessionLike;
  modelFallbackMessage?: string;
  diagnostics?: string[];
}

export interface CreateWorkerSessionOptions {
  cwd: string;
  agentDir?: string;
  tools?: readonly string[];
  model?: unknown;
  modelName?: string;
  thinkingLevel?: string;
  authStorage?: unknown;
  modelRegistry?: unknown;
  settingsManager?: unknown;
  resourceLoader?: unknown;
}

export type WorkerSessionFactory = (options: CreateWorkerSessionOptions) => Promise<WorkerSessionFactoryResult>;

export interface RunWorkerTaskOptions extends WorkerTaskPromptOptions, CreateWorkerSessionOptions {
  taskTimeoutSeconds?: number;
  gracefulShutdownSeconds?: number;
  abortSignal?: AbortSignal;
  sessionFactory?: WorkerSessionFactory;
  onEvent?: (event: CapturedWorkerEvent) => void;
  now?: () => Date;
}

export interface CapturedWorkerEvent {
  type: string;
  textDelta?: string;
  toolName?: string;
  isError?: boolean;
  note?: string;
  usageCostTotal?: number;
  usageCostKey?: string;
}

export interface SessionOutcome {
  task: Pick<Task, "taskId" | "title" | "section">;
  attempt: number;
  startedAt: string;
  endedAt: string;
  reportedStatus: string;
  done: boolean;
  assistantText: string;
  sessionFile?: string;
  sessionId?: string;
  contextObservations: string[];
  compactionEvents: string[];
  events: CapturedWorkerEvent[];
  workerCostTotal: number;
  workerCostSource?: string;
  shutdownRequested: boolean;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

export function buildMissingTaskResultMessage(): string {
  return `Pi Long Task notice: your previous response did not include a complete machine-readable TASK_RESULT block.
Reply now with only the required block:

TASK_RESULT:
status: done|partial|blocked|failed
summary: <short summary>
changes:
- <changed item or "none">
verification:
- <command/result or "not run">
remaining:
- <remaining item or "none">`;
}

export async function createIsolatedWorkerSession(
  options: CreateWorkerSessionOptions,
): Promise<WorkerSessionFactoryResult> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? pi.getAgentDir();
  const authStorage = options.authStorage ?? pi.AuthStorage.create();
  const modelRegistry = options.modelRegistry ?? pi.ModelRegistry.create(authStorage as never);
  const settingsManager = options.settingsManager ?? pi.SettingsManager.create(cwd, agentDir);

  applyWorkerSettingsDefaults(settingsManager);

  const discoveredResourceLoader =
    options.resourceLoader ??
    new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settingsManager as never,
      noExtensions: true,
    });
  const resourceLoader = disableExtensionsForWorker(discoveredResourceLoader, () => pi.createExtensionRuntime());
  await resourceLoader.reload();

  const model =
    options.model ?? (options.modelName ? await resolveWorkerModel(modelRegistry, options.modelName) : undefined);
  const createOptions: Record<string, unknown> = {
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    tools: [...(options.tools ?? DEFAULT_WORKER_TOOLS)],
    thinkingLevel: options.thinkingLevel ?? DEFAULT_WORKER_THINKING_LEVEL,
    sessionManager: pi.SessionManager.inMemory(cwd),
  };
  if (model) {
    createOptions.model = model;
  }

  const result = await pi.createAgentSession(createOptions as never);
  return {
    session: result.session,
    modelFallbackMessage: result.modelFallbackMessage,
    diagnostics: extensionDiagnostics(result.extensionsResult),
  };
}

export async function runWorkerTask(options: RunWorkerTaskOptions): Promise<SessionOutcome> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const contextObservations: string[] = [];
  const compactionEvents: string[] = [];
  const events: CapturedWorkerEvent[] = [];
  let assistantText = "";
  let currentAssistantText = "";
  let sessionFile: string | undefined;
  let sessionId: string | undefined;
  let shutdownRequested = false;
  let timedOut = false;
  let aborted = false;
  let error: string | undefined;
  let finished = false;
  let turnCount = 0;
  let messageUsageCostTotal = 0;
  let hasMessageUsageCost = false;
  let sessionStatsCostTotal: number | undefined;

  const prompt = buildTaskPrompt(options);
  const taskTimeoutSeconds = options.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
  const gracefulShutdownSeconds = options.gracefulShutdownSeconds ?? DEFAULT_GRACEFUL_SHUTDOWN_SECONDS;
  const sessionFactory = options.sessionFactory ?? createIsolatedWorkerSession;
  let session: WorkerSessionLike | undefined;
  let unsubscribe: (() => void) | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const capture = (event: CapturedWorkerEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  const messageUsageCostsByKey = new Map<string, number>();
  const recordWorkerUsageCost = (cost: number | undefined, key: string | undefined) => {
    if (cost === undefined) {
      return;
    }
    hasMessageUsageCost = true;
    if (!key) {
      messageUsageCostTotal += cost;
      return;
    }

    const previousCost = messageUsageCostsByKey.get(key) ?? 0;
    messageUsageCostsByKey.set(key, cost);
    messageUsageCostTotal += cost - previousCost;
  };

  const schedule = (fn: () => void | Promise<void>, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void Promise.resolve(fn()).catch((exc: unknown) => {
        compactionEvents.push(`timer action failed: ${errorMessage(exc)}`);
      });
    }, ms);
    timers.add(timer);
  };

  const requestGracefulTaskResult = async (message: string, options: { shutdown?: boolean } = {}) => {
    if (!session || finished || aborted) {
      return;
    }
    if (options.shutdown) {
      shutdownRequested = true;
    }
    if (session.isBashRunning && session.abortBash) {
      session.abortBash();
      compactionEvents.push("aborted running bash before graceful shutdown request");
    }
    if ((session.isStreaming || session.isBashRunning) && session.steer) {
      await session.steer(message);
    } else {
      await session.prompt(message);
    }
  };

  const abortSession = async (reason: string) => {
    if (!session || finished || aborted) {
      return;
    }
    aborted = true;
    shutdownRequested = true;
    error = error ?? reason;
    await session.abort?.();
  };

  const abortListener = () => {
    void abortSession("worker session aborted by outer signal").catch((exc: unknown) => {
      compactionEvents.push(`abort by outer signal failed: ${errorMessage(exc)}`);
    });
  };

  try {
    if (options.abortSignal?.aborted) {
      throw new Error("worker session aborted before start");
    }

    const factoryResult = await sessionFactory(options);
    session = factoryResult.session;
    sessionFile = session.sessionFile;
    sessionId = session.sessionId;
    if (factoryResult.modelFallbackMessage) {
      contextObservations.push(`model fallback: ${factoryResult.modelFallbackMessage}`);
    }
    for (const diagnostic of factoryResult.diagnostics ?? []) {
      contextObservations.push(diagnostic);
    }

    unsubscribe = session.subscribe((event: unknown) => {
      const summary = summarizeWorkerEvent(event);
      if (summary) {
        capture(summary);
      }

      if (!isRecord(event) || typeof event.type !== "string") {
        return;
      }

      switch (event.type) {
        case "message_start": {
          const message = event.message;
          if (isRecord(message) && message.role === "assistant") {
            currentAssistantText = "";
          }
          break;
        }
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (isRecord(assistantEvent) && assistantEvent.type === "text_delta") {
            const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
            currentAssistantText += delta;
            assistantText = currentAssistantText || assistantText;
          }
          break;
        }
        case "message_end": {
          const messageText = assistantMessageText(event.message);
          if (messageText) {
            assistantText = messageText;
          }
          recordWorkerUsageCost(workerUsageCostFromEvent(event), workerUsageCostKeyFromEvent(event));
          break;
        }
        case "turn_end": {
          turnCount += 1;
          const messageText = assistantMessageText(event.message);
          if (messageText) {
            assistantText = messageText;
          }
          captureContextUsage(session, turnCount, contextObservations);
          break;
        }
        case "tool_execution_start": {
          const toolName = typeof event.toolName === "string" ? event.toolName : "";
          if (toolName === "bash") {
            const requestedTimeout = requestedBashTimeout(event);
            if (requestedTimeout !== undefined && requestedTimeout > options.maxBashTimeoutSeconds) {
              const command = isRecord(event.args) && typeof event.args.command === "string" ? event.args.command : "";
              compactionEvents.push(
                `aborted bash command with timeout ${requestedTimeout.toFixed(0)}s > max ${options.maxBashTimeoutSeconds.toFixed(0)}s: ${command.slice(0, 160)}`,
              );
              session?.abortBash?.();
            }
          }
          break;
        }
        case "compaction_end": {
          compactionEvents.push(formatCompactionEndEvent(event));
          break;
        }
        case "agent_end": {
          const eventText = lastAssistantTextFromMessages(event.messages);
          if (eventText) {
            assistantText = eventText;
          }
          break;
        }
        case "extension_error": {
          compactionEvents.push(`extension_error: ${String(event.error ?? "unknown")}`);
          break;
        }
      }
    });

    options.abortSignal?.addEventListener("abort", abortListener, { once: true });

    if (taskTimeoutSeconds > 0) {
      schedule(async () => {
        if (finished || hasTaskResultStatus(assistantText)) {
          return;
        }
        timedOut = true;
        await requestGracefulTaskResult(buildTimeLimitMessage(taskTimeoutSeconds), { shutdown: true });
        if (gracefulShutdownSeconds > 0) {
          schedule(
            () => abortSession(`task exceeded ${taskTimeoutSeconds.toFixed(0)}s timeout`),
            gracefulShutdownSeconds * 1000,
          );
        }
      }, taskTimeoutSeconds * 1000);
    }

    await session.prompt(prompt);
    assistantText = latestAssistantText(session, assistantText);

    if (!hasTaskResultStatus(assistantText) && !aborted && !options.abortSignal?.aborted) {
      contextObservations.push("missing TASK_RESULT status after initial prompt; requested required block once");
      await requestGracefulTaskResult(buildMissingTaskResultMessage());
      assistantText = latestAssistantText(session, assistantText);
    }
  } catch (exc) {
    error = error ?? errorMessage(exc);
  } finally {
    finished = true;
    clearTimers();
    options.abortSignal?.removeEventListener("abort", abortListener);
    unsubscribe?.();
    if (session) {
      assistantText = latestAssistantText(session, assistantText);
      sessionFile = session.sessionFile ?? sessionFile;
      sessionId = session.sessionId ?? sessionId;
      sessionStatsCostTotal = await workerUsageCostFromSessionStats(session);
      session.dispose?.();
    }
  }

  if ((error || aborted || timedOut) && !hasTaskResult(assistantText)) {
    assistantText = buildLongTaskFailureTaskResult(error ?? (timedOut ? "task timed out" : "worker session aborted"));
  }

  const reportedStatus = parseReportedStatus(assistantText);
  const capturedWorkerCost = selectWorkerCostTotal({
    messageCostTotal: hasMessageUsageCost ? messageUsageCostTotal : undefined,
    statsCostTotal: sessionStatsCostTotal,
  });
  return {
    task: options.task,
    attempt: options.attempt,
    startedAt,
    endedAt: now().toISOString(),
    reportedStatus,
    done: isDoneStatus(reportedStatus),
    assistantText,
    sessionFile,
    sessionId,
    contextObservations,
    compactionEvents,
    events,
    workerCostTotal: capturedWorkerCost.total,
    workerCostSource: capturedWorkerCost.source,
    shutdownRequested,
    timedOut,
    aborted: aborted || Boolean(options.abortSignal?.aborted),
    error,
  };
}

function textFromContentPart(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }

  const type = typeof item.type === "string" ? item.type : "";
  if (type && type !== "text" && type !== "output_text") {
    return "";
  }

  if (typeof item.text === "string") {
    return item.text;
  }
  if (isRecord(item.text) && typeof item.text.value === "string") {
    return item.text.value;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return "";
}

function textFromDeltaEvent(event: Record<string, unknown>): string {
  if (typeof event.text === "string") {
    return event.text;
  }
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (isRecord(event.delta)) {
    return textFromContentPart(event.delta);
  }
  if (isRecord(event.content)) {
    return textFromContentPart(event.content);
  }
  return "";
}

function applyWorkerSettingsDefaults(settingsManager: unknown): void {
  if (!isRecord(settingsManager) || typeof settingsManager.applyOverrides !== "function") {
    return;
  }

  try {
    settingsManager.applyOverrides({
      retry: { enabled: true, maxRetries: 2 },
      compaction: { enabled: true },
    });
  } catch {
    // Settings defaults are best-effort; createAgentSession can still use its own defaults.
  }
}

async function resolveWorkerModel(modelRegistry: unknown, modelName: string): Promise<unknown> {
  const [provider, ...modelIdParts] = modelName.split("/");
  const modelId = modelIdParts.join("/");
  if (provider && modelId && isRecord(modelRegistry) && typeof modelRegistry.find === "function") {
    const registryModel = modelRegistry.find(provider, modelId);
    if (registryModel) {
      return registryModel;
    }
  }

  try {
    const ai = await import("@earendil-works/pi-ai");
    if (typeof ai.getModel === "function" && provider && modelId) {
      const getModel = ai.getModel as (providerName: string, modelId: string) => unknown;
      return getModel(provider, modelId);
    }
  } catch {
    // Optional peer resolution can fail in tests that inject a session factory.
  }
  return undefined;
}

export function disableExtensionsForWorker(
  resourceLoader: unknown,
  createRuntime: () => unknown,
): {
  getExtensions: () => { extensions: unknown[]; errors: unknown[]; runtime: unknown };
  getSkills: () => unknown;
  getPrompts: () => unknown;
  getThemes: () => unknown;
  getAgentsFiles: () => unknown;
  getSystemPrompt: () => unknown;
  getAppendSystemPrompt: () => unknown[];
  extendResources: (paths: unknown) => void;
  reload: () => Promise<void>;
} {
  const loader = resourceLoader as Record<string, unknown>;
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createRuntime() }),
    getSkills: () => callLoaderMethod(loader, "getSkills", { skills: [], diagnostics: [] }),
    getPrompts: () => callLoaderMethod(loader, "getPrompts", { prompts: [], diagnostics: [] }),
    getThemes: () => callLoaderMethod(loader, "getThemes", { themes: [], diagnostics: [] }),
    getAgentsFiles: () => callLoaderMethod(loader, "getAgentsFiles", { agentsFiles: [] }),
    getSystemPrompt: () => callLoaderMethod(loader, "getSystemPrompt", undefined),
    getAppendSystemPrompt: () => callLoaderMethod(loader, "getAppendSystemPrompt", []) as unknown[],
    extendResources: (paths: unknown) => {
      if (typeof loader.extendResources === "function") {
        loader.extendResources(paths);
      }
    },
    reload: async () => {
      if (typeof loader.reload === "function") {
        await loader.reload();
      }
    },
  };
}

function callLoaderMethod(loader: Record<string, unknown>, name: string, fallback: unknown): unknown {
  const method = loader[name];
  return typeof method === "function" ? method.call(loader) : fallback;
}

function extensionDiagnostics(extensionsResult: unknown): string[] {
  if (!isRecord(extensionsResult) || !Array.isArray(extensionsResult.errors)) {
    return [];
  }
  return extensionsResult.errors.map((item) => {
    if (!isRecord(item)) {
      return `extension diagnostic: ${String(item)}`;
    }
    return `extension diagnostic: ${String(item.path ?? "unknown")}: ${String(item.error ?? "unknown error")}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeWorkerEvent(event: unknown): CapturedWorkerEvent | undefined {
  if (!isRecord(event) || typeof event.type !== "string") {
    return undefined;
  }

  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === "text_delta") {
      return {
        type: event.type,
        textDelta: typeof assistantEvent.delta === "string" ? assistantEvent.delta : "",
      };
    }
    return { type: event.type, note: String(assistantEvent.type ?? "assistant_update") };
  }

  if (event.type.startsWith("tool_execution_")) {
    return {
      type: event.type,
      toolName: typeof event.toolName === "string" ? event.toolName : undefined,
      isError: typeof event.isError === "boolean" ? event.isError : undefined,
    };
  }

  if (event.type === "message_end") {
    const usageCostTotal = workerUsageCostFromEvent(event);
    return usageCostTotal === undefined
      ? { type: event.type }
      : { type: event.type, usageCostTotal, usageCostKey: workerUsageCostKeyFromEvent(event) };
  }

  if (
    event.type === "turn_end" ||
    event.type === "compaction_start" ||
    event.type === "compaction_end" ||
    event.type === "agent_end" ||
    event.type === "auto_retry_start" ||
    event.type === "auto_retry_end"
  ) {
    return { type: event.type };
  }

  return undefined;
}

export function workerUsageCostFromEvent(event: unknown): number | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  for (const candidate of [event.assistantMessage, event.message, event]) {
    const cost = workerUsageCostFromAssistantMessage(candidate);
    if (cost !== undefined) {
      return cost;
    }
  }
  return undefined;
}

export function workerUsageCostFromAssistantMessage(message: unknown): number | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  return usageCostTotal(message.usage);
}

export function workerUsageCostKeyFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  for (const candidate of [event.assistantMessage, event.message, event]) {
    const key = workerUsageCostKeyFromAssistantMessage(candidate);
    if (key) {
      return key;
    }
  }
  return undefined;
}

function workerUsageCostKeyFromAssistantMessage(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  for (const keyName of ["id", "messageId", "uuid"] as const) {
    const value = message[keyName];
    if (typeof value === "string" && value) {
      return `${keyName}:${value}`;
    }
  }
  return undefined;
}

export function workerUsageCostFromStats(stats: unknown): number | undefined {
  if (!isRecord(stats)) {
    return undefined;
  }

  const directCost = finiteNonNegativeNumber(stats.cost);
  if (directCost !== undefined) {
    return directCost;
  }

  return usageCostTotal(stats.usage) ?? usageCostTotal(stats);
}

async function workerUsageCostFromSessionStats(session: WorkerSessionLike): Promise<number | undefined> {
  if (!session.getSessionStats) {
    return undefined;
  }

  try {
    return workerUsageCostFromStats(await session.getSessionStats());
  } catch {
    return undefined;
  }
}

function usageCostTotal(usage: unknown): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  const cost = usage.cost;
  if (isRecord(cost)) {
    return finiteNonNegativeNumber(cost.total);
  }
  return finiteNonNegativeNumber(cost);
}

function selectWorkerCostTotal(options: { messageCostTotal: number | undefined; statsCostTotal: number | undefined }): {
  total: number;
  source?: string;
} {
  if (options.statsCostTotal !== undefined) {
    return { total: options.statsCostTotal, source: "session_stats" };
  }
  if (options.messageCostTotal !== undefined) {
    return { total: options.messageCostTotal, source: "message_end" };
  }
  return { total: 0 };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function captureContextUsage(
  session: WorkerSessionLike | undefined,
  turnCount: number,
  contextObservations: string[],
): void {
  const usage = session?.getContextUsage?.() ?? contextUsageFromStats(session?.getSessionStats?.());
  const percent = contextPercent(usage);
  if (percent === undefined) {
    contextObservations.push(`turn ${turnCount}: context usage unavailable`);
    return;
  }
  contextObservations.push(`turn ${turnCount}: ${percent.toFixed(1)}%`);
}

function contextUsageFromStats(stats: unknown): unknown {
  return isRecord(stats) ? stats.contextUsage : undefined;
}

function contextPercent(usage: unknown): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  for (const key of ["percent", "percentage", "contextPercent", "contextPercentage"] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1 ? value : value * 100;
    }
  }

  const used = numericProperty(usage, ["used", "tokens", "contextTokens"]);
  const limit = numericProperty(usage, ["limit", "max", "contextWindow", "window"]);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return (used / limit) * 100;
  }
  return undefined;
}

function numericProperty(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function requestedBashTimeout(event: Record<string, unknown>): number | undefined {
  if (!isRecord(event.args)) {
    return undefined;
  }
  const timeout = event.args.timeout;
  if (typeof timeout === "number" && Number.isFinite(timeout)) {
    return timeout;
  }
  if (typeof timeout === "string") {
    const parsed = Number.parseFloat(timeout);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatCompactionEndEvent(event: Record<string, unknown>): string {
  const reason = String(event.reason ?? "unknown");
  const aborted = Boolean(event.aborted);
  if (isRecord(event.result)) {
    const tokensBefore = event.result.tokensBefore;
    return `compaction_end reason=${reason} aborted=${aborted} tokensBefore=${String(tokensBefore ?? "unknown")}`;
  }
  return `compaction_end reason=${reason} aborted=${aborted} error=${String(event.errorMessage ?? "unknown")}`;
}

function latestAssistantText(session: WorkerSessionLike, fallback: string): string {
  const direct = session.getLastAssistantText?.();
  if (direct) {
    return direct;
  }
  const fromMessages = lastAssistantTextFromMessages(session.messages);
  return fromMessages || fallback;
}

function buildLongTaskFailureTaskResult(reason: string): string {
  return `TASK_RESULT:
status: partial
summary: Pi Long Task stopped the session before the worker produced a final result.
changes:
- unknown; inspect git diff and session state
verification:
- not completed by worker
remaining:
- Pi Long Task/session error: ${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
