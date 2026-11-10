import { existsSync, realpathSync } from "node:fs";
import nodePath from "node:path";

import {
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isModuleDeclaration,
  isStringLiteralLikeNode,
} from "tsrs/ast";
import type { FileReference, Node, SourceFile } from "tsrs/ast";
import { ModuleKind } from "tsrs/sync";
import type {
  ModuleResolutionEntry,
  RawCompilerOptions,
  ResolvedModule,
  ResolvedTypeReferenceDirective,
} from "tsrs/sync";

import { COMPILER_LIBRARY_DIRECTORY } from "#typepeek/inspection/compiler/compiler-distribution";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { isTypeScriptStandardLibraryDeclaration } from "#typepeek/inspection/compiler/typescript-standard-library";
import {
  canonicalEvidenceCandidatePath,
  isPathWithin,
} from "#typepeek/inspection/evidence/evidence-boundary";
import type { DeclarationProviderAuthority } from "#typepeek/inspection/evidence/installed-evidence";
import {
  canonicalPackageBoundary,
  canonicalPath,
  declarationProviderSegments,
  findMaterializedPackageRoot,
  findVisiblePackageForDependency,
  parsePackageNameSegments,
  readInstalledManifest,
} from "#typepeek/inspection/evidence/installed-package-boundary";
import type { PackageBoundaryObserver } from "#typepeek/inspection/evidence/installed-package-boundary";
import { StaticBoundaryInspectionError } from "#typepeek/inspection/model/errors";
import type { AccessStyle } from "#typepeek/inspection/model/protocol";

const OUTSIDE_PACKAGE_MESSAGE =
  "A declaration references source outside its installed package boundary.";

const MAX_PACKAGE_LOOKUP_CACHE_ENTRIES = 4096;

interface PackageRootCapability {
  readonly canonicalRoot: string;
  readonly logicalRoot: string;
}

interface ResolutionState {
  readonly allowedPackageRoots: Set<string>;
  readonly packageLookups: Map<string, PackageRootCapability | undefined>;
  readonly compilerWorkSession: CompilerWorkSession;
}

const isAuthorizedSourceCandidate = function isAuthorizedSourceCandidate(
  allowedRoots: ReadonlySet<string>,
  fileName: string
): boolean {
  return (
    isTypeScriptStandardLibraryDeclaration(fileName) ||
    [...allowedRoots].some((allowedRoot) =>
      isPathWithin(allowedRoot, nodePath.resolve(fileName))
    )
  );
};

const isBarePackageSpecifier = function isBarePackageSpecifier(
  specifier: string
): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("#") &&
    !specifier.startsWith("/") &&
    !nodePath.isAbsolute(specifier)
  );
};

const containingPackageRoots = function containingPackageRoots(
  state: ResolutionState,
  containingFile: string
): Set<string> {
  const canonicalContainingFile =
    canonicalEvidenceCandidatePath(containingFile);

  return new Set(
    canonicalContainingFile === undefined
      ? []
      : [...state.allowedPackageRoots].filter((root) =>
          isPathWithin(root, canonicalContainingFile)
        )
  );
};

const externalPackageCandidates = function externalPackageCandidates(
  specifier: string
): readonly {
  readonly declared: string;
  readonly expectedIdentity?: string;
  readonly physical: string;
}[] {
  const packageSegments = parsePackageNameSegments(specifier);

  if (packageSegments === undefined) {
    return [];
  }

  const packageName = packageSegments.join("/");

  const declarationProvider =
    declarationProviderSegments(packageName).join("/");

  return [
    {
      declared: packageName,
      physical: packageName,
    },
    {
      declared: packageName,
      expectedIdentity: declarationProvider,
      physical: declarationProvider,
    },
    {
      declared: declarationProvider,
      physical: declarationProvider,
    },
  ];
};

const readVisibleTypeReferenceCandidatePackageRoots =
  function readVisibleTypeReferenceCandidatePackageRoots(
    state: ResolutionState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    expectedPackageIdentity: string | undefined
  ): PackageRootCapability | undefined {
    const packageSegments = parsePackageNameSegments(physicalPackageName);

    if (packageSegments === undefined) {
      return undefined;
    }

    const { packageBoundaryObserver: observer } = state.compilerWorkSession;

    const location = findVisiblePackageForDependency(
      containingFile,
      declaredPackageName,
      packageSegments,
      observer
    );

    if (location === undefined) {
      return undefined;
    }

    if (
      expectedPackageIdentity !== undefined &&
      readInstalledManifest(location.packageRoot, observer).packageIdentity
        .name !== expectedPackageIdentity
    ) {
      return undefined;
    }

    return {
      canonicalRoot: canonicalPackageBoundary(location.packageRoot, observer),
      logicalRoot: nodePath.resolve(location.packageRoot),
    };
  };

