import { Schema } from "effect";

import { MAX_INSPECTION_PLAN_QUERIES } from "#typepeek/inspection/inspection-plan-query";
import {
  atomicInspectionResultSchemas,
  inspectionFailureSchema,
  inspectionFailureSchemas,
  inspectionResultSchemas,
  inspectionResultWithIdentity,
  signatureInspectionSchemaComponents,
  type AtomicInspectionResult,
  type InspectedSignature,
  type InspectionFailure,
  type InspectionPlan,
  type InspectionResult,
  type SignatureInspection,
} from "#typepeek/inspection/protocol";
import {
  inspectionProtocolResponseOptionsSchema,
  INSPECTION_PROTOCOL_VERSION,
  PROTOCOL_RECOVERY_POLICY,
  protocolRecoveryReasonSchemas,
  signatureEvidenceIntentSchema,
  supportingTypeRecoveryBudgetSchema,
  type InspectionIntent,
  type SignatureEvidenceKind,
  type SignatureEvidenceIntent,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  inspectionRequestSchemas,
  type InspectionRequestByIntent,
  type NormalizedInspectionRequestByIntent,
} from "#typepeek/inspection/request-definitions";

const protocolVersionSchema = Schema.Literal(INSPECTION_PROTOCOL_VERSION);
const omittedFieldSchema = Schema.optionalKey(Schema.Never);
const isSignatureEvidenceIntent = Schema.is(signatureEvidenceIntentSchema);

function authoritativeContract<Type, Encoded>() {
  return <Contract extends Schema.Constraint>(
    schema: [Contract["Type"]] extends [Type]
      ? [Type] extends [Contract["Type"]]
        ? [Contract["Encoded"]] extends [Encoded]
          ? [Encoded] extends [Contract["Encoded"]]
            ? Contract
            : never
          : never
        : never
      : never,
  ): Contract => schema;
}

const structuredInspectedSignatureSchema = Schema.Struct({
  kind: signatureInspectionSchemaComponents.signature.fields.kind,
  typeParameters: signatureInspectionSchemaComponents.signature.fields.typeParameters,
  thisParameter: signatureInspectionSchemaComponents.signature.fields.thisParameter,
  parameters: signatureInspectionSchemaComponents.signature.fields.parameters,
  returns: signatureInspectionSchemaComponents.signature.fields.returns,
});

const exactInspectedSignatureSchema = Schema.Struct({
  kind: signatureInspectionSchemaComponents.signature.fields.kind,
  text: signatureInspectionSchemaComponents.signature.fields.text,
});

function signatureInspectionWith<SignatureSchema extends Schema.Constraint>(
  signatureSchema: SignatureSchema,
) {
  const moduleExportSchema = signatureInspectionSchemaComponents.moduleExport.mapFields(
    (fields) => ({
      ...fields,
      signatures: Schema.Array(signatureSchema),
    }),
  );
  return inspectionResultWithIdentity({
    intent: Schema.Literal("signature-inspection"),
    moduleExport: moduleExportSchema,
  });
}

function atomicInspectionResultWith<SignatureInspectionSchema extends Schema.Constraint>(
  signatureInspectionSchema: SignatureInspectionSchema,
) {
  return Schema.Union([
    atomicInspectionResultSchemas["interface-overview"],
    atomicInspectionResultSchemas["export-inspection"],
    signatureInspectionSchema,
    atomicInspectionResultSchemas["export-search"],
    atomicInspectionResultSchemas["public-subpath-discovery"],
    atomicInspectionResultSchemas["declaration-inspection"],
    atomicInspectionResultSchemas["member-inspection"],
  ]);
}

function inspectionResultWith<SignatureSchema extends Schema.Constraint>(
  signatureSchema: SignatureSchema,
) {
  const signatureInspectionSchema = signatureInspectionWith(signatureSchema);
  const atomicSchema = atomicInspectionResultWith(signatureInspectionSchema);
  const planSchema = Schema.Struct({
    intent: Schema.Literal("inspection-plan"),
    inspections: Schema.Array(atomicSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES),
    ),
  });
  return {
    signatureInspectionSchema,
    planSchema,
    resultSchema: Schema.Union([signatureInspectionSchema, planSchema]),
  } as const;
}

