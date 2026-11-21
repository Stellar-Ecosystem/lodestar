//! Tests for the committed spending result event (#1236), the daily spending rollover
//! (#1242), and the safety and authority of agent list pagination (#1264, #1265).
//!
//! They use isolated contract fixtures and a stub registry, and move no real funds.

// The contract is `no_std`; the tests collect results into ordinary vectors.
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger as _},
    vec, Address, Env, FromVal, String, Symbol, Vec,
};

/// Stands in for the service registry: reports one configured provider for every service.
#[contract]
pub struct RegistryStub;

#[contractimpl]
impl RegistryStub {
    pub fn set_provider(env: Env, provider: Address) {
        env.storage().persistent().set(&0u64, &provider);
    }

    pub fn get_service(env: Env, id: u64) -> ServiceEntry {
        let provider: Address = env
            .storage()
            .persistent()
            .get(&0u64)
            .unwrap_or_else(|| Address::generate(&env));
        ServiceEntry {
            id,
            name: String::from_str(&env, "Stub Service"),
            description: String::from_str(&env, "Stub"),
            endpoint: String::from_str(&env, "http://stub.test"),
            price_usdc: String::from_str(&env, "1"),
            category: String::from_str(&env, "test"),
            provider,
            reputation: 100,
            active: true,
            registered_at: env.ledger().sequence() as u64,
        }
    }
}

/// Functions that panic with an error, instead of returning a Result, surface it from the
/// generated `try_` client as a generic contract error carrying the code.
fn contract_error(error: AgentError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(error as u32)
}

const FIRST_LEDGER: u32 = 100;
const SERVICE_ID: u64 = 7;
/// Default caps given to a new agent (see `register_agent`).
const DEFAULT_MAX_PER_TX: i128 = 10_000_000_000;
const DEFAULT_MAX_PER_DAY: i128 = 100_000_000_000;

/// `(service_id, amount, success, within_tx_cap, within_daily_cap, daily_spent_before,
/// daily_spent_after, max_per_tx, max_per_day, last_reset_ledger, window_reset)`
type Committed = (
    u64,
    i128,
    bool,
    bool,
    bool,
    i128,
    i128,
    i128,
    i128,
    u64,
    bool,
);

struct World<'a> {
    env: &'a Env,
    contract: Address,
    client: LodestarAgentsClient<'a>,
    provider: Address,
}

fn at_ledger(env: &Env, sequence: u32) {
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number = sequence;
        ledger.min_persistent_entry_ttl = TEST_MAX_TTL;
        ledger.min_temp_entry_ttl = TEST_MAX_TTL;
    });
}

/// A fresh contract and stub registry. When `sign_everything` is false no authorization is
/// mocked, so any call that needs a signature fails unless the test supplies one.
fn world(env: &Env, sign_everything: bool) -> World<'_> {
    if sign_everything {
        env.mock_all_auths();
    }
    at_ledger(env, FIRST_LEDGER);
    let registry = env.register(RegistryStub, ());
    let admin = Address::generate(env);
    let contract = env.register(LodestarAgents, (admin,));
    let client = LodestarAgentsClient::new(env, &contract);
    client.init(&registry);
    let provider = Address::generate(env);
    RegistryStubClient::new(env, &registry).set_provider(&provider);
    World {
        env,
        contract,
        client,
        provider,
    }
}

/// Registers an agent that owns itself and returns `(agent, owner)`.
fn register(world: &World<'_>, label: &str) -> (Address, Address) {
    let agent = Address::generate(world.env);
    let owner = Address::generate(world.env);
    world.client.register_agent(
        &agent,
        &String::from_str(world.env, label),
        &String::from_str(world.env, "test agent"),
        &owner,
    );
    (agent, owner)
}

/// Gives the agent small caps so limits are easy to reach.
fn set_caps(world: &World<'_>, agent: &Address, owner: &Address, per_tx: i128, per_day: i128) {
    world
        .client
        .update_policy(agent, &per_tx, &per_day, &vec![world.env], &0, owner);
}

fn pay(world: &World<'_>, agent: &Address, amount: i128, success: bool) {
    world
        .client
        .record_payment(agent, &SERVICE_ID, &amount, &success, &world.provider);
}

