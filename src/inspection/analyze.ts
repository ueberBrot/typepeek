import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  inspectFocusedModuleExport,
  inspectFocusedModuleExportDeclarations,
  inspectFocusedModuleExportMember,
} from "#typepeek/inspection/export-inspection";
import {
  createInspectionCacheIdentity,
  createInspectionCacheHitNotice,
  type InspectionCacheHitNotice,
  createInspectionCacheWriteReceipt,
  type InspectionCacheWriteReceipt,
  readInspectionCacheOutcome,
} from "#typepeek/inspection/inspection-cache";
import {
  type InspectableModuleEvidence,
  type InspectableModuleDiscoveryEvidence,
  type InspectableModuleSelection,
  inspectableModuleDiscoveryEvidence,
  materializeInspectableModuleEvidence,
  selectInspectableModule,
} from "#typepeek/inspection/installed-evidence";
import { createInstalledEvidenceFingerprintRecorder } from "#typepeek/inspection/installed-evidence-fingerprint";
import { profileInspectionPhase } from "#typepeek/inspection/performance-profile";
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

export interface CachedAnalysisExecution {
  readonly cacheHit?: InspectionCacheHitNotice;
  readonly cacheWrite?: InspectionCacheWriteReceipt;
  readonly outcome: InspectionOutcome;
}

/** Uses only a previously validated complete outcome whose Installed Evidence still matches. */
export function analyzeInspectionWithCache(
  analysisRequest: AnalysisRequest,
  readCache = true,
): CachedAnalysisExecution {
  const recorder = createInstalledEvidenceFingerprintRecorder();
  try {
    const selection = selectInspectableModule(analysisRequest.request, recorder);
    if (selection === undefined) {
      return { outcome: missingSpecifierOutcome(analysisRequest.request.specifier) };
    }
    const identity = createInspectionCacheIdentity(analysisRequest, selection);
    const selectionEvidence = recorder.snapshot();
    const cachedOutcome =
      !readCache || selectionEvidence === undefined
        ? undefined
        : readInspectionCacheOutcome(identity, selectionEvidence);
    if (cachedOutcome !== undefined) {
      return {
        cacheHit: createInspectionCacheHitNotice(identity),
        outcome: profileInspectionPhase("inspection-cache-hit", () => cachedOutcome),
      };
    }
    profileInspectionPhase("inspection-cache-miss", () => undefined);
    const outcome = inspectSelectedPackage(analysisRequest, selection);
    const cacheWrite =
      outcome.status === "success"
        ? createInspectionCacheWriteReceipt(identity, recorder.snapshot())
        : undefined;
    return cacheWrite === undefined ? { outcome } : { cacheWrite, outcome };
  } catch (error) {
    return { outcome: errorOutcome(error) };
  }
}

function inspectInstalledPackage(analysisRequest: AnalysisRequest): InspectionOutcome {
  const selection = selectInspectableModule(analysisRequest.request);
  return selection === undefined
    ? missingSpecifierOutcome(analysisRequest.request.specifier)
    : inspectSelectedPackage(analysisRequest, selection);
}

function inspectSelectedPackage(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionOutcome {
  return analysisRequiresProgram(analysisRequest)
    ? inspectInstalledPackageProgram(analysisRequest, selection)
    : inspectInstalledPackageDiscovery(analysisRequest, selection);
}

function inspectInstalledPackageProgram(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = materializeInspectableModuleEvidence(
    selection,
    evidenceInspection(analysisRequest),
  );
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
    case "declaration-inspection":
      return { intent: analysisRequest.intent, exportName: analysisRequest.request.exportName };
    case "member-inspection":
      return {
        intent: analysisRequest.intent,
        exportName: analysisRequest.request.exportName,
        memberPath: analysisRequest.request.memberPath,
      };
    case "export-search":
      return { intent: analysisRequest.intent, query: analysisRequest.request.query };
    case "public-subpath-discovery":
    case "inspection-plan":
      throw new UnsupportedInspectionError(
        "Inspection request requires a different evidence path.",
      );
  }
}

