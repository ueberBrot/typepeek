import type { Dirent } from "node:fs";
import { opendirSync } from "node:fs";
import nodePath from "node:path";

import type { CompilerWorkSession } from "#typepeek/inspection/compiler/compiler-work-session";
import {
  canonicalEvidencePath,
  isEvidenceDirectory,
  isEvidenceFile,
  isPathWithin,
} from "#typepeek/inspection/evidence/evidence-boundary";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import { requireDefined } from "#typepeek/shared/defined-value";

const MAX_PUBLIC_SUBPATH_FILE_DEPTH = 64;
const MAX_PUBLIC_SUBPATH_FILE_ENTRIES = 4096;

interface PackageFileTraversal {
  entries: number;
  readonly filesBySearchRoot: Map<string, readonly string[]>;
}

interface PackageDirectory {
  readonly canonicalAncestors: ReadonlySet<string>;
  readonly canonicalDirectory: string;
  readonly depth: number;
  readonly logicalDirectory: string;
}

interface PackageEntry {
  readonly canonicalPath: string;
  readonly kind: "directory" | "file";
  readonly logicalPath: string;
}

interface PackageSearchRoot {
  readonly canonicalDirectory: string;
  readonly logicalDirectory: string;
}

const readPackageSearchRoot = function readPackageSearchRoot(
  packageRoot: string,
  searchRoot: string
): PackageSearchRoot | undefined {
  const canonicalSearchRoot = canonicalEvidencePath(searchRoot);

  return canonicalSearchRoot !== undefined &&
    isPathWithin(packageRoot, canonicalSearchRoot) &&
    isEvidenceDirectory(canonicalSearchRoot)
    ? {
        canonicalDirectory: canonicalSearchRoot,
        logicalDirectory: searchRoot,
      }
    : undefined;
};

const readBoundedDirectoryEntries = function readBoundedDirectoryEntries(
  directory: string,
  traversal: {
    entries: number;
  }
): readonly Dirent[] {
  const entries: Dirent[] = [];
  const directoryHandle = opendirSync(directory);

  try {
    while (true) {
      const entry = directoryHandle.readSync();

      if (entry === null) {
        break;
      }

      traversal.entries += 1;

      if (traversal.entries > MAX_PUBLIC_SUBPATH_FILE_ENTRIES) {
        throw new InspectionLimitError(
          "public-subpath-files",
          "Inspection exceeded its Public Subpath file traversal limit."
        );
      }

      entries.push(entry);
    }
  } finally {
    directoryHandle.closeSync();
  }

  return entries.toSorted((left, right) => {
    if (left.name < right.name) {
      return -1;
    }

    if (left.name > right.name) {
      return 1;
    }

    return 0;
  });
};

const observeNearestReadableAncestor = function observeNearestReadableAncestor(
  packageRoot: string,
  searchRoot: string,
  traversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): void {
  if (observeEvidenceDirectory === undefined) {
    return;
  }

  let candidate = nodePath.dirname(searchRoot);

  while (isPathWithin(packageRoot, candidate)) {
    const canonicalCandidate = canonicalEvidencePath(candidate);

    if (
      canonicalCandidate !== undefined &&
      isPathWithin(packageRoot, canonicalCandidate) &&
      isEvidenceDirectory(canonicalCandidate)
    ) {
      observeEvidenceDirectory(
        canonicalCandidate,
        readBoundedDirectoryEntries(canonicalCandidate, traversal)
      );

      return;
    }

    const parent = nodePath.dirname(candidate);

    if (parent === candidate) {
      return;
    }

    candidate = parent;
  }
};

const linkedPackageEntryKind = function linkedPackageEntryKind(
  canonicalEntryPath: string
): PackageEntry["kind"] | undefined {
  if (isEvidenceDirectory(canonicalEntryPath)) {
    return "directory";
  }

  return isEvidenceFile(canonicalEntryPath) ? "file" : undefined;
};

const packageEntryKind = function packageEntryKind(
  entry: Dirent,
  canonicalEntryPath: string
): PackageEntry["kind"] | undefined {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  return entry.isSymbolicLink()
    ? linkedPackageEntryKind(canonicalEntryPath)
    : undefined;
};