fn stored_policy(world: &World<'_>, agent: &Address) -> SpendingPolicy {
    world.env.as_contract(&world.contract, || {
        world
            .env
            .storage()
            .persistent()
            .get(&DataKey::Policy(agent.clone()))
            .expect("policy")
    })
}

fn stored_agent(world: &World<'_>, agent: &Address) -> AgentEntry {
    world.env.as_contract(&world.contract, || {
        world
            .env
            .storage()
            .persistent()
            .get(&DataKey::Agent(agent.clone()))
            .expect("agent")
    })
}

/// The events of the most recent invocation, as `(action, agent, data)`.
fn last_events(world: &World<'_>) -> std::vec::Vec<(Symbol, Address, soroban_sdk::Val)> {
    let env = world.env;
    let all = env.events().all();
    let mut out = std::vec::Vec::new();
    for i in 0..all.len() {
        let (_contract, topics, data) = all.get(i).unwrap();
        let (domain, action, who) = <(Symbol, Symbol, Address)>::from_val(env, &topics.to_val());
        assert_eq!(domain, Symbol::new(env, "agents"));
        out.push((action, who, data));
    }
    out
}

fn committed(world: &World<'_>) -> Committed {
    let events = last_events(world);
    let (_, _, data) = events
        .iter()
        .find(|(action, _, _)| *action == Symbol::new(world.env, "spending_committed"))
        .expect("a spending_committed event");
    Committed::from_val(world.env, data)
}

// ───────────────────────────── #1236: committed spending result ─────────────────────────────

#[test]
fn a_recorded_payment_emits_payment_then_spending_committed_in_that_order() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");

    pay(&world, &agent, 500, true);

    let events = last_events(&world);
    let actions: std::vec::Vec<Symbol> =
        events.iter().map(|(action, _, _)| action.clone()).collect();
    assert_eq!(
        actions,
        std::vec![
            Symbol::new(&env, "payment"),
            Symbol::new(&env, "spending_committed")
        ]
    );
    // Both are about the same agent, so a consumer can join them on the third topic.
    assert!(events.iter().all(|(_, who, _)| *who == agent));
}

#[test]
fn the_committed_event_traces_one_payment_to_the_caps_it_was_judged_against() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");

    pay(&world, &agent, 500, true);

    assert_eq!(
        committed(&world),
        (
            SERVICE_ID,
            500,
            true,
            true,
            true,
            0,
            500,
            DEFAULT_MAX_PER_TX,
            DEFAULT_MAX_PER_DAY,
            FIRST_LEDGER as u64,
            false
        )
    );
}

#[test]
fn a_payment_exactly_at_the_per_transaction_cap_is_within_it() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 10_000);

    pay(&world, &agent, 1_000, true);

    let event = committed(&world);
    assert!(event.3, "exactly at the cap is within it");
    assert!(event.4);
}

#[test]
fn a_payment_one_over_the_per_transaction_cap_is_flagged_but_still_recorded() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 10_000);

    pay(&world, &agent, 1_001, true);

    let event = committed(&world);
    assert!(!event.3, "one over the cap is outside it");
    // record_payment records an outcome; refusing is check_spending_allowed's job, and the
    // event says what happened instead of hiding it.
    assert_eq!(event.6, 1_001);
    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, 1_001);
    assert!(!world.client.check_spending_allowed(&agent, &1_001));
}

#[test]
fn a_payment_that_takes_the_day_over_its_cap_is_flagged() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 1_500);

    pay(&world, &agent, 1_000, true);
    assert!(committed(&world).4, "1000 of 1500 is within the daily cap");

    pay(&world, &agent, 600, true);
    let event = committed(&world);
    assert!(event.3, "600 is within the per-transaction cap");
    assert!(!event.4, "1600 of 1500 is outside the daily cap");
    assert_eq!((event.5, event.6), (1_000, 1_600));
}

#[test]
fn a_failed_payment_does_not_add_to_the_spent_amount() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 10_000);
    pay(&world, &agent, 400, true);

    pay(&world, &agent, 300, false);

    let event = committed(&world);
    assert!(!event.2, "reported as failed");
    assert_eq!(
        (event.5, event.6),
        (400, 400),
        "spent is unchanged by a failure"
    );
    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, 400);
}

