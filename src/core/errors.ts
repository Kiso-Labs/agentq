export class AgentQError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "AgentQError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
