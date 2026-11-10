import type { InspectableModuleEvidence } from "#typepeek/inspection/evidence/installed-evidence";
import type { SignatureInspection } from "#typepeek/inspection/model/protocol";
import type { InspectionResultConstruction } from "#typepeek/inspection/model/result-construction";
import { inspectResolvedExportSignatureDetails } from "#typepeek/inspection/projection/public-signatures";
import { resolveFocusedExport } from "#typepeek/inspection/queries/focused-export";

/** Produces a focused result without declaration or Supporting Type traversal. */
export const inspectModuleExportSignatures =
  function inspectModuleExportSignatures(
    evidence: InspectableModuleEvidence,
    exportName: string,
    constructionOwner: InspectionResultConstruction
  ): SignatureInspection | undefined {
    const resolution = resolveFocusedExport(
      evidence.checker,
      evidence.moduleSymbol,
      exportName
    );

    if (resolution === undefined) {
      return undefined;
    }

    const construction = constructionOwner.signatures();

    const signatures = inspectResolvedExportSignatureDetails(
      evidence.checker,
      resolution,
      (value) => construction.signature(value)
    );

    const moduleExport = construction.moduleExport(
      resolution.exportedSymbol.name,
      resolution.aliasTargetName,
      signatures
    );

    return construction.result(moduleExport);
  };
