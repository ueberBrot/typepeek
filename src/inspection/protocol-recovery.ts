import { isBoundedExportSearchQuery } from "#typepeek/inspection/inspection-plan-query";
import {
  PROTOCOL_RECOVERY_POLICY,
  SUPPORTING_TYPE_RECOVERY_BUDGETS,
  type ProtocolRecoveryGuidance,
} from "#typepeek/inspection/inspection-protocol-schema";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import { INSPECTION_PROTOCOL_VERSION } from "#typepeek/inspection/protocol-vocabulary";
import type { PreparedInspectionCoreRequest } from "#typepeek/inspection/request-definitions";

const SUPPORTING_TYPE_BUDGETS = new Set<string>(SUPPORTING_TYPE_RECOVERY_BUDGETS);

/** Derives only complete executable requests from one trusted normalized request. */
export function protocolRecoveryGuidance(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome,
): readonly ProtocolRecoveryGuidance[] {
  const candidates = recoveryCandidates(prepared, outcome);
  return candidates.length <= PROTOCOL_RECOVERY_POLICY.maximumEntries && hasBoundedBytes(candidates)
    ? candidates
    : [];
}

function hasBoundedBytes(guidance: readonly ProtocolRecoveryGuidance[]): boolean {
  return Buffer.byteLength(JSON.stringify(guidance)) <= PROTOCOL_RECOVERY_POLICY.maximumBytes;
}

function recoveryCandidates(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome,
): readonly ProtocolRecoveryGuidance[] {
  if (
    prepared.intent === "export-inspection" &&
    outcome.status === "limit-exceeded" &&
    SUPPORTING_TYPE_BUDGETS.has(outcome.exceededBudget)
  ) {
    const request = prepared.request;
    return [
      {
        reason: "inspect-declarations-without-supporting-types",
        request: {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          intent: "declaration-inspection",
          request,
        },
      },
      {
        reason: "inspect-signatures-without-supporting-types",
        request: {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          intent: "signature-inspection",
          request,
          response: { signatureEvidence: "structured" },
        },
      },
    ];
  }
  if (outcome.status !== "not-found" || outcome.reason !== "export-not-found") {
    return [];
  }
  const focusedRequest = focusedExportRequest(prepared);
  return focusedRequest === undefined || !isBoundedExportSearchQuery(focusedRequest.exportName)
    ? []
    : [
        {
          reason: "search-related-export-names",
          request: {
            protocolVersion: INSPECTION_PROTOCOL_VERSION,
            intent: "export-search",
            request: {
              resolutionContext: focusedRequest.resolutionContext,
              specifier: focusedRequest.specifier,
              accessStyle: focusedRequest.accessStyle,
              query: focusedRequest.exportName,
            },
          },
        },
      ];
}

function focusedExportRequest(prepared: PreparedInspectionCoreRequest):
  | {
      readonly resolutionContext: string;
      readonly specifier: string;
      readonly accessStyle: "import" | "require";
      readonly exportName: string;
    }
  | undefined {
  switch (prepared.intent) {
    case "export-inspection":
    case "signature-inspection":
    case "declaration-inspection":
    case "member-inspection":
      return prepared.request;
    default:
      return undefined;
  }
}
