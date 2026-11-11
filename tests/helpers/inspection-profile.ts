import { Schema } from "effect";

import { decodeJson } from "#typepeek/shared/json-data";

export const profilePhaseNames = function profilePhaseNames(
  serialized: string
): readonly string[] {
  const profile = decodeJson(
    Schema.Struct({
      phases: Schema.mutableKey(
        Schema.mutable(
          Schema.Array(
            Schema.Struct({
              name: Schema.mutableKey(Schema.String),
            })
          )
        )
      ),
    }),
    serialized
  );

  return profile.phases.map(({ name }) => name);
};
