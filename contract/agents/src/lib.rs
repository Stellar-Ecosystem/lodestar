#![no_std]
use soroban_sdk::{
    contract, contractimpl, symbol_short, Address, Env, Map, String, Symbol, Vec,
};

const DAY_LEDGERS: u64 = 17280; // ~1 day assuming 5-second ledger times
const INITIAL_SCORE: u32 = 100;
const MAX_SCORE: u32 = 1000;
const SUCCESS_INCREMENT: u32 = 10;
const FAILURE_PENALTY: u32 = 25;

#[derive(Clone, Debug, PartialEq)]
pub struct SpendingPolicy {
    pub max_per_tx_stroops: i128,
    pub max_per_day_stroops: i128,
    pub daily_spent_stroops: i128,
    pub last_reset_ledger: u64,
    pub allowed_providers: Vec<Address>,
    pub min_score_to_earn: u32,
    pub owner: Address,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentIdentity {
    pub address: Address,
    pub owner: Address,
    pub score: u32,
    pub total_payments: u32,
    pub successful_payments: u32,
    pub failed_payments: u32,
    pub registered_at_ledger: u64,
}

#[contract]
pub struct LodestarAgentsContract;

#[contractimpl]
impl LodestarAgentsContract {
    pub fn update_policy(
        env: Env,
        agent: Address,
        max_per_tx: i128,
        max_per_day: i128,
        allowed_providers: Vec<Address>,
        min_score_to_earn: u32,
        owner: Address,
    ) {
        owner.require_auth();
        let key = Symbol::new(&env, "POLICY");
        let current_ledger = env.ledger().sequence() as u64;

        let policy = SpendingPolicy {
            max_per_tx_stroops: max_per_tx,
            max_per_day_stroops: max_per_day,
            daily_spent_stroops: 0,
            last_reset_ledger: current_ledger,
            allowed_providers,
            min_score_to_earn,
            owner,
        };
        env.storage().persistent().set(&(key, agent), &policy);
    }

    pub fn get_policy(env: Env, agent: Address) -> Option<SpendingPolicy> {
        let key = Symbol::new(&env, "POLICY");
        let mut policy: SpendingPolicy = env.storage().persistent().get(&(key, agent))?;
        let current_ledger = env.ledger().sequence() as u64;

        if current_ledger >= policy.last_reset_ledger + DAY_LEDGERS {
            policy.daily_spent_stroops = 0;
            policy.last_reset_ledger = current_ledger;
        }
        Some(policy)
    }

    pub fn get_agent(env: Env, agent: Address) -> Option<AgentIdentity> {
        let key = Symbol::new(&env, "AGENT");
        env.storage().persistent().get(&(key, agent))
    }

