// @effect-diagnostics nodeBuiltinImport:off - Real Git/APFS fixtures require byte-preserving file and subprocess assertions.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, beforeAll, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ApfsClone from "./ApfsClone.ts";
import * as CowWorkspace from "./CowWorkspaceService.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const macOS = HostProcess.Platform.defaultValue() === "darwin";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
let root: string;
let helper: string;

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(
    async () =>
      (
        await execFile("git", [
          "-C",
          cwd,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ])
      ).stdout,
  );
const write = (rootPath: string, path: string, contents: string) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(rootPath, path), contents));
const read = (rootPath: string, path: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(rootPath, path), "utf8"));
const recordPath = (stateDir: string, rootPath: string) =>
  NodePath.join(
    stateDir,
    "cow-workspaces",
    `${NodeCrypto.createHash("sha256").update(NodePath.resolve(rootPath)).digest("hex")}.json`,
  );

const withFixture = <A, E>(
  use: (input: {
    directory: string;
    sourceRoot: string;
    home: string;
  }) => Effect.Effect<
    A,
    E,
    | CowWorkspace.CowWorkspaceService
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(root, "fixture-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const sourceRoot = NodePath.join(directory, "source");
    const home = NodePath.join(directory, "home");
    yield* Effect.promise(() => NodeFSP.mkdir(sourceRoot));
    yield* git(sourceRoot, ["init", "-q", "-b", "main"]);
    yield* git(sourceRoot, ["config", "user.name", "CoW Test"]);
    yield* git(sourceRoot, ["config", "user.email", "cow-test@example.invalid"]);
    yield* write(sourceRoot, "file", "first\nsecond\nthird\nfourth\nfifth\n");
    yield* write(sourceRoot, "other", "original\n");
    yield* write(sourceRoot, ".gitignore", "ignored\n");
    yield* git(sourceRoot, ["add", "."]);
    yield* git(sourceRoot, ["commit", "-qm", "initial"]);
    return yield* use({ directory, sourceRoot, home }).pipe(
      Effect.provide(
        CowWorkspace.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ProcessRunner.layer,
              ApfsClone.layer,
              ServerSettings.layerTest(),
              ServerConfig.layerTest(sourceRoot, home),
            ),
          ),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              ...HostProcess.Environment.defaultValue(),
              T3CODE_APFS_CLONE_PATH: helper,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const create = (
  service: CowWorkspace.CowWorkspaceService["Service"],
  sourceRoot: string,
  suffix = "one",
) =>
  service.create({
    projectId: "project",
    threadId: `thread-${suffix}`,
    commandId: `command-${suffix}`,
    sourceRoot,
  });
const binding = (rootPath: string, suffix = "one") => ({
  projectId: "project",
  threadId: `thread-${suffix}`,
  rootPath,
});

describe.skipIf(!macOS)("CoW workspace APFS/Git integration", () => {
  beforeAll(async () => {
    root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cow-service-")),
    );
    helper = NodePath.join(root, "t3-apfs-clone");
    await execFile(process.execPath, [
      NodePath.resolve(import.meta.dirname, "../../../../scripts/build-apfs-clone.mjs"),
      "--output",
      helper,
    ]);
  });
  afterAll(async () => {
    if (root) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it.effect("uses the host home when expanding the shared isolation directory setting", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ worktreesDirectory: "~/isolated" });
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot).pipe(
          Effect.provideService(HostProcess.HomeDirectory, directory),
        );
        expect(NodePath.dirname(workspace.rootPath)).toBe(
          NodePath.join(directory, "isolated", "cow"),
        );
        expect(yield* read(workspace.rootPath, "other")).toBe("original\n");
        expect(yield* read(sourceRoot, "other")).toBe("original\n");
      }),
    ),
  );

  it.effect("preserves the native rejection reason when workspace creation fails", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const sourceStatus = yield* git(sourceRoot, ["status", "--porcelain=v1"]);
        yield* Effect.promise(() => execFile("mkfifo", [NodePath.join(sourceRoot, "ignored")]));
        const error = yield* create(service, sourceRoot).pipe(Effect.flip);
        expect(error.message).toContain("special-file; errno 45");
        expect(yield* git(sourceRoot, ["status", "--porcelain=v1"])).toBe(sourceStatus);
        expect(
          (yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(sourceRoot, "ignored")),
          )).isFIFO(),
        ).toBe(true);
      }),
    ),
  );

  it.effect(
    "inherits dirty index/worktree/local files without attributing them to the session",
    () =>
      withFixture(({ sourceRoot }) =>
        Effect.gen(function* () {
          const service = yield* CowWorkspace.CowWorkspaceService;
          yield* write(sourceRoot, "file", "staged inherited\n");
          yield* git(sourceRoot, ["add", "file"]);
          yield* write(sourceRoot, "file", "unstaged inherited\n");
          yield* write(sourceRoot, "untracked", "inherited local\n");
          yield* write(sourceRoot, "ignored", "runtime content\n");
          const sourceIndex = yield* git(sourceRoot, ["show", ":file"]);
          const sourceStatus = yield* git(sourceRoot, ["status", "--porcelain=v1"]);
          const workspace = yield* create(service, sourceRoot);
          expect(yield* service.probe({ sourceRoot })).toEqual({
            backend: "apfs",
            supported: true,
          });
          expect(yield* read(workspace.rootPath, "file")).toBe("unstaged inherited\n");
          expect(yield* read(workspace.rootPath, "untracked")).toBe("inherited local\n");
          expect(yield* read(workspace.rootPath, "ignored")).toBe("runtime content\n");
          expect(yield* git(workspace.rootPath, ["show", ":file"])).toBe(sourceIndex);
          expect(yield* git(workspace.rootPath, ["status", "--porcelain=v1"])).toBe(sourceStatus);
          expect(yield* service.changes(binding(workspace.rootPath))).toEqual([]);
          expect(yield* create(service, sourceRoot)).toEqual(workspace);
          yield* write(workspace.rootPath, "file", "agent content\n");
          yield* git(workspace.rootPath, ["add", "file"]);
          yield* git(workspace.rootPath, ["commit", "-qm", "session"]);
          expect(yield* git(sourceRoot, ["show", ":file"])).toBe(sourceIndex);
          expect(yield* git(sourceRoot, ["status", "--porcelain=v1"])).toBe(sourceStatus);
          expect((yield* git(sourceRoot, ["branch", "--list", workspace.branch])).trim()).toBe("");
          expect(yield* service.changes(binding(workspace.rootPath))).toEqual([
            { path: "file", kind: "modified" },
          ]);
        }),
      ),
  );

  it.effect("prepares private repositories from linked worktree sources", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        const linked = NodePath.join(directory, "linked");
        yield* git(sourceRoot, ["worktree", "add", "-q", "-b", "linked", linked]);
        yield* write(linked, "file", "linked staged\n");
        yield* git(linked, ["add", "file"]);
        yield* write(linked, "file", "linked unstaged\n");
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, linked);
        expect(yield* read(workspace.rootPath, "file")).toBe("linked unstaged\n");
        expect(yield* git(workspace.rootPath, ["show", ":file"])).toBe("linked staged\n");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(workspace.rootPath, ".git")),
          ).pipe(Effect.map((stat) => stat.isDirectory())),
        ).toBe(true);
        yield* write(workspace.rootPath, "file", "private\n");
        yield* git(workspace.rootPath, ["add", "file"]);
        yield* git(workspace.rootPath, ["commit", "-qm", "private commit"]);
        expect(yield* git(linked, ["show", ":file"])).toBe("linked staged\n");
        expect(yield* read(sourceRoot, "file")).toBe("first\nsecond\nthird\nfourth\nfifth\n");
        expect((yield* git(sourceRoot, ["branch", "--list", workspace.branch])).trim()).toBe("");
      }),
    ),
  );

  it.effect("ignores polluted Git routing variables during private repository preparation", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        const foreign = NodePath.join(directory, "foreign");
        yield* git(sourceRoot, ["clone", "-q", sourceRoot, foreign]);
        const foreignHead = yield* git(foreign, ["rev-parse", "HEAD"]);
        const foreignConfig = yield* read(foreign, ".git/config");
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* Effect.gen(function* () {
          yield* Effect.sync(() => {
            vi.stubEnv("GIT_DIR", NodePath.join(foreign, ".git"));
            vi.stubEnv("GIT_COMMON_DIR", NodePath.join(foreign, ".git"));
            vi.stubEnv("GIT_OBJECT_DIRECTORY", NodePath.join(foreign, ".git/objects"));
            vi.stubEnv("GIT_WORK_TREE", foreign);
            vi.stubEnv("GIT_INDEX_FILE", NodePath.join(foreign, ".git/index"));
          });
          return yield* create(service, sourceRoot);
        }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
        expect(yield* git(foreign, ["rev-parse", "HEAD"])).toBe(foreignHead);
        expect(yield* read(foreign, ".git/config")).toBe(foreignConfig);
        expect(yield* service.changes(binding(workspace.rootPath))).toEqual([]);
        yield* write(workspace.rootPath, "file", "private after polluted env\n");
        expect(yield* read(sourceRoot, "file")).toBe("first\nsecond\nthird\nfourth\nfifth\n");
      }),
    ),
  );

  it.effect(
    "preserves effective includeIf configuration without depending on source includes",
    () =>
      withFixture(({ directory, sourceRoot }) =>
        Effect.gen(function* () {
          const included = NodePath.join(directory, "identity.inc");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              included,
              '[user]\n name = Included Identity\n email = included@example.invalid\n[remote "origin"]\n url = ../remote.git\n',
            ),
          );
          yield* git(sourceRoot, ["config", `includeIf.gitdir:${sourceRoot}/.git.path`, included]);
          expect(
            (yield* git(sourceRoot, ["config", "--includes", "--get", "user.name"])).trim(),
          ).toBe("Included Identity");
          const service = yield* CowWorkspace.CowWorkspaceService;
          const workspace = yield* create(service, sourceRoot);
          yield* Effect.promise(() => NodeFSP.unlink(included));
          expect((yield* git(workspace.rootPath, ["config", "--get", "user.name"])).trim()).toBe(
            "Included Identity",
          );
          expect(
            (yield* git(workspace.rootPath, ["config", "--get", "remote.origin.url"])).trim(),
          ).toBe(NodePath.resolve(sourceRoot, "../remote.git"));
          expect(yield* read(workspace.rootPath, ".git/config")).not.toContain("includeIf");
        }),
      ),
  );

  it.effect(
    "integrates only the session delta and preserves target staging and independent edits",
    () =>
      withFixture(({ sourceRoot }) =>
        Effect.gen(function* () {
          const service = yield* CowWorkspace.CowWorkspaceService;
          yield* write(sourceRoot, "untracked", "inherited local\n");
          const workspace = yield* create(service, sourceRoot);
          yield* write(workspace.rootPath, "file", "agent first\nsecond\nthird\nfourth\nfifth\n");
          yield* write(sourceRoot, "file", "first\nsecond\nthird\nfourth\ntarget fifth\n");
          yield* write(sourceRoot, "other", "staged destination\n");
          yield* git(sourceRoot, ["add", "other"]);
          const indexBefore = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index")),
          );
          const first = yield* service.integrate({
            ...binding(workspace.rootPath),
            paths: ["file"],
          });
          expect(first.conflicts).toEqual([]);
          expect(yield* read(sourceRoot, "file")).toBe(
            "agent first\nsecond\nthird\nfourth\ntarget fifth\n",
          );
          expect(yield* read(sourceRoot, "untracked")).toBe("inherited local\n");
          expect(yield* read(sourceRoot, "other")).toBe("staged destination\n");
          expect(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index"))),
          ).toEqual(indexBefore);
          expect(
            yield* service.integrate({ ...binding(workspace.rootPath), paths: ["file"] }),
          ).toEqual(first);
        }),
      ),
  );

  it.effect("reports overlap conflicts without changing either checkout", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        yield* write(workspace.rootPath, "file", "agent replacement\n");
        yield* write(sourceRoot, "file", "target replacement\n");
        const result = yield* service.integrate({
          ...binding(workspace.rootPath),
          paths: ["file"],
        });
        expect(result.conflicts).toEqual(["file"]);
        expect(yield* read(sourceRoot, "file")).toBe("target replacement\n");
        expect(yield* read(workspace.rootPath, "file")).toBe("agent replacement\n");
      }),
    ),
  );

  it.effect("integrates additions, deletions, executable modes, symlinks and clean binaries", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(sourceRoot, "binary"), Buffer.from([0xff, 0, 1, 2])),
        );
        yield* write(directory, "outside", "outside sentinel\n");
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        const indexBefore = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index")),
        );
        const binary = Buffer.from([0xff, 0, 3, 4, 5]);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspace.rootPath, "binary"), binary),
        );
        yield* Effect.promise(() =>
          NodeFSP.chmod(NodePath.join(workspace.rootPath, "file"), 0o755),
        );
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(workspace.rootPath, "other")));
        yield* write(workspace.rootPath, "new", "session addition\n");
        yield* Effect.promise(() =>
          NodeFSP.symlink("file", NodePath.join(workspace.rootPath, "new-link")),
        );
        expect(yield* service.changes(binding(workspace.rootPath))).toEqual([
          { path: "binary", kind: "modified" },
          { path: "file", kind: "modified" },
          { path: "new", kind: "added" },
          { path: "new-link", kind: "added" },
          { path: "other", kind: "deleted" },
        ]);
        expect(
          (yield* service.integrate({
            ...binding(workspace.rootPath),
            paths: ["binary", "file", "new", "new-link", "other"],
          })).conflicts,
        ).toEqual([]);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, "binary"))),
        ).toEqual(binary);
        expect(
          (yield* Effect.promise(() => NodeFSP.stat(NodePath.join(sourceRoot, "file")))).mode &
            0o777,
        ).toBe(0o755);
        expect(yield* read(sourceRoot, "new")).toBe("session addition\n");
        expect(
          yield* Effect.promise(() => NodeFSP.readlink(NodePath.join(sourceRoot, "new-link"))),
        ).toBe("file");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(sourceRoot, "other")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index"))),
        ).toEqual(indexBefore);
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            NodePath.relative(workspace.rootPath, NodePath.join(directory, "outside")),
            NodePath.join(workspace.rootPath, "outside-link"),
          ),
        );
        const rejected = yield* service
          .integrate({
            ...binding(workspace.rootPath),
            paths: ["outside-link"],
          })
          .pipe(Effect.flip);
        expect(rejected._tag).toBe("CowWorkspaceError");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.lstat(NodePath.join(sourceRoot, "outside-link")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(yield* read(directory, "outside")).toBe("outside sentinel\n");
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index"))),
        ).toEqual(indexBefore);
      }),
    ),
  );

  it.effect("reports invalid UTF8 binary overlap as a conflict and preserves both files", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), Buffer.from([0xff, 0, 1, 2])),
        );
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        const agent = Buffer.from([0xff, 0, 3, 4]);
        const target = Buffer.from([0xff, 0, 5, 6]);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspace.rootPath, "file"), agent),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), target));
        expect(
          (yield* service.integrate({ ...binding(workspace.rootPath), paths: ["file"] })).conflicts,
        ).toEqual(["file"]);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, "file"))),
        ).toEqual(target);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(workspace.rootPath, "file"))),
        ).toEqual(agent);
      }),
    ),
  );

  it.effect("refuses ordinary deletion of staged and unstaged session changes", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        yield* write(workspace.rootPath, "file", "staged session\n");
        yield* git(workspace.rootPath, ["add", "file"]);
        expect((yield* service.remove(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "conflict",
        );
        yield* write(workspace.rootPath, "file", "unstaged session\n");
        expect((yield* service.remove(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "conflict",
        );
        expect(yield* git(workspace.rootPath, ["show", ":file"])).toBe("staged session\n");
        expect(yield* read(workspace.rootPath, "file")).toBe("unstaged session\n");
      }),
    ),
  );

  it.effect("retains HEAD, detached reflog commits, and stashes before forced deletion", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        yield* write(workspace.rootPath, "file", "committed session\n");
        yield* git(workspace.rootPath, ["add", "file"]);
        yield* git(workspace.rootPath, ["commit", "-qm", "retained session"]);
        const committed = (yield* git(workspace.rootPath, ["rev-parse", "HEAD"])).trim();
        yield* git(workspace.rootPath, ["checkout", "--detach", "-q"]);
        yield* write(workspace.rootPath, "file", "detached session\n");
        yield* git(workspace.rootPath, ["add", "file"]);
        yield* git(workspace.rootPath, ["commit", "-qm", "detached session"]);
        const detached = (yield* git(workspace.rootPath, ["rev-parse", "HEAD"])).trim();
        yield* git(workspace.rootPath, ["checkout", "-q", workspace.branch]);
        yield* write(workspace.rootPath, "file", "stash one\n");
        yield* git(workspace.rootPath, ["stash", "push", "-qm", "first stash"]);
        const stashOne = (yield* git(workspace.rootPath, ["rev-parse", "refs/stash"])).trim();
        yield* write(workspace.rootPath, "file", "stash two\n");
        yield* git(workspace.rootPath, ["stash", "push", "-qm", "second stash"]);
        const stashTwo = (yield* git(workspace.rootPath, ["rev-parse", "refs/stash"])).trim();
        yield* write(workspace.rootPath, "untracked", "discarded by explicit force\n");
        expect((yield* service.remove(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "conflict",
        );
        yield* service.remove({ ...binding(workspace.rootPath), force: true });
        const config = yield* ServerConfig.ServerConfig;
        const retained = NodePath.join(config.stateDir, "cow-workspaces", workspace.workspaceId);
        const restored = NodePath.join(retained, "restored.git");
        yield* git(sourceRoot, [
          "clone",
          "--bare",
          NodePath.join(retained, "history.bundle"),
          restored,
        ]);
        for (const hash of [committed, detached, stashOne, stashTwo]) {
          expect(
            (yield* git(sourceRoot, ["--git-dir", restored, "cat-file", "-t", hash])).trim(),
          ).toBe("commit");
        }
        expect((yield* service.findByRoot(workspace))?.state).toBe("removed");
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(workspace.rootPath).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true);
        yield* service.remove({ ...binding(workspace.rootPath), force: true });
        expect(yield* read(sourceRoot, "file")).toBe("first\nsecond\nthird\nfourth\nfifth\n");
      }),
    ),
  );

  it.effect("requires integration recovery before removal without changing the source", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        const config = yield* ServerConfig.ServerConfig;
        const original = yield* read(sourceRoot, "file");
        yield* write(workspace.rootPath, "file", "session change\n");
        yield* service.integrate({ ...binding(workspace.rootPath), paths: ["file"] });
        const journalPath = NodePath.join(
          config.stateDir,
          "cow-workspaces",
          workspace.workspaceId,
          "integration.json",
        );
        const journal = decodeJson(
          yield* Effect.promise(() => NodeFSP.readFile(journalPath, "utf8")),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(journalPath, encodeJson({ ...journal, state: "applying" })),
        );
        expect(
          (yield* service.remove({ ...binding(workspace.rootPath), force: true }).pipe(Effect.flip))
            .reason,
        ).toBe("recovery");
        expect(yield* read(sourceRoot, "file")).toBe("session change\n");
        expect(yield* read(workspace.rootPath, "file")).toBe("session change\n");
        yield* service.recover();
        expect(yield* read(sourceRoot, "file")).toBe(original);
        yield* service.remove({ ...binding(workspace.rootPath), force: true });
      }),
    ),
  );

  it.effect("refuses a replaced root and never deletes the replacement", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        yield* Effect.promise(() =>
          NodeFSP.rename(workspace.rootPath, `${workspace.rootPath}-original`),
        );
        yield* Effect.promise(() => NodeFSP.mkdir(workspace.rootPath, { mode: 0o700 }));
        yield* write(workspace.rootPath, "foreign", "keep me\n");
        expect((yield* service.verify(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "ownership",
        );
        expect(
          (yield* service.remove({ ...binding(workspace.rootPath), force: true }).pipe(Effect.flip))
            .reason,
        ).toBe("ownership");
        yield* service.recover();
        expect(yield* read(workspace.rootPath, "foreign")).toBe("keep me\n");
      }),
    ),
  );

  it.effect("refuses redirected private Git metadata and leaves its target intact", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        const foreign = NodePath.join(directory, "foreign");
        yield* git(sourceRoot, ["clone", "-q", sourceRoot, foreign]);
        const foreignConfig = yield* read(foreign, ".git/config");
        yield* Effect.promise(() =>
          NodeFSP.rename(
            NodePath.join(workspace.rootPath, ".git"),
            NodePath.join(directory, "private.git"),
          ),
        );
        yield* write(workspace.rootPath, ".git", `gitdir: ${NodePath.join(foreign, ".git")}\n`);
        expect((yield* service.verify(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "ownership",
        );
        expect(
          (yield* service.remove({ ...binding(workspace.rootPath), force: true }).pipe(Effect.flip))
            .reason,
        ).toBe("ownership");
        expect(yield* read(foreign, ".git/config")).toBe(foreignConfig);
        expect(yield* read(foreign, "file")).toBe("first\nsecond\nthird\nfourth\nfifth\n");
      }),
    ),
  );

  it.effect("refuses redirected Git internals before inspection or forced deletion", () =>
    withFixture(({ directory, sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const foreign = NodePath.join(directory, "foreign");
        yield* git(sourceRoot, ["clone", "-q", sourceRoot, foreign]);
        const foreignHead = yield* git(foreign, ["rev-parse", "HEAD"]);
        for (const folder of ["objects", "refs", "logs"]) {
          const workspace = yield* create(service, sourceRoot, folder);
          const original = NodePath.join(workspace.rootPath, ".git", folder);
          yield* Effect.promise(() =>
            NodeFSP.rename(original, NodePath.join(directory, `private-${folder}`)),
          );
          yield* Effect.promise(() =>
            NodeFSP.symlink(NodePath.join(foreign, ".git", folder), original),
          );
          expect(
            (yield* service.verify(binding(workspace.rootPath, folder)).pipe(Effect.flip)).reason,
          ).toBe("ownership");
          expect(
            (yield* service
              .remove({ ...binding(workspace.rootPath, folder), force: true })
              .pipe(Effect.flip)).reason,
          ).toBe("ownership");
        }
        expect(yield* git(foreign, ["rev-parse", "HEAD"])).toBe(foreignHead);
      }),
    ),
  );

  it.effect("refuses a reserved CoW root after its ownership journal disappears", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.promise(() =>
          NodeFSP.unlink(recordPath(config.stateDir, workspace.rootPath)),
        );
        expect((yield* service.findByRoot(workspace).pipe(Effect.flip)).reason).toBe("ownership");
        expect((yield* service.verify(binding(workspace.rootPath)).pipe(Effect.flip)).reason).toBe(
          "ownership",
        );
        expect(
          (yield* service.remove({ ...binding(workspace.rootPath), force: true }).pipe(Effect.flip))
            .reason,
        ).toBe("ownership");
        expect(yield* read(workspace.rootPath, "file")).toBe(
          "first\nsecond\nthird\nfourth\nfifth\n",
        );
      }),
    ),
  );

  it.effect("recovers a durable integration receipt without repeating completed writes", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const workspace = yield* create(service, sourceRoot);
        yield* write(workspace.rootPath, "file", "integrated session\n");
        const integrated = yield* service.integrate({
          ...binding(workspace.rootPath),
          paths: ["file"],
        });
        const record = yield* service.verify(binding(workspace.rootPath));
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            recordPath(config.stateDir, workspace.rootPath),
            encodeJson({ ...record, integrationReceipts: [] }),
          ),
        );
        yield* write(sourceRoot, "file", "edited after integration\n");
        yield* service.recover();
        yield* service.recover();
        expect((yield* service.verify(binding(workspace.rootPath))).integrationReceipts).toEqual([
          integrated.integrationId,
        ]);
        expect(
          yield* service.integrate({ ...binding(workspace.rootPath), paths: ["file"] }),
        ).toEqual(integrated);
        expect(yield* read(sourceRoot, "file")).toBe("edited after integration\n");
      }),
    ),
  );

  it.effect("recovers interrupted allocations idempotently and keeps published workspaces", () =>
    withFixture(({ sourceRoot }) =>
      Effect.gen(function* () {
        const service = yield* CowWorkspace.CowWorkspaceService;
        const abandoned = yield* create(service, sourceRoot, "abandoned");
        const ready = yield* create(service, sourceRoot, "ready");
        const record = yield* service.verify(binding(abandoned.rootPath, "abandoned"));
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            recordPath(config.stateDir, abandoned.rootPath),
            encodeJson({
              ...record,
              state: "creating",
              gitIdentity: null,
              baselineTree: null,
            }),
          ),
        );
        yield* service.recover();
        yield* service.recover();
        expect((yield* service.findByRoot(abandoned))?.state).toBe("removed");
        expect((yield* service.verify(binding(ready.rootPath, "ready"))).state).toBe("ready");
      }),
    ),
  );
});
