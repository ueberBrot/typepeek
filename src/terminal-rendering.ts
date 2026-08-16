import type {
  AtomicInspectionResult,
  DeclarationInspection,
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  ExportSearch,
  InspectedDeclaration,
  InspectionResult,
  InterfaceOverview,
  InspectionPlan,
  MemberInspection,
  PackageIdentity,
  PublicSubpathDiscovery,
  PublicInterfaceComparison,
  PublicInterfaceComparisonTarget,
  ResolutionVariant,
  SignatureInspection,
} from "#typepeek/inspection";
import { InspectionLimitError } from "#typepeek/inspection/errors";
import { terminalSafeLine } from "#typepeek/output-safety";

const MAX_TERMINAL_OUTPUT_BYTES = 128 * 1_024;

export interface TerminalRenderingOptions {
  readonly includePublicSubpaths?: boolean;
  readonly moduleExportMatch?: string;
}

/**
 * Renders a validated Inspection Result as deterministic plain text. Every
 * value originating in Installed Evidence is escaped before terminal display.
 */
export function renderInspection(
  result: InspectionResult,
  options: TerminalRenderingOptions = {},
): string {
  const rendered = renderInspectionResult(result, options);
  if (Buffer.byteLength(rendered) > MAX_TERMINAL_OUTPUT_BYTES) {
    throw new InspectionLimitError(
      "terminal-output",
      "Inspection exceeded its terminal output limit.",
    );
  }
  return rendered;
}

function renderInspectionResult(
  result: InspectionResult,
  options: TerminalRenderingOptions,
): string {
  return result.intent === "public-interface-comparison"
    ? renderPublicInterfaceComparison(result)
    : renderSingleTargetInspectionResult(result, options);
}

function renderSingleTargetInspectionResult(
  result: Exclude<InspectionResult, PublicInterfaceComparison>,
  options: TerminalRenderingOptions,
): string {
  switch (result.intent) {
    case "interface-overview":
      return renderInterfaceOverview(
        result,
        options.includePublicSubpaths === true,
        options.moduleExportMatch,
      );
    case "export-inspection":
      return renderExportInspection(result);
    case "signature-inspection":
      return renderSignatureInspection(result);
    case "inspection-plan":
      return renderInspectionPlan(result, options);
    case "export-search":
      return renderExportSearch(result);
    case "public-subpath-discovery":
      return renderPublicSubpathDiscovery(result);
    case "declaration-inspection":
      return renderDeclarationInspection(result);
    case "member-inspection":
      return renderMemberInspection(result);
  }
}

