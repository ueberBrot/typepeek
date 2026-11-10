import { Cause, Effect } from "effect";

import { parsePackageNameSegments } from "#typepeek/inspection/evidence/installed-package-boundary";
import { isBuiltin } from "#typepeek/platform/node-module";
import { platformPath as nodePath } from "#typepeek/platform/platform-path";
import { requireDefined } from "#typepeek/shared/defined-value";

import type { WorkspaceRepository } from "../workspace/workspace-repository.ts";
import {
  WorkspaceDiscoveryLimitError,
  findWorkspaceRepository,
} from "../workspace/workspace-repository.ts";

type WorkspaceFlag = "--workspace" | "--before-workspace" | "--after-workspace";

const workspacePackageName = function workspacePackageName(
  specifier: string
): string | undefined {
  return isBuiltin(specifier)
    ? undefined
    : parsePackageNameSegments(specifier)?.join("/");
};

const usesCurrentResolutionContext = Effect.fnUntraced(
  function* usesCurrentResolutionContext(
    repository: WorkspaceRepository,
    resolutionContext: string,
    packageName: string
  ) {
    return (
      repository.root !== resolutionContext ||
      (yield* repository.declaresPackage(packageName))
    );
  }
);

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
  repository: WorkspaceRepository,
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
    .map((candidate) => displayWorkspaceCandidate(repository.root, candidate))
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
    const repository = yield* findWorkspaceRepository(resolutionContext);

    if (
      repository === undefined ||
      (yield* usesCurrentResolutionContext(
        repository,
        resolutionContext,
        packageName
      ))
    ) {
      return resolutionContext;
    }

    const candidates = yield* repository.consumingWorkspaces(packageName);

    return selectDeclaredWorkspace(
      candidates,
      repository,
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
