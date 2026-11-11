import { Schema } from "effect";

import type {
  AtomicInspectionResult,
  InspectedSignature,
  InspectionFailure,
  InspectionPlan,
  InspectionResult,
  SignatureInspection,
} from "#typepeek/inspection/model/protocol";
import {
  atomicInspectionResultSchemas,
  inspectionFailureSchema,
  inspectionFailureSchemas,
  inspectionResultSchemas,
  inspectionResultWithIdentity,
  signatureInspectionSchemaComponents,
} from "#typepeek/inspection/model/protocol";
import type {
  InspectionIntent,
  SignatureEvidenceIntent,
  SignatureEvidenceKind,
} from "#typepeek/inspection/model/protocol-vocabulary";
import {
  INSPECTION_PROTOCOL_VERSION,
  inspectionProtocolResponseOptionsSchema,
  PROTOCOL_RECOVERY_POLICY,
  protocolRecoveryReasonSchemas,
  signatureEvidenceIntentSchema,
  supportingTypeRecoveryBudgetSchema,
} from "#typepeek/inspection/model/protocol-vocabulary";
import type {
  InspectionRequestByIntent,
  NormalizedInspectionRequestByIntent,
} from "#typepeek/inspection/model/request-definitions";
import { inspectionRequestSchemas } from "#typepeek/inspection/model/request-definitions";
import { MAX_INSPECTION_PLAN_QUERIES } from "#typepeek/inspection/queries/inspection-plan-query";

const protocolVersionSchema = Schema.Literal(INSPECTION_PROTOCOL_VERSION);
const omittedFieldSchema = Schema.optionalKey(Schema.Never);
const isSignatureEvidenceIntent = Schema.is(signatureEvidenceIntentSchema);

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Both directions of the returned schema contract must match Type and Encoded at compile time.
const authoritativeContract = function authoritativeContract<Type, Encoded>() {
  return <Contract extends Schema.Constraint>(
    schema: [Contract["Type"]] extends [Type]
      ? [Type] extends [Contract["Type"]]
        ? [Contract["Encoded"]] extends [Encoded]
          ? [Encoded] extends [Contract["Encoded"]]
            ? Contract
            : never
          : never
        : never
      : never
  ): Contract => schema;
};

const structuredInspectedSignatureSchema = Schema.Struct({
  kind: signatureInspectionSchemaComponents.signature.fields.kind,
  parameters: signatureInspectionSchemaComponents.signature.fields.parameters,
  returns: signatureInspectionSchemaComponents.signature.fields.returns,
  thisParameter:
    signatureInspectionSchemaComponents.signature.fields.thisParameter,
  typeParameters:
    signatureInspectionSchemaComponents.signature.fields.typeParameters,
});

const exactInspectedSignatureSchema = Schema.Struct({
  kind: signatureInspectionSchemaComponents.signature.fields.kind,
  text: signatureInspectionSchemaComponents.signature.fields.text,
});

const signatureInspectionWith = function signatureInspectionWith<
  SignatureSchema extends Schema.Constraint,
>(signatureSchema: SignatureSchema) {
  const moduleExportSchema =
    signatureInspectionSchemaComponents.moduleExport.mapFields((fields) => ({
      ...fields,
      signatures: Schema.Array(signatureSchema),
    }));

  return inspectionResultWithIdentity({
    intent: Schema.Literal("signature-inspection"),
    moduleExport: moduleExportSchema,
  });
};

const atomicInspectionResultWith = function atomicInspectionResultWith<
  SignatureInspectionSchema extends Schema.Constraint,
>(signatureInspectionSchema: SignatureInspectionSchema) {
  return Schema.Union([
    atomicInspectionResultSchemas["interface-overview"],
    atomicInspectionResultSchemas["export-inspection"],
    signatureInspectionSchema,
    atomicInspectionResultSchemas["export-search"],
    atomicInspectionResultSchemas["public-subpath-discovery"],
    atomicInspectionResultSchemas["declaration-inspection"],
    atomicInspectionResultSchemas["member-inspection"],
    atomicInspectionResultSchemas["member-discovery"],
  ]);
};

