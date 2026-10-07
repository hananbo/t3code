import { it, expect, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as CowWorkspace from "../workspaceIsolation/CowWorkspaceService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { verifyCowThreadWorkspace } from "./CowWorkspaceBinding.ts";

const projectId = ProjectId.make("cow-project");
const parentId = ThreadId.make("cow-parent");
const childId = ThreadId.make("cow-child");
const rootPath = "/isolated/cow/123";
const identity = { device: "1", inode: "2" };
const record: CowWorkspace.CowWorkspaceRecord = {
  schemaVersion: 1,
  workspaceId: "123",
  projectId,
  threadIds: [parentId],
  commandId: "create",
  executionHostId: "local",
  sourceRoot: "/project",
  sourceIdentity: identity,
  rootPath,
  rootIdentity: identity,
  gitIdentity: identity,
  state: "ready",
  branch: "cow-work",
  baseCommit: "abc",
  baselineTree: null,
  baseline: [],
  initialRefs: "",
  createdAt: "2026-10-06T00:00:00.000Z",
  integrationReceipts: [],
  historyRetained: false,
};
const child = {
  id: childId,
  projectId,
  worktreePath: rootPath,
  lineage: {
    parentThreadId: parentId,
    relationshipToParent: "subagent" as const,
    rootThreadId: parentId,
  },
};

it.effect(
  "enrolls an inherited worker only after verifying its persisted parent's ownership",
  () => {
    const owners = new Set<string>([parentId]);
    const verify = vi.fn((binding: { threadId: string }) =>
      owners.has(binding.threadId)
        ? Effect.succeed(record)
        : Effect.fail(
            new CowWorkspace.CowWorkspaceError({
              operation: "verify",
              reason: "ownership",
              cause: "Unowned",
            }),
          ),
    );
    const attach = vi.fn((binding: { threadId: string }) =>
      Effect.sync(() => {
        owners.add(binding.threadId);
      }),
    );
    return Effect.gen(function* () {
      yield* verifyCowThreadWorkspace(child);
      expect(verify.mock.calls.map(([binding]) => binding.threadId)).toEqual([parentId, childId]);
      expect(attach).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CowWorkspace.CowWorkspaceService)({
            findByRoot: () => Effect.succeed(record),
            verify,
            attach,
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRecoveryProjection: () =>
              Effect.succeed({
                thread: { ...child, id: parentId },
              } as ProjectionStore.ProjectionRuntimeRecoveryState),
          }),
        ),
      ),
    );
  },
);

it.effect("rejects a child whose persisted parent uses another root", () => {
  const attach = vi.fn(() => Effect.void);
  return Effect.gen(function* () {
    const result = yield* verifyCowThreadWorkspace(child).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(attach).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(CowWorkspace.CowWorkspaceService)({
          findByRoot: () => Effect.succeed(record),
          attach,
          verify: () =>
            Effect.fail(
              new CowWorkspace.CowWorkspaceError({
                operation: "verify",
                reason: "ownership",
                cause: "Unowned",
              }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRecoveryProjection: () =>
            Effect.succeed({
              thread: { ...child, id: parentId, worktreePath: "/other" },
            } as ProjectionStore.ProjectionRuntimeRecoveryState),
        }),
      ),
    ),
  );
});

it.effect(
  "rejects a missing managed copy before the provider can recreate it as a Git worktree",
  () =>
    Effect.gen(function* () {
      const result = yield* verifyCowThreadWorkspace({ ...child, id: parentId }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CowWorkspace.CowWorkspaceService)({
            findByRoot: () => Effect.succeed(record),
            verify: () =>
              Effect.fail(
                new CowWorkspace.CowWorkspaceError({
                  operation: "verify",
                  reason: "ownership",
                  cause: "Missing root",
                }),
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ),
      ),
    ),
);
