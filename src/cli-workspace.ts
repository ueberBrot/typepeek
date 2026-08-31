import { opendirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

import { hasDeclaredPackage, parsePackageNameSegments } from "#typepeek/inspection";

const MAX_ANCESTOR_DIRECTORIES = 64;
const MAX_WORKSPACES = 128;
const MAX_WORKSPACE_CONFIG_BYTES = 256 * 1_024;
const MAX_WORKSPACE_DISCOVERY_DEPTH = 32;
const MAX_WORKSPACE_DISCOVERY_OPERATIONS = 16 * 1_024;

export type CliWorkspaceSelection =
  | { readonly status: "selected"; readonly resolutionContext: string }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly string[];
      readonly repositoryRoot: string;
    }
  | { readonly status: "limit-exceeded"; readonly repositoryRoot: string };

class WorkspaceDiscoveryLimitError extends Error {}

export function selectCliWorkspace(
  specifier: string,
  explicitWorkspace: string | undefined,
  currentDirectory = process.cwd(),
): CliWorkspaceSelection {
  if (explicitWorkspace !== undefined) {
    return { status: "selected", resolutionContext: explicitWorkspace };
  }

  const resolutionContext = resolve(currentDirectory);
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName === undefined || isBuiltin(specifier)) {
    return { status: "selected", resolutionContext };
  }

  try {
    const repository = findWorkspaceRepository(resolutionContext);
    if (
      repository === undefined ||
      repository.root !== resolutionContext ||
      workspaceDeclaresPackage(repository.root, packageName)
    ) {
      return { status: "selected", resolutionContext };
    }

    const discovery = discoverWorkspaceDirectories(repository);
    if (discovery.status === "limit-exceeded") {
      return { status: "limit-exceeded", repositoryRoot: repository.root };
    }
    const candidates = discovery.directories.filter((directory) =>
      workspaceDeclaresPackage(directory, packageName),
    );
    if (candidates.length === 1) {
      return { status: "selected", resolutionContext: candidates[0] as string };
    }
    return candidates.length > 1
      ? { status: "ambiguous", candidates, repositoryRoot: repository.root }
      : { status: "selected", resolutionContext };
  } catch (error) {
    if (error instanceof WorkspaceDiscoveryLimitError) {
      return { status: "limit-exceeded", repositoryRoot: resolutionContext };
    }
    throw error;
  }
}

export function displayWorkspaceCandidate(repositoryRoot: string, candidate: string): string {
  const relativeCandidate = relative(repositoryRoot, candidate);
  return relativeCandidate === "" ? "." : relativeCandidate.split(sep).join("/");
}

interface WorkspaceRepository {
  readonly patterns: readonly string[];
  readonly root: string;
}

type WorkspaceDiscovery =
  | { readonly status: "complete"; readonly directories: readonly string[] }
  | { readonly status: "limit-exceeded" };

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
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === "string");
  }
  if (isRecord(workspaces)) {
    const packages = workspaces["packages"];
    return Array.isArray(packages)
      ? packages.filter((value): value is string => typeof value === "string")
      : [];
  }
  return [];
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
  if (text === undefined) {
    return [];
  }
  const patterns: string[] = [];
  let packagesIndent: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const packagesMatch = /^(\s*)packages\s*:\s*$/u.exec(line);
    if (packagesMatch !== null) {
      packagesIndent = (packagesMatch[1] ?? "").length;
      continue;
    }
    if (packagesIndent === undefined || line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= packagesIndent) {
      break;
    }
    const itemMatch = /^\s*-\s*(.+?)\s*$/u.exec(line);
    if (itemMatch !== null) {
      const pattern = unquoteYamlScalar(stripYamlComment(itemMatch[1] ?? ""));
      if (pattern !== "") {
        patterns.push(pattern);
      }
    }
  }
  return patterns;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (quote === undefined && character === "#" && /\s/u.test(value[index - 1] ?? "")) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function unquoteYamlScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value.trim();
}