const inspectionResultWith = function inspectionResultWith<
  SignatureSchema extends Schema.Constraint,
>(signatureSchema: SignatureSchema) {
  const signatureInspectionSchema = signatureInspectionWith(signatureSchema);
  const atomicSchema = atomicInspectionResultWith(signatureInspectionSchema);

  const planSchema = Schema.Struct({
    inspections: Schema.Array(atomicSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_INSPECTION_PLAN_QUERIES)
    ),
    intent: Schema.Literal("inspection-plan"),
  });

  return {
    planSchema,
    resultSchema: Schema.Union([signatureInspectionSchema, planSchema]),
    signatureInspectionSchema,
  } as const;
};

const inspectionOutcomeWith = function inspectionOutcomeWith<
  SignatureSchema extends Schema.Constraint,
>(signatureSchema: SignatureSchema) {
  const projected = inspectionResultWith(signatureSchema);

  return {
    ...projected,
    outcomeSchema: Schema.Union([
      Schema.Struct({
        result: projected.resultSchema,
        status: Schema.Literal("success"),
      }),
      inspectionFailureSchema,
    ]),
  } as const;
};

export const protocolInspectionSchemas = {
  both: inspectionOutcomeWith(signatureInspectionSchemaComponents.signature),
  exact: inspectionOutcomeWith(exactInspectedSignatureSchema),
  structured: inspectionOutcomeWith(structuredInspectedSignatureSchema),
} as const satisfies Readonly<
  Record<SignatureEvidenceKind, ReturnType<typeof inspectionOutcomeWith>>
>;

const requestEnvelopeWithoutProjection =
  function requestEnvelopeWithoutProjection<
    const Intent extends Exclude<InspectionIntent, SignatureEvidenceIntent>,
    RequestSchema extends Schema.Constraint,
  >(intent: Intent, request: RequestSchema) {
    return Schema.Struct({
      intent: Schema.Literal(intent),
      protocolVersion: protocolVersionSchema,
      request,
      response: omittedFieldSchema,
    });
  };

const requestEnvelopeWithProjection = function requestEnvelopeWithProjection<
  const Intent extends SignatureEvidenceIntent,
  RequestSchema extends Schema.Constraint,
>(intent: Intent, request: RequestSchema) {
  return Schema.Struct({
    intent: Schema.Literal(intent),
    protocolVersion: protocolVersionSchema,
    request,
    response: Schema.optionalKey(inspectionProtocolResponseOptionsSchema),
  });
};

const inspectionProtocolRequestSchemas = {
  "declaration-inspection": requestEnvelopeWithoutProjection(
    "declaration-inspection",
    inspectionRequestSchemas["declaration-inspection"]
  ),
  "export-inspection": requestEnvelopeWithoutProjection(
    "export-inspection",
    inspectionRequestSchemas["export-inspection"]
  ),
  "export-search": requestEnvelopeWithoutProjection(
    "export-search",
    inspectionRequestSchemas["export-search"]
  ),
  "inspection-plan": requestEnvelopeWithProjection(
    "inspection-plan",
    inspectionRequestSchemas["inspection-plan"]
  ),
  "interface-overview": requestEnvelopeWithoutProjection(
    "interface-overview",
    inspectionRequestSchemas["interface-overview"]
  ),
  "member-discovery": requestEnvelopeWithoutProjection(
    "member-discovery",
    inspectionRequestSchemas["member-discovery"]
  ),
  "member-inspection": requestEnvelopeWithoutProjection(
    "member-inspection",
    inspectionRequestSchemas["member-inspection"]
  ),
  "public-interface-comparison": requestEnvelopeWithoutProjection(
    "public-interface-comparison",
    inspectionRequestSchemas["public-interface-comparison"]
  ),
  "public-subpath-discovery": requestEnvelopeWithoutProjection(
    "public-subpath-discovery",
    inspectionRequestSchemas["public-subpath-discovery"]
  ),
  "signature-inspection": requestEnvelopeWithProjection(
    "signature-inspection",
    inspectionRequestSchemas["signature-inspection"]
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
    inspectionProtocolRequestSchemas["member-discovery"],
    inspectionProtocolRequestSchemas["inspection-plan"],
    inspectionProtocolRequestSchemas["public-interface-comparison"],
  ])
);

