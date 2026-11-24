# Agents contract: allowed categories and payment outcomes

Behaviour of `contract/agents` as pinned by `category_policy_tests.rs` (#1247) and
`payment_outcome_tests.rs` (#1253).

## Allowed service categories (`SpendingPolicy.allowed_categories`)

- A new agent starts with an empty list.
- `update_policy` stores the list exactly as given (order kept, exact strings, no case folding) and
  **replaces** the previous list. It does not merge. Only the agent's owner may call it; anyone else
  gets `Unauthorized`, an unknown agent `AgentNotFound`, and nothing is stored.
- One update is one `("agents", "policy_updated", agent)` event with
  `(caller, max_per_tx, max_per_day, allowed_categories, min_score_to_earn)`.
- Changing the list keeps the spend already made in the current window and does not touch the agent
  record (score, counters, volume).
- **The list is not enforced by the payment path.** `check_spending_allowed` takes no category, and
  `record_payment` does not read the service's category. A payment to a service outside the list is
  still recorded. Enforcing it needs a category input on the check and a decision on what an empty
  list means (today it is the default, so "no restriction" is the only reading that keeps existing
  agents working). Tests under `the_list_is_not_enforced_by_the_payment_path` state this so that a
  future change is deliberate.

## Payment outcomes (`record_payment`)

Amounts are in stroops. Time is the ledger sequence number (`last_active`), not a timestamp.

Who may record: the caller must sign **and** be the provider the registry lists for `service_id`.
Not the agent's owner, the agent, the contract admin, or the provider of another service.

| Step | Check | Error |
|------|-------|-------|
| 1 | caller signed | host auth failure |
| 2 | `amount_stroops > 0` | `InvalidAmount` |
| 3 | registry set | `NotInitialized` |
| 4 | caller is the service's provider | `Unauthorized` |
| 5 | agent exists | `AgentNotFound` |
| 6 | policy exists | `PolicyNotFound` |

Because step 4 precedes step 5, a stranger cannot learn which agents exist.

A rejected outcome changes nothing: no score, counters, volume, daily spend or event. In particular a
stranger cannot record failures to lower an agent's score.

An authorized outcome changes:

- success: `total_payments`, `successful_payments`, `total_volume_stroops` and the policy's daily
  spend by the amount, `last_active`, and the score by `+10` (capped at 1000) when the score is at
  or above `min_score_to_earn`;
- failure: `total_payments`, `failed_payments`, `last_active`, and the score by `-25` (floored at 0);
  no volume or spend.

It emits one `("agents", "payment", agent)` event with
`(service_id, amount, success, old_score, new_score, caller)`.
