import ts from "@typescript/typescript6";
import { Schema } from "effect";

import { signatureFact } from "./signature.ts";
import type { DiscoveryWorkload } from "./workloads.ts";

const stringsSchema = Schema.Array(Schema.String);
const compilerAnswerSchema = Schema.Struct({
  facts: stringsSchema,
  files: stringsSchema,
  compilerVersion: Schema.String,
});
const fileEvidenceSchema = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  commands: Schema.Array(stringsSchema),
});
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

export const decodeCompilerAnswer = Schema.decodeUnknownSync(compilerAnswerSchema);
export const decodeFileEvidence = Schema.decodeUnknownSync(fileEvidenceSchema);

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

export function fileFacts(workload: DiscoveryWorkload, serialized: string): readonly string[] {
  const evidence = decodeFileEvidence(JSON.parse(serialized));
  const facts: string[] = [];
  const seenInterfaces = new Set<string>();
  for (const file of evidence.files) {
    const fileSignatures: string[] = [];
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        if (node.name.text !== workload.specifier.replace(/^node:/u, "")) {
          return;
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === workload.target) {
        fileSignatures.push(
          signatureFact(
            "call",
            node
              .getText(source)
              .replace(/^(?:export\s+)?(?:declare\s+)?function\s+[\w$]+\s*/u, "")
              .replace(/;$/u, ""),
          ),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const key = JSON.stringify(fileSignatures);
    if (!seenInterfaces.has(key)) facts.push(...fileSignatures);
    seenInterfaces.add(key);
  }
  return facts;
}
