import { access } from "node:fs/promises";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { decodeJson } from "#typepeek/json-data";

import type { PackagedCliMatrix } from "./helpers/index.ts";
import {
  PACKAGE_MANAGER_PINS,
  materializePackagedCliMatrix,
} from "./helpers/index.ts";
import { match } from "./helpers/matchers.ts";

interface JsonSignatureSemantics {
  readonly intent: string;
  readonly moduleExport: string;
  readonly packageIdentity: string;
  readonly signatureKinds: readonly string[];
  readonly specifier: string;
  readonly status: string;
}

const valueAfterPrefix = function valueAfterPrefix(
  lines: readonly string[],
  prefix: string
): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
};

const sectionEntries = function sectionEntries(
  lines: readonly string[],
  heading: string
): readonly string[] {
  const headingIndex = lines.findIndex((line) =>
    line.startsWith(`${heading} (`)
  );

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
};

const readCliSemantics = function readCliSemantics(
  output: string
): CliSemantics {
  const lines = output.split("\n");

  return {
    moduleExport: valueAfterPrefix(lines, "Module Export: "),
    packageIdentity: valueAfterPrefix(lines, "Package: "),
    publicSubpaths: sectionEntries(lines, "Public Subpaths"),
    signatures: sectionEntries(lines, "Signatures"),
    specifier: valueAfterPrefix(lines, "Specifier: "),
  };
};

const readJsonSignatureSemantics = function readJsonSignatureSemantics(
  output: string
): JsonSignatureSemantics {
  const outcome = decodeJson(
    Schema.Struct({
      result: Schema.mutableKey(
        Schema.Struct({
          intent: Schema.mutableKey(Schema.String),
          moduleExport: Schema.mutableKey(
            Schema.Struct({
              name: Schema.mutableKey(Schema.String),
              signatures: Schema.mutableKey(
                Schema.mutable(
                  Schema.Array(
                    Schema.Struct({
                      kind: Schema.mutableKey(Schema.String),
                    })
                  )
                )
              ),
            })
          ),
          packageIdentity: Schema.mutableKey(
            Schema.Struct({
              name: Schema.mutableKey(Schema.String),
              version: Schema.mutableKey(Schema.optionalKey(Schema.String)),
            })
          ),
          specifier: Schema.mutableKey(Schema.String),
        })
      ),
      status: Schema.mutableKey(Schema.String),
    }),
    output
  );

  return {
    intent: outcome.result.intent,
    moduleExport: outcome.result.moduleExport.name,
    packageIdentity: `${outcome.result.packageIdentity.name}@${outcome.result.packageIdentity.version}`,
    signatureKinds: outcome.result.moduleExport.signatures.map(
      ({ kind }) => kind
    ),
    specifier: outcome.result.specifier,
    status: outcome.status,
  };
};

interface CliSemantics {
  readonly moduleExport: string | undefined;
  readonly packageIdentity: string | undefined;
  readonly publicSubpaths: readonly string[];
  readonly signatures: readonly string[];
  readonly specifier: string | undefined;
}

