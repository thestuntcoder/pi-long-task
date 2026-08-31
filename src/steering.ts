export type SteeringInputSource = "interactive" | "rpc";

export interface SteeringInput {
  text: string;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
  images?: readonly unknown[];
}

export type SteeringMessageStatus = "queued" | "processing" | "accepted" | "failed";

export interface SteeringMessage {
  id: string;
  sequence: number;
  text: string;
  source: SteeringInputSource;
  receivedAt: string;
  status: SteeringMessageStatus;
  error?: string;
}

export type SteeringMessageProcessor = (message: Readonly<SteeringMessage>) => void | Promise<void>;
export type SteeringMessageObserver = (message: Readonly<SteeringMessage>) => void;

/**
 * A run-scoped FIFO for guidance received while a long task is active.
 *
 * A message remains in the queue until its processor resolves successfully. A
 * processor failure pauses the queue so later guidance cannot overtake it;
 * callers may fix the recoverable failure and call retryFailed().
 */
export class SerializedSteeringQueue {
  private readonly queueId: string;
  private readonly now: () => Date;
  private readonly onChange: SteeringMessageObserver | undefined;
  private readonly messages: SteeringMessage[] = [];
  private processor: SteeringMessageProcessor | undefined;
  private sequence = 0;
  private processing = false;
  private failed = false;
  private closed = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: { queueId: string; now?: () => Date; onChange?: SteeringMessageObserver }) {
    const queueId = options.queueId.trim();
    if (!queueId) {
      throw new Error("A steering queue requires a non-empty queueId.");
    }
    this.queueId = queueId;
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange;
  }

  enqueue(text: string, source: SteeringInputSource): SteeringMessage {
    if (this.closed) {
      throw new Error("Cannot enqueue guidance after the steering queue is closed.");
    }
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("Steering guidance must not be empty.");
    }

    const sequence = ++this.sequence;
    const message: SteeringMessage = {
      id: `${this.queueId}:${sequence}`,
      sequence,
      text: normalizedText,
      source,
      receivedAt: this.now().toISOString(),
      status: "queued",
    };
    this.messages.push(message);
    this.publish(message);
    const queuedMessage = { ...message };
    this.startPump();
    return queuedMessage;
  }

  /** Attach the single plan-revision consumer. Pending messages start immediately. */
  setProcessor(processor: SteeringMessageProcessor): () => void {
    if (this.processor && this.processor !== processor) {
      throw new Error("A steering queue already has a processor.");
    }
    this.processor = processor;
    this.startPump();
    return () => {
      if (this.processor === processor) {
        this.processor = undefined;
      }
    };
  }

  /** Retry the failed head message without allowing later messages to overtake it. */
  retryFailed(): void {
    if (!this.failed) {
      return;
    }
    const message = this.messages[0];
    if (message?.status === "failed") {
      message.status = "queued";
      delete message.error;
      this.publish(message);
    }
    this.failed = false;
    this.startPump();
  }

  pendingMessages(): ReadonlyArray<Readonly<SteeringMessage>> {
    return this.messages.map((message) => ({ ...message }));
  }

  waitForIdle(): Promise<void> {
    if (!this.processing) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  close(): void {
    this.closed = true;
    this.processor = undefined;
    this.resolveIdleWaitersIfIdle();
  }

  private startPump(): void {
    if (this.processing || this.failed || !this.processor || this.messages.length === 0) {
      return;
    }
    this.processing = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (!this.failed && this.processor && this.messages.length > 0) {
        const processor = this.processor;
        const message = this.messages[0];
        message.status = "processing";
        delete message.error;
        this.publish(message);
        try {
          await processor({ ...message });
        } catch (error) {
          message.status = "failed";
          message.error = errorMessage(error);
          this.failed = true;
          this.publish(message);
          break;
        }

        message.status = "accepted";
        this.publish(message);
        this.messages.shift();
      }
    } finally {
      this.processing = false;
      this.resolveIdleWaitersIfIdle();
      // A message may have arrived between the final loop check and this
      // assignment. Starting again here closes that race without parallelism.
      this.startPump();
    }
  }

  private publish(message: SteeringMessage): void {
    try {
      this.onChange?.({ ...message });
    } catch {
      // Observability must never affect delivery or ordering.
    }
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.processing) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

export type SteeringRouteResult =
  | { routed: true; message: SteeringMessage }
  | {
      routed: false;
      reason: "no_active_run" | "ambiguous_active_runs" | "not_steering" | "control_input" | "images" | "empty";
    };

/** Routes input only when exactly one Pi Long Task execution owns steering. */
export class ActiveLongTaskSteeringRouter {
  private readonly activeQueues = new Map<symbol, SerializedSteeringQueue>();

  activate(queue: SerializedSteeringQueue): () => void {
    const registration = Symbol("active-long-task-steering");
    this.activeQueues.set(registration, queue);
    return () => {
      this.activeQueues.delete(registration);
    };
  }

  route(input: SteeringInput): SteeringRouteResult {
    if (input.source === "extension" || input.streamingBehavior !== "steer") {
      return { routed: false, reason: "not_steering" };
    }
    if (input.images && input.images.length > 0) {
      return { routed: false, reason: "images" };
    }
    const text = input.text.trim();
    if (!text) {
      return { routed: false, reason: "empty" };
    }
    if (isControlInput(text)) {
      return { routed: false, reason: "control_input" };
    }
    if (this.activeQueues.size === 0) {
      return { routed: false, reason: "no_active_run" };
    }
    if (this.activeQueues.size > 1) {
      return { routed: false, reason: "ambiguous_active_runs" };
    }

    const queue = this.activeQueues.values().next().value as SerializedSteeringQueue;
    return { routed: true, message: queue.enqueue(text, input.source) };
  }
}

function isControlInput(text: string): boolean {
  return text.startsWith("/") || text.startsWith("!");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
