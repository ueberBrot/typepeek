import {
  INSPECTION_BUDGET_DIMENSIONS,
  INSPECTION_FAILURE_REASONS,
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
} from "#typepeek/inspection/protocol-vocabulary";

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
}

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([INSPECTION_PROTOCOL_VERSION] as const);
const CAPABILITIES = Object.freeze({
  intent: "capabilities",
  protocolVersion: INSPECTION_PROTOCOL_VERSION,
  supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
  supportedIntents: INSPECTION_INTENTS,
  failureReasons: INSPECTION_FAILURE_REASONS,
  budgetDimensions: INSPECTION_BUDGET_DIMENSIONS,
} as const satisfies InspectionCapabilities);

/** Describes the stable protocol vocabulary available to any adapter. */
export function inspectCapabilities(): InspectionCapabilities {
  return CAPABILITIES;
}
