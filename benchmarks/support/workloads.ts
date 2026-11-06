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
    id: "semver-clean",
    kind: "signatures",
    question: "Find every public call signature of semver's clean export.",
    specifier: "semver",
    target: "clean",
  },
  {
    expectedCount: 1,
    id: "node-aborted",
    kind: "signatures",
    question: "Find every public call signature of node:util aborted.",
    specifier: "node:util",
    target: "aborted",
  },
  {
    id: "semver-parse",
    kind: "signatures",
    question:
      "Find every public call signature of the installed semver parse export.",
    specifier: "semver",
    target: "parse",
  },
  {
    id: "effect-errors",
    kind: "search",
    question:
      "Find all public effect/Cause export names containing error, ignoring case.",
    specifier: "effect/Cause",
    target: "error",
  },
  {
    expectedCount: 0,
    id: "semver-absent",
    kind: "search",
    question: "Does semver export a name containing __typepeek_absent__?",
    specifier: "semver",
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
    expectedCount: 2,
    id: "effect-map",
    kind: "signatures",
    question:
      "Find every public call signature of effect/Option map, including its generic parameters.",
    specifier: "effect/Option",
    target: "map",
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
