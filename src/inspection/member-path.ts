import { Result, Schema } from "effect";

export const MAX_MEMBER_PATH_SEGMENTS = 16;
export const MAX_MEMBER_PATH_SEGMENT_BYTES = 256;
export const memberPathSchema = Schema.Array(
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((segment) => Buffer.byteLength(segment) <= MAX_MEMBER_PATH_SEGMENT_BYTES, {
      expected: "a bounded member path segment",
    }),
  ),
).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_MEMBER_PATH_SEGMENTS));

const decodeMemberPath = Schema.decodeUnknownResult(memberPathSchema);

/** Snapshots one bounded, dense Member path without invoking array accessors. */
export function readBoundedMemberPath(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MEMBER_PATH_SEGMENTS) {
    return undefined;
  }
  const segments: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !isMemberPathSegment(descriptor.value)
    ) {
      return undefined;
    }
    segments.push(descriptor.value);
  }
  return Object.keys(value).length === value.length
    ? Result.getOrUndefined(decodeMemberPath(segments))
    : undefined;
}

function isMemberPathSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_MEMBER_PATH_SEGMENT_BYTES
  );
}
