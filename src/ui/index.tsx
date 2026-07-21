import { type Instance, render } from "ink";
import { AgentqApp } from "./app.tsx";
import type { UiController } from "./types.ts";

export interface RenderAgentqOptions {
  pollIntervalMs?: number;
  alternateScreen?: boolean;
}

/** Render AgentQ as a full-screen terminal application. */
export function renderAgentq(
  controller: UiController,
  options: RenderAgentqOptions = {},
): Instance {
  return render(<AgentqApp controller={controller} pollIntervalMs={options.pollIntervalMs} />, {
    alternateScreen: options.alternateScreen ?? true,
    exitOnCtrlC: true,
    patchConsole: false,
  });
}

export { AgentqApp } from "./app.tsx";
export type { AgentqAppProps, ListEventOptions, UiController } from "./types.ts";