export const inspectionProtocolRequestSchema: Schema.Codec<
  NormalizedInspectionProtocolRequestContract,
  InspectionProtocolRequestContract
> = exactInspectionProtocolRequestSchema;

export const supportsSignatureEvidence = function supportsSignatureEvidence(
  intent: InspectionIntent
): intent is SignatureEvidenceIntent {
  return isSignatureEvidenceIntent(intent);
};

const structuredSignatureRecoveryRequestSchema =
  inspectionProtocolRequestSchemas["signature-inspection"].mapFields(
    (fields) => ({
      ...fields,
      response: Schema.Struct({
        signatureEvidence: Schema.Literal("structured"),
      }),
    })
  );

const declarationRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.declarationsWithoutSupportingTypes,
  request: Schema.toEncoded(
    inspectionProtocolRequestSchemas["declaration-inspection"]
  ),
});

const signatureRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.signaturesWithoutSupportingTypes,
  request: Schema.toEncoded(structuredSignatureRecoveryRequestSchema),
});

const searchRecoveryGuidanceSchema = Schema.Struct({
  reason: protocolRecoveryReasonSchemas.relatedExportNames,
  request: Schema.toEncoded(inspectionProtocolRequestSchemas["export-search"]),
});

const hasBoundedRecoveryBytes = function hasBoundedRecoveryBytes(
  guidance: readonly unknown[]
): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(guidance)) <=
      PROTOCOL_RECOVERY_POLICY.maximumBytes
    );
  } catch {
    return false;
  }
};

const boundedRecovery = function boundedRecovery<
  RecoverySchema extends Schema.Top &
    Schema.ConstraintDecoder<readonly unknown[]>,
>(schema: RecoverySchema): RecoverySchema["Rebuild"] {
  return schema.check(
    Schema.isMaxLength(PROTOCOL_RECOVERY_POLICY.maximumEntries),
    Schema.makeFilter(hasBoundedRecoveryBytes, {
      expected: `at most ${PROTOCOL_RECOVERY_POLICY.maximumBytes} serialized bytes`,
    })
  );
};

const searchRecoverySchema = boundedRecovery(
  Schema.Tuple([searchRecoveryGuidanceSchema])
);

const supportingTypeRecoverySchema = boundedRecovery(
  Schema.Tuple([
    declarationRecoveryGuidanceSchema,
    signatureRecoveryGuidanceSchema,
  ])
);

export const protocolRecoverySchema = Schema.Union([
  searchRecoverySchema,
  supportingTypeRecoverySchema,
]);

const structuredProjectionSchema = Schema.Struct({
  omittedEvidence: Schema.Tuple([Schema.Literal("exact-signature-text")]),
  signatureEvidence: Schema.Literal("structured"),
});

const exactProjectionSchema = Schema.Struct({
  omittedEvidence: Schema.Tuple([
    Schema.Literal("structured-signature-fields"),
  ]),
  signatureEvidence: Schema.Literal("exact"),
});

const bothProjectionSchema = Schema.Struct({
  omittedEvidence: Schema.Tuple([]),
  signatureEvidence: Schema.Literal("both"),
});

export const signatureEvidenceProjectionSchemas = {
  both: bothProjectionSchema,
  exact: exactProjectionSchema,
  structured: structuredProjectionSchema,
} as const satisfies Readonly<Record<SignatureEvidenceKind, Schema.Constraint>>;

const nonProjectedInspectionResultSchema = Schema.Union([
  inspectionResultSchemas["interface-overview"],
  inspectionResultSchemas["export-inspection"],
  inspectionResultSchemas["export-search"],
  inspectionResultSchemas["public-subpath-discovery"],
  inspectionResultSchemas["declaration-inspection"],
  inspectionResultSchemas["member-inspection"],
  inspectionResultSchemas["member-discovery"],
  inspectionResultSchemas["public-interface-comparison"],
]);

