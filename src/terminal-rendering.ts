import { isCodePointInRanges, type CodePointRange } from "#typepeek/code-point-ranges";
import type {
  ExportDeclarationSpace,
  ExportInspection,
  ExportNamespaceMember,
  InspectedDeclaration,
  InspectionResult,
  InterfaceOverview,
  PackageIdentity,
} from "#typepeek/inspection";

const UNSAFE_TERMINAL_RANGES: readonly CodePointRange[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

/**
 * Renders a validated Inspection Result as deterministic plain text. Every
 * value originating in Installed Evidence is escaped before terminal display.
 */
export function renderInspection(result: InspectionResult): string {
  return result.intent === "interface-overview"
    ? renderInterfaceOverview(result)
    : renderExportInspection(result);
}

function renderInterfaceOverview(result: InterfaceOverview): string {
  return [
    "Interface Overview",
    `Specifier: ${terminalSafeLine(result.specifier)}`,
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    ...(result.publicSubpaths.length === 0
      ? []
      : [
          `Public Subpaths (${result.publicSubpaths.length}):`,
          ...result.publicSubpaths.map(({ specifier }) => `- ${terminalSafeLine(specifier)}`),
        ]),
    `Module Exports (${result.moduleExports.length}):`,
    ...result.moduleExports.map(({ name }) => `- ${terminalSafeLine(name)}`),
  ].join("\n");
}

function renderExportInspection(result: ExportInspection): string {
  const alias =
    result.moduleExport.alias === undefined
      ? ""
      : ` (alias of ${terminalSafeLine(result.moduleExport.alias.targetName)})`;
  return [
    "Export Inspection",
    `Specifier: ${terminalSafeLine(result.specifier)}`,
    ...renderEvidenceIdentities(result.packageIdentity, result.declarationProvider),
    `Module Export: ${terminalSafeLine(result.moduleExport.name)}${alias}`,
    ...(result.moduleExport.alias === undefined
      ? []
      : ["Alias Declaration:", ...renderDeclaration(result.moduleExport.alias.declaration)]),
    "Declaration Spaces:",
    ...result.moduleExport.spaces.flatMap(renderDeclarationSpace),
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

function terminalSafeLine(value: string): string {
  // Escape rather than delete unsafe characters so hostile or ambiguous input
  // remains visible without gaining terminal control semantics.
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isUnsafeTerminalCodePoint(codePoint)
      ? `\\u{${codePoint.toString(16).toUpperCase()}}`
      : character;
  }).join("");
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return isCodePointInRanges(codePoint, UNSAFE_TERMINAL_RANGES);
}
