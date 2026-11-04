import { Schema } from "effect";

const nullableNumber = Schema.NullOr(Schema.Finite);

export const acquisitionMeasurementSchema = Schema.Struct({
  evidenceBytes: Schema.Finite,
  evidenceTokens: Schema.Finite,
  invalidReason: Schema.NullOr(Schema.String),
  missingFacts: Schema.Array(Schema.String),
  retrievalSeconds: nullableNumber,
  status: Schema.Literals(["complete", "insufficient", "invalid"]),
  sufficientEvidenceMilliseconds: nullableNumber,
  taskToEvidenceSeconds: nullableNumber,
});

export const captureReceiptSchema = Schema.Struct({
  answer: Schema.String,
  error: Schema.NullOr(Schema.String),
  failureKind: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  turnCompletedMilliseconds: nullableNumber,
});

const statisticsSchema = Schema.NullOr(Schema.Struct({ mean: Schema.Finite }));

const attemptSchema = Schema.Struct({
  acquisition: Schema.optionalKey(acquisitionMeasurementSchema),
  classification: Schema.String,
  condition: Schema.String,
  instructionTokens: Schema.optionalKey(
    Schema.Struct({
      prompt: Schema.Finite,
      skill: Schema.Finite,
    })
  ),
  passed: Schema.Boolean,
  seconds: Schema.Finite,
});

export const discoveryStudySchema = Schema.Struct({
  attempts: Schema.Array(attemptSchema),
  groups: Schema.Array(
    Schema.Struct({
      condition: Schema.String,
      coverageComplete: Schema.Boolean,
      precisionWithinTenPercent: Schema.NullOr(Schema.Boolean),
      successfulEvidenceTokens: statisticsSchema,
      successfulSeconds: statisticsSchema,
      wholeRun: Schema.Struct({ successfulSeconds: statisticsSchema }),
    })
  ),
  schemaVersion: Schema.Finite,
});
