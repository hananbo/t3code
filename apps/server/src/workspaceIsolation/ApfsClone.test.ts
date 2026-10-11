// @effect-diagnostics nodeBuiltinImport:off - Native integration assertions exercise filesystem descriptors and captured child processes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as ApfsClone from "./ApfsClone.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const macOS = HostProcess.Platform.defaultValue() === "darwin";
let root: string;
let helper: string;
const decodeNativeResult = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
      errno: Schema.optionalKey(Schema.Number),
    }),
  ),
);

const native = async (
  operation: string,
  source: string,
  destination: string,
  exclusions: ReadonlyArray<string> = [],
) => {
  let stdout: string;
  try {
    stdout = (await execFile(helper, [operation, source, destination, ...exclusions])).stdout;
  } catch (cause) {
    if (
      typeof cause !== "object" ||
      cause === null ||
      !("stdout" in cause) ||
      typeof cause.stdout !== "string"
    )
      throw cause;
    stdout = cause.stdout;
  }
  return decodeNativeResult(stdout);
};
const clone = (source: string, destination: string, exclusions: ReadonlyArray<string> = []) =>
  native("clone", source, destination, exclusions);

const fixture = async (parent = root) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(parent, "fixture-"));
  const sourceRoot = NodePath.join(directory, "source");
  const destinationRoot = NodePath.join(directory, "copy");
  await NodeFSP.mkdir(sourceRoot);
  await NodeFSP.mkdir(destinationRoot, { mode: 0o700 });
  return { directory, sourceRoot, destinationRoot };
};

const largeFixture = async () => {
  const value = await fixture();
  for (let start = 0; start < 5000; start += 32) {
    await Promise.all(
      Array.from({ length: Math.min(32, 5000 - start) }, (_, offset) =>
        NodeFSP.writeFile(NodePath.join(value.sourceRoot, `file-${start + offset}`), "source"),
      ),
    );
  }
  return value;
};

