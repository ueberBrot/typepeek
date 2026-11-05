import { opendirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

import { Predicate, Schema } from "effect";

import { requireDefined } from "#typepeek/defined-value";
import { hasDeclaredPackage } from "#typepeek/inspection/installed-package-boundary";
import { decodeJson, isJsonObject } from "#typepeek/json-data";

const PACKAGE_MANIFEST_FILE = "package.json";
const MAX_ANCESTOR_DIRECTORIES = 64;
const MAX_WORKSPACES = 128;
const MAX_WORKSPACE_CONFIG_BYTES = 256 * 1024;
const MAX_WORKSPACE_DISCOVERY_DEPTH = 32;
const MAX_WORKSPACE_DISCOVERY_OPERATIONS = 16 * 1024;

export class WorkspaceDiscoveryLimitError extends Error {
  override name = "WorkspaceDiscoveryLimitError";
}

const readableFileSize = function readableFileSize(
  fileName: string
): number | undefined {
  try {
    const statistics = statSync(fileName);

    return statistics.isFile() ? statistics.size : undefined;
  } catch {
    return undefined;
  }
};

const readText = function readText(fileName: string): string | undefined {
  try {
    return readFileSync(fileName, "utf-8");
  } catch {
    return undefined;
  }
};

const readBoundedText = function readBoundedText(
  fileName: string
): string | undefined {
  const fileSize = readableFileSize(fileName);

  if (fileSize === undefined) {
    return undefined;
  }

  if (fileSize > MAX_WORKSPACE_CONFIG_BYTES) {
    throw new WorkspaceDiscoveryLimitError();
  }

  return readText(fileName);
};

const readJsonRecord = function readJsonRecord(
  fileName: string
): Schema.JsonObject | undefined {
  const text = readBoundedText(fileName);

  if (text === undefined) {
    return undefined;
  }

  try {
    const value: Schema.Json = decodeJson(Schema.MutableJson, text);

    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const stringValues = function stringValues(
  value: Schema.Json | undefined
): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => Predicate.isString(entry))
    : [];
};

const readManifestWorkspacePatterns = function readManifestWorkspacePatterns(
  manifestPath: string
): readonly string[] {
  const manifest = readJsonRecord(manifestPath);

  if (manifest === undefined) {
    return [];
  }

  const { workspaces } = manifest;

  if (Array.isArray(workspaces)) {
    return stringValues(workspaces);
  }

  return stringValues(
    isJsonObject(workspaces) ? workspaces["packages"] : undefined
  );
};

const leadingWhitespace = function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
};

const isIgnorableYamlLine = function isIgnorableYamlLine(
  line: string
): boolean {
  const trimmed = line.trim();

  return trimmed === "" || trimmed.startsWith("#");
};

const yamlBlockHasEnded = function yamlBlockHasEnded(
  line: string,
  parentIndent: number
): boolean {
  if (isIgnorableYamlLine(line)) {
    return false;
  }

  const indent = leadingWhitespace(line);

  return (
    indent < parentIndent ||
    (indent === parentIndent && !/^\s*-(?:\s|$)/u.test(line))
  );
};

const leadingYamlQuote = function leadingYamlQuote(
  value: string
): "'" | '"' | undefined {
  const [firstCharacter] = value;

  if (firstCharacter !== "'" && firstCharacter !== '"') {
    return undefined;
  }

  return firstCharacter;
};

const yamlQuote = function yamlQuote(value: string): "'" | '"' | undefined {
  const quote = leadingYamlQuote(value);

  return quote !== undefined && value.length >= 2 && value.endsWith(quote)
    ? quote
    : undefined;
};

const unquoteYamlScalar = function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();

  return yamlQuote(trimmed) === undefined ? trimmed : trimmed.slice(1, -1);
};

const closingYamlQuoteEnd = function closingYamlQuoteEnd(
  value: string,
  quote: "'" | '"'
): number {
  const quotedScalar =
    quote === "'"
      ? /^'(?:''|[^'])*'/u.exec(value)
      : /^"(?:\\.|[^"\\])*"/u.exec(value);

  return quotedScalar?.[0].length ?? -1;
};

