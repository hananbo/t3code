import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CowWorkspaceError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  type TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Terminals from "../terminal/Manager.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as Cow from "./CowWorkspaceService.ts";
import * as Operations from "./CowWorkspaceOperations.ts";

const threadId = ThreadId.make("cow-owner");
const otherId = ThreadId.make("cow-shared");
const projectId = ProjectId.make("cow-project");
const rootPath = "/tmp/cow-operations/workspace";
const sourceRoot = "/tmp/cow-operations/source";
const identity = { device: "1", inode: "2" };
const record: Cow.CowWorkspaceRecord = {
  schemaVersion: 1,
  workspaceId: "cow-id",
  projectId,
  threadIds: [threadId],
  commandId: "create",
  executionHostId: "local",
  sourceRoot,
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
const makeProjection = (id = threadId, cwd: string | null = rootPath) =>
  ({
    thread: {
      id,
      projectId,
      worktreePath: cwd,
      deletedAt: null,
      archivedAt: null,
      branch: "cow-work",
    },
    runs: [],
    providerSessions: [],
    providerThreads: [],
  }) as unknown as OrchestrationV2ThreadProjection;

function scenario(
  options: {
    readonly other?: OrchestrationV2ThreadProjection;
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly registeredRoot?: string;
    readonly owners?: ReadonlyArray<ThreadId>;
    readonly liveRoot?: string;
    readonly terminal?: TerminalSummary;
    readonly state?: Cow.CowWorkspaceRecord["state"];
    readonly beforeGuard?: (projection: OrchestrationV2ThreadProjection) => void;
  } = {},
) {
  const owner = makeProjection();
  if (options.deleted) Object.assign(owner.thread, { deletedAt: "2026-10-06T00:00:00.000Z" });
  let mutations = 0;
  const currentRecord = {
    ...record,
    state: options.state ?? "ready",
    threadIds: options.owners ?? record.threadIds,
  };
  const projections = new Map([
    [threadId, owner],
    ...(options.other === undefined ? [] : [[options.other.thread.id, options.other] as const]),
  ]);
  const shell = options.other?.thread as OrchestrationV2ThreadShell | undefined;
  const mutation = (input: Parameters<Cow.CowWorkspaceService["Service"]["remove"]>[0]) =>
    withWorkspaceLease(
      rootPath,
      Effect.gen(function* () {
        options.beforeGuard?.(owner);
        if (input.guard) yield* input.guard(currentRecord);
        mutations++;
      }),
    );
  const layer = Operations.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Cow.CowWorkspaceService)({
          findByRoot: () => Effect.succeed(currentRecord),
          verify: () => Effect.succeed(currentRecord),
          remove: mutation,
          integrate: (input) =>
            mutation(input).pipe(Effect.as({ integrationId: "integration", conflicts: [] })),
          changes: (input) => mutation(input).pipe(Effect.as([])),
        }),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadRecords: (id) => Effect.succeed(projections.get(id)!),
        }),
        Layer.mock(Projects.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: sourceRoot } as Project)),
          snapshot: Effect.succeed({
            projects: [
              { id: projectId, workspaceRoot: options.registeredRoot ?? sourceRoot } as Project,
            ],
            updatedAt: "2026-10-06T00:00:00.000Z",
          }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: (input) =>
            Effect.succeed({
              threads:
                shell !== undefined &&
                (input?.location === "archive") === (options.archived === true)
                  ? [shell]
                  : [],
            } as unknown as Effect.Success<
              ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getShellSnapshot"]>
            >),
        }),
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
          hasLiveSessionInWorkspace: (root) => Effect.succeed(root === options.liveRoot),
        }),
        Layer.mock(Terminals.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({
              type: "snapshot",
              terminals: options.terminal === undefined ? [] : [options.terminal],
            }).pipe(Effect.as(() => {})),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, mutationCount: () => mutations };
}
const input = { threadId, workspaceId: record.workspaceId };
const assertFailure = <A, E>(result: Exit.Exit<A, E>, message: string) => {
  assert(Exit.isFailure(result));
  assert.include(Cause.pretty(result.cause), message);
};