#[test]
fn spent_amounts_chain_across_payments_and_always_match_storage() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 10_000);

    let mut previous_after = 0;
    for (amount, success) in [
        (100, true),
        (250, true),
        (75, false),
        (300, true),
        (10, true),
    ] {
        pay(&world, &agent, amount, success);
        let event = committed(&world);

        assert_eq!(
            event.5, previous_after,
            "before is the previous after: no drift"
        );
        assert_eq!(
            event.6,
            stored_policy(&world, &agent).daily_spent_stroops,
            "after is exactly what is stored"
        );
        previous_after = event.6;
    }
    assert_eq!(previous_after, 100 + 250 + 300 + 10);
}

#[test]
fn the_first_payment_of_a_new_window_says_it_opened_the_window() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    set_caps(&world, &agent, &owner, 1_000, 10_000);
    pay(&world, &agent, 600, true);

    let new_window = FIRST_LEDGER + DAY_LEDGERS as u32;
    at_ledger(&env, new_window);
    pay(&world, &agent, 200, true);

    let event = committed(&world);
    assert!(event.10, "window_reset");
    assert_eq!(
        (event.5, event.6),
        (0, 200),
        "yesterday's spend is not carried over"
    );
    assert_eq!(event.9, new_window as u64);

    pay(&world, &agent, 50, true);
    let next = committed(&world);
    assert!(
        !next.10,
        "the second payment of the window does not reset it again"
    );
    assert_eq!((next.5, next.6), (200, 250));
}

#[test]
fn a_rejected_payment_commits_nothing_and_emits_no_events() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");
    let before_policy = stored_policy(&world, &agent);
    let before_agent = stored_agent(&world, &agent);

    let not_the_provider = Address::generate(&env);
    let result =
        world
            .client
            .try_record_payment(&agent, &SERVICE_ID, &500, &true, &not_the_provider);

    assert_eq!(result, Err(Ok(AgentError::Unauthorized)));
    assert_eq!(last_events(&world).len(), 0);
    assert_eq!(
        stored_policy(&world, &agent).daily_spent_stroops,
        before_policy.daily_spent_stroops
    );
    assert_eq!(stored_agent(&world, &agent).score, before_agent.score);
    assert_eq!(stored_agent(&world, &agent).total_payments, 0);
}

#[test]
fn a_non_positive_amount_is_rejected_without_events() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");

    for amount in [0i128, -5] {
        let result =
            world
                .client
                .try_record_payment(&agent, &SERVICE_ID, &amount, &true, &world.provider);
        assert_eq!(result, Err(Ok(AgentError::InvalidAmount)));
        assert_eq!(last_events(&world).len(), 0);
    }
}

// ───────────────────────────── #1242: daily spending rollover ─────────────────────────────

/// One agent with `per_tx` and `per_day` caps, registered at `FIRST_LEDGER`.
fn capped(world: &World<'_>, per_tx: i128, per_day: i128) -> Address {
    let (agent, owner) = register(world, "capped");
    set_caps(world, &agent, &owner, per_tx, per_day);
    agent
}

#[test]
fn a_payment_on_the_first_ledger_of_a_new_window_starts_a_fresh_total() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);
    pay(&world, &agent, 900, true);
    assert!(
        !world.client.check_spending_allowed(&agent, &200),
        "900 + 200 is over 1000"
    );

    let first_of_new_window = FIRST_LEDGER + DAY_LEDGERS as u32;
    at_ledger(&env, first_of_new_window);

    assert!(
        world.client.check_spending_allowed(&agent, &600),
        "a new window has room again"
    );
    pay(&world, &agent, 600, true);

    let policy = stored_policy(&world, &agent);
    assert_eq!(
        policy.daily_spent_stroops, 600,
        "not 1500: yesterday's 900 was cleared"
    );
    assert_eq!(policy.last_reset_ledger, first_of_new_window as u64);
}

#[test]
fn one_ledger_before_the_reset_the_old_total_still_counts() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);
    pay(&world, &agent, 900, true);

    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32 - 1);

    assert!(!world.client.check_spending_allowed(&agent, &600));
    pay(&world, &agent, 50, true);
    let event = committed(&world);
    assert!(!event.10, "still the old window");
    assert_eq!((event.5, event.6), (900, 950));
}

