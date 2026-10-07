import { EnvironmentId, ThreadId, type CowWorkspace } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { cowWorkspaceBindingKey, cowWorkspaceForRoot } from "./orchestration.ts";

const workspace: CowWorkspace = {
  workspaceId: "copy-one",
  backend: "apfs",
  rootPath: "/copies/one",
  state: "ready",
  branch: "feature",
};

describe("copy-on-write client workspace binding", () => {
  it("hides a previous inspect response until it matches the new execution root", () => {
    expect(cowWorkspaceForRoot(workspace, "/copies/one")).toBe(workspace);
    expect(cowWorkspaceForRoot(workspace, "/copies/two")).toBeNull();
    expect(cowWorkspaceForRoot(workspace, null)).toBeNull();
    expect(cowWorkspaceForRoot(null, "/copies/two")).toBeNull();
  });

  it("starts fresh action state when the host, thread, or root changes", () => {
    const host = EnvironmentId.make("host");
    const thread = ThreadId.make("thread");
    const original = cowWorkspaceBindingKey(host, thread, "/copies/one");
    expect(cowWorkspaceBindingKey(EnvironmentId.make("other"), thread, "/copies/one")).not.toBe(
      original,
    );
    expect(cowWorkspaceBindingKey(host, ThreadId.make("other"), "/copies/one")).not.toBe(original);
    expect(cowWorkspaceBindingKey(host, thread, "/copies/two")).not.toBe(original);
    expect(cowWorkspaceBindingKey(host, thread, "/copies/one")).toBe(original);
  });
});
