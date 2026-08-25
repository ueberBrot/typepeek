import type { PreparedInspectionCoreRequest } from "#typepeek/inspection/core";
import { isBoundedExportSearchQuery } from "#typepeek/inspection/inspection-plan-query";
import type { InspectionOutcome, ProtocolRecoveryGuidance } from "#typepeek/inspection/protocol";
import { INSPECTION_PROTOCOL_VERSION } from "#typepeek/inspection/protocol-vocabulary";

const MAX_PROTOCOL_RECOVERY_ENTRIES = 3;
const MAX_PROTOCOL_RECOVERY_BYTES = 32 * 1_024;
const SUPPORTING_TYPE_BUDGETS = new Set([
  "supporting-type-depth",
  "supporting-types",
  "supporting-type-traversal",
]);

/** Derives only complete executable requests from one trusted normalized request. */
export function protocolRecoveryGuidance(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome,
): readonly ProtocolRecoveryGuidance[] {
  const candidates = recoveryCandidates(prepared, outcome);
  const retained: ProtocolRecoveryGuidance[] = [];
  let bytes = Buffer.byteLength("[]");
  for (const candidate of candidates) {
    const candidateBytes =
      Buffer.byteLength(JSON.stringify(candidate)) + (retained.length === 0 ? 0 : 1);
    if (
      retained.length >= MAX_PROTOCOL_RECOVERY_ENTRIES ||
      bytes + candidateBytes > MAX_PROTOCOL_RECOVERY_BYTES
    ) {
      break;
    }
    retained.push(candidate);
    bytes += candidateBytes;
  }
  return retained;
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
