//! Tests for the committed registration event (#1231), authority around the per-transaction
//! cap (#1235) and the committed policy-change event for allowed categories (#1246).
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

const FIRST_LEDGER: u32 = 100;
const SERVICE_ID: u64 = 7;
const CAP: i128 = 1_000;
const DAILY: i128 = 10_000;

/// Panicking functions surface their error from the generated `try_` client as a generic
/// contract error carrying the code.
fn contract_error(error: AgentError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(error as u32)
}

struct World<'a> {
    env: &'a Env,
    admin: Address,
    contract: Address,
    client: LodestarAgentsClient<'a>,
    provider: Address,
}

/// A fresh contract and stub registry. When `sign_everything` is false no authorization is
/// mocked, so any call that needs a signature fails unless the test supplies one.
fn world(env: &Env, sign_everything: bool) -> World<'_> {
    if sign_everything {
        env.mock_all_auths();
    }
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number = FIRST_LEDGER;
        ledger.min_persistent_entry_ttl = TEST_MAX_TTL;
        ledger.min_temp_entry_ttl = TEST_MAX_TTL;
    });
    let registry = env.register(RegistryStub, ());
    let admin = Address::generate(env);
    let contract = env.register(LodestarAgents, (admin.clone(),));
    let client = LodestarAgentsClient::new(env, &contract);
    client.init(&registry);
    let provider = Address::generate(env);
    RegistryStubClient::new(env, &registry).set_provider(&provider);
    World {
        env,
        admin,
        contract,
        client,
        provider,
    }
}

fn text(world: &World<'_>, value: &str) -> String {
    String::from_str(world.env, value)
}

/// Registers an agent and returns `(agent, owner)`; the owner is a different address.
fn register(world: &World<'_>, label: &str) -> (Address, Address) {
    let agent = Address::generate(world.env);
    let owner = Address::generate(world.env);
    world.client.register_agent(
        &agent,
        &text(world, label),
        &text(world, "test agent"),
        &owner,
    );
    (agent, owner)
}

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

/// A world with one agent whose per-transaction cap is `CAP` and daily cap `DAILY`.
fn capped(world: &World<'_>) -> (Address, Address) {
    let (agent, owner) = register(world, "capped");
    set_caps(world, &agent, &owner, CAP, DAILY);
    (agent, owner)
}

// ───────────────────────── #1231: committed registration result ─────────────────────────

type Registered = (Address, String, String, i32);

#[test]
fn registration_emits_exactly_one_event_with_the_identity_and_initial_score() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = Address::generate(&env);
    let owner = Address::generate(&env);

    world.client.register_agent(
        &agent,
        &text(&world, "Atlas"),
        &text(&world, "routes payments"),
        &owner,
    );

    let events = last_events(&world);
    assert_eq!(
        events.len(),
        1,
        "the default policy is created without a second event"
    );
    let (action, who, data) = &events[0];
    assert_eq!(*action, Symbol::new(&env, "registered"));
    assert_eq!(*who, agent);
    assert_eq!(
        Registered::from_val(&env, data),
        (
            owner,
            text(&world, "Atlas"),
            text(&world, "routes payments"),
            INITIAL_SCORE
        )
    );
}

#[test]
fn the_event_matches_what_was_committed_to_storage() {
    let env = Env::default();
    let world = world(&env, true);
    let agent = Address::generate(&env);

    world
        .client
        .register_agent(&agent, &text(&world, "Atlas"), &text(&world, "d"), &agent);

    let events = last_events(&world);
    let (owner, name, description, score) = Registered::from_val(&env, &events[0].2);
    let stored = stored_agent(&world, &agent);
    assert_eq!(
        (owner, name, description, score),
        (
            stored.owner.clone(),
            stored.name.clone(),
            stored.description.clone(),
            stored.score
        )
    );
    assert_eq!(stored.owner, agent, "owner may be the agent itself");
}

#[test]
fn the_event_reports_the_initial_score_even_after_the_score_later_moves() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");
    let initial = Registered::from_val(&env, &last_events(&world)[0].2).3;

    pay(&world, &agent, 100, true);

    assert_eq!(initial, INITIAL_SCORE);
    assert_ne!(
        stored_agent(&world, &agent).score,
        initial,
        "the stored score has moved on"
    );
}

