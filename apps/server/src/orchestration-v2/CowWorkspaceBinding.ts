import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CowWorkspace from "../workspaceIsolation/CowWorkspaceService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** Validate before provider open; a missing private repository must never be rebuilt as a worktree. */
export const verifyCowThreadWorkspace = Effect.fn("verifyCowThreadWorkspace")(function* (
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath" | "lineage">,
) {
  if (thread.worktreePath === null) return;
  const cow = yield* CowWorkspace.CowWorkspaceService;
  const rootPath = thread.worktreePath;
  const workspace = yield* cow.findByRoot({ rootPath });
  if (workspace === null) return;
  const parentThreadId = thread.lineage.parentThreadId;
  if (!workspace.threadIds.includes(thread.id) && parentThreadId !== null) {
    // Only committed same-project lineage can enroll an inherited worker. This
    // covers the race between its outbox turn and its caller's binding update.
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = yield* projections.getRuntimeRecoveryProjection(parentThreadId);
    if (parent.thread.projectId === thread.projectId && parent.thread.worktreePath === rootPath) {
      yield* cow.verify({ projectId: thread.projectId, threadId: parentThreadId, rootPath });
      yield* cow.attach({ projectId: thread.projectId, threadId: thread.id, rootPath });
    }
  }
  yield* cow.verify({ projectId: thread.projectId, threadId: thread.id, rootPath });
});
