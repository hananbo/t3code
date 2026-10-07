import {
  CowWorkspaceError,
  type CowWorkspace,
  type CowWorkspaceCapability,
  type CowWorkspaceChangesInput,
  type CowWorkspaceChangesResult,
  type CowWorkspaceIntegrateInput,
  type CowWorkspaceIntegrateResult,
  type CowWorkspaceRemoveInput,
  type ProjectId,
  ThreadId,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Cow from "./CowWorkspaceService.ts";

export class CowWorkspaceOperations extends Context.Service<
  CowWorkspaceOperations,
  {
    readonly probe: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<CowWorkspaceCapability, CowWorkspaceError>;
    readonly inspect: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<CowWorkspace | null, CowWorkspaceError>;
    readonly changes: (
      input: typeof CowWorkspaceChangesInput.Type,
    ) => Effect.Effect<typeof CowWorkspaceChangesResult.Type, CowWorkspaceError>;
    readonly integrate: (
      input: typeof CowWorkspaceIntegrateInput.Type,
    ) => Effect.Effect<typeof CowWorkspaceIntegrateResult.Type, CowWorkspaceError>;
    /** Storage cleanup supplies its policy/outbox recheck; it runs inside the same removal lease. */
    readonly removeDeleted: (
      input: typeof CowWorkspaceRemoveInput.Type,
      recheck: Effect.Effect<void, CowWorkspaceError>,
    ) => Effect.Effect<void, CowWorkspaceError>;
    readonly remove: (
      input: typeof CowWorkspaceRemoveInput.Type,
    ) => Effect.Effect<void, CowWorkspaceError>;
  }
>()("t3/workspaceIsolation/CowWorkspaceOperations") {}

const isCowError = Schema.is(Cow.CowWorkspaceError);
const isOperationError = Schema.is(CowWorkspaceError);
const mapError = (cause: unknown): CowWorkspaceError => {
  if (isOperationError(cause)) return cause;
  if (isCowError(cause) && isOperationError(cause.cause)) return cause.cause;
  return new CowWorkspaceError({
    message: isCowError(cause)
      ? cause.message
      : "The copy-on-write workspace operation could not be completed.",
  });
};
const unavailable = (message: string) => Effect.fail(new CowWorkspaceError({ message }));

const make = Effect.gen(function* () {
  const cow = yield* Cow.CowWorkspaceService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providerSessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const binding = Effect.fn("CowWorkspaceOperations.binding")(function* (threadId: ThreadId) {
    const projection = yield* threads.getThreadRecords(threadId, ["runs"]);
    const project = yield* projects.getById(projection.thread.projectId);
    if (Option.isNone(project) || projection.thread.worktreePath === null)
      return yield* unavailable("This thread has no copy-on-write workspace.");
    return {
      projectId: projection.thread.projectId,
      threadId,
      rootPath: projection.thread.worktreePath,
      projection,
    };
  });
  const inside = (root: string, target: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const requireIdle = Effect.fn("CowWorkspaceOperations.requireIdle")(function* (
    record: Cow.CowWorkspaceRecord,
    requestingThreadId: ThreadId,
    removing: boolean,
  ) {
    const roots = removing ? [record.rootPath] : [record.rootPath, record.sourceRoot];
    const usesWorkspace = (cwd: string) => roots.some((root) => inside(root, cwd));
    for (const root of roots) {
      if (yield* providerSessions.hasLiveSessionInWorkspace(root))
        return yield* unavailable(
          "Stop all provider sessions using this workspace before changing or removing it.",
        );
    }
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projectSnapshot = yield* projects.snapshot;
    const projectRoots = new Map(
      projectSnapshot.projects.map((project) => [project.id, project.workspaceRoot]),
    );
    if (removing) {
      for (const project of projectSnapshot.projects) {
        const canonicalRoot = yield* fs
          .realPath(project.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => project.workspaceRoot));
        if (inside(record.rootPath, canonicalRoot))
          return yield* unavailable(
            "A registered project uses this workspace. Move or remove it first.",
          );
      }
    }
    const candidates = new Map(
      [...active.threads, ...archived.threads].map((thread) => [thread.id, thread]),
    );
    const owners = new Set(record.threadIds.map((id) => ThreadId.make(id)));
    for (const thread of candidates.values()) {
      const cwd = thread.worktreePath ?? projectRoots.get(thread.projectId);
      if (cwd !== undefined && usesWorkspace(cwd)) owners.add(thread.id);
    }
    for (const owner of owners) {
      const projection = yield* threads.getThreadRecords(owner, [
        "runs",
        "providerSessions",
        "providerThreads",
      ]);
      const currentCwd =
        projection.thread.worktreePath ?? projectRoots.get(projection.thread.projectId);
      const boundHere = currentCwd !== undefined && usesWorkspace(currentCwd);
      if (
        (boundHere &&
          projection.runs.some((run) =>
            ["running", "preparing", "queued", "starting", "waiting"].includes(run.status),
          )) ||
        projection.providerThreads.some(
          (thread) =>
            (thread.pendingBackgroundTasks?.length ?? 0) > 0 &&
            (boundHere ||
              projection.providerSessions.some(
                (session) => session.id === thread.providerSessionId && usesWorkspace(session.cwd),
              )),
        ) ||
        projection.providerSessions.some(
          (session) => usesWorkspace(session.cwd) && !["stopped", "error"].includes(session.status),
        )
      )
        return yield* unavailable(
          "Stop all agents using this workspace before changing or removing it.",
        );
      if (
        removing &&
        owner !== requestingThreadId &&
        projection.thread.deletedAt === null &&
        projection.thread.worktreePath !== null &&
        inside(record.rootPath, projection.thread.worktreePath)
      )
        return yield* unavailable(
          "Another thread still uses this workspace. Delete or detach it first.",
        );
    }
    let open: ReadonlyArray<TerminalSummary> = [];
    yield* Effect.acquireUseRelease(
      terminals.subscribeMetadata((event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") open = event.terminals;
          else if (event.type === "upsert")
            open = [
              ...open.filter(
                (item) =>
                  item.threadId !== event.terminal.threadId ||
                  item.terminalId !== event.terminal.terminalId,
              ),
              event.terminal,
            ];
          else
            open = open.filter(
              (item) => item.threadId !== event.threadId || item.terminalId !== event.terminalId,
            );
        }),
      ),
      () => Effect.void,
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    if (
      open.some(
        (item) =>
          (item.pid !== null ||
            item.hasRunningSubprocess ||
            item.status === "starting" ||
            item.status === "running") &&
          (usesWorkspace(item.cwd) ||
            (item.worktreePath !== null && usesWorkspace(item.worktreePath))),
      )
    )
      return yield* unavailable("Close all terminals using this workspace first.");
  });
  // The core calls this after acquiring its workspace leases and reading the
  // authoritative journal, so a stale UI cannot act on a replacement allocation.
  const guard =
    (input: { readonly threadId: ThreadId; readonly workspaceId: string }, removing?: boolean) =>
    (record: Cow.CowWorkspaceRecord) =>
      Effect.gen(function* () {
        if (record.workspaceId !== input.workspaceId)
          return yield* unavailable("This workspace has changed. Refresh before continuing.");
        const current = yield* threads.getThreadRecords(input.threadId, []);
        if (
          current.thread.projectId !== record.projectId ||
          current.thread.worktreePath !== record.rootPath
        )
          return yield* unavailable("This thread no longer owns the selected workspace.");
        if (removing !== undefined) yield* requireIdle(record, input.threadId, removing);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Cow.CowWorkspaceError({
              operation: "lifecycle",
              reason: "ownership",
              cause: mapError(cause),
            }),
        ),
      );
  return CowWorkspaceOperations.of({
    probe: (input) =>
      projects.getById(input.projectId).pipe(
        Effect.flatMap((project) =>
          Option.isSome(project)
            ? cow.probe({ sourceRoot: project.value.workspaceRoot })
            : unavailable("Project was not found."),
        ),
        Effect.mapError(mapError),
      ),
    removeDeleted: (input, recheck) =>
      Effect.gen(function* () {
        const bound = yield* binding(input.threadId);
        yield* cow.remove({
          ...bound,
          guard: (record) =>
            Effect.gen(function* () {
              yield* guard(input, true)(record);
              const current = yield* threads.getThreadRecords(input.threadId, []);
              if (current.thread.deletedAt === null)
                return yield* unavailable("Only deleted threads qualify for this cleanup policy.");
              yield* recheck;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new Cow.CowWorkspaceError({
                    operation: "lifecycle",
                    reason: "ownership",
                    cause: mapError(cause),
                  }),
              ),
            ),
        });
      }).pipe(Effect.mapError(mapError)),
    inspect: (input) =>
      Effect.gen(function* () {
        const projection = yield* threads.getThreadRecords(input.threadId, []);
        if (projection.thread.worktreePath === null) return null;
        const record = yield* cow.findByRoot({ rootPath: projection.thread.worktreePath });
        if (record === null) return null;
        if (
          record.projectId !== projection.thread.projectId ||
          !record.threadIds.includes(input.threadId)
        )
          return yield* unavailable("Copy-on-write ownership could not be verified.");
        if (!["ready", "removed"].includes(record.state))
          return yield* unavailable("This workspace requires recovery before it can be used.");
        const exists = yield* fs.exists(record.rootPath);
        if (exists && record.state === "ready")
          yield* cow.verify({
            projectId: record.projectId,
            threadId: input.threadId,
            rootPath: record.rootPath,
          });
        return {
          workspaceId: record.workspaceId,
          backend: "apfs" as const,
          rootPath: record.rootPath,
          state:
            !exists || record.state === "removed"
              ? ("missing" as const)
              : projection.thread.archivedAt !== null
                ? ("archived" as const)
                : ("ready" as const),
          branch: projection.thread.branch,
        };
      }).pipe(Effect.mapError(mapError)),
    changes: (input) =>
      binding(input.threadId).pipe(
        Effect.flatMap((bound) => cow.changes({ ...bound, guard: guard(input) })),
        Effect.mapError(mapError),
      ),
    integrate: (input) =>
      Effect.gen(function* () {
        const bound = yield* binding(input.threadId);
        return yield* cow.integrate({ ...bound, paths: input.paths, guard: guard(input, false) });
      }).pipe(Effect.mapError(mapError)),
    remove: (input) =>
      Effect.gen(function* () {
        const bound = yield* binding(input.threadId);
        yield* cow.remove({
          ...bound,
          guard: guard(input, true),
          ...(input.force === undefined ? {} : { force: input.force }),
        });
      }).pipe(Effect.mapError(mapError)),
  });
});

export const layer = Layer.effect(CowWorkspaceOperations, make);
