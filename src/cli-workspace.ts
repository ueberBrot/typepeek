import { isBuiltin } from "node:module";
import nodePath from "node:path";

import { requireDefined } from "#typepeek/defined-value";
import { parsePackageNameSegments } from "#typepeek/inspection/installed-package-boundary";

import type { WorkspaceRepository } from "./workspace-repository.ts";
import {
  WorkspaceDiscoveryLimitError,
  findWorkspaceRepository,
} from "./workspace-repository.ts";

type WorkspaceFlag = "--workspace" | "--before-workspace" | "--after-workspace";

const workspacePackageName = function workspacePackageName(
  specifier: string
): string | undefined {
  return isBuiltin(specifier)
    ? undefined
    : parsePackageNameSegments(specifier)?.join("/");
};

const usesCurrentResolutionContext = function usesCurrentResolutionContext(
  repository: WorkspaceRepository,
  resolutionContext: string,
  packageName: string
): boolean {
  return (
    repository.root !== resolutionContext ||
    repository.declaresPackage(packageName)
  );
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
  repository: WorkspaceRepository,
  resolutionContext: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag
): string | Error {
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

const selectRepositoryWorkspace = function selectRepositoryWorkspace(
  resolutionContext: string,
  packageName: string,
  specifier: string,
  workspaceFlag: WorkspaceFlag
): string | Error {
  const repository = findWorkspaceRepository(resolutionContext);

  if (
    repository === undefined ||
    usesCurrentResolutionContext(repository, resolutionContext, packageName)
  ) {
    return resolutionContext;
  }

  const candidates = repository.consumingWorkspaces(packageName);

  return selectDeclaredWorkspace(
    candidates,
    repository,
    resolutionContext,
    specifier,
    workspaceFlag
  );
};

const selectBoundedRepositoryWorkspace =
  function selectBoundedRepositoryWorkspace(
    resolutionContext: string,
    packageName: string,
    specifier: string,
    workspaceFlag: WorkspaceFlag
  ): string | Error {
    try {
      return selectRepositoryWorkspace(
        resolutionContext,
        packageName,
        specifier,
        workspaceFlag
      );
    } catch (error) {
      if (error instanceof WorkspaceDiscoveryLimitError) {
        return new Error(
          `Workspace discovery exceeded its bound. Select one with ${workspaceFlag} <path>.`
        );
      }

      throw error;
    }
  };

export const selectCliWorkspace = function selectCliWorkspace(
  specifier: string,
  explicitWorkspace: string | undefined,
  workspaceFlag: "--workspace" | "--before-workspace" | "--after-workspace",
  currentDirectory = process.cwd()
): string | Error {
  if (explicitWorkspace !== undefined) {
    return explicitWorkspace;
  }

  const resolutionContext = nodePath.resolve(currentDirectory);
  const packageName = workspacePackageName(specifier);

  if (packageName === undefined) {
    return resolutionContext;
  }

  return selectBoundedRepositoryWorkspace(
    resolutionContext,
    packageName,
    specifier,
    workspaceFlag
  );
};
