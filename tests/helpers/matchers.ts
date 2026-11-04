import { expect } from "vite-plus/test";

export type MatcherFactoryName =
  | "any"
  | "anything"
  | "arrayContaining"
  | "objectContaining"
  | "stringContaining"
  | "stringMatching";

export type AsymmetricMatchers = {
  readonly [Name in MatcherFactoryName]: (
    ...parameters: Parameters<(typeof expect)[Name]>
  ) => object;
};

/** Vitest types asymmetric matchers as any; this view retains their object contract. */
export const match: AsymmetricMatchers = expect;
