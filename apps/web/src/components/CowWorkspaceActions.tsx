import { cowWorkspaceForRoot } from "@t3tools/client-runtime/state/orchestration";
import { useEffect, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentServerConfigsAtom } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

export function CowWorkspaceActions({
  environmentId,
  threadId,
  rootPath,
  onReviewChanges,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  rootPath: string | null;
  onReviewChanges?: () => void;
}) {
  const supported =
    useAtomValue(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .cowWorkspace === true;
  const workspace = useEnvironmentQuery(
    supported
      ? orchestrationEnvironment.cowWorkspace.inspect({ environmentId, input: { threadId } })
      : null,
  );
  const ownedWorkspace = cowWorkspaceForRoot(
    workspace.error === null ? workspace.data : null,
    rootPath,
  );
  const [action, setAction] = useState<"integrate" | "remove" | null>(null);
  const canIntegrate = useAtomValue(
    orchestrationEnvironment.cowWorkspace.integrate.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    orchestrationEnvironment.cowWorkspace.remove.permissionAtom(environmentId),
  );
  const changes = useEnvironmentQuery(
    action === "integrate" && ownedWorkspace
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
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const refreshWorkspace = workspace.refresh;
  useEffect(() => {
    if (supported && rootPath !== null) refreshWorkspace();
  }, [supported, rootPath, refreshWorkspace]);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    if (busy || action === null || !ownedWorkspace) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "integrate") {
        const result = await integrate({
          environmentId,
          input: { threadId, workspaceId: ownedWorkspace.workspaceId, paths: [...selected] },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (result.value.conflicts.length > 0) {
          setMessage(
            `Conflicts: ${result.value.conflicts.join(", ")}. Both checkouts are retained. Review the listed files in both checkouts, resolve them, then retry.`,
          );
          return;
        }
        setMessage("Selected changes integrated into the project checkout.");
        changes.refresh();
        setSelected(new Set());
      } else {
        const result = await remove({
          environmentId,
          input: { threadId, workspaceId: ownedWorkspace.workspaceId, force },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setAction(null);
        workspace.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workspace operation failed.");
    } finally {
      setBusy(false);
    }
  };
  if (!ownedWorkspace) return null;
  if (ownedWorkspace.state === "missing")
    return (
      <p role="alert" className="py-2 text-sm">
        Copy-on-write workspace is missing or removed. Retained Git history requires manual recovery
        before work can resume.
      </p>
    );
  const open = (next: "integrate" | "remove") => {
    setSelected(new Set());
    setForce(false);
    setMessage(null);
    setAction(next);
  };
  return (
    <>
      <div className="flex flex-wrap gap-1 py-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !canIntegrate}
          onClick={() => open("integrate")}
        >
          Integrate copy
        </Button>
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={busy || !canRemove}
          onClick={() => open("remove")}
        >
          Remove copy
        </Button>
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {action === "integrate"
                ? "Integrate copy-on-write changes"
                : "Remove copy-on-write workspace"}
            </DialogTitle>
            <DialogDescription>
              {action === "integrate"
                ? "Select changes made since this copy was created. They merge into the project's current checkout; conflicts retain both checkouts."
                : "The server retains Git history before removing this copy. Recovery is manual; uncommitted contents are discarded when allowed. Stop its agents and terminals first."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {action === "integrate" ? (
              <div className="flex max-h-80 flex-col gap-2 overflow-auto">
                {changes.error ? (
                  <p role="alert">{changes.error}</p>
                ) : changes.isPending ? (
                  <p>Loading changes…</p>
                ) : changes.data?.length === 0 ? (
                  <p>No changes since copy creation.</p>
                ) : null}
                {changes.data?.map((change) => (
                  <label key={change.path} className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.has(change.path)}
                      disabled={busy || !canIntegrate}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(change.path);
                          else next.delete(change.path);
                          return next;
                        })
                      }
                    />
                    <span className="break-all text-sm">
                      {change.path} ({change.kind})
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={force}
                  disabled={busy || !canRemove}
                  onCheckedChange={setForce}
                />
                <span>Discard uncommitted contents when removing this copy</span>
              </label>
            )}
            {message ? (
              <p role="status" className="pt-3 text-sm">
                {message}
              </p>
            ) : null}
            {message && action === "integrate" && onReviewChanges ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setAction(null);
                  onReviewChanges();
                }}
              >
                Review changes
              </Button>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              Close
            </Button>
            <Button
              variant={action === "remove" ? "destructive" : "default"}
              disabled={
                busy || (action === "integrate" ? !canIntegrate || selected.size === 0 : !canRemove)
              }
              onClick={() => void submit()}
            >
              {busy
                ? "Working…"
                : action === "integrate"
                  ? "Integrate selected paths"
                  : "Remove copy"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
