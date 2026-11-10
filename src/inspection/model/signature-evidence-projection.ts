import { Result, Schema } from "effect";

import type {
  SignatureEvidenceKind,
  SignatureEvidenceProjection,
} from "#typepeek/inspection/model/inspection-protocol-schema";
import {
  protocolInspectionSchemas,
  signatureEvidenceProjectionSchemas,
} from "#typepeek/inspection/model/inspection-protocol-schema";
import type {
  InspectedSignature,
  InspectionOutcome,
  InspectionResult,
  SignatureInspection,
} from "#typepeek/inspection/model/protocol";
import { unreachableCase } from "#typepeek/shared/unreachable-case";

const projectInspectedSignature = function projectInspectedSignature(
  signature: InspectedSignature,
  evidence: SignatureEvidenceKind
) {
  if (evidence === "exact") {
    return { kind: signature.kind, text: signature.text };
  }

  if (evidence === "structured") {
    return {
      kind: signature.kind,
      typeParameters: signature.typeParameters,
      ...(signature.thisParameter !== undefined && {
        thisParameter: signature.thisParameter,
      }),
      parameters: signature.parameters,
      returns: signature.returns,
    };
  }

  return signature;
};

const projectSignatureInspection = function projectSignatureInspection(
  inspection: SignatureInspection,
  evidence: SignatureEvidenceKind
) {
  return {
    ...inspection,
    moduleExport: {
      ...inspection.moduleExport,
      signatures: inspection.moduleExport.signatures.map((signature) =>
        projectInspectedSignature(signature, evidence)
      ),
    },
  };
};

const projectInspectionResult = function projectInspectionResult(
  result: InspectionResult,
  evidence: SignatureEvidenceKind
) {
  if (result.intent === "signature-inspection") {
    return projectSignatureInspection(result, evidence);
  }

  if (result.intent === "inspection-plan") {
    return {
      ...result,
      inspections: result.inspections.map((inspection) =>
        inspection.intent === "signature-inspection"
          ? projectSignatureInspection(inspection, evidence)
          : inspection
      ),
    };
  }

  return result;
};

const signatureEvidenceProjection = function signatureEvidenceProjection(
  signatureEvidence: SignatureEvidenceKind
): SignatureEvidenceProjection | undefined {
  switch (signatureEvidence) {
    case "structured": {
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.structured)({
          omittedEvidence: ["exact-signature-text"],
          signatureEvidence,
        })
      );
    }

    case "exact": {
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.exact)({
          omittedEvidence: ["structured-signature-fields"],
          signatureEvidence,
        })
      );
    }

    case "both": {
      return Result.getOrUndefined(
        Schema.decodeResult(signatureEvidenceProjectionSchemas.both)({
          omittedEvidence: [],
          signatureEvidence,
        })
      );
    }

    default: {
      return unreachableCase(signatureEvidence);
    }
  }
};

export const projectSignatureEvidence = function projectSignatureEvidence(
  outcome: InspectionOutcome,
  evidence: SignatureEvidenceKind
) {
  const candidate =
    outcome.status === "success"
      ? {
          result: projectInspectionResult(outcome.result, evidence),
          status: "success",
        }
      : outcome;

  return {
    outcome: Result.getOrUndefined(
      Schema.decodeUnknownResult(
        protocolInspectionSchemas[evidence].outcomeSchema
      )(candidate)
    ),
    projection: signatureEvidenceProjection(evidence),
  };
};
