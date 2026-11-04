/** Signals that a request crosses Typepeek's no-execution inspection boundary. */
export class StaticBoundaryInspectionError extends Error {
  override name = "StaticBoundaryInspectionError";
}