#[test]
fn a_registration_returns_the_new_count_and_events_follow_registration_order() {
    let env = Env::default();
    let world = world(&env, true);

    let mut registered = std::vec::Vec::new();
    for expected_count in 1u64..=3 {
        let agent = Address::generate(&env);
        let count =
            world
                .client
                .register_agent(&agent, &text(&world, "n"), &text(&world, "d"), &agent);
        assert_eq!(count, expected_count);
        // The event for this registration names this agent, so the stream is in order.
        assert_eq!(last_events(&world)[0].1, agent);
        registered.push(agent);
    }

    let listed: std::vec::Vec<Address> = world
        .client
        .list_agents(&10)
        .iter()
        .map(|entry| entry.address)
        .collect();
    assert_eq!(listed, registered);
}

#[test]
fn registration_creates_the_default_policy_without_a_policy_event() {
    let env = Env::default();
    let world = world(&env, true);

    let (agent, _owner) = register(&world, "a");

    let policy = stored_policy(&world, &agent);
    assert_eq!(policy.max_per_tx_stroops, 10_000_000_000);
    assert_eq!(policy.max_per_day_stroops, 100_000_000_000);
    assert_eq!(policy.daily_spent_stroops, 0);
    assert_eq!(policy.allowed_categories.len(), 0);
    assert!(
        last_events(&world)
            .iter()
            .all(|(action, _, _)| *action != Symbol::new(&env, "policy_updated")),
        "the registered event is what announces the default policy"
    );
}

#[test]
fn a_duplicate_registration_fails_with_no_event_and_keeps_the_original() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "original");
    let count = world.client.get_agent_count();

    let result = world.client.try_register_agent(
        &agent,
        &text(&world, "impostor"),
        &text(&world, "again"),
        &Address::generate(&env),
    );

    assert_eq!(
        result,
        Err(Ok(contract_error(AgentError::AgentAlreadyRegistered)))
    );
    assert_eq!(
        last_events(&world).len(),
        0,
        "a failed registration commits and announces nothing"
    );
    assert_eq!(world.client.get_agent_count(), count);
    let stored = stored_agent(&world, &agent);
    assert_eq!(stored.name, text(&world, "original"));
    assert_eq!(stored.owner, owner);
}

// ───────────────── #1235: authority around the per-transaction spending cap ─────────────────

#[test]
fn a_payment_exactly_at_the_cap_is_allowed_and_recorded_by_the_signed_provider() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);

    assert!(
        world.client.check_spending_allowed(&agent, &CAP),
        "exactly at the cap is allowed"
    );
    assert!(
        !world.client.check_spending_allowed(&agent, &(CAP + 1)),
        "one over is not"
    );
    pay(&world, &agent, CAP, true);

    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, CAP);
    let entry = stored_agent(&world, &agent);
    assert_eq!((entry.total_payments, entry.successful_payments), (1, 1));
    assert_eq!(entry.total_volume_stroops, CAP);
}

#[test]
fn a_failed_payment_after_a_passed_allowance_check_spends_nothing_and_costs_score() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);
    let score_before = stored_agent(&world, &agent).score;

    assert!(
        world.client.check_spending_allowed(&agent, &CAP),
        "the allowance check passed"
    );
    pay(&world, &agent, CAP, false);

    let entry = stored_agent(&world, &agent);
    assert_eq!(entry.score, score_before + SCORE_FAILURE);
    assert_eq!((entry.total_payments, entry.failed_payments), (1, 1));
    assert_eq!(
        entry.total_volume_stroops, 0,
        "a failed payment moves no volume"
    );
    assert_eq!(
        stored_policy(&world, &agent).daily_spent_stroops,
        0,
        "and uses no allowance"
    );
    assert!(
        world.client.check_spending_allowed(&agent, &CAP),
        "the full cap is still available"
    );
}

#[test]
fn a_signed_address_that_is_not_the_provider_cannot_record_a_payment_at_the_cap() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);
    let before_agent = stored_agent(&world, &agent);
    let impostor = Address::generate(&env);

    for success in [true, false] {
        let result =
            world
                .client
                .try_record_payment(&agent, &SERVICE_ID, &CAP, &success, &impostor);
        assert_eq!(result, Err(Ok(AgentError::Unauthorized)));
    }

    let after = stored_agent(&world, &agent);
    assert_eq!(after.score, before_agent.score);
    assert_eq!(after.total_payments, 0);
    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, 0);
}

