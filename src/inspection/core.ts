/* oxlint-disable anti-slop/no-unknown-parameters -- Inspection Core is a public validation boundary; request data must be checked before intent-specific dispatch. */
import { Effect } from "effect";

import { runBoundedAnalysis } from "#typepeek/inspection/execution/analysis-process";
import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";
import type {
  DeclarationInspection,
  DeclarationInspectionRequest,
  ExportInspection,
  ExportInspectionRequest,
  ExportSearch,
  ExportSearchRequest,
  InspectionFailure,
  InspectionOutcome,
  InspectionPlan,
  InspectionPlanRequest,
  InspectionRequestByIntent,
  InspectionResultByIntent,
  InterfaceOverview,
  InterfaceOverviewRequest,
  MemberDiscovery,
  MemberDiscoveryRequest,
  MemberInspection,
  MemberInspectionRequest,
  NormalizedPublicInterfaceComparisonRequest,
  PublicInterfaceComparison,
  PublicInterfaceComparisonRequest,
  PublicSubpathDiscovery,
  PublicSubpathDiscoveryRequest,
  SignatureInspection,
  SignatureInspectionRequest,
} from "#typepeek/inspection/model/protocol";
import type { InspectionIntent } from "#typepeek/inspection/model/protocol-vocabulary";
import type { PreparedInspectionCoreRequest } from "#typepeek/inspection/model/request-definitions";
import { readInspectionCoreRequest } from "#typepeek/inspection/model/request-definitions";
import { compareInterfaceOverviews } from "#typepeek/inspection/queries/public-interface-comparison";

const INTERFACE_OVERVIEW = "interface-overview";
const PUBLIC_INTERFACE_COMPARISON = "public-interface-comparison";

export type InspectionCoreInvocationReceipt<
  Intent extends InspectionIntent = InspectionIntent,
> =
  | {
      readonly outcome: InspectionFailure;
      readonly preparedRequest?: never;
    }
  | {
      readonly outcome: InspectionOutcome<InspectionResultByIntent[Intent]>;
      readonly preparedRequest: Extract<
        PreparedInspectionCoreRequest,
        {
          readonly intent: Intent;
        }
      >;
    };

const executePublicInterfaceComparison = Effect.fn(
  "executePublicInterfaceComparison"
)(function* executePublicInterfaceComparison(
  request: NormalizedPublicInterfaceComparisonRequest
) {
  const [before, after] = yield* Effect.all(
    [
      runBoundedAnalysis({
        intent: INTERFACE_OVERVIEW,
        request: request.before,
      }),
      runBoundedAnalysis({
        intent: INTERFACE_OVERVIEW,
        request: request.after,
      }),
    ],
    { concurrency: 2 }
  );

  if (before.status !== "success") {
    return before;
  }

  return after.status === "success"
    ? enforceInspectionOutcome(
        PUBLIC_INTERFACE_COMPARISON,
        compareInterfaceOverviews(before.result, after.result)
      )
    : after;
});

const invokePreparedInspectionCore = Effect.fn("invokePreparedInspectionCore")(
  function* invokePreparedInspectionCore(
    prepared: PreparedInspectionCoreRequest
  ) {
    return yield* prepared.intent === PUBLIC_INTERFACE_COMPARISON
      ? executePublicInterfaceComparison(prepared.request)
      : runBoundedAnalysis(prepared);
  }
);

/** Lazily validates one request and retains the trusted normalization for adapters. */
const invokeInspectionCoreEffect = Effect.fn("invokeInspectionCore")(
  function* invokeInspectionCoreEffect(
    intent: InspectionIntent,
    request: unknown
  ): Effect.fn.Return<InspectionCoreInvocationReceipt> {
    const reading = readInspectionCoreRequest(intent, request);

    if (!reading.accepted) {
      return { outcome: reading.outcome };
    }

    return {
      outcome: yield* invokePreparedInspectionCore(reading.preparedRequest),
      preparedRequest: reading.preparedRequest,
    };
  }
);

