import { loadWorkflowTask } from "./taskLoader";

const file = process.env.WORKFLOW_TASK_FILE;

if (!file) {
  throw new Error("Missing WORKFLOW_TASK_FILE");
}

const task = loadWorkflowTask(file);

console.log({
  id: task.id,
  repository: `${task.repository.owner}/${task.repository.name}`,
  workspace: task.workspace,
  baseBranch: task.baseBranch,
  workingBranch: task.workingBranch,
  pullRequestNumber: task.pullRequestNumber,
  maxReviewCycles: task.maxReviewCycles,
});