const visibleTypeReferenceCandidatePackageRoots =
  function visibleTypeReferenceCandidatePackageRoots(
    state: ResolutionState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    expectedPackageIdentity?: string
  ): PackageRootCapability | undefined {
    state.compilerWorkSession.reserveOperations();

    // Declarations in one directory share package visibility. Include both names
    // in the key to distinguish package aliases and @types fallbacks.
    const key = JSON.stringify([
      nodePath.dirname(containingFile),
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity,
    ]);

    if (state.packageLookups.has(key)) {
      return state.packageLookups.get(key);
    }

    const roots = readVisibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity
    );

    if (state.packageLookups.size < MAX_PACKAGE_LOOKUP_CACHE_ENTRIES) {
      state.packageLookups.set(key, roots);
    }

    return roots;
  };

const moduleResolutionRoots = function moduleResolutionRoots(
  state: ResolutionState,
  specifier: string,
  containingFile: string
): ReadonlySet<string> {
  if (!isBarePackageSpecifier(specifier)) {
    return containingPackageRoots(state, containingFile);
  }

  const roots = new Set<string>();

  for (const {
    declared,
    expectedIdentity,
    physical,
  } of externalPackageCandidates(specifier)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declared,
      physical,
      expectedIdentity
    );

    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }

  return roots;
};

const isResolvedExternalPackage = function isResolvedExternalPackage(
  specifier: string,
  resolvedModule: ResolvedModule | undefined
): resolvedModule is ResolvedModule {
  // Windows junctions may not be external; root checks still prove ownership.
  return isBarePackageSpecifier(specifier) && resolvedModule !== undefined;
};

const declarationEntrypointBelongsToRoot =
  function declarationEntrypointBelongsToRoot(
    packageRoot: string,
    declarationPath: string,
    observer: PackageBoundaryObserver
  ): boolean {
    const canonicalDeclarationPath = canonicalPath(declarationPath, observer);

    if (
      canonicalDeclarationPath === undefined ||
      !isPathWithin(packageRoot, canonicalDeclarationPath)
    ) {
      return false;
    }

    const materializedOwner = findMaterializedPackageRoot(
      canonicalDeclarationPath,
      observer
    );

    return materializedOwner === undefined || materializedOwner === packageRoot;
  };

const visibleTypeReferenceCandidateRoots =
  function visibleTypeReferenceCandidateRoots(
    state: ResolutionState,
    containingFile: string,
    declaredPackageName: string,
    physicalPackageName: string,
    resolvedFileName: string,
    expectedPackageIdentity?: string
  ): PackageRootCapability | undefined {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      declaredPackageName,
      physicalPackageName,
      expectedPackageIdentity
    );

    return packageRoots !== undefined &&
      declarationEntrypointBelongsToRoot(
        packageRoots.canonicalRoot,
        resolvedFileName,
        state.compilerWorkSession.packageBoundaryObserver
      )
      ? packageRoots
      : undefined;
  };

const visibleExternalPackageRoots = function visibleExternalPackageRoots(
  state: ResolutionState,
  containingFile: string,
  specifier: string,
  resolvedFileName: string
): PackageRootCapability | undefined {
  return externalPackageCandidates(specifier)
    .map(({ declared, expectedIdentity, physical }) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        declared,
        physical,
        resolvedFileName,
        expectedIdentity
      )
    )
    .find((root) => root !== undefined);
};

const allowResolvedPackageRoots = function allowResolvedPackageRoots(
  state: ResolutionState,
  packageRoots: PackageRootCapability | undefined
): boolean {
  if (packageRoots === undefined) {
    return false;
  }

  state.allowedPackageRoots.add(packageRoots.canonicalRoot);
  state.allowedPackageRoots.add(packageRoots.logicalRoot);

  return true;
};

const authorizeExternalPackage = function authorizeExternalPackage(
  state: ResolutionState,
  specifier: string,
  containingFile: string,
  resolvedModule: ResolvedModule | undefined
): boolean {
  if (!isResolvedExternalPackage(specifier, resolvedModule)) {
    return true;
  }

  // Every referenced Package Module must be declared by the containing
  // package, including TypeScript's automatic @types fallback, even when a
  // hoisted physical installation happens to resolve.
  const packageRoots = visibleExternalPackageRoots(
    state,
    containingFile,
    specifier,
    resolvedModule.resolvedFileName
  );

  return allowResolvedPackageRoots(state, packageRoots);
};

