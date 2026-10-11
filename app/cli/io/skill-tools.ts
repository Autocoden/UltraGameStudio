/** Model-facing skill tools; the injected service remains filesystem authority. */
import { parseSkillReviewMessage } from '../../src/runtime/skills/protocol';
import type { SkillEvidence, SkillLearningMode, SkillOrigin } from '../../src/runtime/skills/types';
import { createNodeSkillHostPort, type NodeSkillHostOptions } from './skill-host';

export interface NodeSkillToolDefinition {
  name: 'skills_list' | 'skill_view' | 'skill_manage';
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}
export interface NodeSkillToolOptions {
  /** Trusted host snapshot, never a tool argument. */
  origin: SkillOrigin;
  request: NodeSkillHostOptions['request'];
  mode?: SkillLearningMode;
  /** Trusted evidence observed by the host, not supplied by the model. */
  evidence?: () => readonly SkillEvidence[];
  allowManage?: boolean;
  signal?: AbortSignal;
}

const string = { type: 'string', minLength: 1, maxLength: 100000 };
const strictObject = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const identity = { skillId: string, filePath: string };
const receipt = { expectedHash: string, readReceiptId: string };
const definitions: NodeSkillToolDefinition[] = [
  { name: 'skills_list', description: 'Discover this host workspace skill catalog and available host learning evidence. An index is not a full read.',
    inputSchema: strictObject({}, []), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'skill_view', description: 'Read a full SKILL.md or selected support file by opaque skillId and obtain a fresh host receipt. Never executes scripts.',
    inputSchema: strictObject(identity, ['skillId']), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'skill_manage', description: 'Propose bounded skill-only changes using host evidence IDs and fresh read receipts. Host policy determines applied, pending, or failure; cannot approve, execute, or change roots.',
    inputSchema: strictObject({ version: { const: 1 }, kind: { const: 'propose' }, lesson: string,
      evidenceIds: { type: 'array', minItems: 1, maxItems: 64, items: string },
      operations: { type: 'array', minItems: 1, maxItems: 16, items: { anyOf: [
        strictObject({ action: { const: 'create' }, name: string, content: string }, ['action', 'name', 'content']),
        strictObject({ action: { const: 'patch' }, ...identity, oldString: string, newString: { type: 'string', maxLength: 100000 }, ...receipt },
          ['action', 'skillId', 'oldString', 'newString', 'expectedHash', 'readReceiptId']),
        strictObject({ action: { const: 'write_file' }, ...identity, content: string, ...receipt, absent: { const: true } }, ['action', 'skillId', 'filePath', 'content']),
        strictObject({ action: { const: 'remove_file' }, ...identity, ...receipt }, ['action', 'skillId', 'filePath', 'expectedHash', 'readReceiptId']),
      ] } },
    }, ['version', 'kind', 'lesson', 'evidenceIds', 'operations']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];

/** Strict inbound validation is separate from the host port's trusted API. */
export function createNodeSkillToolDispatcher(options: NodeSkillToolOptions) {
  const origin = Object.freeze({ ...options.origin });
  const mode = options.mode ?? 'approve-all';
  const allowManage = options.allowManage !== false && mode !== 'off';
  const request = options.request;
  const getEvidence = options.evidence;
  const signal = options.signal;
  const checkCancelled = (dispatchSignal?: AbortSignal) => {
    if (signal?.aborted || dispatchSignal?.aborted) throw new Error('SKILL_TOOL_CANCELLED');
  };
  const evidence = () => structuredClone([...(getEvidence?.() ?? [])]).filter((item) =>
    item.origin && ['native-tool', 'host-check', 'user-input'].includes(item.provenance) &&
    ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'].every((key) => item.origin[key as keyof SkillOrigin] === origin[key as keyof SkillOrigin])).slice(-256);
  const host = createNodeSkillHostPort({ origin, request, mode: 'off' });
  return {
    tools: () => structuredClone(definitions.filter((tool) => allowManage || tool.name !== 'skill_manage')),
    async invoke(name: string, value: unknown, dispatchSignal?: AbortSignal): Promise<unknown> {
      checkCancelled(dispatchSignal);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL_TOOL_INVALID_ARGUMENTS');
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > 131072) throw new Error('SKILL_TOOL_REQUEST_LIMIT');
      if (name === 'skills_list') {
        if (Object.keys(value).length) throw new Error('SKILL_TOOL_UNKNOWN_FIELD');
        return { ...await host.list(), learningEvidence: evidence().map(({ evidenceId, kind, provenance, status, exitCode }) =>
          ({ evidenceId, kind, provenance, status, ...(exitCode !== undefined ? { exitCode } : {}) })) };
      }
      if (name === 'skill_view') {
        const read = parseSkillReviewMessage(JSON.stringify({ version: 1, kind: 'read', requests: [value] }));
        if (read.kind !== 'read') throw new Error('SKILL_TOOL_INVALID_ARGUMENTS');
        return host.view(read.requests[0]);
      }
      if (name !== 'skill_manage') throw new Error('SKILL_TOOL_UNAVAILABLE');
      if (!allowManage) throw new Error('SKILL_TOOL_MANAGE_DISABLED');
      const proposal = parseSkillReviewMessage(raw);
      if (proposal.kind !== 'propose') throw new Error('SKILL_TOOL_INVALID_PROPOSAL');
      const known = evidence();
      if (proposal.evidenceIds.some((id) => !known.some((item) => item.evidenceId === id))) throw new Error('SKILL_TOOL_UNKNOWN_EVIDENCE');
      checkCancelled(dispatchSignal);
      return createNodeSkillHostPort({ origin, request, mode, evidence: known }).manage(proposal);
    },
  };
}
export type NodeSkillToolDispatcher = ReturnType<typeof createNodeSkillToolDispatcher>;
