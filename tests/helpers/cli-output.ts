import { expect } from "vite-plus/test";

import { splitCodePoints } from "#typepeek/code-point-ranges";

const UNSAFE_TERMINAL_CODE_POINTS = new Set([
  ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
  ...Array.from({ length: 33 }, (_, offset) => 0x7f + offset),
  1564,
  8206,
  8207,
  ...Array.from({ length: 7 }, (_, offset) => 8232 + offset),
  ...Array.from({ length: 4 }, (_, offset) => 8294 + offset),
]);

const isLayoutWhitespace = function isLayoutWhitespace(
  character: string
): boolean {
  return character === "\n" || character === "\r" || character === "\t";
};

const isUnsafeTerminalCharacter = function isUnsafeTerminalCharacter(
  character: string
): boolean {
  return UNSAFE_TERMINAL_CODE_POINTS.has(character.codePointAt(0) ?? 0);
};

export const expectTerminalSafe = function expectTerminalSafe(
  output: string
): void {
  expect(
    splitCodePoints(output).some(
      (character) =>
        !isLayoutWhitespace(character) && isUnsafeTerminalCharacter(character)
    )
  ).toBeFalsy();
};

export const expectJsonTerminalSafe = function expectJsonTerminalSafe(
  output: string
): void {
  expect(
    splitCodePoints(output).some(
      (character) => character !== "\n" && isUnsafeTerminalCharacter(character)
    )
  ).toBeFalsy();
};

export const expectTerminalSafeLine = function expectTerminalSafeLine(
  output: string
): void {
  expect(splitCodePoints(output).some(isUnsafeTerminalCharacter)).toBeFalsy();
};