it.effect("reports unsupported execution hosts without inspecting paths", () =>
  Effect.gen(function* () {
    const service = yield* ApfsClone.ApfsClone;
    expect(yield* service.probe({ sourceRoot: "/missing", destinationParent: "/missing" })).toEqual(
      { backend: "apfs-clone", supported: false, reason: "platform" },
    );
  }).pipe(
    Effect.provide(ApfsClone.layer),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);

describe.skipIf(!macOS)("APFS native isolation", () => {
  beforeAll(async () => {
    root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-apfs-test-")),
    );
    helper = NodePath.join(root, "t3-apfs-clone");
    await execFile(process.execPath, [
      NodePath.resolve(import.meta.dirname, "../../../../scripts/build-apfs-clone.mjs"),
      "--output",
      helper,
    ]);
    const { directory, sourceRoot } = await fixture();
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "probe"), "native clone");
    // A supported macOS runner must execute the native assertions; unexpected
    // unsupported capability is a failure, not a silently skipped test.
    expect(await native("probe", sourceRoot, directory)).toEqual({ ok: true });
  });

  afterAll(async () => {
    if (root) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it.effect("probes and clones through the host service", () =>
    Effect.gen(function* () {
      const { directory, sourceRoot, destinationRoot } = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source"));
      const service = yield* ApfsClone.ApfsClone;
      expect(yield* service.probe({ sourceRoot, destinationParent: directory })).toEqual({
        backend: "apfs-clone",
        supported: true,
      });
      yield* service.clone({ sourceRoot, destinationRoot });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(destinationRoot, "file"), "copy"),
      );
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(sourceRoot, "file"), "utf8")),
      ).toBe("source");
    }).pipe(
      Effect.provide(ApfsClone.layer),
      Effect.provideService(HostProcess.Environment, { T3CODE_APFS_CLONE_PATH: helper }),
      Effect.provide(NodeServices.layer),
    ),
  );

  it("omits live ignored IPC sockets while preserving workspace and private Git files", async () => {
    // Darwin UNIX socket names have a short limit; its per-user temp root is too long.
    const { directory, sourceRoot, destinationRoot } = await fixture("/private/tmp");
    await execFile("git", ["init", "--quiet", sourceRoot]);
    await NodeFSP.mkdir(NodePath.join(sourceRoot, ".codegraph"));
    await NodeFSP.writeFile(NodePath.join(sourceRoot, ".gitignore"), ".codegraph/\nignored.txt\n");
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "staged");
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "ignored.txt"), "ignored contents");
    await execFile("git", ["-C", sourceRoot, "add", ".gitignore", "file"]);
    const index = await NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index"));
    const socketPath = NodePath.join(sourceRoot, ".codegraph/daemon.sock");
    const server = NodeNet.createServer((connection) => connection.end("source IPC"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      expect(await clone(sourceRoot, destinationRoot, [".git", ".t3"])).toEqual({ ok: true });
      const privateGit = NodePath.join(destinationRoot, ".git");
      await NodeFSP.mkdir(privateGit, { mode: 0o700 });
      expect(await clone(NodePath.join(sourceRoot, ".git"), privateGit)).toEqual({ ok: true });
      expect(await NodeFSP.readFile(NodePath.join(destinationRoot, "file"), "utf8")).toBe("staged");
      expect(await NodeFSP.readFile(NodePath.join(destinationRoot, "ignored.txt"), "utf8")).toBe(
        "ignored contents",
      );
      expect(await NodeFSP.readFile(NodePath.join(privateGit, "index"))).toEqual(index);
      await NodeFSP.writeFile(NodePath.join(privateGit, "index"), "private index");
      expect(await NodeFSP.readFile(NodePath.join(sourceRoot, ".git/index"))).toEqual(index);
      expect((await NodeFSP.lstat(socketPath)).isSocket()).toBe(true);
      await expect(
        NodeFSP.lstat(NodePath.join(destinationRoot, ".codegraph/daemon.sock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const reply = await new Promise<string>((resolve, reject) => {
        const connection = NodeNet.createConnection(socketPath);
        let data = "";
        connection.on("data", (chunk) => {
          data += chunk.toString();
        });
        connection.once("error", reject);
        connection.once("end", () => resolve(data));
      });
      expect(reply).toBe("source IPC");
      await NodeFSP.symlink(".codegraph/daemon.sock", NodePath.join(sourceRoot, "socket-link"));
      const rejectedRoot = NodePath.join(directory, "rejected");
      await NodeFSP.mkdir(rejectedRoot, { mode: 0o700 });
      expect((await clone(sourceRoot, rejectedRoot, [".git", ".t3"])).reason).toBe(
        "external-symlink",
      );
      expect(await NodeFSP.readdir(rejectedRoot)).toEqual([]);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("clones bytes and metadata, keeps symlinks, and separates source hardlinks", async () => {
    const { sourceRoot, destinationRoot } = await fixture();
    await NodeFSP.mkdir(NodePath.join(sourceRoot, "nested"));
    await NodeFSP.chmod(NodePath.join(sourceRoot, "nested"), 0o1755);
    const original = NodePath.join(sourceRoot, "nested/executable");
    const bytes = Buffer.from([0, 255, 15, 0, 99]);
    await NodeFSP.writeFile(original, bytes, { mode: 0o755 });
    await NodeFSP.utimes(original, 1_700_000_000, 1_700_000_001);
    await execFile("/usr/bin/xattr", ["-w", "user.t3-cow-test", "preserved", original]);
    await NodeFSP.link(original, NodePath.join(sourceRoot, "hardlink"));
    await NodeFSP.symlink("nested/executable", NodePath.join(sourceRoot, "relative-link"));
    await NodeFSP.lutimes(NodePath.join(sourceRoot, "relative-link"), 1_700_000_000, 1_700_000_001);
    for (const ignored of [".git", ".t3"]) {
      await NodeFSP.mkdir(NodePath.join(sourceRoot, ignored));
      await NodeFSP.writeFile(NodePath.join(sourceRoot, ignored, "excluded"), "local state");
    }
    expect(await clone(sourceRoot, destinationRoot, [".git", ".t3"])).toEqual({ ok: true });
    const copy = NodePath.join(destinationRoot, "nested/executable");
    expect(await NodeFSP.readFile(copy)).toEqual(bytes);
    expect((await NodeFSP.stat(copy)).mode & 0o777).toBe(0o755);
    expect((await NodeFSP.stat(copy)).mtimeMs).toBe((await NodeFSP.stat(original)).mtimeMs);
    expect((await execFile("/usr/bin/xattr", ["-p", "user.t3-cow-test", copy])).stdout.trim()).toBe(
      "preserved",
    );
    expect(await NodeFSP.readlink(NodePath.join(destinationRoot, "relative-link"))).toBe(
      "nested/executable",
    );
    expect((await NodeFSP.stat(NodePath.join(destinationRoot, "nested"))).mode & 0o1777).toBe(
      0o1755,
    );
    expect((await NodeFSP.lstat(NodePath.join(destinationRoot, "relative-link"))).mtimeMs).toBe(
      (await NodeFSP.lstat(NodePath.join(sourceRoot, "relative-link"))).mtimeMs,
    );
    expect(await NodeFSP.readdir(destinationRoot)).not.toContain(".git");
    expect(await NodeFSP.readdir(destinationRoot)).not.toContain(".t3");
    expect((await NodeFSP.stat(copy)).ino).not.toBe((await NodeFSP.stat(original)).ino);
    expect((await NodeFSP.stat(copy)).ino).not.toBe(
      (await NodeFSP.stat(NodePath.join(destinationRoot, "hardlink"))).ino,
    );
    await NodeFSP.writeFile(copy, "copy writes");
    expect(await NodeFSP.readFile(original)).toEqual(bytes);
    expect(await NodeFSP.readFile(NodePath.join(destinationRoot, "hardlink"))).toEqual(bytes);
    await NodeFSP.writeFile(original, "source writes");
    expect(await NodeFSP.readFile(copy, "utf8")).toBe("copy writes");
    expect(await NodeFSP.readFile(NodePath.join(destinationRoot, "hardlink"))).toEqual(bytes);
  });

  it("can clone Git metadata when no exclusions are requested", async () => {
    const { sourceRoot, destinationRoot } = await fixture();
    await execFile("git", ["init", "-q", sourceRoot]);
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "staged"), "index content");
    await execFile("git", ["-C", sourceRoot, "add", "staged"]);
    expect(await clone(sourceRoot, destinationRoot)).toEqual({ ok: true });
    await NodeFSP.writeFile(NodePath.join(destinationRoot, "staged"), "session content");
    await execFile("git", ["-C", destinationRoot, "add", "staged"]);
    expect((await execFile("git", ["-C", sourceRoot, "show", ":staged"])).stdout).toBe(
      "index content",
    );
    expect((await execFile("git", ["-C", destinationRoot, "show", ":staged"])).stdout).toBe(
      "session content",
    );
  });

  it("rejects escaping symlinks and special files before cloning contents", async () => {
    for (const kind of ["relative", "absolute", "fifo"] as const) {
      const { directory, sourceRoot, destinationRoot } = await fixture();
      await NodeFSP.writeFile(NodePath.join(directory, "outside"), "secret");
      const entry = NodePath.join(sourceRoot, "unsafe");
      if (kind === "fifo") await execFile("mkfifo", [entry]);
      else
        await NodeFSP.symlink(
          kind === "relative" ? "../outside" : NodePath.join(directory, "outside"),
          entry,
        );
      const error = await clone(sourceRoot, destinationRoot);
      expect(error.reason).toBe(kind === "fifo" ? "special-file" : "external-symlink");
      expect(await NodeFSP.readdir(destinationRoot)).toEqual([]);
    }
  });

  it("rejects links that depend on an excluded intermediate directory", async () => {
    const { sourceRoot, destinationRoot } = await fixture();
    await NodeFSP.mkdir(NodePath.join(sourceRoot, ".git"));
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source");
    await NodeFSP.symlink(".git/../file", NodePath.join(sourceRoot, "link"));
    expect((await clone(sourceRoot, destinationRoot, [".git"])).reason).toBe("external-symlink");
    expect(await NodeFSP.readdir(destinationRoot)).toEqual([]);
  });

  it("rejects nonempty destinations, broad permissions, and excluded-path traversal", async () => {
    const { sourceRoot, destinationRoot } = await fixture();
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source");
    const attempt = (excludedPaths?: ReadonlyArray<string>) =>
      clone(sourceRoot, destinationRoot, excludedPaths);
    await NodeFSP.writeFile(NodePath.join(destinationRoot, ".git"), "existing");
    expect((await attempt([".git"])).reason).toBe("destination");
    expect(await NodeFSP.readFile(NodePath.join(destinationRoot, ".git"), "utf8")).toBe("existing");
    await NodeFSP.unlink(NodePath.join(destinationRoot, ".git"));
    await NodeFSP.chmod(destinationRoot, 0o755);
    expect((await attempt()).reason).toBe("destination");
    await NodeFSP.chmod(destinationRoot, 0o700);
    expect((await attempt(["../outside"])).reason).toBe("path");
    const nested = NodePath.join(sourceRoot, "private-copy");
    await NodeFSP.mkdir(nested, { mode: 0o700 });
    expect((await clone(sourceRoot, nested)).reason).toBe("destination");
    expect(await NodeFSP.readdir(nested)).toEqual([]);
  });

  it("reports unsupported filesystems without copying", async () => {
    const { sourceRoot } = await fixture();
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source");
    expect((await native("probe", sourceRoot, "/dev")).reason).toBe("filesystem");
  });

  it.effect("surfaces permission failure instead of reporting unsupported capability", () =>
    Effect.gen(function* () {
      const { sourceRoot, destinationRoot } = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source"));
      yield* Effect.promise(() => NodeFSP.chmod(destinationRoot, 0o500));
      const service = yield* ApfsClone.ApfsClone;
      const error = yield* service
        .probe({ sourceRoot, destinationParent: destinationRoot })
        .pipe(Effect.flip);
      expect(error.reason).toBe("io");
      expect(error.errno).toBe(13);
      yield* Effect.promise(() => NodeFSP.chmod(destinationRoot, 0o700));
    }).pipe(
      Effect.provide(ApfsClone.layer),
      Effect.provideService(HostProcess.Environment, { T3CODE_APFS_CLONE_PATH: helper }),
      Effect.provide(NodeServices.layer),
    ),
  );

  it("rejects a source directory change during native cloning", async () => {
    const { sourceRoot, destinationRoot } = await largeFixture();
    const child = NodeChildProcess.spawn(helper, ["clone", sourceRoot, destinationRoot]);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const mutated = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stderr.once("data", () => {
        NodeFSP.writeFile(
          NodePath.join(sourceRoot, "concurrent-addition"),
          "new source entry",
        ).then(resolve, reject);
      });
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await Promise.all([exited, mutated]);
    expect(decodeNativeResult(stdout).reason).toBe("source-changed");
  });

  it("terminates the native clone before rolling back its private allocation", async () => {
    const { sourceRoot, destinationRoot } = await largeFixture();
    const child = NodeChildProcess.spawn(helper, ["clone", sourceRoot, destinationRoot]);
    child.stdout.resume();
    child.stderr.once("data", () => {
      child.kill("SIGTERM");
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (_code, signal) => resolve(signal));
    });
    expect(signal).toBe("SIGTERM");
    await NodeFSP.rm(destinationRoot, { recursive: true });
    expect(await NodeFSP.readFile(NodePath.join(sourceRoot, "file-0"), "utf8")).toBe("source");
    expect((await NodeFSP.readdir(sourceRoot)).length).toBe(5000);
  });

  it("rejects nested repositories before the first sensitive clone", async () => {
    const { sourceRoot, destinationRoot } = await fixture();
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "file"), "source");
    await NodeFSP.mkdir(NodePath.join(sourceRoot, "nested"));
    await NodeFSP.mkdir(NodePath.join(sourceRoot, "nested/.git"));
    expect((await clone(sourceRoot, destinationRoot)).reason).toBe("unsupported-layout");
    expect(await NodeFSP.readdir(destinationRoot)).toEqual([]);
  });
});
