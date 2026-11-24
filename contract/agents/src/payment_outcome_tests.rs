//! #1253: who may record a payment outcome, and what a recorded outcome changes.
//!
//! The boundary these tests pin for `record_payment`:
//!
//! 1. The caller must sign and must be the provider the registry lists for `service_id`. Nobody else
//!    can record an outcome: not the agent's owner, not the contract admin, not the agent itself,
//!    not the provider of a different service.
//! 2. A rejected outcome changes nothing: no score, counters, volume, daily spend or event. This
//!    matters most for failures, which would otherwise let a stranger lower an agent's score.
//! 3. An authorized outcome changes exactly the documented fields, in the units it was given:
//!    amounts in stroops, time in ledger sequence numbers.
//!
//! The registry is the in-test mock; no live funds are involved.
extern crate std;

use crate::test::{MockRegistry, MockRegistryClient};
use crate::{
    AgentEntry, AgentError, LodestarAgents, LodestarAgentsClient, INITIAL_SCORE, SCORE_FAILURE,
    SCORE_SUCCESS,
};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger as _},
    Address, Env, FromVal, IntoVal, String, Symbol,
};

const SERVICE: u64 = 7;

struct Fixture<'a> {
    env: &'a Env,
    client: LodestarAgentsClient<'a>,
    registry: MockRegistryClient<'a>,
    admin: Address,
    agent: Address,
    owner: Address,
    provider: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let registry_id = env.register(MockRegistry, ());
    let admin = Address::generate(env);
    let contract_id = env.register(LodestarAgents, (admin.clone(),));
    let client = LodestarAgentsClient::new(env, &contract_id);
    client.init(&registry_id);

    let agent = Address::generate(env);
    let owner = Address::generate(env);
    client.register_agent(
        &agent,
        &String::from_str(env, "Outcome Agent"),
        &String::from_str(env, "regression fixture"),
        &owner,
    );
    let registry = MockRegistryClient::new(env, &registry_id);
    let provider = Address::generate(env);
    registry.set_service(&SERVICE, &provider);
    Fixture {
        env,
        client,
        registry,
        admin,
        agent,
        owner,
        provider,
    }
}

impl Fixture<'_> {
    fn entry(&self) -> AgentEntry {
        self.client.get_agent(&self.agent).unwrap()
    }

    fn spent(&self) -> i128 {
        self.client
            .get_policy(&self.agent)
            .unwrap()
            .daily_spent_stroops
    }

    /// Everything a payment outcome could change, for before/after comparison.
    fn state(&self) -> (i32, u64, u64, u64, i128, u64, i128) {
        let a = self.entry();
        (
            a.score,
            a.total_payments,
            a.successful_payments,
            a.failed_payments,
            a.total_volume_stroops,
            a.last_active,
            self.spent(),
        )
    }
}

mod an_authorized_outcome {
    use super::*;

    #[test]
    fn a_success_records_the_exact_amount_and_raises_the_score_once() {
        let env = Env::default();
        let f = fixture(&env);
        let amount = 1_234_567i128; // stroops

        f.client
            .record_payment(&f.agent, &SERVICE, &amount, &true, &f.provider);

        let a = f.entry();
        assert_eq!(a.score, INITIAL_SCORE + SCORE_SUCCESS);
        assert_eq!(a.total_payments, 1);
        assert_eq!(a.successful_payments, 1);
        assert_eq!(a.failed_payments, 0);
        assert_eq!(a.total_volume_stroops, amount);
        assert_eq!(f.spent(), amount);
    }

    #[test]
    fn the_activity_time_is_the_ledger_sequence_not_a_timestamp() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = 100_000_000;
            li.min_temp_entry_ttl = 100_000_000;
            li.sequence_number = 4_321;
            li.timestamp = 1_700_000_000;
        });
        let f = fixture(&env);

        f.client
            .record_payment(&f.agent, &SERVICE, &1i128, &true, &f.provider);

        assert_eq!(f.entry().last_active, 4_321);
    }

    #[test]
    fn a_failure_lowers_the_score_and_counts_no_volume_or_spend() {
        let env = Env::default();
        let f = fixture(&env);

        f.client
            .record_payment(&f.agent, &SERVICE, &900i128, &false, &f.provider);

        let a = f.entry();
        assert_eq!(a.score, INITIAL_SCORE + SCORE_FAILURE);
        assert_eq!(a.failed_payments, 1);
        assert_eq!(a.successful_payments, 0);
        assert_eq!(a.total_volume_stroops, 0);
        assert_eq!(f.spent(), 0);
    }

    #[test]
    fn it_emits_one_payment_event_carrying_the_service_amount_outcome_and_both_scores() {
        let env = Env::default();
        let f = fixture(&env);
        let before = env.events().all().len();

        f.client
            .record_payment(&f.agent, &SERVICE, &5_000_000i128, &true, &f.provider);

        let events = env.events().all();
        assert_eq!(events.len(), before + 1);
        let event = events.get(events.len() - 1).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "agents"),
                Symbol::new(&env, "payment"),
                f.agent.clone(),
            )
                .into_val(&env)
        );
        assert_eq!(
            <(u64, i128, bool, i32, i32, Address)>::from_val(&env, &event.2),
            (
                SERVICE,
                5_000_000,
                true,
                INITIAL_SCORE,
                INITIAL_SCORE + SCORE_SUCCESS,
                f.provider.clone()
            )
        );
    }

    #[test]
    fn each_service_provider_may_record_for_their_own_service() {
        let env = Env::default();
        let f = fixture(&env);
        let other_provider = Address::generate(&env);
        f.registry.set_service(&8u64, &other_provider);

        f.client
            .record_payment(&f.agent, &SERVICE, &10i128, &true, &f.provider);
        f.client
            .record_payment(&f.agent, &8u64, &20i128, &true, &other_provider);

        let a = f.entry();
        assert_eq!(a.total_payments, 2);
        assert_eq!(a.total_volume_stroops, 30);
    }
}

