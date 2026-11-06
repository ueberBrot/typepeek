import { expect, test } from "vite-plus/test";

import {
  INSPECTION_INTENTS,
  INSPECTION_PROTOCOL_VERSION,
  inspectCapabilities,
  invokeInspectionProtocol,
} from "#typepeek/inspection";

import type { CompiledPackageFixture } from "../helpers/compiled-package-fixture.ts";

export const registerRequestAdmissionTests =
  function registerRequestAdmissionTests(
    getFixture: () => CompiledPackageFixture
  ): void {
    test("rejects unsupported protocol versions before inspection", async () => {
      await expect(
        invokeInspectionProtocol({
          intent: "interface-overview",
          protocolVersion: "2",
          request: {
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
        })
      ).resolves.toStrictEqual({
        outcome: {
          message: 'Inspection protocol version "2" is not supported.',
          reason: "unsupported-protocol-version",
          status: "unsupported",
        },
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
      });
    });

    test.each([
      null,
      {},
      {
        intent: "runtime-execution",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {},
      },
      {
        intent: "interface-overview",
        protocolVersion: "x".repeat(65),
        request: {},
      },
    ])(
      "rejects malformed adapter envelopes without entering inspection",
      async (request) => {
        await expect(invokeInspectionProtocol(request)).resolves.toStrictEqual({
          outcome: {
            message: "Inspection received an invalid protocol request.",
            reason: "invalid-request",
            status: "unsupported",
          },
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
        });
      }
    );

    test("does not evaluate protocol-envelope accessors", async () => {
      const request = {
        intent: "interface-overview",
        get protocolVersion(): string {
          throw new Error("protocol version getter was evaluated");
        },
        request: {},
      };

      await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
        outcome: { reason: "invalid-request", status: "unsupported" },
      });
    });

    test("does not enumerate protocol-envelope keys", async () => {
      const request = new Proxy(
        {
          intent: "interface-overview",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {
            resolutionContext: getFixture().resolutionContext,
            specifier: "@typepeek-fixture/focused",
          },
        },
        {
          ownKeys(): never {
            throw new Error("protocol envelope keys were enumerated");
          },
        }
      );

      await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
        outcome: {
          result: { intent: "interface-overview" },
          status: "success",
        },
      });
    });

    test("turns hostile protocol-envelope descriptors into an invalid request", async () => {
      const request = new Proxy(
        {},
        {
          getOwnPropertyDescriptor(): never {
            throw new Error("protocol envelope descriptor is unavailable");
          },
        }
      );

      await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
        outcome: { reason: "invalid-request", status: "unsupported" },
      });
    });

    test("tolerates unknown protocol-envelope fields without reading them", async () => {
      const request = {
        get futureTransportMetadata(): never {
          throw new Error("unknown protocol field was evaluated");
        },
        intent: "interface-overview",
        protocolVersion: INSPECTION_PROTOCOL_VERSION,
        request: {
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
      };

      await expect(invokeInspectionProtocol(request)).resolves.toMatchObject({
        outcome: {
          result: { intent: "interface-overview" },
          status: "success",
        },
      });
    });

    test("reads only bounded known fields from the nested inspection request", async () => {
      const request = new Proxy(
        {
          resolutionContext: getFixture().resolutionContext,
          specifier: "@typepeek-fixture/focused",
        },
        {
          ownKeys(): never {
            throw new Error("nested request keys were enumerated");
          },
        }
      );

      await expect(
        invokeInspectionProtocol({
          intent: "interface-overview",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request,
        })
      ).resolves.toMatchObject({
        outcome: {
          result: { intent: "interface-overview" },
          status: "success",
        },
      });
    });

    test("keeps exported protocol vocabularies immutable at runtime", async () => {
      expect(() =>
        Array.prototype.push.call(INSPECTION_INTENTS, "runtime-execution")
      ).toThrow(TypeError);
      expect([
        Reflect.set(inspectCapabilities(), "protocolVersion", "999"),
        inspectCapabilities().protocolVersion,
      ]).toStrictEqual([false, INSPECTION_PROTOCOL_VERSION]);
      await expect(
        invokeInspectionProtocol({
          intent: "runtime-execution",
          protocolVersion: INSPECTION_PROTOCOL_VERSION,
          request: {},
        })
      ).resolves.toMatchObject({
        outcome: { reason: "invalid-request", status: "unsupported" },
      });
    });
  };