const stripYamlComment = function stripYamlComment(value: string): string {
  const trimmed = value.trim();
  const quote = leadingYamlQuote(trimmed);

  const commentIndex =
    quote === undefined
      ? trimmed.search(/\s#/u)
      : closingYamlQuoteEnd(trimmed, quote);

  return commentIndex > 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
};

const pnpmWorkspacePattern = function pnpmWorkspacePattern(
  line: string
): readonly string[] {
  const trimmed = line.trim();
  const item = trimmed.startsWith("-") ? trimmed.slice(1).trim() : undefined;

  if (item === undefined || item === "") {
    return [];
  }

  const pattern = unquoteYamlScalar(stripYamlComment(item));

  return pattern === "" ? [] : [pattern];
};

const pnpmWorkspacePatterns = function pnpmWorkspacePatterns(
  text: string
): readonly string[] {
  const lines = text.split(/\r?\n/u);

  const packagesLine = lines.findIndex((line) =>
    /^\s*packages\s*:(?:\s+#.*|\s*)$/u.test(line)
  );

  if (packagesLine === -1) {
    return [];
  }

  const packagesIndent = leadingWhitespace(requireDefined(lines[packagesLine]));
  const block = lines.slice(packagesLine + 1);

  const blockEnd = block.findIndex((line) =>
    yamlBlockHasEnded(line, packagesIndent)
  );

  return (blockEnd === -1 ? block : block.slice(0, blockEnd)).flatMap(
    pnpmWorkspacePattern
  );
};

const readPnpmWorkspacePatterns = function readPnpmWorkspacePatterns(
  fileName: string
): readonly string[] {
  const text = readBoundedText(fileName);

  return text === undefined ? [] : pnpmWorkspacePatterns(text);
};

const readWorkspacePatterns = function readWorkspacePatterns(
  directory: string
): readonly string[] {
  return [
    ...readManifestWorkspacePatterns(
      nodePath.join(directory, PACKAGE_MANIFEST_FILE)
    ),
    ...readPnpmWorkspacePatterns(
      nodePath.join(directory, "pnpm-workspace.yaml")
    ),
  ];
};

const findWorkspaceLayout = function findWorkspaceLayout(
  startingDirectory: string
): WorkspaceLayout | undefined {
  let directory = startingDirectory;

  for (let depth = 0; depth < MAX_ANCESTOR_DIRECTORIES; depth += 1) {
    const patterns = readWorkspacePatterns(directory);

    if (patterns.length > 0) {
      return { patterns, root: directory };
    }

    const parent = nodePath.dirname(directory);

    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }

  throw new WorkspaceDiscoveryLimitError();
};

const workspaceDeclaresPackage = function workspaceDeclaresPackage(
  directory: string,
  packageName: string
): boolean {
  const manifest = readJsonRecord(
    nodePath.join(directory, PACKAGE_MANIFEST_FILE)
  );

  return manifest !== undefined && hasDeclaredPackage(manifest, packageName);
};

const unusableWorkspacePattern = function unusableWorkspacePattern(
  pattern: string
): boolean {
  return [
    pattern === "",
    nodePath.isAbsolute(pattern),
    pattern.split("/").includes(".."),
    pattern.includes("\0"),
  ].includes(true);
};

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;

  while (value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
};

const normalizedWorkspacePattern = function normalizedWorkspacePattern(
  pattern: string
): string | undefined {
  const normalized = trimTrailingSlashes(
    pattern
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/)+/u, "")
  );

  return unusableWorkspacePattern(normalized) ? undefined : normalized;
};

const normalizedWorkspacePatterns = function normalizedWorkspacePatterns(
  patterns: readonly string[]
): readonly string[] {
  return patterns.flatMap((pattern) => {
    const normalized = normalizedWorkspacePattern(pattern);

    return normalized === undefined ? [] : [normalized];
  });
};

const enforceDiscoveryDepth = function enforceDiscoveryDepth(
  depth: number
): void {
  if (depth > MAX_WORKSPACE_DISCOVERY_DEPTH) {
    throw new WorkspaceDiscoveryLimitError();
  }
};

const consumeDiscoveryOperation = function consumeDiscoveryOperation(
  state: WorkspaceDiscoveryState
): void {
  state.operations += 1;

  if (state.operations > MAX_WORKSPACE_DISCOVERY_OPERATIONS) {
    throw new WorkspaceDiscoveryLimitError();
  }
};

const openWorkspaceDirectory = function openWorkspaceDirectory(
  directory: string
): ReturnType<typeof opendirSync> | undefined {
  try {
    return opendirSync(directory);
  } catch {
    return undefined;
  }
};

const isPackageManifestEntry = function isPackageManifestEntry(
  name: string,
  isFile: boolean
): boolean {
  return isFile && name === PACKAGE_MANIFEST_FILE;
};

const isTraversableDirectory = function isTraversableDirectory(
  name: string,
  isDirectory: boolean
): boolean {
  return isDirectory && name !== ".git" && name !== "node_modules";
};

const traversableDirectoryNames = function traversableDirectoryNames(
  name: string,
  isDirectory: boolean
): readonly string[] {
  return isTraversableDirectory(name, isDirectory) ? [name] : [];
};

const collectWorkspaceDirectoryContents =
  function collectWorkspaceDirectoryContents(
    directoryHandle: ReturnType<typeof opendirSync>,
    state: WorkspaceDiscoveryState
  ): WorkspaceDirectoryContents {
    const childDirectories: string[] = [];
    let hasManifest = false;

    for (
      let entry = directoryHandle.readSync();
      entry !== null;
      entry = directoryHandle.readSync()
    ) {
      consumeDiscoveryOperation(state);
      hasManifest ||= isPackageManifestEntry(entry.name, entry.isFile());
      childDirectories.push(
        ...traversableDirectoryNames(entry.name, entry.isDirectory())
      );
    }

    return { childDirectories, hasManifest };
  };

const readWorkspaceDirectory = function readWorkspaceDirectory(
  directory: string,
  state: WorkspaceDiscoveryState
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
};

