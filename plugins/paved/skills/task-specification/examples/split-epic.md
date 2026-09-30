# Example: request split into tasks

Synthetic. The repository and its paths are invented; only the shape matters.

**Request.** "Add team workspaces: users create a team, invite members, share projects
with the team and see team activity."

**Why split.** Four outcomes that can each be used on their own; together they would
need well over seven acceptance criteria. Whether invitations must go through the
existing email integration is unknown, so it gets its own task after the certain part.

**Proposed tasks, in order.**

| # | Type | Title | Depends on | Expected result |
|---|---|---|---|---|
| 1 | Feature | Create a team and add existing users | — | A user creates a team and adds users who already have an account |
| 2 | Feature | Share a project with a team | 1 | Members of a team open the projects shared with it |
| 3 | Feature | Invite people without an account | 1 | An invited person joins the team through an invitation |
| 4 | Feature | Team activity feed | 2 | Members see who changed which shared project and when |

Each task is then written in full in the template. Task 3 opens with the question the
repository cannot answer: the integrations context lists an email provider, but not
whether it may send invitations on behalf of users.

**Rejected split.** "Team storage", "team endpoints", "team screens": layers that no one
can use or verify separately.