const typeReferencePackageCandidates = function typeReferencePackageCandidates(
  referenceName: string
): readonly string[] {
  const declarationProvider =
    declarationProviderSegments(referenceName).join("/");

  return declarationProvider === referenceName
    ? [referenceName]
    : [referenceName, declarationProvider];
};

const alreadyAllowedTypeReferenceRoots =
  function alreadyAllowedTypeReferenceRoots(
    state: ResolutionState,
    referenceName: string
  ): Set<string> {
    const packageNames = new Set(typeReferencePackageCandidates(referenceName));
    const { packageBoundaryObserver: observer } = state.compilerWorkSession;

    return new Set(
      [...state.allowedPackageRoots].filter((root) =>
        packageNames.has(
          readInstalledManifest(root, observer).packageIdentity.name
        )
      )
    );
  };

const typeReferenceResolutionRoots = function typeReferenceResolutionRoots(
  state: ResolutionState,
  referenceName: string,
  containingFile: string
): ReadonlySet<string> {
  const roots = alreadyAllowedTypeReferenceRoots(state, referenceName);

  for (const candidate of typeReferencePackageCandidates(referenceName)) {
    const packageRoots = visibleTypeReferenceCandidatePackageRoots(
      state,
      containingFile,
      candidate,
      candidate
    );

    if (packageRoots !== undefined) {
      roots.add(packageRoots.canonicalRoot);
      roots.add(packageRoots.logicalRoot);
    }
  }

  return roots;
};

const visibleTypeReferenceRoots = function visibleTypeReferenceRoots(
  state: ResolutionState,
  containingFile: string,
  referenceName: string,
  resolvedFileName: string
): PackageRootCapability | undefined {
  return typeReferencePackageCandidates(referenceName)
    .map((candidate) =>
      visibleTypeReferenceCandidateRoots(
        state,
        containingFile,
        candidate,
        candidate,
        resolvedFileName
      )
    )
    .find((root) => root !== undefined);
};

const authorizeResolvedTypeReference = function authorizeResolvedTypeReference(
  state: ResolutionState,
  referenceName: string,
  containingFile: string,
  resolution: ResolvedTypeReferenceDirective
): boolean {
  const { resolvedFileName } = resolution;

  if (resolvedFileName === undefined) {
    return true;
  }

  const canonicalResolvedFile =
    canonicalEvidenceCandidatePath(resolvedFileName);

  if (
    canonicalResolvedFile !== undefined &&
    [...alreadyAllowedTypeReferenceRoots(state, referenceName)].some((root) =>
      isPathWithin(root, canonicalResolvedFile)
    )
  ) {
    return true;
  }

  const packageRoots = visibleTypeReferenceRoots(
    state,
    containingFile,
    referenceName,
    resolvedFileName
  );

  if (packageRoots === undefined) {
    return false;
  }

  return allowResolvedPackageRoots(state, packageRoots);
};

const authorizeTypeReferenceDirective =
  function authorizeTypeReferenceDirective(
    state: ResolutionState,
    referenceName: string,
    containingFile: string,
    resolution: ResolvedTypeReferenceDirective | undefined
  ): boolean {
    if (resolution === undefined) {
      return true;
    }

    return authorizeResolvedTypeReference(
      state,
      referenceName,
      containingFile,
      resolution
    );
  };

/** Owns authorized declaration dependencies and the resolution receipts used by native programs. */
export class InstalledDeclarationResolution {
  private readonly state: ResolutionState;
  private readonly moduleResolutions = new Map<string, ModuleResolutionEntry>();
  private readonly references = new Map<string, string>();
  private readonly reservedResolutions = new Set<string>();
  private readonly work: CompilerWorkSession;

  constructor(packageRoots: readonly string[], work: CompilerWorkSession) {
    this.work = work;
    this.state = {
      allowedPackageRoots: new Set(packageRoots),
      compilerWorkSession: work,
      packageLookups: new Map(),
    };
  }

  allowPackageRoot(root: DeclarationProviderAuthority["root"]): void {
    this.state.allowedPackageRoots.add(root.canonical);
    this.state.allowedPackageRoots.add(nodePath.resolve(root.logical));
  }

  containsDirectory(directory: string): boolean {
    return [...this.state.allowedPackageRoots].some((root) =>
      isPathWithin(root, directory)
    );
  }

  resolveTypeReference(
    containingFile: string,
    reference: FileReference
  ): string | undefined {
    return this.references.get(`${containingFile}\0${reference.fileName}`);
  }

