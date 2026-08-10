/** Signals that an inspection exhausted a measured work or output budget. */
export class InspectionLimitError extends Error {}

/** Signals that Installed Evidence cannot support an authoritative inspection. */
export class UnsupportedInspectionError extends Error {}

/** Signals that a request crosses Typepeek's no-execution inspection boundary. */
export class StaticBoundaryInspectionError extends Error {}
