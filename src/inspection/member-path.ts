const MAX_MEMBER_PATH_SEGMENTS = 16;
const MAX_MEMBER_PATH_SEGMENT_BYTES = 256;

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
  return Object.keys(value).length === value.length ? segments : undefined;
}

function isMemberPathSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_MEMBER_PATH_SEGMENT_BYTES
  );
}