  observeSource(fileName: string, canonical: string, text: string): void {
    if (isTypeScriptStandardLibraryDeclaration(canonical)) {
      this.work.observeEvidenceFile(canonical, text, "declaration");
    } else {
      const accessStyle = this.work.readEvidenceFileFormat(fileName, [
        ...this.state.allowedPackageRoots,
      ]);

      this.work.observeEvidenceFile(
        canonical,
        text,
        "declaration",
        accessStyle === undefined ? undefined : { accessStyle, path: fileName }
      );
    }
  }

  assertSource(fileName: string): string {
    if (
      !isAuthorizedSourceCandidate(this.state.allowedPackageRoots, fileName)
    ) {
      throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
    }

    const canonical = realpathSync.native(fileName);

    if (
      !isAuthorizedSourceCandidate(this.state.allowedPackageRoots, canonical)
    ) {
      throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
    }

    return canonical;
  }

  private resolveImport(
    specifier: string,
    containingFile: string,
    accessStyle: AccessStyle
  ): string | undefined {
    const roots = moduleResolutionRoots(this.state, specifier, containingFile);

    if (!isBarePackageSpecifier(specifier) && !specifier.startsWith("#")) {
      const candidate = nodePath.resolve(
        nodePath.dirname(containingFile),
        specifier
      );

      InstalledDeclarationResolution.assertRelative(roots, candidate);

      // Validate declaration substitutions before the bounded resolver hides
      // an escaping symlink as a missing file.
      const substitutions =
        new Map([
          [".js", [".ts", ".tsx", ".d.ts"]],
          [".mjs", [".mts", ".d.mts"]],
          [".cjs", [".cts", ".d.cts"]],
        ]).get(nodePath.extname(candidate)) ?? [];

      for (const extension of substitutions) {
        const substituted = candidate.replace(/\.[cm]?js$/u, extension);
        this.work.reserveOperations();

        if (existsSync(substituted)) {
          InstalledDeclarationResolution.assertRelative(roots, substituted);
          break;
        }
      }
    }

    const resolution = this.work.resolveModule(
      specifier,
      containingFile,
      [...roots],
      accessStyle
    );

    const permitted = authorizeExternalPackage(
      this.state,
      specifier,
      containingFile,
      resolution
    );

    const selected = permitted ? resolution : undefined;
    const resolvedPath = selected?.resolvedFileName;
    this.moduleResolutions.set(
      JSON.stringify([
        nodePath.dirname(containingFile),
        specifier,
        accessStyle,
      ]),
      {
        containingDirectory: nodePath.dirname(containingFile),
        moduleName: specifier,
        resolutionMode:
          accessStyle === "require" ? ModuleKind.CommonJS : ModuleKind.ESNext,
        result:
          selected === undefined
            ? {}
            : {
                resolvedFileName: selected.resolvedFileName,
                ...(selected.packageId !== undefined && {
                  packageId: selected.packageId,
                }),
              },
      }
    );
    this.work.observeResolution({
      accessStyle,
      allowedRoots: [...roots],
      containingFile,
      kind: "module",
      specifier,
      ...(resolvedPath !== undefined && { resolvedPath }),
    });

    return resolvedPath;
  }

  private static assertRelative(
    roots: ReadonlySet<string>,
    candidate: string
  ): void {
    const canonical = canonicalEvidenceCandidatePath(candidate);

    if (
      canonical === undefined ||
      ![...roots].some(
        (root) =>
          isPathWithin(root, nodePath.resolve(candidate)) &&
          isPathWithin(root, canonical)
      )
    ) {
      throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
    }
  }

  private resolveReference(
    file: SourceFile,
    reference: FileReference,
    accessStyle: AccessStyle
  ): string | undefined {
    const name = reference.fileName;
    const roots = typeReferenceResolutionRoots(this.state, name, file.fileName);
    const provider = declarationProviderSegments(name).join("/");

    const resolved = [...new Set([provider, name])]
      .map((specifier) =>
        this.work.resolveModule(
          specifier,
          file.fileName,
          [...roots],
          accessStyle
        )
      )
      .find((result) => result !== undefined);

    const resolvedPath =
      resolved !== undefined &&
      authorizeTypeReferenceDirective(this.state, name, file.fileName, {
        ...resolved,
        primary: true,
      })
        ? resolved.resolvedFileName
        : undefined;

    if (resolvedPath !== undefined) {
      this.references.set(`${file.fileName}\0${name}`, resolvedPath);
    }

    this.work.observeResolution({
      accessStyle,
      allowedRoots: [...roots],
      containingFile: file.fileName,
      kind: "type-reference",
      specifier: name,
      ...(resolvedPath !== undefined && { resolvedPath }),
    });

    return resolvedPath;
  }

