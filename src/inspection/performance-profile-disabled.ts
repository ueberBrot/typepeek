/** Packaged builds disable profiling. */
export const inspectionProfilingEnabled = false;

export function beginInspectionProfile(): void {}

export function profileInspectionPhase<Value>(_name: string, inspect: () => Value): Value {
  return inspect();
}

export function completeInspectionProfile(): undefined {
  return undefined;
}

export function forwardInspectionProfile(_serialized: Uint8Array): void {}
