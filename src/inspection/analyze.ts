import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import { inspectFocusedModuleExport } from "#typepeek/inspection/export-inspection";
import {
  type InspectableModuleEvidence,
  type InspectableModuleDiscoveryEvidence,
  readInspectableModuleDiscoveryEvidence,
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
  constructExportSearch,
  constructInspectionPlan,
  constructInterfaceOverview,
  constructPublicSubpathDiscovery,
  createInspectionResultConstructionContext,
  type InspectionResultConstructionContext,
} from "#typepeek/inspection/result-construction";
import { inspectModuleExportSignatures } from "#typepeek/inspection/signature-inspection";

const MAX_MODULE_EXPORTS = 320;
const MAX_EXPORT_SEARCH_CANDIDATES = 4_096;
const MAX_EXPORT_SEARCH_MATCHES = 320;

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
  return analysisRequiresProgram(analysisRequest)
    ? inspectInstalledPackageProgram(analysisRequest)
    : inspectInstalledPackageDiscovery(analysisRequest);
}

function inspectInstalledPackageProgram(analysisRequest: AnalysisRequest): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = readInspectableModuleEvidence(request, evidenceInspection(analysisRequest));
  if (evidence === undefined) {
    return {
      status: "not-found",
      message: `Specifier "${request.specifier}" is not installed from this Resolution Context.`,
    };
  }
  const constructionContext = createInspectionResultConstructionContext({
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity: evidence.resultIdentity,
  });

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
      result: constructInspectionPlan(constructionContext, inspections),
    };
  }

  const inspection = inspectEvidenceQuery(
    evidence,
    inspectionQuery(analysisRequest),
    constructionContext,
  );
  return "status" in inspection ? inspection : { status: "success", result: inspection };
}

function inspectionQuery(analysisRequest: AnalysisRequest): InspectionPlanQuery {
  switch (analysisRequest.intent) {
    case "interface-overview":
      return { intent: analysisRequest.intent };
    case "export-inspection":
    case "signature-inspection":
      return { intent: analysisRequest.intent, exportName: analysisRequest.request.exportName };
    case "export-search":
      return { intent: analysisRequest.intent, query: analysisRequest.request.query };
    case "public-subpath-discovery":
    case "inspection-plan":
      throw new UnsupportedInspectionError(
        "Inspection request requires a different evidence path.",
      );
  }
}

function inspectInstalledPackageDiscovery(analysisRequest: AnalysisRequest): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = readInspectableModuleDiscoveryEvidence(request);
  if (evidence === undefined) {
    return missingSpecifierOutcome(request.specifier);
  }
  const context = inspectionConstructionContext(request, evidence.resultIdentity);
  const publicSubpaths = evidence.publicSubpaths;
  if (analysisRequest.intent === "public-subpath-discovery") {
    return {
      status: "success",
      result: constructPublicSubpathDiscovery(context, publicSubpaths),
    };
  }
  if (analysisRequest.intent !== "inspection-plan") {
    throw new UnsupportedInspectionError("Inspection requires TypeScript program evidence.");
  }
  const inspections = analysisRequest.request.queries.map(() =>
    constructPublicSubpathDiscovery(context, publicSubpaths),
  );
  return {
    status: "success",
    result: constructInspectionPlan(context, inspections),
  };
}

function analysisRequiresProgram(analysisRequest: AnalysisRequest): boolean {
  if (analysisRequest.intent === "public-subpath-discovery") {
    return false;
  }
  return (
    analysisRequest.intent !== "inspection-plan" ||
    analysisRequest.request.queries.some((query) => query.intent !== "public-subpath-discovery")
  );
}

function inspectionConstructionContext(
  request: AnalysisRequest["request"],
  identity: InspectableModuleDiscoveryEvidence["resultIdentity"],
): InspectionResultConstructionContext {
  return createInspectionResultConstructionContext({
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity,
  });
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

  if (query.intent === "export-search") {
    const search = searchModuleExports(evidence, query.query);
    return constructExportSearch(
      constructionContext,
      query.query,
      search.totalModuleExports,
      search.matches,
    );
  }

  if (query.intent === "public-subpath-discovery") {
    return constructPublicSubpathDiscovery(constructionContext, evidence.publicSubpaths);
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
    case "export-search":
      return { intent: analysisRequest.intent };
    case "public-subpath-discovery":
      throw new UnsupportedInspectionError(
        "Public Subpath Discovery does not materialize a TypeScript program.",
      );
    case "inspection-plan":
      return { intent: analysisRequest.intent, queries: analysisRequest.request.queries };
  }
}

function missingSpecifierOutcome(specifier: string): InspectionFailure {
  return {
    status: "not-found",
    message: `Specifier "${specifier}" is not installed from this Resolution Context.`,
  };
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

function searchModuleExports(
  { checker, moduleSymbol }: InspectableModuleEvidence,
  query: string,
): {
  readonly totalModuleExports: number;
  readonly matches: readonly { readonly name: string }[];
} {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  if (exportedSymbols.length > MAX_EXPORT_SEARCH_CANDIDATES) {
    throw new InspectionLimitError("Inspection exceeded its Module Export search limit.");
  }
  const normalizedQuery = query.toLowerCase();
  const matches = exportedSymbols
    .map((symbol) => ({ name: symbol.getName() }))
    .filter(({ name }) => name.toLowerCase().includes(normalizedQuery))
    .sort(compareModuleExports);
  if (matches.length > MAX_EXPORT_SEARCH_MATCHES) {
    throw new InspectionLimitError("Inspection exceeded its Module Export search match limit.");
  }
  return { totalModuleExports: exportedSymbols.length, matches };
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
