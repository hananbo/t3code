// @effect-diagnostics nodeBuiltinImport:off -- Durable ownership needs fsync and lossless native file identities.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as ApfsClone from "./ApfsClone.ts";

const Identity = Schema.Struct({ device: Schema.String, inode: Schema.String });
const Entry = Schema.Struct({ path: Schema.String, mode: Schema.String, hash: Schema.String });
const Record = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workspaceId: Schema.String,
  projectId: Schema.String,
  threadIds: Schema.Array(Schema.String),
  commandId: Schema.String,
  executionHostId: Schema.String,
  sourceRoot: Schema.String,
  sourceIdentity: Identity,
  rootPath: Schema.String,
  rootIdentity: Schema.NullOr(Identity),
  gitIdentity: Schema.NullOr(Identity),
  state: Schema.Literals(["creating", "ready", "removing", "removed", "quarantined"]),
  branch: Schema.String,
  baseCommit: Schema.String,
  baselineTree: Schema.NullOr(Schema.String),
  baseline: Schema.Array(Entry),
  initialRefs: Schema.String,
  createdAt: Schema.String,
  integrationReceipts: Schema.Array(Schema.String),
  historyRetained: Schema.Boolean,
  removalForce: Schema.optional(Schema.Boolean),
});
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(Record));
export type CowWorkspaceRecord = typeof Record.Type;
type SnapshotEntry = typeof Entry.Type;
type Binding = { readonly projectId: string; readonly threadId: string; readonly rootPath: string };
type MutationGuard = {
  readonly guard?: (record: CowWorkspaceRecord) => Effect.Effect<void, CowWorkspaceError>;
};
type Create = {
  readonly projectId: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly sourceRoot: string;
  readonly branch?: string;
};

const isApfsCloneError = Schema.is(ApfsClone.ApfsCloneError);

export class CowWorkspaceError extends Schema.TaggedError<CowWorkspaceError>()(
  "CowWorkspaceError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "unsupported",
      "ownership",
      "layout",
      "git",
      "io",
      "conflict",
      "recovery",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = isApfsCloneError(this.cause)
      ? `${this.cause.reason}${this.cause.errno === undefined ? "" : `; errno ${this.cause.errno}`}`
      : this.reason;
    return `Copy-on-write workspace ${this.operation} failed (${detail}).`;
  }
}

export class CowWorkspaceService extends Context.Service<
  CowWorkspaceService,
  {
    readonly probe: (input: {
      readonly sourceRoot: string;
    }) => Effect.Effect<
      { readonly backend: "apfs"; readonly supported: boolean; readonly reason?: string },
      CowWorkspaceError
    >;
    readonly create: (
      input: Create,
    ) => Effect.Effect<
      { readonly workspaceId: string; readonly rootPath: string; readonly branch: string },
      CowWorkspaceError
    >;
    readonly findByRoot: (input: {
      readonly rootPath: string;
    }) => Effect.Effect<CowWorkspaceRecord | null, CowWorkspaceError>;
    readonly verify: (input: Binding) => Effect.Effect<CowWorkspaceRecord, CowWorkspaceError>;
    readonly attach: (
      input: Binding & {
        readonly relatedRootPath?: string;
        readonly beforeAttach?: (
          record: CowWorkspaceRecord,
        ) => Effect.Effect<void, CowWorkspaceError>;
      },
    ) => Effect.Effect<void, CowWorkspaceError>;
    readonly changes: (input: Binding & MutationGuard) => Effect.Effect<
      ReadonlyArray<{
        readonly path: string;
        readonly kind: "added" | "modified" | "deleted";
      }>,
      CowWorkspaceError
    >;
    readonly integrate: (
      input: Binding & MutationGuard & { readonly paths: ReadonlyArray<string> },
    ) => Effect.Effect<
      { readonly integrationId: string; readonly conflicts: ReadonlyArray<string> },
      CowWorkspaceError
    >;
    readonly remove: (
      input: Binding & MutationGuard & { readonly force?: boolean },
    ) => Effect.Effect<void, CowWorkspaceError>;
    readonly recover: () => Effect.Effect<void, CowWorkspaceError>;
  }
>()("t3/workspaceIsolation/CowWorkspaceService") {}