  scanSource(file: SourceFile) {
    const next: string[] = [];
    this.work.reserveOperations(
      file.referencedFiles.length * 3 + file.typeReferenceDirectives.length
    );

    const mode = isTypeScriptStandardLibraryDeclaration(file.fileName)
      ? "import"
      : (this.work.readEvidenceFileFormat(file.fileName, [
          ...this.state.allowedPackageRoots,
        ]) ?? "import");

    for (const reference of file.referencedFiles) {
      const path = nodePath.resolve(
        nodePath.dirname(file.fileName),
        reference.fileName
      );

      InstalledDeclarationResolution.assertRelative(
        this.state.allowedPackageRoots,
        path
      );
      next.push(path);
    }

    for (const reference of file.typeReferenceDirectives) {
      let referenceMode = mode;

      if (reference.resolutionMode === 1) {
        referenceMode = "require";
      } else if (reference.resolutionMode === 99) {
        referenceMode = "import";
      }

      const path = this.resolveReference(file, reference, referenceMode);

      if (path !== undefined) {
        next.push(path);
      }
    }

    const libraries = file.libReferenceDirectives.map((reference) =>
      nodePath.join(
        COMPILER_LIBRARY_DIRECTORY,
        `lib.${reference.fileName.toLowerCase()}.d.ts`
      )
    );

    const seen = new Set<string>();

    const localRoots = isTypeScriptStandardLibraryDeclaration(file.fileName)
      ? new Set([COMPILER_LIBRARY_DIRECTORY])
      : containingPackageRoots(this.state, file.fileName);

    const requests: {
      readonly specifier: string;
      readonly accessStyle: AccessStyle;
    }[] = [];

    const add = (specifier: string, accessStyle = mode): void => {
      // Reject lexical escapes before reserving a batch or probing the filesystem.
      if (!isBarePackageSpecifier(specifier) && !specifier.startsWith("#")) {
        const candidate = nodePath.resolve(
          nodePath.dirname(file.fileName),
          specifier
        );

        if (![...localRoots].some((root) => isPathWithin(root, candidate))) {
          throw new StaticBoundaryInspectionError(OUTSIDE_PACKAGE_MESSAGE);
        }
      }

      const key = `${accessStyle}\0${specifier}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      requests.push({ accessStyle, specifier });
    };

    const visit = (node: Node): void => {
      if (
        (isImportDeclaration(node) || isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        isStringLiteralLikeNode(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text);
      } else if (
        isImportEqualsDeclaration(node) &&
        isExternalModuleReference(node.moduleReference) &&
        isStringLiteralLikeNode(node.moduleReference.expression)
      ) {
        add(node.moduleReference.expression.text, "require");
      } else if (
        isImportTypeNode(node) &&
        isLiteralTypeNode(node.argument) &&
        isStringLiteralLikeNode(node.argument.literal)
      ) {
        const explicitMode = node.attributes?.attributes.find(
          (attribute) => attribute.name.text === "resolution-mode"
        )?.value;

        let referenceMode = mode;

        if (
          explicitMode !== undefined &&
          isStringLiteralLikeNode(explicitMode)
        ) {
          const { text: referenceText } = explicitMode;

          if (referenceText === "import" || referenceText === "require") {
            referenceMode = referenceText;
          }
        }

        add(node.argument.literal.text, referenceMode);
      } else if (
        isModuleDeclaration(node) &&
        isStringLiteralLikeNode(node.name) &&
        node.name.text.startsWith(".")
      ) {
        add(node.name.text);
      }

      node.forEachChild(visit);
    };

    visit(file);

    // Account for native resolution round trips before performing any of them.
    // A unique import reserves eight host-work units in addition to its callbacks.
    for (const { specifier, accessStyle } of requests) {
      const key = JSON.stringify([
        nodePath.dirname(file.fileName),
        specifier,
        accessStyle,
      ]);

      if (!this.reservedResolutions.has(key)) {
        this.reservedResolutions.add(key);
        this.work.reserveOperations(8);
      }
    }

    for (const { specifier, accessStyle } of requests) {
      const path = this.resolveImport(specifier, file.fileName, accessStyle);

      if (path !== undefined) {
        next.push(path);
      }
    }

    return { declarations: next, libraries };
  }

  createProgramResolution(options: RawCompilerOptions) {
    const moduleResolver = this.work.native.api.createModuleResolver(options, {
      moduleResolutions: {
        entries: [...this.moduleResolutions.values()],
        fallback: "unresolved",
      },
    });

    return {
      moduleResolver,
      typeReferenceFiles: [...this.references.values()],
    };
  }
}
