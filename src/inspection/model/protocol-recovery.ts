import { Result, Schema } from "effect";

import type { ProtocolRecovery } from "#typepeek/inspection/model/inspection-protocol-schema";
import {
  exportNotFoundOutcomeSchema,
  protocolRecoverySchema,
  supportingTypeLimitOutcomeSchema,
} from "#typepeek/inspection/model/inspection-protocol-schema";
import type { InspectionOutcome } from "#typepeek/inspection/model/protocol";
import {
  INSPECTION_PROTOCOL_VERSION,
  protocolRecoveryReasonSchemas,
} from "#typepeek/inspection/model/protocol-vocabulary";
import type { PreparedInspectionCoreRequest } from "#typepeek/inspection/model/request-definitions";
import { isBoundedExportSearchQuery } from "#typepeek/inspection/queries/inspection-plan-query";
import { unreachableCase } from "#typepeek/shared/unreachable-case";

const decodeProtocolRecovery = Schema.decodeUnknownResult(
  protocolRecoverySchema
);

const isExportNotFoundOutcome = Schema.is(exportNotFoundOutcomeSchema);

const isSupportingTypeLimitOutcome = Schema.is(
  supportingTypeLimitOutcomeSchema
);

const focusedExportRequest = function focusedExportRequest(
  prepared: PreparedInspectionCoreRequest
):
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
    case "member-discovery": {
      return prepared.request;
    }

    case "export-search":
    case "inspection-plan":
    case "interface-overview":
    case "public-interface-comparison":
    case "public-subpath-discovery": {
      return undefined;
    }

    default: {
      return unreachableCase(prepared);
    }
  }
};

const recoveryCandidates = function recoveryCandidates(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome
): ProtocolRecovery | readonly [] {
  if (
    prepared.intent === "export-inspection" &&
    isSupportingTypeLimitOutcome(outcome)
  ) {
    const { request } = prepared;

    return [
      {
        reason:
          protocolRecoveryReasonSchemas.declarationsWithoutSupportingTypes
            .literal,
        request: {
          intent: "declaration-inspection",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request,
        },
      },
      {
        reason:
          protocolRecoveryReasonSchemas.signaturesWithoutSupportingTypes
            .literal,
        request: {
          intent: "signature-inspection",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
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

  return focusedRequest === undefined ||
    !isBoundedExportSearchQuery(focusedRequest.exportName)
    ? []
    : [
        {
          reason: protocolRecoveryReasonSchemas.relatedExportNames.literal,
          request: {
            intent: "export-search",
            protocolVersion: INSPECTION_PROTOCOL_VERSION,
            request: {
              accessStyle: focusedRequest.accessStyle,
              query: focusedRequest.exportName,
              resolutionContext: focusedRequest.resolutionContext,
              specifier: focusedRequest.specifier,
            },
          },
        },
      ];
};

/** Builds recovery requests from the validated original request. */
export const protocolRecoveryGuidance = function protocolRecoveryGuidance(
  prepared: PreparedInspectionCoreRequest,
  outcome: InspectionOutcome
): ProtocolRecovery | readonly [] {
  const candidates = recoveryCandidates(prepared, outcome);

  if (candidates.length === 0) {
    return candidates;
  }

  return Result.getOrElse(decodeProtocolRecovery(candidates), () => []);
};