#[test]
fn two_payments_in_the_same_ledger_after_the_reset_reset_the_window_once() {
    // The nearest a single-threaded contract gets to "concurrent": two payments that both
    // see an expired window within one ledger.
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);
    pay(&world, &agent, 900, true);

    let reset_ledger = FIRST_LEDGER + DAY_LEDGERS as u32;
    at_ledger(&env, reset_ledger);

    pay(&world, &agent, 400, true);
    let first = committed(&world);
    pay(&world, &agent, 400, true);
    let second = committed(&world);

    assert!(first.10, "the first payment opens the window");
    assert!(
        !second.10,
        "the second sees the window already opened and does not reset again"
    );
    assert_eq!((first.5, first.6), (0, 400));
    assert_eq!(
        (second.5, second.6),
        (400, 800),
        "no duplicate effect: exactly 400 + 400"
    );
    let policy = stored_policy(&world, &agent);
    assert_eq!(policy.daily_spent_stroops, 800);
    assert_eq!(policy.last_reset_ledger, reset_ledger as u64);
}

#[test]
fn the_total_stays_bounded_after_two_payments_cross_the_reset() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);
    pay(&world, &agent, 900, true);

    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32);
    pay(&world, &agent, 400, true);
    pay(&world, &agent, 400, true);

    // 800 of 1000 in the new window: 200 more fits, 201 does not.
    assert!(world.client.check_spending_allowed(&agent, &200));
    assert!(!world.client.check_spending_allowed(&agent, &201));
}

#[test]
fn a_payment_in_the_last_ledger_of_a_window_counts_in_that_window_not_the_next() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);

    let last_of_old = FIRST_LEDGER + DAY_LEDGERS as u32 - 1;
    at_ledger(&env, last_of_old);
    pay(&world, &agent, 700, true);
    let old = committed(&world);
    assert!(!old.10);
    assert_eq!(
        old.9, FIRST_LEDGER as u64,
        "still the window that began at registration"
    );

    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32);
    pay(&world, &agent, 700, true);
    let new = committed(&world);

    assert!(new.10, "the next ledger opens the new window");
    assert_eq!(
        (new.5, new.6),
        (0, 700),
        "the 700 from the last ledger is not carried over"
    );
}

#[test]
fn reading_the_allowance_does_not_change_storage_even_across_a_reset() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 1_000);
    pay(&world, &agent, 900, true);
    let stored_before = stored_policy(&world, &agent);

    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32 + 3);
    let _ = world.client.check_spending_allowed(&agent, &100);
    let _ = world.client.get_policy(&agent);

    let stored_after = stored_policy(&world, &agent);
    assert_eq!(
        stored_after.daily_spent_stroops,
        stored_before.daily_spent_stroops
    );
    assert_eq!(
        stored_after.last_reset_ledger,
        stored_before.last_reset_ledger
    );
}

#[test]
fn a_payment_on_the_reset_ledger_needs_the_provider_to_sign() {
    let env = Env::default();
    let world = world(&env, false);
    let (agent, owner) = register(&world, "a");
    env.mock_all_auths();
    set_caps(&world, &agent, &owner, 1_000, 1_000);
    env.set_auths(&[]);
    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32);
    let before = stored_policy(&world, &agent);

    let result = world
        .client
        .try_record_payment(&agent, &SERVICE_ID, &100, &true, &world.provider);

    assert!(result.is_err(), "an unsigned payment is refused");
    let after = stored_policy(&world, &agent);
    assert_eq!(after.daily_spent_stroops, before.daily_spent_stroops);
    assert_eq!(
        after.last_reset_ledger, before.last_reset_ledger,
        "refused payments do not reset the window"
    );
}

#[test]
fn a_single_payment_has_exactly_one_effect_on_the_agent() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = capped(&world, 1_000, 10_000);
    at_ledger(&env, FIRST_LEDGER + DAY_LEDGERS as u32);

    pay(&world, &agent, 300, true);

    let entry = stored_agent(&world, &agent);
    assert_eq!(entry.total_payments, 1);
    assert_eq!(entry.successful_payments, 1);
    assert_eq!(entry.total_volume_stroops, 300);
    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, 300);
}

// ───────────────────────── #1264: pagination stays safe, including on failure ─────────────────────────

fn page(world: &World<'_>, page: u32, size: u32) -> std::vec::Vec<Address> {
    let entries: Vec<AgentEntry> = world.client.list_agents_page(&page, &size);
    entries.iter().map(|entry| entry.address).collect()
}

