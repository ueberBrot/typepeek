import type {
  InspectedModuleExportSignatures,
  InspectedSignature,
  SignatureInspection,
} from "#typepeek/inspection/protocol";
import type { ResultConstructionBudget } from "#typepeek/inspection/result-construction-budget";
import type {
  InspectionResultConstructionTarget,
  SignatureInspectionConstruction,
} from "#typepeek/inspection/result-construction-contracts";

export class OwnedSignatureInspectionConstruction implements SignatureInspectionConstruction {
  readonly #budget: ResultConstructionBudget;
  readonly #target: InspectionResultConstructionTarget;
  constructor(
    target: InspectionResultConstructionTarget,
    budget: ResultConstructionBudget
  ) {
    this.#target = target;
    this.#budget = budget;
  }
  signature(value: InspectedSignature): InspectedSignature {
    return this.#budget.leaf(value);
  }
  moduleExport(
    name: string,
    aliasTargetName: string | undefined,
    signatures: readonly InspectedSignature[]
  ): InspectedModuleExportSignatures {
    return this.#budget.container(
      {
        name,
        ...(aliasTargetName !== undefined && { aliasTargetName }),
        signatures,
      },
      signatures
    );
  }
  result(moduleExport: InspectedModuleExportSignatures): SignatureInspection {
    return this.#budget.container(
      {
        intent: "signature-inspection",
        resolutionVariant: this.#target.resolutionVariant,
        specifier: this.#target.specifier,
        ...this.#target.identity,
        moduleExport,
      },
      [moduleExport]
    );
  }
}
