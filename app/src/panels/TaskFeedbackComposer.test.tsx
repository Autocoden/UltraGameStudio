import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskReferenceImage } from "@/lib/taskBoard";

const {
  previewLocalFileMock,
  saveClipboardImageMock,
  saveTaskAttachmentMock,
} = vi.hoisted(() => ({
  previewLocalFileMock: vi.fn(),
  saveClipboardImageMock: vi.fn(),
  saveTaskAttachmentMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  previewLocalFile: previewLocalFileMock,
  saveClipboardImage: saveClipboardImageMock,
  saveTaskAttachment: saveTaskAttachmentMock,
}));

import TaskFeedbackComposer from "./TaskFeedbackComposer";

function Harness() {
  const [feedback, setFeedback] = useState("");
  const [attachments, setAttachments] = useState<TaskReferenceImage[]>([]);
  return (
    <TaskFeedbackComposer
      value={feedback}
      onChange={setFeedback}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      cwd={"D:\\project"}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TaskFeedbackComposer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    previewLocalFileMock.mockReset();
    saveClipboardImageMock.mockReset();
    saveTaskAttachmentMock.mockReset();
    saveClipboardImageMock.mockResolvedValue(
      "D:\\project\\.ugs\\clipboard-images\\feedback.png",
    );
    saveTaskAttachmentMock.mockResolvedValue(
      "D:\\project\\.ugs\\task-attachments\\notes.txt",
    );
    previewLocalFileMock.mockResolvedValue({
      path: "D:\\project\\.ugs\\clipboard-images\\feedback.png",
      fileName: "feedback.png",
      kind: "image",
      mime: "image/png",
      sizeBytes: 2,
      truncated: false,
      base64: "aGk=",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("saves a pasted screenshot, previews it, and lets the user remove it", async () => {
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="修改反馈"]',
    )!;
    const file = new File([new Uint8Array([104, 105])], "feedback.png", {
      type: "image/png",
    });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [
          {
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    await act(async () => textarea.dispatchEvent(paste));
    await settle();

    expect(saveClipboardImageMock).toHaveBeenCalledWith({
      bytesBase64: "aGk=",
      mime: "image/png",
      fileName: "feedback.png",
      cwd: "D:\\project",
    });
    expect(previewLocalFileMock).toHaveBeenCalledWith(
      "D:\\project\\.ugs\\clipboard-images\\feedback.png",
      { cwd: "D:\\project" },
    );
    expect(container.textContent).toContain("1/10");
    expect(container.querySelector('img[alt="feedback.png"]')).not.toBeNull();

    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="删除附件 feedback.png"]',
    )!;
    await act(async () => remove.click());
    expect(container.textContent).toContain("0/10");
    expect(container.querySelector('img[alt="feedback.png"]')).toBeNull();
  });

  it("saves a dropped non-image file with the task attachment command", async () => {
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="修改反馈"]',
    )!;
    const file = new File(["review notes"], "notes.txt", {
      type: "text/plain",
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file] },
    });

    await act(async () => textarea.dispatchEvent(drop));
    await settle();

    expect(saveTaskAttachmentMock).toHaveBeenCalledWith({
      bytesBase64: "cmV2aWV3IG5vdGVz",
      mime: "text/plain",
      fileName: "notes.txt",
      cwd: "D:\\project",
    });
    expect(saveClipboardImageMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("notes.txt");
    expect(container.textContent).toContain("1/10");
  });
});
