import { Result, Schema } from "effect";

interface LatencyWorkloadDefinition<Name extends string> {
  readonly arguments_: readonly string[];
  readonly expectation:
    | {
        readonly intent: "export-search";
        readonly matchCount: number;
        readonly query: string;
        readonly specifier: string;
      }
    | {
        readonly intent: "interface-overview" | "public-subpath-discovery";
        readonly specifier: string;
      }
    | {
        readonly exportName: string;
        readonly intent: "signature-inspection";
        readonly specifier: string;
      };
  readonly name: Name;
}

function defineLatencyWorkloads<
  const Workloads extends readonly [
    LatencyWorkloadDefinition<string>,
    ...LatencyWorkloadDefinition<string>[],
  ],
>(...workloads: Workloads): Workloads {
  return workloads;
}

const LATENCY_WORKLOADS = defineLatencyWorkloads(
  {
    name: "effect-interface-overview",
    arguments_: ["overview", "effect", "--json"],
    expectation: { intent: "interface-overview", specifier: "effect" },
  },
  {
    name: "effect-export-search",
    arguments_: ["search", "effect", "runPromise", "--json"],
    expectation: {
      intent: "export-search",
      matchCount: 0,
      query: "runPromise",
      specifier: "effect",
    },
  },
  {
    name: "effect-signature-inspection",
    arguments_: ["signatures", "effect/Effect", "runPromise", "--json"],
    expectation: {
      exportName: "runPromise",
      intent: "signature-inspection",
      specifier: "effect/Effect",
    },
  },
  {
    name: "effect-public-subpath-discovery",
    arguments_: ["subpaths", "effect", "--json"],
    expectation: { intent: "public-subpath-discovery", specifier: "effect" },
  },
  {
    name: "typescript-signature-inspection",
    arguments_: ["signatures", "@typescript/typescript6", "createProgram", "--json"],
    expectation: {
      exportName: "createProgram",
      intent: "signature-inspection",
      specifier: "@typescript/typescript6",
    },
  },
  {
    name: "execa-signature-inspection",
    arguments_: ["signatures", "execa", "execa", "--json"],
    expectation: {
      exportName: "execa",
      intent: "signature-inspection",
      specifier: "execa",
    },
  },
  {
    name: "node-signature-inspection",
    arguments_: ["signatures", "node:fs", "readFile", "--json"],
    expectation: {
      exportName: "readFile",
      intent: "signature-inspection",
      specifier: "node:fs",
    },
  },
);

export type BenchmarkLatencyCaseName = (typeof LATENCY_WORKLOADS)[number]["name"];

export const REQUIRED_LATENCY_CASES = LATENCY_WORKLOADS.map(
  ({ name }) => name,
) as unknown as readonly [BenchmarkLatencyCaseName, ...BenchmarkLatencyCaseName[]];
export const benchmarkLatencyCaseNameSchema = Schema.Literals(REQUIRED_LATENCY_CASES);
const decodeBenchmarkLatencyCaseName = Schema.decodeUnknownResult(benchmarkLatencyCaseNameSchema);

export function selectLatencyWorkloads(caseName: BenchmarkLatencyCaseName | undefined) {
  return caseName === undefined
    ? LATENCY_WORKLOADS
    : LATENCY_WORKLOADS.filter(({ name }) => name === caseName);
}

export function readLatencyWorkloadName(value: unknown): BenchmarkLatencyCaseName {
  return Result.getOrThrowWith(
    decodeBenchmarkLatencyCaseName(value),
    (cause) => new TypeError("Unknown latency workload.", { cause }),
  );
}