function inspectInstalledPackageDiscovery(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = inspectableModuleDiscoveryEvidence(selection);
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
  const handler = INSPECTION_QUERY_HANDLERS[query.intent] as EvidenceQueryHandler;
  return handler(evidence, query, constructionContext);
}

type EvidenceQueryResult = AtomicInspectionResult | InspectionFailure;
type EvidenceQueryHandler<Query extends InspectionPlanQuery = InspectionPlanQuery> = (
  evidence: InspectableModuleEvidence,
  query: Query,
  context: InspectionResultConstructionContext,
) => EvidenceQueryResult;

const INSPECTION_QUERY_HANDLERS = {
  "interface-overview": inspectInterfaceOverviewQuery,
  "export-inspection": inspectExportQuery,
  "signature-inspection": inspectSignatureQuery,
  "declaration-inspection": inspectDeclarationQuery,
  "member-inspection": inspectMemberQuery,
  "export-search": inspectExportSearchQuery,
  "public-subpath-discovery": inspectPublicSubpathQuery,
} as const satisfies {
  readonly [Intent in InspectionPlanQuery["intent"]]: EvidenceQueryHandler<
    Extract<InspectionPlanQuery, { readonly intent: Intent }>
  >;
};

function inspectInterfaceOverviewQuery(
  evidence: InspectableModuleEvidence,
  _query: Extract<InspectionPlanQuery, { readonly intent: "interface-overview" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  return constructInterfaceOverview(
    context,
    evidence.publicSubpaths,
    inspectModuleExports(evidence),
  );
}

function inspectExportQuery(
  evidence: InspectableModuleEvidence,
  query: Extract<InspectionPlanQuery, { readonly intent: "export-inspection" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  return focusedQueryResult(
    inspectFocusedModuleExport(evidence, query.exportName, context),
    query.exportName,
    context.specifier,
  );
}

function inspectSignatureQuery(
  evidence: InspectableModuleEvidence,
  query: Extract<InspectionPlanQuery, { readonly intent: "signature-inspection" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  return focusedQueryResult(
    inspectModuleExportSignatures(evidence, query.exportName, context),
    query.exportName,
    context.specifier,
  );
}

function inspectDeclarationQuery(
  evidence: InspectableModuleEvidence,
  query: Extract<InspectionPlanQuery, { readonly intent: "declaration-inspection" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  return focusedQueryResult(
    inspectFocusedModuleExportDeclarations(evidence, query.exportName, context),
    query.exportName,
    context.specifier,
  );
}

function focusedQueryResult(
  result: AtomicInspectionResult | undefined,
  exportName: string,
  specifier: string,
): EvidenceQueryResult {
  return result ?? missingExportOutcome(exportName, specifier);
}

function inspectMemberQuery(
  evidence: InspectableModuleEvidence,
  query: Extract<InspectionPlanQuery, { readonly intent: "member-inspection" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  const outcome = inspectFocusedModuleExportMember(
    evidence,
    query.exportName,
    query.memberPath,
    context,
  );
  if (outcome.status === "success") {
    return outcome.result;
  }
  if (outcome.status === "export-not-found") {
    return missingExportOutcome(query.exportName, context.specifier);
  }
  if (outcome.status === "ambiguous-member") {
    return ambiguousMemberOutcome(query.exportName, query.memberPath);
  }
  if (outcome.status === "unsupported-member") {
    return unsupportedMemberOutcome(query.exportName, query.memberPath);
  }
  return missingMemberOutcome(query.exportName, query.memberPath, context.specifier);
}

function inspectExportSearchQuery(
  evidence: InspectableModuleEvidence,
  query: Extract<InspectionPlanQuery, { readonly intent: "export-search" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  const search = searchModuleExports(evidence, query.query);
  return constructExportSearch(context, query.query, search.totalModuleExports, search.matches);
}

function inspectPublicSubpathQuery(
  evidence: InspectableModuleEvidence,
  _query: Extract<InspectionPlanQuery, { readonly intent: "public-subpath-discovery" }>,
  context: InspectionResultConstructionContext,
): EvidenceQueryResult {
  return constructPublicSubpathDiscovery(context, evidence.publicSubpaths);
}

function evidenceInspection(
  analysisRequest: AnalysisRequest,
): Parameters<typeof materializeInspectableModuleEvidence>[1] {
  switch (analysisRequest.intent) {
    case "export-inspection":
    case "signature-inspection":
    case "declaration-inspection":
      return {
        intent: analysisRequest.intent,
        exportName: analysisRequest.request.exportName,
      };
    case "member-inspection":
      return {
        intent: analysisRequest.intent,
        exportName: analysisRequest.request.exportName,
        memberPath: analysisRequest.request.memberPath,
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
    reason: "specifier-not-found",
    message: `Specifier "${specifier}" is not installed from this Resolution Context.`,
  };
}

function missingExportOutcome(exportName: string, specifier: string): InspectionFailure {
  return {
    status: "not-found",
    reason: "export-not-found",
    message: `Module Export "${exportName}" was not found in "${specifier}".`,
  };
}

function missingMemberOutcome(
  exportName: string,
  memberPath: readonly string[],
  specifier: string,
): InspectionFailure {
  return {
    status: "not-found",
    reason: "member-not-found",
    message: `Public Member "${[exportName, ...memberPath].join(".")}" was not found in "${specifier}".`,
  };
}

function ambiguousMemberOutcome(
  exportName: string,
  memberPath: readonly string[],
): InspectionFailure {
  return {
    status: "unsupported",
    reason: "ambiguous-member",
    message: `Public Member "${[exportName, ...memberPath].join(".")}" is ambiguous across declaration spaces.`,
  };
}

function unsupportedMemberOutcome(
  exportName: string,
  memberPath: readonly string[],
): InspectionFailure {
  return {
    status: "unsupported",
    reason: "no-static-representation",
    message: `Public Member "${[exportName, ...memberPath].join(".")}" has no declaration-safe static representation.`,
  };
}

function inspectModuleExports({
  checker,
  moduleSymbol,
}: InspectableModuleEvidence): readonly { readonly name: string }[] {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  if (exportedSymbols.length > MAX_MODULE_EXPORTS) {
    throw new InspectionLimitError(
      "module-exports",
      "Inspection exceeded its Module Export limit.",
    );
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
    throw new InspectionLimitError(
      "export-search-candidates",
      "Inspection exceeded its Module Export search limit.",
    );
  }
  const normalizedQuery = query.toLowerCase();
  const matches = exportedSymbols
    .map((symbol) => ({ name: symbol.getName() }))
    .filter(({ name }) => name.toLowerCase().includes(normalizedQuery))
    .sort(compareModuleExports);
  if (matches.length > MAX_EXPORT_SEARCH_MATCHES) {
    throw new InspectionLimitError(
      "export-search-matches",
      "Inspection exceeded its Module Export search match limit.",
    );
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
    return {
      status: "limit-exceeded",
      reason: "budget-exceeded",
      exceededBudget: error.exceededBudget,
      message: error.message,
    };
  }
  if (error instanceof StaticBoundaryInspectionError) {
    return { status: "static-boundary", reason: "static-boundary", message: error.message };
  }
  // Unexpected errors may contain host paths or analyzer details, neither of
  // which belongs in the transport-neutral Inspection Result.
  return error instanceof UnsupportedInspectionError
    ? { status: "unsupported", reason: "unsupported-evidence", message: error.message }
    : {
        status: "unsupported",
        reason: "unsupported-evidence",
        message: "Installed Evidence could not be inspected statically.",
      };
}
