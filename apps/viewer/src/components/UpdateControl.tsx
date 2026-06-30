import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import type { UpdateStatus } from "@plan-review/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyUpdate, checkUpdate, fetchHealthSha } from "../update";

type Phase = "idle" | "applying" | "applied";

// How long to wait for the rebuilt broker to come back up before giving up. An update
// includes a Rust recompile, so this is generously long.
const POLL_MS = 3000;
const POLL_DEADLINE_MS = 10 * 60_000;

/**
 * Header affordance + dialog for in-app self-update. Drives the broker's
 * /update/check and /update/apply, mirroring the macOS "Check for Updates…" menu
 * item (which emits the `check-for-updates` Tauri event this listens for). A dot on
 * the button signals an available update found by the background check on mount.
 */
export function UpdateControl() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const fromShaRef = useRef<string | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setActionError(null);
    try {
      setStatus(await checkUpdate());
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    } finally {
      setChecking(false);
    }
  }, []);

  // Background check on mount so the button can show an "available" dot unprompted.
  useEffect(() => {
    void runCheck();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [runCheck]);

  // The macOS menu item ("Check for Updates…") emits this event; open + re-check.
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("check-for-updates", () => {
          setOpen(true);
          void runCheck();
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else dispose = un;
      })
      .catch(() => {
        /* not running inside Tauri (browser/dev) */
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [runCheck]);

  const openDialog = () => {
    setOpen(true);
    void runCheck();
  };

  // Poll the broker's /health sha until it differs from the pre-apply sha (the
  // rebuilt broker has restarted), or the target sha if we know it.
  const startPolling = useCallback((target: string | null) => {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const from = fromShaRef.current;
    const tick = async () => {
      const sha = await fetchHealthSha();
      const landed = !!sha && sha !== from && (target ? sha === target : true);
      if (landed) {
        setPhase("applied");
        return;
      }
      if (Date.now() > deadline) {
        setActionError("Update is taking a while — check ~/.plan-review/update.log");
        return;
      }
      pollRef.current = window.setTimeout(tick, POLL_MS);
    };
    pollRef.current = window.setTimeout(tick, POLL_MS);
  }, []);

  const apply = useCallback(async () => {
    setActionError(null);
    fromShaRef.current = status?.sha ?? null;
    let res;
    try {
      res = await applyUpdate();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
      return;
    }
    if (!res.started) {
      setActionError(res.error ?? "could not start the update");
      return;
    }
    setPhase("applying");
    startPolling(res.targetSha);
  }, [status, startPolling]);

  const available = (status?.behind ?? 0) > 0;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={openDialog}
        title={available ? `Update available — ${status?.behind} new` : "Check for updates"}
        aria-label="Check for updates"
        className="relative"
      >
        <ArrowDownToLine />
        {available && phase === "idle" && (
          <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-info ring-2 ring-card" />
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Updates</DialogTitle>
            <DialogDescription>
              {status
                ? `Plan Review ${status.version} · ${status.branch} @ ${status.sha.slice(0, 9)}`
                : "Checking…"}
            </DialogDescription>
          </DialogHeader>

          <Body
            status={status}
            checking={checking}
            phase={phase}
            actionError={actionError}
          />

          <DialogFooter>
            {phase === "applied" ? (
              <Button onClick={() => setOpen(false)}>Close</Button>
            ) : phase === "applying" ? null : (
              <>
                <Button variant="ghost" onClick={runCheck} disabled={checking}>
                  <RefreshCw className={checking ? "animate-spin" : undefined} />
                  Check again
                </Button>
                {status && status.behind > 0 && (
                  <Button onClick={apply} disabled={!status.canApply}>
                    <ArrowDownToLine /> Update now
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Body({
  status,
  checking,
  phase,
  actionError,
}: {
  status: UpdateStatus | null;
  checking: boolean;
  phase: Phase;
  actionError: string | null;
}) {
  if (phase === "applied")
    return (
      <Note icon={CircleCheck} tone="success">
        Updated. <strong>Reopen this plan</strong> to load the new version.
      </Note>
    );

  if (phase === "applying")
    return (
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <span className="flex items-center gap-2 text-foreground">
          <Spinner /> Updating…
        </span>
        <p className="leading-relaxed">
          Fetching, reinstalling, and rebuilding the app. This can take a few minutes; the window reconnects
          automatically when it’s done.
        </p>
        {actionError && <ErrorLine>{actionError}</ErrorLine>}
      </div>
    );

  if (checking && !status)
    return (
      <span className="flex items-center gap-2 text-sm text-foreground">
        <Spinner /> Checking for updates…
      </span>
    );

  if (status?.error)
    return <Note icon={TriangleAlert} tone="warn">Couldn’t check for updates: {status.error}</Note>;

  if (status && status.behind === 0)
    return (
      <Note icon={CircleCheck} tone="success">
        You’re on the latest version.
      </Note>
    );

  if (!status) return null;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-foreground">
        {status.behind} update{status.behind === 1 ? "" : "s"} available
      </p>
      <ul className="max-h-52 space-y-1 overflow-auto rounded-md border border-border bg-muted/30 p-2.5">
        {status.commits.map((c) => (
          <li key={c.sha} className="flex gap-2 leading-relaxed">
            <code className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">{c.sha}</code>
            <span className="text-foreground/85">{c.subject}</span>
          </li>
        ))}
      </ul>
      {!status.clean && (
        <Note icon={TriangleAlert} tone="warn">
          You have uncommitted local changes. Commit or stash them before updating.
        </Note>
      )}
      {status.ahead > 0 && (
        <Note icon={TriangleAlert} tone="warn">
          Your checkout has {status.ahead} local commit{status.ahead === 1 ? "" : "s"} not in {status.branch}. Update
          from a terminal with <code className="font-mono">git pull --rebase</code>.
        </Note>
      )}
      {actionError && <ErrorLine>{actionError}</ErrorLine>}
    </div>
  );
}

function Note({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof CircleCheck;
  tone: "success" | "warn";
  children: React.ReactNode;
}) {
  const cls = tone === "success" ? "text-success" : "text-warning";
  return (
    <div className="flex items-start gap-2 text-sm leading-relaxed text-foreground/85">
      <Icon className={`mt-0.5 size-4 shrink-0 ${cls}`} />
      <span>{children}</span>
    </div>
  );
}

const ErrorLine = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{children}</p>
);

const Spinner = () => (
  <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
);
