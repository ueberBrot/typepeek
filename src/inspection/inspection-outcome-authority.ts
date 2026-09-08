import { Predicate, Result, Schema } from "effect";

import { MAX_MEMBER_CANDIDATES, MAX_MEMBER_MATCHES } from "#typepeek/inspection/budget-policy";
import { inspectionPlanQueriesForRequest } from "#typepeek/inspection/inspection-plan-query";
import {
  memberDeclarationSpaceSchema,
  memberPathsEqual,
  readBoundedMemberPath,
} from "#typepeek/inspection/member-path";
import type { PackageIdentity } from "#typepeek/inspection/package-identity";
import {
  type AnalysisRequest,
  type AtomicInspectionResult,
  type DeclarationInspection,
  type ExportInspection,
  type ExportSearch,
  type InspectionFailure,
  type InspectionOutcome,
  inspectionOutcomeSchema,
  type InspectionPlan,
  type InspectionPlanQuery,
  type InspectionResult,
  type InspectionResultByIntent,
  type InterfaceOverview,
  type MemberInspection,
  type MemberDiscovery,
  type NormalizedInspectionPlanRequest,
  type NormalizedInspectionTarget,
  type PublicInterfaceComparison,
  type PublicSubpathDiscovery,
  type SignatureInspection,
} from "#typepeek/inspection/protocol";
import {
  readOwnDataProperty,
  snapshotBoundedDataPropertyGraph,
} from "#typepeek/inspection/untrusted-data";

const MAX_PROTOCOL_GRAPH_OBJECTS = 4_096;
const MAX_PROTOCOL_GRAPH_VALUES = 16_384;
const STRICT_PROTOCOL_PARSE_OPTIONS = { onExcessProperty: "error" } as const;
const decodeInspectionOutcome = Schema.decodeUnknownResult(
  inspectionOutcomeSchema,
  STRICT_PROTOCOL_PARSE_OPTIONS,
);

const INVALID_RESULT_OUTCOME: InspectionFailure = {
  status: "unsupported",
  reason: "invalid-result",
  message: "Inspection returned an invalid result.",
};

/**
 * Accepts only a bounded, dense, data-property-only outcome for the requested
 * intent. Invalid process messages collapse to a generic failure rather than
 * exposing analyzer or transport details.
 */