fn register_many(world: &World<'_>, count: usize) -> std::vec::Vec<Address> {
    (0..count)
        .map(|i| register(world, &std::format!("agent-{i}")).0)
        .collect()
}

#[test]
fn pages_partition_the_list_in_registration_order() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 5);

    assert_eq!(page(&world, 0, 2), agents[0..2]);
    assert_eq!(page(&world, 1, 2), agents[2..4]);
    assert_eq!(
        page(&world, 2, 2),
        agents[4..5],
        "the final page is partial"
    );
    assert!(page(&world, 3, 2).is_empty(), "past the end is empty");
}

#[test]
fn a_page_past_the_end_or_with_absurd_arguments_is_empty_and_does_not_panic() {
    let env = Env::default();
    let world = world(&env, true);
    register_many(&world, 3);

    assert!(page(&world, 100, 10).is_empty());
    assert!(page(&world, u32::MAX, u32::MAX).is_empty());
    assert!(
        page(&world, 0, 0).is_empty(),
        "a zero page size returns nothing"
    );
    assert_eq!(
        page(&world, 0, u32::MAX).len(),
        3,
        "a huge page size returns everything"
    );
}

#[test]
fn an_empty_registry_pages_as_empty() {
    let env = Env::default();
    let world = world(&env, true);

    assert!(page(&world, 0, 10).is_empty());
    assert_eq!(world.client.get_agent_count(), 0);
}

#[test]
fn an_agent_registered_during_traversal_shows_up_at_the_end_without_shifting_earlier_pages() {
    let env = Env::default();
    let world = world(&env, true);
    let mut agents = register_many(&world, 4);

    let first = page(&world, 0, 2);
    // A new agent registers between page fetches, before the next page is read.
    agents.push(register(&world, "late").0);
    let second = page(&world, 1, 2);
    let third = page(&world, 2, 2);

    assert_eq!(first, agents[0..2]);
    assert_eq!(
        second,
        agents[2..4],
        "page 1 is the same as it would have been"
    );
    assert_eq!(third, agents[4..5], "the new agent is on the next page");
    assert_eq!(
        page(&world, 0, 2),
        first,
        "re-reading an earlier page gives the same agents"
    );
}

#[test]
fn a_full_traversal_sees_each_agent_exactly_once_while_agents_keep_registering() {
    let env = Env::default();
    let world = world(&env, true);
    let mut registered = register_many(&world, 3);

    let mut seen: std::vec::Vec<Address> = std::vec::Vec::new();
    let mut next_page = 0;
    loop {
        let batch = page(&world, next_page, 2);
        if batch.is_empty() {
            break;
        }
        seen.extend(batch);
        next_page += 1;
        // Two more agents join after each page is read, up to a cap, before the next one.
        if registered.len() < 9 {
            registered.push(register(&world, "joiner").0);
            registered.push(register(&world, "joiner").0);
        }
    }

    assert_eq!(
        seen, registered,
        "no agent skipped, none seen twice, order preserved"
    );
    assert_eq!(world.client.get_agent_count(), registered.len() as u64);
}

#[test]
fn an_agent_registered_after_the_final_partial_page_appears_on_a_following_fetch() {
    let env = Env::default();
    let world = world(&env, true);
    let mut agents = register_many(&world, 3);
    assert_eq!(page(&world, 1, 2), agents[2..3], "final partial page");
    assert!(page(&world, 2, 2).is_empty());

    agents.push(register(&world, "after").0);

    assert_eq!(
        page(&world, 1, 2),
        agents[2..4],
        "the partial page filled up"
    );
    assert!(page(&world, 2, 2).is_empty());
}

#[test]
fn list_agents_agrees_with_the_first_page() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 4);

    let listed: Vec<AgentEntry> = world.client.list_agents(&3);

    assert_eq!(
        listed
            .iter()
            .map(|entry| entry.address)
            .collect::<std::vec::Vec<_>>(),
        agents[0..3]
    );
}

