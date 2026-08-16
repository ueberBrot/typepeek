import { runBoundedAnalysis } from "#typepeek/inspection/analysis-process";
import {
  enforceInspectionOutcome,
  type ExportInspection,
  type ExportInspectionRequest,
  type InspectionOutcome,
  type InspectionPlan,
  type InspectionPlanRequest,
  type InterfaceOverview,
  type InterfaceOverviewRequest,
  type SignatureInspection,
  type SignatureInspectionRequest,
} from "#typepeek/inspection/protocol";
import { readInspectionRequest } from "#typepeek/inspection/request-codec";

/**
 * Executes a bounded, all-or-nothing query list in one analysis process while
 * sharing declaration-provider selection and TypeScript program evidence.
 */
export async function inspectPlan(
  request: InspectionPlanRequest,
): Promise<InspectionOutcome<InspectionPlan>> {
  const requestReading = readInspectionRequest("inspection-plan", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "inspection-plan",
    await runBoundedAnalysis({ intent: "inspection-plan", request: requestReading.request }),
  );
}

/**
 * Validates a request and produces a bounded index of the Module Exports visible
 * from its Resolution Context. Analysis runs in an isolated subprocess, and its
 * result is size- and schema-checked before it crosses the Inspection Core seam.
 */
export async function inspectInterfaceOverview(
  request: InterfaceOverviewRequest,
): Promise<InspectionOutcome<InterfaceOverview>> {
  const requestReading = readInspectionRequest("interface-overview", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "interface-overview",
    await runBoundedAnalysis({
      intent: "interface-overview",
      request: requestReading.request,
    }),
  );
}

/**
 * Validates a request and produces a bounded Export Inspection for one Module
 * Export. Missing exports and all supported failure modes are returned as
 * structured outcomes rather than partial Inspection Results.
 */
export async function inspectExport(
  request: ExportInspectionRequest,
): Promise<InspectionOutcome<ExportInspection>> {
  const requestReading = readInspectionRequest("export-inspection", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "export-inspection",
    await runBoundedAnalysis({
      intent: "export-inspection",
      request: requestReading.request,
    }),
  );
}

/**
 * Validates a request and returns only the public call and construct signatures
 * for one Module Export, without traversing Supporting Types.
 */
export async function inspectExportSignatures(
  request: SignatureInspectionRequest,
): Promise<InspectionOutcome<SignatureInspection>> {
  const requestReading = readInspectionRequest("signature-inspection", request);
  if (!requestReading.accepted) {
    return requestReading.outcome;
  }

  return enforceInspectionOutcome(
    "signature-inspection",
    await runBoundedAnalysis({
      intent: "signature-inspection",
      request: requestReading.request,
    }),
  );
}
