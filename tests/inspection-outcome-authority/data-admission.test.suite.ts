import { expect, test } from "vite-plus/test";

import { enforceInspectionOutcome } from "#typepeek/inspection/model/inspection-outcome-authority";

import { defineObjectPrototypeProperty } from "../helpers/prototype-fixture.ts";

export const registerDataAdmissionTests =
  function registerDataAdmissionTests(): void {
    test("rejects inherited Inspection Outcome accessors without evaluating them", () => {
      let statusRead = false;

      const outcome = {
        result: { inspections: [], intent: "inspection-plan" },
      };

      Object.setPrototypeOf(outcome, {
        get status() {
          statusRead = true;

          return "success";
        },
      });
      expect([
        enforceInspectionOutcome("inspection-plan", outcome),
        statusRead,
      ]).toStrictEqual([
        {
          message: "Inspection returned an invalid result.",
          reason: "invalid-result",
          status: "unsupported",
        },
        false,
      ]);
    });

    test("does not read Inspection Outcome fields inherited from Object.prototype", () => {
      let statusRead = false;
      let enforced: ReturnType<typeof enforceInspectionOutcome>;
      defineObjectPrototypeProperty("status", {
        configurable: true,
        get() {
          statusRead = true;

          return "success";
        },
      });

      try {
        enforced = enforceInspectionOutcome("inspection-plan", {
          result: { inspections: [], intent: "inspection-plan" },
        });
      } finally {
        Reflect.deleteProperty(Object.prototype, "status");
      }

      expect([enforced, statusRead]).toStrictEqual([
        {
          message: "Inspection returned an invalid result.",
          reason: "invalid-result",
          status: "unsupported",
        },
        false,
      ]);
    });

    test("bounds protocol graph validation before structural schema checking", () => {
      expect(
        enforceInspectionOutcome("interface-overview", {
          result: {
            intent: "interface-overview",
            moduleExports: Array.from({ length: 4097 }, (_, index) => ({
              name: `item${index}`,
            })),
            packageIdentity: { name: "example" },
            publicSubpaths: [],
            specifier: "example",
          },
          status: "success",
        })
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("rejects compiler-shaped data in a focused Inspection Outcome", () => {
      const spaces = Object.assign(
        [
          {
            declarations: [
              {
                kind: "function",
                provenance: {
                  column: 1,
                  file: "index.d.ts",
                  line: 1,
                  packageIdentity: { name: "example" },
                },
                text: "function createExample(): void;",
              },
            ],
            space: "value",
          },
        ],
        { compilerNode: { flags: 1 } }
      );

      expect(
        enforceInspectionOutcome("export-inspection", {
          result: {
            intent: "export-inspection",
            moduleExport: {
              name: "createExample",
              signatures: [],
              spaces,
            },
            packageIdentity: { name: "example" },
            specifier: "example",
            supportingTypes: [],
          },
          status: "success",
        })
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("rejects accessor properties without evaluating them", () => {
      const outcome = {
        message: "missing",
        status: "not-found",
      };

      Object.defineProperty(outcome, "extra", {
        enumerable: true,
        get() {
          throw new Error("getter was evaluated");
        },
      });
      expect(
        enforceInspectionOutcome("interface-overview", outcome)
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("contains throwing accessors on non-record outcome inputs", () => {
      const outcome: unknown[] = [];
      Object.defineProperties(outcome, {
        message: {
          get() {
            throw new Error("outcome getter was evaluated");
          },
        },
        status: { value: "not-found" },
      });
      expect(
        enforceInspectionOutcome("interface-overview", outcome)
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("rejects arrays and functions masquerading as Inspection Outcome records", () => {
      const arrayOutcome: unknown[] = [];
      Object.setPrototypeOf(arrayOutcome, {
        message: "missing",
        status: "not-found",
      });
      expect(
        enforceInspectionOutcome("interface-overview", arrayOutcome)
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });

      const functionOutcome = Object.assign(() => {}, {
        message: "missing",
        status: "not-found",
      });

      expect(
        enforceInspectionOutcome("interface-overview", functionOutcome)
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });

    test("rejects sparse arrays in a focused Inspection Outcome", () => {
      const supportingTypes: unknown[] = [];
      supportingTypes.length = 1_000_000_000;
      expect(
        enforceInspectionOutcome("export-inspection", {
          result: {
            intent: "export-inspection",
            moduleExport: {
              name: "createExample",
              signatures: [],
              spaces: [],
            },
            packageIdentity: { name: "example" },
            specifier: "example",
            supportingTypes,
          },
          status: "success",
        })
      ).toStrictEqual({
        message: "Inspection returned an invalid result.",
        reason: "invalid-result",
        status: "unsupported",
      });
    });
  };
