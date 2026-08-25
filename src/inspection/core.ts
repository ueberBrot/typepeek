import { Effect } from "effect";

import { runBoundedAnalysis } from "#typepeek/inspection/analysis-process";
import {
  enforceInspectionOutcome,
  type AnalysisRequest,
  type DeclarationInspection,
  type DeclarationInspectionRequest,
  type ExportInspection,
  type ExportInspectionRequest,
  type ExportSearch,
  type ExportSearchRequest,
  type InspectionFailure,
  type InspectionOutcome,
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
import { readInspectionRequest } from "#typepeek/inspection/request-definitions";

export type PreparedInspectionCoreRequest =
  | AnalysisRequest
  | {
      readonly intent: "public-interface-comparison";
      readonly request: NormalizedPublicInterfaceComparisonRequest;
    };

export interface InspectionCoreInvocationReceipt {
  readonly outcome: InspectionOutcome;
  readonly preparedRequest?: PreparedInspectionCoreRequest;
}

type InspectionCorePreparation =
  | { readonly accepted: true; readonly preparedRequest: PreparedInspectionCoreRequest }
  | { readonly accepted: false; readonly outcome: InspectionFailure };

/** Validates once, dispatches, and retains the trusted normalized request for adapters. */
export async function invokeInspectionCoreWithReceipt(
  intent: InspectionIntent,
  request: unknown,
): Promise<InspectionCoreInvocationReceipt> {
  const preparation = prepareInspectionCoreRequest(intent, request);
  if (!preparation.accepted) {
    return { outcome: preparation.outcome };
  }
  return {
    preparedRequest: preparation.preparedRequest,
    outcome: await Effect.runPromise(invokePreparedInspectionCore(preparation.preparedRequest)),
  };
}

/** Owns request validation and dispatch for every transport-neutral Inspection Core intent. */
async function invokeInspectionCore(
  intent: InspectionIntent,
  request: unknown,
): Promise<InspectionOutcome> {
  return (await invokeInspectionCoreWithReceipt(intent, request)).outcome;
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

function prepareInspectionCoreRequest(
  intent: InspectionIntent,
  request: unknown,
): InspectionCorePreparation {
  if (intent === "public-interface-comparison") {
    const reading = readInspectionRequest(intent, request);
    return reading.accepted
      ? { accepted: true, preparedRequest: { intent, request: reading.request } }
      : reading;
  }
  const reading = readInspectionRequest(intent, request);
  return reading.accepted
    ? {
        accepted: true,
        preparedRequest: { intent, request: reading.request } as AnalysisRequest,
      }
    : reading;
}

const invokePreparedInspectionCore = Effect.fn("invokePreparedInspectionCore")(function* (
  prepared: PreparedInspectionCoreRequest,
) {
  return yield* prepared.intent === "public-interface-comparison"
    ? executePublicInterfaceComparison(prepared.request)
    : executeAnalysis(prepared);
});

const executePublicInterfaceComparison = Effect.fn("executePublicInterfaceComparison")(function* (
  request: NormalizedPublicInterfaceComparisonRequest,
) {
  const [beforeValue, afterValue] = yield* Effect.all(
    [
      executeAnalysis({ intent: "interface-overview", request: request.before }),
      executeAnalysis({ intent: "interface-overview", request: request.after }),
    ],
    { concurrency: 2 },
  );
  const before = enforceInspectionOutcome("interface-overview", beforeValue);
  const after = enforceInspectionOutcome("interface-overview", afterValue);
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

const executeAnalysis = Effect.fn("executeAnalysis")((request: AnalysisRequest) =>
  Effect.promise(() => runBoundedAnalysis(request)),
);

interface InspectionResultByIntent {
  readonly "interface-overview": InterfaceOverview;
  readonly "export-inspection": ExportInspection;
  readonly "signature-inspection": SignatureInspection;
  readonly "export-search": ExportSearch;
  readonly "public-subpath-discovery": PublicSubpathDiscovery;
  readonly "declaration-inspection": DeclarationInspection;
  readonly "member-inspection": MemberInspection;
  readonly "inspection-plan": InspectionPlan;
  readonly "public-interface-comparison": PublicInterfaceComparison;
}

async function invokeTypedInspection<Intent extends InspectionIntent>(
  intent: Intent,
  request: unknown,
): Promise<InspectionOutcome<InspectionResultByIntent[Intent]>> {
  return invokeInspectionCore(intent, request) as Promise<
    InspectionOutcome<InspectionResultByIntent[Intent]>
  >;
}
