//! #1247: regression tests for the allowed service categories in an agent's spending policy.
//!
//! What the contract does today, and what these tests pin:
//!
//! - `update_policy` stores `allowed_categories` verbatim, replaces (never merges) the previous list,
//!   and only the agent's owner may change it.
//! - A new agent starts with an empty list.
//! - Nothing else reads the list. `check_spending_allowed` takes no category and `record_payment`
//!   does not look at the service's category, so a category outside the list does not stop a payment
//!   from being recorded or a spend from being approved. The tests under "the list is not enforced
//!   by the payment path" state that explicitly, so enforcing it later is a deliberate change that
//!   updates them rather than an accident.
//!
//! None of the tests use live funds: the registry is the in-test mock.
extern crate std;

use crate::test::{MockRegistry, MockRegistryClient};
use crate::{AgentEntry, LodestarAgents, LodestarAgentsClient, SpendingPolicy};
use soroban_sdk::{
    testutils::{Address as _, Events},
    vec, Address, Env, FromVal, IntoVal, String, Symbol, Vec,
};

struct Fixture<'a> {
    env: &'a Env,
    client: LodestarAgentsClient<'a>,
    agent: Address,
    owner: Address,
    provider: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let registry_id = env.register(MockRegistry, ());
    let admin = Address::generate(env);
    let contract_id = env.register(LodestarAgents, (admin,));
    let client = LodestarAgentsClient::new(env, &contract_id);
    client.init(&registry_id);

    let agent = Address::generate(env);
    let owner = Address::generate(env);
    client.register_agent(
        &agent,
        &String::from_str(env, "Category Agent"),
        &String::from_str(env, "regression fixture"),
        &owner,
    );
    let provider = Address::generate(env);
    MockRegistryClient::new(env, &registry_id).set_provider(&provider);
    Fixture {
        env,
        client,
        agent,
        owner,
        provider,
    }
}

fn cats(env: &Env, names: &[&str]) -> Vec<String> {
    let mut list = vec![env];
    for name in names {
        list.push_back(String::from_str(env, name));
    }
    list
}

impl Fixture<'_> {
    fn set_categories(&self, names: &[&str]) {
        self.client.update_policy(
            &self.agent,
            &1_000_000i128,
            &10_000_000i128,
            &cats(self.env, names),
            &0,
            &self.owner,
        );
    }

    fn policy(&self) -> SpendingPolicy {
        self.client.get_policy(&self.agent).unwrap()
    }

    fn agent_entry(&self) -> AgentEntry {
        self.client.get_agent(&self.agent).unwrap()
    }
}

fn names(policy: &SpendingPolicy) -> std::vec::Vec<std::string::String> {
    policy
        .allowed_categories
        .iter()
        .map(|c| {
            let mut buf = std::vec![0u8; c.len() as usize];
            c.copy_into_slice(&mut buf);
            std::string::String::from_utf8(buf).unwrap()
        })
        .collect()
}

mod the_list_is_stored {
    use super::*;

    #[test]
    fn a_new_agent_starts_with_an_empty_list() {
        let env = Env::default();
        let f = fixture(&env);

        assert!(f.policy().allowed_categories.is_empty());
    }

    #[test]
    fn one_exact_match_is_stored_as_given() {
        let env = Env::default();
        let f = fixture(&env);

        f.set_categories(&["data"]);

        assert_eq!(names(&f.policy()), ["data"]);
    }

    #[test]
    fn several_categories_keep_their_order() {
        let env = Env::default();
        let f = fixture(&env);

        f.set_categories(&["data", "compute", "storage"]);

        assert_eq!(names(&f.policy()), ["data", "compute", "storage"]);
    }

    #[test]
    fn categories_are_exact_strings_with_no_case_folding() {
        let env = Env::default();
        let f = fixture(&env);

        f.set_categories(&["Data", "data"]);

        assert_eq!(names(&f.policy()), ["Data", "data"]);
    }

