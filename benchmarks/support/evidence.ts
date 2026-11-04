import { Schema } from "effect";

import { decodeJson } from "#typepeek/json-data";

import { signatureFact } from "./signature.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

const searchOutcomeSchema = Schema.Struct({
  result: Schema.Struct({
    intent: Schema.Literal("export-search"),
    matches: Schema.Array(Schema.Struct({ name: Schema.String })),
    query: Schema.String,
    scope: Schema.optionalKey(Schema.Never),
    specifier: Schema.String,
  }),
  status: Schema.Literal("success"),
});

const signatureOutcomeSchema = Schema.Struct({
  result: Schema.Struct({
    intent: Schema.Literals(["signature-inspection", "export-inspection"]),
    moduleExport: Schema.Struct({
      name: Schema.String,
      signatures: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["call", "construct"]),
          text: Schema.String,
        })
      ),
    }),
    specifier: Schema.String,
  }),
  status: Schema.Literal("success"),
});

const documentedSearchOutcomeSchema = Schema.Struct({
  result: Schema.Struct({
    intent: Schema.Literal("export-search"),
    matches: Schema.Array(
      signatureOutcomeSchema.fields.result.fields.moduleExport
    ),
    scope: Schema.Literal("documentation"),
    specifier: Schema.String,
  }),
  status: Schema.Literal("success"),
});

const planOutcomeSchema = Schema.Struct({
  result: Schema.Struct({
    inspections: Schema.Array(Schema.Unknown),
    intent: Schema.Literal("inspection-plan"),
  }),
  status: Schema.Literal("success"),
});

export const typepeekFacts = function typepeekFacts(
  workload: DiscoveryWorkload,
  serialized: string
): readonly string[] {
  const value = decodeJson(Schema.MutableJson, serialized);

  const outcomes = Schema.is(planOutcomeSchema)(value)
    ? value.result.inspections.map((result) => ({ result, status: "success" }))
    : [value];

  if (workload.kind === "search") {
    const outcome = outcomes
      .filter(Schema.is(searchOutcomeSchema))
      .find(
        ({ result }) =>
          result.specifier === workload.specifier &&
          result.query.toLowerCase() === workload.target.toLowerCase()
      );

    if (outcome === undefined) {
      throw new Error("Typepeek did not return the requested search.");
    }

    const { result } = outcome;

    return result.matches.map(({ name }) => name).toSorted();
  }

  const signatureOutcomes = outcomes.flatMap((outcome) =>
    Schema.is(documentedSearchOutcomeSchema)(outcome)
      ? outcome.result.matches.map((moduleExport) => ({
          result: {
            intent: "signature-inspection",
            moduleExport,
            specifier: outcome.result.specifier,
          },
          status: "success",
        }))
      : [outcome]
  );

  const outcome = signatureOutcomes
    .filter(Schema.is(signatureOutcomeSchema))
    .find(
      ({ result }) =>
        result.specifier === workload.specifier &&
        result.moduleExport.name === workload.target
    );

  if (outcome === undefined) {
    throw new Error("Typepeek did not return the requested export.");
  }

  const { result } = outcome;

  return result.moduleExport.signatures.map(({ kind, text }) =>
    signatureFact(kind, text)
  );
};
