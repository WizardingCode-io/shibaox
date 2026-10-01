import type { RoutineApprovals, RoutineTrigger } from '@wizardingcode/shibaox-schemas';

export interface RoutineTemplate {
  id: string;
  title: string;
  description: string;
  icon:
    | 'triangle-alert'
    | 'file-text'
    | 'search'
    | 'wrench'
    | 'zap'
    | 'history'
    | 'clock'
    | 'globe';
  draft: {
    name: string;
    description: string;
    trigger: RoutineTrigger;
    workflow: string;
    input: string;
    approvals?: RoutineApprovals;
  };
}

/** Routines most teams want on day one; each opens the dialog prefilled. */
export const TEMPLATES: RoutineTemplate[] = [
  {
    id: 'security-scan',
    title: 'Security scan',
    description: 'Audit the dependencies every Monday and triage what it finds.',
    icon: 'triangle-alert',
    draft: {
      name: 'Security scan',
      description: 'Weekly dependency audit',
      trigger: { type: 'cron', cron: '0 9 * * 1' },
      workflow: 'security-scan',
      input: 'Run the dependency audit and report what needs attention, most severe first.',
    },
  },
  {
    id: 'daily-briefing',
    title: 'Daily briefing',
    description: 'What changed in the repository yesterday: commits, pull requests, issues.',
    icon: 'file-text',
    draft: {
      name: 'Daily briefing',
      description: "Yesterday's commits, PRs and issues",
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      workflow: 'chat',
      input:
        'Summarise what changed in this repository since yesterday: commits on the main branch, pull requests opened, reviewed or merged, and issues opened or closed (use git and gh). Keep it to ten lines and say what needs a decision.',
    },
  },
  {
    id: 'issue-triage',
    title: 'Issue triage',
    description: 'New issues get a first read: a summary, a suggested label and a next step.',
    icon: 'search',
    draft: {
      name: 'Issue triage',
      description: 'A first read of new issues',
      trigger: { type: 'github', watch: 'issues' },
      workflow: 'chat',
      input:
        'For each new issue below: say what it asks for in one line, whether the repository already covers it, and the next step (a label, a question to the reporter, or a fix). Do not change anything.',
    },
  },
  {
    id: 'fix-bugs',
    title: 'Fix labelled bugs',
    description:
      'An issue labelled "bug" becomes a pull request, with your approval before it lands.',
    icon: 'wrench',
    draft: {
      name: 'Fix labelled bugs',
      description: 'bug-labelled issues → pull requests',
      trigger: { type: 'github', watch: 'issues', label: 'bug' },
      workflow: 'fix-issue',
      input: 'Fix the issue described below and open a pull request.',
    },
  },
  {
    id: 'monitor-ci',
    title: 'Monitor CI',
    description: 'When CI on the default branch goes red, find out why and propose the fix.',
    icon: 'zap',
    draft: {
      name: 'Monitor CI',
      description: 'A red CI on the default branch',
      trigger: { type: 'github', watch: 'checks' },
      workflow: 'fix-issue',
      input:
        'CI on the default branch is red (the runs are below). Find the failing step, the cause, and open a pull request with the fix.',
    },
  },
  {
    id: 'weekly-review',
    title: 'Weekly review',
    description: 'A Friday summary of what landed this week and what is still open.',
    icon: 'history',
    draft: {
      name: 'Weekly review',
      description: 'The week, every Friday',
      trigger: { type: 'cron', cron: '0 16 * * 5' },
      workflow: 'chat',
      input:
        'Write the weekly review of this repository: what landed (merged pull requests, notable commits), what is still open, and what looks stuck. Use git and gh. One page.',
    },
  },
  {
    id: 'dependency-updates',
    title: 'Dependency updates',
    description: 'Every Monday, the outdated dependencies and what upgrading each would mean.',
    icon: 'clock',
    draft: {
      name: 'Dependency updates',
      description: 'Outdated dependencies, weekly',
      trigger: { type: 'cron', cron: '0 9 * * 1' },
      workflow: 'chat',
      input:
        "List this project's outdated dependencies (the package manager's outdated command), group them by major and minor, and say which upgrades look safe and which need a look at the changelog.",
    },
  },
];
