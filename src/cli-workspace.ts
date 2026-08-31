import { opendirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

import {
  hasDeclaredPackage,
  parsePackageNameSegments,
} from "#typepeek/inspection/installed-package-boundary";

const MAX_ANCESTOR_DIRECTORIES = 64;
const MAX_WORKSPACES = 128;
const MAX_WORKSPACE_CONFIG_BYTES = 256 * 1_024;
const MAX_WORKSPACE_DISCOVERY_DEPTH = 32;
const MAX_WORKSPACE_DISCOVERY_OPERATIONS = 16 * 1_024;

type WorkspaceFlag = "--workspace" | "--before-workspace" | "--after-workspace";

class WorkspaceDiscoveryLimitError extends Error {}

export function selectCliWorkspace(
  specifier: string,
  explicitWorkspace: string | undefined,
  workspaceFlag: "--workspace" | "--before-workspace" | "--after-workspace",
  currentDirectory = process.cwd(),
): string | Error {
  if (explicitWorkspace !== undefined) {
    return explicitWorkspace;
  }

  const resolutionContext = resolve(currentDirectory);
  const packageName = workspacePackageName(specifier);
  if (packageName === undefined) {
    return resolutionContext;
  }

  return selectBoundedRepositoryWorkspace(resolutionContext, packageName, specifier, workspaceFlag);
}

function selectBoundedRepositoryWorkspace(
  resolutionContext: string,
  packageName: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag,
): string | Error {
  try {
    return selectRepositoryWorkspace(resolutionContext, packageName, specifier, workspaceFlag);
  } catch (error) {
    if (error instanceof WorkspaceDiscoveryLimitError) {
      return new Error(
        `Workspace discovery exceeded its bound. Select one with ${workspaceFlag} <path>.`,
      );
    }
    throw error;
  }
}

function selectRepositoryWorkspace(
  resolutionContext: string,
  packageName: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag,
): string | Error {
  const repository = findWorkspaceRepository(resolutionContext);
  if (
    repository === undefined ||
    usesCurrentResolutionContext(repository, resolutionContext, packageName)
  ) {
    return resolutionContext;
  }

  const candidates = discoverWorkspaceDirectories(repository).filter((directory) =>
    workspaceDeclaresPackage(directory, packageName),
  );
  return selectDeclaredWorkspace(
    candidates,
    repository,
    resolutionContext,
    specifier,
    workspaceFlag,
  );
}

function usesCurrentResolutionContext(
  repository: WorkspaceRepository,
  resolutionContext: string,
  packageName: string,
): boolean {
  return (
    repository.root !== resolutionContext || workspaceDeclaresPackage(repository.root, packageName)
  );
}

function selectDeclaredWorkspace(
  candidates: readonly string[],
  repository: WorkspaceRepository,
  resolutionContext: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag,
): string | Error {
  if (candidates.length === 1) {
    return candidates[0] as string;
  }
  if (candidates.length === 0) {
    return resolutionContext;
  }
  const displayedCandidates = candidates
    .map((candidate) => displayWorkspaceCandidate(repository.root, candidate))
    .join(", ");
  return new Error(
    `Specifier "${specifier}" matches multiple consuming workspaces: ${displayedCandidates}. Select one with ${workspaceFlag} <path>.`,
  );
}

function displayWorkspaceCandidate(repositoryRoot: string, candidate: string): string {
  const relativeCandidate = relative(repositoryRoot, candidate);
  return relativeCandidate === "" ? "." : relativeCandidate.split(sep).join("/");
}

interface WorkspaceRepository {
  readonly patterns: readonly string[];
  readonly root: string;
}

function findWorkspaceRepository(startingDirectory: string): WorkspaceRepository | undefined {
  let directory = startingDirectory;
  for (let depth = 0; depth < MAX_ANCESTOR_DIRECTORIES; depth += 1) {
    const patterns = readWorkspacePatterns(directory);
    if (patterns.length > 0) {
      return { patterns, root: directory };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  throw new WorkspaceDiscoveryLimitError();
}

function readWorkspacePatterns(directory: string): readonly string[] {
  return [
    ...readManifestWorkspacePatterns(join(directory, "package.json")),
    ...readPnpmWorkspacePatterns(join(directory, "pnpm-workspace.yaml")),
  ];
}

function readManifestWorkspacePatterns(manifestPath: string): readonly string[] {
  const manifest = readJsonRecord(manifestPath);
  if (manifest === undefined) {
    return [];
  }
  const workspaces = manifest["workspaces"];
  return Array.isArray(workspaces)
    ? stringValues(workspaces)
    : stringValues(isRecord(workspaces) ? workspaces["packages"] : undefined);
}

function stringValues(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readJsonRecord(fileName: string): Readonly<Record<string, unknown>> | undefined {
  const text = readBoundedText(fileName);
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPnpmWorkspacePatterns(fileName: string): readonly string[] {
  const text = readBoundedText(fileName);
  return text === undefined ? [] : pnpmWorkspacePatterns(text);
}

function pnpmWorkspacePatterns(text: string): readonly string[] {
  const lines = text.split(/\r?\n/u);
  const packagesLine = lines.findIndex((line) => /^\s*packages\s*:\s*$/u.test(line));
  if (packagesLine === -1) {
    return [];
  }
  const packagesIndent = leadingWhitespace(lines[packagesLine] as string);
  const block = lines.slice(packagesLine + 1);
  const blockEnd = block.findIndex((line) => yamlBlockHasEnded(line, packagesIndent));
  return (blockEnd === -1 ? block : block.slice(0, blockEnd)).flatMap(pnpmWorkspacePattern);
}

function yamlBlockHasEnded(line: string, parentIndent: number): boolean {
  return !isIgnorableYamlLine(line) && leadingWhitespace(line) <= parentIndent;
}

function isIgnorableYamlLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

function pnpmWorkspacePattern(line: string): readonly string[] {
  const item = /^\s*-\s*(.+?)\s*$/u.exec(line)?.[1];
  if (item === undefined) {
    return [];
  }
  const pattern = unquoteYamlScalar(stripYamlComment(item));
  return pattern === "" ? [] : [pattern];
}

function stripYamlComment(value: string): string {
  const trimmed = value.trim();
  const quote = leadingYamlQuote(trimmed);
  const commentIndex =
    quote === undefined ? trimmed.search(/\s#/u) : closingYamlQuoteEnd(trimmed, quote);
  return commentIndex > 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

function closingYamlQuoteEnd(value: string, quote: "'" | '"'): number {
  const quotedScalar =
    quote === "'" ? /^'(?:''|[^'])*'/u.exec(value) : /^"(?:\\.|[^"\\])*"/u.exec(value);
  return quotedScalar?.[0].length ?? -1;
}

function leadingYamlQuote(value: string): "'" | '"' | undefined {
  const firstCharacter = value[0];
  if (firstCharacter !== "'" && firstCharacter !== '"') {
    return undefined;
  }
  return firstCharacter;
}

function yamlQuote(value: string): "'" | '"' | undefined {
  const quote = leadingYamlQuote(value);
  return quote !== undefined && value.length >= 2 && value.endsWith(quote) ? quote : undefined;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  return yamlQuote(trimmed) === undefined ? trimmed : trimmed.slice(1, -1);
}

function readBoundedText(fileName: string): string | undefined {
  const fileSize = readableFileSize(fileName);
  if (fileSize === undefined) {
    return undefined;
  }
  if (fileSize > MAX_WORKSPACE_CONFIG_BYTES) {
    throw new WorkspaceDiscoveryLimitError();
  }
  return readText(fileName);
}

function readableFileSize(fileName: string): number | undefined {
  try {
    const statistics = statSync(fileName);
    return statistics.isFile() ? statistics.size : undefined;
  } catch {
    return undefined;
  }
}

function readText(fileName: string): string | undefined {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}

interface WorkspaceDiscoveryState {
  readonly directories: string[];
  operations: number;
}

interface WorkspaceDirectoryContents {
  readonly childDirectories: readonly string[];
  readonly hasManifest: boolean;
}

interface WorkspaceTraversal {
  readonly excludePatterns: readonly string[];
  readonly includePatterns: readonly string[];
  readonly state: WorkspaceDiscoveryState;
}

function discoverWorkspaceDirectories(repository: WorkspaceRepository): readonly string[] {
  const includePatterns = normalizedWorkspacePatterns(
    repository.patterns.filter((pattern) => !pattern.startsWith("!")),
  );
  const excludePatterns = normalizedWorkspacePatterns(
    repository.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1)),
  );
  const traversal: WorkspaceTraversal = {
    excludePatterns,
    includePatterns,
    state: { directories: [], operations: 0 },
  };
  visitWorkspaceDirectory(repository.root, "", 0, traversal);
  return traversal.state.directories.sort();
}

function visitWorkspaceDirectory(
  directory: string,
  relativeDirectory: string,
  depth: number,
  traversal: WorkspaceTraversal,
): void {
  enforceDiscoveryDepth(depth);
  consumeDiscoveryOperation(traversal.state);
  const contents = readWorkspaceDirectory(directory, traversal.state);
  if (contents === undefined) {
    return;
  }
  if (
    isSelectedWorkspaceDirectory(
      relativeDirectory,
      contents.hasManifest,
      traversal.includePatterns,
      traversal.excludePatterns,
    )
  ) {
    recordWorkspaceDirectory(traversal.state, directory);
  }
  for (const childDirectory of contents.childDirectories) {
    visitWorkspaceChild(directory, relativeDirectory, childDirectory, depth, traversal);
  }
}

function enforceDiscoveryDepth(depth: number): void {
  if (depth > MAX_WORKSPACE_DISCOVERY_DEPTH) {
    throw new WorkspaceDiscoveryLimitError();
  }
}

function consumeDiscoveryOperation(state: WorkspaceDiscoveryState): void {
  state.operations += 1;
  if (state.operations > MAX_WORKSPACE_DISCOVERY_OPERATIONS) {
    throw new WorkspaceDiscoveryLimitError();
  }
}

function readWorkspaceDirectory(
  directory: string,
  state: WorkspaceDiscoveryState,
): WorkspaceDirectoryContents | undefined {
  const directoryHandle = openWorkspaceDirectory(directory);
  if (directoryHandle === undefined) {
    return undefined;
  }
  try {
    return collectWorkspaceDirectoryContents(directoryHandle, state);
  } finally {
    directoryHandle.closeSync();
  }
}

function openWorkspaceDirectory(directory: string): ReturnType<typeof opendirSync> | undefined {
  try {
    return opendirSync(directory);
  } catch {
    return undefined;
  }
}

function collectWorkspaceDirectoryContents(
  directoryHandle: ReturnType<typeof opendirSync>,
  state: WorkspaceDiscoveryState,
): WorkspaceDirectoryContents {
  const childDirectories: string[] = [];
  let hasManifest = false;
  for (let entry = directoryHandle.readSync(); entry !== null; entry = directoryHandle.readSync()) {
    consumeDiscoveryOperation(state);
    hasManifest ||= isPackageManifestEntry(entry.name, entry.isFile());
    childDirectories.push(...traversableDirectoryNames(entry.name, entry.isDirectory()));
  }
  return { childDirectories, hasManifest };
}

function isPackageManifestEntry(name: string, isFile: boolean): boolean {
  return isFile && name === "package.json";
}

function traversableDirectoryNames(name: string, isDirectory: boolean): readonly string[] {
  return isTraversableDirectory(name, isDirectory) ? [name] : [];
}

function isTraversableDirectory(name: string, isDirectory: boolean): boolean {
  return isDirectory && name !== ".git" && name !== "node_modules";
}

function isSelectedWorkspaceDirectory(
  relativeDirectory: string,
  hasManifest: boolean,
  includePatterns: readonly string[],
  excludePatterns: readonly string[],
): boolean {
  return (
    relativeDirectory !== "" &&
    hasManifest &&
    matchesAnyWorkspacePattern(relativeDirectory, includePatterns) &&
    !matchesAnyWorkspacePattern(relativeDirectory, excludePatterns)
  );
}

function recordWorkspaceDirectory(state: WorkspaceDiscoveryState, directory: string): void {
  state.directories.push(directory);
  if (state.directories.length > MAX_WORKSPACES) {
    throw new WorkspaceDiscoveryLimitError();
  }
}

function visitWorkspaceChild(
  directory: string,
  relativeDirectory: string,
  childDirectory: string,
  depth: number,
  traversal: WorkspaceTraversal,
): void {
  const childRelative =
    relativeDirectory === "" ? childDirectory : `${relativeDirectory}/${childDirectory}`;
  if (couldContainWorkspace(childRelative, traversal.includePatterns)) {
    visitWorkspaceDirectory(join(directory, childDirectory), childRelative, depth + 1, traversal);
  }
}

function normalizedWorkspacePatterns(patterns: readonly string[]): readonly string[] {
  return patterns
    .map(normalizedWorkspacePattern)
    .filter((pattern): pattern is string => pattern !== undefined);
}

function normalizedWorkspacePattern(pattern: string): string | undefined {
  const normalized = pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+$/u, "");
  return unusableWorkspacePattern(normalized) ? undefined : normalized;
}

function unusableWorkspacePattern(pattern: string): boolean {
  return [
    pattern === "",
    isAbsolute(pattern),
    pattern.split("/").includes(".."),
    pattern.includes("\0"),
  ].includes(true);
}

function matchesAnyWorkspacePattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesWorkspacePattern(path, pattern));
}

