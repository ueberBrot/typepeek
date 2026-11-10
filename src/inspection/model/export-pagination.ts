import { Schema } from "effect";

import { MAX_EXPORT_INDEX_CANDIDATES } from "#typepeek/inspection/model/budget-policy";
import { sha256 } from "#typepeek/platform/platform-crypto";

const EXPORT_PAGE_SIZE = 100;
export const MAX_EXPORT_CURSOR_BYTES = 80;
const CONTINUATION = /^[a-f0-9]{64}\.[1-9]\d{0,4}$/u;

export const exportCursorSchema = Schema.String.check(
  Schema.makeFilter((value) => value === "start" || CONTINUATION.test(value), {
    expected: '"start" or an export index continuation cursor',
  })
);

export const exportPageSchema = Schema.Struct({
  complete: Schema.Boolean,
  cursor: exportCursorSchema,
  nextCursor: Schema.optionalKey(exportCursorSchema),
  totalModuleExports: Schema.Natural.check(
    Schema.isLessThanOrEqualTo(MAX_EXPORT_INDEX_CANDIDATES)
  ),
});

export type ExportPage = typeof exportPageSchema.Type;

/** Binds continuation to the selected target and its entire sorted export-name index. */
export const paginateExports = function paginateExports(
  names: readonly {
    readonly name: string;
  }[],
  cursor: string,
  scope: string
):
  | {
      readonly moduleExports: readonly {
        readonly name: string;
      }[];
      readonly page: ExportPage;
    }
  | undefined {
  const digest = sha256(JSON.stringify([scope, names]));

  const offset = cursor === "start" ? 0 : Number(cursor.slice(65));

  if (cursor !== "start") {
    const isAlignedOffset =
      offset < names.length && offset % EXPORT_PAGE_SIZE === 0;

    if (
      !CONTINUATION.test(cursor) ||
      cursor.slice(0, 64) !== digest ||
      !isAlignedOffset
    ) {
      return undefined;
    }
  }

  const moduleExports = names.slice(offset, offset + EXPORT_PAGE_SIZE);
  const nextOffset = offset + moduleExports.length;

  return {
    moduleExports,
    page: {
      complete: offset === 0 && nextOffset === names.length,
      cursor,
      totalModuleExports: names.length,
      ...(nextOffset < names.length && {
        nextCursor: `${digest}.${nextOffset}`,
      }),
    },
  };
};

/** Checks page completeness and continuation arithmetic at the outcome boundary. */
export const isConsistentExportPage = function isConsistentExportPage(
  page: ExportPage,
  count: number
): boolean {
  const offset = page.cursor === "start" ? 0 : Number(page.cursor.slice(65));
  const end = offset + count;

  const nextCursor = Object.hasOwn(page, "nextCursor")
    ? page.nextCursor
    : undefined;

  if (
    !(
      page.cursor === "start" ||
      (offset < page.totalModuleExports && offset % EXPORT_PAGE_SIZE === 0)
    )
  ) {
    return false;
  }

  if (count > EXPORT_PAGE_SIZE) {
    return false;
  }

  if (end > page.totalModuleExports) {
    return false;
  }

  if (count !== Math.min(EXPORT_PAGE_SIZE, page.totalModuleExports - offset)) {
    return false;
  }

  if (page.complete !== (offset === 0 && end === page.totalModuleExports)) {
    return false;
  }

  if (end >= page.totalModuleExports) {
    return nextCursor === undefined;
  }

  if (
    nextCursor === undefined ||
    nextCursor === "start" ||
    Number(nextCursor.slice(65)) !== end
  ) {
    return false;
  }

  return (
    page.cursor === "start" ||
    nextCursor.slice(0, 64) === page.cursor.slice(0, 64)
  );
};
