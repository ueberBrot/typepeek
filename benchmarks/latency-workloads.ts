interface LatencyWorkloadDefinition<Name extends string> {
  readonly arguments_: readonly string[];
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
  { name: "effect-interface-overview", arguments_: ["overview", "effect", "--json"] },
  {
    name: "effect-export-search",
    arguments_: ["search", "effect", "runPromise", "--json"],
  },
  {
    name: "effect-signature-inspection",
    arguments_: ["signatures", "effect/Effect", "runPromise", "--json"],
  },
  {
    name: "effect-public-subpath-discovery",
    arguments_: ["subpaths", "effect", "--json"],
  },
  {
    name: "typescript-signature-inspection",
    arguments_: ["signatures", "@typescript/typescript6", "createProgram", "--json"],
  },
  {
    name: "execa-signature-inspection",
    arguments_: ["signatures", "execa", "execa", "--json"],
  },
  {
    name: "node-signature-inspection",
    arguments_: ["signatures", "node:fs", "readFile", "--json"],
  },
);

export type BenchmarkLatencyCaseName = (typeof LATENCY_WORKLOADS)[number]["name"];

export const REQUIRED_LATENCY_CASES = LATENCY_WORKLOADS.map(
  ({ name }) => name,
) as unknown as readonly [BenchmarkLatencyCaseName, ...BenchmarkLatencyCaseName[]];

export function selectLatencyWorkloads(caseName: BenchmarkLatencyCaseName | undefined) {
  return caseName === undefined
    ? LATENCY_WORKLOADS
    : LATENCY_WORKLOADS.filter(({ name }) => name === caseName);
}

export function readLatencyWorkloadName(value: string): BenchmarkLatencyCaseName {
  const workload = LATENCY_WORKLOADS.find(({ name }) => name === value);
  if (workload === undefined) {
    throw new TypeError(`Unknown latency workload: ${value}`);
  }
  return workload.name;
}
