import { splitCodePoints } from "#typepeek/code-point-ranges";
import { requireDefined } from "#typepeek/defined-value";
import {
  MAX_EXPORT_INDEX_CANDIDATES,
  MAX_EXPORT_SEARCH_MATCHES,
  MAX_MODULE_EXPORTS,
} from "#typepeek/inspection/budget-policy";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/errors";
import type { ModuleExportInspection } from "#typepeek/inspection/export-inspection";
import { createModuleExportInspection } from "#typepeek/inspection/export-inspection";
import { paginateExports } from "#typepeek/inspection/export-pagination";
import { resolveFocusedExportSymbol } from "#typepeek/inspection/focused-export";
import { inspectionPlanQueriesForRequest } from "#typepeek/inspection/inspection-plan-query";
import type {
  InspectableModuleEvidence,
  InspectableModuleSelection,
} from "#typepeek/inspection/installed-evidence";
import { materializeInspectableModuleEvidence } from "#typepeek/inspection/installed-evidence";
import type { MemberPath } from "#typepeek/inspection/member-path";
import { formatMemberPath } from "#typepeek/inspection/member-path";
import { inspectPackageDocumentation } from "#typepeek/inspection/package-documentation";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  ExportSearch,
  InspectionFailure,
  InspectionOutcome,
  InspectionPlanQuery,
} from "#typepeek/inspection/protocol";
import { inspectResolvedExportSignatures } from "#typepeek/inspection/public-signatures";
import { InspectionResultConstruction } from "#typepeek/inspection/result-construction";
import { inspectModuleExportSignatures } from "#typepeek/inspection/signature-inspection";
import { unreachableCase } from "#typepeek/unreachable-case";

interface ModuleExportSearchResult {
  readonly totalModuleExports: number;
  readonly matches: ExportSearch["matches"];
}

const compareModuleExports = function compareModuleExports(
  left: {
    readonly name: string;
  },
  right: {
    readonly name: string;
  }
): number {
  if (left.name < right.name) {
    return -1;
  }

  if (left.name > right.name) {
    return 1;
  }

  return 0;
};

const inspectModuleExports = function inspectModuleExports(
  { checker, moduleSymbol }: InspectableModuleEvidence,
  maximum = MAX_MODULE_EXPORTS
): readonly {
  readonly name: string;
}[] {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);

  if (exportedSymbols.length > maximum) {
    throw new InspectionLimitError(
      "module-exports",
      "Inspection exceeded its Module Export limit."
    );
  }

  return exportedSymbols
    .map((symbol) => ({ name: symbol.name }))
    .toSorted(compareModuleExports);
};

const missingExportOutcome = function missingExportOutcome(
  exportName: string,
  specifier: string
): InspectionFailure {
  return {
    message: `Module Export "${exportName}" was not found in "${specifier}".`,
    reason: "export-not-found",
    status: "not-found",
  };
};

const focusedQueryResult = function focusedQueryResult(
  result: AtomicInspectionResult | undefined,
  exportName: string,
  specifier: string
): EvidenceQueryResult {
  return result ?? missingExportOutcome(exportName, specifier);
};

const ambiguousMemberOutcome = function ambiguousMemberOutcome(
  exportName: string,
  memberPath: MemberPath
): InspectionFailure {
  return {
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" is ambiguous across declaration spaces.`,
    reason: "ambiguous-member",
    status: "unsupported",
  };
};

const unsupportedMemberOutcome = function unsupportedMemberOutcome(
  exportName: string,
  memberPath: MemberPath
): InspectionFailure {
  return {
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" has no declaration-safe static representation.`,
    reason: "no-static-representation",
    status: "unsupported",
  };
};

const missingMemberOutcome = function missingMemberOutcome(
  exportName: string,
  memberPath: MemberPath,
  specifier: string
): InspectionFailure {
  return {
    message: `Public Member "${[exportName, formatMemberPath(memberPath)].join(".")}" was not found in "${specifier}".`,
    reason: "member-not-found",
    status: "not-found",
  };
};

