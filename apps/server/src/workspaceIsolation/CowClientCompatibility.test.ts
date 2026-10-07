import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type OrchestrationProjectShell,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  preserveLegacyCowDefaults,
  projectCowDefault,
  projectCowSettings,
  projectCowShellItem,
} from "./CowClientCompatibility.ts";

const id = ProjectId.make("cow-project");
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultThreadEnvMode: "cow",
  projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "cow", defaultProjectScripts: [] } },
};
const legacyMode = Schema.Literals(["local", "worktree"]);
describe("Cow client compatibility", () => {
  it("projects strict old settings enums without changing durable defaults", () => {
    const legacy = projectCowSettings(settings, false);
    expect(Schema.decodeUnknownSync(legacyMode)(legacy.defaultThreadEnvMode)).toBe("local");
    expect(
      Schema.decodeUnknownSync(legacyMode)(
        legacy.projectSettingsOverrides[id]!.defaultThreadEnvMode!,
      ),
    ).toBe("local");
    expect(settings.defaultThreadEnvMode).toBe("cow");
    expect(settings.projectSettingsOverrides[id]!.defaultThreadEnvMode).toBe("cow");
    expect(projectCowSettings(settings, true)).toBe(settings);
  });
  it("preserves a Cow project default when a legacy script editor resaves the projected entry", () => {
    const legacy = projectCowSettings(settings, false);
    const patch = preserveLegacyCowDefaults(settings, {
      projectSettingsOverrides: {
        [id]: { ...legacy.projectSettingsOverrides[id], defaultProjectScripts: [] },
      },
    });
    expect(patch.projectSettingsOverrides![id]!.defaultThreadEnvMode).toBe("cow");
  });
  it("honors explicit legacy Worktree and reset changes", () => {
    expect(
      preserveLegacyCowDefaults(settings, {
        projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "worktree" } },
      }).projectSettingsOverrides![id]!.defaultThreadEnvMode,
    ).toBe("worktree");
    expect(
      preserveLegacyCowDefaults(settings, { projectSettingsOverrides: { [id]: null } })
        .projectSettingsOverrides![id],
    ).toBeNull();
    expect(
      preserveLegacyCowDefaults(settings, { projectSettingsOverrides: { [id]: {} } })
        .projectSettingsOverrides![id],
    ).toEqual({});
  });
  it("projects project updates for old shell stream readers", () => {
    const project = { id, defaultThreadEnvMode: "cow" } as OrchestrationProjectShell;
    const item = { kind: "project.updated" as const, sequence: 1, project };
    expect(projectCowShellItem(item, false)).toEqual({
      ...item,
      project: { ...project, defaultThreadEnvMode: "local" },
    });
    expect(projectCowShellItem(item, true)).toBe(item);
    expect(projectCowDefault(project, true)).toBe(project);
  });
});
