import { Schema } from "effect";

import { signatureFact } from "./signature.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

const searchOutcomeSchema = Schema.Struct({
  status: Schema.Literal("success"),
  result: Schema.Struct({
    intent: Schema.Literal("export-search"),
    specifier: Schema.String,
    query: Schema.String,
    matches: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});
const signatureOutcomeSchema = Schema.Struct({
  status: Schema.Literal("success"),
  result: Schema.Struct({
    intent: Schema.Literal("signature-inspection"),
    specifier: Schema.String,
    moduleExport: Schema.Struct({
      name: Schema.String,
      signatures: Schema.Array(
        Schema.Struct({ kind: Schema.Literals(["call", "construct"]), text: Schema.String }),
      ),
    }),
  }),
});
const planOutcomeSchema = Schema.Struct({
  status: Schema.Literal("success"),
  result: Schema.Struct({
    intent: Schema.Literal("inspection-plan"),
    inspections: Schema.Array(Schema.Unknown),
  }),
});

export function typepeekFacts(workload: DiscoveryWorkload, serialized: string): readonly string[] {
  const value: unknown = JSON.parse(serialized);
  const outcomes = Schema.is(planOutcomeSchema)(value)
    ? value.result.inspections.map((result) => ({ status: "success", result }))
    : [value];
  if (workload.kind === "search") {
    const outcome = outcomes
      .filter(Schema.is(searchOutcomeSchema))
      .find(
        ({ result }) =>
          result.specifier === workload.specifier &&
          result.query.toLowerCase() === workload.target.toLowerCase(),
      );
    if (outcome === undefined) throw new Error("Typepeek did not return the requested search.");
    const { result } = outcome;
    return result.matches.map(({ name }) => name).sort();
  }
  const outcome = outcomes
    .filter(Schema.is(signatureOutcomeSchema))
    .find(
      ({ result }) =>
        result.specifier === workload.specifier && result.moduleExport.name === workload.target,
    );
  if (outcome === undefined) throw new Error("Typepeek did not return the requested export.");
  const { result } = outcome;
  return result.moduleExport.signatures.map(({ kind, text }) => signatureFact(kind, text));
}
