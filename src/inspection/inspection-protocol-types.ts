import type {
  AtomicInspectionResult,
  InspectedSignature,
  InspectionFailure,
  InspectionPlan,
  InspectionRequestByIntent,
  InspectionResult,
  SignatureInspection,
} from "#typepeek/inspection/protocol";
import {
  inspectionProtocolResponseOptionsSchema,
  INSPECTION_PROTOCOL_VERSION,
  type InspectionIntent,
  type SignatureEvidenceKind,
} from "#typepeek/inspection/protocol-vocabulary";

export type { SignatureEvidenceKind } from "#typepeek/inspection/protocol-vocabulary";
export type StructuredInspectedSignature = Omit<InspectedSignature, "text">;
export type ExactInspectedSignature = Pick<InspectedSignature, "kind" | "text">;
export type ProtocolInspectedSignature<Evidence extends SignatureEvidenceKind> =
  Evidence extends "structured"
    ? StructuredInspectedSignature
    : Evidence extends "exact"
      ? ExactInspectedSignature
      : InspectedSignature;
export type ProtocolSignatureInspection<Evidence extends SignatureEvidenceKind> = Omit<
  SignatureInspection,
  "moduleExport"
> & {
  readonly moduleExport: Omit<SignatureInspection["moduleExport"], "signatures"> & {
    readonly signatures: readonly ProtocolInspectedSignature<Evidence>[];
  };
};
export type ProtocolInspectionPlan<Evidence extends SignatureEvidenceKind> = Omit<
  InspectionPlan,
  "inspections"
> & {
  readonly inspections: readonly (
    | Exclude<AtomicInspectionResult, SignatureInspection>
    | ProtocolSignatureInspection<Evidence>
  )[];
};
export type ProtocolInspectionResult<Evidence extends SignatureEvidenceKind> =
  | Exclude<InspectionResult, SignatureInspection | InspectionPlan>
  | ProtocolSignatureInspection<Evidence>
  | ProtocolInspectionPlan<Evidence>;
export type ProtocolInspectionOutcome<Evidence extends SignatureEvidenceKind> =
  | {
      readonly status: "success";
      readonly result: ProtocolInspectionResult<Evidence>;
    }
  | InspectionFailure;

export interface SignatureEvidenceProjection {
  readonly signatureEvidence: SignatureEvidenceKind;
  readonly omittedEvidence: readonly ("exact-signature-text" | "structured-signature-fields")[];
}

export type InspectionProtocolResponseOptions<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = Omit<typeof inspectionProtocolResponseOptionsSchema.Type, "signatureEvidence"> & {
  readonly signatureEvidence: Evidence;
};

export type InspectionProtocolEnvelope<
  Intent extends InspectionIntent,
  Evidence extends SignatureEvidenceKind,
> = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly intent: Intent;
  readonly request: InspectionRequestByIntent[Intent];
} & (Intent extends "signature-inspection" | "inspection-plan"
  ? { readonly response?: InspectionProtocolResponseOptions<Evidence> }
  : { readonly response?: never });

export type InspectionProtocolRequest<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = {
  readonly [Intent in InspectionIntent]: InspectionProtocolEnvelope<Intent, Evidence>;
}[InspectionIntent];

export type ProtocolRecoveryReason =
  | "inspect-declarations-without-supporting-types"
  | "inspect-signatures-without-supporting-types"
  | "search-related-export-names";

export interface ProtocolRecoveryGuidance {
  readonly reason: ProtocolRecoveryReason;
  readonly request: InspectionProtocolRequest;
}

export interface InspectionProtocolResponse<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: ProtocolInspectionOutcome<Evidence>;
  readonly projection?: SignatureEvidenceProjection;
  readonly recovery?: readonly ProtocolRecoveryGuidance[];
}
