import type { TakeOn } from "./db/schema";
import type { TaskView } from "./adoption-rules";
import { fitsTakeOn } from "./sizing";

// The board shows work that fits what the person wants to take on, grouped by
// project and milestone, then single tasks. Finished work drops off.

type BoardTask = Pick<TaskView, "sizeTier" | "status">;
type BoardMilestone<T> = { tasks: T[] };
type BoardProject<M> = { milestones: M[] };

export type BoardData<
  T extends BoardTask = TaskView,
  M extends BoardMilestone<T> = { id: number; title: string; position: number; tasks: T[] },
  P extends BoardProject<M> = { id: number; title: string; milestones: M[] },
> = { projects: P[]; singles: T[] };

const showable = (t: BoardTask) => t.status !== "merged" && t.status !== "closed";

export function filterBoard<T extends BoardTask, M extends BoardMilestone<T>, P extends BoardProject<M>>(
  board: { projects: P[]; singles: T[] },
  takeOn: TakeOn,
): { projects: P[]; singles: T[] } {
  const fits = (t: T) => showable(t) && fitsTakeOn(takeOn, t.sizeTier);
  const projects = board.projects
    .map((p) => ({
      ...p,
      milestones: p.milestones.map((m) => ({ ...m, tasks: m.tasks.filter(fits) })).filter((m) => m.tasks.length > 0),
    }))
    .filter((p) => p.milestones.length > 0);
  return { projects, singles: board.singles.filter(fits) };
}
