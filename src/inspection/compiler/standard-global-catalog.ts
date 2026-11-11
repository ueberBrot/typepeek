import { layer } from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import { forEach as forEachEffect } from "effect/Effect";

import { COMPILER_LIBRARY_DIRECTORY } from "#typepeek/inspection/compiler/compiler-distribution";
import { COMPILER_VERSION } from "#typepeek/inspection/compiler/compiler-metadata";
import { InspectionLimitError } from "#typepeek/inspection/model/errors";
import { readBoundedFileText } from "#typepeek/platform/platform-file";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { runAdapterEffect } from "#typepeek/shared/effect-adapter";
import { bitwiseOr } from "#typepeek/shared/integer-bits";

export interface StandardGlobalCatalog {
  readonly compilerVersion: string;
  readonly traversalNodes: number;
  readonly entries: readonly (readonly [string, number])[];
}

interface StandardGlobalSpaces {
  type: boolean;
  value: boolean;
}

const MAX_STANDARD_LIBRARY_BYTES = 4 * 1024 * 1024;
const MAX_STANDARD_LIBRARY_FILES = 128;
const MAX_STANDARD_GLOBAL_NAMES = 20_000;

interface StandardNamespaceScan {
  braceDepth: number;
  globalDepth: number | null;
  readonly namespaces: {
    readonly depth: number;
    readonly prefix: readonly string[];
  }[];
  readonly topLevelDeclarationsAreGlobal: boolean;
}

const standardLibraryLimit =
  function standardLibraryLimit(): InspectionLimitError {
    return new InspectionLimitError(
      "standard-library-catalog",
      "Inspection exceeded its standard library catalog limit."
    );
  };

const standardNamespaceName = function standardNamespaceName(
  line: string
): string | undefined {
  if (/^\s*declare\s+global\s*\{/u.test(line)) {
    return "global";
  }

  return /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(?<name>[$A-Z_a-z][$\w]*)\s*\{/u.exec(
    line
  )?.groups?.["name"];
};

const collectsStandardGlobals = function collectsStandardGlobals(
  scan: StandardNamespaceScan
): boolean {
  return scan.topLevelDeclarationsAreGlobal || scan.globalDepth !== null;
};

const addStandardGlobal = function addStandardGlobal(
  names: Map<string, StandardGlobalSpaces>,
  name: string,
  space: "type" | "value" | "both"
): void {
  const current = names.get(name) ?? { type: false, value: false };
  names.set(name, {
    type: current.type || space === "type" || space === "both",
    value: current.value || space === "value" || space === "both",
  });
};

const collectStandardDeclarationLine = function collectStandardDeclarationLine(
  line: string,
  prefix: readonly string[],
  names: Map<string, StandardGlobalSpaces>,
  reserveTraversalNode: () => void
): void {
  const declarationPatterns: readonly [RegExp, "type" | "value" | "both"][] = [
    [
      /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+(?<name>[$A-Z_a-z][$\w]*)/u,
      "type",
    ],
    [
      /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|enum)\s+(?<name>[$A-Z_a-z][$\w]*)/u,
      "both",
    ],
    [
      /^\s*(?:export\s+)?(?:declare\s+)?function\s+(?<name>[$A-Z_a-z][$\w]*)/u,
      "value",
    ],
    [
      /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?<name>[$A-Z_a-z][$\w]*)/u,
      "value",
    ],
  ];

  for (const [pattern, space] of declarationPatterns) {
    const name = pattern.exec(line)?.groups?.["name"];

    if (name !== undefined) {
      reserveTraversalNode();
      addStandardGlobal(names, [...prefix, name].join("."), space);

      return;
    }
  }
};

const openStandardNamespace = function openStandardNamespace(
  namespaceName: string,
  prefix: readonly string[],
  scan: StandardNamespaceScan,
  names: Map<string, StandardGlobalSpaces>,
  reserveTraversalNode: () => void
): void {
  reserveTraversalNode();

  if (namespaceName === "global") {
    scan.globalDepth = scan.braceDepth + 1;
  }

  const namespacePrefix =
    namespaceName === "global" ? [] : [...prefix, namespaceName];

  if (namespacePrefix.length > 0 && collectsStandardGlobals(scan)) {
    addStandardGlobal(names, namespacePrefix.join("."), "value");
  }

  scan.namespaces.push({ depth: scan.braceDepth + 1, prefix: namespacePrefix });
};

