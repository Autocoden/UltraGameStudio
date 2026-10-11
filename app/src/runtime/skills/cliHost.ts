/** Pure CLI-host evidence helpers. They do not execute commands or grant tools. */
import type { SkillNativeToolEvent } from './types';

/**
 * A native command exit is verification only for a conservative direct check.
 * Composite shell scripts and text mentioning tests stay ordinary tool evidence.
 * This classifies host records; it is not a shell sandbox or a semantic proof.
 */
export function isCliVerificationEvent(event: SkillNativeToolEvent): boolean {
  if (event.phase !== 'end' || event.provenance !== 'native-tool' || event.status !== 'success' || event.exitCode !== 0 ||
    !/^(?:bash|shell|terminal|exec(?:ute)?|command_execution|commandExecution|run_shell_command)$/i.test(event.toolName)) return false;
  const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : undefined;
  const command = args?.command;
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[;|&<>`$()\r\n\0]/.test(command) ||
    /(?:^|\s)(?:--(?:help|version|if-present|ignore-scripts)|-h)(?:\s|$)/.test(command)) return false;
  return /^(?:(?:npm|pnpm|yarn)\s+(?:test|(?:run\s+)?(?:test(?::[\w-]+)?|check(?::[\w-]+)?|lint(?::[\w-]+)?|build(?::[\w-]+)?))|(?:npx|pnpm\s+exec)\s+(?:tsc|eslint|vitest)|(?:pytest|tsc|eslint|vitest)|(?:python(?:3)?\s+-m\s+pytest)|(?:cargo\s+(?:test|check|clippy))|(?:go\s+(?:test|vet)))(?:\s|$)/.test(command.trim());
}
