/** Internal entrypoint for CLI adapters and tests. */
export {
  comparePublicInterfaces,
  inspectExport,
  inspectExportDeclarations,
  inspectExportMember,
  inspectExportMembers,
  inspectExportSearch,
  inspectExportSignatures,
  inspectInterfaceOverview,
  inspectPlan,
  inspectPublicSubpaths,
} from "#typepeek/inspection/core";

export {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  inspectionCapabilitiesSchema,
} from "#typepeek/inspection/protocol-metadata";

export { invokeInspectionProtocol } from "#typepeek/inspection/inspection-protocol";

export type {
  AtomicInspectionResult,
  DeclarationInspection,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSearch,
  InspectedDeclaration,
  InspectionPlan,
  InspectionPlanQuery,
  InspectionRequestByIntent,
  InspectionResult,
  InterfaceOverview,
  MemberDiscovery,
  MemberInspection,
  PackageIdentity,
  PublicInterfaceComparison,
  PublicInterfaceComparisonTarget,
  PublicSubpathDiscovery,
  ResolutionVariant,
  SignatureInspection,
} from "#typepeek/inspection/protocol";

export type { InspectionIntent } from "#typepeek/inspection/protocol-metadata";

export type { MemberPath } from "#typepeek/inspection/member-path";
