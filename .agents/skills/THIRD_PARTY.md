# Third-party skills

These skills are copied from other repositories. Don't edit them here. Update them from their source.

| Skill | Source | License | How to update |
|---|---|---|---|
| `benchmark-checklist`, `how`, `principle-*` except the five below, `tdd`, `technical-writing`, `typescript-best-practices`, `unslop` | [backnotprop/pstack](https://github.com/backnotprop/pstack), commit `fce11a3` | MIT, see `PSTACK_LICENSE` | Copy the upstream file again |
| `vercel-react-best-practices`, `vercel-composition-patterns`, `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | MIT, per each `SKILL.md` and the repo README | `pnpm dlx skills update -p` |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) | Apache 2.0, see `frontend-design/LICENSE.txt` | `pnpm dlx skills update -p` |

`skills-lock.json` at the repo root records the source and hash of each skill installed with the `skills` CLI.

The five investigation principles are this repo's own and are edited here: `principle-question-driven-investigation`, `principle-inspect-resources-and-config`, `principle-corroborate-with-the-right-evidence`, `principle-decompose-into-independent-questions`, and `principle-keep-a-finding-ledger`.