const braceDelta = function braceDelta(line: string): number {
  let delta = 0;

  for (const character of line) {
    if (character === "{") {
      delta += 1;
    } else if (character === "}") {
      delta -= 1;
    }
  }

  return delta;
};

const closeCompletedStandardNamespaces =
  function closeCompletedStandardNamespaces(scan: StandardNamespaceScan): void {
    while ((scan.namespaces.at(-1)?.depth ?? 0) > scan.braceDepth) {
      scan.namespaces.pop();
    }
  };

const scanStandardLibraryLine = function scanStandardLibraryLine(
  line: string,
  scan: StandardNamespaceScan,
  names: Map<string, StandardGlobalSpaces>,
  reserveTraversalNode: () => void
): void {
  const prefix = scan.namespaces.at(-1)?.prefix ?? [];
  const namespaceName = standardNamespaceName(line);

  if (namespaceName === undefined) {
    if (collectsStandardGlobals(scan)) {
      collectStandardDeclarationLine(line, prefix, names, reserveTraversalNode);
    }
  } else {
    openStandardNamespace(
      namespaceName,
      prefix,
      scan,
      names,
      reserveTraversalNode
    );
  }

  scan.braceDepth += braceDelta(line);
  closeCompletedStandardNamespaces(scan);

  if (scan.globalDepth !== null && scan.globalDepth > scan.braceDepth) {
    scan.globalDepth = null;
  }
};

const collectStandardGlobalNames = function collectStandardGlobalNames(
  text: string,
  names: Map<string, StandardGlobalSpaces>,
  reserveTraversalNode: () => void
): void {
  const scan: StandardNamespaceScan = {
    braceDepth: 0,
    globalDepth: null,
    namespaces: [],
    topLevelDeclarationsAreGlobal: !text
      .split("\n")
      .some((line) => /^export\s*\{\s*\}\s*;/u.test(line.trim())),
  };

  for (const line of text.split("\n")) {
    scanStandardLibraryLine(line, scan, names, reserveTraversalNode);
  }
};

export const readStandardGlobalCatalogEffect = Effect.fnUntraced(
  function* readStandardGlobalCatalogEffect() {
    const fs = yield* FileSystem.FileSystem;
    let traversalNodes = 0;

    const reserveTraversalNode = (): void => {
      traversalNodes += 1;
    };

    const libraryNames = yield* fs.readDirectory(COMPILER_LIBRARY_DIRECTORY);

    const libraryFiles = libraryNames
      .filter((name) => /^lib\..+\.d\.ts$/u.test(name))
      .map((name) => nodePath.join(COMPILER_LIBRARY_DIRECTORY, name));

    if (libraryFiles.length > MAX_STANDARD_LIBRARY_FILES) {
      return yield* Effect.die(standardLibraryLimit());
    }

    const names = new Map<string, StandardGlobalSpaces>();
    let byteCount = 0;
    yield* forEachEffect(
      libraryFiles,
      (libraryFile) =>
        Effect.gen(function* readLibrary() {
          const text = yield* readBoundedFileText(
            libraryFile,
            MAX_STANDARD_LIBRARY_BYTES - byteCount
          ).pipe(
            Effect.catchTag("ByteStreamLimitError", () =>
              Effect.die(standardLibraryLimit())
            )
          );

          byteCount += Buffer.byteLength(text);
          collectStandardGlobalNames(text, names, reserveTraversalNode);

          if (names.size > MAX_STANDARD_GLOBAL_NAMES) {
            return yield* Effect.die(standardLibraryLimit());
          }

          return yield* Effect.void;
        }),
      { discard: true }
    );
    addStandardGlobal(names, "globalThis", "value");

    return {
      compilerVersion: COMPILER_VERSION,
      entries: [...names].map(
        ([name, spaces]) =>
          [name, bitwiseOr(spaces.type ? 1 : 0, spaces.value ? 2 : 0)] as const
      ),
      traversalNodes,
    } satisfies StandardGlobalCatalog;
  }
);

export const readStandardGlobalCatalog = async () =>
  await runAdapterEffect(
    readStandardGlobalCatalogEffect().pipe(Effect.provide(layer))
  );
