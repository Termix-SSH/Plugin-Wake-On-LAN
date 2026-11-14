import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

type KeepAwake = (reason: string, awake: boolean) => void;

/**
 * Tells Termix whether a job has work, so the plugin's process can stop when
 * none of its jobs do (Termix 26.11.2+, a no-op on older versions).
 */
export function keepAwake(
  ctx: Pick<PluginContext, "schedule">,
  reason: string,
  awake: boolean,
): void {
  const schedule = ctx.schedule as { keepAwake?: KeepAwake };
  schedule.keepAwake?.call(ctx.schedule, reason, awake);
}
