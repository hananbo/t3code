import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Build scripts target the actual compiler host.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation runs only on the actual macOS host.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: {
    arch: { type: "string", default: hostArch },
    output: { type: "string" },
  },
});

// Build time only. Installed servers never invoke a compiler.
if (hostPlatform === "darwin") {
  const architectures = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (!architectures) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../native/apfs-clone/", import.meta.url));
  const source = NodePath.join(root, "main.c");
  const output = values.output ?? NodePath.join(root, "build", values.arch, "t3-apfs-clone");
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    NodeChildProcess.execFileSync(
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        ...architectures.flatMap((arch) => ["-arch", arch]),
        "-mmacosx-version-min=12.0",
        source,
        "-o",
        temporary,
      ],
      { stdio: "inherit" },
    );
    // Apple Silicon requires a signed Mach-O; release packaging replaces this
    // ad hoc signature with its normal Developer ID signature.
    NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", temporary], {
      stdio: "inherit",
    });
    NodeFS.renameSync(temporary, output);
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}
