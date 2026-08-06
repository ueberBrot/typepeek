import ts from "@typescript/typescript6";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { readBoundedUtf8File } from "#typepeek/inspection/bounded-file";
import { InspectionLimitError, UnsupportedInspectionError } from "#typepeek/inspection/errors";
import { findReferencedPackageRoot } from "#typepeek/inspection/package-evidence";
import { isPathWithin } from "#typepeek/inspection/paths";

const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;

interface CompilerHostState {
  readonly defaultHost: ts.CompilerHost;
  readonly allowedPackageRoots: Set<string>;
  sourceFileCount: number;
  sourceByteCount: number;
}

export function createBoundedCompilerHost(
  packageRoot: string,
  compilerOptions: ts.CompilerOptions,
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const canonicalPackageRoot = canonicalPath(packageRoot);
  if (canonicalPackageRoot === undefined) {
    throw new UnsupportedInspectionError(
      "The installed package boundary could not be canonicalized.",
    );
  }
  const state: CompilerHostState = {
    defaultHost,
    allowedPackageRoots: new Set([canonicalPackageRoot]),
    sourceFileCount: 0,
    sourceByteCount: 0,
  };

  return {
    ...defaultHost,
    resolveModuleNameLiterals: (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile,
    ) =>
      moduleLiterals.map((moduleLiteral) =>
        resolveModuleLiteral(
          state,
          moduleLiteral,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
        ),
      ),
    getSourceFile: (fileName, languageVersion, onError) =>
      getBoundedSourceFile(state, fileName, languageVersion, onError),
  };
}

function resolveModuleLiteral(
  state: CompilerHostState,
  moduleLiteral: ts.StringLiteralLike,
  containingFile: string,
  redirectedReference: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions,
  containingSourceFile: ts.SourceFile,
): ts.ResolvedModuleWithFailedLookupLocations {
  const resolution = ts.resolveModuleName(
    moduleLiteral.text,
    containingFile,
    options,
    state.defaultHost,
    undefined,
    redirectedReference,
    ts.getModeForUsageLocation(containingSourceFile, moduleLiteral, options),
  );
  // Only a bare package import resolved by the owned compiler can authorize
  // another Installed Evidence root. Relative paths cannot expand this set.
  authorizeExternalPackage(state, moduleLiteral.text, containingFile, resolution.resolvedModule);
  return resolution;
}

function authorizeExternalPackage(
  state: CompilerHostState,
  specifier: string,
  containingFile: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): void {
  if (!isResolvedExternalPackage(specifier, resolvedModule)) {
    return;
  }

  const packageRoot =
    findMaterializedPackageRoot(resolvedModule.resolvedFileName) ??
    findReferencedPackageRoot(containingFile, specifier, resolvedModule.resolvedFileName);
  if (packageRoot !== undefined) {
    state.allowedPackageRoots.add(packageRoot);
  }
}

function isResolvedExternalPackage(
  specifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
): resolvedModule is ts.ResolvedModuleFull {
  // TypeScript may classify workspace packages reached through Windows
  // directory junctions as non-external. The package-root checks below prove
  // that the resolved declaration is Installed Evidence without relying on
  // that platform-sensitive classification.
  return isBarePackageSpecifier(specifier) && resolvedModule !== undefined;
}

function getBoundedSourceFile(
  state: CompilerHostState,
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  onError?: (message: string) => void,
): ts.SourceFile | undefined {
  const installedSourcePath = resolveReadablePath(fileName, onError);
  if (installedSourcePath === undefined) {
    return undefined;
  }
  assertAllowedSource(state.allowedPackageRoots, installedSourcePath);
  incrementSourceFileCount(state);

  const sourceText = readSourceText(state, installedSourcePath, onError);
  return sourceText === undefined
    ? undefined
    : ts.createSourceFile(fileName, sourceText, languageVersion, true);
}

function resolveReadablePath(
  fileName: string,
  onError?: (message: string) => void,
): string | undefined {
  try {
    // Containment is checked against the canonical target so a symlink cannot
    // disguise caller project source as package-owned declarations.
    return realpathSync(fileName);
  } catch (error) {
    onError?.(String(error));
    return undefined;
  }
}

function assertAllowedSource(allowedRoots: ReadonlySet<string>, sourcePath: string): void {
  if (![...allowedRoots].some((allowedRoot) => isPathWithin(allowedRoot, sourcePath))) {
    throw new UnsupportedInspectionError(
      "A declaration references source outside its installed package boundary.",
    );
  }
}

function incrementSourceFileCount(state: CompilerHostState): void {
  state.sourceFileCount += 1;
  if (state.sourceFileCount > MAX_SOURCE_FILES) {
    throw new InspectionLimitError("Inspection exceeded its declaration file limit.");
  }
}

function readSourceText(
  state: CompilerHostState,
  sourcePath: string,
  onError?: (message: string) => void,
): string | undefined {
  try {
    const sourceText = readBoundedUtf8File(
      sourcePath,
      MAX_SOURCE_BYTES - state.sourceByteCount,
      "Inspection exceeded its declaration byte limit.",
    );
    state.sourceByteCount += Buffer.byteLength(sourceText);
    return sourceText;
  } catch (error) {
    if (error instanceof InspectionLimitError) {
      throw error;
    }
    onError?.(String(error));
    return undefined;
  }
}

function isBarePackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !isAbsolute(specifier);
}

function findMaterializedPackageRoot(resolvedFileName: string): string | undefined {
  const resolvedSourcePath = canonicalPath(resolvedFileName);
  if (resolvedSourcePath === undefined) {
    return undefined;
  }
  return findMaterializedPackageRootFrom(dirname(resolvedSourcePath));
}

function findMaterializedPackageRootFrom(startingDirectory: string): string | undefined {
  let directory = startingDirectory;
  while (true) {
    const packageRoot = packageRootAt(directory);
    if (packageRoot !== undefined) {
      return packageRoot;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function packageRootAt(directory: string): string | undefined {
  if (!isMaterializedPackageRoot(directory)) {
    return undefined;
  }
  return hasPackageManifest(directory) ? canonicalPath(directory) : undefined;
}

function isMaterializedPackageRoot(directory: string): boolean {
  const parent = dirname(directory);
  const grandparent = dirname(parent);
  return (
    basename(parent) === "node_modules" ||
    (basename(grandparent) === "node_modules" && basename(parent).startsWith("@"))
  );
}

function hasPackageManifest(directory: string): boolean {
  try {
    return statSync(join(directory, "package.json")).isFile();
  } catch {
    return false;
  }
}

function canonicalPath(fileName: string): string | undefined {
  try {
    return realpathSync(fileName);
  } catch {
    return undefined;
  }
}
