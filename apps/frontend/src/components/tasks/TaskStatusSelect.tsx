import { useEffect, useState } from "react";
import { TASK_STATUSES, TASK_STATUS_LABELS, type Task, type TaskStatus } from "@meeting-bot/contracts";
import { errorMessage } from "../../api";
import { setTaskStatus } from "../../tasks";
import { useToast } from "../Toast";

/** Seletor de status que salva na hora; em caso de erro volta ao valor anterior e avisa. */
export function TaskStatusSelect({
  task,
  onChanged,
}: Readonly<{ task: Pick<Task, "id" | "title" | "status">; onChanged: (task: Task) => void }>) {
  const toast = useToast();
  const [value, setValue] = useState<TaskStatus>(task.status);
  const [busy, setBusy] = useState(false);

  useEffect(() => setValue(task.status), [task.status]);

  async function change(next: TaskStatus) {
    const previous = value;
    setValue(next);
    setBusy(true);
    try {
      onChanged(await setTaskStatus(task.id, next));
    } catch (err) {
      setValue(previous);
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      className="task-status-select"
      aria-label={`Status da tarefa ${task.title}`}
      value={value}
      disabled={busy}
      onChange={(e) => void change(e.target.value as TaskStatus)}
    >
      {TASK_STATUSES.map((s) => (
        <option key={s} value={s}>
          {TASK_STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
