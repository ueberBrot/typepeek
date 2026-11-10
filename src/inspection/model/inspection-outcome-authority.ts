/* oxlint-disable anti-slop/no-unknown-parameters -- This boundary rejects malformed worker outcomes before correlating their decoded intents, selectors, and identities. */
import { Predicate, Result, Schema } from "effect";

import type { PackageIdentity } from "#typepeek/inspection/evidence/package-identity";
import { MAX_NAMESPACE_DEPTH } from "#typepeek/inspection/model/budget-policy";
import { memberPathsEqual } from "#typepeek/inspection/model/member-path";
import type {
  AnalysisRequest,
  AtomicInspectionResult,
  InspectionFailure,
  InspectionOutcome,
  InspectionPlan,
  InspectionPlanQuery,
  InspectionResult,
  InspectionResultByIntent,
  NormalizedInspectionPlanRequest,
  NormalizedInspectionTarget,
} from "#typepeek/inspection/model/protocol";
import { inspectionOutcomeSchema } from "#typepeek/inspection/model/protocol";
import {
  readOwnOptionalProperty,
  snapshotBoundedDataPropertyGraph,
} from "#typepeek/inspection/model/untrusted-data";
import { inspectionPlanQueriesForRequest } from "#typepeek/inspection/queries/inspection-plan-query";

const EXPORT_INSPECTION = "export-inspection";
const DECLARATION_INSPECTION = "declaration-inspection";
const INSPECTION_PLAN = "inspection-plan";

const MAX_PROTOCOL_GRAPH_OBJECTS = 4096;
const MAX_PROTOCOL_GRAPH_VALUES = 16_384;
const STRICT_PROTOCOL_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

const decodeInspectionOutcome = Schema.decodeUnknownResult(
  inspectionOutcomeSchema,
  STRICT_PROTOCOL_PARSE_OPTIONS
);

const INVALID_RESULT_OUTCOME: InspectionFailure = {
  message: "Inspection returned an invalid result.",
  reason: "invalid-result",
  status: "unsupported",
};

/** Validates an outcome for the requested intent; malformed data returns invalid-result. */
const everyArrayItem = function everyArrayItem(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean
): boolean {
  // Snapshot arrays have no prototype or iterator; read their numeric entries.
  let index = 0;

  while (index < values.length) {
    if (!predicate(values[index])) {
      return false;
    }

    index += 1;
  }

  return true;
};

const hasBoundedNamespaceMember = function hasBoundedNamespaceMember(
  value: unknown,
  ancestors: Set<object>,
  depth: number
): boolean {
  if (
    depth > MAX_NAMESPACE_DEPTH ||
    (Predicate.isReadonlyObject(value) && ancestors.has(value))
  ) {
    return false;
  }

  if (!Predicate.isReadonlyObject(value) || !Array.isArray(value["members"])) {
    return true;
  }

  ancestors.add(value);

  const valid = everyArrayItem(value["members"], (member) =>
    hasBoundedNamespaceMember(member, ancestors, depth + 1)
  );

  ancestors.delete(value);

  return valid;
};

const hasBoundedInspectionNamespaceGraph =
  function hasBoundedInspectionNamespaceGraph(result: unknown): boolean {
    if (
      !Predicate.isReadonlyObject(result) ||
      (result["intent"] !== EXPORT_INSPECTION &&
        result["intent"] !== DECLARATION_INSPECTION)
    ) {
      return true;
    }

    const { moduleExport } = result;

    if (
      !Predicate.isReadonlyObject(moduleExport) ||
      !Array.isArray(moduleExport["spaces"])
    ) {
      return true;
    }

    return everyArrayItem(moduleExport["spaces"], (space) => {
      if (
        !Predicate.isReadonlyObject(space) ||
        space["space"] !== "namespace" ||
        !Array.isArray(space["members"])
      ) {
        return true;
      }

      return everyArrayItem(space["members"], (member) =>
        hasBoundedNamespaceMember(member, new Set(), 0)
      );
    });
  };