const memberQueryResult = function memberQueryResult(
  outcome:
    | ReturnType<ModuleExportInspection["inspectMember"]>
    | ReturnType<ModuleExportInspection["discoverMembers"]>,
  query: {
    readonly exportName: string;
    readonly memberPath: MemberPath;
  },
  specifier: string
): EvidenceQueryResult {
  switch (outcome.status) {
    case "success": {
      return outcome.result;
    }

    case "export-not-found": {
      return missingExportOutcome(query.exportName, specifier);
    }

    case "ambiguous-member": {
      return ambiguousMemberOutcome(query.exportName, query.memberPath);
    }

    case "unsupported-member": {
      return unsupportedMemberOutcome(query.exportName, query.memberPath);
    }

    case "member-not-found": {
      return missingMemberOutcome(
        query.exportName,
        query.memberPath,
        specifier
      );
    }

    default: {
      return unreachableCase(outcome);
    }
  }
};

const documentationExcerpt = function documentationExcerpt(
  text: string,
  normalizedQuery: string
): string {
  const characters = splitCodePoints(text);
  const matchOffset = text.toLowerCase().indexOf(normalizedQuery);
  let normalizedOffset = 0;
  let matchIndex = 0;

  while (matchIndex < characters.length && normalizedOffset < matchOffset) {
    normalizedOffset += requireDefined(characters[matchIndex]).toLowerCase()
      .length;
    matchIndex += 1;
  }

  return characters
    .slice(
      Math.max(0, matchIndex - 64),
      matchIndex + normalizedQuery.length + 128
    )
    .join("");
};

const searchModuleExports = function searchModuleExports(
  { checker, moduleSymbol }: InspectableModuleEvidence,
  query: string,
  construction: InspectionResultConstruction,
  scope?: ExportSearch["scope"]
): ModuleExportSearchResult {
  const exportedSymbols = checker.getExportsOfModule(moduleSymbol);

  if (exportedSymbols.length > MAX_EXPORT_INDEX_CANDIDATES) {
    throw new InspectionLimitError(
      "export-search-candidates",
      "Inspection exceeded its Module Export search limit."
    );
  }

  const normalizedQuery = query.toLowerCase();
  const matches: ExportSearch["matches"][number][] = [];

  const append = function append(match: ExportSearch["matches"][number]): void {
    if (matches.length >= MAX_EXPORT_SEARCH_MATCHES) {
      throw new InspectionLimitError(
        "export-search-matches",
        "Inspection exceeded its Module Export search match limit."
      );
    }

    matches.push(construction.exportSearchMatch(match));
  };

  for (const symbol of exportedSymbols) {
    const { name } = symbol;

    if (scope === undefined) {
      if (name.toLowerCase().includes(normalizedQuery)) {
        append({ name });
      }
    } else {
      const resolution = resolveFocusedExportSymbol(
        checker,
        symbol,
        moduleSymbol
      );

      const documentation = inspectPackageDocumentation(
        checker,
        symbol,
        resolution.targetSymbol,
        resolution.aliasDeclaration
      );

      if (
        !name.toLowerCase().includes(normalizedQuery) &&
        !(documentation?.text.toLowerCase().includes(normalizedQuery) ?? false)
      ) {
        continue;
      }

      append({
        name,
        signatures: inspectResolvedExportSignatures(
          checker,
          resolution,
          (value) => value
        ),
        ...(documentation !== undefined && {
          packageDocumentation: {
            ...documentation,
            excerpt: true as const,
            text: documentationExcerpt(documentation.text, normalizedQuery),
          },
        }),
      });
    }
  }

  matches.sort(compareModuleExports);

  return { matches, totalModuleExports: exportedSymbols.length };
};

