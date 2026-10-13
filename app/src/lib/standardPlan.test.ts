import { describe, expect, it } from "vitest";
import { orderStandardSubtasks, parseStandardSubtasks, standardPlanDocuments, standardPlanIssues } from "./standardPlan";
import { buildTaskArtifactFiles } from "./taskArtifacts";
import { executionGraph } from "./taskExecutionGraph";
import type { TaskCard } from "./taskBoard";

const plan = `## Requirements
R1: Deliver a report
### Acceptance
AC1: Cite source evidence
## Spec
SCN-001: WHEN requested THEN return verified findings
## Design
DES-001: Inspect the repository and write the report
## Tasks
Tasks-Contract: 1
- [ ] 1. Analysis
  - [ ] 1.2 Write report
    - _Depends on: 1.1_
    - _Files to create: report.md_
    - _Verification: verify citations_
  - [ ] 1.1 Inspect repository
    - _Depends on: none_
  - [ ] 1.3 Inspect documentation
    - _Depends on: none_
`;

describe("Standard compatible documents and execution graph", () => {
  it("preserves separate document bodies and parses only executable leaves", () => {
    expect(standardPlanIssues(plan)).toEqual([]);
    expect(standardPlanDocuments(plan)["requirements.md"]).toContain("AC1:");
    const tasks = parseStandardSubtasks("card", plan);
    expect(tasks.map(task => task.definitionId)).toEqual(["1.2", "1.1", "1.3"]);
    expect(tasks[0]).toMatchObject({ dependsOn: ["1.1"], description: expect.stringContaining("verify citations") });
    expect(orderStandardSubtasks(tasks).map(task => task.definitionId)).toEqual(["1.1", "1.2", "1.3"]);
  });

  it("rejects incomplete documents, unknown dependencies and cycles", () => {
    expect(standardPlanIssues("## Tasks\n- [ ] Work")).toHaveLength(3);
    const tasks = parseStandardSubtasks("card", plan);
    tasks[0].dependsOn = ["missing"];
    expect(() => orderStandardSubtasks(tasks)).toThrow("不存在");
    tasks[0].dependsOn = ["1.1"];
    tasks[1].dependsOn = ["1.2"];
    expect(() => orderStandardSubtasks(tasks)).toThrow("循环");
  });

  it("keeps static definitions unchanged while recording runtime progress and retries", () => {
    const card: TaskCard = { id: "card", title: "Analysis", note: "Analyze only", developmentMode: "standard", status: "human_review", createdAt: 1, updatedAt: 100,
      plan, subtasks: parseStandardSubtasks("card", plan) };
    const before = buildTaskArtifactFiles(card, null);
    card.subtasks![0].status = "completed";
    card.runs = [{ phase: "executing", subtaskId: card.subtasks![0].id, text: "Done", startedAt: 10, completedAt: 50 }];
    const after = buildTaskArtifactFiles(card, null);
    expect(after.map(file => file.name)).toEqual(expect.arrayContaining(["requirements.md", "spec.md", "design.md", "tasks.md", "implementation_plan.md"]));
    expect(after.find(file => file.name === "tasks.md")).toEqual(before.find(file => file.name === "tasks.md"));
    expect(after.find(file => file.name === "implementation_plan.md")?.content).toContain("Status: completed");
    expect(after.find(file => file.name === "implementation_plan.md")?.content).toContain("Duration: 40 ms");
    const graph = executionGraph(card);
    expect(graph.edges).toEqual([{ from: card.subtasks![1].id, to: card.subtasks![0].id }]);
    expect(graph.rounds).toBe(2);
    expect(graph.maxParallel).toBe(2);
    expect(graph.nodes.find(node => node.definitionId === "1.2")?.duration).toBe(40);
  });
});
