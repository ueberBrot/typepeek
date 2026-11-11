import type { NodeBuilderFlags, TypeFormatFlags } from "tsrs/async";

import { bitwiseOr } from "#typepeek/shared/integer-bits";

export function mergeCompilerFlags(
  left: NodeBuilderFlags,
  right: NodeBuilderFlags
): NodeBuilderFlags;
export function mergeCompilerFlags(
  left: TypeFormatFlags,
  right: TypeFormatFlags
): TypeFormatFlags;
export function mergeCompilerFlags(left: number, right: number): number {
  return bitwiseOr(left, right);
}