function renderPublicInterfaceComparison(result: PublicInterfaceComparison): string {
  return [
    "Public Interface Comparison (Interface Overview indexes)",
    ...renderComparisonTarget("Before", result.before),
    ...renderComparisonTarget("After", result.after),
    `Module Exports (${result.moduleExports.added.length} added, ${result.moduleExports.removed.length} removed):`,
    ...result.moduleExports.added.map(({ name }) => `+ ${terminalSafeLine(name)}`),
    ...result.moduleExports.removed.map(({ name }) => `- ${terminalSafeLine(name)}`),
    `Public Subpaths (${result.publicSubpaths.added.length} added, ${result.publicSubpaths.removed.length} removed):`,
    ...result.publicSubpaths.added.map(({ specifier }) => `+ ${terminalSafeLine(specifier)}`),
    ...result.publicSubpaths.removed.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`),
  ].join("\n");
}

function renderComparisonTarget(
  label: "Before" | "After",
  target: PublicInterfaceComparisonTarget,
): readonly string[] {
  return [
    `${label} Specifier: ${terminalSafeLine(target.specifier)}`,
    `${label} Access Style: ${terminalSafeLine(target.resolutionVariant.accessStyle)}`,
    ...(target.packageIdentity === undefined
      ? []
      : [`${label} Package: ${renderPackageIdentity(target.packageIdentity)}`]),
    ...(target.declarationProvider === undefined
      ? []
      : [`${label} Declaration Provider: ${renderPackageIdentity(target.declarationProvider)}`]),
  ];
}

function renderDeclarationInspection(result: DeclarationInspection): string {
  return [
    ...renderSingleTargetHeading("Declaration Inspection", result),
    ...renderDeclaredModuleExport(result.moduleExport),
  ].join("\n");
}

function renderMemberInspection(result: MemberInspection): string {
  return [
    ...renderSingleTargetHeading("Member Inspection", result),
    `Member: ${terminalSafeLine([result.moduleExportName, ...result.memberPath].join("."))}`,
    ...result.declarations.flatMap(renderDeclaration),
  ].join("\n");
}

function renderExportSearch(result: ExportSearch): string {
  return [
    ...renderSingleTargetHeading("Export Search", result),
    `Module Exports (${result.matches.length} matching "${terminalSafeLine(result.query)}"; ${result.totalModuleExports} total):`,
    ...result.matches.map(({ name }) => `- ${terminalSafeLine(name)}`),
  ].join("\n");
}

function renderPublicSubpathDiscovery(result: PublicSubpathDiscovery): string {
  return [
    ...renderSingleTargetHeading("Public Subpath Discovery", result),
    `Public Subpaths (${result.publicSubpaths.length}):`,
    ...result.publicSubpaths.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`),
  ].join("\n");
}

function renderInspectionPlan(result: InspectionPlan, options: TerminalRenderingOptions): string {
  return [
    `Inspection Plan (${result.inspections.length}):`,
    ...result.inspections.flatMap((inspection, index) => [
      `Inspection ${index + 1}:`,
      renderInspectionResult(inspection, options),
    ]),
  ].join("\n");
}

