import { InspectionLimitError } from "#typepeek/inspection/errors";

const MAX_DECLARATIONS_PER_SYMBOL = 128;

/** Applies the shared merged-declaration bound before any symbol is treated as authority. */
export function assertMergedDeclarationLimit(declarations: readonly unknown[]): void {
  if (declarations.length > MAX_DECLARATIONS_PER_SYMBOL) {
    throw new InspectionLimitError("Inspection exceeded its declaration merge limit.");
  }
}
