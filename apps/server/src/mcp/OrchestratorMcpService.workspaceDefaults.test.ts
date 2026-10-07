import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type Project,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

describe("MCP scheduled workspace defaults", () => {
  it.effect(
    "honors configured CoW defaults, explicit roots, and unbinding without rewriting saved intent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          path.join(workspaceRoot, "t3.json"),
          '{"defaultThreadEnvMode":"cow"}',
        );
        const project: Project = {
          id: ProjectId.make("project:workspace-defaults"),
          title: "Workspace defaults",
          workspaceRoot,
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          scripts: [],
          createdAt: "2026-10-06T00:00:00.000Z",
          updatedAt: "2026-10-06T00:00:00.000Z",
          deletedAt: null,
        };
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:workspace-defaults"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
          requestNamespace: "workspace-defaults",
          thread: undefined,
          client: { sessionId: "test", label: "Test", access: "full-access" },
        };
        const tasks = yield* Ref.make<readonly ScheduledTask[]>([]);
        const dependencies = Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome(project),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () => Ref.get(tasks).pipe(Effect.map((tasks) => ({ tasks }))),
            upsert: (input) =>
              Effect.gen(function* () {
                const rows = yield* Ref.get(tasks);
                assert.equal(input.schedule.type, "interval");
                if (input.schedule.type !== "interval")
                  return yield* Effect.die("Unexpected test schedule");
                const task: ScheduledTask = {
                  ...input,
                  id: input.id ?? ScheduledTaskId.make(`task:${rows.length}`),
                  schedule: input.schedule,
                  threadId: input.threadId ?? null,
                  createdBy: input.createdBy ?? "agent",
                  creationSource: input.creationSource ?? "mcp",
                  createdAt: project.createdAt,
                  updatedAt: project.updatedAt,
                  nextRunAt: null,
                  lastRunAt: null,
                  lastRunStatus: "never",
                  lastRunError: null,
                  runCount: 0,
                };
                yield* Ref.set(tasks, [...rows.filter((row) => row.id !== task.id), task]);
                return { task };
              }),
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const settings = yield* ServerSettings.ServerSettingsService;
          const create = (workspaceStrategy?: { type: "root" }) =>
            service.scheduleTask(scope, {
              projectId: project.id,
              prompt: "Check project",
              schedule: { type: "interval", everyMs: 60_000 },
              ...(workspaceStrategy ? { workspaceStrategy } : {}),
            });
          const latest = Ref.get(tasks).pipe(Effect.map((rows) => rows[rows.length - 1]!));
          yield* create();
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "cow" });
          yield* create({ type: "root" });
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "root" });
          yield* settings.updateSettings({ defaultThreadEnvMode: "local" });
          yield* create();
          assert.deepEqual((yield* latest).workspaceStrategy, {
            type: "worktree",
            baseRef: "main",
            startFromOrigin: true,
          });
          yield* settings.updateSettings({ defaultThreadEnvMode: null });
          yield* create();
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "cow" });
          yield* settings.updateSettings({
            projectSettingsOverrides: { [project.id]: { defaultThreadEnvMode: "worktree" } },
          });
          yield* create();
          assert.equal((yield* latest).workspaceStrategy.type, "worktree");
          yield* settings.updateSettings({
            projectSettingsOverrides: { [project.id]: { defaultThreadEnvMode: "cow" } },
          });
          const bound = {
            ...(yield* latest),
            threadId: ThreadId.make("thread:bound"),
            workspaceStrategy: { type: "root" as const },
          };
          yield* Ref.set(tasks, [bound]);
          yield* service.updateScheduledTask(scope, {
            scheduledTaskId: bound.id,
            bindToCurrentThread: false,
          });
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "cow" });
          assert.equal((yield* latest).threadId, null);
          yield* settings.updateSettings({
            projectSettingsOverrides: { [project.id]: { defaultThreadEnvMode: "local" } },
          });
          yield* service.updateScheduledTask(scope, {
            scheduledTaskId: bound.id,
            prompt: "Updated prompt",
          });
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "cow" });
          yield* service.updateScheduledTask(scope, {
            scheduledTaskId: bound.id,
            workspaceStrategy: { type: "root" },
          });
          assert.deepEqual((yield* latest).workspaceStrategy, { type: "root" });
        }).pipe(
          Effect.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(dependencies),
              Layer.provideMerge(ServerSettings.layerTest({ defaultThreadEnvMode: "cow" })),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