const hasBoundedNamespaceGraph = function hasBoundedNamespaceGraph(
  value: unknown
): boolean {
  // Namespace members recurse, so apply the same depth limit as the analyzer.
  if (!Predicate.isReadonlyObject(value) || value["status"] !== "success") {
    return true;
  }

  const { result } = value;

  if (!Predicate.isReadonlyObject(result)) {
    return true;
  }

  const inspections =
    result["intent"] === INSPECTION_PLAN && Array.isArray(result["inspections"])
      ? result["inspections"]
      : [result];

  return everyArrayItem(inspections, hasBoundedInspectionNamespaceGraph);
};

const readInspectionOutcome = function readInspectionOutcome(
  value: unknown
): InspectionOutcome | undefined {
  // Snapshot own data before Schema so cyclic, sparse, accessor-backed,
  // inherited, or excessively deep values cannot make validation unsafe.
  const snapshot = snapshotBoundedDataPropertyGraph(value, {
    maximumObjects: MAX_PROTOCOL_GRAPH_OBJECTS,
    maximumValues: MAX_PROTOCOL_GRAPH_VALUES,
  });

  if (snapshot === undefined || !hasBoundedNamespaceGraph(snapshot)) {
    return undefined;
  }

  return Result.getOrUndefined(decodeInspectionOutcome(snapshot));
};

// oxlint-disable eslint/func-style -- Function declarations preserve these correlated overload signatures.
export function enforceInspectionOutcome<
  Intent extends InspectionResult["intent"],
>(
  intent: Intent,
  value: unknown
): InspectionOutcome<InspectionResultByIntent[Intent]>;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown
): InspectionOutcome {
  try {
    const outcome = readInspectionOutcome(value);

    if (outcome === undefined) {
      return INVALID_RESULT_OUTCOME;
    }

    return outcome.status !== "success" || outcome.result.intent === intent
      ? outcome
      : INVALID_RESULT_OUTCOME;
  } catch {
    return INVALID_RESULT_OUTCOME;
  }
}

// oxlint-enable eslint/func-style
/** Requires a complete outcome correlated with every selector in the normalized request. */
const inspectionMatchesTarget = function inspectionMatchesTarget(
  inspection: AtomicInspectionResult,
  target: NormalizedInspectionTarget
): boolean {
  return (
    inspection.specifier === target.specifier &&
    inspection.resolutionVariant.accessStyle === target.accessStyle
  );
};

const packageIdentitiesEqual = function packageIdentitiesEqual(
  left: PackageIdentity | undefined,
  right: PackageIdentity | undefined
): boolean {
  if (left === right) {
    return true;
  }

  return (
    left !== undefined &&
    right !== undefined &&
    left.name === right.name &&
    readOwnOptionalProperty(left, "version") ===
      readOwnOptionalProperty(right, "version")
  );
};

const inspectionMatchesIdentity = function inspectionMatchesIdentity(
  inspection: AtomicInspectionResult,
  expected: AtomicInspectionResult
): boolean {
  return (
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "packageIdentity"),
      readOwnOptionalProperty(expected, "packageIdentity")
    ) &&
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "declarationProvider"),
      readOwnOptionalProperty(expected, "declarationProvider")
    )
  );
};

const matchesFocusedPlanQuery = function matchesFocusedPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery
): boolean {
  if (
    !(
      inspection.intent === EXPORT_INSPECTION ||
      inspection.intent === "signature-inspection" ||
      inspection.intent === DECLARATION_INSPECTION
    )
  ) {
    return false;
  }

  if (
    !(
      query.intent === EXPORT_INSPECTION ||
      query.intent === "signature-inspection" ||
      query.intent === DECLARATION_INSPECTION
    )
  ) {
    return false;
  }

  return inspection.moduleExport.name === query.exportName;
};

const matchesMemberPlanQuery = function matchesMemberPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery
): boolean {
  return (
    inspection.intent === "member-inspection" &&
    query.intent === "member-inspection" &&
    inspection.moduleExportName === query.exportName &&
    memberPathsEqual(inspection.memberPath, query.memberPath)
  );
};