    pub fn record_payment(
        env: Env,
        agent: Address,
        _payment_id: u64,
        amount: i128,
        success: bool,
        _provider: Address,
    ) {
        let agent_key = Symbol::new(&env, "AGENT");
        let mut identity: AgentIdentity = env
            .storage()
            .persistent()
            .get(&(agent_key, agent.clone()))
            .unwrap_or(AgentIdentity {
                address: agent.clone(),
                owner: agent.clone(),
                score: INITIAL_SCORE,
                total_payments: 0,
                successful_payments: 0,
                failed_payments: 0,
                registered_at_ledger: env.ledger().sequence() as u64,
            });

        identity.total_payments += 1;

        if let Some(mut policy) = Self::get_policy(env.clone(), agent.clone()) {
            let current_ledger = env.ledger().sequence() as u64;
            let mut daily_spent = policy.daily_spent_stroops;
            let mut last_reset = policy.last_reset_ledger;

            if current_ledger >= last_reset + DAY_LEDGERS {
                daily_spent = 0;
                last_reset = current_ledger;
            }

            if success {
                identity.successful_payments += 1;
                daily_spent += amount;

                if identity.score >= policy.min_score_to_earn {
                    identity.score = (identity.score + SUCCESS_INCREMENT).min(MAX_SCORE);
                }
            } else {
                identity.failed_payments += 1;
                identity.score = identity.score.saturating_sub(FAILURE_PENALTY);
            }

            policy.daily_spent_stroops = daily_spent;
            policy.last_reset_ledger = last_reset;

            let policy_key = Symbol::new(&env, "POLICY");
            env.storage().persistent().set(&(policy_key, agent.clone()), &policy);
        }

        env.storage().persistent().set(&(agent_key, agent), &identity);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    const TEST_MAX_TTL: u32 = 100_000;

    fn setup_with_registry(env: &Env) -> (Address, Address) {
        let contract_id = env.register_contract(None, LodestarAgentsContract);
        let admin = Address::generate(env);
        (contract_id, admin)
    }

    fn setup_agent(env: &Env, contract_id: &Address, agent: &Address, owner: &Address) {
        let client = LodestarAgentsContractClient::new(env, contract_id);
        client.update_policy(agent, &1000i128, &5000i128, &vec![env], &0, owner);
    }

    #[test]
    fn test_daily_reset_boundary_one_before_and_after() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup_with_registry(&env);
        let client = LodestarAgentsContractClient::new(&env, &contract_id);

        let agent_addr = Address::generate(&env);
        let owner = Address::generate(&env);
        setup_agent(&env, &contract_id, &agent_addr, &owner);

        let initial_ledger = 100u64;
        env.ledger().with_mut(|li| {
            li.sequence_number = initial_ledger as u32;
            li.min_persistent_entry_ttl = TEST_MAX_TTL;
            li.min_temp_entry_ttl = TEST_MAX_TTL;
        });

        let max_per_day = 1000i128;
        client.update_policy(
            &agent_addr,
            &1000i128,
            &max_per_day,
            &vec![&env],
            &0,
            &owner,
        );

        let policy = client.get_policy(&agent_addr).unwrap();
        assert_eq!(policy.daily_spent_stroops, 0);
        assert_eq!(policy.last_reset_ledger, initial_ledger);

        // 1. Advance to (initial_ledger + DAY_LEDGERS - 1) -> Should NOT reset
        let before_boundary = initial_ledger + DAY_LEDGERS - 1;
        env.ledger().with_mut(|li| {
            li.sequence_number = before_boundary as u32;
            li.min_persistent_entry_ttl = TEST_MAX_TTL;
            li.min_temp_entry_ttl = TEST_MAX_TTL;
        });

        let policy_before = client.get_policy(&agent_addr).unwrap();
        assert_eq!(policy_before.last_reset_ledger, initial_ledger);

        // 2. Advance to (initial_ledger + DAY_LEDGERS) -> EXACT threshold -> Should RESET
        let at_boundary = initial_ledger + DAY_LEDGERS;
        env.ledger().with_mut(|li| {
            li.sequence_number = at_boundary as u32;
            li.min_persistent_entry_ttl = TEST_MAX_TTL;
            li.min_temp_entry_ttl = TEST_MAX_TTL;
        });

        let policy_at = client.get_policy(&agent_addr).unwrap();
        assert_eq!(policy_at.last_reset_ledger, at_boundary);

        // 3. Advance to (at_boundary + 1) -> After threshold -> Should retain reset ledger
        env.ledger().with_mut(|li| {
            li.sequence_number = (at_boundary + 1) as u32;
            li.min_persistent_entry_ttl = TEST_MAX_TTL;
            li.min_temp_entry_ttl = TEST_MAX_TTL;
        });

        let policy_after = client.get_policy(&agent_addr).unwrap();
        assert_eq!(policy_after.last_reset_ledger, at_boundary);
    }

    #[test]
    fn test_record_payment_min_score_to_earn_enforcement() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup_with_registry(&env);
        let client = LodestarAgentsContractClient::new(&env, &contract_id);

        let agent_addr = Address::generate(&env);
        let owner = Address::generate(&env);
        let provider = Address::generate(&env);
        setup_agent(&env, &contract_id, &agent_addr, &owner);

        // Set min_score_to_earn to 150 (initial score is 100)
        client.update_policy(
            &agent_addr,
            &10_000i128,
            &100_000i128,
            &vec![&env],
            &150,
            &owner,
        );

        // Record payment when current score (100) < min_score_to_earn (150)
        client.record_payment(&agent_addr, &1u64, &500i128, &true, &provider);

        let agent = client.get_agent(&agent_addr).unwrap();
        assert_eq!(agent.score, INITIAL_SCORE); // Score remains 100
        assert_eq!(agent.total_payments, 1);
        assert_eq!(agent.successful_payments, 1);
    }
}
