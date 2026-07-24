import type { DuluthEvent } from "../schema.js";
import type { SourceDef } from "../sources.js";

/** Every adapter takes a source definition and returns validated, normalized events. */
export type Adapter = (source: SourceDef) => Promise<DuluthEvent[]>;
