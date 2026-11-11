/* oxlint-disable anti-slop/no-unknown-parameters -- The protocol entry point validates arbitrary external requests and responses before dispatch. */
import { Effect, Predicate, Result, Schema } from "effect";

import { invokeInspectionCore } from "#typepeek/inspection/core";
import type {
  InspectionProtocolResponse,
  NormalizedInspectionProtocolRequest,
  SignatureEvidenceKind,
} from "#typepeek/inspection/model/inspection-protocol-schema";
import {
  inspectionProtocolRequestSchema,
  inspectionProtocolResponseSchema,
  supportsSignatureEvidence,
} from "#typepeek/inspection/model/inspection-protocol-schema";
import type {
  InspectionFailure,
  InspectionOutcome,
} from "#typepeek/inspection/model/protocol";
import { protocolRecoveryGuidance } from "#typepeek/inspection/model/protocol-recovery";
import type { InspectionIntent } from "#typepeek/inspection/model/protocol-vocabulary";
import {
  INSPECTION_PROTOCOL_VERSION,
  inspectionIntentSchema,
  inspectionProtocolResponseOptionsSchema,
} from "#typepeek/inspection/model/protocol-vocabulary";
import { readInspectionRequest } from "#typepeek/inspection/model/request-definitions";
import { projectSignatureEvidence } from "#typepeek/inspection/model/signature-evidence-projection";
import { snapshotDataProperties } from "#typepeek/inspection/model/untrusted-data";

const PROTOCOL_HEADER_FIELDS = [
  "protocolVersion",
  "intent",
  "request",
  "response",
] as const;

const definedResponseSchema = Schema.Unknown.check(
  Schema.makeFilter(Predicate.isNotUndefined, {
    expected: "a defined response",
  })
);

const protocolHeaderSchema = Schema.Struct({
  intent: inspectionIntentSchema,
  protocolVersion: Schema.String.check(
    Schema.makeFilter((version) => Buffer.byteLength(version) <= 64, {
      expected: "a bounded protocol version",
    })
  ),
  request: Schema.Unknown,
  response: Schema.optionalKey(definedResponseSchema),
});

const decodeProtocolHeader = Schema.decodeUnknownResult(protocolHeaderSchema);

const decodeInspectionProtocolRequest = Schema.decodeUnknownResult(
  inspectionProtocolRequestSchema
);

const decodeInspectionProtocolResponse = Schema.decodeUnknownResult(
  inspectionProtocolResponseSchema
);

const decodeProtocolResponseOptions = Schema.decodeUnknownResult(
  inspectionProtocolResponseOptionsSchema
);

type ProtocolHeader = typeof protocolHeaderSchema.Type;

const INVALID_PROTOCOL_RESULT_RESPONSE = Schema.decodeSync(
  inspectionProtocolResponseSchema
)({
  outcome: {
    message: "Inspection produced an invalid protocol result.",
    reason: "invalid-result",
    status: "unsupported",
  },
  protocolVersion: INSPECTION_PROTOCOL_VERSION,
});

const readProtocolHeaderFromData = function readProtocolHeaderFromData(
  value: unknown
): ProtocolHeader | undefined {
  const record = snapshotDataProperties(value, PROTOCOL_HEADER_FIELDS);

  return record === undefined
    ? undefined
    : Result.getOrUndefined(decodeProtocolHeader(record));
};

const protocolResponseFrom = function protocolResponseFrom(
  value: unknown
): InspectionProtocolResponse {
  return (
    Result.getOrUndefined(decodeInspectionProtocolResponse(value)) ??
    INVALID_PROTOCOL_RESULT_RESPONSE
  );
};

const protocolResponse = function protocolResponse(
  outcome: InspectionOutcome
): InspectionProtocolResponse {
  return protocolResponseFrom({
    outcome,
    protocolVersion: INSPECTION_PROTOCOL_VERSION,
  });
};

const invalidProtocolRequest =
  function invalidProtocolRequest(): InspectionFailure {
    return {
      message: "Inspection received an invalid protocol request.",
      reason: "invalid-request",
      status: "unsupported",
    };
  };

const readProtocolResponseOptions = function readProtocolResponseOptions(
  intent: InspectionIntent,
  response: unknown
):
  | {
      readonly signatureEvidence: SignatureEvidenceKind;
    }
  | null
  | undefined {
  if (!supportsSignatureEvidence(intent)) {
    return response === undefined ? undefined : null;
  }

  if (response === undefined) {
    return undefined;
  }

  const snapshot = snapshotDataProperties(response, [
    "signatureEvidence",
  ] as const);

  return snapshot === undefined
    ? null
    : (Result.getOrUndefined(decodeProtocolResponseOptions(snapshot)) ?? null);
};

const readProtocolHeader = (value: unknown): ProtocolHeader | undefined => {
  try {
    return readProtocolHeaderFromData(value);
  } catch {
    return undefined;
  }
};

const readProtocolRequest = function readProtocolRequest(
  header: ProtocolHeader
): NormalizedInspectionProtocolRequest | undefined {
  const reading = readInspectionRequest(header.intent, header.request);

  if (!reading.accepted) {
    return undefined;
  }

  const response = readProtocolResponseOptions(header.intent, header.response);

  if (response === null) {
    return undefined;
  }

  const candidate = {
    intent: header.intent,
    protocolVersion: header.protocolVersion,
    request: reading.request,
    ...(response !== undefined && { response }),
  };

  return Result.getOrUndefined(decodeInspectionProtocolRequest(candidate));
};

const readSignatureEvidenceProjection =
  function readSignatureEvidenceProjection(
    request: NormalizedInspectionProtocolRequest
  ): SignatureEvidenceKind | undefined {
    return supportsSignatureEvidence(request.intent)
      ? (request.response?.signatureEvidence ?? "structured")
      : undefined;
  };

/** Validates and dispatches one Inspection Protocol request through the Inspection Core. */
export const invokeInspectionProtocolEffect = Effect.fn(
  "invokeInspectionProtocol"
)(function* invokeInspectionProtocolEffect(
  value: unknown
): Effect.fn.Return<InspectionProtocolResponse> {
  const header = readProtocolHeader(value);

  if (header === undefined) {
    return protocolResponse(invalidProtocolRequest());
  }

  if (header.protocolVersion !== INSPECTION_PROTOCOL_VERSION) {
    return protocolResponse({
      message: `Inspection protocol version "${header.protocolVersion}" is not supported.`,
      reason: "unsupported-protocol-version",
      status: "unsupported",
    });
  }

  const request = readProtocolRequest(header);

  if (request === undefined) {
    return protocolResponse(invalidProtocolRequest());
  }

  const projection = readSignatureEvidenceProjection(request);

  const invocation = yield* invokeInspectionCore(
    request.intent,
    request.request
  );

  const candidate =
    projection === undefined
      ? {
          outcome: invocation.outcome,
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
        }
      : {
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          ...projectSignatureEvidence(invocation.outcome, projection),
        };

  if (invocation.preparedRequest === undefined) {
    return protocolResponseFrom(candidate);
  }

  const recovery = protocolRecoveryGuidance(
    invocation.preparedRequest,
    invocation.outcome
  );

  return protocolResponseFrom(
    recovery.length === 0 ? candidate : { ...candidate, recovery }
  );
});

export const invokeInspectionProtocol = async (
  value: unknown,
  signal?: AbortSignal
): Promise<InspectionProtocolResponse> =>
  await Effect.runPromise(
    invokeInspectionProtocolEffect(value),
    signal === undefined ? {} : { signal }
  );
