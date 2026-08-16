import type { InspectionBudgetDimension } from "#typepeek/inspection/protocol-vocabulary";

/** Signals that an inspection exhausted a measured work or output budget. */
export class InspectionLimitError extends Error {
  readonly exceededBudget: InspectionBudgetDimension;

  constructor(exceededBudget: InspectionBudgetDimension, message: string) {
    super(message);
    this.exceededBudget = exceededBudget;
  }
}

/** Signals that Installed Evidence cannot support an authoritative inspection. */
export class UnsupportedInspectionError extends Error {}

/** Signals that a request crosses Typepeek's no-execution inspection boundary. */
export class StaticBoundaryInspectionError extends Error {}