function inspectionOutcomeWith<SignatureSchema extends Schema.Constraint>(
  signatureSchema: SignatureSchema,
) {
  const projected = inspectionResultWith(signatureSchema);
  return {
    ...projected,
    outcomeSchema: Schema.Union([
      Schema.Struct({ status: Schema.Literal("success"), result: projected.resultSchema }),
      inspectionFailureSchema,
    ]),
  } as const;
}

export const protocolInspectionSchemas = {
  structured: inspectionOutcomeWith(structuredInspectedSignatureSchema),
  exact: inspectionOutcomeWith(exactInspectedSignatureSchema),
  both: inspectionOutcomeWith(signatureInspectionSchemaComponents.signature),
} as const satisfies Readonly<Record<SignatureEvidenceKind, unknown>>;

function requestEnvelopeWithoutProjection<
  const Intent extends Exclude<InspectionIntent, SignatureEvidenceIntent>,
  RequestSchema extends Schema.Constraint,
>(intent: Intent, request: RequestSchema) {
  return Schema.Struct({
    protocolVersion: protocolVersionSchema,
    intent: Schema.Literal(intent),
    request,
    response: omittedFieldSchema,
  });
}

function requestEnvelopeWithProjection<
  const Intent extends SignatureEvidenceIntent,
  RequestSchema extends Schema.Constraint,
>(intent: Intent, request: RequestSchema) {
  return Schema.Struct({
    protocolVersion: protocolVersionSchema,
    intent: Schema.Literal(intent),
    request,
    response: Schema.optionalKey(inspectionProtocolResponseOptionsSchema),
  });
}

const inspectionProtocolRequestSchemas = {
  "interface-overview": requestEnvelopeWithoutProjection(
    "interface-overview",
    inspectionRequestSchemas["interface-overview"],
  ),
  "export-inspection": requestEnvelopeWithoutProjection(
    "export-inspection",
    inspectionRequestSchemas["export-inspection"],
  ),
  "signature-inspection": requestEnvelopeWithProjection(
    "signature-inspection",
    inspectionRequestSchemas["signature-inspection"],
  ),
  "export-search": requestEnvelopeWithoutProjection(
    "export-search",
    inspectionRequestSchemas["export-search"],
  ),
  "public-subpath-discovery": requestEnvelopeWithoutProjection(
    "public-subpath-discovery",
    inspectionRequestSchemas["public-subpath-discovery"],
  ),
  "declaration-inspection": requestEnvelopeWithoutProjection(
    "declaration-inspection",
    inspectionRequestSchemas["declaration-inspection"],
  ),
  "member-inspection": requestEnvelopeWithoutProjection(
    "member-inspection",
    inspectionRequestSchemas["member-inspection"],
  ),
  "inspection-plan": requestEnvelopeWithProjection(
    "inspection-plan",
    inspectionRequestSchemas["inspection-plan"],
  ),
  "public-interface-comparison": requestEnvelopeWithoutProjection(
    "public-interface-comparison",
    inspectionRequestSchemas["public-interface-comparison"],
  ),
} as const satisfies Readonly<Record<InspectionIntent, Schema.Constraint>>;

const exactInspectionProtocolRequestSchema = authoritativeContract<
  NormalizedInspectionProtocolRequestContract,
  InspectionProtocolRequestContract
>()(
  Schema.Union([
    inspectionProtocolRequestSchemas["interface-overview"],
    inspectionProtocolRequestSchemas["export-inspection"],
    inspectionProtocolRequestSchemas["signature-inspection"],
    inspectionProtocolRequestSchemas["export-search"],
    inspectionProtocolRequestSchemas["public-subpath-discovery"],
    inspectionProtocolRequestSchemas["declaration-inspection"],
    inspectionProtocolRequestSchemas["member-inspection"],
    inspectionProtocolRequestSchemas["inspection-plan"],
    inspectionProtocolRequestSchemas["public-interface-comparison"],
  ]),
);
export const inspectionProtocolRequestSchema: Schema.Codec<
  NormalizedInspectionProtocolRequestContract,
  InspectionProtocolRequestContract
