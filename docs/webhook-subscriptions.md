# Webhook subscriptions for bot commands and PR Q&A

OpenCodra reviews pull requests automatically from the pull-request events it already
subscribes to. The **in-PR bot commands** (`review`, `review rest`, `pause`, `resume`,
`help`, `reject`) and **PR Q&A** additionally require your GitHub App / Bitbucket workspace
to deliver **comment** events. Subscribing to these events is an external, one-time setup
step in the provider UI — adding the event name in OpenCodra's code is necessary but **not**
sufficient. Until you subscribe, comment-triggered commands and reply-under-finding `reject`
never reach OpenCodra.

Signature verification and delivery idempotency are unchanged: every comment delivery is
HMAC-verified and de-duplicated exactly like the existing pull-request events. An unsigned or
replayed comment delivery is rejected/ignored with no new bypass.

## GitHub App

The GitHub App must be subscribed to two comment events:

| Event | Why |
|-------|-----|
| **Issue comment** | Top-level PR comments — `@codra-app review`, `pause`, Q&A, etc. |
| **Pull request review comment** | Replies left **under an inline review finding** — the `reject` flow links the dismissal to the finding via `in_reply_to_id`. |

To subscribe:

1. Open your GitHub App settings: **GitHub → Settings → Developer settings → GitHub Apps → (your app) → Permissions & events**.
2. Under **Subscribe to events**, enable:
   - **Issue comment**
   - **Pull request review comment**
3. Save. GitHub may require you to review/accept the updated permissions on each installation
   (re-onboard or accept the permission prompt) before new event deliveries begin.
4. Confirm delivery under **Advanced → Recent Deliveries** after posting a test comment.

> Reply-under-finding `reject` uses the **Pull request review comment** event. A top-level
> `@codra-app reject <finding-ref>` remains a documented fallback, but the inline reply is the
> primary path and requires this subscription.

## Bitbucket Cloud

The workspace/repository webhook must include the pull-request comment event:

| Event | Why |
|-------|-----|
| **Pull Request → Comment created** (`pullrequest:comment_created`) | All bot commands, Q&A, and reply-under-finding `reject` (linked via `comment.parent.id`) on Bitbucket. |

To subscribe:

1. Open the webhook settings: **Bitbucket → Repository (or Workspace) settings → Webhooks → (your OpenCodra webhook)**, or re-run onboarding.
2. Under **Triggers → Pull Request**, enable **Comment created**.
3. Save. Post a test comment and confirm the delivery under the webhook's **View requests**.

## Enabling the features

Subscribing only makes the events reach OpenCodra. The commands and Q&A features themselves
are gated per-repository configuration toggles
(`review.interactive.commands.enabled` / `review.interactive.qa.enabled`). With both toggles
off, comment deliveries are ignored and every existing auto-review path stays byte-identical.
On Bitbucket, authorization for state-changing commands is driven by the per-repo
`review.interactive.commands.bitbucket_allowed_account_ids` allow-list (see the dashboard /
repo configuration).