#[test]
fn a_failed_registration_during_traversal_changes_nothing() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 3);
    let first = page(&world, 0, 2);
    let count_before = world.client.get_agent_count();

    // Registering the same address again must fail and leave every list untouched.
    let result = world.client.try_register_agent(
        &agents[1],
        &String::from_str(&env, "impostor"),
        &String::from_str(&env, "second attempt"),
        &Address::generate(&env),
    );

    assert_eq!(
        result,
        Err(Ok(contract_error(AgentError::AgentAlreadyRegistered)))
    );
    assert_eq!(world.client.get_agent_count(), count_before);
    assert_eq!(page(&world, 0, 2), first);
    assert_eq!(page(&world, 1, 2), agents[2..3]);
    assert_eq!(
        stored_agent(&world, &agents[1]).name,
        String::from_str(&env, "agent-1")
    );
}

#[test]
fn a_failed_payment_during_traversal_leaves_listed_scores_and_allowance_alone() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 3);
    let scores_before: std::vec::Vec<i32> = agents
        .iter()
        .map(|a| stored_agent(&world, a).score)
        .collect();
    let spent_before: std::vec::Vec<i128> = agents
        .iter()
        .map(|a| stored_policy(&world, a).daily_spent_stroops)
        .collect();

    let not_the_provider = Address::generate(&env);
    let result =
        world
            .client
            .try_record_payment(&agents[0], &SERVICE_ID, &1_000, &true, &not_the_provider);

    assert!(result.is_err());
    let scores_after: std::vec::Vec<i32> = agents
        .iter()
        .map(|a| stored_agent(&world, a).score)
        .collect();
    let spent_after: std::vec::Vec<i128> = agents
        .iter()
        .map(|a| stored_policy(&world, a).daily_spent_stroops)
        .collect();
    assert_eq!(scores_after, scores_before);
    assert_eq!(spent_after, spent_before);
}

#[test]
fn a_payment_that_overflows_the_daily_total_fails_whole_and_spends_no_allowance() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");
    // Put the daily total one stroop below the limit of the type.
    env.as_contract(&world.contract, || {
        let key = DataKey::Policy(agent.clone());
        let mut policy: SpendingPolicy = env.storage().persistent().get(&key).unwrap();
        policy.daily_spent_stroops = i128::MAX - 1;
        env.storage().persistent().set(&key, &policy);
    });
    let agent_before = stored_agent(&world, &agent);

    let result = world
        .client
        .try_record_payment(&agent, &SERVICE_ID, &10, &true, &world.provider);

    assert_eq!(result, Err(Ok(AgentError::ArithmeticOverflow)));
    // The agent record is written before the daily total is updated, so this checks that
    // the failure rolls that write back too instead of leaving a half-applied payment.
    let agent_after = stored_agent(&world, &agent);
    assert_eq!(agent_after.score, agent_before.score);
    assert_eq!(agent_after.total_payments, agent_before.total_payments);
    assert_eq!(
        agent_after.successful_payments,
        agent_before.successful_payments
    );
    assert_eq!(
        stored_policy(&world, &agent).daily_spent_stroops,
        i128::MAX - 1
    );
    assert_eq!(last_events(&world).len(), 0);
}

// ───────────────────────── #1265: authority around pagination ─────────────────────────

#[test]
fn listing_agents_needs_no_signature_and_changes_nothing() {
    let env = Env::default();
    let world = world(&env, false); // no authorization mocked at all
    let agents = register_many(&world, 3);
    let before: std::vec::Vec<(i32, i128, u64)> = agents
        .iter()
        .map(|a| {
            let policy = stored_policy(&world, a);
            (
                stored_agent(&world, a).score,
                policy.daily_spent_stroops,
                policy.last_reset_ledger,
            )
        })
        .collect();

    // An empty page, a full page and the final partial page, all unsigned.
    assert!(page(&world, 5, 2).is_empty());
    assert_eq!(page(&world, 0, 2).len(), 2);
    assert_eq!(page(&world, 1, 2).len(), 1);

    let after: std::vec::Vec<(i32, i128, u64)> = agents
        .iter()
        .map(|a| {
            let policy = stored_policy(&world, a);
            (
                stored_agent(&world, a).score,
                policy.daily_spent_stroops,
                policy.last_reset_ledger,
            )
        })
        .collect();
    assert_eq!(after, before, "pagination is read-only");
}