> = exactInspectionProtocolRequestSchema;

export function supportsSignatureEvidence(
  intent: InspectionIntent,
): intent is SignatureEvidenceIntent {
  return isSignatureEvidenceIntent(intent);
}

const structuredSignatureRecoveryRequestSchema = inspectionProtocolRequestSchemas[
  "signature-inspection"
].mapFields((fields) => ({
  ...fields,
  response: Schema.Struct({ signatureEvidence: Schema.Literal("structured") }),
}));
const declarationRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.declarationsWithoutSupportingTypes,
  request: Schema.toEncoded(inspectionProtocolRequestSchemas["declaration-inspection"]),
});
const signatureRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.signaturesWithoutSupportingTypes,
  request: Schema.toEncoded(structuredSignatureRecoveryRequestSchema),
});
const searchRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.relatedExportNames,
  request: Schema.toEncoded(inspectionProtocolRequestSchemas["export-search"]),
});
function boundedRecovery<
  RecoverySchema extends Schema.Top & Schema.ConstraintDecoder<readonly unknown[]>,
>(schema: RecoverySchema): RecoverySchema["Rebuild"] {
  return schema.check(
    Schema.isMaxLength(PROTOCOL_RECOVERY_POLICY.maximumEntries),
    Schema.makeFilter(hasBoundedRecoveryBytes, {
      expected: `at most ${PROTOCOL_RECOVERY_POLICY.maximumBytes} serialized bytes`,
    }),
  );
}
const searchRecoverySchema = boundedRecovery(Schema.Tuple([searchRecoveryGuidanceSchema]));
const supportingTypeRecoverySchema = boundedRecovery(
  Schema.Tuple([declarationRecoveryGuidanceSchema, signatureRecoveryGuidanceSchema]),
);
export const protocolRecoverySchema = Schema.Union([
  searchRecoverySchema,
  supportingTypeRecoverySchema,
]);
const structuredProjectionSchema = Schema.Struct({
  signatureEvidence: Schema.Literal("structured"),
  omittedEvidence: Schema.Tuple([Schema.Literal("exact-signature-text")]),
});
const exactProjectionSchema = Schema.Struct({
  signatureEvidence: Schema.Literal("exact"),
  omittedEvidence: Schema.Tuple([Schema.Literal("structured-signature-fields")]),
});
const bothProjectionSchema = Schema.Struct({
  signatureEvidence: Schema.Literal("both"),
  omittedEvidence: Schema.Tuple([]),
});

export const signatureEvidenceProjectionSchemas = {
  structured: structuredProjectionSchema,
  exact: exactProjectionSchema,
  both: bothProjectionSchema,
} as const satisfies Readonly<Record<SignatureEvidenceKind, Schema.Constraint>>;

const nonProjectedInspectionResultSchema = Schema.Union([
  inspectionResultSchemas["interface-overview"],
  inspectionResultSchemas["export-inspection"],
  inspectionResultSchemas["export-search"],
  inspectionResultSchemas["public-subpath-discovery"],
  inspectionResultSchemas["declaration-inspection"],
  inspectionResultSchemas["member-inspection"],
  inspectionResultSchemas["public-interface-comparison"],
]);
const nonProjectedInspectionOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), result: nonProjectedInspectionResultSchema }),
  inspectionFailureSchema,
]);
export const exportNotFoundOutcomeSchema = inspectionFailureSchemas.notFound.mapFields(
  (fields) => ({
    ...fields,
    reason: Schema.Literal("export-not-found"),
  }),
);
export const supportingTypeLimitOutcomeSchema = inspectionFailureSchemas.limit.mapFields(
  (fields) => ({
    ...fields,
    exceededBudget: supportingTypeRecoveryBudgetSchema,
  }),
);
const unprojectedResponseSchema = Schema.Struct({
  protocolVersion: protocolVersionSchema,
  outcome: nonProjectedInspectionOutcomeSchema,
  projection: omittedFieldSchema,
  recovery: omittedFieldSchema,
});
const unprojectedSearchRecoveryResponseSchema = Schema.Struct({
  protocolVersion: protocolVersionSchema,
  outcome: exportNotFoundOutcomeSchema,
  projection: omittedFieldSchema,
  recovery: searchRecoverySchema,
});
const supportingTypeRecoveryResponseSchema = Schema.Struct({
  protocolVersion: protocolVersionSchema,
  outcome: supportingTypeLimitOutcomeSchema,
  projection: omittedFieldSchema,
  recovery: supportingTypeRecoverySchema,
});

