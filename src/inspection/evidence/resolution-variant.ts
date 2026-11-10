import type { Schema } from "effect";

import type {
  CompilerWorkSession,
  PackageDeclarationResolver,
} from "#typepeek/inspection/compiler/compiler-work-session";
import { isPathWithin } from "#typepeek/inspection/evidence/evidence-boundary";
import {
  assertPublicSubpath,
  readPublicSubpaths,
} from "#typepeek/inspection/evidence/public-subpath-discovery";
import { UnsupportedInspectionError } from "#typepeek/inspection/model/errors";
import type {
  NormalizedInspectionTarget,
  PublicSubpath,
} from "#typepeek/inspection/model/protocol";

export interface ResolutionVariantSelection {
  readonly compilerWorkSession: CompilerWorkSession;
  readonly request: NormalizedInspectionTarget;
  readonly packageRoot: string;
  readonly packageRootSpecifier: string;
  readonly declarationRoots?: readonly string[];
  readonly missingDeclarationMessage?: string;
  readonly subpathKey?: string;
  readonly exports: Schema.Json | undefined;
}

export interface SelectedResolutionVariant {
  readonly declarationPath: string;
  readonly readPublicSubpaths: () => readonly PublicSubpath[];
}

const canonicalDeclaration = function canonicalDeclaration(
  declarationPath: string,
  resolver: PackageDeclarationResolver
): string {
  const canonicalDeclarationPath = resolver.canonicalPath(declarationPath);

  if (canonicalDeclarationPath === undefined) {
    throw new UnsupportedInspectionError(
      "The package has no readable declaration entrypoint."
    );
  }

  return canonicalDeclarationPath;
};

const resolveDeclarationPath = function resolveDeclarationPath(
  specifier: string,
  declarationRoots: readonly string[],
  missingDeclarationMessage: string | undefined,
  resolver: PackageDeclarationResolver
): string {
  const declarationPath = resolver.resolve(specifier);

  if (declarationPath === undefined) {
    throw new UnsupportedInspectionError(
      missingDeclarationMessage ??
        "The package has no readable declaration entrypoint."
    );
  }

  const canonicalDeclarationPath = canonicalDeclaration(
    declarationPath,
    resolver
  );

  if (
    !declarationRoots.some((root) =>
      isPathWithin(root, canonicalDeclarationPath)
    )
  ) {
    throw new UnsupportedInspectionError(
      "The package declaration entrypoint escapes its installed package boundary."
    );
  }

  return canonicalDeclarationPath;
};

/**
 * Selects one declaration entrypoint and the exact Public Subpaths exposed by
 * the same Resolution Context and Access Style. Manifest and filesystem
 * traversal are bounded and package targets never escape the installed package.
 */
export const selectResolutionVariant = function selectResolutionVariant({
  compilerWorkSession,
  request,
  packageRoot,
  packageRootSpecifier,
  declarationRoots = [packageRoot],
  missingDeclarationMessage,
  subpathKey,
  exports,
}: ResolutionVariantSelection): SelectedResolutionVariant {
  assertPublicSubpath(subpathKey, exports);

  const resolver = compilerWorkSession.createPackageResolver(
    request.resolutionContext,
    request.accessStyle,
    declarationRoots
  );

  return {
    declarationPath: resolveDeclarationPath(
      request.specifier,
      declarationRoots,
      missingDeclarationMessage,
      resolver
    ),
    readPublicSubpaths: () =>
      subpathKey === undefined
        ? readPublicSubpaths({
            declarationRoots,
            exports,
            observeEvidenceDirectory:
              compilerWorkSession.observeEvidenceDirectory,
            packageRoot,
            packageRootSpecifier,
            resolver,
          })
        : [],
  };
};
