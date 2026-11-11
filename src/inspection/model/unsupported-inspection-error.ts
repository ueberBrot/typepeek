/** Signals that Installed Evidence cannot support an authoritative inspection. */
export class UnsupportedInspectionError extends Error {
  override name = "UnsupportedInspectionError";
}