const nonProjectedInspectionOutcomeSchema = Schema.Union([
  Schema.Struct({
    result: nonProjectedInspectionResultSchema,
    status: Schema.Literal("success"),
  }),
  inspectionFailureSchema,
]);

export const exportNotFoundOutcomeSchema =
  inspectionFailureSchemas.notFound.mapFields((fields) => ({
    ...fields,
    reason: Schema.Literal("export-not-found"),
  }));

export const supportingTypeLimitOutcomeSchema =
  inspectionFailureSchemas.limit.mapFields((fields) => ({
    ...fields,
    exceededBudget: supportingTypeRecoveryBudgetSchema,
  }));

const unprojectedResponseSchema = Schema.Struct({
  outcome: nonProjectedInspectionOutcomeSchema,
  projection: omittedFieldSchema,
  protocolVersion: protocolVersionSchema,
  recovery: omittedFieldSchema,
});

const unprojectedSearchRecoveryResponseSchema = Schema.Struct({
  outcome: exportNotFoundOutcomeSchema,
  projection: omittedFieldSchema,
  protocolVersion: protocolVersionSchema,
  recovery: searchRecoverySchema,
});

const supportingTypeRecoveryResponseSchema = Schema.Struct({
  outcome: supportingTypeLimitOutcomeSchema,
  projection: omittedFieldSchema,
  protocolVersion: protocolVersionSchema,
  recovery: supportingTypeRecoverySchema,
});

const projectedResponseSchema = function projectedResponseSchema<
  OutcomeSchema extends Schema.Constraint,
  ProjectionSchema extends Schema.Constraint,
>(outcome: OutcomeSchema, projection: ProjectionSchema) {
  return Schema.Struct({
    outcome,
    projection,
    protocolVersion: protocolVersionSchema,
    recovery: omittedFieldSchema,
  });
};

const projectedSearchRecoveryResponseSchema =
  function projectedSearchRecoveryResponseSchema<
    ProjectionSchema extends Schema.Constraint,
  >(projection: ProjectionSchema) {
    return Schema.Struct({
      outcome: exportNotFoundOutcomeSchema,
      projection,
      protocolVersion: protocolVersionSchema,
      recovery: searchRecoverySchema,
    });
  };

const inspectionProtocolResponseSchemas = {
  both: projectedResponseSchema(
    protocolInspectionSchemas.both.outcomeSchema,
    bothProjectionSchema
  ),
  bothSearchRecovery:
    projectedSearchRecoveryResponseSchema(bothProjectionSchema),
  exact: projectedResponseSchema(
    protocolInspectionSchemas.exact.outcomeSchema,
    exactProjectionSchema
  ),
  exactSearchRecovery: projectedSearchRecoveryResponseSchema(
    exactProjectionSchema
  ),
  structured: projectedResponseSchema(
    protocolInspectionSchemas.structured.outcomeSchema,
    structuredProjectionSchema
  ),
  structuredSearchRecovery: projectedSearchRecoveryResponseSchema(
    structuredProjectionSchema
  ),
  supportingTypeRecovery: supportingTypeRecoveryResponseSchema,
  unprojected: unprojectedResponseSchema,
  unprojectedSearchRecovery: unprojectedSearchRecoveryResponseSchema,
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
  ])
);

export const inspectionProtocolResponseSchema: Schema.Codec<InspectionProtocolResponseContract> =
  exactInspectionProtocolResponseSchema;

export type StructuredInspectedSignature = Omit<InspectedSignature, "text">;

export type ExactInspectedSignature = Pick<InspectedSignature, "kind" | "text">;

export type ProtocolInspectedSignature<Evidence extends SignatureEvidenceKind> =
  Evidence extends "structured"
    ? StructuredInspectedSignature
    : Evidence extends "exact"
      ? ExactInspectedSignature
      : InspectedSignature;

export type ProtocolSignatureInspection<
  Evidence extends SignatureEvidenceKind,
> = Omit<SignatureInspection, "moduleExport"> & {
  readonly moduleExport: Omit<
    SignatureInspection["moduleExport"],
    "signatures"
  > & {
    readonly signatures: readonly ProtocolInspectedSignature<Evidence>[];
  };
};

