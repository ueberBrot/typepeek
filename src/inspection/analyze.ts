import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  createModuleExportInspection,
  type ModuleExportInspection,
} from "#typepeek/inspection/export-inspection";
import {
  createInspectionCacheIdentity,
  createInspectionCacheHitNotice,
  type InspectionCacheHitNotice,
  type InspectionCacheIdentity,
  createInspectionCacheWriteReceipt,
  type InspectionCacheWriteReceipt,
  readInspectionCacheOutcome,
} from "#typepeek/inspection/inspection-cache";
import { inspectionPlanQueriesForRequest } from "#typepeek/inspection/inspection-plan-query";
import {
  type InspectableModuleEvidence,
  type InspectableModuleDiscoveryEvidence,
  type InspectableModuleSelection,
  inspectableModuleDiscoveryEvidence,
  materializeInspectableModuleEvidence,
  selectInspectableModule,
} from "#typepeek/inspection/installed-evidence";
import {
  createInstalledEvidenceFingerprintRecorder,
  type InstalledEvidenceProof,
} from "#typepeek/inspection/installed-evidence-fingerprint";
import { formatMemberPath, type MemberPath } from "#typepeek/inspection/member-path";
import { profileInspectionPhase } from "#typepeek/inspection/performance-profile";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionFailure,
  InspectionOutcome,
  InspectionPlanQuery,
} from "#typepeek/inspection/protocol";
import { InspectionResultConstruction } from "#typepeek/inspection/result-construction";
import { inspectModuleExportSignatures } from "#typepeek/inspection/signature-inspection";

const MAX_MODULE_EXPORTS = 320;
const MAX_EXPORT_SEARCH_CANDIDATES = 4_096;
const MAX_EXPORT_SEARCH_MATCHES = 320;

export interface AnalysisExecution {
  readonly cacheMessage?: InspectionCacheHitNotice | InspectionCacheWriteReceipt;
  readonly outcome: InspectionOutcome;
}

/**
 * Runs one normalized request inside the analysis subprocess, using only a
 * previously validated outcome whose Installed Evidence still matches.
 */
export function analyzeInspection(
  analysisRequest: AnalysisRequest,
  readCache = true,
): AnalysisExecution {
  const recorder = createInstalledEvidenceFingerprintRecorder();
  try {
    const selection = selectInspectableModule(analysisRequest.request, recorder);
    if (selection === undefined) {
      return { outcome: missingSpecifierOutcome(analysisRequest.request.specifier) };
    }
    const identity = createInspectionCacheIdentity(analysisRequest, selection);
    const cached = readCachedAnalysis(identity, recorder.snapshot(), readCache);
    if (cached !== undefined) {
      return cached;
    }
    profileInspectionPhase("inspection-cache-miss", () => undefined);
    const outcome = inspectSelectedPackage(analysisRequest, selection);
    return prepareAnalyzedCacheWrite(identity, recorder.snapshot(), outcome);
  } catch (error) {
    return { outcome: errorOutcome(error) };
  }
}

function readCachedAnalysis(
  identity: InspectionCacheIdentity | undefined,
  proof: InstalledEvidenceProof | undefined,
  readCache: boolean,
): AnalysisExecution | undefined {
  if (!readCache || identity === undefined || proof === undefined) {
    return undefined;
  }
  const cachedOutcome = readInspectionCacheOutcome(identity, proof);
  if (cachedOutcome === undefined) {
    return undefined;
  }
  const outcome = profileInspectionPhase("inspection-cache-hit", () => cachedOutcome);
  const cacheMessage = createInspectionCacheHitNotice(identity);
  return cacheMessage === undefined ? { outcome } : { cacheMessage, outcome };
}

function prepareAnalyzedCacheWrite(
  identity: InspectionCacheIdentity | undefined,
  proof: InstalledEvidenceProof | undefined,
  outcome: InspectionOutcome,
): AnalysisExecution {
  const cacheMessage =
    outcome.status === "success" && identity !== undefined
      ? createInspectionCacheWriteReceipt(identity, proof)
      : undefined;
  return cacheMessage === undefined ? { outcome } : { cacheMessage, outcome };
}