#[test]
fn the_agent_cannot_record_its_own_payment() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);

    let result = world
        .client
        .try_record_payment(&agent, &SERVICE_ID, &CAP, &true, &agent);

    assert_eq!(result, Err(Ok(AgentError::Unauthorized)));
    assert_eq!(stored_agent(&world, &agent).total_payments, 0);
}

#[test]
fn naming_the_provider_without_its_signature_cannot_record_a_payment() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);
    env.set_auths(&[]);

    let result = world
        .client
        .try_record_payment(&agent, &SERVICE_ID, &CAP, &true, &world.provider);

    assert!(
        result.is_err(),
        "the provider has to sign, not just be named"
    );
    assert_eq!(stored_agent(&world, &agent).total_payments, 0);
    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, 0);
}

#[test]
fn a_signed_non_owner_cannot_raise_the_cap() {
    let env = Env::default();
    let world = world(&env, true); // everyone can sign: the role check is what must stop them
    let (agent, _owner) = capped(&world);
    let attacker = Address::generate(&env);

    let result =
        world
            .client
            .try_update_policy(&agent, &i128::MAX, &i128::MAX, &vec![&env], &0, &attacker);

    assert_eq!(result, Err(Ok(contract_error(AgentError::Unauthorized))));
    let policy = stored_policy(&world, &agent);
    assert_eq!(
        (policy.max_per_tx_stroops, policy.max_per_day_stroops),
        (CAP, DAILY)
    );
    assert!(
        !world.client.check_spending_allowed(&agent, &(CAP + 1)),
        "the cap still holds"
    );
}

#[test]
fn the_agent_itself_is_not_the_owner_and_cannot_raise_its_own_cap() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world); // the owner is a different address

    let result =
        world
            .client
            .try_update_policy(&agent, &i128::MAX, &i128::MAX, &vec![&env], &0, &agent);

    assert_eq!(result, Err(Ok(contract_error(AgentError::Unauthorized))));
    assert_eq!(stored_policy(&world, &agent).max_per_tx_stroops, CAP);
}

#[test]
fn the_admin_and_the_provider_are_not_owners_and_cannot_change_the_policy() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);

    for caller in [world.admin.clone(), world.provider.clone()] {
        let result = world
            .client
            .try_update_policy(&agent, &1, &1, &vec![&env], &0, &caller);
        assert_eq!(result, Err(Ok(contract_error(AgentError::Unauthorized))));
    }

    assert_eq!(stored_policy(&world, &agent).max_per_tx_stroops, CAP);
}

#[test]
fn the_owner_has_to_sign_to_change_the_policy() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = capped(&world);
    env.set_auths(&[]);

    let result =
        world
            .client
            .try_update_policy(&agent, &i128::MAX, &i128::MAX, &vec![&env], &0, &owner);

    assert!(result.is_err(), "naming the owner is not enough");
    assert_eq!(stored_policy(&world, &agent).max_per_tx_stroops, CAP);
}

#[test]
fn an_agent_whose_policy_was_attacked_is_still_judged_by_the_original_cap() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);
    let attacker = Address::generate(&env);
    let _ =
        world
            .client
            .try_update_policy(&agent, &i128::MAX, &i128::MAX, &vec![&env], &0, &attacker);

    pay(&world, &agent, CAP, true);

    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, CAP);
    assert!(!world.client.check_spending_allowed(&agent, &(CAP + 1)));
}

#[test]
fn the_allowance_check_needs_no_signature_and_changes_nothing() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = capped(&world);
    pay(&world, &agent, 400, true);
    env.set_auths(&[]);
    let before = stored_policy(&world, &agent);

    assert!(world.client.check_spending_allowed(&agent, &CAP));
    assert!(!world.client.check_spending_allowed(&agent, &(CAP + 1)));

    let after = stored_policy(&world, &agent);
    assert_eq!(after.daily_spent_stroops, before.daily_spent_stroops);
    assert_eq!(after.last_reset_ledger, before.last_reset_ledger);
}

// ───────────── #1246: committed policy changes, including allowed categories ─────────────

type PolicyUpdated = (Address, i128, i128, Vec<String>, i32);

