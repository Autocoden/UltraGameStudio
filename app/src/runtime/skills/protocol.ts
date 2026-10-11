import type { SkillReviewMessage } from './types';

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw new Error(`Invalid ${label}`);
}

/** Host still checks real filesystem links, roots and casing at read/commit. */
export function validateSkillSupportPath(value: unknown): asserts value is string {
  text(value, 'filePath');
  if (!/^(references|templates|scripts|assets)\//.test(value) ||
    /[\\:<>"|?*]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 0x20)) {
    throw new Error('Invalid support path');
  }
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) ||
      WINDOWS_DEVICE.test(segment)) throw new Error('Unsafe support path');
  }
}

export function parseSkillReviewMessage(raw: string): SkillReviewMessage {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 131072) throw new Error('Protocol response exceeds size limit');
  const message = object(JSON.parse(raw));
  if (message.version !== 1) throw new Error('Unsupported protocol version');
  if (message.kind === 'noop') {
    fields(message, ['version', 'kind', 'reason']);
    text(message.reason, 'reason');
  } else if (message.kind === 'read') {
    fields(message, ['version', 'kind', 'requests']);
    if (!Array.isArray(message.requests) || !message.requests.length || message.requests.length > 16) throw new Error('Invalid requests');
    for (const value of message.requests) {
      const request = object(value);
      fields(request, ['skillId', 'filePath']);
      text(request.skillId, 'skillId');
      if ('filePath' in request) validateSkillSupportPath(request.filePath);
    }
  } else if (message.kind === 'propose') {
    fields(message, ['version', 'kind', 'lesson', 'evidenceIds', 'operations']);
    text(message.lesson, 'lesson');
    if (!Array.isArray(message.evidenceIds) || !message.evidenceIds.length || message.evidenceIds.length > 64) throw new Error('Invalid evidenceIds');
    for (const id of message.evidenceIds) text(id, 'evidenceId');
    if (!Array.isArray(message.operations) || !message.operations.length || message.operations.length > 16) throw new Error('Invalid operations');
    if (message.operations.filter((op) => object(op).action === 'create').length > 1) throw new Error('At most one create');
    for (const value of message.operations) {
      const op = object(value);
      switch (op.action) {
        case 'create':
          fields(op, ['action', 'name', 'content']);
          text(op.name, 'name');
          if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(op.name) || op.name.length > 64 || WINDOWS_DEVICE.test(op.name)) throw new Error('Invalid skill name');
          text(op.content, 'content');
          break;
        case 'patch':
          fields(op, ['action', 'skillId', 'filePath', 'oldString', 'newString', 'expectedHash', 'readReceiptId']);
          text(op.skillId, 'skillId');
          if ('filePath' in op) validateSkillSupportPath(op.filePath);
          text(op.oldString, 'oldString');
          if (typeof op.newString !== 'string' || op.oldString === op.newString) throw new Error('Invalid newString');
          text(op.expectedHash, 'expectedHash'); text(op.readReceiptId, 'readReceiptId');
          break;
        case 'write_file':
          fields(op, ['action', 'skillId', 'filePath', 'content', 'expectedHash', 'readReceiptId', 'absent']);
          text(op.skillId, 'skillId'); validateSkillSupportPath(op.filePath); text(op.content, 'content');
          if (op.absent === true) {
            if ('expectedHash' in op || 'readReceiptId' in op) throw new Error('Absent file cannot have an existing-file receipt');
          } else {
            if ('absent' in op) throw new Error('Invalid absent precondition');
            text(op.expectedHash, 'expectedHash'); text(op.readReceiptId, 'readReceiptId');
          }
          break;
        case 'remove_file':
          fields(op, ['action', 'skillId', 'filePath', 'expectedHash', 'readReceiptId']);
          text(op.skillId, 'skillId'); validateSkillSupportPath(op.filePath);
          text(op.expectedHash, 'expectedHash'); text(op.readReceiptId, 'readReceiptId');
          break;
        default: throw new Error('Invalid operation action');
      }
    }
  } else throw new Error('Invalid protocol kind');
  return message as unknown as SkillReviewMessage;
}
