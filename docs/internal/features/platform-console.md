---
title: Platform console
slug: platform-console
purpose: Give an admin one page in studio that shows every operations tool of the deployment, its health, and a link that opens it without a second sign-in.
status: draft
implementation: partial
area: studio
tags: [operations, sso, admin, studio-v3]
created: 2026-11-07
updated: 2026-11-08
version: 0.4
known_issues: ../known-issues/features/platform-console.md
---

# Platform console

## Purpose

An admin who runs the platform today opens each operations tool on its own: Argo CD, Grafana, the Flink UI, and more. They have to remember each address and sign in to each tool separately. The platform console is one page in studio that lists every tool with its health, and opens each one with the admin's studio sign-in. An admin checks the whole platform from one place, and nobody needs to keep a list of addresses.

## Scope

In scope:

- An admin-only page in studio that lists the deployment's operations tools.
- The health of each tool, checked when the page loads.
- Links that open each tool, signed in through the same identity provider as studio where the tool supports it.

Out of scope:

- Operating the tools from the page, such as syncing an Argo CD application or stopping a Flink job. The tools themselves do that.
- How each tool signs a person in. The deployment's environment contract owns that, for example [AWS Free Plan environment](../operations/aws-free-plan.md).
- The studio v2 shell around the page, the route's stage, and the redirect from the classic route. The [studio shell](studio-shell.md) owns them.

## Terms