describe("packaged-cli-consumers", () => {
  describe("packaged CLI in consumer Resolution Contexts", () => {
    let matrix: PackagedCliMatrix;
    beforeAll(async () => {
      matrix = await materializePackagedCliMatrix();
    }, 300_000);

    afterAll(async () => {
      await matrix?.cleanup();
    }, 60_000);

    it("installs one packed artifact with the pinned npm, pnpm, and Bun installers", () => {
      expect(
        matrix.consumers.map(
          ({ executableKind, manager, typepeekTarballPath, version }) => ({
            executableKind,
            manager,
            typepeekTarballPath,
            version,
          })
        )
      ).toStrictEqual(
        PACKAGE_MANAGER_PINS.map(({ manager, version }) => ({
          executableKind:
            process.platform === "win32" || manager === "pnpm"
              ? "shim"
              : "link",
          manager,
          typepeekTarballPath: matrix.typepeekTarballPath,
          version,
        }))
      );
    });

    it("runs the installed executable with equivalent semantic outcomes", async () => {
      const results = await Promise.allSettled(
        matrix.consumers.map(async (consumer) => {
          const overviewArguments = ["publint"];
          const expandedOverviewArguments = ["publint", "--subpaths"];

          const publicSubpathArguments = [
            "export",
            "publint/utils",
            "formatMessage",
          ];

          const zodArguments = ["export", "zod", "ZodError"];
          const zodJsonArguments = ["signatures", "zod", "ZodError", "--json"];
          const overview = await consumer.run(overviewArguments);

          const expandedOverview = await consumer.run(
            expandedOverviewArguments
          );

          const publicSubpathInspection = await consumer.run(
            publicSubpathArguments
          );

          const zodInspection = await consumer.run(zodArguments);
          const zodJsonInspection = await consumer.run(zodJsonArguments);

          return {
            commands: [
              overviewArguments,
              expandedOverviewArguments,
              publicSubpathArguments,
              zodArguments,
              zodJsonArguments,
            ],
            installedPackages: ["publint", "publint/utils", "zod"],
            manager: consumer.manager,
            resolutionContext: consumer.resolutionContext,
            semantics: {
              expandedOverview: readCliSemantics(expandedOverview.stdout),
              overview: readCliSemantics(overview.stdout),
              publicSubpathInspection: readCliSemantics(
                publicSubpathInspection.stdout
              ),
              zodInspection: readCliSemantics(zodInspection.stdout),
              zodJsonInspection: readJsonSignatureSemantics(
                zodJsonInspection.stdout
              ),
            },
          };
        })
      );

      // Wait for every consumer process before fixture cleanup, including on failure.
      const outcomes = results.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }

        return result.value;
      });

      const [baseline] = outcomes;
      expect(baseline).toBeDefined();

      if (baseline === undefined) {
        return;
      }

      expect({
        commands: baseline.commands,
        installedPackages: baseline.installedPackages,
        manager: baseline.manager,
        publicSubpathSignature:
          baseline.semantics.publicSubpathInspection.signatures[0],
        resolutionContext: baseline.resolutionContext,
        semantics: baseline.semantics,
        zodSignature: baseline.semantics.zodInspection.signatures[0],
      }).toMatchObject({
        commands: baseline.commands,
        installedPackages: baseline.installedPackages,
        manager: baseline.manager,
        publicSubpathSignature: match.stringMatching(/^call:/u),
        resolutionContext: baseline.resolutionContext,
        semantics: {
          expandedOverview: {
            packageIdentity: "publint@0.3.22",
            publicSubpaths: ["publint/utils"],
            specifier: "publint",
          },
          overview: {
            packageIdentity: "publint@0.3.22",
            publicSubpaths: [],
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
          zodJsonInspection: {
            intent: "signature-inspection",
            moduleExport: "ZodError",
            packageIdentity: "zod@4.4.3",
            signatureKinds: ["construct"],
            specifier: "zod",
            status: "success",
          },
        },
        zodSignature: match.stringMatching(/^construct:/u),
      });

      for (const outcome of outcomes.slice(1)) {
        expect({
          commands: outcome.commands,
          installedPackages: outcome.installedPackages,
          manager: outcome.manager,
          resolutionContext: outcome.resolutionContext,
          semantics: outcome.semantics,
        }).toStrictEqual({
          commands: outcome.commands,
          installedPackages: outcome.installedPackages,
          manager: outcome.manager,
          resolutionContext: outcome.resolutionContext,
          semantics: baseline.semantics,
        });
      }
    }, 60_000);

    it("ships executable metadata, production dependencies, and the analysis process entry", async () => {
      const shippedPaths = matrix.consumers.flatMap((consumer) => [
        consumer.executablePath,
        consumer.analysisProcessEntryPath,
        ...consumer.productionDependencyPaths,
      ]);

      await expect(
        Promise.all(
          shippedPaths.map(async (path) => {
            await access(path);
          })
        )
      ).resolves.toHaveLength(shippedPaths.length);
    });

    it("does not expose a JavaScript library interface", async () => {
      await expect(
        Promise.all(
          matrix.consumers.map(async (consumer) => {
            await consumer.verifyNoLibraryImports();
          })
        )
      ).resolves.toHaveLength(matrix.consumers.length);
    });

    it("keeps package scripts, process spawning, and network access disabled", async () => {
      await Promise.all(
        matrix.consumers.map(
          async ({ packageScriptSentinel, verifyNoInspectionIo }) =>
            await Promise.all([
              expect(access(packageScriptSentinel)).rejects.toMatchObject({
                code: "ENOENT",
              }),
              verifyNoInspectionIo(),
            ])
        )
      );
    });
  });
});