const INSPECTION_PLAN_QUERY_MATCHERS = {
  "declaration-inspection": matchesFocusedPlanQuery,
  "export-inspection": matchesFocusedPlanQuery,
  "export-search": (inspection, query) =>
    inspection.intent === "export-search" &&
    query.intent === "export-search" &&
    inspection.query === query.query &&
    inspection.scope === query.scope,
  "interface-overview": (inspection, query) =>
    inspection.intent === "interface-overview" &&
    query.intent === "interface-overview" &&
    readOwnOptionalProperty(inspection, "exportPage")?.cursor ===
      readOwnOptionalProperty(query, "cursor"),
  "member-discovery": (inspection, query) => {
    if (inspection.intent !== "member-discovery") {
      return false;
    }

    if (query.intent !== "member-discovery") {
      return false;
    }

    if (inspection.moduleExportName !== query.exportName) {
      return false;
    }

    if (!memberPathsEqual(inspection.memberPath, query.memberPath)) {
      return false;
    }

    return inspection.query === query.query;
  },
  "member-inspection": matchesMemberPlanQuery,
  "public-subpath-discovery": () => true,
  "signature-inspection": matchesFocusedPlanQuery,
} as const satisfies Readonly<
  Record<InspectionPlanQuery["intent"], InspectionPlanQueryMatcher>
>;

const inspectionMatchesPlanQuery = function inspectionMatchesPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery | undefined
): boolean {
  if (query === undefined || inspection.intent !== query.intent) {
    return false;
  }

  return INSPECTION_PLAN_QUERY_MATCHERS[query.intent](inspection, query);
};

/** Requires one complete result matching each ordered plan query exactly once. */
const enforceInspectionPlanOutcome = function enforceInspectionPlanOutcome(
  request: NormalizedInspectionPlanRequest,
  value: unknown
): InspectionOutcome<InspectionPlan> {
  const outcome = enforceInspectionOutcome(INSPECTION_PLAN, value);

  if (outcome.status !== "success") {
    return outcome;
  }

  const [sharedIdentity] = outcome.result.inspections;

  return sharedIdentity !== undefined &&
    outcome.result.inspections.length === request.queries.length &&
    outcome.result.inspections.every(
      (inspection, index) =>
        inspectionMatchesTarget(inspection, request) &&
        inspectionMatchesIdentity(inspection, sharedIdentity) &&
        inspectionMatchesPlanQuery(inspection, request.queries[index])
    )
    ? outcome
    : INVALID_RESULT_OUTCOME;
};

const atomicResultMatchesRequest = function atomicResultMatchesRequest(
  result: InspectionResult,
  request: Exclude<
    AnalysisRequest,
    {
      readonly intent: "inspection-plan";
    }
  >
): boolean {
  const [query] = inspectionPlanQueriesForRequest(request);

  if (query === undefined) {
    return false;
  }

  if (result.intent === INSPECTION_PLAN) {
    return false;
  }

  if (result.intent === "public-interface-comparison") {
    return false;
  }

  if (!inspectionMatchesTarget(result, request.request)) {
    return false;
  }

  return inspectionMatchesPlanQuery(result, query);
};

// oxlint-disable eslint/func-style -- Function declarations preserve these correlated overload signatures.
export function enforceAnalysisRequestOutcome<Request extends AnalysisRequest>(
  request: Request,
  value: unknown
): InspectionOutcome<InspectionResultByIntent[Request["intent"]]>;
export function enforceAnalysisRequestOutcome(
  request: AnalysisRequest,
  value: unknown
): InspectionOutcome {
  if (request.intent === INSPECTION_PLAN) {
    return enforceInspectionPlanOutcome(request.request, value);
  }

  const outcome = enforceInspectionOutcome(request.intent, value);

  return outcome.status !== "success" ||
    atomicResultMatchesRequest(outcome.result, request)
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

// oxlint-enable eslint/func-style
type InspectionPlanQueryMatcher = (
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery
) => boolean;
