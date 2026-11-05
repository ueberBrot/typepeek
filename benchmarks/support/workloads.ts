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
    expectedCount: 1,
    id: "execa-command",
    kind: "signatures",
    question:
      "Find every public call signature of Execa's parseCommandString export.",
    specifier: "execa",
    target: "parseCommandString",
  },
  {
    expectedCount: 1,
    id: "execa-cancellation",
    kind: "signatures",
    question:
      "Find every public call signature of Execa's getCancelSignal export.",
    specifier: "execa",
    target: "getCancelSignal",
  },
  {
    id: "execa-invocation",
    kind: "signatures",
    question: "Find every public call signature of the installed execa export.",
    specifier: "execa",
    target: "execa",
  },
  {
    expectedCount: 2,
    id: "execa-errors",
    kind: "search",
    question:
      "Find all public Execa export names containing error, ignoring case.",
    specifier: "execa",
    target: "error",
  },
  {
    expectedCount: 0,
    id: "execa-absent",
    kind: "search",
    question: "Does Execa export a name containing __typepeek_absent__?",
    specifier: "execa",
    target: "__typepeek_absent__",
  },
  {
    id: "node-read-file",
    kind: "signatures",
    question:
      "Find every public call signature of node:fs readFile, including overloads.",
    specifier: "node:fs",
    target: "readFile",
  },
  {
    expectedCount: 1,
    id: "node-exists",
    kind: "signatures",
    question: "Find every public call signature of node:fs existsSync.",
    specifier: "node:fs",
    target: "existsSync",
  },
  {
    expectedCount: 1,
    id: "effect-option",
    kind: "signatures",
    question: "Find every public call signature of effect/Option getOrNull.",
    specifier: "effect/Option",
    target: "getOrNull",
  },
  {
    expectedCount: 1,
    id: "stricli-routes",
    kind: "signatures",
    question:
      "Find every public call signature of @stricli/core buildRouteMap, including its generic parameters.",
    specifier: "@stricli/core",
    target: "buildRouteMap",
  },
  {
    id: "tsrs-filesystem",
    kind: "signatures",
    question: "Find every public call signature of tsrs/fs createFileSystem.",
    specifier: "tsrs/fs",
    target: "createFileSystem",
  },
];

export const selectDiscoveryWorkloads = function selectDiscoveryWorkloads(
  id?: string
): readonly DiscoveryWorkload[] {
  const selected = DISCOVERY_WORKLOADS.filter(
    (workload) => id === undefined || workload.id === id
  );

  if (selected.length === 0) {
    throw new TypeError(`Unknown discovery workload: ${id}`);
  }

  return selected;
};

export const discoveryCliArguments = function discoveryCliArguments(
  workload: DiscoveryWorkload
): readonly string[] {
  return [
    workload.kind === "search" ? "search" : "signatures",
    workload.specifier,
    workload.target,
    "--json",
  ];
};
