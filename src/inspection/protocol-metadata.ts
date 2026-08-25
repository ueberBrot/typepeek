import {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
} from "#typepeek/inspection/protocol-vocabulary";
import {
  INSPECTION_REQUEST_DESCRIPTORS,
  type InspectionRequestDescriptor,
  type InspectionRequestFieldDescriptor,
} from "#typepeek/inspection/request-definitions";
import { SIGNATURE_EVIDENCE_KINDS } from "#typepeek/inspection/signature-evidence-projection";

export {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
} from "#typepeek/inspection/protocol-vocabulary";
export type {
  InspectionBudgetDimension,
  InspectionFailureReason,
  InspectionIntent,
} from "#typepeek/inspection/protocol-vocabulary";

export interface InspectionCapabilities {
  readonly intent: "capabilities";
  readonly protocolVersion: typeof INSPECTION_PROTOCOL_VERSION;
  readonly supportedProtocolVersions: readonly [typeof INSPECTION_PROTOCOL_VERSION];
  readonly supportedIntents: typeof INSPECTION_INTENTS;
  readonly failureReasons: typeof INSPECTION_FAILURE_REASONS;
  readonly budgetDimensions: typeof INSPECTION_BUDGET_DIMENSIONS;
  readonly requestDescriptors: readonly InspectionRequestDescriptor[];
  readonly responseOptions: readonly [
    {
      readonly name: "signatureEvidence";
      readonly appliesTo: readonly ["signature-inspection", "inspection-plan"];
      readonly values: typeof SIGNATURE_EVIDENCE_KINDS;
      readonly default: "structured";
    },
  ];
}

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([INSPECTION_PROTOCOL_VERSION] as const);
const RESPONSE_OPTIONS = Object.freeze([
  Object.freeze({
    name: "signatureEvidence",
    appliesTo: Object.freeze(["signature-inspection", "inspection-plan"] as const),
    values: SIGNATURE_EVIDENCE_KINDS,
    default: "structured",
  }),
] as const);
const CAPABILITIES = Object.freeze({
  intent: "capabilities",
  protocolVersion: INSPECTION_PROTOCOL_VERSION,
  supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  supportedIntents: INSPECTION_INTENTS,
  failureReasons: INSPECTION_FAILURE_REASONS,
  budgetDimensions: INSPECTION_BUDGET_DIMENSIONS,
  requestDescriptors: INSPECTION_REQUEST_DESCRIPTORS,
  responseOptions: RESPONSE_OPTIONS,
} as const satisfies InspectionCapabilities);

export type { InspectionRequestDescriptor, InspectionRequestFieldDescriptor };

/** Describes the stable protocol vocabulary available to any adapter. */
export function inspectCapabilities(): InspectionCapabilities {
  return CAPABILITIES;
}
