import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react";
import { steerTask } from "@/lib/taskBoardRunner";

export default function TaskLiveInstruction({
  boardKey,
  cardId,
}: {
  boardKey: string;
  cardId: string;
}) {
  const [instruction, setInstruction] = useState("");
  const [state, setState] = useState<
    "idle" | "sending" | "accepted" | "failed"
  >("idle");
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || state === "sending") return;
    setState("sending");
    setMessage("正在发送到当前模型会话…");
    try {
      const accepted = await steerTask(boardKey, cardId, text);
      if (!accepted) {
        setState("failed");
        setMessage("当前模型会话不支持实时指令，请停止任务后再继续执行");
        return;
      }
      setInstruction("");
      setState("accepted");
      setMessage("当前模型会话已接收追加指令");
    } catch (reason) {
      setState("failed");
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex shrink-0 items-center gap-2 border-t border-border bg-panel px-4 py-2.5"
    >
      <label htmlFor={`task-live-instruction-${cardId}`} className="sr-only">
        向当前执行会话追加指令
      </label>
      <input
        id={`task-live-instruction-${cardId}`}
        aria-label="向当前执行会话追加指令"
        value={instruction}
        onChange={(event) => {
          setInstruction(event.target.value);
          if (state !== "sending") {
            setState("idle");
            setMessage("");
          }
        }}
        placeholder="向当前执行会话追加指令…"
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-xs text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={!instruction.trim() || state === "sending"}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-accent px-3 text-xs text-bg disabled:opacity-40"
      >
        {state === "sending" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Send size={13} />
        )}
        发送到当前会话
      </button>
      {message && (
        <span
          aria-live="polite"
          className={`inline-flex max-w-64 shrink-0 items-center gap-1 text-[10px] ${
            state === "failed"
              ? "text-red-400"
              : state === "accepted"
                ? "text-emerald-400"
                : "text-fg-dim"
          }`}
        >
          {state === "failed" ? (
            <AlertCircle size={12} />
          ) : state === "accepted" ? (
            <CheckCircle2 size={12} />
          ) : null}
          {message}
        </span>
      )}
    </form>
  );
}