function readBoundedText(fileName: string): string | undefined {
  let statistics;
  try {
    statistics = statSync(fileName);
  } catch {
    return undefined;
  }
  if (!statistics.isFile()) {
    return undefined;
  }
  if (statistics.size > MAX_WORKSPACE_CONFIG_BYTES) {
    throw new WorkspaceDiscoveryLimitError();
  }
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}

function discoverWorkspaceDirectories(repository: WorkspaceRepository): WorkspaceDiscovery {
  const includePatterns = normalizedWorkspacePatterns(
    repository.patterns.filter((pattern) => !pattern.startsWith("!")),
  );
  const excludePatterns = normalizedWorkspacePatterns(
    repository.patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1)),
  );
  const directories: string[] = [];
  let operations = 0;
  let exceeded = false;

  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (exceeded || depth > MAX_WORKSPACE_DISCOVERY_DEPTH) {
      exceeded = true;
      return;
    }
    operations += 1;
    if (operations > MAX_WORKSPACE_DISCOVERY_OPERATIONS) {
      exceeded = true;
      return;
    }
    const childDirectories: string[] = [];
    let hasManifest = false;
    let directoryHandle;
    try {
      directoryHandle = opendirSync(directory);
    } catch {
      return;
    }
    try {
      for (
        let entry = directoryHandle.readSync();
        entry !== null;
        entry = directoryHandle.readSync()
      ) {
        operations += 1;
        if (operations > MAX_WORKSPACE_DISCOVERY_OPERATIONS) {
          exceeded = true;
          return;
        }
        hasManifest ||= entry.isFile() && entry.name === "package.json";
        if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) {
          childDirectories.push(entry.name);
        }
      }
    } finally {
      directoryHandle.closeSync();
    }
    if (
      relativeDirectory !== "" &&
      hasManifest &&
      matchesAnyWorkspacePattern(relativeDirectory, includePatterns) &&
      !matchesAnyWorkspacePattern(relativeDirectory, excludePatterns)
    ) {
      directories.push(directory);
      if (directories.length > MAX_WORKSPACES) {
        exceeded = true;
        return;
      }
    }
    for (const childDirectory of childDirectories) {
      const childRelative =
        relativeDirectory === "" ? childDirectory : `${relativeDirectory}/${childDirectory}`;
      if (couldContainWorkspace(childRelative, includePatterns)) {
        visit(join(directory, childDirectory), childRelative, depth + 1);
      }
    }
  };

  visit(repository.root, "", 0);
  return exceeded
    ? { status: "limit-exceeded" }
    : { status: "complete", directories: directories.sort() };
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
  if (
    normalized === "" ||
    isAbsolute(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return normalized;
}

function matchesAnyWorkspacePattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return matchesGlob(path, pattern);
    } catch {
      return false;
    }
  });
}

function couldContainWorkspace(path: string, patterns: readonly string[]): boolean {
  const pathSegments = path.split("/");
  return patterns.some((pattern) => {
    const patternSegments = pattern.split("/");
    const recursiveWildcard = patternSegments.indexOf("**");
    const firstGlobSegment = patternSegments.findIndex((segment) => /[*?[{]/u.test(segment));
    const fixedSegments = patternSegments.slice(
      0,
      firstGlobSegment === -1 ? patternSegments.length : firstGlobSegment,
    );
    const fixedPrefix = fixedSegments.join("/");
    const compatiblePrefix =
      fixedPrefix === "" ||
      fixedPrefix === path ||
      fixedPrefix.startsWith(`${path}/`) ||
      path.startsWith(`${fixedPrefix}/`);
    let matches = false;
    try {
      matches = matchesGlob(path, pattern);
    } catch {
      // Invalid patterns cannot contain a workspace.
    }
    return (
      compatiblePrefix &&
      (matches || recursiveWildcard !== -1 || pathSegments.length < patternSegments.length)
    );
  });
}

function workspaceDeclaresPackage(directory: string, packageName: string): boolean {
  const manifest = readJsonRecord(join(directory, "package.json"));
  return manifest !== undefined && hasDeclaredPackage(manifest, packageName);
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  return parsePackageNameSegments(specifier)?.join("/");
}
