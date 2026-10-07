import type { OrchestrationV2ServerCommand, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as CowWorkspace from "../workspaceIsolation/CowWorkspaceService.ts";
import * as Orchestrator from "./Orchestrator.ts";

const isOrchestratorV2Error = Schema.is(Orchestrator.OrchestratorV2Error);
const isCowWorkspaceError = Schema.is(CowWorkspace.CowWorkspaceError);

/** Commit workspace references under the same authority as provider startup and removal. */
export const dispatchWithCowWorkspaceBinding = (
  command: OrchestrationV2ServerCommand,
  orchestrator: Orchestrator.OrchestratorV2Shape,
  cow: CowWorkspace.CowWorkspaceService["Service"] | undefined,
) =>
  Effect.gen(function* () {
    let enrollment:
      | { projectId: ProjectId; threadId: ThreadId; rootPath: string; relatedRootPath?: string }
      | undefined;
    let sourceBinding:
      | { threadId: ThreadId; projectId: ProjectId; rootPath: string | null }
      | undefined;
    if (cow !== undefined && command.type === "thread.metadata.update") {
      const current = (yield* orchestrator.getThreadProjection(command.threadId)).thread;
      const previousRoot =
        current.worktreePath !== null &&
        (yield* cow.findByRoot({ rootPath: current.worktreePath })) !== null
          ? current.worktreePath
          : undefined;
      const targetRoot =
        command.worktreePath && (yield* cow.findByRoot({ rootPath: command.worktreePath })) !== null
          ? command.worktreePath
          : undefined;
      if (previousRoot !== undefined && targetRoot === undefined) {
        // Moving away from a missing/removed copy changes only the durable
        // reference. Its journal still proves ownership without needing the
        // deleted checkout to pass filesystem verification.
        return yield* withWorkspaceLease(
          previousRoot,
          Effect.gen(function* () {
            const latest = (yield* orchestrator.getThreadProjection(command.threadId)).thread;
            const record = yield* cow.findByRoot({ rootPath: previousRoot });
            if (
              latest.worktreePath !== previousRoot ||
              record === null ||
              record.projectId !== latest.projectId ||
              !record.threadIds.includes(latest.id)
            )
              return yield* new CowWorkspace.CowWorkspaceError({
                operation: "detach",
                reason: "ownership",
                cause: "Workspace binding changed before dispatch",
              });
            return yield* orchestrator.dispatch(command);
          }),
        );
      }
      if (previousRoot !== undefined || targetRoot !== undefined) {
        sourceBinding = {
          threadId: current.id,
          projectId: current.projectId,
          rootPath: current.worktreePath,
        };
        const rootPath = targetRoot ?? previousRoot!;
        enrollment = {
          projectId: current.projectId,
          threadId: current.id,
          rootPath,
          ...(previousRoot !== undefined && previousRoot !== rootPath
            ? { relatedRootPath: previousRoot }
            : {}),
        };
      }
    }
    if (cow !== undefined && command.type === "thread.create" && command.worktreePath) {
      const workspace = yield* cow.findByRoot({ rootPath: command.worktreePath });
      if (workspace !== null)
        enrollment = {
          projectId: command.projectId,
          threadId: command.threadId,
          rootPath: command.worktreePath,
        };
    }
    if (cow !== undefined && command.type === "thread.fork") {
      const source = (yield* orchestrator.getThreadProjection(command.sourceThreadId)).thread;
      const rootPath = source.worktreePath;
      if (rootPath !== null && (yield* cow.findByRoot({ rootPath })) !== null) {
        sourceBinding = { threadId: source.id, projectId: source.projectId, rootPath };
        enrollment = { projectId: source.projectId, threadId: command.targetThreadId, rootPath };
      }
    }
    if (cow === undefined || enrollment === undefined) return yield* orchestrator.dispatch(command);
    let dispatched: Orchestrator.OrchestratorV2DispatchResult | undefined;
    // Commit the new reference and enroll its owner under one lifecycle lease.
    // A failed command never adds an owner; a concurrent removal cannot pass
    // its reference check between the command commit and enrollment.
    yield* cow.attach({
      ...enrollment,
      beforeAttach: () =>
        Effect.gen(function* () {
          if (sourceBinding !== undefined) {
            const current = (yield* orchestrator.getThreadProjection(sourceBinding.threadId))
              .thread;
            if (
              current.projectId !== sourceBinding.projectId ||
              current.worktreePath !== sourceBinding.rootPath
            )
              return yield* new CowWorkspace.CowWorkspaceError({
                operation: "attach",
                reason: "ownership",
                cause: "Workspace binding changed before dispatch",
              });
            if (sourceBinding.rootPath !== null) {
              const sourceRecord = yield* cow.findByRoot({ rootPath: sourceBinding.rootPath });
              if (sourceRecord !== null) {
                if (
                  sourceRecord.projectId !== current.projectId ||
                  !sourceRecord.threadIds.includes(current.id)
                )
                  return yield* new CowWorkspace.CowWorkspaceError({
                    operation: "attach",
                    reason: "ownership",
                    cause: "Source workspace ownership changed",
                  });
                if (command.type === "thread.fork")
                  yield* cow.verify({
                    projectId: sourceBinding.projectId,
                    threadId: sourceBinding.threadId,
                    rootPath: sourceBinding.rootPath,
                  });
              }
            }
            if (
              command.type === "thread.metadata.update" &&
              command.worktreePath &&
              command.worktreePath !== sourceBinding.rootPath &&
              (yield* cow.findByRoot({ rootPath: command.worktreePath })) !== null
            )
              yield* cow.verify({
                projectId: current.projectId,
                threadId: current.id,
                rootPath: command.worktreePath,
              });
          }
          dispatched = yield* orchestrator.dispatch(command);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CowWorkspace.CowWorkspaceError({ operation: "attach", reason: "io", cause }),
          ),
        ),
    });
    if (dispatched === undefined)
      return yield* new CowWorkspace.CowWorkspaceError({
        operation: "attach",
        reason: "io",
        cause: "Workspace binding did not commit",
      });
    return dispatched;
  }).pipe(
    Effect.mapError((cause) => {
      const original = isCowWorkspaceError(cause) ? cause.cause : cause;
      return isOrchestratorV2Error(original)
        ? original
        : new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          });
    }),
  );
