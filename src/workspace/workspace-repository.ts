import {
  ByteSize,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import {
  filter as filterEffect,
  forEach as forEachEffect,
} from "effect/Effect";

import { hasDeclaredPackage } from "#typepeek/inspection/evidence/installed-package-boundary";
import { directoryEntries } from "#typepeek/platform/node-directory";
import { matchesGlob } from "#typepeek/platform/node-path-matching";
import { readBoundedFileText } from "#typepeek/platform/platform-file";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { requireDefined } from "#typepeek/shared/defined-value";
import { isJsonObject } from "#typepeek/shared/json-data";

const PACKAGE_MANIFEST_FILE = "package.json";
const MAX_ANCESTOR_DIRECTORIES = 64;
const MAX_WORKSPACES = 128;
const MAX_WORKSPACE_CONFIG_BYTES = 256 * 1024;
const MAX_WORKSPACE_DISCOVERY_DEPTH = 32;
const MAX_WORKSPACE_DISCOVERY_OPERATIONS = 16 * 1024;

export class WorkspaceDiscoveryLimitError extends Error {
  override name = "WorkspaceDiscoveryLimitError";
}

const stringValues = function stringValues(
  value: Schema.Json | undefined
): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => Predicate.isString(entry))
    : [];
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

const matchesWorkspacePattern = function matchesWorkspacePattern(
  path: string,
  pattern: string
): boolean {
  try {
    return matchesGlob(path, pattern);
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

const readBoundedText = Effect.fnUntraced(function* readBoundedText(
  fileName: string
) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(fileName).pipe(Effect.option);

  if (Option.isNone(stat) || stat.value.type !== "File") {
    return Option.none<string>();
  }

  if (ByteSize.toBigInt(stat.value.size) > MAX_WORKSPACE_CONFIG_BYTES) {
    return yield* Effect.die(new WorkspaceDiscoveryLimitError());
  }

  return yield* readBoundedFileText(fileName, MAX_WORKSPACE_CONFIG_BYTES).pipe(
    Effect.asSome,
    Effect.catchTag("ByteStreamLimitError", () =>
      Effect.die(new WorkspaceDiscoveryLimitError())
    ),
    Effect.orElseSucceed(Option.none<string>)
  );
});

const decodeWorkspaceManifest = Schema.decodeOption(
  Schema.fromJsonString(Schema.JsonObject)
);

const readJsonRecord = Effect.fnUntraced(function* readJsonRecord(
  fileName: string
) {
  const text = yield* readBoundedText(fileName);

  return text.pipe(Option.flatMap(decodeWorkspaceManifest));
});

const manifestWorkspacePatterns = function manifestWorkspacePatterns(
  manifest: Option.Option<Schema.JsonObject>
): readonly string[] {
  if (Option.isNone(manifest)) {
    return [];
  }

  const { workspaces } = manifest.value;

  if (Array.isArray(workspaces)) {
    return stringValues(workspaces);
  }

  const packages = isJsonObject(workspaces)
    ? workspaces["packages"]
    : undefined;

  return stringValues(packages);
};

const readWorkspacePatterns = Effect.fnUntraced(function* readWorkspacePatterns(
  directory: string,
  manifest: Option.Option<Schema.JsonObject>
) {
  const pnpm = yield* readBoundedText(
    nodePath.join(directory, "pnpm-workspace.yaml")
  );

  return [
    ...manifestWorkspacePatterns(manifest),
    ...Option.match(pnpm, { onNone: () => [], onSome: pnpmWorkspacePatterns }),
  ];
});

const findWorkspaceLayout = Effect.fnUntraced(function* findWorkspaceLayout(
  startingDirectory: string,
  initialManifest: Option.Option<Schema.JsonObject>
) {
  let directory = startingDirectory;

  for (let depth = 0; depth < MAX_ANCESTOR_DIRECTORIES; depth += 1) {
    const manifest =
      depth === 0
        ? initialManifest
        : yield* readJsonRecord(
            nodePath.join(directory, PACKAGE_MANIFEST_FILE)
          );

    const patterns = yield* readWorkspacePatterns(directory, manifest);

    if (patterns.length > 0) {
      return Option.some({ patterns, root: directory });
    }

    const parent = nodePath.dirname(directory);

    if (parent === directory) {
      return Option.none<WorkspaceLayout>();
    }

    directory = parent;
  }

  return yield* Effect.die(new WorkspaceDiscoveryLimitError());
});

const workspaceDeclaresPackage = Effect.fnUntraced(
  function* workspaceDeclaresPackage(directory: string, packageName: string) {
    const manifest = yield* readJsonRecord(
      nodePath.join(directory, PACKAGE_MANIFEST_FILE)
    );

    return (
      Option.isSome(manifest) && hasDeclaredPackage(manifest.value, packageName)
    );
  }
);

const readWorkspaceDirectory = Effect.fnUntraced(
  function* readWorkspaceDirectory(
    directory: string,
    state: WorkspaceDiscoveryState
  ) {
    const childDirectories: string[] = [];
    let hasManifest = false;

    const read = yield* directoryEntries(directory).pipe(
      Stream.runForEach((entry) =>
        Effect.sync(() => {
          consumeDiscoveryOperation(state);
          hasManifest ||=
            entry.isFile() && entry.name === PACKAGE_MANIFEST_FILE;

          if (
            entry.isDirectory() &&
            entry.name !== ".git" &&
            entry.name !== "node_modules"
          ) {
            childDirectories.push(entry.name);
          }
        })
      ),
      Effect.option
    );

    return read._tag === "Some" ? { childDirectories, hasManifest } : undefined;
  }
);

const visitWorkspaceDirectory: (
  directory: string,
  relativeDirectory: string,
  depth: number,
  traversal: WorkspaceTraversal
) => Effect.Effect<void, never, FileSystem.FileSystem> = Effect.fnUntraced(
  function* visitDirectory(
    directory: string,
    relativeDirectory: string,
    depth: number,
    traversal: WorkspaceTraversal
  ): Effect.fn.Return<void, never, FileSystem.FileSystem> {
    enforceDiscoveryDepth(depth);
    consumeDiscoveryOperation(traversal.state);
    const contents = yield* readWorkspaceDirectory(directory, traversal.state);

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

    yield* forEachEffect(
      contents.childDirectories,
      (child) => {
        const relativeChild =
          relativeDirectory === "" ? child : `${relativeDirectory}/${child}`;

        return couldContainWorkspace(relativeChild, traversal.includePatterns)
          ? visitWorkspaceDirectory(
              nodePath.join(directory, child),
              relativeChild,
              depth + 1,
              traversal
            )
          : Effect.void;
      },
      { discard: true }
    );
  }
);

const discoverWorkspaceDirectories = Effect.fnUntraced(
  function* discoverWorkspaceDirectories(repository: WorkspaceLayout) {
    const traversal: WorkspaceTraversal = {
      excludePatterns: normalizedWorkspacePatterns(
        repository.patterns
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => pattern.slice(1))
      ),
      includePatterns: normalizedWorkspacePatterns(
        repository.patterns.filter((pattern) => !pattern.startsWith("!"))
      ),
      state: { directories: [], operations: 0 },
    };

    yield* visitWorkspaceDirectory(repository.root, "", 0, traversal);

    return traversal.state.directories.toSorted();
  }
);