function projectedResponseSchema<
  OutcomeSchema extends Schema.Constraint,
  ProjectionSchema extends Schema.Constraint,
>(outcome: OutcomeSchema, projection: ProjectionSchema) {
  return Schema.Struct({
    protocolVersion: protocolVersionSchema,
    outcome,
    projection,
    recovery: omittedFieldSchema,
  });
}

function projectedSearchRecoveryResponseSchema<ProjectionSchema extends Schema.Constraint>(
  projection: ProjectionSchema,
) {
  return Schema.Struct({
    protocolVersion: protocolVersionSchema,
    outcome: exportNotFoundOutcomeSchema,
    projection,
    recovery: searchRecoverySchema,
  });
}

const inspectionProtocolResponseSchemas = {
  unprojected: unprojectedResponseSchema,
  unprojectedSearchRecovery: unprojectedSearchRecoveryResponseSchema,
  supportingTypeRecovery: supportingTypeRecoveryResponseSchema,
  structured: projectedResponseSchema(
    protocolInspectionSchemas.structured.outcomeSchema,
    structuredProjectionSchema,
  ),
  structuredSearchRecovery: projectedSearchRecoveryResponseSchema(structuredProjectionSchema),
  exact: projectedResponseSchema(
    protocolInspectionSchemas.exact.outcomeSchema,
    exactProjectionSchema,
  ),
  exactSearchRecovery: projectedSearchRecoveryResponseSchema(exactProjectionSchema),
  both: projectedResponseSchema(protocolInspectionSchemas.both.outcomeSchema, bothProjectionSchema),
  bothSearchRecovery: projectedSearchRecoveryResponseSchema(bothProjectionSchema),
} as const;

const exactInspectionProtocolResponseSchema = authoritativeContract<
  InspectionProtocolResponseContract,
  InspectionProtocolResponseContract
>()(
  Schema.Union([
    inspectionProtocolResponseSchemas.unprojected,
    inspectionProtocolResponseSchemas.unprojectedSearchRecovery,
    inspectionProtocolResponseSchemas.supportingTypeRecovery,
    inspectionProtocolResponseSchemas.structured,
    inspectionProtocolResponseSchemas.structuredSearchRecovery,
    inspectionProtocolResponseSchemas.exact,
    inspectionProtocolResponseSchemas.exactSearchRecovery,
    inspectionProtocolResponseSchemas.both,
    inspectionProtocolResponseSchemas.bothSearchRecovery,
  ]),
);
export const inspectionProtocolResponseSchema: Schema.Codec<InspectionProtocolResponseContract> =
  exactInspectionProtocolResponseSchema;

function hasBoundedRecoveryBytes(guidance: readonly unknown[]): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(guidance)) <= PROTOCOL_RECOVERY_POLICY.maximumBytes;
  } catch {
    return false;
  }
}

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
  | ProtocolSignatureInspection<Evidence>
  | ProtocolInspectionPlan<Evidence>;
export type ProtocolInspectionOutcome<Evidence extends SignatureEvidenceKind> =
  | { readonly status: "success"; readonly result: ProtocolInspectionResult<Evidence> }
  | InspectionFailure;

export type InspectionProtocolResponseOptions<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = { readonly signatureEvidence: Evidence };
export type InspectionProtocolEnvelope<
  Intent extends InspectionIntent,
  RequestByIntent extends Readonly<Record<InspectionIntent, unknown>>,
  Evidence extends SignatureEvidenceKind,
> = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly intent: Intent;
  readonly request: RequestByIntent[Intent];
} & (Intent extends SignatureEvidenceIntent
  ? { readonly response?: InspectionProtocolResponseOptions<Evidence> }
  : { readonly response?: never });
export type InspectionProtocolRequestFrom<
  RequestByIntent extends Readonly<Record<InspectionIntent, unknown>>,
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = {
  readonly [Intent in InspectionIntent]: InspectionProtocolEnvelope<
    Intent,
    RequestByIntent,
    Evidence
  >;
}[InspectionIntent];
export type InspectionProtocolRequestContract<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = InspectionProtocolRequestFrom<InspectionRequestByIntent, Evidence>;
export type NormalizedInspectionProtocolRequestContract<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> = InspectionProtocolRequestFrom<NormalizedInspectionRequestByIntent, Evidence>;

export type DeclarationRecoveryGuidance = typeof declarationRecoveryGuidanceSchema.Type;
export type SignatureRecoveryGuidance = typeof signatureRecoveryGuidanceSchema.Type;
export type SearchRecoveryGuidance = typeof searchRecoveryGuidanceSchema.Type;
export type ProtocolRecovery = typeof protocolRecoverySchema.Type;

export type SignatureEvidenceProjectionFor<Evidence extends SignatureEvidenceKind> =
  Evidence extends "structured"
    ? {
        readonly signatureEvidence: Evidence;
        readonly omittedEvidence: readonly ["exact-signature-text"];
      }
    : Evidence extends "exact"
      ? {
          readonly signatureEvidence: Evidence;
          readonly omittedEvidence: readonly ["structured-signature-fields"];
        }
      : { readonly signatureEvidence: Evidence; readonly omittedEvidence: readonly [] };
export type SignatureEvidenceProjection = SignatureEvidenceProjectionFor<SignatureEvidenceKind>;

export type ExportNotFoundOutcome = typeof exportNotFoundOutcomeSchema.Type;
export type SupportingTypeLimitOutcome = typeof supportingTypeLimitOutcomeSchema.Type;
export type UnprojectedInspectionOutcome =
  | {
      readonly status: "success";
      readonly result: Exclude<InspectionResult, SignatureInspection | InspectionPlan>;
    }
  | InspectionFailure;
export type UnprojectedProtocolResponse = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: UnprojectedInspectionOutcome;
  readonly projection?: never;
  readonly recovery?: never;
};
export type SearchRecoveryProtocolResponse = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: ExportNotFoundOutcome;
  readonly projection?: never;
  readonly recovery: readonly [SearchRecoveryGuidance];
};
export type SupportingTypeRecoveryProtocolResponse = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: SupportingTypeLimitOutcome;
  readonly projection?: never;
  readonly recovery: readonly [DeclarationRecoveryGuidance, SignatureRecoveryGuidance];
};
export type ProjectedProtocolResponse<Evidence extends SignatureEvidenceKind> = {
  readonly [Kind in Evidence]:
    | {
        readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
        readonly outcome: ProtocolInspectionOutcome<Kind>;
        readonly projection: SignatureEvidenceProjectionFor<Kind>;
        readonly recovery?: never;
      }
    | {
        readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
        readonly outcome: ExportNotFoundOutcome;
        readonly projection: SignatureEvidenceProjectionFor<Kind>;
        readonly recovery: readonly [SearchRecoveryGuidance];
      };
}[Evidence];
export type InspectionProtocolResponseContract =
  | UnprojectedProtocolResponse
  | SearchRecoveryProtocolResponse
  | SupportingTypeRecoveryProtocolResponse
  | ProjectedProtocolResponse<SignatureEvidenceKind>;

export type InspectionProtocolRequest = typeof inspectionProtocolRequestSchema.Encoded;
export type NormalizedInspectionProtocolRequest = typeof inspectionProtocolRequestSchema.Type;
export type InspectionProtocolResponse = typeof inspectionProtocolResponseSchema.Type;

export type { SignatureEvidenceKind } from "#typepeek/inspection/protocol-vocabulary";
