import { inspectResolvedExportSignatures } from "#typepeek/inspection/export-inspection";
import { resolveFocusedExport } from "#typepeek/inspection/focused-export";
import type { InspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import type { SignatureInspection } from "#typepeek/inspection/protocol";
import { SignatureInspectionConstruction } from "#typepeek/inspection/result-construction";

/** Produces a focused result without declaration or Supporting Type traversal. */
export function inspectModuleExportSignatures(
  evidence: InspectableModuleEvidence,
  exportName: string,
  specifier: string,
): SignatureInspection | undefined {
  const resolution = resolveFocusedExport(evidence.checker, evidence.moduleSymbol, exportName);
  if (resolution === undefined) {
    return undefined;
  }

  const construction = new SignatureInspectionConstruction();
  const signatures = inspectResolvedExportSignatures(evidence.checker, resolution, {
    signature: (value) => construction.signature(value),
  });
  const moduleExport = construction.moduleExport(
    resolution.exportedSymbol.getName(),
    resolution.aliasTargetName,
    signatures,
  );
  return construction.result(specifier, evidence.resultIdentity, moduleExport);
}