| Term | Meaning |
|---|---|
| Tool | An operations service of the deployment with its own web address, such as Argo CD, Grafana, the Flink UI, or a Kafka browser. |
| Tool card | One tool's entry on the page: its name, purpose, address, health, and sign-in kind. |
| Health | `up`, `degraded`, `down`, or `unknown`, with a one-line reason, the time of the check, and the details below. The page shows each as an icon with a word: Up, Degraded, Down, or Unknown, and Checking while a check runs. |
| Health details | The parts of a tool that make its health. For Flink, each job with its state. For Argo CD, each application that is not synced and healthy, with its sync status and its health status. |
| Platform status | A banner at the top of the page with one word, NEEDS ATTENTION, OK, CHECKING, or NOTHING TO CHECK, a title, a count of the tools that are up, the tools that need attention, and the check time. [Health of a tool](#health-of-a-tool) gives the rule. |
| Single sign-on tool | A tool that signs a person in through the same identity provider as studio, so a person signed in to studio opens it without entering a password again. |
| Own-login tool | A tool that keeps its own login. The card says so. |
| Quick link | A link to a resource outside the deployment, such as the source repository, its CI runs, or the cloud console page that holds the logins. Each belongs to a group, such as Code or Cloud. |

## Behavior

1. An admin opens **Platform** from studio's navigation. Editors do not see the entry, and the page refuses them.
2. The page opens with the platform status: a word with its icon, such as NEEDS ATTENTION, a title, such as "1 tool needs attention: Flink · 1 job restarting" or "2 tools need attention", a line such as "3 of 4 tools are up", each tool not up with its reason, and when the checks ran, such as "Checked 20 s ago", with **Re-check**. When every tool is up, it reads OK and "All tools are up". While checks run, it reads CHECKING and "Checking 2 of 4 tools…".
3. Below it, the page shows one tool card per tool, in a fixed order: Argo CD, Grafana, Flink, then any other tools the deployment declares. A tool that needs attention is tinted.
4. Each card shows the tool's purpose in one line, its address, its sign-in kind, its health, and **Open**. Health loads after the page renders, so a slow tool never delays the page.
5. Grafana's card also links to its "Flink jobs" dashboard. Flink's card lists each job with its state and a link to the job's UI. Argo CD's card lists each application that is not synced and healthy, with its sync and health status and **Open in Argo CD** for that application, and says that every other application is synced and healthy.
6. Opening a single sign-on tool takes the admin through the identity provider without a password prompt, because they already signed in to studio. Opening an own-login tool shows that tool's login.
7. Below the cards, quick links lead to the source repository, its CI runs, and the cloud console pages where the deployment keeps its logins and its user pool, grouped as the deployment declares, such as Code and Cloud.
8. The page only reads. It says that syncing, stopping, or restarting happens in the tool.

Example. An admin signs in to studio and opens Platform. The status reads Degraded: Flink, `event-parse-job` restarting, checked 4 s ago. Argo CD is `up`, with all applications synced and healthy. Grafana is `up`. Flink's card lists four jobs as Running and `event-parse-job` as `RESTARTING`. The admin clicks that job's link and lands in its Flink UI without signing in again.

## Algorithm

### Health of a tool

Studio's server checks each tool when an admin asks for the page. It never checks from the browser, so the page never exposes an internal address or a credential.

| Tool | `up` when | `degraded` when | `down` when |
|---|---|---|---|
| Argo CD | Every application is synced and healthy | Any application is out of sync, progressing, or degraded | The tool does not answer |
| Grafana | Its health endpoint answers healthy | Its health endpoint reports a failing database | The tool does not answer |
| Flink | Every job is `RUNNING` and `STABLE` | Any job is in any other state | The jobs cannot be read |
| Any other tool | Its address answers with success | Not applicable | The tool does not answer |

A check that takes longer than its timeout gives `unknown` with the reason "timed out". A check never retries within one page load. **Re-check** asks the server again. The server still calls a tool at most once per PCN-NFR-03 window, so a re-check inside the window returns the last result with the time it was checked.

The platform status takes the first of these that applies:

| Condition | Word | Title | Count line | Re-check |
|---|---|---|---|---|
| The deployment declares no tools | NOTHING TO CHECK | "No tools to check" | none; the check time reads "Not checked" | disabled |
| A check is still running | CHECKING | "Checking N of M tools…", N the checks still running | "K tools are up so far" | disabled |
| A tool is `down` or `degraded` | NEEDS ATTENTION | "1 tool needs attention: <tool> · <reason>" for one tool, else "N tools need attention" | "K of M tools are up" | enabled |
| Otherwise | OK | "All tools are up" | none | enabled |

K counts the tools that are `up`. A tool that is `unknown` does not count as up, and it does not make the status NEEDS ATTENTION: when every other tool is up, the status reads OK. The banner lists each `down`, `degraded`, and `unknown` tool with its reason, and each name links to its card.

## Functional requirements

| Id | Requirement |
|---|---|
| PCN-FR-01 | Studio must have one Platform page, inside the [studio shell](studio-shell.md), at the route `/platform`, which lives at `/v2/platform` until the prefix drops. Only admins may open it. An editor must not see it in the navigation, and a request from an editor must be refused. |
| PCN-FR-02 | The page must show one tool card for each tool the deployment declares, with its name, purpose, address, sign-in kind, and health. |
| PCN-FR-03 | The deployment must declare its tools and their addresses through studio's configuration, not in studio's code, so that another deployment can list other tools. |
| PCN-FR-04 | Studio's server must check each tool's health by the rules in [Health of a tool](#health-of-a-tool), and the browser must never call a tool to check it. |
| PCN-FR-05 | The page must render before the health checks finish, and must show each tool's health as its check completes. |
| PCN-FR-06 | Grafana's card must link to the "Flink jobs" dashboard, and Flink's card must link to the landing page and to each job's UI. |
| PCN-FR-07 | Each card must say whether its tool is a single sign-on tool or an own-login tool. |
| PCN-FR-08 | The page must show quick links to the source repository, its CI runs, and the cloud console pages that hold the deployment's logins and its user pool, under the groups the deployment declares for them in studio's configuration, such as Code and Cloud. |
| PCN-FR-09 | The page and its health checks must never show or send a password, a token, or a secret. |
| PCN-FR-10 | Until cutover, the classic page at `/platform` must keep working unchanged. From cutover, `/platform` must redirect to `/v2/platform`, as the [studio shell's redirect map](studio-shell.md#cutover-and-redirects) says, until the prefix drops and `/platform` serves the page itself. |
| PCN-FR-11 | The page in the studio shell must meet PCN-FR-01 to PCN-FR-09 and PCN-FR-12 to PCN-FR-17. Classic removal deletes the classic page, and no other route renders the tool cards. |
| PCN-FR-12 | The page must open with the platform status by the table in [Health of a tool](#health-of-a-tool): the word NEEDS ATTENTION, OK, CHECKING, or NOTHING TO CHECK with an icon, the title, the count line, each tool that is `down`, `degraded`, or `unknown` with its reason, and the time of the oldest check shown, such as "Checked 20 s ago", or "Not checked" with no tools. **Re-check** must be disabled while a check runs and when there are no tools. Every health on the page must show as an icon with a word, never as color alone. |
| PCN-FR-13 | **Re-check** must run the checks again without reloading the page, within PCN-NFR-03, and must update the status, the cards, and the check time. |
| PCN-FR-14 | Flink's card must list each job with its state and a link to its UI. Argo CD's card must list each application that is not synced and healthy, with its sync status, its health status, and a link that opens that application in Argo CD. |
| PCN-FR-15 | When the deployment declares no tools, the page must say that no tools are configured and how an operator adds them, and must show no cards. |
| PCN-FR-16 | Flink's job list and Argo CD's application list must collapse behind a toggle that names the count, such as "Jobs (5)". The list must be open by default when its tool is `degraded` and closed otherwise, and the admin's toggle wins. In a `degraded` Flink card, the jobs that are not running come first. |
| PCN-FR-17 | A tool whose configuration is missing or invalid must show "Not known" in place of its sign-in kind and no tool links, beside the `unknown` health and the reason "not configured". |

## Non-functional requirements

| Id | Requirement |
|---|---|
| PCN-NFR-01 | The page must render within 1 second of the request, without waiting for health checks. |
| PCN-NFR-02 | Each health check must time out after 3 seconds. |
| PCN-NFR-03 | Studio must not call a tool for health more than once every 15 seconds, however many admins open the page. |

## Interfaces

| Interface | Use |
|---|---|
| Route `/v2/platform` | The page, until the prefix drops |
| Route `/platform` | The classic page until cutover. A redirect to `/v2/platform` from cutover. The page itself after the prefix drops. |
| Studio's configuration | The tool list: name, purpose, public address, internal health address, and sign-in kind. The quick links: label, address, note, and group. |
| Each tool's read-only API or health endpoint | Health checks from studio's server |

## Failure handling

- **A tool is down or slow.** Its card shows `down` or `unknown` with the reason. The rest of the page works.
- **A tool's configuration is missing or invalid.** Its card shows `unknown`, with the reason "not configured". The rest of the page works.
- **The identity provider is down.** Single sign-on links fail at the provider. The card's own-login note and the deployment's break-glass logins still apply.

## Acceptance criteria

- [ ] Given an admin, when they open `/platform`, then the page lists Argo CD, Grafana, and Flink with addresses and sign-in kinds within 1 second (PCN-FR-01, PCN-FR-02, PCN-NFR-01).
- [ ] Given an editor, when they request `/platform`, then studio refuses it and the navigation has no Platform entry (PCN-FR-01).
- [ ] Given `event-parse-job` restarting, when an admin opens the page, then Flink's card shows `degraded` and names the job (PCN-FR-04).
- [ ] Given Flink with `event-parse-job` restarting and Grafana up, when an admin opens the page, then the banner reads NEEDS ATTENTION with its icon, "1 tool needs attention: Flink · 1 job restarting", and "3 of 4 tools are up", links Flink, and shows when it checked. Given Flink and Grafana degraded, then the title reads "2 tools need attention". Given every tool up, then it reads OK and "All tools are up". Given Kafka browser `unknown` and every other tool up, then it reads OK and lists Kafka browser with its reason (PCN-FR-12).
- [ ] Given Flink and Kafka browser still checking out of four tools, then the banner reads CHECKING, "Checking 2 of 4 tools…", and **Re-check** is disabled. Given a deployment with no tools, then the banner reads NOTHING TO CHECK, "No tools to check", the check time reads "Not checked", and **Re-check** is disabled (PCN-FR-12).
- [ ] Given Flink `degraded` with `event-parse-job` restarting, then Flink's job list is open and `event-parse-job` is first. Given Flink `up`, then the list is closed behind "Jobs (5)". Given the admin closes the open list, then it stays closed until reload (PCN-FR-16).
- [ ] Given Kafka browser with no configuration, then its card shows Unknown, "not configured", and "Not known" as its sign-in kind, with no links (PCN-FR-17).
- [ ] Given a page checked 20 seconds ago, when the admin chooses **Re-check**, then the cards show Checking, then the new health, and the check time is under 1 s ago. Given two re-checks 5 seconds apart, then each tool is called once (PCN-FR-13, PCN-NFR-03).
- [ ] Given Argo CD with application `studio` `OutOfSync` and `Healthy`, and every other application synced and healthy, then Argo CD's card lists only `studio`, with both statuses and a link to `studio` in Argo CD. Given five Flink jobs, then Flink's card lists five jobs with their states (PCN-FR-14).
- [ ] Given quick links declared in the groups Code and Cloud, then the page shows them under those two headings (PCN-FR-08).
- [ ] Given a deployment that declares no tools, then the page says no tools are configured and shows no cards (PCN-FR-15).
- [ ] Given Grafana stopped, when an admin opens the page, then Grafana's card shows `down` and the other cards still load (PCN-FR-04, Failure handling).
- [ ] Given an admin signed in to studio, when they open a single sign-on tool's link, then the tool opens without a password prompt (PCN-FR-07, and the environment's single sign-on requirements).
- [ ] Given the page in the browser, when its network traffic is inspected, then no request goes to a tool's internal address and no secret appears (PCN-FR-04, PCN-FR-09).
- [ ] Given a release before cutover, when an admin opens `/platform`, then the classic page shows the tool cards as before. Given cutover deployed, `/platform` answers 307 to `/v2/platform`. Given the prefix dropped, `/platform` shows the page with no redirect (PCN-FR-10).
- [ ] Given an admin, when they open `/v2/platform`, then the tool cards show inside the v2 sidebar and top bar. Given an editor, `/v2/platform` shows the forbidden state. Given classic removal deployed, no route other than the shell's Platform page renders the tool cards (PCN-FR-01, PCN-FR-11).

## Related

- [Admin authentication](admin-authentication.md): who is an admin.
- [AWS Free Plan environment](../operations/aws-free-plan.md): the tools, their addresses, and their sign-in.
- [Known issues](../known-issues/features/platform-console.md).
