interface WaitingConsumer<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * A small, hot async queue for subprocess events.
 *
 * Producers never block subprocess pipe draining. Once capacity is reached the
 * oldest buffered event is discarded, while events already requested by a
 * consumer are always delivered directly.
 */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly capacity: number;
  dropped = 0;

  private readonly buffer: T[] = [];
  private readonly consumers: WaitingConsumer<T>[] = [];
  private closed = false;
  private failure: unknown;

  constructor(capacity = 512) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Queue capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  /** Returns false when an older buffered event had to be dropped. */
  push(value: T): boolean {
    if (this.closed) return false;

    const consumer = this.consumers.shift();
    if (consumer) {
      consumer.resolve({ done: false, value });
      return true;
    }

    let retainedAllEvents = true;
    if (this.buffer.length === this.capacity) {
      this.buffer.shift();
      this.dropped += 1;
      retainedAllEvents = false;
    }
    this.buffer.push(value);
    return retainedAllEvents;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const consumer of this.consumers.splice(0)) {
      consumer.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.buffer.length = 0;
    for (const consumer of this.consumers.splice(0)) consumer.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ done: true, value: undefined });

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.consumers.push({ resolve, reject });
        });
      },
    };
  }
}
