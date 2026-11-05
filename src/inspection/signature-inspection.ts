import { resolveFocusedExport } from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import type { SignatureInspection } from "#typepeek/inspection/protocol";
import { inspectResolvedExportSignatureDetails } from "#typepeek/inspection/public-signatures";
import type { InspectionResultConstruction } from "#typepeek/inspection/result-construction";

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