mod an_unauthorized_outcome_changes_nothing {
    use super::*;

    fn assert_refused_and_unchanged(
        f: &Fixture<'_>,
        caller: &Address,
        service: u64,
        success: bool,
    ) {
        let state = f.state();

        let result = f
            .client
            .try_record_payment(&f.agent, &service, &100i128, &success, caller);

        assert_eq!(result, Err(Ok(AgentError::Unauthorized)));
        assert_eq!(f.state(), state, "state changed by a refused outcome");
    }

    #[test]
    fn a_stranger_cannot_record_a_success() {
        let env = Env::default();
        let f = fixture(&env);
        assert_refused_and_unchanged(&f, &Address::generate(&env), SERVICE, true);
    }

    #[test]
    fn a_stranger_cannot_record_a_failure_to_lower_the_score() {
        let env = Env::default();
        let f = fixture(&env);
        assert_refused_and_unchanged(&f, &Address::generate(&env), SERVICE, false);
        assert_eq!(f.entry().score, INITIAL_SCORE);
    }

    #[test]
    fn the_agents_owner_cannot_record_outcomes_for_their_own_agent() {
        let env = Env::default();
        let f = fixture(&env);
        assert_refused_and_unchanged(&f, &f.owner.clone(), SERVICE, true);
    }

    #[test]
    fn the_agent_itself_cannot_record_its_own_outcome() {
        let env = Env::default();
        let f = fixture(&env);
        assert_refused_and_unchanged(&f, &f.agent.clone(), SERVICE, true);
    }

    #[test]
    fn the_contract_admin_cannot_record_outcomes() {
        let env = Env::default();
        let f = fixture(&env);
        assert_refused_and_unchanged(&f, &f.admin.clone(), SERVICE, true);
    }

    #[test]
    fn the_provider_of_a_different_service_cannot_record_for_this_one() {
        let env = Env::default();
        let f = fixture(&env);
        let other_provider = Address::generate(&env);
        f.registry.set_service(&8u64, &other_provider);

        assert_refused_and_unchanged(&f, &other_provider, SERVICE, true);
        // ...and the original provider cannot record against the other provider's service.
        assert_refused_and_unchanged(&f, &f.provider.clone(), 8u64, true);
    }

    #[test]
    fn a_rejection_leaves_the_door_open_for_the_real_provider_afterwards() {
        let env = Env::default();
        let f = fixture(&env);
        let stranger = Address::generate(&env);
        let _ = f
            .client
            .try_record_payment(&f.agent, &SERVICE, &100i128, &true, &stranger);

        f.client
            .record_payment(&f.agent, &SERVICE, &100i128, &true, &f.provider);

        let a = f.entry();
        assert_eq!(
            a.total_payments, 1,
            "exactly one outcome, from the provider"
        );
        assert_eq!(a.score, INITIAL_SCORE + SCORE_SUCCESS);
    }

    #[test]
    fn repeated_attempts_by_a_stranger_never_accumulate() {
        let env = Env::default();
        let f = fixture(&env);
        let stranger = Address::generate(&env);
        let state = f.state();

        for _ in 0..10 {
            let _ = f
                .client
                .try_record_payment(&f.agent, &SERVICE, &100i128, &false, &stranger);
        }

        assert_eq!(f.state(), state);
    }

    #[test]
    fn the_caller_must_actually_sign() {
        let env = Env::default();
        let f = fixture(&env);
        env.set_auths(&[]);
        let state = f.state();

        let result = f
            .client
            .try_record_payment(&f.agent, &SERVICE, &100i128, &true, &f.provider);

        assert!(
            result.is_err(),
            "an unsigned call by the provider must not be accepted"
        );
        assert_eq!(f.state(), state);
    }
}

mod the_checks_run_in_a_defined_order {
    use super::*;

    #[test]
    fn a_non_positive_amount_is_rejected_before_the_registry_is_consulted() {
        let env = Env::default();
        let f = fixture(&env);
        let stranger = Address::generate(&env);

        // A stranger with a bad amount gets the amount error, not Unauthorized.
        assert_eq!(
            f.client
                .try_record_payment(&f.agent, &SERVICE, &0i128, &true, &stranger),
            Err(Ok(AgentError::InvalidAmount))
        );
    }

    #[test]
    fn authorization_is_checked_before_the_agent_is_looked_up() {
        let env = Env::default();
        let f = fixture(&env);
        let unknown_agent = Address::generate(&env);
        let stranger = Address::generate(&env);

        // A stranger cannot probe which agents exist: both cases answer Unauthorized.
        assert_eq!(
            f.client
                .try_record_payment(&unknown_agent, &SERVICE, &1i128, &true, &stranger),
            Err(Ok(AgentError::Unauthorized))
        );
        assert_eq!(
            f.client
                .try_record_payment(&f.agent, &SERVICE, &1i128, &true, &stranger),
            Err(Ok(AgentError::Unauthorized))
        );
    }

    #[test]
    fn the_real_provider_gets_agent_not_found_for_an_unknown_agent_and_nothing_is_created() {
        let env = Env::default();
        let f = fixture(&env);
        let unknown_agent = Address::generate(&env);
        let count = f.client.get_agent_count();

        assert_eq!(
            f.client
                .try_record_payment(&unknown_agent, &SERVICE, &1i128, &true, &f.provider),
            Err(Ok(AgentError::AgentNotFound))
        );
        assert!(f.client.get_agent(&unknown_agent).is_none());
        assert_eq!(f.client.get_agent_count(), count);
    }
}
