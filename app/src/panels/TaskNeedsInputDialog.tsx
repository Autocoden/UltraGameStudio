import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Sparkles, X } from "lucide-react";
import {
  type TaskDecisionAnswer,
  type TaskNeedsInputDecisions,
  type TaskOpenQuestionDecision,
} from "@/lib/taskBoard";

const CUSTOM_OPTION_ID = "custom";
const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-40";

function renderableQuestions(
  needsInput: TaskNeedsInputDecisions,
): TaskOpenQuestionDecision[] {
  if (needsInput.decisions.length) return needsInput.decisions;
  return needsInput.questions.map((question, index) => ({
    id: "Q" + (index + 1),
    question,
    options: [
      {
        id: "A",
        label: "批准需求中记录的当前假设，并在此基础上继续规划",
        recommended: true,
      },
    ],
  }));
}

export default function TaskNeedsInputDialog({
  needsInput,
  onClose,
  onSubmit,
}: {
  needsInput: TaskNeedsInputDecisions;
  onClose: () => void;
  onSubmit: (answers: TaskDecisionAnswer[]) => void;
}) {
  const questions = useMemo(
    () => renderableQuestions(needsInput),
    [needsInput],
  );
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const decision of questions) {
      const recommended =
        decision.options.find((option) => option.recommended) ??
        decision.options[0];
      if (recommended) initial[decision.id] = recommended.id;
    }
    setSelections(initial);
    setCustomText({});
    setError("");
  }, [questions]);

  const submit = () => {
    const answers: TaskDecisionAnswer[] = [];
    for (const decision of questions) {
      const selectedId = decision.options.length
        ? selections[decision.id]
        : CUSTOM_OPTION_ID;
      if (!selectedId) {
        setError("请回答每一个问题。");
        return;
      }
      if (selectedId === CUSTOM_OPTION_ID) {
        const answer = (customText[decision.id] ?? "").trim();
        if (!answer) {
          setError("请填写自定义答案。");
          return;
        }
        answers.push({
          questionId: decision.id,
          question: decision.question,
          optionId: CUSTOM_OPTION_ID,
          answer,
        });
        continue;
      }
      const option = decision.options.find(
        (candidate) => candidate.id === selectedId,
      );
      if (!option) {
        setError("请回答每一个问题。");
        return;
      }
      answers.push({
        questionId: decision.id,
        question: decision.question,
        optionId: option.id,
        answer: option.label,
      });
    }
    if (!answers.length) {
      setError("没有可提交的问题。");
      return;
    }
    onSubmit(answers);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="回答任务问题"
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <Sparkles size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">回答待确认问题</h3>
            <p className="mt-1 text-xs leading-5 text-fg-dim">
              {needsInput.message ||
                "规划暂停在必须由你决定的问题上。每题已预选建议项。"}
            </p>
          </div>
          <button type="button" aria-label="关闭问题" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
          {questions.map((decision) => {
            const selectedId = decision.options.length
              ? selections[decision.id]
              : CUSTOM_OPTION_ID;
            return (
              <fieldset
                key={decision.id}
                className="rounded-xl border border-border bg-bg/40 p-4"
              >
                <legend className="px-1 text-sm font-medium">
                  <span className="mr-2 text-fg-dim">{decision.id}</span>
                  {decision.question}
                </legend>
                <div className="mt-3 space-y-1.5">
                  {decision.options.map((option) => (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-start gap-2 rounded-lg p-2 text-sm hover:bg-panel-2"
                    >
                      <input
                        type="radio"
                        name={"task-question-" + decision.id}
                        value={option.id}
                        checked={selectedId === option.id}
                        onChange={() =>
                          setSelections((current) => ({
                            ...current,
                            [decision.id]: option.id,
                          }))
                        }
                        className="mt-0.5 accent-violet-500"
                      />
                      <span>
                        {option.label}
                        {option.recommended && (
                          <span className="ml-2 text-xs font-medium text-accent">
                            建议
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg p-2 text-sm hover:bg-panel-2">
                    <input
                      type="radio"
                      name={"task-question-" + decision.id}
                      value={CUSTOM_OPTION_ID}
                      checked={selectedId === CUSTOM_OPTION_ID}
                      onChange={() =>
                        setSelections((current) => ({
                          ...current,
                          [decision.id]: CUSTOM_OPTION_ID,
                        }))
                      }
                      className="mt-0.5 accent-violet-500"
                    />
                    <span>填写其他答案</span>
                  </label>
                  {selectedId === CUSTOM_OPTION_ID && (
                    <textarea
                      aria-label={decision.id + " 自定义答案"}
                      value={customText[decision.id] ?? ""}
                      onChange={(event) =>
                        setCustomText((current) => ({
                          ...current,
                          [decision.id]: event.target.value,
                        }))
                      }
                      placeholder="描述希望采用的决定..."
                      className="mt-2 min-h-20 w-full rounded-md border border-border bg-bg p-3 text-sm"
                    />
                  )}
                </div>
              </fieldset>
            );
          })}
          {error && (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-xs text-red-400"
            >
              <AlertCircle size={13} />
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4">
          <button type="button" className={button} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={button + " bg-accent text-bg"}
            disabled={!questions.length}
            onClick={submit}
          >
            应用并重新规划
          </button>
        </footer>
      </div>
    </div>
  );
}