function renderInterfaceOverview(
  result: InterfaceOverview,
  includePublicSubpaths: boolean,
  moduleExportMatch: string | undefined,
): string {
  const moduleExports = matchingModuleExports(result, moduleExportMatch);
  return [
    ...renderSingleTargetHeading("Interface Overview", result),
    renderModuleExportsHeading(result, moduleExports.length, moduleExportMatch),
    ...moduleExports.map(({ name }) => `- ${terminalSafeLine(name)}`),
    includePublicSubpaths
      ? `Public Subpaths (${result.publicSubpaths.length}):`
      : `Public Subpaths (${result.publicSubpaths.length}; use --subpaths to list):`,
    ...(includePublicSubpaths
      ? result.publicSubpaths.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`)
      : []),
  ].join("\n");
}

function matchingModuleExports(
  result: InterfaceOverview,
  match: string | undefined,
): InterfaceOverview["moduleExports"] {
  if (match === undefined) {
    return result.moduleExports;
  }
  const normalizedMatch = match.toLowerCase();
  return result.moduleExports.filter(({ name }) => name.toLowerCase().includes(normalizedMatch));
}

function renderModuleExportsHeading(
  result: InterfaceOverview,
  matchedCount: number,
  match: string | undefined,
): string {
  return match === undefined
    ? `Module Exports (${result.moduleExports.length}):`
    : `Module Exports (${matchedCount} matching "${terminalSafeLine(match)}"; ${result.moduleExports.length} total):`;
}

function renderExportInspection(result: ExportInspection): string {
  return [
    ...renderSingleTargetHeading("Export Inspection", result),
    ...renderDeclaredModuleExport(result.moduleExport),
    `Signatures (${result.moduleExport.signatures.length}):`,
    ...result.moduleExport.signatures.map(
      ({ kind, text }) => `- ${terminalSafeLine(kind)}: ${terminalSafeLine(text)}`,
    ),
    `Supporting Types (${result.supportingTypes.length}):`,
    ...result.supportingTypes.flatMap(({ name, declarations }) => [
      `- ${terminalSafeLine(name)}`,
      ...declarations.flatMap(renderDeclaration),
    ]),
    ...(result.packageDocumentation === undefined
      ? []
      : [
          "Package Documentation (untrusted Installed Evidence):",
          ...result.packageDocumentation.text
            .split("\n")
            .map((line) => `| ${terminalSafeLine(line)}`),
        ]),
  ].join("\n");
}

function renderSignatureInspection(result: SignatureInspection): string {
  const alias =
    result.moduleExport.aliasTargetName === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.aliasTargetName)})`;
  return [
    ...renderSingleTargetHeading("Signature Inspection", result),
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    `Signatures (${result.moduleExport.signatures.length}):`,
    ...result.moduleExport.signatures.map(
      ({ kind, text }) => `- ${terminalSafeLine(kind)}: ${terminalSafeLine(text)}`,
    ),
  ].join("\n");
}

function renderDeclaredModuleExport(
  moduleExport: DeclarationInspection["moduleExport"] | ExportInspection["moduleExport"],
): readonly string[] {
  const alias =
    moduleExport.alias === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(moduleExport.alias.targetName)})`;
  return [
    `Module Export: ${terminalSafeLine(moduleExport.name)}${alias}`,
    ...(moduleExport.alias === undefined
      ? []
      : ["Alias Declaration:", ...renderDeclaration(moduleExport.alias.declaration)]),
    "Declaration Spaces:",
    ...moduleExport.spaces.flatMap(renderDeclarationSpace),
  ];
}

function renderDeclarationSpace(space: ExportDeclarationSpace): readonly string[] {
  return space.space === "namespace"
    ? [
        `- ${terminalSafeLine(space.space)}`,
        ...space.members.flatMap((member) => renderNamespaceMember(member, [])),
      ]
    : [`- ${terminalSafeLine(space.space)}`, ...space.declarations.flatMap(renderDeclaration)];
}

function renderNamespaceMember(
  member: ExportNamespaceMember,
  parentPath: readonly string[],
): readonly string[] {
  const path = [...parentPath, member.name];
  return [
    `  ${terminalSafeLine(path.join("."))}:`,
    ...member.declarations.flatMap(renderDeclaration),
    ...member.members.flatMap((child) => renderNamespaceMember(child, path)),
  ];
}

function renderDeclaration(declaration: InspectedDeclaration): readonly string[] {
  return [
    `  ${terminalSafeLine(declaration.kind)}:`,
    ...declaration.text.split("\n").map((line) => `    ${terminalSafeLine(line)}`),
    `  @ ${renderPackageIdentity(declaration.provenance.packageIdentity)}:${terminalSafeLine(declaration.provenance.file)}:${declaration.provenance.line}:${declaration.provenance.column}`,
  ];
}

function renderPackageIdentity(packageIdentity: PackageIdentity): string {
  const version =
    packageIdentity.version === undefined ? "" : `@${terminalSafeLine(packageIdentity.version)}`;
  return `${terminalSafeLine(packageIdentity.name)}${version}`;
}

function renderEvidenceIdentities(
  packageIdentity: PackageIdentity | undefined,
  declarationProvider: PackageIdentity | undefined,
): readonly string[] {
  return [
    ...(packageIdentity === undefined
      ? []
      : [`Package: ${renderPackageIdentity(packageIdentity)}`]),
    ...(declarationProvider === undefined
      ? []
      : [`Declaration Provider: ${renderPackageIdentity(declarationProvider)}`]),
  ];
}

function renderSingleTargetHeading(
  title: string,
  result: AtomicInspectionResult,
): readonly string[] {
  return [
    title,
    ...renderInspectionTarget(result.specifier, result.resolutionVariant),
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
  ];
}

function renderInspectionTarget(
  specifier: string,
  resolutionVariant: ResolutionVariant,
): readonly string[] {
  return [
    `Specifier: ${terminalSafeLine(specifier)}`,
    `Access Style: ${terminalSafeLine(resolutionVariant.accessStyle)}`,
  ];
}
