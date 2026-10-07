import { cowWorkspaceForRoot } from "@t3tools/client-runtime/state/orchestration";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../../components/AppText";
import { orchestrationEnvironment } from "../../../state/orchestration";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SheetListRow } from "./gitSheetComponents";

export function CowWorkspaceActions({
  environmentId,
  threadId,
  rootPath,
  supported,
  onReviewChanges,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  rootPath: string | null;
  supported: boolean;
  onReviewChanges?: () => void;
}) {
  const workspace = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.cowWorkspace.inspect({ environmentId, input: { threadId } })
      : null,
  );
  const ownedWorkspace = cowWorkspaceForRoot(
    workspace.error === null ? workspace.data : null,
    rootPath,
  );
  const [open, setOpen] = useState(false);
  const canIntegrate = useAtomValue(
    orchestrationEnvironment.cowWorkspace.integrate.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    orchestrationEnvironment.cowWorkspace.remove.permissionAtom(environmentId),
  );
  const changes = useEnvironmentQuery(
    open && ownedWorkspace
      ? orchestrationEnvironment.cowWorkspace.changes({
          environmentId,
          input: { threadId, workspaceId: ownedWorkspace.workspaceId },
        })
      : null,
  );
  const integrate = useAtomCommand(orchestrationEnvironment.cowWorkspace.integrate, {
    reportFailure: false,
  });
  const remove = useAtomCommand(orchestrationEnvironment.cowWorkspace.remove, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const refreshWorkspace = workspace.refresh;
  useEffect(() => {
    if (supported && rootPath !== null) refreshWorkspace();
  }, [supported, rootPath, refreshWorkspace]);
  const [message, setMessage] = useState<string | null>(null);
  const integrateSelected = async () => {
    if (busy || selected.size === 0 || !ownedWorkspace) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await integrate({
        environmentId,
        input: { threadId, workspaceId: ownedWorkspace.workspaceId, paths: [...selected] },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setMessage(
        result.value.conflicts.length > 0
          ? `Conflicts: ${result.value.conflicts.join(", ")}. Both checkouts are retained. Review the listed files in both checkouts, resolve them, then retry.`
          : "Selected changes integrated into the project checkout.",
      );
      if (result.value.conflicts.length === 0) {
        setSelected(new Set());
        changes.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Integration failed.");
    } finally {
      setBusy(false);
    }
  };
  const removeCopy = async (force: boolean) => {
    if (busy || !ownedWorkspace) return;
    setBusy(true);
    try {
      const result = await remove({
        environmentId,
        input: { threadId, workspaceId: ownedWorkspace.workspaceId, force },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      workspace.refresh();
    } catch (error) {
      Alert.alert(
        "Removal failed",
        error instanceof Error ? error.message : "Workspace operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (!ownedWorkspace) return null;
  if (ownedWorkspace.state === "missing")
    return (
      <Text accessibilityRole="alert" className="py-3 text-base text-foreground">
        Copy-on-write workspace is missing or removed. Retained Git history requires manual recovery
        before work can resume.
      </Text>
    );
  return (
    <>
      <View className="overflow-hidden rounded-2xl bg-card">
        <SheetListRow
          icon="arrow.triangle.merge"
          title="Integrate copy-on-write changes"
          subtitle="Merge selected edits into the project checkout"
          disabled={busy || !canIntegrate}
          onPress={() => {
            setSelected(new Set());
            setMessage(null);
            setOpen(true);
          }}
        />
        <SheetListRow
          icon="trash"
          title="Remove copy-on-write workspace"
          disabled={busy || !canRemove}
          onPress={() =>
            Alert.alert(
              "Remove copy-on-write workspace?",
              "The server retains Git history before removing this copy. Recovery is manual; uncommitted contents are discarded when allowed. Stop its agents and terminals first.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove clean copy",
                  style: "destructive",
                  onPress: () => void removeCopy(false),
                },
                {
                  text: "Discard uncommitted contents and remove",
                  style: "destructive",
                  onPress: () => void removeCopy(true),
                },
              ],
            )
          }
        />
      </View>
      <Modal
        visible={open}
        animationType="slide"
        onRequestClose={() => {
          if (!busy) setOpen(false);
        }}
      >
        <View className="flex-1 bg-background px-4 pt-16 pb-8">
          <Text className="text-xl font-t3-bold text-foreground">
            Integrate copy-on-write changes
          </Text>
          <Text className="py-3 text-base text-foreground-muted">
            Select changes made since copy creation. Conflicts retain both checkouts.
          </Text>
          <ScrollView className="flex-1">
            {changes.error ? (
              <Text>{changes.error}</Text>
            ) : changes.isPending ? (
              <Text>Loading changes…</Text>
            ) : changes.data?.length === 0 ? (
              <Text>No changes since copy creation.</Text>
            ) : null}
            {changes.data?.map((change) => (
              <Pressable
                key={change.path}
                accessibilityRole="checkbox"
                accessibilityState={{
                  checked: selected.has(change.path),
                  disabled: busy || !canIntegrate,
                }}
                disabled={busy || !canIntegrate}
                className="border-b border-border py-3"
                onPress={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(change.path)) next.delete(change.path);
                    else next.add(change.path);
                    return next;
                  })
                }
              >
                <Text className="text-base text-foreground">
                  {selected.has(change.path) ? "Selected: " : ""}
                  {change.path} ({change.kind})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          {message ? (
            <Text accessibilityRole="alert" className="py-3 text-base text-foreground">
              {message}
            </Text>
          ) : null}
          {message && onReviewChanges ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="items-center p-3"
              onPress={() => {
                setOpen(false);
                onReviewChanges();
              }}
            >
              <Text className="text-base text-foreground">Review changes</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !canIntegrate || selected.size === 0}
            className="items-center rounded-xl bg-primary p-3 disabled:opacity-50"
            onPress={() => void integrateSelected()}
          >
            <Text className="text-base text-primary-foreground">
              {busy ? "Working…" : "Integrate selected paths"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            className="items-center p-3"
            onPress={() => setOpen(false)}
          >
            <Text className="text-base text-foreground">Close</Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}
