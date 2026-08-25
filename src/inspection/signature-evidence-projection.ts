import type {
  InspectedSignature,
  InspectionOutcome,
  InspectionResult,
  ProtocolInspectedSignature,
  ProtocolInspectionOutcome,
  ProtocolInspectionResult,
  ProtocolSignatureInspection,
  SignatureEvidenceKind,
  SignatureEvidenceProjection,
  SignatureInspection,
} from "#typepeek/inspection/protocol";

export const SIGNATURE_EVIDENCE_KINDS = Object.freeze(["structured", "exact", "both"] as const);

/** Removes only the Signature Evidence excluded by an explicit transport projection. */
export function projectInspectionOutcome<Evidence extends SignatureEvidenceKind>(
  outcome: InspectionOutcome,
  evidence: Evidence,
): ProtocolInspectionOutcome<Evidence> {
  return outcome.status === "success"
    ? {
        status: "success",
        result: projectInspectionResult(outcome.result, evidence),
      }
    : outcome;
}

export function signatureEvidenceProjection(
  signatureEvidence: SignatureEvidenceKind,
): SignatureEvidenceProjection {
  return {
    signatureEvidence,
    omittedEvidence:
      signatureEvidence === "structured"
        ? ["exact-signature-text"]
        : signatureEvidence === "exact"
          ? ["structured-signature-fields"]
          : [],
  };
}

export function isSignatureEvidenceKind(value: unknown): value is SignatureEvidenceKind {
  return (
    typeof value === "string" && (SIGNATURE_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

function projectInspectionResult<Evidence extends SignatureEvidenceKind>(
  result: InspectionResult,
  evidence: Evidence,
): ProtocolInspectionResult<Evidence> {
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
    } as ProtocolInspectionResult<Evidence>;
  }
  return result as ProtocolInspectionResult<Evidence>;
}

function projectSignatureInspection<Evidence extends SignatureEvidenceKind>(
  inspection: SignatureInspection,
  evidence: Evidence,
): ProtocolSignatureInspection<Evidence> {
  return {
    ...inspection,
    moduleExport: {
      ...inspection.moduleExport,
      signatures: inspection.moduleExport.signatures.map((signature) =>
        projectInspectedSignature(signature, evidence),
      ),
    },
  } as ProtocolSignatureInspection<Evidence>;
}

function projectInspectedSignature<Evidence extends SignatureEvidenceKind>(
  signature: InspectedSignature,
  evidence: Evidence,
): ProtocolInspectedSignature<Evidence> {
  if (evidence === "exact") {
    return { kind: signature.kind, text: signature.text } as ProtocolInspectedSignature<Evidence>;
  }
  if (evidence === "structured") {
    return {
      kind: signature.kind,
      typeParameters: signature.typeParameters,
      ...(signature.thisParameter === undefined ? {} : { thisParameter: signature.thisParameter }),
      parameters: signature.parameters,
      returns: signature.returns,
    } as ProtocolInspectedSignature<Evidence>;
  }
  return signature as ProtocolInspectedSignature<Evidence>;
}
