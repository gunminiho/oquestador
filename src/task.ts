export interface WorkflowTask {
  id: string;

  repository: {
    owner: string;
    name: string;
  };

  workspace: string;

  baseBranch: string;
  workingBranch: string;

  pullRequestNumber?: number;

  objective: string;

  acceptanceCriteria: string[];

  maxReviewCycles: number;
}

export function validateWorkflowTask(
  task: WorkflowTask,
): void {
  if (!task.id.trim()) {
    throw new Error("WorkflowTask.id is required.");
  }

  if (!task.repository.owner.trim()) {
    throw new Error(
      "WorkflowTask.repository.owner is required.",
    );
  }

  if (!task.repository.name.trim()) {
    throw new Error(
      "WorkflowTask.repository.name is required.",
    );
  }

  if (!task.workspace.trim()) {
    throw new Error(
      "WorkflowTask.workspace is required.",
    );
  }

  if (!task.baseBranch.trim()) {
    throw new Error(
      "WorkflowTask.baseBranch is required.",
    );
  }

  if (!task.workingBranch.trim()) {
    throw new Error(
      "WorkflowTask.workingBranch is required.",
    );
  }

  if (
    task.pullRequestNumber !== undefined &&
    (
      !Number.isInteger(task.pullRequestNumber) ||
      task.pullRequestNumber <= 0
    )
  ) {
    throw new Error(
      "WorkflowTask.pullRequestNumber must be a positive integer when provided.",
    );
  }

  if (!task.objective.trim()) {
    throw new Error(
      "WorkflowTask.objective is required.",
    );
  }

  if (task.acceptanceCriteria.length === 0) {
    throw new Error(
      "WorkflowTask.acceptanceCriteria must contain at least one criterion.",
    );
  }

  if (
    !Number.isInteger(task.maxReviewCycles) ||
    task.maxReviewCycles <= 0
  ) {
    throw new Error(
      "WorkflowTask.maxReviewCycles must be a positive integer.",
    );
  }
}

