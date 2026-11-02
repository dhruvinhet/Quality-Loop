export const LOAD_BUDGET_MS = 15000;
export class BudgetExceeded extends Error {}
export const JIRA_BUSY = 'Jira is busy, retry the request.';
export function checkJira(response) {
  if (response.status === 429 || response.status >= 500) throw new Error(JIRA_BUSY);
  if (!response.ok) throw new Error('Jira could not complete the request.');
}

// Reads only: a timed-out read may finish, but its result is never published.
export function loadBudget(milliseconds = LOAD_BUDGET_MS) {
  const deadline = Date.now() + milliseconds;
  return {
    check() { if (Date.now() >= deadline) throw new BudgetExceeded(); },
    async run(read) {
      this.check();
      let timer;
      try {
        return await Promise.race([read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new BudgetExceeded()), Math.max(0, deadline - Date.now()));
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}
