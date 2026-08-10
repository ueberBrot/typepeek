import { access } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  type PackagedCliMatrix,
  PACKAGE_MANAGER_PINS,
  materializePackagedCliMatrix,
} from "./helpers/index.ts";

describe("packaged CLI in consumer Resolution Contexts", () => {
  let matrix: PackagedCliMatrix;

  beforeAll(async () => {
    matrix = await materializePackagedCliMatrix();
  }, 300_000);

  afterAll(async () => {
    await matrix?.cleanup();
  });

  it("installs one packed artifact with the pinned npm, pnpm, and Bun installers", () => {
    expect(
      matrix.consumers.map(({ executableKind, manager, typepeekTarballPath, version }) => ({
        executableKind,
        manager,
        typepeekTarballPath,
        version,
      })),
    ).toEqual(
      PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({
        executableKind: process.platform === "win32" || manager === "pnpm" ? "shim" : "link",
        manager,
        typepeekTarballPath: matrix.typepeekTarballPath,
        version,
      })),
    );
  });

  it("runs the installed executable with equivalent semantic outcomes", async () => {
    const outcomes = await Promise.all(
      matrix.consumers.map(async (consumer) => {
        const overviewArguments = ["publint"];
        const publicSubpathArguments = ["publint/utils", "--export", "formatMessage"];
        const zodArguments = ["zod", "--export", "ZodError"];
        const overview = await consumer.run(overviewArguments);
        const publicSubpathInspection = await consumer.run(publicSubpathArguments);
        const zodInspection = await consumer.run(zodArguments);

        return {
          commands: [overviewArguments, publicSubpathArguments, zodArguments],
          installedPackages: ["publint", "publint/utils", "zod"],
          manager: consumer.manager,
          resolutionContext: consumer.resolutionContext,
          semantics: {
            overview: readCliSemantics(overview.stdout),
            publicSubpathInspection: readCliSemantics(publicSubpathInspection.stdout),
            zodInspection: readCliSemantics(zodInspection.stdout),
          },
        };
      }),
    );

    const baseline = outcomes[0];
    expect(baseline).toBeDefined();
    if (baseline === undefined) {
      return;
    }

    // Pin labeled facts while leaving renderer prose and signature text free to evolve.
    expect({
      commands: baseline.commands,
      installedPackages: baseline.installedPackages,
      manager: baseline.manager,
      publicSubpathSignature: baseline.semantics.publicSubpathInspection.signatures[0],
      resolutionContext: baseline.resolutionContext,
      semantics: baseline.semantics,
      zodSignature: baseline.semantics.zodInspection.signatures[0],
    }).toMatchObject({
      commands: baseline.commands,
      installedPackages: baseline.installedPackages,
      manager: baseline.manager,
      publicSubpathSignature: expect.stringMatching(/^call:/u),
      resolutionContext: baseline.resolutionContext,
      semantics: {
        overview: {
          packageIdentity: "publint@0.3.22",
          publicSubpaths: ["publint/utils"],
          specifier: "publint",
        },
        publicSubpathInspection: {
          moduleExport: "formatMessage",
          packageIdentity: "publint@0.3.22",
          specifier: "publint/utils",
        },
        zodInspection: {
          moduleExport: "ZodError",
          packageIdentity: "zod@4.4.3",
          specifier: "zod",
        },
      },
      zodSignature: expect.stringMatching(/^construct:/u),
    });

    for (const outcome of outcomes.slice(1)) {
      expect({
        commands: outcome.commands,
        installedPackages: outcome.installedPackages,
        manager: outcome.manager,
        resolutionContext: outcome.resolutionContext,
        semantics: outcome.semantics,
      }).toEqual({
        commands: outcome.commands,
        installedPackages: outcome.installedPackages,
        manager: outcome.manager,
        resolutionContext: outcome.resolutionContext,
        semantics: baseline.semantics,
      });
    }
  }, 60_000);

  it("ships executable metadata, production dependencies, and the analysis process entry", async () => {
    await Promise.all(
      matrix.consumers.flatMap((consumer) => [
        access(consumer.executablePath),
        access(consumer.analysisProcessEntryPath),
        ...consumer.productionDependencyPaths.map((dependencyPath) => access(dependencyPath)),
      ]),
    );
  });

  it("keeps package scripts, process spawning, and network access disabled", async () => {
    await Promise.all(
      matrix.consumers.map(({ packageScriptSentinel, verifyNoInspectionIo }) =>
        Promise.all([
          expect(access(packageScriptSentinel)).rejects.toMatchObject({ code: "ENOENT" }),
          verifyNoInspectionIo(),
        ]),
      ),
    );
  });
});

interface CliSemantics {
  readonly moduleExport: string | undefined;
  readonly packageIdentity: string | undefined;
  readonly publicSubpaths: readonly string[];
  readonly signatures: readonly string[];
  readonly specifier: string | undefined;
}

function readCliSemantics(output: string): CliSemantics {
  const lines = output.split("\n");
  return {
    moduleExport: valueAfterPrefix(lines, "Module Export: "),
    packageIdentity: valueAfterPrefix(lines, "Package: "),
    publicSubpaths: sectionEntries(lines, "Public Subpaths"),
    signatures: sectionEntries(lines, "Signatures"),
    specifier: valueAfterPrefix(lines, "Specifier: "),
  };
}

function sectionEntries(lines: readonly string[], heading: string): readonly string[] {
  const headingIndex = lines.findIndex((line) => line.startsWith(`${heading} (`));
  if (headingIndex === -1) {
    return [];
  }
  const entries = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (!line.startsWith("- ")) {
      break;
    }
    entries.push(line.slice(2));
  }
  return entries;
}

function valueAfterPrefix(lines: readonly string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}
