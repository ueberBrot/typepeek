import { InspectionLimitError } from "#typepeek/inspection/model/errors";

const MAX_DECLARATIONS_PER_SYMBOL = 128;

export const assertMergedDeclarationLimit =
  function assertMergedDeclarationLimit(
    declarations: readonly unknown[]
  ): void {
    if (declarations.length > MAX_DECLARATIONS_PER_SYMBOL) {
      throw new InspectionLimitError(
        "merged-declarations",
        "Inspection exceeded its declaration merge limit."
      );
    }
  };
