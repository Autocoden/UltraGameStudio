import { useEffect } from 'react';
import { useStore } from '@/store/useStore';
import {
  listBackgroundJobs,
  type BackgroundJobProbeRaw,
} from '@/lib/tauri';
import {
  isBackgroundJobManifest,
  jobSessionKey,
  parseJobPercent,
  resolveJobStatus,
  type BackgroundJobManifest,
} from '@/lib/backgroundJobs';
import { workflowSessionKeyId } from '@/store/sessionKey';
import type { WorkflowSessionKey } from '@/store/storeState';
import type { RunProgressSummary } from '@/store/runProgress';
import type { BackgroundJobDetail } from '@/lib/chatTasks';

// Poll cadence. Long external jobs (video dub takes hours) don't need a tight
// loop; 3s keeps the Sidebar dot responsive without hammering the disk.
const JOB_POLL_MS = 3000;

/**
 * Turn one Rust probe into a parsed manifest, or null if the file was not a
 * valid job manifest (foreign file, corrupt JSON, wrong schema).
 */
function parseProbeManifest(
  probe: BackgroundJobProbeRaw,
): BackgroundJobManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(probe.manifestJson);
  } catch {
    return null;
  }
  return isBackgroundJobManifest(value) ? value : null;
}

/** Progress summary from a job's tail; percent-only (jobs have no node count). */
function jobProgressSummary(
  manifest: BackgroundJobManifest,
  probe: BackgroundJobProbeRaw,
): RunProgressSummary {
  const percent = parseJobPercent(
    probe.progressTail ?? undefined,
    manifest.progressRegex,
  );
  return { completed: 0, incomplete: 0, percent };
}

/**
 * BackgroundJobRunner: bridges detached external processes to session live
 * status. Every tick it asks Rust to probe each workspace's
 * `.ultragamestudio/jobs/` dir, runs the pure state-machine over each manifest,
 * keeps the still-running ones in `jobSessions` (so the Sidebar dot stays
 * "running"). Terminal manifests stay on disk so details survive session
 * switches and application restarts; only active jobs affect the Sidebar dot.
 *
 * Desktop-only: `listBackgroundJobs` is a no-op (returns []) outside Tauri, so
 * this quietly does nothing in the browser dev server.
 */
export default function BackgroundJobRunner() {
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setBackgroundJobState = useStore((s) => s.setBackgroundJobState);

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    // The set of workspace cwds to probe. Each workspace's `.ultragamestudio`
    // is a separate jobs dir. Dedupe by path; skip workspaces without one.
    const cwds = Array.from(
      new Set(
        workspaces
          .map((w) => w.path?.trim())
          .filter((p): p is string => !!p),
      ),
    );

    const poll = async () => {
      if (polling) return;
      polling = true;
      let probes: BackgroundJobProbeRaw[] = [];
      try {
        const perWorkspace = await Promise.all(
          cwds.length > 0
            ? cwds.map((cwd) => listBackgroundJobs(cwd).catch(() => []))
            : [listBackgroundJobs(null).catch(() => [])],
        );
        probes = perWorkspace.flat();
      } catch {
        polling = false;
        return; // Never let a probe failure crash the poll loop.
      }
      polling = false;
      if (cancelled) return;

      const sessions: WorkflowSessionKey[] = [];
      const progress: Record<string, RunProgressSummary> = {};
      const seenKeyIds = new Set<string>();
      const details: BackgroundJobDetail[] = [];

      for (const probe of probes) {
        const manifest = parseProbeManifest(probe);
        if (!manifest) continue;
        const status = resolveJobStatus(manifest, {
          artifactExists: probe.artifactExists,
          doneMarkerExists: probe.doneMarkerExists,
          failMarkerExists: probe.failMarkerExists,
          pidAlive: probe.pidAlive ?? undefined,
          progressTail: probe.progressTail ?? undefined,
          probedAt: probe.probedAtMs,
        });
        details.push({ manifest, status,
          percent: parseJobPercent(probe.progressTail ?? undefined, manifest.progressRegex),
          progressTail: probe.progressTail ?? '', probedAt: probe.probedAtMs });

        if (status === 'running') {
          const key = jobSessionKey(manifest);
          const keyId = workflowSessionKeyId(key);
          if (!seenKeyIds.has(keyId)) {
            seenKeyIds.add(keyId);
            sessions.push(key);
          }
          const summary = jobProgressSummary(manifest, probe);
          // When several jobs share a session, keep the LOWEST percent so the
          // dot reflects the slowest still-running step.
          const prior = progress[keyId];
          if (
            !prior ||
            (summary.percent != null &&
              (prior.percent == null || summary.percent < prior.percent))
          ) {
            progress[keyId] = summary;
          }
        }
      }

      setBackgroundJobState(sessions, progress, details);
    };

    void poll();
    const timer = window.setInterval(() => void poll(), JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, setBackgroundJobState, workspaces]);

  return null;
}
