import { Predicate, Result, Schema } from "effect";

import { snapshotBoundedDataPropertyGraph } from "#typepeek/inspection/untrusted-data";

export const MAX_MEMBER_PATH_SEGMENTS = 16;
export const MAX_MEMBER_PATH_SEGMENT_BYTES = 256;

export const memberDeclarationSpaceSchema = Schema.Literals([
  "type",
  "value",
  "namespace",
]);

export const memberNameSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (segment) => Buffer.byteLength(segment) <= MAX_MEMBER_PATH_SEGMENT_BYTES,
    {
      expected: "a bounded member path segment",
    }
  )
);

const memberPathSegmentSchema = Schema.Union([
  memberNameSchema,
  Schema.Struct({
    name: memberNameSchema,
    space: memberDeclarationSpaceSchema,
  }),
]);

export const memberDiscoveryPathSchema = Schema.Array(
  memberPathSegmentSchema
).check(Schema.isMaxLength(MAX_MEMBER_PATH_SEGMENTS));

export const memberPathSchema = memberDiscoveryPathSchema.check(
  Schema.isMinLength(1)
);

export type MemberPath = typeof memberDiscoveryPathSchema.Type;

const decodeMemberPath = Schema.decodeUnknownResult(memberDiscoveryPathSchema, {
  onExcessProperty: "error",
});

/** Snapshots a bounded, dense Member path before decoding its selectors. */
export const readBoundedMemberPath = function readBoundedMemberPath(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Member selectors arrive from untrusted requests and require descriptor-safe validation.
  value: unknown,
  allowEmpty = false
): MemberPath | undefined {
  if (
    !Array.isArray(value) ||
    value.length < (allowEmpty ? 0 : 1) ||
    value.length > MAX_MEMBER_PATH_SEGMENTS
  ) {
    return undefined;
  }

  const snapshot = snapshotBoundedDataPropertyGraph(value, {
    maximumObjects: MAX_MEMBER_PATH_SEGMENTS + 1,
    maximumStringBytes: MAX_MEMBER_PATH_SEGMENT_BYTES,
    maximumValues: MAX_MEMBER_PATH_SEGMENTS * 3 + 1,
  });

  return Result.getOrUndefined(decodeMemberPath(snapshot));
};

/** Renders selectors using the CLI Member path spelling. */
export const formatMemberPath = function formatMemberPath(
  path: MemberPath
): string {
  return path
    .map((segment) =>
      Predicate.isString(segment) ? segment : `${segment.space}:${segment.name}`
    )
    .join(".");
};

export const memberPathsEqual = function memberPathsEqual(
  left: MemberPath,
  right: MemberPath
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];

      return Predicate.isString(segment)
        ? segment === other
        : Predicate.isReadonlyObject(other) &&
            segment.name === other.name &&
            segment.space === other.space;
    })
  );
};
