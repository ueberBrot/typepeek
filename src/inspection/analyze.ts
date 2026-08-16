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
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionFailure,
  InspectionOutcome,
  InspectionPlanQuery,
} from "#typepeek/inspection/protocol";
import {
  constructInterfaceOverview,
  type InspectionResultConstructionContext,
} from "#typepeek/inspection/result-construction";
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
  const constructionContext: InspectionResultConstructionContext = {
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity: evidence.resultIdentity,
  };

  if (analysisRequest.intent === "inspection-plan") {
    const inspections: AtomicInspectionResult[] = [];
    for (const query of analysisRequest.request.queries) {
      const inspection = inspectEvidenceQuery(evidence, query, constructionContext);
      if ("status" in inspection) {
        return inspection;
      }
      inspections.push(inspection);
    }
    return {
      status: "success",
      result: { intent: "inspection-plan", inspections },
    };
  }

  const inspection = inspectEvidenceQuery(
    evidence,
    analysisRequest.intent === "interface-overview"
      ? { intent: analysisRequest.intent }
      : { intent: analysisRequest.intent, exportName: analysisRequest.request.exportName },
    constructionContext,
  );
  return "status" in inspection ? inspection : { status: "success", result: inspection };
}

function inspectEvidenceQuery(
  evidence: InspectableModuleEvidence,
  query: InspectionPlanQuery,
  constructionContext: InspectionResultConstructionContext,
): AtomicInspectionResult | InspectionFailure {
  if (query.intent === "export-inspection") {
    const result = inspectFocusedModuleExport(evidence, query.exportName, constructionContext);
    return result === undefined
      ? missingExportOutcome(query.exportName, constructionContext.specifier)
      : result;
  }

  if (query.intent === "signature-inspection") {
    const result = inspectModuleExportSignatures(evidence, query.exportName, constructionContext);
    return result === undefined
      ? missingExportOutcome(query.exportName, constructionContext.specifier)
      : result;
  }

  return constructInterfaceOverview(
    constructionContext,
    evidence.publicSubpaths,
    inspectModuleExports(evidence),
  );
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
    case "inspection-plan":
      return { intent: analysisRequest.intent, queries: analysisRequest.request.queries };
  }
}

function missingExportOutcome(exportName: string, specifier: string): InspectionFailure {
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