    #[test]
    fn an_empty_list_can_be_set_again_to_clear_a_previous_one() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);

        f.set_categories(&[]);

        assert!(f.policy().allowed_categories.is_empty());
    }
}

mod the_category_changes_before_a_payment {
    use super::*;

    #[test]
    fn a_new_list_replaces_the_old_one_it_is_not_merged() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data", "compute"]);

        f.set_categories(&["storage"]);

        assert_eq!(names(&f.policy()), ["storage"]);
    }

    #[test]
    fn the_payment_that_follows_sees_the_list_as_it_was_last_set() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);
        f.set_categories(&["compute"]);

        f.client
            .record_payment(&f.agent, &1u64, &500i128, &true, &f.provider);

        assert_eq!(names(&f.policy()), ["compute"]);
    }

    #[test]
    fn changing_the_list_keeps_the_spend_already_made_in_the_window() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);
        f.client
            .record_payment(&f.agent, &1u64, &700i128, &true, &f.provider);

        f.set_categories(&["compute"]);

        assert_eq!(f.policy().daily_spent_stroops, 700);
    }

    #[test]
    fn changing_the_list_does_not_touch_the_agent_record() {
        let env = Env::default();
        let f = fixture(&env);
        f.client
            .record_payment(&f.agent, &1u64, &700i128, &true, &f.provider);
        let before = f.agent_entry();

        f.set_categories(&["compute"]);

        let after = f.agent_entry();
        assert_eq!(after.score, before.score);
        assert_eq!(after.total_payments, before.total_payments);
        assert_eq!(after.total_volume_stroops, before.total_volume_stroops);
    }
}

mod only_the_owner_changes_the_list {
    use super::*;
    use crate::AgentError;

    #[test]
    fn a_stranger_is_refused_and_the_list_is_unchanged() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);
        let stranger = Address::generate(&env);

        let result = f.client.try_update_policy(
            &f.agent,
            &1_000_000i128,
            &10_000_000i128,
            &cats(&env, &["compute"]),
            &0,
            &stranger,
        );

        assert_eq!(
            result,
            Err(Ok(soroban_sdk::Error::from(AgentError::Unauthorized)))
        );
        assert_eq!(names(&f.policy()), ["data"]);
    }

    #[test]
    fn the_provider_is_not_the_owner_and_cannot_change_it() {
        let env = Env::default();
        let f = fixture(&env);

        let result = f.client.try_update_policy(
            &f.agent,
            &1_000_000i128,
            &10_000_000i128,
            &cats(&env, &["compute"]),
            &0,
            &f.provider,
        );

        assert_eq!(
            result,
            Err(Ok(soroban_sdk::Error::from(AgentError::Unauthorized)))
        );
        assert!(f.policy().allowed_categories.is_empty());
    }

    #[test]
    fn an_unknown_agent_is_refused() {
        let env = Env::default();
        let f = fixture(&env);
        let unknown = Address::generate(&env);

        let result = f.client.try_update_policy(
            &unknown,
            &1i128,
            &1i128,
            &cats(&env, &["data"]),
            &0,
            &f.owner,
        );

        assert_eq!(
            result,
            Err(Ok(soroban_sdk::Error::from(AgentError::AgentNotFound)))
        );
        assert!(f.client.get_policy(&unknown).is_none());
    }

    #[test]
    fn the_call_asks_the_owner_to_authorize() {
        let env = Env::default();
        let f = fixture(&env);

        f.set_categories(&["data"]);

        let auths = env.auths();
        let (who, _) = auths.last().unwrap();
        assert_eq!(*who, f.owner);
    }
}

mod one_change_is_one_event {
    use super::*;

