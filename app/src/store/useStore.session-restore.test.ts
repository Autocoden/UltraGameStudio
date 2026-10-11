import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyStore } from './history/store';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';
import { chatWorkflow, useStore } from './useStore';
import type { AiEditChannel } from './channelTypes';

afterEach(() => {
  activeAiEdits.clear();
  aiEditSnapshots.clear();
  vi.restoreAllMocks();
});

describe('session restoration', () => {
  it.each([true, false])('restores the correct message on the first activation (live=%s)', async (live) => {
    const workflow = chatWorkflow('目标会话', 'zh-CN');
    const old = { id: 'answer', role: 'assistant' as const, text: '', createdAt: 100 };
    const fresh = { ...old, text: '已生成的正文和执行记录' };
    const channel: AiEditChannel = {
      key: 'restore-channel', sessionKey: 'restore-ws::restore-session', workspaceId: 'restore-ws',
      sessionId: 'restore-session', workflow, messages: [fresh], chat: true,
      workflowSession: false, cliRunIds: new Set(), abortController: new AbortController(),
      ownedMessageIds: new Set(['answer']),
    };
    (live ? activeAiEdits : aiEditSnapshots).set(channel.key, channel);
    vi.spyOn(historyStore, 'getSession').mockResolvedValue({
      id: channel.sessionId!, workspaceId: channel.workspaceId!, title: '目标会话',
      createdAt: 100, updatedAt: 100, isWorkflow: false, messages: [old],
    });
    vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({} as never);
    useStore.setState({ historyReady: true, activeWorkspaceId: channel.workspaceId,
      activeSessionId: 'other', messages: [], workspaces: [], sessions: [], sessionTree: {} });
    useStore.getState().selectSession(channel.sessionId!, channel.workspaceId!);
    await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(channel.sessionId));
    expect(useStore.getState().messages[0].text).toBe(live ? fresh.text : old.text);
  });
});
