import type { SandboxProvider } from "@tanstack/ai-sandbox";

export const SANDBOX_RESOURCE_STATES = [
  "creating",
  "ready",
  "destroyed",
  "cleanup-failed",
] as const;

export interface SandboxResourceEvent {
  readonly id: string;
  readonly state: (typeof SANDBOX_RESOURCE_STATES)[number];
}

export const removeSandboxResources = async (
  destroy: SandboxProvider["destroy"],
  ids: ReadonlySet<string>
): Promise<void> => {
  const outcomes = await Promise.allSettled(
    [...ids].map(async (id) => {
      await destroy({ id });
    })
  );

  const failures = outcomes.filter((outcome) => outcome.status === "rejected");

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => new Error(String(failure.reason))),
      "Docker sandbox cleanup failed."
    );
  }
};