    #[test]
    fn a_policy_update_emits_exactly_one_policy_updated_event_with_the_list() {
        let env = Env::default();
        let f = fixture(&env);
        let before = env.events().all().len();

        f.set_categories(&["data", "compute"]);

        let events = env.events().all();
        assert_eq!(events.len(), before + 1);
        let event = events.get(events.len() - 1).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "agents"),
                Symbol::new(&env, "policy_updated"),
                f.agent.clone(),
            )
                .into_val(&env)
        );
        let (caller, per_tx, per_day, categories, min_score) =
            <(Address, i128, i128, Vec<String>, i32)>::from_val(&env, &event.2);
        assert_eq!(caller, f.owner);
        assert_eq!((per_tx, per_day, min_score), (1_000_000, 10_000_000, 0));
        assert_eq!(categories, cats(&env, &["data", "compute"]));
    }

    #[test]
    fn a_second_update_emits_its_own_event_with_its_own_list() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);

        f.set_categories(&["compute"]);

        // Events are reported per invocation: the second call has exactly one, and it carries the
        // new list rather than the first one.
        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let (_, _, _, categories, _) =
            <(Address, i128, i128, Vec<String>, i32)>::from_val(&env, &events.get(0).unwrap().2);
        assert_eq!(categories, cats(&env, &["compute"]));
    }

    #[test]
    fn changing_the_list_does_not_add_an_agent() {
        let env = Env::default();
        let f = fixture(&env);
        let count = f.client.get_agent_count();

        f.set_categories(&["data"]);
        f.set_categories(&["compute"]);

        assert_eq!(f.client.get_agent_count(), count);
    }
}

mod the_list_is_not_enforced_by_the_payment_path {
    use super::*;

    /// The same payment, under an empty list, a matching list and a list with no matching entry.
    fn lists() -> [&'static [&'static str]; 3] {
        [&[], &["test"], &["data", "compute"]]
    }

    #[test]
    fn a_spend_check_gives_the_same_answer_whatever_the_list() {
        for list in lists() {
            let env = Env::default();
            let f = fixture(&env);
            f.set_categories(list);

            assert!(
                f.client.check_spending_allowed(&f.agent, &1_000i128),
                "{list:?}"
            );
            assert!(
                !f.client.check_spending_allowed(&f.agent, &2_000_000i128),
                "{list:?}"
            );
        }
    }

    #[test]
    fn a_payment_to_a_service_outside_the_list_is_still_recorded() {
        // The mock registry reports every service as category "test".
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data", "compute"]);

        f.client
            .record_payment(&f.agent, &1u64, &500i128, &true, &f.provider);

        let agent = f.agent_entry();
        assert_eq!(agent.total_payments, 1);
        assert_eq!(agent.total_volume_stroops, 500);
        assert_eq!(f.policy().daily_spent_stroops, 500);
    }

    #[test]
    fn a_payment_records_the_same_effects_under_every_list() {
        let mut seen = std::vec::Vec::new();
        for list in lists() {
            let env = Env::default();
            let f = fixture(&env);
            f.set_categories(list);
            f.client
                .record_payment(&f.agent, &1u64, &500i128, &true, &f.provider);
            let agent = f.agent_entry();
            seen.push((
                agent.score,
                agent.total_payments,
                agent.total_volume_stroops,
                f.policy().daily_spent_stroops,
            ));
        }

        assert!(seen.windows(2).all(|w| w[0] == w[1]), "{seen:?}");
    }

    #[test]
    fn a_spend_check_changes_no_stored_state() {
        let env = Env::default();
        let f = fixture(&env);
        f.set_categories(&["data"]);
        let policy_before = f.policy();
        let agent_before = f.agent_entry();

        f.client.check_spending_allowed(&f.agent, &500i128);
        f.client.check_spending_allowed(&f.agent, &500i128);

        let policy = f.policy();
        assert_eq!(
            policy.daily_spent_stroops,
            policy_before.daily_spent_stroops
        );
        assert_eq!(names(&policy), names(&policy_before));
        assert_eq!(f.agent_entry().total_payments, agent_before.total_payments);
    }
}