// oxlint-disable eslint/func-style -- Function declarations preserve these correlated overload signatures.
export function invokeInspectionCore<Intent extends InspectionIntent>(
  intent: Intent,
  request: unknown
): Effect.Effect<InspectionCoreInvocationReceipt<Intent>>;
export function invokeInspectionCore(
  intent: InspectionIntent,
  request: unknown
): Effect.Effect<InspectionCoreInvocationReceipt> {
  return invokeInspectionCoreEffect(intent, request);
}

// oxlint-enable eslint/func-style
const invokeTypedInspection = async function invokeTypedInspection<
  Intent extends InspectionIntent,
>(
  intent: Intent,
  request: InspectionRequestByIntent[Intent]
): Promise<InspectionOutcome<InspectionResultByIntent[Intent]>> {
  return await Effect.runPromise(invokeInspectionCore(intent, request)).then(
    ({ outcome }) => outcome
  );
};

/** Compares complete Interface Overview indexes without merging Resolution Variants. */
export const comparePublicInterfaces = async function comparePublicInterfaces(
  request: PublicInterfaceComparisonRequest
): Promise<InspectionOutcome<PublicInterfaceComparison>> {
  return await invokeTypedInspection(PUBLIC_INTERFACE_COMPARISON, request);
};

/** Searches the bounded Module Export index without returning Public Subpaths. */
export const inspectExportSearch = async function inspectExportSearch(
  request: ExportSearchRequest
): Promise<InspectionOutcome<ExportSearch>> {
  return await invokeTypedInspection("export-search", request);
};

/** Discovers manifest Public Subpaths without materializing a TypeScript program. */
export const inspectPublicSubpaths = async function inspectPublicSubpaths(
  request: PublicSubpathDiscoveryRequest
): Promise<InspectionOutcome<PublicSubpathDiscovery>> {
  return await invokeTypedInspection("public-subpath-discovery", request);
};

/** Executes a bounded all-or-nothing query list over one evidence snapshot. */
export const inspectPlan = async function inspectPlan(
  request: InspectionPlanRequest
): Promise<InspectionOutcome<InspectionPlan>> {
  return await invokeTypedInspection("inspection-plan", request);
};

/** Produces a bounded Module Export and Public Subpath index. */
export const inspectInterfaceOverview = async function inspectInterfaceOverview(
  request: InterfaceOverviewRequest
): Promise<InspectionOutcome<InterfaceOverview>> {
  return await invokeTypedInspection(INTERFACE_OVERVIEW, request);
};

/** Produces a bounded Export Inspection with reachable Supporting Types. */
export const inspectExport = async function inspectExport(
  request: ExportInspectionRequest
): Promise<InspectionOutcome<ExportInspection>> {
  return await invokeTypedInspection("export-inspection", request);
};

/** Returns only public call and construct signatures without Supporting Type traversal. */
export const inspectExportSignatures = async function inspectExportSignatures(
  request: SignatureInspectionRequest
): Promise<InspectionOutcome<SignatureInspection>> {
  return await invokeTypedInspection("signature-inspection", request);
};

/** Returns one Module Export's declarations without signatures or Supporting Types. */
export const inspectExportDeclarations =
  async function inspectExportDeclarations(
    request: DeclarationInspectionRequest
  ): Promise<InspectionOutcome<DeclarationInspection>> {
    return await invokeTypedInspection("declaration-inspection", request);
  };

/** Returns exactly one public member path without unrelated declaration traversal. */
export const inspectExportMember = async function inspectExportMember(
  request: MemberInspectionRequest
): Promise<InspectionOutcome<MemberInspection>> {
  return await invokeTypedInspection("member-inspection", request);
};

/** Lists immediate public Members without rendering declarations or Supporting Types. */
export const inspectExportMembers = async function inspectExportMembers(
  request: MemberDiscoveryRequest
): Promise<InspectionOutcome<MemberDiscovery>> {
  return await invokeTypedInspection("member-discovery", request);
};
