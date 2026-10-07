import { ProjectId } from "@t3tools/contracts";
import type {
  OrchestrationV2ShellStreamItem,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

/** Old clients decode the isolation enum strictly. Opted-in clients receive the durable value. */
export function projectCowDefault<T extends { readonly defaultThreadEnvMode?: unknown }>(
  value: T,
  supportsCow: boolean,
): T {
  return !supportsCow && value.defaultThreadEnvMode === "cow"
    ? { ...value, defaultThreadEnvMode: "local" }
    : value;
}

export function projectCowSettings(settings: ServerSettings, supportsCow: boolean): ServerSettings {
  if (supportsCow) return settings;
  return {
    ...projectCowDefault(settings, false),
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([id, entry]) => [
        id,
        projectCowDefault(entry, false),
      ]),
    ),
  };
}

/** Legacy script editors round-trip entire project entries, including the projected Local value. */
export function preserveLegacyCowDefaults(
  settings: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (patch.projectSettingsOverrides === undefined) return patch;
  return {
    ...patch,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(patch.projectSettingsOverrides).map(([id, entry]) => [
        id,
        entry?.defaultThreadEnvMode === "local" &&
        settings.projectSettingsOverrides[ProjectId.make(id)]?.defaultThreadEnvMode === "cow"
          ? { ...entry, defaultThreadEnvMode: "cow" }
          : entry,
      ]),
    ),
  };
}

export function projectCowShellItem(
  item: OrchestrationV2ShellStreamItem,
  supportsCow: boolean,
): OrchestrationV2ShellStreamItem {
  if (supportsCow) return item;
  if (item.kind === "snapshot")
    return {
      ...item,
      snapshot: {
        ...item.snapshot,
        projects: item.snapshot.projects.map((project) => projectCowDefault(project, false)),
      },
    };
  if (item.kind === "project.updated")
    return { ...item, project: projectCowDefault(item.project, false) };
  return item;
}
