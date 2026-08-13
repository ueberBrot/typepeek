import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import { inspectFocusedModuleExport } from "#typepeek/inspection/export-inspection";
import {
  type InspectableModuleEvidence,
  readInspectableModuleEvidence,
} from "#typepeek/inspection/installed-evidence";
import type { AnalysisRequest, InspectionOutcome } from "#typepeek/inspection/protocol";
import { constructInterfaceOverview } from "#typepeek/inspection/result-construction";
import { inspectModuleExportSignatures } from "#typepeek/inspection/signature-inspection";

const MAX_MODULE_EXPORTS = 320;

/**
 * Runs one already-normalized request inside the analysis subprocess. Expected
 * inspection limits and unsupported cases retain their category; unexpected
 * analyzer failures are deliberately collapsed to a generic unsupported result.
 */
export function analyzeInspection(analysisRequest: AnalysisRequest): InspectionOutcome {
  try {
    return inspectInstalledPackage(analysisRequest);
  } catch (error) {
    return errorOutcome(error);
  }
}

function inspectInstalledPackage(analysisRequest: AnalysisRequest): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = readInspectableModuleEvidence(request, evidenceInspection(analysisRequest));
  if (evidence === undefined) {
    return {
      status: "not-found",
      message: `Specifier "${request.specifier}" is not installed from this Resolution Context.`,
    };
  }

  if (analysisRequest.intent === "export-inspection") {
    const result = inspectFocusedModuleExport(
      evidence,
      analysisRequest.request.exportName,
      request.specifier,
    );
    return result === undefined
      ? {
          status: "not-found",
          message: `Module Export "${analysisRequest.request.exportName}" was not found in "${request.specifier}".`,
        }
      : { status: "success", result };
  }

  if (analysisRequest.intent === "signature-inspection") {
    const result = inspectModuleExportSignatures(
      evidence,
      analysisRequest.request.exportName,
      request.specifier,
    );
    return result === undefined
      ? missingExportOutcome(analysisRequest.request.exportName, request.specifier)
      : { status: "success", result };
  }

  return {
    status: "success",
    result: constructInterfaceOverview(
      request.specifier,
      evidence.resultIdentity,
      evidence.publicSubpaths,
      inspectModuleExports(evidence),
    ),
  };
}

function evidenceInspection(
  analysisRequest: AnalysisRequest,
): Parameters<typeof readInspectableModuleEvidence>[1] {
  switch (analysisRequest.intent) {
    case "export-inspection":
    case "signature-inspection":
      return {
        intent: analysisRequest.intent,
        exportName: analysisRequest.request.exportName,
      };
    case "interface-overview":
      return { intent: analysisRequest.intent };
  }
}

function missingExportOutcome(exportName: string, specifier: string): InspectionOutcome {
  return {
    status: "not-found",
    message: `Module Export "${exportName}" was not found in "${specifier}".`,
  };
}

function inspectModuleExports({
  checker,
  moduleSymbol,
}: InspectableModuleEvidence): readonly { readonly name: string }[] {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  if (exportedSymbols.length > MAX_MODULE_EXPORTS) {
    throw new InspectionLimitError("Inspection exceeded its Module Export limit.");
  }
  return exportedSymbols.map((symbol) => ({ name: symbol.getName() })).sort(compareModuleExports);
}

function compareModuleExports(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function errorOutcome(error: unknown): InspectionOutcome {
  if (error instanceof InspectionLimitError) {
    return { status: "limit-exceeded", message: error.message };
  }
  if (error instanceof StaticBoundaryInspectionError) {
    return { status: "static-boundary", message: error.message };
  }
  // Unexpected errors may contain host paths or analyzer details, neither of
  // which belongs in the transport-neutral Inspection Result.
  return error instanceof UnsupportedInspectionError
    ? { status: "unsupported", message: error.message }
    : {
        status: "unsupported",
        message: "Installed Evidence could not be inspected statically.",
      };
}
