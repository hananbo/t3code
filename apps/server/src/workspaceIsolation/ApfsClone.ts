import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const UnsupportedReason = Schema.Literals([
  "platform",
  "helper-unavailable",
  "filesystem",
  "cross-volume",
]);
const isUnsupportedReason = Schema.is(UnsupportedReason);
export type Capability =
  | { readonly backend: "apfs-clone"; readonly supported: true }
  | {
      readonly backend: "apfs-clone";
      readonly supported: false;
      readonly reason: typeof UnsupportedReason.Type;
    };

export class ApfsCloneError extends Schema.TaggedError<ApfsCloneError>()("ApfsCloneError", {
  operation: Schema.Literals(["probe", "clone"]),
  reason: Schema.String,
  errno: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `APFS workspace ${this.operation} failed (${this.reason}).`;
  }
}

export class ApfsClone extends Context.Service<
  ApfsClone,
  {
    readonly probe: (input: {
      readonly sourceRoot: string;
      readonly destinationParent: string;
    }) => Effect.Effect<Capability, ApfsCloneError>;
    readonly clone: (input: {
      readonly sourceRoot: string;
      readonly destinationRoot: string;
      readonly excludedPaths?: ReadonlyArray<string>;
    }) => Effect.Effect<void, ApfsCloneError>;
  }
>()("t3/workspaceIsolation/ApfsClone") {}

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.String, errno: Schema.Number }),
]);
const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply));

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const executablePath = yield* HostProcess.ExecutablePath;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const candidates = environment.T3CODE_APFS_CLONE_PATH
    ? [environment.T3CODE_APFS_CLONE_PATH]
    : [
        path.resolve(path.dirname(executablePath), "apfs-clone/t3-apfs-clone"),
        path.resolve(path.dirname(executablePath), "../Resources/apfs-clone/t3-apfs-clone"),
        path.resolve(import.meta.dirname, "apfs-clone/t3-apfs-clone"),
        path.resolve(
          import.meta.dirname,
          `../../../../native/apfs-clone/build/${architecture}/t3-apfs-clone`,
        ),
      ];

  const run = Effect.fn("apfsClone.run")(function* (
    operation: "probe" | "clone",
    source: string,
    destination: string,
    excludedPaths: ReadonlyArray<string> = [],
  ) {
    if (platform !== "darwin") return yield* new ApfsCloneError({ operation, reason: "platform" });
    let binary: string | undefined;
    for (const candidate of candidates) {
      if (
        yield* fs
          .exists(candidate)
          .pipe(
            Effect.mapError(
              (cause) => new ApfsCloneError({ operation, reason: "helper-access", cause }),
            ),
          )
      ) {
        binary = candidate;
        break;
      }
    }
    if (!binary) return yield* new ApfsCloneError({ operation, reason: "helper-unavailable" });
    const roots = yield* Effect.all([fs.realPath(source), fs.realPath(destination)]).pipe(
      Effect.mapError((cause) => new ApfsCloneError({ operation, reason: "path", cause })),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(binary, [operation, ...roots, ...excludedPaths], {
          extendEnv: false,
          env: {},
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) => new ApfsCloneError({ operation, reason: "helper-start", cause }),
        ),
      );
    const [stdout, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new ApfsCloneError({ operation, reason: "helper-exit", cause })),
    );
    const reply = yield* decodeReply(stdout).pipe(
      Effect.mapError(
        (cause) => new ApfsCloneError({ operation, reason: "helper-protocol", cause }),
      ),
    );
    if (!reply.ok)
      return yield* new ApfsCloneError({ operation, reason: reply.reason, errno: reply.errno });
    if (exitCode !== 0) return yield* new ApfsCloneError({ operation, reason: "helper-exit" });
  });

  return ApfsClone.of({
    probe: (input) =>
      run("probe", input.sourceRoot, input.destinationParent).pipe(
        Effect.scoped,
        Effect.as({ backend: "apfs-clone", supported: true } as const),
        Effect.catchTags({
          ApfsCloneError: (error) =>
            isUnsupportedReason(error.reason)
              ? Effect.succeed({
                  backend: "apfs-clone",
                  supported: false,
                  reason: error.reason,
                } as const)
              : Effect.fail(error),
        }),
      ),
    clone: (input) =>
      run("clone", input.sourceRoot, input.destinationRoot, input.excludedPaths).pipe(
        Effect.scoped,
      ),
  });
});

export const layer = Layer.effect(ApfsClone, make);