const inspectEvidenceQuery = function inspectEvidenceQuery(
  {
    evidence,
    construction,
    moduleExport,
    paginationScope,
  }: EvidenceQueryContext,
  query: InspectionPlanQuery
): EvidenceQueryResult {
  switch (query.intent) {
    case "interface-overview": {
      if (query.cursor !== undefined) {
        const page = paginateExports(
          inspectModuleExports(evidence, MAX_EXPORT_INDEX_CANDIDATES),
          query.cursor,
          paginationScope
        );

        return page === undefined
          ? {
              message:
                'The export cursor does not match this index. Restart with cursor "start".',
              reason: "invalid-request",
              status: "unsupported",
            }
          : construction.interfaceOverview(
              evidence.publicSubpaths,
              page.moduleExports,
              page.page
            );
      }

      return construction.interfaceOverview(
        evidence.publicSubpaths,
        inspectModuleExports(evidence)
      );
    }

    case "export-inspection": {
      return focusedQueryResult(
        moduleExport.inspectExport(query.exportName),
        query.exportName,
        construction.specifier
      );
    }

    case "signature-inspection": {
      return focusedQueryResult(
        inspectModuleExportSignatures(evidence, query.exportName, construction),
        query.exportName,
        construction.specifier
      );
    }

    case "declaration-inspection": {
      return focusedQueryResult(
        moduleExport.inspectDeclarations(query.exportName),
        query.exportName,
        construction.specifier
      );
    }

    case "member-inspection": {
      return memberQueryResult(
        moduleExport.inspectMember(query.exportName, query.memberPath),
        query,
        construction.specifier
      );
    }

    case "member-discovery": {
      return memberQueryResult(
        moduleExport.discoverMembers(
          query.exportName,
          query.memberPath,
          query.query
        ),
        query,
        construction.specifier
      );
    }

    case "export-search": {
      const search = searchModuleExports(
        evidence,
        query.query,
        construction,
        query.scope
      );

      return construction.exportSearch(
        query.query,
        search.totalModuleExports,
        search.matches,
        query.scope
      );
    }

    case "public-subpath-discovery": {
      return construction.publicSubpathDiscovery(evidence.publicSubpaths);
    }

    default: {
      return unreachableCase(query);
    }
  }
};

const prepareQueryInspection = function prepareQueryInspection(
  selection: InspectableModuleSelection,
  queries: readonly InspectionPlanQuery[],
  construction: InspectionResultConstruction,
  accessStyle: AnalysisRequest["request"]["accessStyle"]
): (query: InspectionPlanQuery) => EvidenceQueryResult {
  if (queries.every((query) => query.intent === "public-subpath-discovery")) {
    const publicSubpaths = selection.readPublicSubpaths();

    return () => construction.publicSubpathDiscovery(publicSubpaths);
  }

  const evidence = materializeInspectableModuleEvidence(selection, queries);

  const context = {
    construction,
    evidence,
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
};

/** Executes ordered queries against one evidence selection and aggregate result budget. */
export const executeInspectionQueries = function executeInspectionQueries(
  analysisRequest: AnalysisRequest,
  selection: InspectableModuleSelection
): InspectionOutcome {
  const { request } = analysisRequest;
  const queries = inspectionPlanQueriesForRequest(analysisRequest);

  const construction = InspectionResultConstruction.create({
    identity: selection.resultIdentity,
    resolutionVariant: { accessStyle: request.accessStyle },
    specifier: request.specifier,
  });

  const inspectQuery = prepareQueryInspection(
    selection,
    queries,
    construction,
    request.accessStyle
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
    return { result: construction.plan(inspections), status: "success" };
  }

  const [result] = inspections;

  if (result === undefined) {
    throw new UnsupportedInspectionError("Inspection has no query to execute.");
  }

  return { result, status: "success" };
};

interface EvidenceQueryContext {
  readonly evidence: InspectableModuleEvidence;
  readonly construction: InspectionResultConstruction;
  readonly moduleExport: ModuleExportInspection;
  readonly paginationScope: string;
}

type EvidenceQueryResult = AtomicInspectionResult | InspectionFailure;
