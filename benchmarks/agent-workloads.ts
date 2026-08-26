import type { InspectionProtocolRequest } from "#typepeek/inspection";

import type { BenchmarkWorkloadId } from "./regression-policy.ts";

export interface AgentWorkloadBase<Id extends BenchmarkWorkloadId> {
  readonly id: Id;
  readonly question: string;
  readonly initialRequest: InspectionProtocolRequest;
  readonly expectedFacts: readonly string[];
}

export type AgentWorkload =
  | (AgentWorkloadBase<"execa-export-discovery"> & { readonly kind: "export-discovery" })
  | (AgentWorkloadBase<"execa-invocation"> & { readonly kind: "signature-projection" })
  | (AgentWorkloadBase<"execa-export-recovery"> & {
      readonly kind: "supporting-type-recovery";
    });

export const AGENT_WORKLOADS = Object.freeze([
  {
    id: "execa-invocation",
    kind: "signature-projection",
    question: "What call signatures can invoke Execa's execa export?",
    initialRequest: {
      protocolVersion: "1",
      intent: "signature-inspection",
      request: {
        resolutionContext: "/absolute/path/to/consumer",
        specifier: "execa",
        exportName: "execa",
      },
    },
    expectedFacts: [
      "status:success",
      "signature-count:4",
      "structured-parameters:present",
      "structured-returns:present",
    ],
  },
  {
    id: "execa-export-recovery",
    kind: "supporting-type-recovery",
    question:
      "Recover a narrower authoritative answer when Execa's execa export is too deep to inspect.",
    initialRequest: {
      protocolVersion: "1",
      intent: "export-inspection",
      request: {
        resolutionContext: "/absolute/path/to/consumer",
        specifier: "execa",
        exportName: "execa",
      },
    },
    expectedFacts: [
      "exceeded-budget:supporting-type-depth",
      "recovery:signature-inspection",
      "recovered-status:success",
      "recovered-intent:signature-inspection",
      "recovered-signatures:present",
    ],
  },
  {
    id: "execa-export-discovery",
    kind: "export-discovery",
    question: "Find Execa exports whose names contain Error without reading all declarations.",
    initialRequest: {
      protocolVersion: "1",
      intent: "export-search",
      request: {
        resolutionContext: "/absolute/path/to/consumer",
        specifier: "execa",
        query: "Error",
      },
    },
    expectedFacts: ["status:success", "match:ExecaError"],
  },
] as const satisfies readonly AgentWorkload[]);
