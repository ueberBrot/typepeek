import { Result, Schema } from "effect";

import type {
  ProtocolInspectionOutcome,
  SignatureEvidenceKind,
  SignatureEvidenceProjection,
} from "#typepeek/inspection/inspection-protocol-schema";
import {
  protocolInspectionSchemas,
  signatureEvidenceProjectionSchemas,
} from "#typepeek/inspection/inspection-protocol-schema";
import type {
  InspectedSignature,
  InspectionOutcome,
  InspectionResult,
  SignatureInspection,
} from "#typepeek/inspection/protocol";

/** Removes only the Signature Evidence excluded by an explicit transport projection. */
export function projectInspectionOutcome(
  outcome: InspectionOutcome,
  evidence: SignatureEvidenceKind,
): ProtocolInspectionOutcome<SignatureEvidenceKind> | undefined {
  const candidate =
    outcome.status === "success"
      ? {
          status: "success",
          result: projectInspectionResult(outcome.result, evidence),
        }
      : outcome;
  return Result.getOrUndefined(
    Schema.decodeUnknownResult(protocolInspectionSchemas[evidence].outcomeSchema)(candidate),
  );
}

export function signatureEvidenceProjection(
  signatureEvidence: SignatureEvidenceKind,
): SignatureEvidenceProjection | undefined {
  switch (signatureEvidence) {
    case "structured":
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.structured)({
          signatureEvidence,
          omittedEvidence: ["exact-signature-text"],
        }),
      );
    case "exact":
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.exact)({
          signatureEvidence,
          omittedEvidence: ["structured-signature-fields"],
        }),
      );
    case "both":
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.both)({
          signatureEvidence,
          omittedEvidence: [],
        }),
      );
  }
}

function projectInspectionResult(
  result: InspectionResult,
  evidence: SignatureEvidenceKind,
): unknown {
  if (result.intent === "signature-inspection") {
    return projectSignatureInspection(result, evidence);
  }
  if (result.intent === "inspection-plan") {
    return {
      ...result,
      inspections: result.inspections.map((inspection) =>
        inspection.intent === "signature-inspection"
          ? projectSignatureInspection(inspection, evidence)
          : inspection,
      ),
    };
  }
  return result;
}

function projectSignatureInspection(
  inspection: SignatureInspection,
  evidence: SignatureEvidenceKind,
): unknown {
  return {
    ...inspection,
    moduleExport: {
      ...inspection.moduleExport,
      signatures: inspection.moduleExport.signatures.map((signature) =>
        projectInspectedSignature(signature, evidence),
      ),
    },
  };
}

function projectInspectedSignature(
  signature: InspectedSignature,
  evidence: SignatureEvidenceKind,
): unknown {
  if (evidence === "exact") {
    return { kind: signature.kind, text: signature.text };
  }
  if (evidence === "structured") {
    return {
      kind: signature.kind,
      typeParameters: signature.typeParameters,
      ...(signature.thisParameter === undefined ? {} : { thisParameter: signature.thisParameter }),
      parameters: signature.parameters,
      returns: signature.returns,
    };
  }
  return signature;
}
