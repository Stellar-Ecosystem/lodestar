use lodestar_agents::{LodestarAgents, LodestarAgentsClient};
use lodestar_registry::{LodestarRegistry, LodestarRegistryClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, FromVal, IntoVal, String, Symbol,
};

#[test]
fn registry_vote_emits_the_agents_registration_check() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let agents_id = env.register(LodestarAgents, (admin,));
    let agents = LodestarAgentsClient::new(&env, &agents_id);
    let registry_id = env.register(LodestarRegistry, (agents_id.clone(),));
    let registry = LodestarRegistryClient::new(&env, &registry_id);

    let agent = Address::generate(&env);
    agents.register_agent(
        &agent,
        &String::from_str(&env, "Event Test Agent"),
        &String::from_str(&env, "Agent checking registration during a vote"),
        &agent,
    );
    let provider = Address::generate(&env);
    let service_id = registry.register_service(
        &provider,
        &String::from_str(&env, "Weather API"),
        &String::from_str(&env, "Weather service for the event test"),
        &String::from_str(&env, "https://example.test/weather"),
        &String::from_str(&env, "0.001"),
        &String::from_str(&env, "GTESTPAYTOADDRESS"),
        &String::from_str(&env, "weather"),
    );

    registry.update_reputation(&service_id, &true, &agent);

    // The agents observation precedes the registry's existing mutation event.
    let events = env.events().all();
    assert_eq!(events.len(), 2);
    let check = events.get(0).unwrap();
    assert_eq!(check.0, agents_id);
    assert_eq!(
        check.1,
        (
            Symbol::new(&env, "agents"),
            Symbol::new(&env, "registration_checked"),
            agent.clone(),
        )
            .into_val(&env)
    );
    assert_eq!(<(bool,)>::from_val(&env, &check.2), (true,));

    let vote = events.get(1).unwrap();
    assert_eq!(vote.0, registry_id);
    assert_eq!(
        vote.1,
        (
            Symbol::new(&env, "registry"),
            Symbol::new(&env, "reputation"),
            service_id,
        )
            .into_val(&env)
    );
    assert_eq!(
        <(Address, bool, i32)>::from_val(&env, &vote.2),
        (agent, true, 1)
    );
}
