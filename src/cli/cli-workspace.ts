import { Cause, Effect, Option } from "effect";

import { parsePackageNameSegments } from "#typepeek/inspection/evidence/installed-package-boundary";
import { isBuiltin } from "#typepeek/platform/node-module";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { requireDefined } from "#typepeek/shared/defined-value";

import {
  WorkspaceDiscoveryLimitError,
  findConsumingWorkspaces,
} from "../workspace/workspace-repository.ts";

type WorkspaceFlag = "--workspace" | "--before-workspace" | "--after-workspace";

const workspacePackageName = function workspacePackageName(
  specifier: string
): string | undefined {
  return isBuiltin(specifier)
    ? undefined
    : parsePackageNameSegments(specifier)?.join("/");
};

const displayWorkspaceCandidate = function displayWorkspaceCandidate(
  repositoryRoot: string,
  candidate: string
): string {
  const relativeCandidate = nodePath.relative(repositoryRoot, candidate);

  return relativeCandidate === ""
    ? "."
    : relativeCandidate.split(nodePath.sep).join("/");
};

const selectDeclaredWorkspace = function selectDeclaredWorkspace(
  candidates: readonly string[],
  repositoryRoot: string,
  resolutionContext: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag
) {
  if (candidates.length === 1) {
    return requireDefined(candidates[0]);
  }

  if (candidates.length === 0) {
    return resolutionContext;
  }

  const displayedCandidates = candidates
    .map((candidate) => displayWorkspaceCandidate(repositoryRoot, candidate))
    .join(", ");

  return new Error(
    `Specifier "${specifier}" matches multiple consuming workspaces: ${displayedCandidates}. Select one with ${workspaceFlag} <path>.`
  );
};

const selectRepositoryWorkspace = Effect.fnUntraced(
  function* selectRepositoryWorkspace(
    resolutionContext: string,
    packageName: string,
    specifier: string,
    workspaceFlag: WorkspaceFlag
  ) {
    const selection = yield* findConsumingWorkspaces(
      resolutionContext,
      packageName
    );

    if (Option.isNone(selection)) {
      return resolutionContext;
    }

    return selectDeclaredWorkspace(
      selection.value.candidates,
      selection.value.root,
      resolutionContext,
      specifier,
      workspaceFlag
    );
  }
);

const selectBoundedRepositoryWorkspace = (
  resolutionContext: string,
  packageName: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag
) =>
  selectRepositoryWorkspace(
    resolutionContext,
    packageName,
    specifier,
    workspaceFlag
  ).pipe(
    Effect.catchCauseIf(
      (cause) => Cause.squash(cause) instanceof WorkspaceDiscoveryLimitError,
      () =>
        Effect.succeed(
          new Error(
            `Workspace discovery exceeded its bound. Select one with ${workspaceFlag} <path>.`
          )
        )
    )
  );

export const selectCliWorkspace = Effect.fnUntraced(
  function* selectCliWorkspace(
    specifier: string,
    explicitWorkspace: string | undefined,
    workspaceFlag: "--workspace" | "--before-workspace" | "--after-workspace",
    currentDirectory: string = process.cwd()
  ) {
    if (explicitWorkspace !== undefined) {
      return explicitWorkspace;
    }

    const resolutionContext = nodePath.resolve(currentDirectory);
    const packageName = workspacePackageName(specifier);

    if (packageName === undefined) {
      return resolutionContext;
    }

    return yield* selectBoundedRepositoryWorkspace(
      resolutionContext,
      packageName,
      specifier,
      workspaceFlag
    );
  }
);
