export interface DiscoveryWorkload {
  readonly id: string;
  readonly question: string;
  readonly specifier: string;
  readonly kind: "search" | "signatures";
  readonly target: string;
  readonly expectedCount?: number;
}

const DISCOVERY_WORKLOADS: readonly DiscoveryWorkload[] = [
  {
    id: "execa-command",
    question: "Find every public call signature of Execa's parseCommandString export.",
    specifier: "execa",
    kind: "signatures",
    target: "parseCommandString",
    expectedCount: 1,
  },
  {
    id: "execa-cancellation",
    question: "Find every public call signature of Execa's getCancelSignal export.",
    specifier: "execa",
    kind: "signatures",
    target: "getCancelSignal",
    expectedCount: 1,
  },
  {
    id: "execa-invocation",
    question: "Find every public call signature of the installed execa export.",
    specifier: "execa",
    kind: "signatures",
    target: "execa",
  },
  {
    id: "execa-errors",
    question: "Find all public Execa export names containing error, ignoring case.",
    specifier: "execa",
    kind: "search",
    target: "error",
    expectedCount: 2,
  },
  {
    id: "execa-absent",
    question: "Does Execa export a name containing __typepeek_absent__?",
    specifier: "execa",
    kind: "search",
    target: "__typepeek_absent__",
    expectedCount: 0,
  },
  {
    id: "node-read-file",
    question: "Find every public call signature of node:fs readFile, including overloads.",
    specifier: "node:fs",
    kind: "signatures",
    target: "readFile",
  },
  {
    id: "node-exists",
    question: "Find every public call signature of node:fs existsSync.",
    specifier: "node:fs",
    kind: "signatures",
    target: "existsSync",
    expectedCount: 1,
  },
  {
    id: "effect-option",
    question: "Find every public call signature of effect/Option getOrNull.",
    specifier: "effect/Option",
    kind: "signatures",
    target: "getOrNull",
    expectedCount: 1,
  },
  {
    id: "stricli-routes",
    question:
      "Find every public call signature of @stricli/core buildRouteMap, including its generic parameters.",
    specifier: "@stricli/core",
    kind: "signatures",
    target: "buildRouteMap",
    expectedCount: 1,
  },
  {
    id: "typescript-program",
    question: "Find every public call signature of @typescript/typescript6 createProgram.",
    specifier: "@typescript/typescript6",
    kind: "signatures",
    target: "createProgram",
  },
];

export function selectDiscoveryWorkloads(id?: string): readonly DiscoveryWorkload[] {
  const selected = DISCOVERY_WORKLOADS.filter((workload) => id === undefined || workload.id === id);
  if (selected.length === 0) {
    throw new TypeError(`Unknown discovery workload: ${id}`);
  }
  return selected;
}

export function discoveryCliArguments(workload: DiscoveryWorkload): readonly string[] {
  return [
    workload.kind === "search" ? "search" : "signatures",
    workload.specifier,
    workload.target,
    "--json",
  ];
}