const matchesWorkspacePattern = function matchesWorkspacePattern(
  path: string,
  pattern: string
): boolean {
  try {
    return nodePath.matchesGlob(path, pattern);
  } catch {
    return false;
  }
};

const matchesAnyWorkspacePattern = function matchesAnyWorkspacePattern(
  path: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) => matchesWorkspacePattern(path, pattern));
};

const isSelectedWorkspaceDirectory = function isSelectedWorkspaceDirectory(
  relativeDirectory: string,
  hasManifest: boolean,
  includePatterns: readonly string[],
  excludePatterns: readonly string[]
): boolean {
  return (
    relativeDirectory !== "" &&
    hasManifest &&
    matchesAnyWorkspacePattern(relativeDirectory, includePatterns) &&
    !matchesAnyWorkspacePattern(relativeDirectory, excludePatterns)
  );
};

const recordWorkspaceDirectory = function recordWorkspaceDirectory(
  state: WorkspaceDiscoveryState,
  directory: string
): void {
  state.directories.push(directory);

  if (state.directories.length > MAX_WORKSPACES) {
    throw new WorkspaceDiscoveryLimitError();
  }
};

const hasCompatibleFixedPrefix = function hasCompatibleFixedPrefix(
  path: string,
  fixedPrefix: string
): boolean {
  return (
    fixedPrefix === "" ||
    fixedPrefix === path ||
    fixedPrefix.startsWith(`${path}/`) ||
    path.startsWith(`${fixedPrefix}/`)
  );
};

const fixedPatternPrefix = function fixedPatternPrefix(
  patternSegments: readonly string[]
): string {
  const firstGlobSegment = patternSegments.findIndex((segment) =>
    /[*?[{]|[+@!]\(/u.test(segment)
  );

  return patternSegments
    .slice(
      0,
      firstGlobSegment === -1 ? patternSegments.length : firstGlobSegment
    )
    .join("/");
};

const patternCouldContainWorkspace = function patternCouldContainWorkspace(
  path: string,
  pattern: string
): boolean {
  const patternSegments = pattern.split("/");

  return (
    hasCompatibleFixedPrefix(path, fixedPatternPrefix(patternSegments)) &&
    (matchesWorkspacePattern(path, pattern) ||
      patternSegments.includes("**") ||
      path.split("/").length < patternSegments.length)
  );
};

const couldContainWorkspace = function couldContainWorkspace(
  path: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) =>
    patternCouldContainWorkspace(path, pattern)
  );
};

const workspaceTraversal = {
  visitWorkspaceChild(
    directory: string,
    relativeDirectory: string,
    childDirectory: string,
    depth: number,
    traversal: WorkspaceTraversal
  ): void {
    const childRelative =
      relativeDirectory === ""
        ? childDirectory
        : `${relativeDirectory}/${childDirectory}`;

    if (couldContainWorkspace(childRelative, traversal.includePatterns)) {
      workspaceTraversal.visitWorkspaceDirectory(
        nodePath.join(directory, childDirectory),
        childRelative,
        depth + 1,
        traversal
      );
    }
  },
  visitWorkspaceDirectory(
    directory: string,
    relativeDirectory: string,
    depth: number,
    traversal: WorkspaceTraversal
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
        traversal.excludePatterns
      )
    ) {
      recordWorkspaceDirectory(traversal.state, directory);
    }

    for (const childDirectory of contents.childDirectories) {
      workspaceTraversal.visitWorkspaceChild(
        directory,
        relativeDirectory,
        childDirectory,
        depth,
        traversal
      );
    }
  },
};

const discoverWorkspaceDirectories = function discoverWorkspaceDirectories(
  repository: WorkspaceLayout
): readonly string[] {
  const includePatterns = normalizedWorkspacePatterns(
    repository.patterns.filter((pattern) => !pattern.startsWith("!"))
  );

  const excludePatterns = normalizedWorkspacePatterns(
    repository.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1))
  );

  const traversal: WorkspaceTraversal = {
    excludePatterns,
    includePatterns,
    state: { directories: [], operations: 0 },
  };

  workspaceTraversal.visitWorkspaceDirectory(repository.root, "", 0, traversal);

  return traversal.state.directories.toSorted();
};

interface WorkspaceLayout {
  readonly patterns: readonly string[];
  readonly root: string;
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

export interface WorkspaceRepository {
  readonly root: string;
  readonly declaresPackage: (packageName: string) => boolean;
  readonly consumingWorkspaces: (packageName: string) => readonly string[];
}

/** Owns static workspace configuration and bounded discovery of consuming workspaces. */
export const findWorkspaceRepository = function findWorkspaceRepository(
  startingDirectory: string
): WorkspaceRepository | undefined {
  const layout = findWorkspaceLayout(startingDirectory);

  if (layout === undefined) {
    return undefined;
  }

  return {
    consumingWorkspaces(packageName) {
      return discoverWorkspaceDirectories(layout).filter((directory) =>
        workspaceDeclaresPackage(directory, packageName)
      );
    },
    declaresPackage(packageName) {
      return workspaceDeclaresPackage(layout.root, packageName);
    },
    root: layout.root,
  };
};
