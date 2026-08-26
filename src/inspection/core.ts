import { Effect } from "effect";

import { runBoundedAnalysis } from "#typepeek/inspection/analysis-process";
import { enforceInspectionOutcome } from "#typepeek/inspection/inspection-outcome-authority";
import {
  type DeclarationInspection,
  type DeclarationInspectionRequest,
  type ExportInspection,
  type ExportInspectionRequest,
  type ExportSearch,
  type ExportSearchRequest,
  type InspectionFailure,
  type InspectionOutcome,
  type InspectionRequestByIntent,
  type InspectionResultByIntent,
  type InspectionPlan,
  type InspectionPlanRequest,
  type InterfaceOverview,
  type InterfaceOverviewRequest,
  type MemberInspection,
  type MemberInspectionRequest,
  type NormalizedPublicInterfaceComparisonRequest,
  type PublicInterfaceComparison,
  type PublicInterfaceComparisonRequest,
  type PublicSubpathDiscovery,
  type PublicSubpathDiscoveryRequest,
  type SignatureInspection,
  type SignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import type { InspectionIntent } from "#typepeek/inspection/protocol-vocabulary";
import { compareInterfaceOverviews } from "#typepeek/inspection/public-interface-comparison";
import {
  type PreparedInspectionCoreRequest,
  readInspectionCoreRequest,
} from "#typepeek/inspection/request-definitions";

export type InspectionCoreInvocationReceipt<Intent extends InspectionIntent = InspectionIntent> =
  | {
      readonly outcome: InspectionFailure;
      readonly preparedRequest?: never;
    }
  | {
      readonly outcome: InspectionOutcome<InspectionResultByIntent[Intent]>;
      readonly preparedRequest: Extract<PreparedInspectionCoreRequest, { readonly intent: Intent }>;
    };

/** Lazily validates one request and retains the trusted normalization for adapters. */
const invokeInspectionCoreEffect = Effect.fn("invokeInspectionCore")(function* (
  intent: InspectionIntent,
  request: unknown,
): Effect.fn.Return<InspectionCoreInvocationReceipt> {
  const reading = readInspectionCoreRequest(intent, request);
  if (!reading.accepted) {
    return { outcome: reading.outcome };
  }
  return {
    preparedRequest: reading.preparedRequest,
    outcome: yield* invokePreparedInspectionCore(reading.preparedRequest),
  };
});

export function invokeInspectionCore<Intent extends InspectionIntent>(
  intent: Intent,
  request: unknown,
): Effect.Effect<InspectionCoreInvocationReceipt<Intent>>;
export function invokeInspectionCore(
  intent: InspectionIntent,
  request: unknown,
): Effect.Effect<InspectionCoreInvocationReceipt> {
  return invokeInspectionCoreEffect(intent, request);
}

/** Compares complete Interface Overview indexes without merging Resolution Variants. */
export function comparePublicInterfaces(
  request: PublicInterfaceComparisonRequest,
): Promise<InspectionOutcome<PublicInterfaceComparison>> {
  return invokeTypedInspection("public-interface-comparison", request);
}

/** Searches the bounded Module Export index without returning Public Subpaths. */
export function inspectExportSearch(
  request: ExportSearchRequest,
): Promise<InspectionOutcome<ExportSearch>> {
  return invokeTypedInspection("export-search", request);
}

/** Discovers manifest Public Subpaths without materializing a TypeScript program. */
export function inspectPublicSubpaths(
  request: PublicSubpathDiscoveryRequest,
): Promise<InspectionOutcome<PublicSubpathDiscovery>> {
  return invokeTypedInspection("public-subpath-discovery", request);
}

/** Executes a bounded all-or-nothing query list over one evidence snapshot. */
export function inspectPlan(
  request: InspectionPlanRequest,
): Promise<InspectionOutcome<InspectionPlan>> {
  return invokeTypedInspection("inspection-plan", request);
}

/** Produces a bounded Module Export and Public Subpath index. */
export function inspectInterfaceOverview(
  request: InterfaceOverviewRequest,
): Promise<InspectionOutcome<InterfaceOverview>> {
  return invokeTypedInspection("interface-overview", request);
}

/** Produces a bounded Export Inspection with reachable Supporting Types. */
export function inspectExport(
  request: ExportInspectionRequest,
): Promise<InspectionOutcome<ExportInspection>> {
  return invokeTypedInspection("export-inspection", request);
}

/** Returns only public call and construct signatures without Supporting Type traversal. */
export function inspectExportSignatures(
  request: SignatureInspectionRequest,
): Promise<InspectionOutcome<SignatureInspection>> {
  return invokeTypedInspection("signature-inspection", request);
}

/** Returns one Module Export's declarations without signatures or Supporting Types. */
export function inspectExportDeclarations(
  request: DeclarationInspectionRequest,
): Promise<InspectionOutcome<DeclarationInspection>> {
  return invokeTypedInspection("declaration-inspection", request);
}

/** Returns exactly one public member path without unrelated declaration traversal. */
export function inspectExportMember(
  request: MemberInspectionRequest,
): Promise<InspectionOutcome<MemberInspection>> {
  return invokeTypedInspection("member-inspection", request);
}

const invokePreparedInspectionCore = Effect.fn("invokePreparedInspectionCore")(function* (
  prepared: PreparedInspectionCoreRequest,
) {
  return yield* prepared.intent === "public-interface-comparison"
    ? executePublicInterfaceComparison(prepared.request)
    : runBoundedAnalysis(prepared);
});

const executePublicInterfaceComparison = Effect.fn("executePublicInterfaceComparison")(function* (
  request: NormalizedPublicInterfaceComparisonRequest,
) {
  const [before, after] = yield* Effect.all(
    [
      runBoundedAnalysis({ intent: "interface-overview", request: request.before }),
      runBoundedAnalysis({ intent: "interface-overview", request: request.after }),
    ],
    { concurrency: 2 },
  );
  if (before.status !== "success") {
    return before;
  }
  return after.status === "success"
    ? enforceInspectionOutcome(
        "public-interface-comparison",
        compareInterfaceOverviews(before.result, after.result),
      )
    : after;
});

function invokeTypedInspection<Intent extends InspectionIntent>(
  intent: Intent,
  request: InspectionRequestByIntent[Intent],
): Promise<InspectionOutcome<InspectionResultByIntent[Intent]>> {
  return Effect.runPromise(invokeInspectionCore(intent, request)).then(({ outcome }) => outcome);
}