it.effect("rejects a stale allocation id inside lifecycle authority", () => {
  const test = scenario();
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.changes({ ...input, workspaceId: "old-id" }).pipe(Effect.exit),
      "workspace has changed",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect("rejects a thread rebound while a lifecycle operation waits", () => {
  const test = scenario({
    beforeGuard: (projection) => {
      Object.assign(projection.thread, { worktreePath: sourceRoot });
    },
  });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(yield* ops.remove({ ...input, force: true }).pipe(Effect.exit), "no longer owns");
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect.each([false, true])(
  "refuses removal while a shared thread remains (archived=%s)",
  (archived) => {
    const test = scenario({ other: makeProjection(otherId), archived });
    return Effect.gen(function* () {
      const ops = yield* Operations.CowWorkspaceOperations;
      assertFailure(
        yield* ops.remove({ ...input, force: true }).pipe(Effect.exit),
        "Another thread still uses",
      );
      assert.equal(test.mutationCount(), 0);
    }).pipe(Effect.provide(test.layer));
  },
);
it.effect("blocks integration while the source checkout has a live provider", () => {
  const test = scenario({ liveRoot: sourceRoot });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.integrate({ ...input, paths: ["file"] }).pipe(Effect.exit),
      "Stop all provider sessions",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect("blocks deletion for a terminal in a child directory even with force", () => {
  const test = scenario({
    terminal: {
      threadId: otherId,
      terminalId: "terminal",
      cwd: `${rootPath}/subdir`,
      worktreePath: null,
      pid: 123,
      status: "running",
      exitCode: null,
      exitSignal: null,
      hasRunningSubprocess: false,
      label: "terminal",
      updatedAt: "2026-10-06T00:00:00.000Z",
    } satisfies TerminalSummary,
  });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.remove({ ...input, force: true }).pipe(Effect.exit),
      "Close all terminals",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect("blocks integration for a preparing source thread before its provider opens", () => {
  const other = makeProjection(otherId, null);
  Object.assign(other, { runs: [{ status: "starting" }] });
  const test = scenario({ other });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.integrate({ ...input, paths: ["file"] }).pipe(Effect.exit),
      "Stop all agents",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect("allows idle owning-thread cleanup", () => {
  const test = scenario();
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    yield* ops.remove(input);
    assert.equal(test.mutationCount(), 1);
  }).pipe(Effect.provide(test.layer));
});
it.effect("does not label a quarantined allocation ready", () => {
  const test = scenario({ state: "quarantined" });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(yield* ops.inspect({ threadId }).pipe(Effect.exit), "requires recovery");
  }).pipe(Effect.provide(test.layer));
});

it.effect("a historical owner running elsewhere does not prevent removing its former copy", () => {
  const other = makeProjection(otherId, "/unrelated/project");
  Object.assign(other, { runs: [{ status: "running" }] });
  const test = scenario({ other, owners: [threadId, otherId] });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    yield* ops.remove(input);
    assert.equal(test.mutationCount(), 1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("background tasks still prevent deletion after the root run settles", () => {
  const other = makeProjection(otherId);
  Object.assign(other, {
    providerThreads: [{ pendingBackgroundTasks: [{ id: "background-task" }] }],
  });
  const test = scenario({ other });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.remove({ ...input, force: true }).pipe(Effect.exit),
      "Stop all agents",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("only deleted owning threads qualify for automatic Cow cleanup", () => {
  const test = scenario();
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.removeDeleted(input, Effect.void).pipe(Effect.exit),
      "Only deleted threads",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
it.effect("deleted-thread cleanup rechecks policy before removing under the lease", () => {
  const test = scenario({ deleted: true });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops
        .removeDeleted(
          input,
          Effect.fail(new CowWorkspaceError({ message: "pending cleanup effects" })),
        )
        .pipe(Effect.exit),
      "pending cleanup effects",
    );
    assert.equal(test.mutationCount(), 0);
    yield* ops.removeDeleted(input, Effect.void);
    assert.equal(test.mutationCount(), 1);
  }).pipe(Effect.provide(test.layer));
});
it.effect("a registered project inside the copy prevents deletion", () => {
  const test = scenario({ deleted: true, registeredRoot: `${rootPath}/nested` });
  return Effect.gen(function* () {
    const ops = yield* Operations.CowWorkspaceOperations;
    assertFailure(
      yield* ops.removeDeleted(input, Effect.void).pipe(Effect.exit),
      "registered project uses",
    );
    assert.equal(test.mutationCount(), 0);
  }).pipe(Effect.provide(test.layer));
});
