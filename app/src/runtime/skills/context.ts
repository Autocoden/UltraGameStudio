import { redactSkillText } from './evidence';
import { validateSkillSupportPath } from './protocol';
import type { SkillHostPort, SkillLearningJob, SkillOrigin, SkillReadRequest, SkillReviewModelPort } from './types';

export interface LoadSkillContextOptions {
  host: SkillHostPort;
  origin: SkillOrigin;
  prompt: string;
  explicitSkillIds?: readonly string[];
  supportRequests?: readonly SkillReadRequest[];
  model?: SkillReviewModelPort;
  signal?: AbortSignal;
}
export interface LoadedSkillContext {
  prompt: string;
  loadedSkills: SkillLearningJob['loadedSkills'];
  catalogRevision: string;
}

/** Append only to the new user request; never mutates system/history objects. */
export async function loadSkillContext(options: LoadSkillContextOptions): Promise<LoadedSkillContext> {
  const check = () => { if (options.signal?.aborted) throw new Error('SKILL_CONTEXT_CANCELLED'); };
  const guarded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancelled = () => reject(new Error('SKILL_CONTEXT_CANCELLED'));
    if (options.signal?.aborted) { promise.catch(() => {}); cancelled(); return; }
    options.signal?.addEventListener('abort', cancelled, { once: true });
    promise.then((value) => { options.signal?.removeEventListener('abort', cancelled); resolve(value); },
      (error) => { options.signal?.removeEventListener('abort', cancelled); reject(error); });
  });
  check();
  const catalog = await guarded(options.host.list());
  check();
  const loadedSkills: SkillLearningJob['loadedSkills'] = [];
  const contexts = [];
  const selected = new Set(options.explicitSkillIds ?? []);
  const active = catalog.entries.filter((entry) => entry.state !== 'archived');
  for (const id of selected) if (!active.some((e) => e.skillId === id)) throw new Error('SKILL_CONTEXT_UNKNOWN_ID');
  const slash = options.prompt.match(/^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/);
  if (slash && !selected.size) {
    const matches = active.filter((entry) => entry.name === slash[1]);
    if (!matches.length) throw new Error('SKILL_CONTEXT_UNKNOWN_NAME');
    const priority = { project: 0, global: 1, external: 2 };
    const first = matches.sort((a, b) => priority[a.scope] - priority[b.scope])[0];
    if (first) {
      if (matches.filter((entry) => priority[entry.scope] === priority[first.scope]).length !== 1) throw new Error('SKILL_CONTEXT_AMBIGUOUS_NAME');
      selected.add(first.skillId);
    }
  }
  if (!selected.size && !slash) {
    const normalized = options.prompt.toLowerCase();
    const wholeName = (name: string): boolean => {
      const at = normalized.indexOf(name.toLowerCase());
      return at >= 0 && !/[a-z0-9_-]/i.test(normalized[at - 1] ?? '') &&
        !/[a-z0-9_-]/i.test(normalized[at + name.length] ?? '');
    };
    const matches = active.filter((entry) => entry.name.length >= 8 &&
      (wholeName(entry.name) || wholeName(entry.name.replace(/-/g, ' '))));
    for (const name of new Set(matches.map((entry) => entry.name))) {
      const named = matches.filter((entry) => entry.name === name);
      const ranks = { project: 0, global: 1, external: 2 };
      named.sort((a, b) => ranks[a.scope] - ranks[b.scope]);
      if (named.filter((entry) => ranks[entry.scope] === ranks[named[0].scope]).length === 1 && selected.size < 4) selected.add(named[0].skillId);
    }
  }
  if (!selected.size && options.model?.capability === 'completion-only' && active.length) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, 5000);
    try {
      const index = active.slice(0, 64).map((entry) => ({ skillId: entry.skillId, name: entry.name, description: entry.description.slice(0, 384), scope: entry.scope }));
      const request = options.model.complete({ system: 'Select only highly relevant skills from this small index. This is a bounded semantic suggestion, not a retrieval guarantee. Return exactly {"skillIds":[opaque ids]}, at most 4, or an empty array. No tools or operations.',
        userContent: JSON.stringify({ prompt: redactSkillText(options.prompt, 4096), index }), signal: controller.signal, timeoutMs: 5000, maxOutputTokens: 512 });
      const response = await new Promise<Awaited<typeof request>>((resolve, reject) => {
        const cancelled = () => reject(new Error('SKILL_SELECTOR_CANCELLED'));
        if (controller.signal.aborted) { cancelled(); return; }
        controller.signal.addEventListener('abort', cancelled, { once: true });
        request.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
      });
      if (response.text.length > 4096) throw new Error('SKILL_SELECTOR_RESPONSE_LIMIT');
      const value: unknown = JSON.parse(response.text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL_SELECTOR_INVALID');
      const selection = value as Record<string, unknown>;
      if (Object.keys(selection).some((key) => key !== 'skillIds') || !Array.isArray(selection.skillIds) || selection.skillIds.length > 4) throw new Error('SKILL_SELECTOR_INVALID');
      if (selection.skillIds.some((id) => typeof id !== 'string' || !index.some((e) => e.skillId === id))) throw new Error('SKILL_SELECTOR_UNKNOWN_ID');
      for (const id of selection.skillIds as string[]) selected.add(id);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Selection is optional; a failed selector gets no new execution capability.
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
  }
  for (const skillId of selected) {
    const read = await guarded(options.host.view({ skillId }));
    check();
    if (read.fullRead !== true || read.entry.skillId !== skillId || read.relativePath !== 'SKILL.md' ||
      read.content.length > 100000 || !read.readReceiptId || !read.hash || !read.revision ||
      read.revision !== read.entry.revision || read.hash !== read.entry.hash) throw new Error('SKILL_CONTEXT_INVALID_FULL_READ');
    contexts.push({ skillId, revision: read.revision, hash: read.hash, filePath: 'SKILL.md', content: read.content, files: read.files });
    loadedSkills.push({ skillId, revision: read.revision, hash: read.hash, files: ['SKILL.md'] });

  }
  for (const request of options.supportRequests ?? []) {
    const loaded = loadedSkills.find((s) => s.skillId === request.skillId);
    if (!loaded) throw new Error('Support request requires a selected skill');
    if (!request.filePath || loaded.files.includes(request.filePath)) continue;
    validateSkillSupportPath(request.filePath);
    const read = await guarded(options.host.view(request));
    check();
    if (read.fullRead !== true || read.entry.skillId !== request.skillId || read.relativePath !== request.filePath ||
      read.content.length > 100000 || !read.readReceiptId || !read.hash || read.revision !== loaded.revision) throw new Error('SKILL_CONTEXT_INVALID_FULL_READ');
    contexts.push({ skillId: request.skillId, revision: read.revision, hash: read.hash,
      filePath: request.filePath, content: read.content, files: read.files });
    loaded.files.push(request.filePath);
  }
  check();
  for (const loaded of loadedSkills) await guarded(options.host.recordUsage?.(loaded.skillId, 'delivered') ?? Promise.resolve());
  check();
  return { prompt: contexts.length ? options.prompt + '\n\n<UGS_SKILL_CONTEXT>\n' + JSON.stringify(contexts) + '\n</UGS_SKILL_CONTEXT>' : options.prompt,
    loadedSkills, catalogRevision: catalog.revision };
}