export function enforceInspectionOutcome(
  intent: "interface-overview",
  value: unknown,
): InspectionOutcome<InterfaceOverview>;
export function enforceInspectionOutcome(
  intent: "export-inspection",
  value: unknown,
): InspectionOutcome<ExportInspection>;
export function enforceInspectionOutcome(
  intent: "signature-inspection",
  value: unknown,
): InspectionOutcome<SignatureInspection>;
export function enforceInspectionOutcome(
  intent: "inspection-plan",
  value: unknown,
): InspectionOutcome<InspectionPlan>;
export function enforceInspectionOutcome(
  intent: "export-search",
  value: unknown,
): InspectionOutcome<ExportSearch>;
export function enforceInspectionOutcome(
  intent: "public-subpath-discovery",
  value: unknown,
): InspectionOutcome<PublicSubpathDiscovery>;
export function enforceInspectionOutcome(
  intent: "declaration-inspection",
  value: unknown,
): InspectionOutcome<DeclarationInspection>;
export function enforceInspectionOutcome(
  intent: "member-discovery",
  value: unknown,
): InspectionOutcome<MemberDiscovery>;
export function enforceInspectionOutcome(
  intent: "member-inspection",
  value: unknown,
): InspectionOutcome<MemberInspection>;
export function enforceInspectionOutcome(
  intent: "public-interface-comparison",
  value: unknown,
): InspectionOutcome<PublicInterfaceComparison>;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
): InspectionOutcome;
export function enforceInspectionOutcome(
  intent: InspectionResult["intent"],
  value: unknown,
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

/** Requires a complete outcome correlated with every selector in the normalized request. */
export function enforceAnalysisRequestOutcome<Request extends AnalysisRequest>(
  request: Request,
  value: unknown,
): InspectionOutcome<InspectionResultByIntent[Request["intent"]]>;
export function enforceAnalysisRequestOutcome(
  request: AnalysisRequest,
  value: unknown,
): InspectionOutcome {
  if (request.intent === "inspection-plan") {
    return enforceInspectionPlanOutcome(request.request, value);
  }
  const outcome = enforceInspectionOutcome(request.intent, value);
  return outcome.status !== "success" || atomicResultMatchesRequest(outcome.result, request)
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

function atomicResultMatchesRequest(
  result: InspectionResult,
  request: Exclude<AnalysisRequest, { readonly intent: "inspection-plan" }>,
): boolean {
  const query = inspectionPlanQueriesForRequest(request)[0];
  return (
    query !== undefined &&
    result.intent !== "inspection-plan" &&
    result.intent !== "public-interface-comparison" &&
    inspectionMatchesTarget(result, request.request) &&
    inspectionMatchesPlanQuery(result, query)
  );
}

/** Requires one complete result matching each ordered plan query exactly once. */
function enforceInspectionPlanOutcome(
  request: NormalizedInspectionPlanRequest,
  value: unknown,
): InspectionOutcome<InspectionPlan> {
  const outcome = enforceInspectionOutcome("inspection-plan", value);
  if (outcome.status !== "success") {
    return outcome;
  }
  const sharedIdentity = outcome.result.inspections[0];
  return sharedIdentity !== undefined &&
    outcome.result.inspections.length === request.queries.length &&
    outcome.result.inspections.every(
      (inspection, index) =>
        inspectionMatchesTarget(inspection, request) &&
        inspectionMatchesIdentity(inspection, sharedIdentity) &&
        inspectionMatchesPlanQuery(inspection, request.queries[index]),
    )
    ? outcome
    : INVALID_RESULT_OUTCOME;
}

function inspectionMatchesTarget(
  inspection: AtomicInspectionResult,
  target: NormalizedInspectionTarget,
): boolean {
  return (
    inspection.specifier === target.specifier &&
    inspection.resolutionVariant.accessStyle === target.accessStyle
  );
}

function inspectionMatchesIdentity(
  inspection: AtomicInspectionResult,
  expected: AtomicInspectionResult,
): boolean {
  return (
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "packageIdentity"),
      readOwnOptionalProperty(expected, "packageIdentity"),
    ) &&
    packageIdentitiesEqual(
      readOwnOptionalProperty(inspection, "declarationProvider"),
      readOwnOptionalProperty(expected, "declarationProvider"),
    )
  );
}

function packageIdentitiesEqual(
  left: PackageIdentity | undefined,
  right: PackageIdentity | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.name === right.name &&
      readOwnOptionalProperty(left, "version") === readOwnOptionalProperty(right, "version"))
  );
}

function readOwnOptionalProperty<Value extends object, Key extends keyof Value & string>(
  value: Value,
  key: Key,
): Value[Key] | undefined {
  const entry = readOwnDataProperty(value, key);
  return entry?.[1] as Value[Key] | undefined;
}

function inspectionMatchesPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery | undefined,
): boolean {
  if (query === undefined || inspection.intent !== query.intent) {
    return false;
  }
  return INSPECTION_PLAN_QUERY_MATCHERS[query.intent](inspection, query);
}

type InspectionPlanQueryMatcher = (
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
) => boolean;

const INSPECTION_PLAN_QUERY_MATCHERS = {
  "interface-overview": () => true,
  "public-subpath-discovery": () => true,
  "export-search": (inspection, query) =>
    inspection.intent === "export-search" &&
    query.intent === "export-search" &&
    inspection.query === query.query,
  "export-inspection": matchesFocusedPlanQuery,
  "signature-inspection": matchesFocusedPlanQuery,
  "declaration-inspection": matchesFocusedPlanQuery,
  "member-inspection": matchesMemberPlanQuery,
  "member-discovery": (inspection, query) =>
    inspection.intent === "member-discovery" &&
    query.intent === "member-discovery" &&
    inspection.moduleExportName === query.exportName &&
    memberPathsEqual(inspection.memberPath, query.memberPath) &&
    inspection.query === query.query &&
    isAuthoritativeMemberDiscovery(inspection),
} as const satisfies Readonly<Record<InspectionPlanQuery["intent"], InspectionPlanQueryMatcher>>;

function matchesFocusedPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
): boolean {
  return (
    (inspection.intent === "export-inspection" ||
      inspection.intent === "signature-inspection" ||
      inspection.intent === "declaration-inspection") &&
    (query.intent === "export-inspection" ||
      query.intent === "signature-inspection" ||
      query.intent === "declaration-inspection") &&
    inspection.moduleExport.name === query.exportName
  );
}

function matchesMemberPlanQuery(
  inspection: AtomicInspectionResult,
  query: InspectionPlanQuery,
): boolean {
  return (
    inspection.intent === "member-inspection" &&
    query.intent === "member-inspection" &&
    inspection.moduleExportName === query.exportName &&
    memberPathsEqual(inspection.memberPath, query.memberPath) &&
    isAuthoritativeMemberInspection(inspection)
  );
}

function isAuthoritativeMemberInspection(inspection: MemberInspection): boolean {
  return (
    readBoundedMemberPath(inspection.memberPath) !== undefined && inspection.declarations.length > 0
  );
}

function isAuthoritativeMemberDiscovery(inspection: MemberDiscovery): boolean {
  return (
    inspection.totalMembers <= MAX_MEMBER_CANDIDATES &&
    inspection.members.length <= MAX_MEMBER_MATCHES &&
    inspection.members.length <= inspection.totalMembers &&
    (inspection.query !== undefined || inspection.members.length === inspection.totalMembers) &&
    inspection.members.every(
      (member, index) =>
        (index === 0 || (inspection.members[index - 1]?.name ?? "") < member.name) &&
        (inspection.query === undefined ||
          member.name.toLowerCase().includes(inspection.query.toLowerCase())) &&
        member.spaces.every(
          (space, index) =>
            index === 0 ||
            memberDeclarationSpaceSchema.literals.indexOf(member.spaces[index - 1] ?? space) <
              memberDeclarationSpaceSchema.literals.indexOf(space),
        ),
    )
  );
}

function readInspectionOutcome(value: unknown): InspectionOutcome | undefined {
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
}

function hasBoundedNamespaceGraph(value: unknown): boolean {
  // Namespace members are the protocol's recursive shape. Keep this transport
  // guard aligned with the analyzer depth budget and reject object cycles.
  if (!Predicate.isReadonlyObject(value) || value["status"] !== "success") {
    return true;
  }
  const result = value["result"];
  if (!Predicate.isReadonlyObject(result)) {
    return true;
  }
  const inspections =
    result["intent"] === "inspection-plan" && Array.isArray(result["inspections"])
      ? result["inspections"]
      : [result];
  return everyArrayItem(inspections, hasBoundedInspectionNamespaceGraph);
}

function hasBoundedInspectionNamespaceGraph(result: unknown): boolean {
  if (!Predicate.isReadonlyObject(result) || result["intent"] !== "export-inspection") {
    return true;
  }
  const moduleExport = result["moduleExport"];
  if (!Predicate.isReadonlyObject(moduleExport) || !Array.isArray(moduleExport["spaces"])) {
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
      hasBoundedNamespaceMember(member, new Set(), 0),
    );
  });
}

function hasBoundedNamespaceMember(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 8 || (Predicate.isReadonlyObject(value) && ancestors.has(value))) {
    return false;
  }
  if (!Predicate.isReadonlyObject(value) || !Array.isArray(value["members"])) {
    return true;
  }

  ancestors.add(value);
  const valid = everyArrayItem(value["members"], (member) =>
    hasBoundedNamespaceMember(member, ancestors, depth + 1),
  );
  ancestors.delete(value);
  return valid;
}

function everyArrayItem(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean,
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!predicate(values[index])) {
      return false;
    }
  }
  return true;
}