#[test]
fn a_policy_change_emits_one_event_carrying_the_categories_and_caps_that_were_stored() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    let categories = vec![&env, text(&world, "weather"), text(&world, "search")];

    world
        .client
        .update_policy(&agent, &CAP, &DAILY, &categories, &25, &owner);

    let events = last_events(&world);
    assert_eq!(events.len(), 1);
    let (action, who, data) = &events[0];
    assert_eq!(*action, Symbol::new(&env, "policy_updated"));
    assert_eq!(*who, agent);
    let (caller, per_tx, per_day, emitted_categories, min_score) =
        PolicyUpdated::from_val(&env, data);
    assert_eq!(caller, owner);
    assert_eq!((per_tx, per_day, min_score), (CAP, DAILY, 25));
    assert_eq!(emitted_categories, categories);

    let stored = stored_policy(&world, &agent);
    assert_eq!(
        stored.allowed_categories, categories,
        "the event matches storage"
    );
    assert_eq!(
        (stored.max_per_tx_stroops, stored.max_per_day_stroops),
        (CAP, DAILY)
    );
}

#[test]
fn clearing_the_categories_is_announced_as_an_empty_list() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    world.client.update_policy(
        &agent,
        &CAP,
        &DAILY,
        &vec![&env, text(&world, "weather")],
        &0,
        &owner,
    );

    world
        .client
        .update_policy(&agent, &CAP, &DAILY, &vec![&env], &0, &owner);

    let data = last_events(&world)[0].2;
    assert_eq!(PolicyUpdated::from_val(&env, &data).3.len(), 0);
    assert_eq!(stored_policy(&world, &agent).allowed_categories.len(), 0);
}

#[test]
fn successive_policy_changes_each_emit_their_own_event_in_order() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");

    let mut announced = std::vec::Vec::new();
    for per_tx in [500i128, 700, 900] {
        world
            .client
            .update_policy(&agent, &per_tx, &DAILY, &vec![&env], &0, &owner);
        let data = last_events(&world)[0].2;
        announced.push(PolicyUpdated::from_val(&env, &data).1);
    }

    assert_eq!(announced, std::vec![500, 700, 900]);
    assert_eq!(stored_policy(&world, &agent).max_per_tx_stroops, 900);
}

#[test]
fn a_rejected_policy_change_emits_no_event_and_changes_nothing() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, _owner) = register(&world, "a");
    let before = stored_policy(&world, &agent);
    let attacker = Address::generate(&env);

    let result = world.client.try_update_policy(
        &agent,
        &1,
        &1,
        &vec![&env, text(&world, "premium")],
        &999,
        &attacker,
    );

    assert!(result.is_err());
    assert_eq!(
        last_events(&world).len(),
        0,
        "no committed change, no event"
    );
    let after = stored_policy(&world, &agent);
    assert_eq!(after.max_per_tx_stroops, before.max_per_tx_stroops);
    assert_eq!(after.allowed_categories.len(), 0);
    assert_eq!(after.min_score_to_earn, before.min_score_to_earn);
}

#[test]
fn a_policy_change_does_not_reset_or_erase_the_spend_already_made_today() {
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = capped(&world);
    pay(&world, &agent, 600, true);
    let window = stored_policy(&world, &agent).last_reset_ledger;

    world.client.update_policy(
        &agent,
        &CAP,
        &DAILY,
        &vec![&env, text(&world, "weather")],
        &0,
        &owner,
    );

    let policy = stored_policy(&world, &agent);
    assert_eq!(
        policy.daily_spent_stroops, 600,
        "changing categories is not a way to clear the day"
    );
    assert_eq!(policy.last_reset_ledger, window);
}

#[test]
fn allowed_categories_are_recorded_and_announced_but_not_enforced_on_chain() {
    // Characterisation, not an endorsement. `check_spending_allowed` and `record_payment`
    // take no category, so a payment to a service outside `allowed_categories` is neither
    // refused nor flagged by this contract. Enforcement is the caller's job today (the
    // backend and agent read the policy). This test pins the current behaviour so that
    // adding on-chain enforcement later is a deliberate, visible change.
    let env = Env::default();
    let world = world(&env, true);
    let (agent, owner) = register(&world, "a");
    world.client.update_policy(
        &agent,
        &CAP,
        &DAILY,
        &vec![&env, text(&world, "weather")],
        &0,
        &owner,
    );

    // SERVICE_ID's category in the stub registry is "test", which is not in the list.
    assert!(world.client.check_spending_allowed(&agent, &CAP));
    pay(&world, &agent, CAP, true);

    assert_eq!(stored_policy(&world, &agent).daily_spent_stroops, CAP);
}