#[test]
fn a_signed_caller_who_is_not_the_owner_cannot_change_the_policy_mid_traversal() {
    let env = Env::default();
    let world = world(&env, true); // everyone can sign: the role check is what must stop them
    let agents = register_many(&world, 3);
    let _first = page(&world, 0, 2);
    let attacker = Address::generate(&env);
    let policy_before = stored_policy(&world, &agents[0]);

    let result = world.client.try_update_policy(
        &agents[0],
        &i128::MAX,
        &i128::MAX,
        &vec![&env],
        &0,
        &attacker,
    );

    assert_eq!(result, Err(Ok(contract_error(AgentError::Unauthorized))));
    let policy_after = stored_policy(&world, &agents[0]);
    assert_eq!(
        policy_after.max_per_tx_stroops,
        policy_before.max_per_tx_stroops
    );
    assert_eq!(
        policy_after.max_per_day_stroops,
        policy_before.max_per_day_stroops
    );
}

#[test]
fn the_owner_without_a_signature_cannot_change_the_policy() {
    let env = Env::default();
    let world = world(&env, false);
    let (agent, owner) = register(&world, "a");
    let before = stored_policy(&world, &agent);

    let result = world
        .client
        .try_update_policy(&agent, &1, &1, &vec![&env], &0, &owner);

    assert!(
        result.is_err(),
        "naming the owner is not enough, the owner has to sign"
    );
    assert_eq!(
        stored_policy(&world, &agent).max_per_tx_stroops,
        before.max_per_tx_stroops
    );
}

#[test]
fn an_address_that_is_not_the_configured_provider_cannot_move_a_score() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 3);
    let scores: std::vec::Vec<i32> = agents
        .iter()
        .map(|a| stored_agent(&world, a).score)
        .collect();
    let impostor = Address::generate(&env);

    for success in [true, false] {
        let result =
            world
                .client
                .try_record_payment(&agents[1], &SERVICE_ID, &100, &success, &impostor);
        assert_eq!(result, Err(Ok(AgentError::Unauthorized)));
    }

    let after: std::vec::Vec<i32> = agents
        .iter()
        .map(|a| stored_agent(&world, a).score)
        .collect();
    assert_eq!(after, scores);
}

#[test]
fn the_configured_provider_without_a_signature_cannot_move_a_score() {
    let env = Env::default();
    let world = world(&env, false);
    let (agent, _owner) = register(&world, "a");
    let score = stored_agent(&world, &agent).score;

    let result = world
        .client
        .try_record_payment(&agent, &SERVICE_ID, &100, &true, &world.provider);

    assert!(
        result.is_err(),
        "the provider has to sign, not just be named"
    );
    assert_eq!(stored_agent(&world, &agent).score, score);
}

#[test]
fn only_the_admin_can_flag_an_agent_and_a_new_registration_does_not_change_that() {
    let env = Env::default();
    let world = world(&env, true);
    let agents = register_many(&world, 2);
    let attacker = Address::generate(&env);

    let result =
        world
            .client
            .try_flag_agent(&agents[0], &String::from_str(&env, "spam"), &attacker);

    assert!(result.is_err());
    assert!(!stored_agent(&world, &agents[0]).flagged);
}

#[test]
fn registering_a_new_agent_leaves_existing_policies_and_scores_untouched() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "existing");
    set_caps(&world, &agent, &owner, 1_000, 5_000);
    pay(&world, &agent, 300, true);
    let policy_before = stored_policy(&world, &agent);
    let agent_before = stored_agent(&world, &agent);

    register(&world, "newcomer");

    let policy_after = stored_policy(&world, &agent);
    let agent_after = stored_agent(&world, &agent);
    assert_eq!(
        policy_after.max_per_tx_stroops,
        policy_before.max_per_tx_stroops
    );
    assert_eq!(
        policy_after.daily_spent_stroops,
        policy_before.daily_spent_stroops
    );
    assert_eq!(agent_after.score, agent_before.score);
    assert_eq!(agent_after.total_payments, agent_before.total_payments);
}

#[test]
fn registration_is_unsigned_by_design_and_that_is_the_current_behaviour() {
    // Characterisation, not an endorsement: `register_agent` carries no `require_auth` so
    // the backend can register on behalf of any wallet (see the comment on the function).
    // Anyone can therefore register any address and name any owner. This test pins that so
    // a change to it is deliberate and visible.
    let env = Env::default();
    let world = world(&env, false); // nothing is signed

    let (agent, owner) = register(&world, "unsigned");

    assert_eq!(stored_agent(&world, &agent).owner, owner);
    assert_eq!(page(&world, 0, 10), std::vec![agent]);
}