function matchesWorkspacePattern(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return false;
  }
}

function couldContainWorkspace(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternCouldContainWorkspace(path, pattern));
}

function patternCouldContainWorkspace(path: string, pattern: string): boolean {
  const patternSegments = pattern.split("/");
  return (
    hasCompatibleFixedPrefix(path, fixedPatternPrefix(patternSegments)) &&
    (matchesWorkspacePattern(path, pattern) ||
      patternSegments.includes("**") ||
      path.split("/").length < patternSegments.length)
  );
}

function fixedPatternPrefix(patternSegments: readonly string[]): string {
  const firstGlobSegment = patternSegments.findIndex((segment) => /[*?[{]/u.test(segment));
  return patternSegments
    .slice(0, firstGlobSegment === -1 ? patternSegments.length : firstGlobSegment)
    .join("/");
}

function hasCompatibleFixedPrefix(path: string, fixedPrefix: string): boolean {
  return (
    fixedPrefix === "" ||
    fixedPrefix === path ||
    fixedPrefix.startsWith(`${path}/`) ||
    path.startsWith(`${fixedPrefix}/`)
  );
}

function workspaceDeclaresPackage(directory: string, packageName: string): boolean {
  const manifest = readJsonRecord(join(directory, "package.json"));
  return manifest !== undefined && hasDeclaredPackage(manifest, packageName);
}

function workspacePackageName(specifier: string): string | undefined {
  return isBuiltin(specifier) ? undefined : parsePackageNameSegments(specifier)?.join("/");
}
