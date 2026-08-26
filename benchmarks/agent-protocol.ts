import { Predicate } from "effect";
import { resolve } from "node:path";

import {
  type InspectionProtocolRequest,
  type InspectionProtocolResponse,
  invokeInspectionProtocol,
} from "#typepeek/inspection";

import { type AgentWorkload, AGENT_WORKLOADS } from "./agent-workloads.ts";
import { type AgentProtocolReport, encodeAgentProtocolReport } from "./regression-policy.ts";

type ProtocolResponse = Awaited<ReturnType<typeof invokeInspectionProtocol>>;

const workloads = [];
for (const workload of AGENT_WORKLOADS) {
  switch (workload.kind) {
    case "signature-projection":
      workloads.push(await measureSignatureProjection(workload));
      break;
    case "supporting-type-recovery":
      workloads.push(await measureRecovery(workload));
      break;
    case "export-discovery":
      workloads.push(await measureExportDiscovery(workload));
      break;
  }
}

const report: AgentProtocolReport = {
  kind: "agent-protocol-benchmark",
  schemaVersion: 1,
  protocolVersion: "1",
  workloads,
};
process.stdout.write(`${JSON.stringify(encodeAgentProtocolReport(report))}\n`);

async function measureSignatureProjection(
  workload: Extract<AgentWorkload, { kind: "signature-projection" }>,
) {
  const request = withResolutionContext(workload.initialRequest);
  const structured = await invokeInspectionProtocol(request);
  const both = await invokeInspectionProtocol({
    ...request,
    response: { signatureEvidence: "both" },
  });
  const structuredBytes = serializedBytes(structured);
  const bothBytes = serializedBytes(both);
  const facts = signatureFacts(structured);
  return {
    id: workload.id,
    question: workload.question,
    passed: factsMatch(workload.expectedFacts, facts),
    facts,
    structuredBytes,
    bothBytes,
    reductionRatio: roundedRatio(1 - structuredBytes / bothBytes),
  };
}

async function measureRecovery(
  workload: Extract<AgentWorkload, { kind: "supporting-type-recovery" }>,
) {
  const initial = await invokeInspectionProtocol(withResolutionContext(workload.initialRequest));
  const signatureRecovery = initial.recovery?.find(
    ({ request }) => request.intent === "signature-inspection",
  );
  const recovered = await invokeInspectionProtocol(signatureRecovery?.request);
  const facts = recoveryFacts(initial, recovered, signatureRecovery?.request.intent);
  return {
    id: workload.id,
    question: workload.question,
    passed: factsMatch(workload.expectedFacts, facts),
    facts,
    initialStatus: initial.outcome.status,
    recoveryReason: signatureRecovery?.reason ?? "missing",
    recoveredStatus: recovered.outcome.status,
  };
}

async function measureExportDiscovery(
  workload: Extract<AgentWorkload, { kind: "export-discovery" }>,
) {
  const response = await invokeInspectionProtocol(withResolutionContext(workload.initialRequest));
  const matches = exportSearchNames(response);
  const facts = [`status:${response.outcome.status}`, ...matches.map((name) => `match:${name}`)];
  return {
    id: workload.id,
    question: workload.question,
    passed: factsMatch(workload.expectedFacts, facts),
    facts,
    matches,
  };
}

function withResolutionContext(request: InspectionProtocolRequest): InspectionProtocolRequest {
  if (request.intent === "public-interface-comparison") {
    return request;
  }
  return {
    ...request,
    request: { ...request.request, resolutionContext: resolve(".") },
  } as InspectionProtocolRequest;
}

function signatureFacts(response: ProtocolResponse): readonly string[] {
  if (response.outcome.status !== "success") {
    return [`status:${response.outcome.status}`];
  }
  const result = response.outcome.result;
  if (result.intent !== "signature-inspection") {
    return ["status:success", `intent:${result.intent}`];
  }
  const signatures = result.moduleExport.signatures;
  return [
    "status:success",
    `signature-count:${signatures.length}`,
    ...factWhen(signatures.some(hasStructuredParameters), "structured-parameters:present"),
    ...factWhen(signatures.some(hasStructuredReturns), "structured-returns:present"),
  ];
}

function recoveryFacts(
  initial: ProtocolResponse,
  recovered: InspectionProtocolResponse,
  recoveryIntent: string | undefined,
): readonly string[] {
  return [
    ...initialBudgetFacts(initial),
    ...factWhen(recoveryIntent !== undefined, `recovery:${recoveryIntent}`),
    `recovered-status:${recovered.outcome.status}`,
    ...recoveredResultFacts(recovered),
  ];
}

function initialBudgetFacts(response: ProtocolResponse): readonly string[] {
  return response.outcome.status === "limit-exceeded"
    ? [`exceeded-budget:${response.outcome.exceededBudget}`]
    : [];
}

function recoveredResultFacts(response: InspectionProtocolResponse): readonly string[] {
  if (response.outcome.status !== "success") {
    return [];
  }
  const result = response.outcome.result;
  return [
    `recovered-intent:${result.intent}`,
    ...factWhen(
      result.intent === "signature-inspection" && result.moduleExport.signatures.length > 0,
      "recovered-signatures:present",
    ),
  ];
}

function hasStructuredParameters(signature: unknown): boolean {
  return (
    Predicate.isReadonlyObject(signature) &&
    Array.isArray(signature["parameters"]) &&
    signature["parameters"].length > 0
  );
}

function hasStructuredReturns(signature: unknown): boolean {
  return Predicate.isReadonlyObject(signature) && Predicate.isReadonlyObject(signature["returns"]);
}

function factWhen(condition: boolean, fact: string): readonly string[] {
  return condition ? [fact] : [];
}

function factsMatch(expected: readonly string[], actual: readonly string[]): boolean {
  const actualFacts = new Set(actual);
  return expected.every((fact) => actualFacts.has(fact));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function roundedRatio(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function exportSearchNames(response: ProtocolResponse): readonly string[] {
  if (response.outcome.status !== "success") {
    return [];
  }
  const result = response.outcome.result;
  return result.intent === "export-search" ? result.matches.map(({ name }) => name) : [];
}
