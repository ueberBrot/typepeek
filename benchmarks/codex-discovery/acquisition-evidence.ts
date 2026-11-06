import { Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import { decodeJson } from "#typepeek/json-data";

import { typepeekFacts } from "../support/evidence.ts";
import { signatureFact } from "../support/signature.ts";

const oracleSchema = Schema.Struct({
  declarations: Schema.Array(
    Schema.Struct({ fact: Schema.String, text: Schema.String })
  ),
  exportDeclarations: Schema.Array(Schema.String),
  facts: Schema.Array(Schema.String),
  schemaVersion: Schema.Literal(1),
  workload: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["signatures", "search"]),
    specifier: Schema.String,
    target: Schema.String,
  }),
});

export type AcquisitionOracle = typeof oracleSchema.Type;

export const decodeAcquisitionOracle = Schema.decodeUnknownSync(oracleSchema);

const commandResultSchema = Schema.Struct({
  chunk_id: Schema.String,
  exit_code: Schema.Literal(0),
  output: Schema.String,
  wall_time_seconds: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
});

const jsonContainerSchema = Schema.Union([
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.Json),
]);

const commandOutputs = function commandOutputs(value: Schema.Json): string[] {
  if (Schema.is(commandResultSchema)(value)) {
    return [value.output];
  }

  if (
    !Schema.is(jsonContainerSchema)(value) ||
    ("status" in value && value["status"] === "rejected")
  ) {
    return [];
  }

  return Object.values(value).flatMap(commandOutputs);
};

const jsonObjects = function* jsonObjects(text: string): Generator<string> {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
    } else if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        yield text.slice(start, index + 1);
        start = -1;
      }
    }
  }
};

const commandOutputText = function commandOutputText(text: string): string[] {
  const decoded: string[] = [text];

  for (const candidate of jsonObjects(text)) {
    try {
      const value = decodeJson(Schema.MutableJson, candidate);

      decoded.push(...commandOutputs(value));
    } catch {
      continue;
    }
  }

  return decoded;
};

const sourceFragments = function sourceFragments(text: string): string[] {
  const fragments: string[] = [];
  let previousFile: string | null = null;
  let previousLine: number | null = null;

  for (const line of text.split("\n")) {
    const match =
      /^(?:(?<file>.*?\.(?:[cm]?[jt]s|[jt]sx))[:-])?(?<line>\d+)[:-](?<body>.*)$/u.exec(
        line
      );

    if (match === null) {
      if (previousLine === null && fragments.length > 0) {
        fragments[fragments.length - 1] += `\n${line}`;
      } else {
        fragments.push(line);
      }

      previousFile = null;
      previousLine = null;
      continue;
    }

    const {
      file: matchedFile,
      line: number,
      body,
    } = requireDefined(match.groups);

    const file = matchedFile ?? null;
    const lineNumber = Number(number);

    if (
      file === previousFile &&
      previousLine !== null &&
      lineNumber === previousLine + 1
    ) {
      fragments[fragments.length - 1] += `\n${body}`;
    } else {
      fragments.push(requireDefined(body));
    }

    previousFile = file ?? null;
    previousLine = lineNumber;
  }

  return fragments;
};

/** Accumulates only returned evidence, preserving numbered source continuity. */
export class AcquisitionEvidence {
  private readonly sourceBodies: string[] = [];
  private readonly matched = new Set<string>();
  private readonly indexes = new Set<string>();
  private completeSearch = false;
  private readonly oracle: AcquisitionOracle;

  constructor(oracle: AcquisitionOracle) {
    this.oracle = oracle;
  }

  observe(blocks: readonly string[]) {
    const before = new Set(this.matched);
    this.observeEvidence(blocks.flatMap(commandOutputText).join("\n"));

    return {
      complete:
        this.oracle.workload.kind === "search"
          ? this.completeSearch
          : this.oracle.facts.length > 0 &&
            this.oracle.facts.every((fact) => this.matched.has(fact)),
      newFacts: [...this.matched].filter((fact) => !before.has(fact)),
    };
  }

  private observeStructuredEvidence(returnedText: string): void {
    for (const candidate of jsonObjects(returnedText)) {
      try {
        const facts = typepeekFacts(
          { ...this.oracle.workload, question: "" },
          candidate
        );

        if (
          this.oracle.workload.kind === "search" &&
          JSON.stringify(facts) === JSON.stringify(this.oracle.facts)
        ) {
          this.completeSearch = true;
        }

        if (facts.every((fact) => this.oracle.facts.includes(fact))) {
          for (const fact of facts) {
            this.matched.add(fact);
          }
        }
      } catch {
        continue;
      }
    }
  }
  private observeEvidence(returnedText: string): void {
    this.observeStructuredEvidence(returnedText);

    const numbered = returnedText.replaceAll(
      /^(?:Script completed|Wall time[^\n]*|Chunk ID:[^\n]*|Process exited[^\n]*|(?:Final )?[Oo]utput:)[\r\n]*/gmu,
      ""
    );

    this.sourceBodies.push(numbered.trim());

    const outputs = [
      ...sourceFragments(numbered),
      ...sourceFragments(this.sourceBodies.join("\n")),
    ].map((text) => {
      // Context searches can start inside a documentation comment.
      const source = /^\s*\*/u.test(text) ? `/*\n${text}` : text;

      return signatureFact("declaration", source).slice("declaration:".length);
    });

    const contains = (text: string) =>
      outputs.some((body) => ` ${body} `.includes(` ${text} `));

    for (const declaration of this.oracle.declarations) {
      const text = signatureFact("declaration", declaration.text).slice(
        "declaration:".length
      );

      if (contains(text)) {
        this.matched.add(declaration.fact);
      }
    }

    for (const declaration of this.oracle.exportDeclarations) {
      const text = signatureFact("declaration", declaration).slice(
        "declaration:".length
      );

      if (contains(text)) {
        this.indexes.add(declaration);
      }
    }

    if (
      this.oracle.workload.kind === "search" &&
      this.oracle.exportDeclarations.length > 0 &&
      this.oracle.exportDeclarations.every((declaration) =>
        this.indexes.has(declaration)
      )
    ) {
      this.completeSearch = true;

      for (const fact of this.oracle.facts) {
        this.matched.add(fact);
      }
    }
  }

  result() {
    return {
      matchedFacts: this.oracle.facts.filter((fact) => this.matched.has(fact)),
      missingExportIndexParts: this.completeSearch
        ? 0
        : this.oracle.exportDeclarations.filter(
            (declaration) => !this.indexes.has(declaration)
          ).length,
      missingFacts: this.oracle.facts.filter((fact) => !this.matched.has(fact)),
    };
  }
}