const withCowLeases = <A, E, R>(roots: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
  [...new Set(roots.map((root) => NodePath.resolve(root)))]
    .sort()
    .reduceRight((held, root) => withWorkspaceLease(root, held), effect);
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const inside = (root: string, child: string) =>
  child === root || child.startsWith(`${root}${NodePath.sep}`);
const missing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
const identity = async (root: string) => {
  const stat = await NodeFSP.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Expected an owned directory");
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
};
const sameIdentity = (a: typeof Identity.Type, b: typeof Identity.Type) =>
  a.device === b.device && a.inode === b.inode;
const verifyGitPaths = async (gitDir: string) => {
  for (const name of ["HEAD", "index", "config", "packed-refs", "objects", "refs", "logs"]) {
    try {
      if ((await NodeFSP.lstat(NodePath.join(gitDir, name))).isSymbolicLink())
        throw new Error("Redirected Git metadata");
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
  }
  // These directories are mutable Git routing state. Object bytes need no hashing here.
  const visit = async (directory: string, recursive: boolean) => {
    let names: string[];
    try {
      names = await NodeFSP.readdir(directory);
    } catch (cause) {
      if (missing(cause)) return;
      throw cause;
    }
    for (const name of names) {
      const entry = NodePath.join(directory, name),
        stat = await NodeFSP.lstat(entry);
      if (stat.isSymbolicLink()) throw new Error("Redirected Git metadata");
      if (stat.isDirectory() && recursive) await visit(entry, true);
    }
  };
  await visit(NodePath.join(gitDir, "refs"), true);
  await visit(NodePath.join(gitDir, "logs"), true);
  const objects = NodePath.join(gitDir, "objects");
  await visit(objects, false);
  for (const name of await NodeFSP.readdir(objects)) {
    if ((await NodeFSP.lstat(NodePath.join(objects, name))).isDirectory())
      await visit(NodePath.join(objects, name), false);
  }
};
const configSnapshot = (raw: string, sourceRoot: string) => {
  const quote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\b", "\\b")}"`;
  return (
    raw
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("\n");
        const key = separator < 0 ? entry : entry.slice(0, separator);
        let value = separator < 0 ? "true" : entry.slice(separator + 1);
        const parts = key.split(".");
        const section = parts.shift(),
          name = parts.pop();
        if (
          !section ||
          !name ||
          !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(section) ||
          !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)
        )
          throw new Error("Unsupported Git config key");
        if (
          ["include", "includeif"].includes(section.toLowerCase()) ||
          ["core.worktree", "core.bare"].includes(key.toLowerCase())
        )
          return [];
        // Relative local remotes otherwise resolve against a different working directory.
        if (
          section === "remote" &&
          ["url", "pushurl"].includes(name) &&
          !NodePath.isAbsolute(value) &&
          !/^[a-z][a-z0-9+.-]*:|^[^/]+@[^/]+:/i.test(value)
        )
          value = NodePath.resolve(sourceRoot, value);
        const subsection = parts.length > 0 ? ` ${quote(parts.join("."))}` : "";
        return [`[${section}${subsection}]\n\t${name} = ${quote(value)}\n`];
      })
      .join("") + "[core]\n\tbare = false\n"
  );
};
const atomicJson = async (path: string, value: unknown) => {
  const temp = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temp, path);
  const parent = await NodeFSP.open(NodePath.dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};
const Content = Schema.Struct({
  kind: Schema.Literals(["file", "symlink", "missing"]),
  mode: Schema.Number,
  data: Schema.String,
});
type FileContent = typeof Content.Type;
const IntegrationJournal = Schema.Struct({
  integrationId: Schema.String,
  state: Schema.Literals(["applying", "done", "rolled-back", "conflicted"]),
  sourceRoot: Schema.String,
  sourceIdentity: Identity,
  entries: Schema.Array(Schema.Struct({ path: Schema.String, before: Content, after: Content })),
});
const decodeIntegrationJournal = Schema.decodeEffect(Schema.fromJsonString(IntegrationJournal));
const contentHash = (content: FileContent) =>
  content.kind === "missing"
    ? null
    : NodeCrypto.createHash("sha1")
        .update(`blob ${Buffer.from(content.data, "base64").length}\0`)
        .update(Buffer.from(content.data, "base64"))
        .digest("hex");
const equivalent = (a: FileContent, b: FileContent) =>
  a.kind === b.kind && a.mode === b.mode && a.data === b.data;
const contentMode = (entry: FileContent) =>
  entry.kind === "symlink" ? "120000" : (entry.mode & 0o111) !== 0 ? "100755" : "100644";
const readContent = async (root: string, relative: string): Promise<FileContent> => {
  if (
    NodePath.isAbsolute(relative) ||
    relative.split("/").some((part) => part === ".." || part === ".git" || part === ".t3")
  )
    throw new Error("Invalid integration path");
  const absolute = NodePath.join(root, relative);
  let parent = NodePath.dirname(absolute);
  while (parent !== root) {
    if (!inside(root, parent)) throw new Error("Path outside destination");
    try {
      if (!(await NodeFSP.lstat(parent)).isDirectory())
        throw new Error("Redirected destination parent");
    } catch (cause) {
      if (!missing(cause)) throw cause;
    }
    parent = NodePath.dirname(parent);
  }
  try {
    const stat = await NodeFSP.lstat(absolute);
    if (stat.isSymbolicLink())
      return {
        kind: "symlink",
        mode: 0o777,
        data: Buffer.from(await NodeFSP.readlink(absolute)).toString("base64"),
      };
    if (!stat.isFile()) throw new Error("Unsupported integration entry");
    const handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("Destination changed");
      return {
        kind: "file",
        mode: stat.mode & 0o777,
        data: (await handle.readFile()).toString("base64"),
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (missing(cause)) return { kind: "missing", mode: 0, data: "" };
    throw cause;
  }
};
const writeContent = async (
  root: string,
  relative: string,
  expected: FileContent,
  next: FileContent,
) => {
  if (!equivalent(await readContent(root, relative), expected))
    throw new Error("Destination changed during integration");
  const absolute = NodePath.join(root, relative);
  if (next.kind === "missing") {
    if (expected.kind !== "missing") {
      await NodeFSP.unlink(absolute);
      const parent = await NodeFSP.open(NodePath.dirname(absolute), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    return;
  }
  await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
  await readContent(root, relative);
  if (next.kind === "symlink") {
    const target = Buffer.from(next.data, "base64").toString("utf8");
    if (
      NodePath.isAbsolute(target) ||
      !inside(root, NodePath.resolve(NodePath.dirname(absolute), target))
    )
      throw new Error("Symlink escapes destination");
    const temp = NodePath.join(NodePath.dirname(absolute), `.t3-cow-${NodeCrypto.randomUUID()}`);
    await NodeFSP.symlink(target, temp);
    if (!equivalent(await readContent(root, relative), expected)) {
      await NodeFSP.unlink(temp);
      throw new Error("Destination changed during integration");
    }
    await NodeFSP.rename(temp, absolute);
  } else {
    const temp = NodePath.join(NodePath.dirname(absolute), `.t3-cow-${NodeCrypto.randomUUID()}`);
    const handle = await NodeFSP.open(temp, "wx", next.mode);
    try {
      await handle.writeFile(Buffer.from(next.data, "base64"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!equivalent(await readContent(root, relative), expected)) {
      await NodeFSP.unlink(temp);
      throw new Error("Destination changed during integration");
    }
    await NodeFSP.rename(temp, absolute);
  }
  const parent = await NodeFSP.open(NodePath.dirname(absolute), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};
const io = <A>(
  operation: string,
  task: () => Promise<A>,
  reason: CowWorkspaceError["reason"] = "io",
) =>
  Effect.tryPromise({
    try: task,
    catch: (cause) => new CowWorkspaceError({ operation, reason, cause }),
  });
const fail = (operation: string, reason: CowWorkspaceError["reason"], cause: unknown) =>
  Effect.fail(new CowWorkspaceError({ operation, reason, cause }));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const clone = yield* ApfsClone.ApfsClone;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const store = NodePath.join(config.stateDir, "cow-workspaces");
  yield* io("initialize", async () => {
    await NodeFSP.mkdir(store, { recursive: true, mode: 0o700 });
  });
  const recordFile = (root: string) =>
    NodePath.join(store, `${digest(NodePath.resolve(root))}.json`);
  const metadataDir = (record: CowWorkspaceRecord) => NodePath.join(store, record.workspaceId);
  const vault = (record: CowWorkspaceRecord) => NodePath.join(metadataDir(record), "baseline.git");
  const persist = (record: CowWorkspaceRecord) =>
    io("journal", () => atomicJson(recordFile(record.rootPath), record));
  const readRecord = Effect.fn("CowWorkspaceService.readRecord")(function* (
    input: { readonly rootPath: string },
    allocating = false,
  ) {
    const raw = yield* io("read-ownership", async () => {
      try {
        return await NodeFSP.readFile(recordFile(input.rootPath), "utf8");
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    });
    if (raw === null) {
      if (!allocating && /[\\/]cow[\\/][0-9a-f]{32}$/.test(NodePath.resolve(input.rootPath)))
        return yield* fail(
          "read-ownership",
          "ownership",
          "Missing ownership journal for reserved CoW root",
        );
      return null;
    }
    const record = yield* decodeRecord(raw).pipe(
      Effect.mapError(
        (cause) =>
          new CowWorkspaceError({ operation: "read-ownership", reason: "ownership", cause }),
      ),
    );
    if (
      record.rootPath !== NodePath.resolve(input.rootPath) ||
      !/^[0-9a-f]{32}$/.test(record.workspaceId) ||
      NodePath.basename(record.rootPath) !== record.workspaceId ||
      !NodePath.isAbsolute(record.sourceRoot)
    )
      return yield* fail("read-ownership", "ownership", "Root mismatch");
    return record;
  });
  const findByRoot = (input: { readonly rootPath: string }) => readRecord(input);
  const verifyRoot = Effect.fn("CowWorkspaceService.verifyRoot")(function* (
    record: CowWorkspaceRecord,
  ) {
    if (record.rootIdentity === null || record.gitIdentity === null || record.state !== "ready")
      return yield* fail("verify", "ownership", "Workspace is not ready");
    yield* io(
      "verify",
      async () => {
        if (!sameIdentity(await identity(record.rootPath), record.rootIdentity!))
          throw new Error("Workspace replaced");
        if (
          !sameIdentity(await identity(NodePath.join(record.rootPath, ".git")), record.gitIdentity!)
        )
          throw new Error("Repository replaced");
        const real = await NodeFSP.realpath(record.rootPath);
        if (real !== record.rootPath) throw new Error("Workspace redirected");
        await verifyGitPaths(NodePath.join(record.rootPath, ".git"));
        for (const name of ["commondir", "objects/info/alternates"]) {
          try {
            await NodeFSP.lstat(NodePath.join(record.rootPath, ".git", name));
            throw new Error("Repository redirected");
          } catch (cause) {
            if (!missing(cause)) throw cause;
          }
        }
      },
      "ownership",
    );
    return record;
  });
  const verify = Effect.fn("CowWorkspaceService.verify")(function* (input: Binding) {
    const record = yield* findByRoot(input);
    if (
      record === null ||
      record.projectId !== input.projectId ||
      !record.threadIds.includes(input.threadId)
    )
      return yield* fail("verify", "ownership", "Workspace binding mismatch");
    return yield* verifyRoot(record);
  });
  const git = Effect.fn("CowWorkspaceService.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly gitDir?: string;
      readonly index?: string;
      readonly stdin?: string;
      readonly allowFailure?: boolean;
      readonly allowInvalidUtf8?: boolean;
    },
  ) {
    const gitDir = options?.gitDir ?? NodePath.join(cwd, ".git");
    const commonDir = yield* io("git-layout", async () => {
      try {
        return NodePath.resolve(
          gitDir,
          (await NodeFSP.readFile(NodePath.join(gitDir, "commondir"), "utf8")).trim(),
        );
      } catch (cause) {
        if (missing(cause)) return gitDir;
        throw cause;
      }
    });
    const result = yield* runner
      .run({
        command: "git",
        cwd,
        args: [
          "--git-dir",
          gitDir,
          "--work-tree",
          cwd,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.splitIndex=false",
          "-c",
          "core.pager=cat",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        env: {
          GIT_DIR: gitDir,
          GIT_WORK_TREE: cwd,
          GIT_COMMON_DIR: commonDir,
          GIT_OBJECT_DIRECTORY: NodePath.join(commonDir, "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
          GIT_INDEX_FILE: options?.index ?? NodePath.join(gitDir, "index"),
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
          GIT_NAMESPACE: "",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          GIT_EXTERNAL_DIFF: "",
          GIT_OPTIONAL_LOCKS: "0",
        },
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        timeout: "2 minutes",
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) => new CowWorkspaceError({ operation: "git", reason: "git", cause }),
        ),
      );
    if (result.code !== 0 && options?.allowFailure !== true)
      return yield* fail("git", "git", result);
    if ((result.stdoutInvalidUtf8 && !options?.allowInvalidUtf8) || result.stdoutTruncated)
      return yield* fail("git", "layout", "Unsupported Git output");
    return result;
  });
  const destinationParent = Effect.fn("CowWorkspaceService.destinationParent")(function* () {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new CowWorkspaceError({ operation: "settings", reason: "io", cause }),
      ),
    );
    const directory = resolveWorktreesDirectory(
      current.worktreesDirectory,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (directory === null)
      return yield* fail("probe", "unsupported", "Invalid workspace location");
    return yield* io("prepare-parent", async () => {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const parent = NodePath.join(await NodeFSP.realpath(directory), "cow");
      await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
      return await NodeFSP.realpath(parent);
    });
  });
  const probe = Effect.fn("CowWorkspaceService.probe")(function* (input: {
    readonly sourceRoot: string;
  }) {
    const parent = yield* destinationParent();
    const capability = yield* clone
      .probe({ sourceRoot: input.sourceRoot, destinationParent: parent })
      .pipe(
        Effect.mapError(
          (cause) => new CowWorkspaceError({ operation: "probe", reason: "io", cause }),
        ),
      );
    return {
      backend: "apfs" as const,
      supported: capability.supported,
      ...(!capability.supported ? { reason: capability.reason } : {}),
    };
  });
  const snapshot = Effect.fn("CowWorkspaceService.snapshot")(function* (
    record: CowWorkspaceRecord,
  ) {
    yield* verifyRoot(record);
    const listed = yield* git(record.rootPath, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const paths = [
      ...new Set([
        ...listed.stdout.split("\0").filter(Boolean),
        ...record.baseline.map((entry) => entry.path),
      ]),
    ].sort();
    const entries: SnapshotEntry[] = [];
    const regular: Array<{ path: string; mode: string }> = [];
    for (const relative of paths) {
      if (
        relative.split("/").some((part) => part === ".git" || part === ".t3" || part === "..") ||
        NodePath.isAbsolute(relative)
      )
        return yield* fail("baseline", "layout", "Excluded or unsafe tracked path");
      const item = yield* io(
        "baseline-stat",
        async () => {
          const absolute = NodePath.join(record.rootPath, relative);
          try {
            if (!inside(record.rootPath, await NodeFSP.realpath(NodePath.dirname(absolute))))
              throw new Error("Path escapes workspace");
            const stat = await NodeFSP.lstat(absolute);
            if (stat.isSymbolicLink()) {
              const target = await NodeFSP.readlink(absolute);
              if (
                NodePath.isAbsolute(target) ||
                !inside(record.rootPath, NodePath.resolve(NodePath.dirname(absolute), target))
              )
                throw new Error("Symlink escapes workspace");
              return { mode: "120000", target };
            }
            if (!stat.isFile()) throw new Error("Unsupported tracked entry");
            return { mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644", target: null };
          } catch (cause) {
            if (missing(cause)) return null;
            throw cause;
          }
        },
        "layout",
      );
      if (item === null) continue;
      if (item.target !== null) {
        const result = yield* git(
          record.rootPath,
          ["hash-object", "--no-filters", "-w", "--stdin"],
          { gitDir: vault(record), stdin: item.target },
        );
        entries.push({ path: relative, mode: item.mode, hash: result.stdout.trim() });
      } else regular.push({ path: relative, mode: item.mode });
    }
    // Batch regular blobs; ignored dependency trees are cloned but never hashed for the baseline.
    for (let start = 0; start < regular.length; start += 256) {
      const batch = regular.slice(start, start + 256);
      const result = yield* git(
        record.rootPath,
        ["hash-object", "--no-filters", "-w", "--", ...batch.map((entry) => entry.path)],
        { gitDir: vault(record) },
      );
      const hashes = result.stdout.trim().split("\n");
      if (hashes.length !== batch.length)
        return yield* fail("baseline", "git", "Incomplete blob import");
      entries.push(...batch.map((entry, index) => ({ ...entry, hash: hashes[index]! })));
    }
    const index = NodePath.join(metadataDir(record), `snapshot-${NodeCrypto.randomUUID()}.index`);
    const options = { gitDir: vault(record), index };
    yield* git(record.rootPath, ["read-tree", "--empty"], options);
    yield* git(record.rootPath, ["update-index", "-z", "--index-info"], {
      ...options,
      stdin: entries.map((entry) => `${entry.mode} ${entry.hash}\t${entry.path}\0`).join(""),
    });
    const tree = (yield* git(record.rootPath, ["write-tree"], options)).stdout.trim();
    yield* io("remove-private-index", async () => {
      await NodeFSP.unlink(index);
    });
    return { tree, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
  });

  const create = Effect.fn("CowWorkspaceService.create")(function* (input: Create) {
    const parent = yield* destinationParent();
    const sourceRoot = yield* io("source", () => NodeFSP.realpath(input.sourceRoot));
    if (inside(sourceRoot, parent) || inside(parent, sourceRoot))
      return yield* fail("create", "layout", "Overlapping source and allocation roots");
    const id = digest(`${input.projectId}\0${input.threadId}\0${input.commandId}`).slice(0, 32);
    const rootPath = NodePath.join(parent, id);
    return yield* withWorkspaceLease(
      rootPath,
      Effect.gen(function* () {
        const existing = yield* readRecord({ rootPath }, true);
        if (existing !== null) {
          const record = yield* verify({ ...input, rootPath });
          return {
            workspaceId: record.workspaceId,
            rootPath: record.rootPath,
            branch: record.branch,
          };
        }
        const capability = yield* probe({ sourceRoot });
        if (!capability.supported) return yield* fail("create", "unsupported", capability.reason);
        const { gitDir, commonDir } = yield* io(
          "layout",
          async () => {
            const entry = NodePath.join(sourceRoot, ".git");
            const stat = await NodeFSP.lstat(entry);
            if (stat.isSymbolicLink()) throw new Error("Redirected Git directory");
            let gitDir = entry;
            if (stat.isFile()) {
              const marker = await NodeFSP.readFile(entry, "utf8");
              if (!marker.startsWith("gitdir: ") || marker.trim().includes("\n"))
                throw new Error("Invalid worktree marker");
              gitDir = await NodeFSP.realpath(NodePath.resolve(sourceRoot, marker.trim().slice(8)));
              if (
                (await NodeFSP.realpath(
                  (await NodeFSP.readFile(NodePath.join(gitDir, "gitdir"), "utf8")).trim(),
                )) !== entry
              )
                throw new Error("Foreign worktree marker");
            }
            let commonDir = gitDir;
            try {
              commonDir = await NodeFSP.realpath(
                NodePath.resolve(
                  gitDir,
                  (await NodeFSP.readFile(NodePath.join(gitDir, "commondir"), "utf8")).trim(),
                ),
              );
            } catch (cause) {
              if (!missing(cause)) throw cause;
            }
            return { gitDir, commonDir };
          },
          "layout",
        );
        yield* io(
          "layout",
          async () => {
            await identity(gitDir);
            await identity(commonDir);
            await verifyGitPaths(commonDir);
            if (gitDir !== commonDir)
              await verifyGitPaths(gitDir).catch((cause) => {
                if (!missing(cause)) throw cause;
              });
            for (const candidate of [
              "shallow",
              "objects/info/alternates",
              "info/sparse-checkout",
              "MERGE_HEAD",
              "index.lock",
            ]) {
              for (const base of new Set([gitDir, commonDir])) {
                try {
                  await NodeFSP.lstat(NodePath.join(base, candidate));
                  throw new Error("Unsupported repository layout");
                } catch (cause) {
                  if (!missing(cause)) throw cause;
                }
              }
            }
          },
          "layout",
        );
        const sourceGit = (args: ReadonlyArray<string>) =>
          git(sourceRoot, args, { gitDir, index: NodePath.join(gitDir, "index") });
        const unsupported = yield* git(
          sourceRoot,
          [
            "config",
            "--local",
            "--get-regexp",
            "^(extensions\\.(partialclone|worktreeconfig|refstorage)|core\\.(sparsecheckout|splitindex))$",
          ],
          { gitDir, index: NodePath.join(gitDir, "index"), allowFailure: true },
        );
        const unmerged = yield* sourceGit(["ls-files", "--unmerged", "-z"]);
        const modules = yield* sourceGit(["ls-files", "--stage", "-z"]);
        const flags = (yield* sourceGit(["ls-files", "-v", "-z"])).stdout
          .split("\0")
          .filter(Boolean);
        if (
          unsupported.stdout.split("\n").some((line) => line && !line.endsWith(" false")) ||
          unmerged.stdout ||
          flags.some((line) => /^[a-zS]/.test(line)) ||
          modules.stdout.split("\0").some((entry) => entry.startsWith("160000 "))
        )
          return yield* fail("create", "layout", "Unsupported repository layout");
        if ((yield* sourceGit(["rev-parse", "--show-object-format"])).stdout.trim() !== "sha1")
          return yield* fail("create", "layout", "Only SHA-1 repositories are supported");
        const head = (yield* sourceGit(["rev-parse", "--verify", "HEAD"])).stdout.trim();
        const branch = input.branch ?? `t3/cow-${id.slice(0, 12)}`;
        yield* sourceGit(["check-ref-format", "--branch", branch]);
        const initialRefs = (yield* sourceGit([
          "for-each-ref",
          "--format=%(refname) %(objectname)",
        ])).stdout;
        const effectiveConfig = yield* runner
          .run({
            command: "git",
            cwd: sourceRoot,
            args: [
              "--git-dir",
              gitDir,
              "--work-tree",
              sourceRoot,
              "config",
              "--null",
              "--list",
              "--includes",
            ],
            env: {
              GIT_DIR: gitDir,
              GIT_WORK_TREE: sourceRoot,
              GIT_COMMON_DIR: commonDir,
              GIT_OBJECT_DIRECTORY: NodePath.join(commonDir, "objects"),
              GIT_INDEX_FILE: NodePath.join(gitDir, "index"),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
              GIT_CONFIG_COUNT: "0",
              GIT_CONFIG_PARAMETERS: "",
              GIT_NAMESPACE: "",
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CowWorkspaceError({ operation: "configuration", reason: "git", cause }),
            ),
          );
        if (
          effectiveConfig.code !== 0 ||
          effectiveConfig.stdoutInvalidUtf8 ||
          effectiveConfig.stdoutTruncated
        )
          return yield* fail(
            "create",
            "layout",
            "Cannot capture effective repository configuration",
          );
        const initialIndex = yield* io("source-index", async () => {
          try {
            return digest(
              (await NodeFSP.readFile(NodePath.join(gitDir, "index"))).toString("base64"),
            );
          } catch (cause) {
            if (missing(cause)) return null;
            throw cause;
          }
        });
        let record: CowWorkspaceRecord = {
          schemaVersion: 1,
          workspaceId: id,
          projectId: input.projectId,
          threadIds: [input.threadId],
          commandId: input.commandId,
          executionHostId: yield* io("host", async () => {
            try {
              return (await NodeFSP.readFile(config.environmentIdPath, "utf8")).trim();
            } catch (cause) {
              if (missing(cause)) return config.baseDir;
              throw cause;
            }
          }),
          sourceRoot,
          sourceIdentity: yield* io("source", () => identity(sourceRoot)),
          rootPath,
          rootIdentity: null,
          gitIdentity: null,
          state: "creating",
          branch,
          baseCommit: head,
          baselineTree: null,
          baseline: [],
          initialRefs,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          integrationReceipts: [],
          historyRetained: false,
        };
        yield* persist(record);
        yield* io("allocate", async () => {
          await NodeFSP.mkdir(rootPath, { mode: 0o700 });
          await NodeFSP.mkdir(metadataDir(record), { mode: 0o700 });
        });
        record = { ...record, rootIdentity: yield* io("allocate", () => identity(rootPath)) };
        yield* persist(record);
        yield* clone
          .clone({ sourceRoot, destinationRoot: rootPath, excludedPaths: [".git", ".t3"] })
          .pipe(
            Effect.mapError(
              (cause) => new CowWorkspaceError({ operation: "clone", reason: "io", cause }),
            ),
          );
        const privateGit = NodePath.join(rootPath, ".git");
        yield* io("repository", () =>
          NodeFSP.mkdir(privateGit, { mode: 0o700 }).then(() => undefined),
        );
        yield* clone
          .clone({
            sourceRoot: commonDir,
            destinationRoot: privateGit,
            excludedPaths: ["worktrees"],
          })
          .pipe(
            Effect.mapError(
              (cause) => new CowWorkspaceError({ operation: "repository", reason: "io", cause }),
            ),
          );
        if (gitDir !== commonDir)
          yield* io("repository", async () => {
            for (const name of ["HEAD", "index", "logs/HEAD"]) {
              try {
                const bytes = await NodeFSP.readFile(NodePath.join(gitDir, name));
                await NodeFSP.mkdir(NodePath.dirname(NodePath.join(privateGit, name)), {
                  recursive: true,
                  mode: 0o700,
                });
                await NodeFSP.writeFile(NodePath.join(privateGit, name), bytes, { mode: 0o600 });
              } catch (cause) {
                if (!missing(cause)) throw cause;
              }
            }
          });
        const finalIndex = yield* io("source-index", async () => {
          try {
            return digest(
              (await NodeFSP.readFile(NodePath.join(gitDir, "index"))).toString("base64"),
            );
          } catch (cause) {
            if (missing(cause)) return null;
            throw cause;
          }
        });
        const finalRefs = (yield* sourceGit(["for-each-ref", "--format=%(refname) %(objectname)"]))
          .stdout;
        if (
          finalIndex !== initialIndex ||
          finalRefs !== initialRefs ||
          (yield* sourceGit(["rev-parse", "HEAD"])).stdout.trim() !== head
        )
          return yield* fail("create", "conflict", "Source Git state changed during cloning");
        yield* io("repository-config", () =>
          NodeFSP.writeFile(
            NodePath.join(privateGit, "config"),
            configSnapshot(effectiveConfig.stdout, sourceRoot),
            { mode: 0o600 },
          ),
        );
        // This is Git administrative reconstruction, not an ordinary-file copy fallback.
        yield* git(rootPath, ["config", "--local", "--unset-all", "core.worktree"], {
          allowFailure: true,
        });
        yield* git(rootPath, ["config", "--local", "core.bare", "false"]);
        yield* git(rootPath, ["update-ref", `refs/heads/${branch}`, head]);
        yield* git(rootPath, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
        record = {
          ...record,
          gitIdentity: yield* io("repository", () => identity(privateGit)),
          state: "ready",
        };
        yield* runner
          .run({
            command: "git",
            args: [
              "--git-dir",
              vault(record),
              "-c",
              "init.templateDir=",
              "init",
              "--bare",
              vault(record),
            ],
            env: {
              GIT_DIR: vault(record),
              GIT_WORK_TREE: undefined,
              GIT_COMMON_DIR: vault(record),
              GIT_OBJECT_DIRECTORY: NodePath.join(vault(record), "objects"),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
              GIT_INDEX_FILE: NodePath.join(vault(record), "index"),
              GIT_CONFIG_COUNT: "0",
              GIT_CONFIG_PARAMETERS: "",
              GIT_NAMESPACE: "",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_SYSTEM: "/dev/null",
            },
          })
          .pipe(
            Effect.flatMap((result) =>
              result.code === 0 ? Effect.void : fail("baseline", "git", result),
            ),
            Effect.mapError(
              (cause) => new CowWorkspaceError({ operation: "baseline", reason: "git", cause }),
            ),
          );
        const baseline = yield* snapshot(record);
        yield* git(rootPath, ["update-ref", "refs/baselines/creation", baseline.tree], {
          gitDir: vault(record),
        });
        record = { ...record, baseline: baseline.entries, baselineTree: baseline.tree };
        yield* verifyRoot(record);
        yield* persist(record);
        return { workspaceId: id, rootPath, branch };
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const abandoned = yield* readRecord({ rootPath }, true);
            if (abandoned?.state !== "creating" || abandoned.rootIdentity === null) return;
            yield* io(
              "failed-allocation",
              async () => {
                if (!sameIdentity(await identity(rootPath), abandoned.rootIdentity!))
                  throw new Error("Allocation replaced");
                await NodeFSP.rm(rootPath, { recursive: true });
              },
              "ownership",
            );
            yield* persist({ ...abandoned, state: "removed" });
          }).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("CoW allocation cleanup requires recovery", { workspaceId: id }),
            ),
          ),
        ),
      ),
    );
  });
  const attach = Effect.fn("CowWorkspaceService.attach")(function* (
    input: Binding & {
      readonly relatedRootPath?: string;
      readonly beforeAttach?: (
        record: CowWorkspaceRecord,
      ) => Effect.Effect<void, CowWorkspaceError>;
    },
  ) {
    yield* withCowLeases(
      [input.rootPath, ...(input.relatedRootPath ? [input.relatedRootPath] : [])],
      Effect.gen(function* () {
        const record = yield* findByRoot(input);
        if (record === null || record.projectId !== input.projectId)
          return yield* fail("attach", "ownership", "Project mismatch");
        yield* verifyRoot(record);
        if (input.beforeAttach) yield* input.beforeAttach(record);
        if (!record.threadIds.includes(input.threadId))
          yield* persist({ ...record, threadIds: [...record.threadIds, input.threadId] });
      }),
    );
  });
  const changes: CowWorkspaceService["Service"]["changes"] = (input) =>
    withWorkspaceLease(
      input.rootPath,
      Effect.gen(function* () {
        const record = yield* verify(input);
        if (input.guard) yield* input.guard(record);
        const current = yield* snapshot(record);
        const before = new Map(record.baseline.map((entry) => [entry.path, entry]));
        const after = new Map(current.entries.map((entry) => [entry.path, entry]));
        return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((relative) => {
          const a = before.get(relative),
            b = after.get(relative);
          if (a?.hash === b?.hash && a?.mode === b?.mode) return [];
          return [
            {
              path: relative,
              kind: !a ? ("added" as const) : !b ? ("deleted" as const) : ("modified" as const),
            },
          ];
        });
      }),
    );
  const rollbackIntegration = Effect.fn("CowWorkspaceService.rollbackIntegration")(function* (
    record: CowWorkspaceRecord,
    restore = true,
  ) {
    const journalPath = NodePath.join(metadataDir(record), "integration.json");
    const raw = yield* io("integration-recovery", async () => {
      try {
        return await NodeFSP.readFile(journalPath, "utf8");
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    });
    if (raw === null) return;
    const journal = yield* decodeIntegrationJournal(raw).pipe(
      Effect.mapError(
        (cause) =>
          new CowWorkspaceError({ operation: "integration-recovery", reason: "recovery", cause }),
      ),
    );
    if (
      journal.sourceRoot !== record.sourceRoot ||
      !sameIdentity(journal.sourceIdentity, record.sourceIdentity)
    )
      return yield* fail(
        "integration-recovery",
        "ownership",
        "Integration receipt destination mismatch",
      );
    if (journal.state === "done") {
      if (!record.integrationReceipts.includes(journal.integrationId))
        yield* persist({
          ...record,
          integrationReceipts: [...record.integrationReceipts, journal.integrationId],
        });
      return;
    }
    if (journal.state === "rolled-back") return;
    if (!restore)
      return yield* fail(
        "remove",
        "recovery",
        "Recover interrupted integration before removing this workspace",
      );
    yield* io(
      "integration-recovery",
      async () => {
        if (
          journal.sourceRoot !== record.sourceRoot ||
          !sameIdentity(await identity(journal.sourceRoot), journal.sourceIdentity)
        )
          throw new Error("Integration destination replaced");
        for (const entry of journal.entries.toReversed()) {
          const current = await readContent(journal.sourceRoot, entry.path);
          if (equivalent(current, entry.before)) continue;
          if (!equivalent(current, entry.after))
            throw new Error("Destination changed after interrupted integration");
          await writeContent(journal.sourceRoot, entry.path, current, entry.before);
        }
        await atomicJson(journalPath, { ...journal, state: "rolled-back" });
      },
      "recovery",
    );
  });
  const integrate: CowWorkspaceService["Service"]["integrate"] = (input) =>
    Effect.gen(function* () {
      const initial = yield* verify(input);
      return yield* withCowLeases(
        [input.rootPath, initial.sourceRoot],
        Effect.gen(function* () {
          let record = yield* verify(input);
          if (input.guard) yield* input.guard(record);
          yield* rollbackIntegration(record);
          record = yield* verify(input);
          if (input.guard) yield* input.guard(record);
          yield* io(
            "integration-target",
            async () => {
              if (!sameIdentity(await identity(record.sourceRoot), record.sourceIdentity))
                throw new Error("Source checkout replaced");
            },
            "ownership",
          );
          const current = yield* snapshot(record);
          const before = new Map(record.baseline.map((entry) => [entry.path, entry]));
          const after = new Map(current.entries.map((entry) => [entry.path, entry]));
          const selected = [...new Set(input.paths)].sort();
          if (
            selected.length === 0 ||
            selected.some((relative) => {
              const a = before.get(relative),
                b = after.get(relative);
              return (!a && !b) || (a?.hash === b?.hash && a?.mode === b?.mode);
            })
          )
            return yield* fail("integrate", "layout", "Select changed eligible paths");
          const integrationId = digest(
            `${record.baselineTree}\0${current.tree}\0${selected.join("\0")}`,
          );
          if (record.integrationReceipts.includes(integrationId))
            return { integrationId, conflicts: [] };
          const entries: Array<{ path: string; before: FileContent; after: FileContent }> = [];
          const conflicts: string[] = [];
          for (const relative of selected) {
            const base = before.get(relative),
              sessionEntry = after.get(relative);
            const target = yield* io(
              "integration-read",
              () => readContent(record.sourceRoot, relative),
              "ownership",
            );
            const session = yield* io(
              "integration-read",
              () => readContent(record.rootPath, relative),
              "ownership",
            );
            if (
              sessionEntry &&
              (contentHash(session) !== sessionEntry.hash ||
                contentMode(session) !== sessionEntry.mode)
            )
              return yield* fail("integrate", "conflict", "Session changed during integration");
            const targetMatches = base
              ? contentHash(target) === base.hash && contentMode(target) === base.mode
              : target.kind === "missing";
            if (equivalent(target, session)) continue;
            let proposed = session;
            if (!targetMatches) {
              if (
                !base ||
                !sessionEntry ||
                base.mode === "120000" ||
                session.kind !== "file" ||
                target.kind !== "file"
              ) {
                conflicts.push(relative);
                continue;
              }
              const baseFile = NodePath.join(
                metadataDir(record),
                `merge-base-${NodeCrypto.randomUUID()}`,
              );
              // Git cat-file is decoded only for text merges; binary overlap is a conflict.
              const blob = yield* git(record.rootPath, ["cat-file", "blob", base.hash], {
                gitDir: vault(record),
                allowInvalidUtf8: true,
              });
              if (blob.stdoutInvalidUtf8) {
                conflicts.push(relative);
                continue;
              }
              const a = Buffer.from(target.data, "base64"),
                b = Buffer.from(session.data, "base64"),
                original = Buffer.from(blob.stdout);
              if (
                a.includes(0) ||
                b.includes(0) ||
                original.includes(0) ||
                !a.equals(Buffer.from(a.toString("utf8"))) ||
                !b.equals(Buffer.from(b.toString("utf8")))
              ) {
                conflicts.push(relative);
                continue;
              }
              const targetFile = `${baseFile}.target`,
                sessionFile = `${baseFile}.session`;
              yield* io("merge-input", async () => {
                await NodeFSP.writeFile(baseFile, original, { mode: 0o600 });
                await NodeFSP.writeFile(targetFile, a, { mode: 0o600 });
                await NodeFSP.writeFile(sessionFile, b, { mode: 0o600 });
              });
              const merged = yield* git(
                record.rootPath,
                ["merge-file", "-p", targetFile, baseFile, sessionFile],
                { allowFailure: true },
              );
              yield* io("merge-input", async () => {
                await Promise.all(
                  [baseFile, targetFile, sessionFile].map((file) => NodeFSP.unlink(file)),
                );
              });
              if (
                merged.code !== 0 ||
                (contentMode(target) !== base.mode &&
                  sessionEntry.mode !== base.mode &&
                  contentMode(target) !== sessionEntry.mode)
              ) {
                conflicts.push(relative);
                continue;
              }
              proposed = {
                kind: "file",
                data: Buffer.from(merged.stdout).toString("base64"),
                mode: sessionEntry.mode === base.mode ? target.mode : session.mode,
              };
            }
            entries.push({ path: relative, before: target, after: proposed });
          }
          if (conflicts.length > 0) return { integrationId, conflicts };
          const journalPath = NodePath.join(metadataDir(record), "integration.json");
          const journal = {
            integrationId,
            state: "applying" as const,
            sourceRoot: record.sourceRoot,
            sourceIdentity: record.sourceIdentity,
            entries,
          };
          yield* io("integration-intent", () => atomicJson(journalPath, journal));
          yield* io("integration-apply", async () => {
            for (const entry of entries) {
              if (!sameIdentity(await identity(record.sourceRoot), record.sourceIdentity))
                throw new Error("Destination replaced");
              await writeContent(record.sourceRoot, entry.path, entry.before, entry.after);
            }
          }).pipe(
            Effect.onError(() =>
              rollbackIntegration(record).pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("CoW integration rollback requires recovery", {
                    workspaceId: record.workspaceId,
                  }),
                ),
              ),
            ),
          );
          yield* io("integration-receipt", () =>
            atomicJson(journalPath, { ...journal, state: "done" }),
          );
          yield* persist({
            ...record,
            integrationReceipts: [...record.integrationReceipts, integrationId],
          });
          return { integrationId, conflicts: [] };
        }),
      );
    });
  const finishRemoval = Effect.fn("CowWorkspaceService.finishRemoval")(function* (
    record: CowWorkspaceRecord,
  ) {
    const tombstone = NodePath.join(
      NodePath.dirname(record.rootPath),
      `.removed-${record.workspaceId}`,
    );
    if (!record.historyRetained) {
      yield* io(
        "retention-ownership",
        async () => {
          if (
            !record.rootIdentity ||
            !sameIdentity(await identity(record.rootPath), record.rootIdentity)
          )
            throw new Error("Workspace replaced");
          if (
            !record.gitIdentity ||
            !sameIdentity(
              await identity(NodePath.join(record.rootPath, ".git")),
              record.gitIdentity,
            )
          )
            throw new Error("Repository replaced");
          await verifyGitPaths(NodePath.join(record.rootPath, ".git"));
        },
        "ownership",
      );
      const reflogs = (yield* git(record.rootPath, ["reflog", "--all", "--format=%H"])).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      const head = (yield* git(record.rootPath, ["rev-parse", "HEAD"])).stdout.trim();
      const retained = [...new Set([head, ...reflogs])];
      if (retained.some((hash) => !/^[0-9a-f]{40}$/.test(hash)))
        return yield* fail("retention", "git", "Invalid retained object");
      yield* git(record.rootPath, ["update-ref", "--stdin"], {
        stdin: retained
          .map((hash, index) => `update refs/t3/cow-retention/${index} ${hash}\n`)
          .join(""),
      });
      const bundle = NodePath.join(metadataDir(record), "history.bundle");
      yield* git(record.rootPath, ["bundle", "create", bundle, "--all"]);
      yield* git(record.rootPath, ["bundle", "verify", bundle]);
      yield* io("retention-sync", async () => {
        const handle = await NodeFSP.open(bundle, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const configBytes = await NodeFSP.readFile(NodePath.join(record.rootPath, ".git/config"));
        await NodeFSP.writeFile(NodePath.join(metadataDir(record), "history.config"), configBytes, {
          mode: 0o600,
        });
        const retainedConfig = await NodeFSP.open(
          NodePath.join(metadataDir(record), "history.config"),
          "r",
        );
        try {
          await retainedConfig.sync();
        } finally {
          await retainedConfig.close();
        }
        const retainedDirectory = await NodeFSP.open(metadataDir(record), "r");
        try {
          await retainedDirectory.sync();
        } finally {
          await retainedDirectory.close();
        }
      });
      record = { ...record, historyRetained: true };
      yield* persist(record);
    }
    yield* io(
      "remove-owned-root",
      async () => {
        if (!record.rootIdentity) throw new Error("Unowned allocation");
        let current = record.rootPath;
        try {
          await NodeFSP.lstat(current);
        } catch (cause) {
          if (!missing(cause)) throw cause;
          current = tombstone;
        }
        try {
          if (!sameIdentity(await identity(current), record.rootIdentity))
            throw new Error("Allocation replaced");
          if (current === record.rootPath) {
            await NodeFSP.rename(current, tombstone);
            current = tombstone;
            const parent = await NodeFSP.open(NodePath.dirname(current), "r");
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
          }
          if (!sameIdentity(await identity(current), record.rootIdentity))
            throw new Error("Tombstone replaced");
          await NodeFSP.rm(current, { recursive: true });
          const parent = await NodeFSP.open(NodePath.dirname(current), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } catch (cause) {
          if (!missing(cause)) throw cause;
        }
      },
      "ownership",
    );
    yield* persist({ ...record, state: "removed" });
  });
  const remove: CowWorkspaceService["Service"]["remove"] = (input) =>
    withWorkspaceLease(
      input.rootPath,
      Effect.gen(function* () {
        const record = yield* findByRoot(input);
        if (
          record === null ||
          record.projectId !== input.projectId ||
          !record.threadIds.includes(input.threadId)
        )
          return yield* fail("remove", "ownership", "Workspace binding mismatch");
        if (input.guard) yield* input.guard(record);
        if (record.state === "removed") return;
        if (record.state === "removing") return yield* finishRemoval(record);
        yield* verifyRoot(record);
        yield* rollbackIntegration(record, false);
        if (input.force !== true) {
          const current = yield* snapshot(record);
          const headTree = (yield* git(record.rootPath, [
            "rev-parse",
            "HEAD^{tree}",
          ])).stdout.trim();
          const ignored = yield* git(record.rootPath, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
          ]);
          if (current.tree !== headTree || ignored.stdout.length > 0)
            return yield* fail(
              "remove",
              "conflict",
              "Confirm discarding uncommitted or ignored contents",
            );
        }
        const removing = {
          ...record,
          state: "removing" as const,
          removalForce: input.force === true,
        };
        yield* persist(removing);
        yield* finishRemoval(removing);
      }),
    );
  const recover: CowWorkspaceService["Service"]["recover"] = () =>
    Effect.gen(function* () {
      const files = yield* io("recovery-list", () => NodeFSP.readdir(store));
      for (const name of files.filter((file) => /^[0-9a-f]{64}\.json$/.test(file))) {
        yield* Effect.gen(function* () {
          const raw = yield* io("recovery-read", () =>
            NodeFSP.readFile(NodePath.join(store, name), "utf8"),
          );
          const record = yield* decodeRecord(raw).pipe(
            Effect.mapError(
              (cause) => new CowWorkspaceError({ operation: "recover", reason: "recovery", cause }),
            ),
          );
          if (
            recordFile(record.rootPath) !== NodePath.join(store, name) ||
            !/^[0-9a-f]{32}$/.test(record.workspaceId)
          )
            return yield* fail("recover", "ownership", "Invalid ownership journal");
          yield* withWorkspaceLease(
            record.rootPath,
            Effect.gen(function* () {
              if (record.state === "creating" && record.rootIdentity !== null) {
                yield* io(
                  "abandoned-allocation",
                  async () => {
                    if (!sameIdentity(await identity(record.rootPath), record.rootIdentity!))
                      throw new Error("Abandoned allocation replaced");
                    await NodeFSP.rm(record.rootPath, { recursive: true });
                  },
                  "ownership",
                );
                yield* persist({ ...record, state: "removed" });
              } else if (record.state === "removing") yield* finishRemoval(record);
              else if (record.state === "ready") yield* rollbackIntegration(record);
            }),
          );
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("CoW recovery requires review", { journal: name }),
          ),
        );
      }
    });
  return CowWorkspaceService.of({
    probe,
    create,
    findByRoot,
    verify,
    attach,
    changes,
    integrate,
    remove,
    recover,
  });
});

export const layer = Layer.effect(CowWorkspaceService, make);
