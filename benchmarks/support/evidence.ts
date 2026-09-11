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

export function typepeekFacts(workload: DiscoveryWorkload, serialized: string): readonly string[] {
  const value: unknown = JSON.parse(serialized);
  if (workload.kind === "search") {
    const { result } = Schema.decodeUnknownSync(searchOutcomeSchema)(value);
    if (result.specifier !== workload.specifier || result.query !== workload.target) {
      throw new Error("Typepeek answered a different search.");
    }
    return result.matches.map(({ name }) => name).sort();
  }
  const { result } = Schema.decodeUnknownSync(signatureOutcomeSchema)(value);
  if (result.specifier !== workload.specifier || result.moduleExport.name !== workload.target) {
    throw new Error("Typepeek answered a different export.");
  }
  return result.moduleExport.signatures.map(({ kind, text }) => signatureFact(kind, text));
}