interface WorkspaceLayout {
  readonly patterns: readonly string[];
  readonly root: string;
}

interface WorkspaceDiscoveryState {
  readonly directories: string[];
  operations: number;
}

interface WorkspaceTraversal {
  readonly excludePatterns: readonly string[];
  readonly includePatterns: readonly string[];
  readonly state: WorkspaceDiscoveryState;
}

/** Owns static workspace configuration and bounded discovery of consuming workspaces. */
export const findConsumingWorkspaces = Effect.fnUntraced(
  function* findConsumingWorkspaces(
    resolutionContext: string,
    packageName: string
  ) {
    const manifest = yield* readJsonRecord(
      nodePath.join(resolutionContext, PACKAGE_MANIFEST_FILE)
    );

    if (
      Option.isSome(manifest) &&
      hasDeclaredPackage(manifest.value, packageName)
    ) {
      return Option.none();
    }

    const layout = yield* findWorkspaceLayout(resolutionContext, manifest);

    if (Option.isNone(layout) || layout.value.root !== resolutionContext) {
      return Option.none();
    }

    const directories = yield* discoverWorkspaceDirectories(layout.value);

    const candidates = yield* filterEffect(directories, (directory) =>
      workspaceDeclaresPackage(directory, packageName)
    );

    return Option.some({ candidates, root: layout.value.root });
  }
);