const readPackageEntry = function readPackageEntry(
  packageRoot: string,
  logicalDirectory: string,
  entry: Dirent
): readonly PackageEntry[] {
  const logicalPath = nodePath.join(logicalDirectory, entry.name);
  const canonicalEntryPath = canonicalEvidencePath(logicalPath);

  if (canonicalEntryPath === undefined) {
    return [];
  }

  if (!isPathWithin(packageRoot, canonicalEntryPath)) {
    return [];
  }

  const kind = packageEntryKind(entry, canonicalEntryPath);

  return kind === undefined
    ? []
    : [{ canonicalPath: canonicalEntryPath, kind, logicalPath }];
};

const readBoundedPackageFiles = function readBoundedPackageFiles(
  packageRoot: string,
  searchRoot: string,
  traversal: PackageFileTraversal,
  observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
): readonly string[] {
  const readableSearchRoot = readPackageSearchRoot(packageRoot, searchRoot);

  if (readableSearchRoot === undefined) {
    observeNearestReadableAncestor(
      packageRoot,
      searchRoot,
      traversal,
      observeEvidenceDirectory
    );

    return [];
  }

  const files: string[] = [];

  const pending: PackageDirectory[] = [
    {
      canonicalAncestors: new Set([readableSearchRoot.canonicalDirectory]),
      canonicalDirectory: readableSearchRoot.canonicalDirectory,
      depth: 0,
      logicalDirectory: readableSearchRoot.logicalDirectory,
    },
  ];

  while (pending.length > 0) {
    const candidate = requireDefined(pending.pop());

    if (candidate.depth > MAX_PUBLIC_SUBPATH_FILE_DEPTH) {
      throw new InspectionLimitError(
        "public-subpath-files",
        "Inspection exceeded its Public Subpath file traversal depth limit."
      );
    }

    const directoryEntries = readBoundedDirectoryEntries(
      candidate.canonicalDirectory,
      traversal
    );

    observeEvidenceDirectory?.(candidate.canonicalDirectory, directoryEntries);

    const entries = directoryEntries.flatMap((entry) =>
      readPackageEntry(packageRoot, candidate.logicalDirectory, entry)
    );

    pending.push(
      ...entries
        .filter(
          (entry) =>
            entry.kind === "directory" &&
            !candidate.canonicalAncestors.has(entry.canonicalPath)
        )
        .map((entry) => ({
          canonicalAncestors: new Set([
            ...candidate.canonicalAncestors,
            entry.canonicalPath,
          ]),
          canonicalDirectory: entry.canonicalPath,
          depth: candidate.depth + 1,
          logicalDirectory: entry.logicalPath,
        }))
        .toReversed()
    );
    files.push(
      ...entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.logicalPath)
    );
  }

  return files;
};

const packageTargetCapture = function packageTargetCapture(
  packageRoot: string,
  packageFile: string,
  prefix: string,
  suffix: string
): readonly string[] {
  const target = `./${nodePath.relative(packageRoot, packageFile).split(nodePath.sep).join("/")}`;

  return target.startsWith(prefix) &&
    target.endsWith(suffix) &&
    target.length >= prefix.length + suffix.length
    ? [target.slice(prefix.length, target.length - suffix.length)]
    : [];
};

/** Owns bounded wildcard file discovery and its Installed Evidence directory receipts. */
export class PublicSubpathFiles {
  private readonly packageRoot: string;
  private readonly observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"];
  private readonly traversal: PackageFileTraversal = {
    entries: 0,
    filesBySearchRoot: new Map(),
  };

  constructor(
    packageRoot: string,
    observeEvidenceDirectory: CompilerWorkSession["observeEvidenceDirectory"]
  ) {
    this.packageRoot = packageRoot;
    this.observeEvidenceDirectory = observeEvidenceDirectory;
  }

  captures(targetPattern: string): readonly string[] {
    const wildcardIndex = targetPattern.indexOf("*");
    const prefix = targetPattern.slice(0, wildcardIndex);
    const suffix = targetPattern.slice(wildcardIndex + 1);

    const searchRoot = nodePath.join(
      this.packageRoot,
      nodePath.dirname(prefix.slice(2))
    );

    let files = this.traversal.filesBySearchRoot.get(searchRoot);

    if (files === undefined) {
      files = readBoundedPackageFiles(
        this.packageRoot,
        searchRoot,
        this.traversal,
        this.observeEvidenceDirectory
      );
      this.traversal.filesBySearchRoot.set(searchRoot, files);
    }

    return files
      .flatMap((packageFile) =>
        packageTargetCapture(this.packageRoot, packageFile, prefix, suffix)
      )
      .toSorted();
  }
}
