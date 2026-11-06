import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { inspectExport, inspectInterfaceOverview } from "#typepeek/inspection";

import type { DeclarationProviderFixture } from "./helpers/declaration-provider-fixture.ts";
import {
  materializeAliasedTypeReferenceFixture,
  materializeDeclarationProviderFixture,
  materializeNodeProviderFixture,
  materializeWorkspaceTypeReferenceFixture,
} from "./helpers/declaration-provider-fixture.ts";
import { match } from "./helpers/matchers.ts";

describe("declaration-providers", () => {
  describe("Declaration Providers", () => {
    let fixture: DeclarationProviderFixture;
    beforeAll(async () => {
      fixture = await materializeDeclarationProviderFixture();
    }, 60_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it("inspects a JavaScript package through its separate visible provider", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.providerOneContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: fixture.providerName, version: "1.0.0" },
          moduleExports: [{ name: "overloaded" }, { name: "providerVersion" }],
          packageIdentity: { name: fixture.packageName, version: "3.0.0" },
        },
        status: "success",
      });
    });

    it("inspects a hoisted JavaScript Package Module through its hoisted Declaration Provider", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.hoistedProviderContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: fixture.providerName, version: "1.0.0" },
          moduleExports: [{ name: "overloaded" }, { name: "providerVersion" }],
          packageIdentity: { name: fixture.packageName, version: "3.0.0" },
        },
        status: "success",
      });
    });

    it("inspects a separate provider expressed as an exact ambient module", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.ambientProviderContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: fixture.providerName, version: "3.0.0" },
          moduleExports: [{ name: "ambient" }],
          packageIdentity: { name: fixture.packageName, version: "3.0.0" },
        },
        status: "success",
      });
    });

    it("selects different provider installations without merging contexts", async () => {
      const [providerOne, providerTwo] = await Promise.all([
        inspectExport({
          exportName: "providerVersion",
          resolutionContext: fixture.providerOneContext,
          specifier: fixture.packageName,
        }),
        inspectExport({
          exportName: "providerVersion",
          resolutionContext: fixture.providerTwoContext,
          specifier: fixture.packageName,
        }),
      ]);

      expect([
        providerOne,
        providerTwo,
        JSON.stringify(providerOne).includes("provider-one"),
        JSON.stringify(providerOne).includes("provider-two"),
        JSON.stringify(providerTwo).includes("provider-two"),
        JSON.stringify(providerTwo).includes("provider-one"),
      ]).toStrictEqual([
        match.objectContaining({
          result: match.objectContaining({
            declarationProvider: match.objectContaining({
              name: fixture.providerName,
              version: "1.0.0",
            }),
            packageIdentity: match.objectContaining({
              name: fixture.packageName,
              version: "3.0.0",
            }),
          }),
          status: "success",
        }),
        match.objectContaining({
          result: match.objectContaining({
            declarationProvider: match.objectContaining({
              name: fixture.providerName,
              version: "2.0.0",
            }),
            packageIdentity: match.objectContaining({
              name: fixture.packageName,
              version: "3.0.0",
            }),
          }),
          status: "success",
        }),
        true,
        false,
        true,
        false,
      ]);
    });

    it("attributes focused declarations to the provider while preserving the target identity", async () => {
      const outcome = await inspectExport({
        exportName: "overloaded",
        resolutionContext: fixture.providerOneContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: fixture.providerName, version: "1.0.0" },
          moduleExport: { name: "overloaded" },
          packageIdentity: { name: fixture.packageName, version: "3.0.0" },
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.signatures.length,
        outcome.result.moduleExport.spaces.flatMap((space) =>
          space.space === "namespace"
            ? []
            : space.declarations.map(
                ({ provenance }) => provenance.packageIdentity
              )
        ),
      ]).toStrictEqual([
        2,
        match.arrayContaining([
          { name: fixture.providerName, version: "1.0.0" },
        ]),
      ]);
    });

    it("does not expose a provider when its target Package Module is absent", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.providerOnlyContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toStrictEqual({
        message: `Specifier "${fixture.packageName}" is not installed from this Resolution Context.`,
        reason: "specifier-not-found",
        status: "not-found",
      });
    });

    it("fails clearly when a JavaScript package has no visible provider", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.missingProviderContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toStrictEqual({
        message: `Package Module "${fixture.packageName}" has no readable Declaration Provider.`,
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it("ignores a malformed provider when the package owns its declarations", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.selfTypedWithMalformedProviderContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toMatchObject({
        result: {
          moduleExports: [{ name: "selfOwned" }],
          packageIdentity: { name: fixture.packageName, version: "3.0.0" },
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        throw new Error("Expected a successful inspection result.");
      }

      expect(outcome.result).not.toHaveProperty("declarationProvider");
    });

    it("rejects a provider entrypoint owned by a nested installed package", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.nestedProviderContext,
        specifier: fixture.packageName,
      });

      expect(outcome).toStrictEqual({
        message:
          "The declaration entrypoint belongs to a nested installed package instead of the selected Declaration Provider.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });
  });
  describe("Node Platform Modules", () => {
    let fixture: DeclarationProviderFixture;
    beforeAll(async () => {
      fixture = await materializeDeclarationProviderFixture();
    }, 60_000);

    afterAll(async () => {
      await fixture?.cleanup();
    });

    it("resolves node:fs through the context-visible real @types/node", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: process.cwd(),
        specifier: "node:fs",
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: "@types/node", version: "24.19.2" },
          moduleExports: match.arrayContaining([{ name: "readFile" }]),
          specifier: "node:fs",
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        throw new Error("Expected a successful inspection result.");
      }

      expect(outcome.result).not.toHaveProperty("packageIdentity");
    });

    it("focuses overload-heavy Node declarations without unrelated library drift", async () => {
      const outcome = await inspectExport({
        exportName: "readFile",
        resolutionContext: process.cwd(),
        specifier: "node:fs",
      });

      expect(outcome).toMatchObject({
        result: {
          declarationProvider: { name: "@types/node", version: "24.19.2" },
          moduleExport: { name: "readFile" },
        },
        status: "success",
      });

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.signatures.length > 1,
        outcome.result.supportingTypes.length <= 48,
        outcome.result.supportingTypes
          .map(({ name }) => name)
          .includes("EventEmitter"),
        outcome.result.moduleExport.spaces.flatMap((space) =>
          space.space === "namespace"
            ? []
            : space.declarations.map(
                ({ provenance }) => provenance.packageIdentity.name
              )
        ),
      ]).toStrictEqual([
        true,
        true,
        false,
        match.arrayContaining(["@types/node"]),
      ]);
    });

    it("fails clearly without a visible @types/node provider", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.missingProviderContext,
        specifier: "node:fs",
      });

      expect(outcome).toStrictEqual({
        message:
          'Node Platform Module "node:fs" has no visible @types/node Declaration Provider.',
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it("rejects a nonexistent node: module even when @types/node is visible", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: process.cwd(),
        specifier: "node:typepeek-not-real",
      });

      expect(outcome).toStrictEqual({
        message:
          'Node Platform Module "node:typepeek-not-real" is not a known Node runtime module.',
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it("rejects an unknown runtime module even when a provider declares it", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.injectedNodeProviderContext,
        specifier: "node:typepeek-not-real",
      });

      expect(outcome).toStrictEqual({
        message:
          'Node Platform Module "node:typepeek-not-real" is not a known Node runtime module.',
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it("rejects unresolved re-exports nested in the selected ambient module", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.brokenNodeProviderContext,
        specifier: "node:fs",
      });

      expect(outcome).toStrictEqual({
        message:
          "A declaration re-export could not be resolved from Installed Evidence.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it("rejects unresolved ambient export-equals aliases for overview and focus", async () => {
      const [overview, focused] = await Promise.all([
        inspectInterfaceOverview({
          resolutionContext: fixture.brokenExportEqualsNodeProviderContext,
          specifier: "node:fs",
        }),
        inspectExport({
          exportName: "missing",
          resolutionContext: fixture.brokenExportEqualsNodeProviderContext,
          specifier: "node:fs",
        }),
      ]);

      const failure = {
        message:
          "A declaration re-export could not be resolved from Installed Evidence.",
        reason: "unsupported-evidence",
        status: "unsupported",
      } as const;

      expect([overview, focused]).toStrictEqual([failure, failure]);
    });

    it("rejects an unresolved exported ambient import-equals alias", async () => {
      const outcome = await inspectInterfaceOverview({
        resolutionContext: fixture.exportedImportNodeProviderContext,
        specifier: "node:fs",
      });

      expect(outcome).toStrictEqual({
        message:
          "A declaration re-export could not be resolved from Installed Evidence.",
        reason: "unsupported-evidence",
        status: "unsupported",
      });
    });

    it.each([
      ["direct", "export { Missing };"],
      ["renamed", "export { Missing as exposed };"],
    ])(
      "rejects a %s named export of an unresolved import-equals alias",
      async (_, exportText) => {
        const isolatedFixture = await materializeNodeProviderFixture(
          [
            'declare module "node:fs" {',
            '  import Missing = require("node:missing");',
            `  ${exportText}`,
            "}",
            "",
          ].join("\n")
        );

        try {
          const outcome = await inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          });

          expect(outcome).toStrictEqual({
            message:
              "A declaration re-export could not be resolved from Installed Evidence.",
            reason: "unsupported-evidence",
            status: "unsupported",
          });
        } finally {
          await isolatedFixture.cleanup();
        }
      }
    );

    it("accepts a declared external triple-slash type provider", async () => {
      const isolatedFixture = await materializeNodeProviderFixture(
        [
          '/// <reference types="helper" />',
          'declare module "node:fs" {',
          "  export function inspect(value: Helper): void;",
          "}",
          "",
        ].join("\n"),
        "interface Helper { readonly value: string; }\n",
        "@types/helper"
      );

      try {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: isolatedFixture.resolutionContext,
          specifier: "node:fs",
        });

        expect(outcome).toMatchObject({
          result: { moduleExports: [{ name: "inspect" }] },
          status: "success",
        });
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it.each([
      ["ordinary", "typepeek-type-helper"],
      ["scoped", "@typepeek/type-helper"],
    ])(
      "accepts a declared %s package as a triple-slash type provider",
      async (_, packageName) => {
        const isolatedFixture = await materializeNodeProviderFixture(
          [
            `/// <reference types="${packageName}" />`,
            'declare module "node:fs" {',
            "  export function inspect(value: Helper): void;",
            "}",
            "",
          ].join("\n"),
          "interface Helper { readonly value: string; }\n",
          packageName
        );

        try {
          const outcome = await inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          });

          expect(outcome).toMatchObject({
            result: { moduleExports: [{ name: "inspect" }] },
            status: "success",
          });
        } finally {
          await isolatedFixture.cleanup();
        }
      }
    );

    it("rejects an undeclared nested triple-slash type provider", async () => {
      const isolatedFixture = await materializeNodeProviderFixture(
        [
          '/// <reference types="helper" />',
          'declare module "node:fs" {',
          "  export function inspect(value: Helper): void;",
          "}",
          "",
        ].join("\n"),
        "interface Helper { readonly value: string; }\n",
        "@types/helper",
        "nested-undeclared"
      );

      try {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: isolatedFixture.resolutionContext,
          specifier: "node:fs",
        });

        expect(outcome).toStrictEqual({
          message:
            "A declaration re-export could not be resolved from Installed Evidence.",
          reason: "unsupported-evidence",
          status: "unsupported",
        });
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it.each(["npm", "pnpm"] as const)(
      "accepts a type-reference provider installed through a declared alias key in a %s layout",
      async (layout) => {
        const isolatedFixture = await materializeAliasedTypeReferenceFixture(
          "@types/helper",
          layout
        );

        try {
          const outcome = await inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          });

          expect(outcome).toMatchObject({
            result: { moduleExports: [{ name: "inspect" }] },
            status: "success",
          });
        } finally {
          await isolatedFixture.cleanup();
        }
      }
    );

    it("rejects an extraneous type-reference path with a declared manifest identity", async () => {
      const isolatedFixture = await materializeAliasedTypeReferenceFixture(
        "@types/actual-helper"
      );

      try {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: isolatedFixture.resolutionContext,
          specifier: "node:fs",
        });

        expect(outcome).toStrictEqual({
          message:
            "A declaration re-export could not be resolved from Installed Evidence.",
          reason: "unsupported-evidence",
          status: "unsupported",
        });
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it("accepts a declared workspace-linked triple-slash type provider", async () => {
      const isolatedFixture = await materializeWorkspaceTypeReferenceFixture();

      try {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: isolatedFixture.resolutionContext,
          specifier: "node:fs",
        });

        expect(outcome).toMatchObject({
          result: { moduleExports: [{ name: "inspect" }] },
          status: "success",
        });
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it("rejects an unresolved inline import in a transitive declaration file", async () => {
      const isolatedFixture = await materializeNodeProviderFixture(
        [
          'declare module "node:fs" {',
          '  import { Missing } from "helper";',
          "  export function inspect(value: Missing): void;",
          "}",
          "",
        ].join("\n"),
        'export type Missing = import("node:missing").Missing;\n'
      );

      try {
        const [overview, focused] = await Promise.all([
          inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          }),
          inspectExport({
            exportName: "inspect",
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          }),
        ]);

        const failure = {
          message:
            "A declaration re-export could not be resolved from Installed Evidence.",
          reason: "unsupported-evidence",
          status: "unsupported",
        } as const;

        expect([overview, focused]).toStrictEqual([failure, failure]);
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it.each([
      ["path", '/// <reference path="./missing.d.ts" />'],
      ["types", '/// <reference types="typepeek-missing-types" />'],
    ])(
      "rejects an unresolved triple-slash %s reference",
      async (_, reference) => {
        const isolatedFixture = await materializeNodeProviderFixture(
          [
            reference,
            'declare module "node:fs" {',
            "  export type MissingPublic = Missing;",
            "}",
            "",
          ].join("\n")
        );

        try {
          const [overview, focused] = await Promise.all([
            inspectInterfaceOverview({
              resolutionContext: isolatedFixture.resolutionContext,
              specifier: "node:fs",
            }),
            inspectExport({
              exportName: "MissingPublic",
              resolutionContext: isolatedFixture.resolutionContext,
              specifier: "node:fs",
            }),
          ]);

          const failure = {
            message:
              "A declaration re-export could not be resolved from Installed Evidence.",
            reason: "unsupported-evidence",
            status: "unsupported",
          } as const;

          expect([overview, focused]).toStrictEqual([failure, failure]);
        } finally {
          await isolatedFixture.cleanup();
        }
      }
    );

    it.each([
      [
        "named",
        'import { Missing } from "node:missing";',
        "export { Missing };",
      ],
      [
        "renamed named",
        'import { Source as Missing } from "node:missing";',
        "export { Missing as exposed };",
      ],
      ["default", 'import Missing from "node:missing";', "export { Missing };"],
      [
        "namespace",
        'import * as Missing from "node:missing";',
        "export { Missing };",
      ],
      [
        "public-type",
        'import { Missing } from "node:missing";',
        "export function inspect(value: Missing): void;",
      ],
    ])(
      "rejects a locally exported unresolved %s import",
      async (_, importText, exportText) => {
        const isolatedFixture = await materializeNodeProviderFixture(
          [
            'declare module "node:fs" {',
            `  ${importText}`,
            `  ${exportText}`,
            "}",
            "",
          ].join("\n")
        );

        try {
          const outcome = await inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          });

          expect(outcome).toStrictEqual({
            message:
              "A declaration re-export could not be resolved from Installed Evidence.",
            reason: "unsupported-evidence",
            status: "unsupported",
          });
        } finally {
          await isolatedFixture.cleanup();
        }
      }
    );

    it.each([
      ["type", 'export type Missing = import("node:missing").Missing;'],
      ["typeof", 'export type Missing = typeof import("node:missing");'],
    ])("rejects an unresolved inline import %s", async (_, declaration) => {
      const isolatedFixture = await materializeNodeProviderFixture(
        ['declare module "node:fs" {', `  ${declaration}`, "}", ""].join("\n")
      );

      try {
        const [overview, focused] = await Promise.all([
          inspectInterfaceOverview({
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          }),
          inspectExport({
            exportName: "Missing",
            resolutionContext: isolatedFixture.resolutionContext,
            specifier: "node:fs",
          }),
        ]);

        const failure = {
          message:
            "A declaration re-export could not be resolved from Installed Evidence.",
          reason: "unsupported-evidence",
          status: "unsupported",
        } as const;

        expect([overview, focused]).toStrictEqual([failure, failure]);
      } finally {
        await isolatedFixture.cleanup();
      }
    });

    it.each(["Buffer", "NodeJS"])(
      "does not expose the %s global as a module",
      async (specifier) => {
        const outcome = await inspectInterfaceOverview({
          resolutionContext: process.cwd(),
          specifier,
        });

        expect(outcome.status).not.toBe("success");
      }
    );
  });
});
