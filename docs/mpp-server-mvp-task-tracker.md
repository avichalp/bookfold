# BookFold MPP Server MVP Build Notes

This is a short public record of the MVP work.

The long internal task log was removed.
Git history keeps the full change trail.

## Window

- Start: 2026-04-15
- Finish: 2026-04-19

## Outcome

Status: shipped

```text
upload -> quote -> pay -> run -> poll -> result
```

## Delivered

| Area | Result |
|---|---|
| SDK | frozen summary plans, token counting, deterministic pricing |
| Payments | shared payment types, inbound MPP charge, outbound OpenAI MPP spend |
| Server | uploads, quotes, paid job create, job read, OpenAPI, health |
| Jobs | Vercel Workflow execution, Blob artifacts, Turso state |
| Recovery | requeue and restart-safe job handling |
| Docs | API examples, deploy guide, rate-limit notes |
| Deploy | preview and production deploys completed |

## Checks

- `bun run verify`
- `bun run build:vercel`
- `bun run smoke:hosted` when deploy env is present

## Source of truth

Use these for current behavior:

- [API](./mpp-server-api.md)
- [Deploy](./mpp-server-deploy.md)
- [Production readiness](./mpp-server-production-readiness-plan.md)

Use git history for the detailed build log.
