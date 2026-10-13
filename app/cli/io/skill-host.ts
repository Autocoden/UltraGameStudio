/** Node bridge for a host-owned skill service; never resolves model paths. */
import type {
  SkillCatalog, SkillOrigin, SkillProposal, SkillReadRequest, SkillReadResult, SkillMutationResult, SkillHostPort, SkillEvidence, SkillLearningMode,
} from '../../src/runtime/skills/types';
// @ts-expect-error This Node-only backend module has no declaration file.
import { createWorkspaceSkillService } from '../../../backend/src/workspace-skill-service.mjs';

export type NodeSkillHostRequest =
  | { action: 'list'; origin: SkillOrigin }
  | ({ action: 'view'; origin: SkillOrigin } & SkillReadRequest)
  | { action: 'manage'; origin: SkillOrigin; proposal: SkillProposal; mode: SkillLearningMode; evidence: SkillEvidence[] }
  | { action: 'usage'; origin: SkillOrigin; skillId: string;
      kind: 'viewed' | 'delivered' | 'used-with-evidence'; evidenceIds?: string[]; evidence: SkillEvidence[] };

export interface NodeSkillHostOptions {
  /** Trusted host snapshot, not a model-supplied object. */
  origin: SkillOrigin;
  /** Trusted immutable policy/evidence for this review; never from a proposal. */
  mode?: SkillLearningMode;
  evidence?: readonly SkillEvidence[];
  /** Bind to service.request in the caller; the service owns roots and policy. */
  request: (payload: NodeSkillHostRequest) => Promise<unknown>;
}

export interface NodeWorkspaceSkillRequestOptions {
  cwd: string;
  hostId: string;
  workspaceId: string;
}

/** Only the Node host selects a managed root; model requests cannot replace it. */
export function createNodeWorkspaceSkillRequest(options: NodeWorkspaceSkillRequestOptions): NodeSkillHostOptions['request'] {
  const service = createWorkspaceSkillService({ dir: options.cwd, hostId: options.hostId, workspaceId: options.workspaceId });
  return (request) => service.request(request);
}

export function createNodeSkillHostPort(options: NodeSkillHostOptions): SkillHostPort {
  const origin: SkillOrigin = Object.freeze({ ...options.origin });
  const request = options.request;
  const mode = options.mode ?? 'approve-all';
  const evidence = structuredClone([...(options.evidence ?? [])]);
  return {
    list: async () => await request({ action: 'list', origin }) as SkillCatalog,
    view: async (read: SkillReadRequest) => await request({ action: 'view', origin,
      skillId: read.skillId, ...(read.filePath !== undefined ? { filePath: read.filePath } : {}),
    }) as SkillReadResult,
    manage: async (proposal: SkillProposal) => await request({ action: 'manage', origin, mode, evidence: structuredClone(evidence),
      proposal: { version: proposal.version, kind: proposal.kind, lesson: proposal.lesson,
        evidenceIds: [...proposal.evidenceIds], operations: structuredClone(proposal.operations) },
    }) as SkillMutationResult,
    recordUsage: async (skillId, kind, evidenceIds) => {
      await request({ action: 'usage', origin, skillId, kind, evidence: structuredClone(evidence),
        ...(evidenceIds !== undefined ? { evidenceIds: [...evidenceIds] } : {}),
      });
    },
  };
}
