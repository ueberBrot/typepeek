import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";

const EXPORT_PAGE_SIZE = 100;
export const MAX_EXPORT_INDEX_CANDIDATES = 16_384;
export const MAX_EXPORT_CURSOR_BYTES = 80;
const CONTINUATION = /^[a-f0-9]{64}\.[1-9][0-9]{0,4}$/u;

export const exportCursorSchema = Schema.String.check(
  Schema.makeFilter((value) => value === "start" || CONTINUATION.test(value), {
    expected: '"start" or an export index continuation cursor',
  }),
);

export const exportPageSchema = Schema.Struct({
  cursor: exportCursorSchema,
  totalModuleExports: Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_EXPORT_INDEX_CANDIDATES)),
  complete: Schema.Boolean,
  nextCursor: Schema.optionalKey(exportCursorSchema),
});
export type ExportPage = typeof exportPageSchema.Type;

/** Binds continuation to the selected target and its entire sorted export-name index. */
export function paginateExports(
  names: readonly { readonly name: string }[],
  cursor: string,
  scope: string,
):
  | { readonly moduleExports: readonly { readonly name: string }[]; readonly page: ExportPage }
  | undefined {
  const digest = createHash("sha256")
    .update(JSON.stringify([scope, names]))
    .digest("hex");
  const offset = cursor === "start" ? 0 : Number(cursor.slice(65));
  if (
    cursor !== "start" &&
    (!CONTINUATION.test(cursor) ||
      cursor.slice(0, 64) !== digest ||
      offset >= names.length ||
      offset % EXPORT_PAGE_SIZE !== 0)
  )
    return undefined;
  const moduleExports = names.slice(offset, offset + EXPORT_PAGE_SIZE);
  const nextOffset = offset + moduleExports.length;
  return {
    moduleExports,
    page: {
      cursor,
      totalModuleExports: names.length,
      complete: offset === 0 && nextOffset === names.length,
      ...(nextOffset < names.length ? { nextCursor: `${digest}.${nextOffset}` } : {}),
    },
  };
}

/** Checks page completeness and continuation arithmetic at the outcome boundary. */
export function isConsistentExportPage(page: ExportPage, count: number): boolean {
  const offset = page.cursor === "start" ? 0 : Number(page.cursor.slice(65));
  const end = offset + count;
  const nextCursor = Object.hasOwn(page, "nextCursor") ? page.nextCursor : undefined;
  return (
    (page.cursor === "start" ||
      (offset < page.totalModuleExports && offset % EXPORT_PAGE_SIZE === 0)) &&
    count <= EXPORT_PAGE_SIZE &&
    end <= page.totalModuleExports &&
    count === Math.min(EXPORT_PAGE_SIZE, page.totalModuleExports - offset) &&
    page.complete === (offset === 0 && end === page.totalModuleExports) &&
    (end < page.totalModuleExports
      ? nextCursor !== undefined &&
        nextCursor !== "start" &&
        Number(nextCursor.slice(65)) === end &&
        (page.cursor === "start" || nextCursor.slice(0, 64) === page.cursor.slice(0, 64))
      : nextCursor === undefined)
  );
}
