import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2AppThreadJson,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as Projections from "./orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";
import * as Terminals from "./terminal/Manager.ts";
import * as Git from "./vcs/GitVcsDriver.ts";
import * as Cow from "./workspaceIsolation/CowWorkspaceService.ts";
import * as CowOperations from "./workspaceIsolation/CowWorkspaceOperations.ts";
import * as Cleanup from "./storageCleanup.ts";
import { ServerActivation } from "./serverActivation.ts";

const encodeThreadJson = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));

it.effect.each(["deleted", "pending-effects", "policy-changed", "inactive"] as const)(
  "Cow storage sweep: %s",
  (scenario) =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
      const rootPath = `${config.worktreesDir}/cow/allocation`;
      const projectId = ProjectId.make("project-cleanup-cow");
      const threadId = ThreadId.make("thread-cleanup-cow");
      const time = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
      const appThread = {
        id: threadId,
        projectId,
        title: "Copy",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "cow-work",
        worktreePath: rootPath,
        activeProviderThreadId: null,
        lastVisitedAt: null,
        lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
        forkedFrom: null,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: time,
        updatedAt: time,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: scenario === "inactive" ? null : time,
      };
      const payload = yield* encodeThreadJson(appThread);
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/unrelated-source','[]','2026-01-01','2026-01-01')`;
      if (scenario !== "inactive")
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,deleted_at,payload_json) VALUES (${threadId},${projectId},'Copy','codex','full-access','default','2026-01-01','2026-01-01','2026-01-01',${payload})`;
      if (scenario === "pending-effects")
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id,command_id,thread_id,effect_type,payload_json,status,available_at,created_at,updated_at) VALUES ('pending','command',${threadId},'cleanup','{}','pending','2026-01-01','2026-01-01','2026-01-01')`;
      let removed = 0;
      const shell = {
        ...appThread,
        status: "idle",
        activeRunId: null,
        pendingBackgroundTasks: [],
        pendingRuntimeRequest: null,
        latestUserMessageAt: null,
      } as unknown as OrchestrationV2ThreadShell;
      const settingsLayer = Settings.layerTest({
        storageCleanup: { worktreeAfterDays: 1, worktreeOnDelete: true },
      });
      const layer = Layer.mergeAll(
        settingsLayer,
        Layer.mock(Projects.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed([
              { id: projectId, workspaceRoot: "/unrelated-source" },
            ] as unknown as Effect.Success<
              ReturnType<Projects.ProjectStoreV2["Service"]["listShells"]>
            >),
        }),
        Layer.mock(Projections.ProjectionStoreV2)({
          getShellSnapshot: (input) =>
            Effect.succeed({
              threads: scenario === "inactive" && input?.location !== "archive" ? [shell] : [],
            } as unknown as Effect.Success<
              ReturnType<Projections.ProjectionStoreV2["Service"]["getShellSnapshot"]>
            >),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        Layer.mock(Terminals.TerminalManager)({
          subscribeMetadata: () => Effect.succeed(() => {}),
        }),
        Layer.mock(Git.GitVcsDriver)({
          removeWorktree: () => Effect.die("CoW must never invoke Git worktree removal"),
        }),
        Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
        Layer.mock(Cow.CowWorkspaceService)({
          findByRoot: () =>
            Effect.succeed({ workspaceId: "allocation", rootPath } as Cow.CowWorkspaceRecord),
        }),
        Layer.unwrap(
          Effect.gen(function* () {
            const settings = yield* Settings.ServerSettingsService;
            return Layer.mock(CowOperations.CowWorkspaceOperations)({
              removeDeleted: (_input, recheck) =>
                Effect.gen(function* () {
                  if (scenario === "policy-changed")
                    yield* settings
                      .updateSettings({ storageCleanup: { worktreeOnDelete: false } })
                      .pipe(Effect.orDie);
                  yield* recheck;
                  removed++;
                }),
            });
          }),
        ).pipe(Layer.provide(settingsLayer)),
      );
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.StorageCleanup;
        const report = yield* cleanup.runNow;
        assert.equal(removed, scenario === "deleted" ? 1 : 0);
        const entries = report.entries.filter((entry) => entry.kind === "worktree");
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.path, rootPath);
        assert.equal(entries[0]?.outcome, scenario === "deleted" ? "removed" : "kept");
        assert.equal(entries[0]?.bytes, null);
      }).pipe(
        Effect.provide(Cleanup.layer.pipe(Layer.provide(layer))),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          Sqlite.layerMemory,
          Config.layerTest(process.cwd(), { prefix: "cow-cleanup-test-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
