import type { InspectionBudgetDimension } from "#typepeek/inspection/model/protocol-vocabulary";

/** Signals that an inspection exhausted a measured work or output budget. */
export class InspectionLimitError extends Error {
  override name = "InspectionLimitError";
  readonly exceededBudget: InspectionBudgetDimension;
  constructor(exceededBudget: InspectionBudgetDimension, message: string) {
    super(message);
    this.exceededBudget = exceededBudget;
  }
}

export { UnsupportedInspectionError } from "#typepeek/inspection/model/unsupported-inspection-error";

export { StaticBoundaryInspectionError } from "#typepeek/inspection/model/static-boundary-inspection-error";