export type ProtocolInspectionPlan<Evidence extends SignatureEvidenceKind> =
  Omit<InspectionPlan, "inspections"> & {
    readonly inspections: readonly (
      | Exclude<AtomicInspectionResult, SignatureInspection>
      | ProtocolSignatureInspection<Evidence>
    )[];
  };

export type ProtocolInspectionResult<Evidence extends SignatureEvidenceKind> =
  | ProtocolSignatureInspection<Evidence>
  | ProtocolInspectionPlan<Evidence>;

export type ProtocolInspectionOutcome<Evidence extends SignatureEvidenceKind> =
  | {
      readonly status: "success";
      readonly result: ProtocolInspectionResult<Evidence>;
    }
  | InspectionFailure;

export interface InspectionProtocolResponseOptions<
  Evidence extends SignatureEvidenceKind = SignatureEvidenceKind,
> {
  readonly signatureEvidence: Evidence;
}

export type InspectionProtocolEnvelope<
  Intent extends InspectionIntent,
  RequestByIntent extends Readonly<Record<InspectionIntent, unknown>>,
  Evidence extends SignatureEvidenceKind,
> = {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly intent: Intent;
  readonly request: RequestByIntent[Intent];
} & (Intent extends SignatureEvidenceIntent
  ? {
      readonly response?: InspectionProtocolResponseOptions<Evidence>;
    }
  : {
      readonly response?: never;
    });

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
> = InspectionProtocolRequestFrom<
  NormalizedInspectionRequestByIntent,
  Evidence
>;

export type DeclarationRecoveryGuidance =
  typeof declarationRecoveryGuidanceSchema.Type;

export type SignatureRecoveryGuidance =
  typeof signatureRecoveryGuidanceSchema.Type;

export type SearchRecoveryGuidance = typeof searchRecoveryGuidanceSchema.Type;

export type ProtocolRecovery = typeof protocolRecoverySchema.Type;

export type SignatureEvidenceProjectionFor<
  Evidence extends SignatureEvidenceKind,
> = Evidence extends "structured"
  ? {
      readonly signatureEvidence: Evidence;
      readonly omittedEvidence: readonly ["exact-signature-text"];
    }
  : Evidence extends "exact"
    ? {
        readonly signatureEvidence: Evidence;
        readonly omittedEvidence: readonly ["structured-signature-fields"];
      }
    : {
        readonly signatureEvidence: Evidence;
        readonly omittedEvidence: readonly [];
      };

export type SignatureEvidenceProjection =
  SignatureEvidenceProjectionFor<SignatureEvidenceKind>;

export type ExportNotFoundOutcome = typeof exportNotFoundOutcomeSchema.Type;

export type SupportingTypeLimitOutcome =
  typeof supportingTypeLimitOutcomeSchema.Type;

export type UnprojectedInspectionOutcome =
  | {
      readonly status: "success";
      readonly result: Exclude<
        InspectionResult,
        SignatureInspection | InspectionPlan
      >;
    }
  | InspectionFailure;

export interface UnprojectedProtocolResponse {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: UnprojectedInspectionOutcome;
  readonly projection?: never;
  readonly recovery?: never;
}

export interface SearchRecoveryProtocolResponse {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: ExportNotFoundOutcome;
  readonly projection?: never;
  readonly recovery: readonly [SearchRecoveryGuidance];
}

export interface SupportingTypeRecoveryProtocolResponse {
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly outcome: SupportingTypeLimitOutcome;
  readonly projection?: never;
  readonly recovery: readonly [
    DeclarationRecoveryGuidance,
    SignatureRecoveryGuidance,
  ];
}

export type ProjectedProtocolResponse<Evidence extends SignatureEvidenceKind> =
  {
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

export type NormalizedInspectionProtocolRequest =
  typeof inspectionProtocolRequestSchema.Type;

export type InspectionProtocolResponse =
  typeof inspectionProtocolResponseSchema.Type;

export type { SignatureEvidenceKind } from "#typepeek/inspection/model/protocol-vocabulary";
