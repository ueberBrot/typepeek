import { Result, Schema } from "effect";

import { isBoundedExportSearchQuery } from "#typepeek/inspection/inspection-plan-query";
import {
  exportNotFoundOutcomeSchema,
  protocolRecoverySchema,
  supportingTypeLimitOutcomeSchema,
  type ProtocolRecovery,
} from "#typepeek/inspection/inspection-protocol-schema";
import type { InspectionOutcome } from "#typepeek/inspection/protocol";
import {
  INSPECTION_PROTOCOL_VERSION,
  protocolRecoveryReasonSchemas,
} from "#typepeek/inspection/protocol-vocabulary";
import type { PreparedInspectionCoreRequest } from "#typepeek/inspection/request-definitions";

const decodeProtocolRecovery = Schema.decodeUnknownResult(protocolRecoverySchema);
const isExportNotFoundOutcome = Schema.is(exportNotFoundOutcomeSchema);
const isSupportingTypeLimitOutcome = Schema.is(supportingTypeLimitOutcomeSchema);

/** Derives only complete executable requests from one trusted normalized request. */
export function protocolRecoveryGuidance(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome,
): ProtocolRecovery | readonly [] {
  const candidates = recoveryCandidates(prepared, outcome);
  if (candidates.length === 0) {
    return candidates;
  }
  return Result.getOrElse(decodeProtocolRecovery(candidates), () => []);
}

function recoveryCandidates(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome,
): ProtocolRecovery | readonly [] {
  if (prepared.intent === "export-inspection" && isSupportingTypeLimitOutcome(outcome)) {
    const request = prepared.request;
    return [
      {
        reason: protocolRecoveryReasonSchemas.declarationsWithoutSupportingTypes.literal,
        request: {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          intent: "declaration-inspection",
          request,
        },
      },
      {
        reason: protocolRecoveryReasonSchemas.signaturesWithoutSupportingTypes.literal,
        request: {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          intent: "signature-inspection",
          request,
          response: { signatureEvidence: "structured" },
        },
      },
    ];
  }
  if (!isExportNotFoundOutcome(outcome)) {
    return [];
  }
  const focusedRequest = focusedExportRequest(prepared);
  return focusedRequest === undefined || !isBoundedExportSearchQuery(focusedRequest.exportName)
    ? []
    : [
        {
          reason: protocolRecoveryReasonSchemas.relatedExportNames.literal,
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