function inspectSelectedPackage(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionOutcome {
  const queries = inspectionPlanQueriesForRequest(analysisRequest);
  return analysisRequiresProgram(queries)
    ? inspectInstalledPackageProgram(analysisRequest, selection, queries)
    : inspectInstalledPackageDiscovery(analysisRequest, selection, queries);
}

function inspectInstalledPackageProgram(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = materializeInspectableModuleEvidence(selection, queries);
  const construction = InspectionResultConstruction.create({
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity: evidence.resultIdentity,
  });

  const context = {
    evidence,
    construction,
    moduleExport: createModuleExportInspection(evidence, construction),
  };

  if (analysisRequest.intent === "inspection-plan") {
    const inspections: AtomicInspectionResult[] = [];
    for (const query of queries) {
      const inspection = inspectEvidenceQuery(context, query);
      if ("status" in inspection) {
        return inspection;
      }
      inspections.push(inspection);
    }
    return {
      status: "success",
      result: construction.plan(inspections),
    };
  }

  const query = queries[0];
  if (query === undefined) {
    throw new UnsupportedInspectionError("Inspection has no query to execute.");
  }
  const inspection = inspectEvidenceQuery(context, query);
  return "status" in inspection ? inspection : { status: "success", result: inspection };
}

function inspectInstalledPackageDiscovery(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
): InspectionOutcome {
  const { request } = analysisRequest;
  const evidence = inspectableModuleDiscoveryEvidence(selection);
  const construction = inspectionResultConstruction(request, evidence.resultIdentity);
  const publicSubpaths = evidence.publicSubpaths;
  if (analysisRequest.intent === "public-subpath-discovery") {
    return {
      status: "success",
      result: construction.publicSubpathDiscovery(publicSubpaths),
    };
  }
  if (analysisRequest.intent !== "inspection-plan") {
    throw new UnsupportedInspectionError("Inspection requires TypeScript program evidence.");
  }
  const inspections = queries.map(() => construction.publicSubpathDiscovery(publicSubpaths));
  return {
    status: "success",
    result: construction.plan(inspections),
  };
}

function analysisRequiresProgram(queries: readonly InspectionPlanQuery[]): boolean {
  return queries.some((query) => query.intent !== "public-subpath-discovery");
}

function inspectionResultConstruction(
  request: AnalysisRequest["request"],
  identity: InspectableModuleDiscoveryEvidence["resultIdentity"],
): InspectionResultConstruction {
  return InspectionResultConstruction.create({
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity,
  });
}

interface EvidenceQueryContext {
  readonly evidence: InspectableModuleEvidence;
  readonly construction: InspectionResultConstruction;
  readonly moduleExport: ModuleExportInspection;
}

function inspectEvidenceQuery(
  context: EvidenceQueryContext,
  query: InspectionPlanQuery,
): AtomicInspectionResult | InspectionFailure {
  const handler = INSPECTION_QUERY_HANDLERS[query.intent] as EvidenceQueryHandler;
  return handler(context, query);
}

type EvidenceQueryResult = AtomicInspectionResult | InspectionFailure;
type EvidenceQueryHandler<Query extends InspectionPlanQuery = InspectionPlanQuery> = (
  context: EvidenceQueryContext,
  query: Query,
) => EvidenceQueryResult;

const INSPECTION_QUERY_HANDLERS = {
  "interface-overview": inspectInterfaceOverviewQuery,
  "export-inspection": inspectExportQuery,
  "signature-inspection": inspectSignatureQuery,
  "declaration-inspection": inspectDeclarationQuery,
  "member-inspection": inspectMemberQuery,
  "member-discovery": inspectMemberDiscoveryQuery,
  "export-search": inspectExportSearchQuery,
  "public-subpath-discovery": inspectPublicSubpathQuery,
} as const satisfies {
  readonly [Intent in InspectionPlanQuery["intent"]]: EvidenceQueryHandler<
    Extract<InspectionPlanQuery, { readonly intent: Intent }>
  >;
};

function inspectInterfaceOverviewQuery(
  { evidence, construction }: EvidenceQueryContext,
  _query: Extract<InspectionPlanQuery, { readonly intent: "interface-overview" }>,
): EvidenceQueryResult {
  return construction.interfaceOverview(evidence.publicSubpaths, inspectModuleExports(evidence));
}

function inspectExportQuery(
  { moduleExport, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "export-inspection" }>,
): EvidenceQueryResult {
  return focusedQueryResult(
    moduleExport.inspectExport(query.exportName),
    query.exportName,
    construction.specifier,
  );
}

function inspectSignatureQuery(
  { evidence, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "signature-inspection" }>,
): EvidenceQueryResult {
  return focusedQueryResult(
    inspectModuleExportSignatures(evidence, query.exportName, construction),
    query.exportName,
    construction.specifier,
  );
}

function inspectDeclarationQuery(
  { moduleExport, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "declaration-inspection" }>,
): EvidenceQueryResult {
  return focusedQueryResult(
    moduleExport.inspectDeclarations(query.exportName),
    query.exportName,
    construction.specifier,
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
  { moduleExport, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "member-inspection" }>,
): EvidenceQueryResult {
  return memberQueryResult(
    moduleExport.inspectMember(query.exportName, query.memberPath),
    query,
    construction.specifier,
  );
}

function inspectMemberDiscoveryQuery(
  { moduleExport, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "member-discovery" }>,
): EvidenceQueryResult {
  return memberQueryResult(
    moduleExport.discoverMembers(query.exportName, query.memberPath, query.query),
    query,
    construction.specifier,
  );
}

function memberQueryResult(
  outcome:
    | ReturnType<ModuleExportInspection["inspectMember"]>
    | ReturnType<ModuleExportInspection["discoverMembers"]>,
  query: { readonly exportName: string; readonly memberPath: MemberPath },
  specifier: string,
): EvidenceQueryResult {
  switch (outcome.status) {
    case "success":
      return outcome.result;
    case "export-not-found":
      return missingExportOutcome(query.exportName, specifier);
    case "ambiguous-member":
      return ambiguousMemberOutcome(query.exportName, query.memberPath);
    case "unsupported-member":
      return unsupportedMemberOutcome(query.exportName, query.memberPath);
    case "member-not-found":
      return missingMemberOutcome(query.exportName, query.memberPath, specifier);
  }
}

function inspectExportSearchQuery(
  { evidence, construction }: EvidenceQueryContext,
  query: Extract<InspectionPlanQuery, { readonly intent: "export-search" }>,
): EvidenceQueryResult {
  const search = searchModuleExports(evidence, query.query);
  return construction.exportSearch(query.query, search.totalModuleExports, search.matches);
}

function inspectPublicSubpathQuery(
  { evidence, construction }: EvidenceQueryContext,
  _query: Extract<InspectionPlanQuery, { readonly intent: "public-subpath-discovery" }>,
): EvidenceQueryResult {
  return construction.publicSubpathDiscovery(evidence.publicSubpaths);
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
  memberPath: MemberPath,
  specifier: string,
): InspectionFailure {
  return {
    status: "not-found",
    reason: "member-not-found",
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" was not found in "${specifier}".`,
  };
}

function ambiguousMemberOutcome(exportName: string, memberPath: MemberPath): InspectionFailure {
  return {
    status: "unsupported",
    reason: "ambiguous-member",
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" is ambiguous across declaration spaces.`,
  };
}

function unsupportedMemberOutcome(exportName: string, memberPath: MemberPath): InspectionFailure {
  return {
    status: "unsupported",
    reason: "no-static-representation",
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" has no declaration-safe static representation.`,
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
