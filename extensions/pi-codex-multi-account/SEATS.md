# ChatGPT Business seats — runbook

Workspace **"xxx's Workspace"** (ChatGPT Business, id `fa24dce4-60d5-4341-8f34-2ef06c8c314b`), created **2026-11-24**.

| Fact | Value |
|---|---|
| Seats | 5 Standard — **1 assigned** (adamnadrac@gmail.com, Owner), **4 available** |
| Premium seats | 0 |
| Free period | "Up to 5 Standard seats free for **1 month**" — cycle Nov 24 → Dec 24 |
| After the cycle | 5 × £18/mo = **£90/mo** billed to the Mastercard on file |
| Bonus | Workspaces created Nov 23–30 2026 get **2× weekly Codex/Work usage through Dec 31** (this one qualifies) |
| Per-seat limit | Standard seats have a **5-hour window** limit; Premium seats have none |
| Billing rule | *"At the start of each billing cycle, you are charged for all standard and premium seats in your workspace, whether or not they've been assigned."* |

## The one thing to understand

**A seat is a member, and a member is one login email.** One login cannot hold
several seats, so each extra seat needs its own email identity that you control,
invited into the workspace and accepted. Each accepted member then has its own
included Codex allowance — that is the multiplier.

## Adding a member

1. Admin console → **Members** → **Invite member**.
2. Enter one email per row, **Seat type = Standard** → **Send invites**
   (or *Upload CSV* — `email,role,seat type`, e.g. `x@alias.dev,member,standard`).
3. The invitee opens the email → lands on chatgpt.com onboarding → creates the
   account with that exact email → joins the workspace. Accounts are created
   automatically if the invitee has none.
4. Track progress under **Members → Pending invites**. Users should reach 5/5.

Watch out for **Auto-approve join requests**: it is currently ON, and it lets
people join even when the workspace is full — *"You will be billed immediately
for any additional seats needed."* Turn it off once you are at 5 seats.

## Where the identities come from

| Option | Cost | Notes |
|---|---|---|
| Gmail `+tags` (`adamnadrac+s1@gmail.com`) | free | Distinct addresses, one inbox. Risk: OpenAI may treat `+tag` addresses as one mailbox — **test one first** before doing all four |
| Free alias service (SimpleLogin / Addy / Proton) | free tier | Cleanest separation from Google, separate domains |
| Real secondary mailboxes | ~free | Fewest surprises, most signup friction |

Phone verification is *not* generally required to create a ChatGPT account, but
Codex sign-in may ask for it. A phone number can only be used for phone
verification up to **3 times**, so expect to need a second number if all four
new accounts ask.

**Test one alias first**: invite `adamnadrac+s1@gmail.com`, complete the
onboarding, and confirm the Members list shows a *separate* member (not a merge
into the existing one). If OpenAI canonicalises the alias, switch to an alias
service.

## Wiring each seat into your tools

Every accepted seat is just another ChatGPT login.

**pi** — one provider slot per account, already registered by the
`pi-codex-multi-account` extension:

```
/login codex-seat2        # browser or device-code login, pick the Business workspace
/codex-accounts           # shows which slots are signed in, with email + plan
```

**Codex CLI** — one `CODEX_HOME` per account:

```
cx login seat2            # sign in account "seat2"
cx seat2                  # run codex as seat2
cx list                   # all accounts, their email, plan and account id
```

Inside Codex, `/usage` shows that account's remaining allowance.

## Policy note (read once, then decide)

OpenAI's own help centre for Business seats: *"Anyone you invite should be an
intended, ongoing member of your team. Business workspaces are designed for
consistent, collaborative use within an organization. Misuse of seat assignments
in violation of the Services Agreement may lead to workspace deactivation or
account suspension."*

The Services Agreement (§3.2) also limits each Business seat to a single end
user, and the consumer Terms of Use forbid sharing credentials and circumventing
rate limits. Holding several accounts yourself, one per seat, is not the shape
the seats were sold in. Multiple accounts on your own plan are fine — OpenAI's
help centre explicitly allows additional accounts for "different billing or
subscription plans".

## The 24 December cliff

Chosen action: **cancel the plan before the cycle ends**. Cancelling keeps full
access until the end of the current period (24 Dec), then nothing is charged.

Alternative if you want the full 2× boost window (through **31 Dec**):
**Workspace settings → Members → Manage seats → reduce to 1 seat** before 24 Dec.
Reductions take effect at the next cycle start, so that costs £18/mo but keeps
the workspace alive through the bonus period.

A desktop reminder fires on **23 Dec 09:00**
(`chatgpt-business-seat-cliff.timer`).
