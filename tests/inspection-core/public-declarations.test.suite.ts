import { expect, test } from "vite-plus/test";

import { inspectExport, inspectExportSignatures } from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";

export const registerPublicDeclarationTests =
  function registerPublicDeclarationTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("excludes Supporting Types referenced only by private declarations", async () => {
      const outcome = await inspectExport({
        exportName: "usePublicShape",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.supportingTypes.map(({ name }) => name),
        JSON.stringify(outcome.result.supportingTypes).includes("PrivateOnly"),
        JSON.stringify(outcome.result.supportingTypes).includes("private"),
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "#privateSecret"
        ),
        JSON.stringify(outcome.result.supportingTypes).includes(
          "protected readonly inherited"
        ),
      ]).toStrictEqual([
        ["PublicShape", "VisibleOnly"],
        false,
        false,
        false,
        true,
      ]);
    });

    test("preserves public constructor inputs without exposing private parameter properties", async () => {
      const outcome = await inspectExport({
        exportName: "Constructed",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/focused",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.supportingTypes
          .map(({ name }) => name)
          .includes("ConstructorInput"),
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "constructor(input: ConstructorInput)"
        ),
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "private readonly input"
        ),
      ]).toStrictEqual([true, true, false]);
    });

    test.each([
      ["Export Inspection", inspectExport],
      ["Signature Inspection", inspectExportSignatures],
    ] as const)(
      "preserves inherited standard-library constructor inputs in %s",
      async (_, inspect) => {
        const outcome = await inspect({
          exportName: "InheritedError",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        });

        expect(outcome.status).toBe("success");

        if (outcome.status !== "success") {
          return;
        }

        expect(
          outcome.result.moduleExport.signatures.map(({ kind, text }) => ({
            kind,
            text,
          }))
        ).toStrictEqual([
          { kind: "construct", text: "new (message?: string): InheritedError" },
          {
            kind: "construct",
            text: "new (message?: string, options?: ErrorOptions): InheritedError",
          },
        ]);

        expect(
          "supportingTypes" in outcome.result
            ? outcome.result.supportingTypes
            : undefined
        ).toStrictEqual(
          outcome.result.intent === "export-inspection" ? [] : undefined
        );
      }
    );

    test.each([
      ["TransitiveError", 2],
      ["ErrorFactory", 4],
    ] as const)(
      "preserves the standard-library constructor surface of %s",
      async (exportName, signatureCount) => {
        const outcome = await inspectExportSignatures({
          exportName,
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        });

        expect(outcome.status).toBe("success");

        if (outcome.status !== "success") {
          return;
        }

        expect([
          outcome.result.moduleExport.signatures.length,
          outcome.result.moduleExport.signatures
            .map(({ text }) => text)
            .join("\n")
            .includes("message?: string"),
          outcome.result.moduleExport.signatures
            .map(({ text }) => text)
            .join("\n")
            .includes("options?: ErrorOptions"),
        ]).toStrictEqual([signatureCount, true, true]);
      }
    );

    test("preserves private-constructor instance properties without advertising construction", async () => {
      const outcome = await inspectExport({
        exportName: "PrivateToken",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      const publicSurface = JSON.stringify(outcome.result.moduleExport.spaces);
      expect([
        outcome.result.moduleExport.signatures,
        publicSurface.includes("readonly visible: VisibleOnly;"),
        publicSurface.includes("protected inherited: VisibleOnly;"),
        publicSurface.includes("private constructor();"),
        publicSurface.includes("secret"),
        outcome.result.supportingTypes.map(({ name }) => name),
      ]).toStrictEqual([[], true, true, true, false, ["VisibleOnly"]]);
    });

    test("does not advertise a protected constructor as publicly constructible", async () => {
      const outcome = await inspectExport({
        exportName: "ProtectedToken",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.signatures,
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "protected constructor(input: ConstructorInput);"
        ),
        outcome.result.supportingTypes.map(({ name }) => name),
      ]).toStrictEqual([[], true, ["ConstructorInput"]]);
    });

    test("projects parameter properties from public and private overload implementations", async () => {
      const [publicOutcome, privateOutcome] = await Promise.all([
        inspectExport({
          exportName: "PublicOverloadedToken",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/private-constructor-source",
        }),
        inspectExport({
          exportName: "PrivateOverloadedToken",
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/private-constructor-source",
        }),
      ]);

      expect([publicOutcome.status, privateOutcome.status]).toStrictEqual([
        "success",
        "success",
      ]);

      if (
        publicOutcome.status !== "success" ||
        privateOutcome.status !== "success"
      ) {
        return;
      }

      expect([
        JSON.stringify(publicOutcome.result.moduleExport.spaces).includes(
          "readonly visible: VisibleOnly;"
        ),
        publicOutcome.result.moduleExport.signatures,
        JSON.stringify(privateOutcome.result.moduleExport.spaces).includes(
          "readonly visible: VisibleOnly;"
        ),
      ]).toStrictEqual([
        true,
        [
          {
            kind: "construct",
            text: "new (visible: VisibleOnly): PublicOverloadedToken",
          },
        ],
        true,
      ]);

      for (const declaration of privateOutcome.result.moduleExport.spaces.flatMap(
        (space) => (space.space === "namespace" ? [] : space.declarations)
      )) {
        expect(declaration.text.match(/private constructor/gu)).toHaveLength(1);
      }

      expect([
        privateOutcome.result.moduleExport.signatures,
        privateOutcome.result.supportingTypes.map(({ name }) => name),
      ]).toStrictEqual([[], ["VisibleOnly"]]);
    });

    test("does not advertise an abstract class as publicly constructible", async () => {
      const outcome = await inspectExport({
        exportName: "AbstractBase",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.signatures,
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "abstract class AbstractBase"
        ),
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "constructor(value: string);"
        ),
      ]).toStrictEqual([[], true, true]);
    });

    test("does not advertise an abstract constructor type as publicly constructible", async () => {
      const outcome = await inspectExport({
        exportName: "AbstractConstructor",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      expect([
        outcome.result.moduleExport.signatures,
        JSON.stringify(outcome.result.moduleExport.spaces).includes(
          "abstract new (value: string)"
        ),
      ]).toStrictEqual([[], true]);
    });

    test("groups computed overloads by their checker-resolved property identity", async () => {
      const outcome = await inspectExport({
        exportName: "ComputedOverloaded",
        resolutionContext: getFixture().resolutionContext,
        specifier: "@typepeek-fixture/private-constructor-source",
      });

      expect(outcome.status).toBe("success");

      if (outcome.status !== "success") {
        return;
      }

      const publicSurface = JSON.stringify(outcome.result.moduleExport.spaces);
      expect([
        publicSurface.includes("[computedKey](value: string): string;"),
        publicSurface.includes("computedAlias"),
      ]).toStrictEqual([true, false]);
    });
  };
