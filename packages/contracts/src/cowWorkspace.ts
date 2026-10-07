import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CowWorkspaceStrategy = Schema.Struct({
  type: Schema.Literal("cow"),
  branch: Schema.optional(TrimmedNonEmptyString),
});

export const CowWorkspaceCapability = Schema.Struct({
  backend: Schema.Literal("apfs"),
  supported: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export type CowWorkspaceCapability = typeof CowWorkspaceCapability.Type;

export const CowWorkspace = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  backend: Schema.Literal("apfs"),
  rootPath: TrimmedNonEmptyString,
  state: Schema.Literals(["ready", "archived", "missing"]),
  branch: Schema.NullOr(Schema.String),
});
export type CowWorkspace = typeof CowWorkspace.Type;

export const CowWorkspaceProbeInput = Schema.Struct({ projectId: ProjectId });
export const CowWorkspaceInspectInput = Schema.Struct({ threadId: ThreadId });
export const CowWorkspaceChangesInput = Schema.Struct({
  threadId: ThreadId,
  workspaceId: TrimmedNonEmptyString,
});
export const CowWorkspaceChangesResult = Schema.Array(
  Schema.Struct({
    path: TrimmedNonEmptyString,
    kind: Schema.Literals(["added", "modified", "deleted"]),
  }),
);
export const CowWorkspaceIntegrateInput = Schema.Struct({
  threadId: ThreadId,
  workspaceId: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export const CowWorkspaceIntegrateResult = Schema.Struct({
  integrationId: TrimmedNonEmptyString,
  conflicts: Schema.Array(Schema.String),
});
export const CowWorkspaceRemoveInput = Schema.Struct({
  threadId: ThreadId,
  workspaceId: TrimmedNonEmptyString,
  force: Schema.optional(Schema.Boolean),
});
export class CowWorkspaceError extends Schema.TaggedError<CowWorkspaceError>()(
  "CowWorkspaceError",
  { message: Schema.String },
) {}
