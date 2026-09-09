import {
  MAX_MODULE_EXPORTS,
  MAX_EXPORT_INDEX_CANDIDATES,
  MAX_EXPORT_SEARCH_MATCHES,
} from "#typepeek/inspection/budget-policy";
import {
  InspectionLimitError,
  StaticBoundaryInspectionError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import {
  createModuleExportInspection,
  type ModuleExportInspection,
} from "#typepeek/inspection/export-inspection";
import { paginateExports } from "#typepeek/inspection/export-pagination";
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
  type InspectableModuleSelection,
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

export interface AnalysisExecution {
  readonly cacheMessage?: InspectionCacheHitNotice | InspectionCacheWriteReceipt;
  readonly outcome: InspectionOutcome;
}

/** Reuses a validated cache entry when its evidence matches; otherwise inspects the module. */
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
    const outcome = inspectSelectedModule(analysisRequest, selection);
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

function inspectSelectedModule(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection,
): InspectionOutcome {
  const { request } = analysisRequest;
  const queries = inspectionPlanQueriesForRequest(analysisRequest);
  const construction = InspectionResultConstruction.create({
    specifier: request.specifier,
    resolutionVariant: { accessStyle: request.accessStyle },
    identity: selection.resultIdentity,
  });
  const inspectQuery = prepareQueryInspection(
    selection,
    queries,
    construction,
    request.accessStyle,
  );
  const inspections: AtomicInspectionResult[] = [];
  for (const query of queries) {
    const inspection = inspectQuery(query);
    if ("status" in inspection) {
      return inspection;
    }
    inspections.push(inspection);
  }
  if (analysisRequest.intent === "inspection-plan") {
    return { status: "success", result: construction.plan(inspections) };
  }
  const result = inspections[0];
  if (result === undefined) {
    throw new UnsupportedInspectionError("Inspection has no query to execute.");
  }
  return { status: "success", result };
}

function prepareQueryInspection(
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
  construction: InspectionResultConstruction,
  accessStyle: AnalysisRequest["request"]["accessStyle"],
): (query: InspectionPlanQuery) => EvidenceQueryResult {
  if (queries.every((query) => query.intent === "public-subpath-discovery")) {
    const publicSubpaths = selection.readPublicSubpaths();
    return () => construction.publicSubpathDiscovery(publicSubpaths);
  }
  const evidence = materializeInspectableModuleEvidence(selection, queries);
  const context = {
    evidence,
    construction,
    moduleExport: createModuleExportInspection(evidence, construction),
    paginationScope: JSON.stringify([
      selection.resolutionContextDirectory,
      selection.declarationAuthority,
      selection.resultIdentity,
      construction.specifier,
      accessStyle,
    ]),
  };
  return (query) => inspectEvidenceQuery(context, query);
}

interface EvidenceQueryContext {
  readonly evidence: InspectableModuleEvidence;
  readonly construction: InspectionResultConstruction;
  readonly moduleExport: ModuleExportInspection;
  readonly paginationScope: string;
}

type EvidenceQueryResult = AtomicInspectionResult | InspectionFailure;

function inspectEvidenceQuery(
  { evidence, construction, moduleExport, paginationScope }: EvidenceQueryContext,
  query: InspectionPlanQuery,
): EvidenceQueryResult {
  switch (query.intent) {
    case "interface-overview": {
      if (query.cursor !== undefined) {
        const page = paginateExports(
          inspectModuleExports(evidence, MAX_EXPORT_INDEX_CANDIDATES),
          query.cursor,
          paginationScope,
        );
        return page === undefined
          ? {
              status: "unsupported",
              reason: "invalid-request",
              message: 'The export cursor does not match this index. Restart with cursor "start".',
            }
          : construction.interfaceOverview(evidence.publicSubpaths, page.moduleExports, page.page);
      }
      return construction.interfaceOverview(
        evidence.publicSubpaths,
        inspectModuleExports(evidence),
      );
    }
    case "export-inspection":
      return focusedQueryResult(
        moduleExport.inspectExport(query.exportName),
        query.exportName,
        construction.specifier,
      );
    case "signature-inspection":
      return focusedQueryResult(
        inspectModuleExportSignatures(evidence, query.exportName, construction),
        query.exportName,
        construction.specifier,
      );
    case "declaration-inspection":
      return focusedQueryResult(
        moduleExport.inspectDeclarations(query.exportName),
        query.exportName,
        construction.specifier,
      );
    case "member-inspection":
      return memberQueryResult(
        moduleExport.inspectMember(query.exportName, query.memberPath),
        query,
        construction.specifier,
      );
    case "member-discovery":
      return memberQueryResult(
        moduleExport.discoverMembers(query.exportName, query.memberPath, query.query),
        query,
        construction.specifier,
      );
    case "export-search": {
      const search = searchModuleExports(evidence, query.query);
      return construction.exportSearch(query.query, search.totalModuleExports, search.matches);
    }
    case "public-subpath-discovery":
      return construction.publicSubpathDiscovery(evidence.publicSubpaths);
  }
}

function focusedQueryResult(
  result: AtomicInspectionResult | undefined,
  exportName: string,
  specifier: string,
): EvidenceQueryResult {
  return result ?? missingExportOutcome(exportName, specifier);
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

function inspectModuleExports(
  { checker, moduleSymbol }: InspectableModuleEvidence,
  maximum = MAX_MODULE_EXPORTS,
): readonly { readonly name: string }[] {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);
  if (exportedSymbols.length > maximum) {
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
  if (exportedSymbols.length > MAX_EXPORT_INDEX_CANDIDATES) {
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
  // Unexpected errors may expose host paths or analyzer internals; return a generic failure.
  return error instanceof UnsupportedInspectionError
    ? { status: "unsupported", reason: "unsupported-evidence", message: error.message }
    : {
        status: "unsupported",
        reason: "unsupported-evidence",
        message: "Installed Evidence could not be inspected statically.",
      };
}
