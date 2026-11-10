import { existsSync } from "node:fs";
import nodePath from "node:path";

import { ScriptTarget } from "tsrs/ast";
import type { FileReference, SourceFile } from "tsrs/ast";
import { createFileSystem, createFileSystemLayer } from "tsrs/fs";
import { ModuleKind, ModuleResolutionKind } from "tsrs/sync";
import type { Program, RawCompilerOptions, Snapshot } from "tsrs/sync";

import {
  COMPILER_LIBRARY_DIRECTORY,
  COMPILER_INTRINSIC_FILE,
  COMPILER_INTRINSIC_SOURCE,
} from "#typepeek/inspection/compiler/compiler-distribution";
import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import { InstalledDeclarationResolution } from "#typepeek/inspection/compiler/installed-declaration-resolution";
import { INSPECTION_STANDARD_LIBRARY } from "#typepeek/inspection/compiler/typescript-standard-library";
import { readBoundedUtf8File } from "#typepeek/inspection/evidence/evidence-boundary";
import type { DeclarationProviderAuthority } from "#typepeek/inspection/evidence/installed-evidence";
import { canonicalPath } from "#typepeek/inspection/evidence/installed-package-boundary";
import type { PackageBoundaryObserver } from "#typepeek/inspection/evidence/installed-package-boundary";
import { INSPECTION_BUDGET_POLICY } from "#typepeek/inspection/model/budget-policy";
import {
  InspectionLimitError,
  UnsupportedInspectionError,
} from "#typepeek/inspection/model/errors";

/** Materializes only authorized Installed Evidence into an immutable SDK filesystem. */
export class InstalledProgramLoader {
  private readonly resolution: InstalledDeclarationResolution;
  private readonly texts = new Map<string, string>();
  private readonly pendingTexts = new Map<string, string>();
  private readonly dependencies = new Map<
    string,
    {
      readonly declarations: readonly string[];
      readonly libraries: readonly string[];
    }
  >();
  private readonly scanned = new Set<string>();
  private snapshot: Snapshot | undefined;
  private byteCount = 0;
  private fileCount = 0;
  private readonly work: CompilerWorkSession;
  readonly packageBoundaryObserver: PackageBoundaryObserver;

  constructor(packageRoots: readonly string[], work: CompilerWorkSession) {
    this.work = work;
    this.packageBoundaryObserver = work.packageBoundaryObserver;
    this.resolution = new InstalledDeclarationResolution(packageRoots, work);
  }

  allowPackageRoot(root: DeclarationProviderAuthority["root"]): void {
    this.resolution.allowPackageRoot(root);
  }

  resolveTypeReference(
    containingFile: string,
    reference: FileReference
  ): string | undefined {
    return this.resolution.resolveTypeReference(containingFile, reference);
  }

  findProgramSourceFile(
    program: Program,
    fileName: string
  ): SourceFile | undefined {
    this.work.reserveOperations();

    if (!existsSync(fileName)) {
      return undefined;
    }

    this.resolution.assertSource(fileName);
    const direct = program.getSourceFile(fileName);

    if (direct !== undefined) {
      return direct;
    }

    const canonical = canonicalPath(fileName, this.packageBoundaryObserver);

    return canonical === undefined
      ? undefined
      : program.getSourceFile(canonical);
  }

  private recordText(fileName: string, text: string): void {
    if (this.texts.get(fileName) !== text) {
      this.texts.set(fileName, text);
      this.pendingTexts.set(fileName, text);
    }
  }

  private captureManifests(fileName: string): void {
    for (
      let directory = nodePath.dirname(fileName);
      this.resolution.containsDirectory(directory);
      directory = nodePath.dirname(directory)
    ) {
      this.work.reserveOperations();
      const manifest = nodePath.join(directory, "package.json");

      if (!this.texts.has(manifest) && existsSync(manifest)) {
        this.resolution.assertSource(manifest);
        this.recordText(manifest, this.work.readResolutionFile(manifest));
      }

      if (nodePath.dirname(directory) === directory) {
        break;
      }
    }
  }

  private readSource(fileName: string): string | undefined {
    const cached = this.texts.get(fileName);

    if (cached !== undefined) {
      return cached;
    }

    this.work.reserveOperations(2);

    if (!existsSync(fileName)) {
      return undefined;
    }

    const canonical = this.resolution.assertSource(fileName);
    this.fileCount += 1;

    if (this.fileCount > INSPECTION_BUDGET_POLICY.declarationSourceFiles) {
      throw new InspectionLimitError(
        "declaration-files",
        "Inspection exceeded its declaration file limit."
      );
    }

    const text = readBoundedUtf8File(
      canonical,
      INSPECTION_BUDGET_POLICY.declarationSourceBytes - this.byteCount,
      "declaration-bytes",
      "Inspection exceeded its declaration byte limit."
    );

    this.byteCount += Buffer.byteLength(text);
    this.recordText(fileName, text);
    this.captureManifests(fileName);

    this.resolution.observeSource(fileName, canonical, text);

    return text;
  }

  createProgram(rootNames: readonly string[], libraries: boolean): Program {
    this.recordText(COMPILER_INTRINSIC_FILE, COMPILER_INTRINSIC_SOURCE);
    const pending = [...rootNames];

    if (libraries) {
      pending.push(
        nodePath.join(COMPILER_LIBRARY_DIRECTORY, INSPECTION_STANDARD_LIBRARY)
      );
    }

    while (pending.length > 0) {
      const fileName = pending.pop();

      if (fileName === undefined) {
        throw new Error(
          "The declaration discovery queue was unexpectedly empty."
        );
      }

      const key = `${libraries}\0${fileName}`;

      if (this.scanned.has(key)) {
        continue;
      }

      this.scanned.add(key);
      let dependencies = this.dependencies.get(fileName);

      if (dependencies === undefined) {
        const text = this.readSource(fileName);

        if (text !== undefined) {
          using lease = this.work.native.api.createSourceFile(fileName, text);
          dependencies = this.resolution.scanSource(lease.sourceFile);
          this.dependencies.set(fileName, dependencies);
        }
      }

      if (dependencies !== undefined) {
        pending.push(...dependencies.declarations);

        if (libraries) {
          pending.push(...dependencies.libraries);
        }
      }
    }

    const options: RawCompilerOptions = {
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ScriptTarget.ES2024,
      types: [],
      ...(libraries ? { lib: ["es2024"] } : { noLib: true }),
    };

    const session = this.work.native;

    const { moduleResolver, typeReferenceFiles } =
      this.resolution.createProgramResolution(options);

    const createPrograms = [
      {
        compilerOptions: options,
        options: { moduleResolver },
        rootFiles: [
          ...new Set([
            ...rootNames,
            ...typeReferenceFiles,
            COMPILER_INTRINSIC_FILE,
          ]),
        ],
      },
    ];

    this.snapshot =
      this.snapshot === undefined
        ? session.api.createSnapshot({
            createPrograms,
            fileSystem: createFileSystem([...this.texts]),
          })
        : this.snapshot.update({
            createPrograms,
            fileSystem: createFileSystemLayer([...this.pendingTexts]),
          });
    const program = this.snapshot.operation?.createdPrograms?.[0];

    if (program === undefined) {
      throw new UnsupportedInspectionError(
        "The native compiler could not materialize Installed Evidence."
      );
    }

    this.pendingTexts.clear();

    return session.retainProgram(program);
  }
}
