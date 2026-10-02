#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, vec, Address, Env, IntoVal, String,
    Symbol, Vec,
};

const MAX_TTL: u32 = 3110400;

// Minimum number of ledgers that must elapse before the same agent may vote on
// the same service again. ~1 hour at 5 s/ledger. This caps how fast any single
// identity can move a service's reputation, blocking automated inflation loops.
const VOTE_COOLDOWN_LEDGERS: u64 = 720;

const MAX_REPUTATION: i32 = 10_000;
const MIN_REPUTATION: i32 = -10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    InvalidName = 1,
    InvalidDescription = 2,
    DuplicateActiveService = 3,
    ServiceNotFound = 4,
    AgentsContractNotConfigured = 5,
    CallerNotRegisteredAgent = 6,
    ReputationVoteCooldown = 7,
    ProviderMismatch = 8,
    CategoryIndexNotFound = 9,
    InvalidEndpoint = 10,
    InvalidCategory = 11,
    ServiceCounterNotFound = 12,
}

// Canonical category list. Keep in sync with `frontend/lib/categoryMeta.tsx`.
// Existing mixed-case entries are not migrated automatically; providers should
// re-register under a canonical category returned by `list_categories()`.
const VALID_CATEGORIES: &[&str] = &["search", "weather", "finance", "ai", "data", "compute"];

// Returns the canonical lower-case form for a user-supplied category string,
// or `None` if it is not one of the known categories.
fn canonicalize_category(env: &Env, category: &String) -> Option<String> {
    let len = category.len() as usize;
    if len > 32 {
        return None;
    }
    let mut bytes = [0u8; 32];
    category.copy_into_slice(&mut bytes[..len]);

    let mut start = 0;
    while start < len && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = len;
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let trimmed = &bytes[start..end];

    for &cat in VALID_CATEGORIES {
        if trimmed.eq_ignore_ascii_case(cat.as_bytes()) {
            return Some(String::from_str(env, cat));
        }
    }
    None
}

#[contracttype]
#[derive(Clone)]
pub struct ServiceEntry {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub endpoint: String,
    pub price_usdc: String,
    pub pay_to: String,
    pub category: String,
    pub provider: Address,
    pub reputation: i32,
    pub active: bool,
    pub registered_at: u64,
}

#[contracttype]
pub enum DataKey {
    Counter,
    ServiceIds,
    Service(u64),
    ServiceIdsByCategory(String),
    // Address of the LodestarAgents contract, used to verify that a reputation
    // voter is a registered agent via a cross-contract `is_registered` call.
    AgentsContract,
    // Last ledger on which `agent` voted on `service_id`. Models the
    // `(service_id, agent) -> last_vote_ledger` cooldown map as discrete keys so
    // each lookup touches only one entry instead of loading a growing Map.
    LastVote(u64, Address),
    ProviderEndpoint(Address, String),
}

fn active_service_exists(env: &Env, provider: &Address, endpoint: &String) -> bool {
    env.storage().persistent().has(&DataKey::ProviderEndpoint(
        provider.clone(),
        endpoint.clone(),
    ))
}

fn vec_contains_id(ids: &Vec<u64>, id: u64) -> bool {
    let mut i = 0;
    while i < ids.len() {
        if ids.get(i).unwrap() == id {
            return true;
        }
        i += 1;
    }
    false
}

#[contract]
pub struct LodestarRegistry;

#[contractimpl]
impl LodestarRegistry {
    /// Deploy-time setup: store the address of the LodestarAgents contract so
    /// `update_reputation` can verify voters are registered agents.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment used to access contract storage.
    /// * `agents_contract` - Address of the LodestarAgents contract that
    ///   `update_reputation` will cross-call (`is_registered`) to authorise
    ///   reputation voters. Stored verbatim; not validated at construction time.
    ///
    /// # Returns
    ///
    /// This function returns `()`. Its only observable effect is the storage
    /// write described below.
    ///
    /// # Authorisation
    ///
    /// This is a contract constructor. It runs exactly once, atomically, as part
    /// of deployment, and can never be invoked by a later caller. It therefore
    /// requires no `require_auth` and exposes no post-deploy setter: the agents
    /// address is fixed for the contract's lifetime. That closes the
    /// trust-anchor takeover risk a public `init` would carry (a front-runner
    /// pointing the registry at a malicious agents contract where everyone is
    /// "registered").
    ///
    /// # Panics
    ///
    /// This function defines no contract-specific panic path and returns no
    /// `RegistryError` variant. The Soroban SDK will panic, without a
    /// `RegistryError` variant, if the persistent-storage write or TTL extension
    /// fails (for example, if the host rejects the storage access).
    ///
    /// # Storage
    ///
    /// * `DataKey::AgentsContract` — written with the supplied `agents_contract`
    ///   address, then its TTL is extended by `MAX_TTL` ledgers (both threshold
    ///   and extend-to), so the trust anchor does not expire.
    ///
    /// This is a contract constructor — it runs exactly once, atomically, as part
    /// of deployment, and can never be invoked by a later caller. That closes the
    /// trust-anchor takeover risk a public `init` would carry (a front-runner
    /// pointing the registry at a malicious agents contract where everyone is
    /// "registered"). The agents address is fixed for the contract's lifetime.
    pub fn __constructor(env: Env, agents_contract: Address) {
        env.storage()
            .persistent()
            .set(&DataKey::AgentsContract, &agents_contract);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::AgentsContract, MAX_TTL, MAX_TTL);
    }

    /// Address of the LodestarAgents contract this registry was deployed against.
    pub fn get_agents_contract(env: Env) -> Option<Address> {
        // Storage keys touched by this function:
        // 1. DataKey::AgentsContract - read to return the contract address;
        //    TTL extended so the trust anchor is not archived.
        let result = env.storage().persistent().get(&DataKey::AgentsContract);
        if result.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::AgentsContract, MAX_TTL, MAX_TTL);
        }
        result
    }

    pub fn register_service(
        env: Env,
        provider: Address,
        name: String,
        description: String,
        endpoint: String,
        price_usdc: String,
        pay_to: String,
        category: String,
    ) -> Result<u64, RegistryError> {
        provider.require_auth();

        if name.len() < 3 || name.len() > 64 {
            return Err(RegistryError::InvalidName);
        }
        if description.len() < 10 || description.len() > 256 {
            return Err(RegistryError::InvalidDescription);
        }
        if endpoint.len() > 256 {
            return Err(RegistryError::InvalidEndpoint);
        }
        if category.len() < 1 || category.len() > 32 {
            return Err(RegistryError::InvalidCategory);
        }
        if active_service_exists(&env, &provider, &endpoint) {
            return Err(RegistryError::DuplicateActiveService);
        }

        let counter: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0u64);

        let new_id = counter + 1;

        let canonical_category =
            canonicalize_category(&env, &category).ok_or(RegistryError::InvalidCategory)?;
        let cat = canonical_category.clone();

        let entry = ServiceEntry {
            id: new_id,
            name,
            description,
            endpoint,
            price_usdc,
            pay_to,
            category: canonical_category,
            provider,
            reputation: 0,
            active: true,
            registered_at: env.ledger().sequence() as u64,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Service(new_id), &entry);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Service(new_id), MAX_TTL, MAX_TTL);

        let endpoint_key =
            DataKey::ProviderEndpoint(entry.provider.clone(), entry.endpoint.clone());
        env.storage().persistent().set(&endpoint_key, &new_id);
        env.storage()
            .persistent()
            .extend_ttl(&endpoint_key, MAX_TTL, MAX_TTL);

        env.storage().persistent().set(&DataKey::Counter, &new_id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Counter, MAX_TTL, MAX_TTL);

        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceIds)
            .unwrap_or_else(|| vec![&env]);
        ids.push_back(new_id);
        env.storage().persistent().set(&DataKey::ServiceIds, &ids);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ServiceIds, MAX_TTL, MAX_TTL);

        let mut cat_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceIdsByCategory(cat.clone()))
            .unwrap_or_else(|| vec![&env]);
        cat_ids.push_back(new_id);
        env.storage()
            .persistent()
            .set(&DataKey::ServiceIdsByCategory(cat.clone()), &cat_ids);
        env.storage().persistent().extend_ttl(
            &DataKey::ServiceIdsByCategory(cat),
            MAX_TTL,
            MAX_TTL,
        );

        env.events().publish(
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "registered"),
                new_id,
            ),
            (
                entry.provider.clone(),
                entry.name.clone(),
                entry.description.clone(),
                entry.endpoint.clone(),
                entry.category.clone(),
                entry.price_usdc.clone(),
                entry.pay_to.clone(),
            ),
        );

        Ok(new_id)
    }

    /// Returns the service registered under `id`.
    ///
    /// This read-only entrypoint calls `get` once for the persistent-storage key
    /// `DataKey::Service(id)`. It does not require authorization, extend the
    /// entry's TTL, write to storage, emit an event, or call another contract.
    /// An entry is returned unchanged when present, including when it is
    /// inactive.
    ///
    /// # Arguments
    ///
    /// * `env` - The Soroban environment used to access contract storage.
    /// * `id` - The registry identifier of the service to retrieve.
    ///
    /// # Returns
    ///
    /// `Ok(ServiceEntry)` when `DataKey::Service(id)` has a live value, or
    /// `Err(RegistryError::ServiceNotFound)` when no live value is stored at
    /// that key.
    ///
    /// # Panics
    ///
    /// This function defines no contract-specific panic path. The Soroban SDK
    /// will panic, without a `RegistryError` variant, if a stored value cannot
    /// be converted to `ServiceEntry`; values written by this contract preserve
    /// that type invariant. A missing live value returns `ServiceNotFound`
    /// instead of panicking.
    pub fn get_service(env: Env, id: u64) -> Result<ServiceEntry, RegistryError> {
        env.storage()
            .persistent()
            .get(&DataKey::Service(id))
            .ok_or(RegistryError::ServiceNotFound)
    }

    pub fn list_services(
        env: Env,
        offset: u32,
        limit: u32,
        category: Option<String>,
    ) -> Vec<ServiceEntry> {
        // Storage keys touched by this function:
        // 1. DataKey::ServiceIdsByCategory(cat) — read when `category` is Some;
        //    TTL extended unconditionally to prevent archival of the index.
        // 2. DataKey::ServiceIds — read when `category` is None;
        //    TTL extended unconditionally to prevent archival of the master list.
        // 3. DataKey::Service(id) — read for every id in the selected slice;
        //    TTL extended on every successful read so hot entries stay live.
        let limit = limit.min(50u32).max(1u32);
        let start: u32 = offset;

        let ids: Vec<u64> = if let Some(ref category) = category {
            let Some(cat) = canonicalize_category(&env, category) else {
                return vec![&env];
            };
            let key = DataKey::ServiceIdsByCategory(cat);
            let result: Vec<u64> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or_else(|| vec![&env]);
            // Bump TTL so a popular category index is never archived while being
            // actively queried.
            if !result.is_empty() {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, MAX_TTL, MAX_TTL);
            }
            result
        } else {
            let key = DataKey::ServiceIds;
            let result: Vec<u64> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or_else(|| vec![&env]);
            // Bump TTL on the master list so it is never archived while being
            // actively queried.
            if !result.is_empty() {
                env.storage()
                    .persistent()
                    .extend_ttl(&key, MAX_TTL, MAX_TTL);
            }
            result
        };

        let total = ids.len();
        let end = (start + limit).min(total);

        let mut services: Vec<ServiceEntry> = vec![&env];
        let mut i = start;
        while i < end {
            let service_key = DataKey::Service(ids.get(i).unwrap());
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, ServiceEntry>(&service_key)
            {
                // Extend TTL on every read so queried service entries stay live.
                env.storage()
                    .persistent()
                    .extend_ttl(&service_key, MAX_TTL, MAX_TTL);
                if entry.active {
                    services.push_back(entry);
                }
            }
            i += 1;
        }

        // Insertion sort by reputation descending
        let len = services.len();
        for i in 1..len {
            let mut j = i;
            while j > 0 {
                let a = services.get(j - 1).unwrap();
                let b = services.get(j).unwrap();
                if a.reputation >= b.reputation {
                    break;
                }
                services.set(j - 1, b);
                services.set(j, a);
                j -= 1;
            }
        }

        services
    }

    /// Return the list of valid category strings.
    pub fn list_categories(env: Env) -> Vec<String> {
        let mut categories: Vec<String> = vec![&env];
        for &cat in VALID_CATEGORIES {
            categories.push_back(String::from_str(&env, cat));
        }
        categories
    }

    /// List a single page of services in registration order, filtering only active services.
    /// This avoids the pagination bug where inactive services cause short pages.
    ///
    /// Unlike list_services, this function ensures that every page except the last
    /// contains exactly page_size entries when enough active services exist.
    ///
    /// **Read-only: this entrypoint intentionally emits no event** (see #734).
    /// Soroban runs read-only calls through `simulateTransaction`, whose events are
    /// returned to the calling client but never written to a ledger, so no indexer
    /// could observe them — emission would only add cost for every caller. A
    /// consumer tracks what this page contains from the `registered`,
    /// `deactivated`, `reactivated`, and `reputation` events, which are emitted by
    /// the mutations that can change the page. The schema is documented in
    /// `contract/DEPLOY.md` and locked by tests in this module.
    pub fn list_services_page(env: Env, page: u32, page_size: u32) -> Vec<ServiceEntry> {
        // Storage keys touched by this function:
        // 1. DataKey::ServiceIds — read once to obtain the full ordered id list;
        //    TTL extended so the master index is never archived while being paged.
        // 2. DataKey::Service(id) — read for every id examined during the walk;
        //    TTL extended on each successful read so queried entries stay live.
        let page_size = page_size.min(20u32).max(1u32);

        let ids_key = DataKey::ServiceIds;
        let ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&ids_key)
            .unwrap_or_else(|| vec![&env]);

        // Bump the master list so it survives periods of high page traffic.
        if !ids.is_empty() {
            env.storage()
                .persistent()
                .extend_ttl(&ids_key, MAX_TTL, MAX_TTL);
        }

        let mut result: Vec<ServiceEntry> = vec![&env];
        let total_ids = ids.len() as usize;
        let mut active_count = 0;
        let mut found_count = 0;
        let target_skip = page as usize * page_size as usize;

        // Walk through all services, counting active ones until we reach our page
        for i in 0..total_ids {
            let service_key = DataKey::Service(ids.get(i as u32).unwrap());
            if let Some(entry) = env
                .storage()
                .persistent()
                .get::<DataKey, ServiceEntry>(&service_key)
            {
                // Extend TTL on every read so queried service entries stay live.
                env.storage()
                    .persistent()
                    .extend_ttl(&service_key, MAX_TTL, MAX_TTL);
                if entry.active {
                    if active_count >= target_skip {
                        // We're in the target page range
                        result.push_back(entry);
                        found_count += 1;
                        if found_count >= page_size as usize {
                            break;
                        }
                    }
                    active_count += 1;
                }
            }
        }

        result
    }

    /// Cast a reputation vote on a service.
    ///
    /// Authorization (closes the anonymous-write vulnerability):
    /// 1. `caller.require_auth()` — the vote must be signed by `caller`.
    /// 2. `caller` must be a registered agent, checked via a cross-contract
    ///    `is_registered` call to the configured LodestarAgents contract, so
    ///    only identities with an on-chain agent record can vote.
    /// 3. A per-(service, agent) cooldown of `VOTE_COOLDOWN_LEDGERS` rate-limits
    ///    repeat votes, preventing a single identity from inflating or tanking a
    ///    score in a tight loop.
    ///
    /// Storage keys touched by this function:
    /// 1. DataKey::AgentsContract — read to resolve the agents contract; TTL extended.
    /// 2. DataKey::Service(id) — read, updated, and TTL extended.
    /// 3. DataKey::LastVote(id, caller) — read for the cooldown check, written
    ///    with the current ledger, and TTL extended.
    pub fn update_reputation(
        env: Env,
        id: u64,
        positive: bool,
        caller: Address,
    ) -> Result<(), RegistryError> {
        caller.require_auth();

        // ── 1. Caller must be a registered agent ──────────────────────────────
        let agents_contract: Address = env
            .storage()
            .persistent()
            .get(&DataKey::AgentsContract)
            .ok_or(RegistryError::AgentsContractNotConfigured)?;
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::AgentsContract, MAX_TTL, MAX_TTL);

        let registered: bool = env.invoke_contract(
            &agents_contract,
            &Symbol::new(&env, "is_registered"),
            vec![&env, caller.clone().into_val(&env)],
        );
        if !registered {
            return Err(RegistryError::CallerNotRegisteredAgent);
        }

        let mut entry: ServiceEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Service(id))
            .ok_or(RegistryError::ServiceNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Service(id), MAX_TTL, MAX_TTL);

        // ── 2. Per-(service, agent) cooldown ──────────────────────────────────
        let now = env.ledger().sequence() as u64;
        let vote_key = DataKey::LastVote(id, caller.clone());
        if let Some(last_vote) = env.storage().persistent().get::<DataKey, u64>(&vote_key) {
            env.storage()
                .persistent()
                .extend_ttl(&vote_key, MAX_TTL, MAX_TTL);
            if now < last_vote + VOTE_COOLDOWN_LEDGERS {
                return Err(RegistryError::ReputationVoteCooldown);
            }
        }

        // ── 3. Apply the vote ─────────────────────────────────────────────────
        if positive {
            entry.reputation = (entry.reputation + 1).min(MAX_REPUTATION);
        } else {
            entry.reputation = (entry.reputation - 1).max(MIN_REPUTATION);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Service(id), &entry);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Service(id), MAX_TTL, MAX_TTL);

        env.storage().persistent().set(&vote_key, &now);
        env.storage()
            .persistent()
            .extend_ttl(&vote_key, MAX_TTL, MAX_TTL);

        env.events().publish(
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "reputation"),
                id,
            ),
            (caller, positive, entry.reputation),
        );

        Ok(())
    }

    pub fn deactivate_service(env: Env, provider: Address, id: u64) -> Result<(), RegistryError> {
        provider.require_auth();

        // Storage keys touched by this function:
        // 1. DataKey::Service(id) - Read, updated, and TTL extended.
        // 2. DataKey::ProviderEndpoint(provider, endpoint) - Removed (no TTL extension needed).
        // 3. DataKey::ServiceIdsByCategory(category) - Read, updated, and TTL extended.

        let mut entry: ServiceEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Service(id))
            .ok_or(RegistryError::ServiceNotFound)?;

        if provider != entry.provider {
            return Err(RegistryError::ProviderMismatch);
        }

        entry.active = false;
        env.storage()
            .persistent()
            .set(&DataKey::Service(id), &entry);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Service(id), MAX_TTL, MAX_TTL);

        env.storage()
            .persistent()
            .remove(&DataKey::ProviderEndpoint(
                entry.provider.clone(),
                entry.endpoint.clone(),
            ));

        // Remove from category index
        let cat_key = DataKey::ServiceIdsByCategory(entry.category.clone());
        let cat_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&cat_key)
            .ok_or(RegistryError::CategoryIndexNotFound)?;
        let mut updated: Vec<u64> = vec![&env];
        for cid in cat_ids.iter() {
            if cid != id {
                updated.push_back(cid);
            }
        }
        env.storage().persistent().set(&cat_key, &updated);
        env.storage()
            .persistent()
            .extend_ttl(&cat_key, MAX_TTL, MAX_TTL);

        env.events().publish(
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "deactivated"),
                id,
            ),
            (
                entry.provider.clone(),
                entry.name.clone(),
                entry.category.clone(),
                entry.reputation,
            ),
        );

        Ok(())
    }

    pub fn reactivate_service(env: Env, provider: Address, id: u64) {
        provider.require_auth();

        let mut entry: ServiceEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Service(id))
            .unwrap_or_else(|| {
                soroban_sdk::panic_with_error!(&env, RegistryError::ServiceNotFound)
            });

        if provider != entry.provider {
            soroban_sdk::panic_with_error!(&env, RegistryError::ProviderMismatch);
        }
        if active_service_exists(&env, &provider, &entry.endpoint) {
            soroban_sdk::panic_with_error!(&env, RegistryError::DuplicateActiveService);
        }

        entry.active = true;
        env.storage()
            .persistent()
            .set(&DataKey::Service(id), &entry);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Service(id), MAX_TTL, MAX_TTL);

        let endpoint_key =
            DataKey::ProviderEndpoint(entry.provider.clone(), entry.endpoint.clone());
        env.storage().persistent().set(&endpoint_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&endpoint_key, MAX_TTL, MAX_TTL);

        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceIds)
            .unwrap_or_else(|| vec![&env]);
        if !vec_contains_id(&ids, id) {
            ids.push_back(id);
            env.storage().persistent().set(&DataKey::ServiceIds, &ids);
        }
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ServiceIds, MAX_TTL, MAX_TTL);

        let cat_key = DataKey::ServiceIdsByCategory(entry.category.clone());
        let mut cat_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&cat_key)
            .unwrap_or_else(|| vec![&env]);
        if !vec_contains_id(&cat_ids, id) {
            cat_ids.push_back(id);
            env.storage().persistent().set(&cat_key, &cat_ids);
        }
        env.storage()
            .persistent()
            .extend_ttl(&cat_key, MAX_TTL, MAX_TTL);

        env.events().publish(
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "reactivated"),
                id,
            ),
            (
                entry.provider.clone(),
                entry.name.clone(),
                entry.category.clone(),
                entry.reputation,
            ),
        );
    }

    pub fn get_service_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Counter)
            .unwrap_or(0u64)
    }

    pub fn get_reputation_bounds(_env: Env) -> (i32, i32) {
        (MIN_REPUTATION, MAX_REPUTATION)
    }
}

#[cfg(test)]
mod test {
    // This crate is no_std; `format!` lives in `alloc` and must be imported
    // explicitly for the tests that build strings.
    extern crate alloc;
    use alloc::format;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _, MockAuth, MockAuthInvoke},
        Address, FromVal, IntoVal, String,
    };
    fn setup_service(
        env: &Env,
        id: u64,
        provider: &Address,
        category: &str,
        reputation: i32,
        active: bool,
    ) {
        let cat = String::from_str(env, category);
        let entry = ServiceEntry {
            id,
            name: String::from_str(env, "Test Service"),
            description: String::from_str(env, "Test Description"),
            endpoint: String::from_str(env, "https://test.com"),
            price_usdc: String::from_str(env, "10"),
            pay_to: String::from_str(env, "G_TEST_PAYMENT"),
            category: cat.clone(),
            provider: provider.clone(),
            reputation,
            active,
            registered_at: env.ledger().sequence() as u64,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Service(id), &entry);

        // Add to ServiceIds list
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceIds)
            .unwrap_or_else(|| vec![env]);
        ids.push_back(id);
        env.storage().persistent().set(&DataKey::ServiceIds, &ids);

        // Add to category index
        let mut cat_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ServiceIdsByCategory(cat.clone()))
            .unwrap_or_else(|| vec![env]);
        cat_ids.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::ServiceIdsByCategory(cat), &cat_ids);
    }

    #[test]
    fn test_list_services_empty() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            // Test with no services registered
            let result = LodestarRegistry::list_services(env.clone(), 0, 20, None);
            assert_eq!(result.len(), 0);
        });
    }

    #[test]
    fn test_list_services_single_entry() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);
            setup_service(&env, 1, &provider, "compute", 0, true);

            // Test listing all services
            let result = LodestarRegistry::list_services(env, 0, 20, None);
            assert_eq!(result.len(), 1);
            assert_eq!(result.get(0).unwrap().id, 1);
        });
    }

    #[test]
    fn test_list_services_reputation_sorting() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register three services with different reputations
            setup_service(&env, 1, &provider, "compute", 2, true);
            setup_service(&env, 2, &provider, "compute", 1, true);
            setup_service(&env, 3, &provider, "compute", -1, true);

            // Test sorting (should be descending: 1=2, 2=1, 3=-1)
            let result = LodestarRegistry::list_services(env, 0, 20, None);
            assert_eq!(result.len(), 3);
            assert_eq!(result.get(0).unwrap().id, 1);
            assert_eq!(result.get(1).unwrap().id, 2);
            assert_eq!(result.get(2).unwrap().id, 3);
        });
    }

    #[test]
    fn test_list_services_tied_reputation() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register three services with same reputation
            setup_service(&env, 1, &provider, "compute", 1, true);
            setup_service(&env, 2, &provider, "compute", 1, true);
            setup_service(&env, 3, &provider, "compute", 1, true);

            // Test that all are returned (order may vary for ties)
            let result = LodestarRegistry::list_services(env, 0, 20, None);
            assert_eq!(result.len(), 3);

            // Verify all have same reputation
            let rep1 = result.get(0).unwrap().reputation;
            let rep2 = result.get(1).unwrap().reputation;
            let rep3 = result.get(2).unwrap().reputation;
            assert_eq!(rep1, rep2);
            assert_eq!(rep2, rep3);
        });
    }

    #[test]
    fn test_list_services_category_filter() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register services in different categories
            setup_service(&env, 1, &provider, "compute", 0, true);
            setup_service(&env, 2, &provider, "weather", 0, true);
            setup_service(&env, 3, &provider, "compute", 0, true);

            // Test filtering by compute category
            let compute_result = LodestarRegistry::list_services(
                env.clone(),
                0,
                20,
                Some(String::from_str(&env, "compute")),
            );
            assert_eq!(compute_result.len(), 2);

            // Test filtering by weather category
            let weather_result = LodestarRegistry::list_services(
                env.clone(),
                0,
                20,
                Some(String::from_str(&env, "weather")),
            );
            assert_eq!(weather_result.len(), 1);
            assert_eq!(weather_result.get(0).unwrap().id, 2);

            // Test with no filter (should return all)
            let all_result = LodestarRegistry::list_services(env, 0, 20, None);
            assert_eq!(all_result.len(), 3);
        });
    }

    #[test]
    fn test_list_services_inactive_filtered() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register two services, one active and one inactive
            setup_service(&env, 1, &provider, "compute", 0, true);
            setup_service(&env, 2, &provider, "compute", 0, false);

            // Test that only active service is returned
            let result = LodestarRegistry::list_services(env, 0, 20, None);
            assert_eq!(result.len(), 1);
            assert_eq!(result.get(0).unwrap().id, 1);
        });
    }

    #[test]
    fn test_list_services_category_filter_with_reputation() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register services in different categories with different reputations
            setup_service(&env, 1, &provider, "compute", 1, true);
            setup_service(&env, 2, &provider, "compute", 2, true);
            setup_service(&env, 3, &provider, "storage", 1, true);

            // Test filtering by compute category with reputation sorting
            let compute_result = LodestarRegistry::list_services(
                env.clone(),
                0,
                20,
                Some(String::from_str(&env, "compute")),
            );
            assert_eq!(compute_result.len(), 2);
            assert_eq!(compute_result.get(0).unwrap().id, 2); // Higher reputation
            assert_eq!(compute_result.get(1).unwrap().id, 1);
        });
    }

    #[test]
    fn test_list_services_nonexistent_category() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register a service
            setup_service(&env, 1, &provider, "compute", 0, true);

            // Test filtering by non-existent category
            let result = LodestarRegistry::list_services(
                env.clone(),
                0,
                20,
                Some(String::from_str(&env, "nonexistent")),
            );
            assert_eq!(result.len(), 0);

            let long_category = "A".repeat(33);
            let result = LodestarRegistry::list_services(
                env.clone(),
                0,
                20,
                Some(String::from_str(&env, &long_category)),
            );
            assert_eq!(result.len(), 0);
        });
    }

    #[test]
    fn test_list_services_page_basic() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register 5 active services
            for i in 1..=5 {
                setup_service(&env, i, &provider, "compute", 0, true);
            }

            // Test first page with page_size=3
            let page0 = LodestarRegistry::list_services_page(env.clone(), 0, 3);
            assert_eq!(page0.len(), 3);
            assert_eq!(page0.get(0).unwrap().id, 1);
            assert_eq!(page0.get(1).unwrap().id, 2);
            assert_eq!(page0.get(2).unwrap().id, 3);

            // Test second page with page_size=3
            let page1 = LodestarRegistry::list_services_page(env.clone(), 1, 3);
            assert_eq!(page1.len(), 2); // Only 2 remaining services
            assert_eq!(page1.get(0).unwrap().id, 4);
            assert_eq!(page1.get(1).unwrap().id, 5);

            // Test beyond available pages
            let page2 = LodestarRegistry::list_services_page(env, 2, 3);
            assert_eq!(page2.len(), 0);
        });
    }

    #[test]
    fn test_list_services_page_mixed_active_inactive() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register services with alternating active/inactive pattern
            // IDs 1,3,5,7,9 are active; IDs 2,4,6,8,10 are inactive
            for i in 1..=10 {
                let active = i % 2 == 1; // odd IDs are active
                setup_service(&env, i, &provider, "compute", 0, active);
            }

            // Test first page with page_size=3
            // Should get services 1, 3, 5 (first 3 active services)
            let page0 = LodestarRegistry::list_services_page(env.clone(), 0, 3);
            assert_eq!(page0.len(), 3);
            assert_eq!(page0.get(0).unwrap().id, 1);
            assert_eq!(page0.get(1).unwrap().id, 3);
            assert_eq!(page0.get(2).unwrap().id, 5);

            // Test second page with page_size=3
            // Should get services 7, 9 (next 2 active services, only 2 remaining)
            let page1 = LodestarRegistry::list_services_page(env.clone(), 1, 3);
            assert_eq!(page1.len(), 2);
            assert_eq!(page1.get(0).unwrap().id, 7);
            assert_eq!(page1.get(1).unwrap().id, 9);

            // Test third page - should be empty
            let page2 = LodestarRegistry::list_services_page(env, 2, 3);
            assert_eq!(page2.len(), 0);
        });
    }

    #[test]
    fn test_list_services_page_all_inactive() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register 3 inactive services
            for i in 1..=3 {
                setup_service(&env, i, &provider, "compute", 0, false);
            }

            // Test first page - should be empty since all services are inactive
            let page0 = LodestarRegistry::list_services_page(env, 0, 3);
            assert_eq!(page0.len(), 0);
        });
    }

    #[test]
    fn test_list_services_page_empty_registry() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            // Test with no services registered
            let page0 = LodestarRegistry::list_services_page(env, 0, 3);
            assert_eq!(page0.len(), 0);
        });
    }

    #[test]
    fn test_list_services_page_parameter_bounds() {
        let env = Env::default();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));

        env.clone().as_contract(&contract_id, || {
            let provider = Address::generate(&env);

            // Register 5 active services
            for i in 1..=5 {
                setup_service(&env, i, &provider, "compute", 0, true);
            }

            // Test page_size clamping - should clamp 25 to 20
            let result = LodestarRegistry::list_services_page(env.clone(), 0, 25);
            assert_eq!(result.len(), 5); // All available services

            // Test page_size clamping - should clamp 0 to 1
            let result = LodestarRegistry::list_services_page(env, 0, 0);
            assert_eq!(result.len(), 1); // One service due to min clamp
        });
    }

    // ── list_services authorization posture (#732) ────────────────────────────
    //
    // `list_services` takes no `Address` argument and calls no `require_auth`, so
    // it is a permissionless read. The tests below pin that posture from both
    // sides: the read must keep working for a caller who signs nothing, and it
    // must keep working for a caller whose signature comes from an address with
    // no relationship to the registry. A future refactor that adds a hidden auth
    // requirement (or drops a state write into a read path) fails here.

    #[test]
    fn test_list_services_succeeds_with_no_auths() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let id = register_a_service(&env, &registry);

        // Drop every auth mock, so nothing is left to authorise the read with.
        env.set_auths(&[]);

        let services = registry.list_services(&0, &20, &None);
        assert_eq!(services.len(), 1);
        assert_eq!(services.get(0).unwrap().id, id);
        assert_eq!(
            services.get(0).unwrap().category,
            String::from_str(&env, "compute")
        );

        // A read that demands no authorization must not consume any either.
        assert!(
            env.auths().is_empty(),
            "list_services must not require or record an authorization",
        );
    }

    #[test]
    fn test_list_services_succeeds_for_any_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, _agents) = deploy_registry_with_id(&env);
        let provider = Address::generate(&env);
        let first = register_service_with_provider_and_endpoint(
            &env,
            &registry,
            &provider,
            &String::from_str(&env, "https://one.test"),
        );
        let second = register_service_with_provider_and_endpoint(
            &env,
            &registry,
            &provider,
            &String::from_str(&env, "https://two.test"),
        );

        // The anonymous read, with no auths available at all.
        env.set_auths(&[]);
        let anonymous = registry.list_services(&0, &20, &None);
        assert_eq!(anonymous.len(), 2);

        // The same read signed by an address that is neither the provider nor
        // anything the registry knows about.
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &registry_id,
                fn_name: "list_services",
                args: (0u32, 20u32, None::<String>).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let signed_by_stranger = registry.list_services(&0, &20, &None);

        // The signer's identity neither gates the call nor changes the result.
        for (i, expected) in [first, second].iter().enumerate() {
            assert_eq!(anonymous.get(i as u32).unwrap().id, *expected);
            assert_eq!(signed_by_stranger.get(i as u32).unwrap().id, *expected);
        }
        assert_eq!(signed_by_stranger.get(0).unwrap().provider, provider);
    }

    #[test]
    fn test_list_services_does_not_mutate_state() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, _agents) = deploy_registry_with_id(&env);
        let provider = Address::generate(&env);
        let first = register_service_with_provider_and_endpoint(
            &env,
            &registry,
            &provider,
            &String::from_str(&env, "https://one.test"),
        );
        let second = register_service_with_provider_and_endpoint(
            &env,
            &registry,
            &provider,
            &String::from_str(&env, "https://two.test"),
        );
        let events_before = env.events().all().len();
        let sequence_before = env.ledger().sequence();

        // No auths: if a read path ever grows a require_auth, this panics.
        env.set_auths(&[]);
        let listed = registry.list_services(&0, &20, &None);
        let by_category = registry.list_services(&0, &20, &Some(String::from_str(&env, "compute")));
        let empty_page = registry.list_services(&99, &20, &None);
        assert_eq!(listed.len(), 2);
        assert_eq!(by_category.len(), 2);
        assert_eq!(empty_page.len(), 0);

        // Storage and the ledger are untouched by the reads above.
        assert_eq!(registry.get_service_count(), 2);
        let ids: Vec<u64> = env.clone().as_contract(&registry_id, || {
            env.storage()
                .persistent()
                .get(&DataKey::ServiceIds)
                .unwrap_or_else(|| vec![&env])
        });
        assert_eq!(ids, vec![&env, first, second]);
        let category_ids: Vec<u64> = env.clone().as_contract(&registry_id, || {
            env.storage()
                .persistent()
                .get(&DataKey::ServiceIdsByCategory(String::from_str(
                    &env, "compute",
                )))
                .unwrap_or_else(|| vec![&env])
        });
        assert_eq!(category_ids, vec![&env, first, second]);
        env.clone().as_contract(&registry_id, || {
            assert!(active_service_exists(
                &env,
                &provider,
                &String::from_str(&env, "https://one.test")
            ));
        });
        // The reads above emitted no events of their own, and did not advance the
        // ledger. (Registering emitted one event each; a read must add none.)
        assert_eq!(events_before, 1);
        assert!(env.events().all().is_empty());
        assert_eq!(env.ledger().sequence(), sequence_before);

        // Reading twice is idempotent: nothing accumulates, nothing is consumed.
        let repeated = registry.list_services(&0, &20, &None);
        for (i, expected) in [first, second].iter().enumerate() {
            assert_eq!(repeated.get(i as u32).unwrap().id, *expected);
        }
        assert_eq!(registry.get_service_count(), 2);
    }

    // ── update_reputation authorization tests ─────────────────────────────────

    #[test]
    fn test_reactivate_service_restores_visibility_and_preserves_reputation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        env.clone().as_contract(&contract_id, || {
            setup_service(&env, 1, &provider, "compute", 42, true);
        });

        registry.deactivate_service(&provider, &1);
        assert_eq!(registry.get_service(&1).reputation, 42);
        assert!(!registry.get_service(&1).active);
        assert_eq!(registry.list_services(&0, &20, &None).len(), 0);
        assert_eq!(
            registry
                .list_services(&0, &20, &Some(String::from_str(&env, "compute")))
                .len(),
            0
        );

        registry.reactivate_service(&provider, &1);
        let service = registry.get_service(&1);
        assert!(service.active);
        assert_eq!(service.reputation, 42);
        assert!(active_service_exists(&env, &provider, &service.endpoint));

        let all = registry.list_services(&0, &20, &None);
        assert_eq!(all.len(), 1);
        assert_eq!(all.get(0).unwrap().id, 1);

        let by_category = registry.list_services(&0, &20, &Some(String::from_str(&env, "compute")));
        assert_eq!(by_category.len(), 1);
        assert_eq!(by_category.get(0).unwrap().id, 1);

        let events = env.events().all();
        assert_eq!(events.len(), 2);
        let event = events.get(1).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "reactivated"),
                1u64,
            )
                .into_val(&env)
        );
        // Payload is self-sufficient: no `get_service` read is needed to know
        // where the service belongs or what it looks like (#734).
        assert_eq!(
            <(Address, String, String, i32)>::from_val(&env, &event.2),
            (
                provider,
                String::from_str(&env, "Test Service"),
                String::from_str(&env, "compute"),
                42,
            )
        );
    }

    #[test]
    fn test_reactivate_service_emits_reactivated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        // Seed an inactive service directly so reactivation is the only
        // invocation under test that can publish an event.
        env.clone().as_contract(&contract_id, || {
            setup_service(&env, 1, &provider, "compute", 42, false);
        });

        registry.reactivate_service(&provider, &1);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let event = events.get(0).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "reactivated"),
                1u64,
            )
                .into_val(&env)
        );
        assert_eq!(
            <(Address, String, String, i32)>::from_val(&env, &event.2),
            (
                provider,
                String::from_str(&env, "Test Service"),
                String::from_str(&env, "compute"),
                42,
            )
        );
    }

    /// #734 asks that off-chain consumers stop polling the listing, so pin the
    /// read path as event-free. `list_services_page` only reads storage; an event
    /// published from it would be visible to the caller alone (simulation events
    /// are never written to a ledger) while costing every caller.
    #[test]
    fn test_list_services_page_emits_no_events() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        register_a_service(&env, &registry);

        let before = env.events().all().len();
        assert_eq!(before, 1, "setup emits exactly one registration event");

        let page = registry.list_services_page(&0, &20);
        let after = env.events().all().len();

        assert_eq!(page.len(), 1);
        // The invocation that served the page contributed no event at all.
        assert_eq!(after, 0, "list_services_page must stay read-only");
    }

    /// Fold the events of the most recent top-level invocation into a local
    /// replica of the listed services. An off-chain consumer sees each
    /// transaction's events once, so this is called after every mutation; the
    /// updates are idempotent, so replaying an event is harmless.
    fn ingest_events(env: &Env, order: &mut Vec<u64>, active: &mut Vec<bool>) {
        let events = env.events().all();
        for i in 0..events.len() {
            let event = events.get(i).unwrap();
            let action: Symbol = Symbol::from_val(env, &event.1.get(1).unwrap());
            let registered = action == Symbol::new(env, "registered");
            let deactivated = action == Symbol::new(env, "deactivated");
            let reactivated = action == Symbol::new(env, "reactivated");
            if !registered && !deactivated && !reactivated {
                // e.g. a reputation vote: does not change what is listed.
                continue;
            }

            let id: u64 = u64::from_val(env, &event.1.get(2).unwrap());
            let mut idx: u32 = 0;
            let mut seen = false;
            while idx < order.len() {
                if order.get(idx).unwrap() == id {
                    seen = true;
                    break;
                }
                idx += 1;
            }
            if seen {
                active.set(idx, !deactivated);
            } else {
                order.push_back(id);
                active.push_back(!deactivated);
            }
        }
    }

    #[test]
    fn test_list_services_page_matches_an_event_only_replica() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);

        let mut order: Vec<u64> = vec![&env];
        let mut active: Vec<bool> = vec![&env];
        let mut providers: Vec<Address> = vec![&env];
        let mut ids: Vec<u64> = vec![&env];
        for _ in 0..5 {
            let provider = Address::generate(&env);
            let id = registry.register_service(
                &provider,
                &String::from_str(&env, "Test Service"),
                &String::from_str(&env, "Test Description"),
                &String::from_str(&env, "https://test.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_TEST_PAYMENT"),
                &String::from_str(&env, "compute"),
            );
            providers.push_back(provider);
            ids.push_back(id);
            ingest_events(&env, &mut order, &mut active);
        }

        // Service 3 is deactivated; service 2 is deactivated and then
        // reactivated; service 2 also gains reputation, which must not disturb
        // the replica because reputation does not reorder `list_services_page`.
        let second = ids.get(1).unwrap();
        registry.deactivate_service(&providers.get(2).unwrap(), &ids.get(2).unwrap());
        ingest_events(&env, &mut order, &mut active);
        registry.deactivate_service(&providers.get(1).unwrap(), &second);
        ingest_events(&env, &mut order, &mut active);
        registry.reactivate_service(&providers.get(1).unwrap(), &second);
        ingest_events(&env, &mut order, &mut active);

        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);
        registry.update_reputation(&second, &true, &agent);
        ingest_events(&env, &mut order, &mut active);

        let mut replica: Vec<u64> = vec![&env];
        let mut i: u32 = 0;
        while i < order.len() {
            if active.get(i).unwrap() {
                replica.push_back(order.get(i).unwrap());
            }
            i += 1;
        }
        assert_eq!(replica.len(), 4, "only service 3 stays inactive");

        let mut listed: Vec<u64> = vec![&env];
        for page in 0..2u32 {
            let entries = registry.list_services_page(&page, &2);
            for entry in entries.iter() {
                listed.push_back(entry.id);
            }
        }

        // The contract listing agrees with the event-only replica, so no
        // follow-up read was needed to know what the page contains.
        assert_eq!(replica, listed);
    }

    #[test]
    fn test_reactivate_service_rejects_non_provider() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &contract_id);
        let provider = Address::generate(&env);
        let other = Address::generate(&env);

        env.clone().as_contract(&contract_id, || {
            setup_service(&env, 1, &provider, "compute", 42, false);
        });

        let result = registry.try_reactivate_service(&other, &1);
        assert_eq!(result, Err(Ok(soroban_sdk::Error::from_contract_error(8))));
        let service = registry.get_service(&1);
        assert!(!service.active);
        assert_eq!(service.reputation, 42);
    }

    #[test]
    fn test_reactivate_service_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        let result = registry.try_reactivate_service(&provider, &999);
        assert_eq!(result, Err(Ok(soroban_sdk::Error::from_contract_error(4))));
    }

    #[test]
    fn test_reactivate_service_duplicate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &contract_id);
        let provider = Address::generate(&env);

        env.clone().as_contract(&contract_id, || {
            setup_service(&env, 1, &provider, "compute", 42, false); // Deactivated
            setup_service(&env, 2, &provider, "compute", 42, true); // Active duplicate (same provider, endpoint)
        });

        // Try to reactivate the first one, it should fail with DuplicateActiveService (3)
        let result = registry.try_reactivate_service(&provider, &1);
        assert_eq!(result, Err(Ok(soroban_sdk::Error::from_contract_error(3))));
    }
    // Minimal stand-in for the LodestarAgents contract exposing just the
    // `is_registered` entrypoint the registry cross-calls.
    #[contract]
    pub struct MockAgents;

    #[contractimpl]
    impl MockAgents {
        pub fn set_registered(env: Env, agent: Address, registered: bool) {
            env.storage().persistent().set(&agent, &registered);
        }

        pub fn is_registered(env: Env, agent_address: Address) -> bool {
            env.storage()
                .persistent()
                .get(&agent_address)
                .unwrap_or(false)
        }
    }

    fn deploy_registry_with_id(
        env: &Env,
    ) -> (
        Address,
        LodestarRegistryClient<'static>,
        MockAgentsClient<'static>,
    ) {
        let agents_id = env.register(MockAgents, ());
        let agents = MockAgentsClient::new(env, &agents_id);

        let registry_id = env.register(LodestarRegistry, (agents_id.clone(),));
        let registry = LodestarRegistryClient::new(env, &registry_id);

        (registry_id, registry, agents)
    }

    fn deploy_registry(env: &Env) -> (LodestarRegistryClient<'static>, MockAgentsClient<'static>) {
        let (_, registry, agents) = deploy_registry_with_id(env);
        (registry, agents)
    }

    fn register_a_service(env: &Env, registry: &LodestarRegistryClient) -> u64 {
        let provider = Address::generate(env);
        registry.register_service(
            &provider,
            &String::from_str(env, "Test Service"),
            &String::from_str(env, "Test Description"),
            &String::from_str(env, "https://test.com"),
            &String::from_str(env, "10"),
            &String::from_str(env, "G_TEST_PAYMENT"),
            &String::from_str(env, "compute"),
        )
    }

    fn register_service_with_provider_and_endpoint(
        env: &Env,
        registry: &LodestarRegistryClient,
        provider: &Address,
        endpoint: &String,
    ) -> u64 {
        registry.register_service(
            provider,
            &String::from_str(env, "Test Service"),
            &String::from_str(env, "Test Description"),
            endpoint,
            &String::from_str(env, "10"),
            &String::from_str(env, "G_TEST_PAYMENT"),
            &String::from_str(env, "compute"),
        )
    }

    #[test]
    fn test_register_service_emits_registered_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);
        let name = String::from_str(&env, "Test Service");
        let description = String::from_str(&env, "Test Description");
        let endpoint = String::from_str(&env, "https://test.com");
        let price = String::from_str(&env, "10");
        let pay_to = String::from_str(&env, "G_TEST_PAYMENT");
        let category = String::from_str(&env, "compute");

        let id = registry.register_service(
            &provider,
            &name,
            &description,
            &endpoint,
            &price,
            &pay_to,
            &category,
        );

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let event = events.get(0).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "registered"),
                id,
            )
                .into_val(&env)
        );
        assert_eq!(
            <(Address, String, String, String, String, String, String)>::from_val(&env, &event.2),
            (
                provider,
                name,
                description,
                endpoint,
                category,
                price,
                pay_to
            )
        );
    }

    #[test]
    fn test_update_reputation_emits_reputation_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let id = register_a_service(&env, &registry);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        registry.update_reputation(&id, &true, &agent);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let event = events.get(0).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "reputation"),
                id,
            )
                .into_val(&env)
        );
        assert_eq!(
            <(Address, bool, i32)>::from_val(&env, &event.2),
            (agent, true, 1i32)
        );
    }

    #[test]
    fn test_deactivate_service_emits_deactivated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);
        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "Test Service"),
            &String::from_str(&env, "Test Description"),
            &String::from_str(&env, "https://test.com"),
            &String::from_str(&env, "10"),
            &String::from_str(&env, "G_TEST_PAYMENT"),
            &String::from_str(&env, "compute"),
        );

        registry.deactivate_service(&provider, &id);

        let events = env.events().all();
        assert_eq!(events.len(), 1);
        let event = events.get(0).unwrap();
        assert_eq!(
            event.1,
            (
                Symbol::new(&env, "registry"),
                Symbol::new(&env, "deactivated"),
                id,
            )
                .into_val(&env)
        );
        // Same self-sufficient payload as `reactivated` (#734).
        assert_eq!(
            <(Address, String, String, i32)>::from_val(&env, &event.2),
            (
                provider,
                String::from_str(&env, "Test Service"),
                String::from_str(&env, "compute"),
                0,
            )
        );
    }

    #[test]
    fn test_deactivate_service_preserves_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);
        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "Test Service"),
            &String::from_str(&env, "Test Description"),
            &String::from_str(&env, "https://test.com"),
            &String::from_str(&env, "10"),
            &String::from_str(&env, "G_TEST_PAYMENT"),
            &String::from_str(&env, "compute"),
        );

        // Advance ledger by somewhat less than MAX_TTL
        env.ledger()
            .with_mut(|li| li.sequence_number += 3110400 - 100);

        // This should bump the TTL again
        registry.deactivate_service(&provider, &id);

        // Advance ledger past the original threshold.
        // If TTL was not bumped during deactivate_service, this would archive it
        // and retrieving the service entry would fail or return an archived state.
        env.ledger().with_mut(|li| li.sequence_number += 150);

        // Assert readability
        let entry = registry.get_service(&id);
        assert_eq!(entry.active, false);
    }

    /// `set_registered` on the agents contract is exercised through the
    /// registry's `update_reputation` path. Every persistent key touched by
    /// `update_reputation` must have its TTL extended, otherwise an entry can
    /// be archived between writes and a later read looks like data loss.
    #[test]
    fn test_update_reputation_extends_ttl_on_all_touched_keys() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let id = register_a_service(&env, &registry);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        // Advance to just before the original TTL would expire.
        env.ledger()
            .with_mut(|li| li.sequence_number += MAX_TTL - 1);

        // This vote must bump DataKey::AgentsContract, DataKey::Service(id),
        // and DataKey::LastVote(id, agent).
        registry.update_reputation(&id, &true, &agent);
        assert_eq!(registry.get_service(&id).reputation, 1);

        // Advance past the original registration TTL. Without the extend_ttl
        // calls the entries would now be archived and the next read would fail.
        env.ledger().with_mut(|li| li.sequence_number += 2);

        // The service entry must still be readable after the original TTL window.
        let entry = registry.get_service(&id);
        assert_eq!(entry.id, id);
        assert_eq!(entry.reputation, 1);

        // The agents contract trust anchor must still be readable too.
        assert!(registry.get_agents_contract().is_some());
    }

    #[test]
    fn test_register_service_rejects_non_provider_auth() {
        let env = Env::default();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        let provider = Address::generate(&env);
        let different_signer = Address::generate(&env);
        let name = String::from_str(&env, "Test Service");
        let description = String::from_str(&env, "Test Description");
        let endpoint = String::from_str(&env, "https://test.com");
        let price = String::from_str(&env, "10");
        let pay_to = String::from_str(&env, "G_TEST_PAYMENT");
        let category = String::from_str(&env, "compute");

        env.mock_auths(&[MockAuth {
            address: &different_signer,
            invoke: &MockAuthInvoke {
                contract: &registry_id,
                fn_name: "register_service",
                args: (
                    provider.clone(),
                    name.clone(),
                    description.clone(),
                    endpoint.clone(),
                    price.clone(),
                    pay_to.clone(),
                    category.clone(),
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }]);

        assert!(registry
            .try_register_service(
                &provider,
                &name,
                &description,
                &endpoint,
                &price,
                &pay_to,
                &category,
            )
            .is_err());
        assert_eq!(registry.get_service_count(), 0);
    }

    #[test]
    fn test_update_reputation_requires_registered_agent() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, agents) = deploy_registry_with_id(&env);
        let id = register_a_service(&env, &registry);

        // An address with no agent record cannot vote.
        let stranger = Address::generate(&env);
        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::update_reputation(env.clone(), id, true, stranger.clone())
        });
        assert!(matches!(
            result,
            Err(RegistryError::CallerNotRegisteredAgent)
        ));
        assert_eq!(registry.get_service(&id).reputation, 0);

        // Once registered, the same address may vote.
        agents.set_registered(&stranger, &true);
        registry.update_reputation(&id, &true, &stranger);
        assert_eq!(registry.get_service(&id).reputation, 1);
    }

    #[test]
    fn test_update_reputation_positive_and_negative() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let id = register_a_service(&env, &registry);

        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        registry.update_reputation(&id, &true, &agent);
        assert_eq!(registry.get_service(&id).reputation, 1);

        // Advance past the cooldown, then a negative vote brings it back to 0.
        env.ledger()
            .with_mut(|li| li.sequence_number += VOTE_COOLDOWN_LEDGERS as u32 + 1);
        registry.update_reputation(&id, &false, &agent);
        assert_eq!(registry.get_service(&id).reputation, 0);
    }

    #[test]
    fn test_update_reputation_cooldown_blocks_rapid_repeat_votes() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, agents) = deploy_registry_with_id(&env);
        let id = register_a_service(&env, &registry);

        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        // First vote succeeds.
        registry.update_reputation(&id, &true, &agent);
        assert_eq!(registry.get_service(&id).reputation, 1);

        // A second vote within the cooldown window is rejected — no inflation.
        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::update_reputation(env.clone(), id, true, agent.clone())
        });
        assert!(matches!(result, Err(RegistryError::ReputationVoteCooldown)));
        assert_eq!(registry.get_service(&id).reputation, 1);

        // After the cooldown elapses, voting is allowed again.
        env.ledger()
            .with_mut(|li| li.sequence_number += VOTE_COOLDOWN_LEDGERS as u32 + 1);
        registry.update_reputation(&id, &true, &agent);
        assert_eq!(registry.get_service(&id).reputation, 2);
    }

    #[test]
    fn test_cooldown_is_per_agent_and_per_service() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let id1 = register_a_service(&env, &registry);
        let id2 = register_a_service(&env, &registry);

        let agent_a = Address::generate(&env);
        let agent_b = Address::generate(&env);
        agents.set_registered(&agent_a, &true);
        agents.set_registered(&agent_b, &true);

        // Agent A votes on service 1.
        registry.update_reputation(&id1, &true, &agent_a);
        // A different agent voting on the same service is unaffected by A's cooldown.
        registry.update_reputation(&id1, &true, &agent_b);
        // Agent A voting on a different service is also unaffected.
        registry.update_reputation(&id2, &true, &agent_a);

        assert_eq!(registry.get_service(&id1).reputation, 2);
        assert_eq!(registry.get_service(&id2).reputation, 1);
    }

    #[test]
    fn test_constructor_sets_agents_contract_immutably() {
        let env = Env::default();
        // The agents contract is fixed at deployment by the constructor — there is
        // no post-deploy setter, so the trust anchor can never be swapped.
        let agents = Address::generate(&env);
        let registry_id = env.register(LodestarRegistry, (agents.clone(),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);
        assert_eq!(registry.get_agents_contract(), Some(agents));
    }

    #[test]
    fn test_update_reputation_requires_caller_auth() {
        // Regression guard for #104: without env.mock_all_auths(), the
        // caller.require_auth() in update_reputation must reject the vote. This
        // fails if require_auth() is ever removed, even though the agent is
        // registered and outside any cooldown.
        let env = Env::default();

        // Build the registry + a service + a registered agent under mocked auth…
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let id = register_a_service(&env, &registry);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        // …then drop all auth mocks so require_auth is genuinely enforced.
        env.set_auths(&[]);
        assert!(registry.try_update_reputation(&id, &true, &agent).is_err());
        assert_eq!(registry.get_service(&id).reputation, 0);
    }

    #[test]
    fn test_update_reputation_clamped_at_max() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let agents = MockAgentsClient::new(&env, &agents_id);
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        let provider = Address::generate(&env);
        env.clone().as_contract(&registry_id, || {
            setup_service(&env, 1, &provider, "compute", MAX_REPUTATION - 1, true);
        });

        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        registry.update_reputation(&1u64, &true, &agent);
        assert_eq!(registry.get_service(&1u64).reputation, MAX_REPUTATION);

        env.ledger()
            .with_mut(|li| li.sequence_number += VOTE_COOLDOWN_LEDGERS as u32 + 1);
        registry.update_reputation(&1u64, &true, &agent);
        assert_eq!(registry.get_service(&1u64).reputation, MAX_REPUTATION);
    }

    #[test]
    fn test_update_reputation_clamped_at_min() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let agents = MockAgentsClient::new(&env, &agents_id);
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        let provider = Address::generate(&env);
        env.clone().as_contract(&registry_id, || {
            setup_service(&env, 1, &provider, "compute", MIN_REPUTATION + 1, true);
        });

        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        registry.update_reputation(&1u64, &false, &agent);
        assert_eq!(registry.get_service(&1u64).reputation, MIN_REPUTATION);

        env.ledger()
            .with_mut(|li| li.sequence_number += VOTE_COOLDOWN_LEDGERS as u32 + 1);
        registry.update_reputation(&1u64, &false, &agent);
        assert_eq!(registry.get_service(&1u64).reputation, MIN_REPUTATION);
    }

    // ── update_reputation boundary tests (#736) ───────────────────────────
    //
    // Each table below pins one value on each side of a threshold where
    // update_reputation changes behaviour. Every test uses a single Env so it
    // records exactly one snapshot under test_snapshots/test/, making changes
    // to storage writes, events or auth trees visible in review.

    #[test]
    fn test_update_reputation_boundaries_around_clamps() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, agents) = deploy_registry_with_id(&env);
        let provider = Address::generate(&env);

        // (starting reputation, positive vote, expected reputation)
        let cases = [
            // Upper clamp at MAX_REPUTATION.
            (MAX_REPUTATION - 2, true, MAX_REPUTATION - 1),
            (MAX_REPUTATION - 1, true, MAX_REPUTATION),
            (MAX_REPUTATION, true, MAX_REPUTATION),
            (MAX_REPUTATION, false, MAX_REPUTATION - 1),
            // Lower clamp at MIN_REPUTATION.
            (MIN_REPUTATION + 2, false, MIN_REPUTATION + 1),
            (MIN_REPUTATION + 1, false, MIN_REPUTATION),
            (MIN_REPUTATION, false, MIN_REPUTATION),
            (MIN_REPUTATION, true, MIN_REPUTATION + 1),
            // Zero, where the sign flips.
            (-1, true, 0),
            (0, true, 1),
            (0, false, -1),
            (1, false, 0),
        ];

        for (i, (start, positive, expected)) in cases.iter().enumerate() {
            // A fresh service and agent per case keeps the cooldown out of play.
            let id = i as u64 + 1;
            env.clone().as_contract(&registry_id, || {
                setup_service(&env, id, &provider, "compute", *start, true);
            });
            let agent = Address::generate(&env);
            agents.set_registered(&agent, &true);

            registry.update_reputation(&id, positive, &agent);
            assert_eq!(
                registry.get_service(&id).reputation,
                *expected,
                "start={} positive={}",
                start,
                positive
            );
        }
    }

    #[test]
    fn test_update_reputation_cooldown_boundary() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, agents) = deploy_registry_with_id(&env);
        let provider = Address::generate(&env);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        let cooldown = VOTE_COOLDOWN_LEDGERS as u32;
        // (ledgers elapsed since the previous vote, second vote accepted)
        let cases = [
            (0, false),
            (1, false),
            (cooldown - 1, false),
            (cooldown, true),
            (cooldown + 1, true),
        ];

        // Ledger 0 covers a first vote at the lowest possible sequence; the
        // second base covers a vote recorded at a non-zero sequence.
        let mut next_id = 1u64;
        for base in [0u32, 1_000] {
            env.ledger().with_mut(|li| li.sequence_number = base);

            // One service per case so each has its own LastVote entry, all
            // first voted on at `base`.
            let first_id = next_id;
            for _ in cases.iter() {
                env.clone().as_contract(&registry_id, || {
                    setup_service(&env, next_id, &provider, "compute", 0, true);
                });
                registry.update_reputation(&next_id, &true, &agent);
                next_id += 1;
            }

            for (i, (elapsed, accepted)) in cases.iter().enumerate() {
                let id = first_id + i as u64;
                env.ledger()
                    .with_mut(|li| li.sequence_number = base + elapsed);

                let result = registry.try_update_reputation(&id, &true, &agent);
                if *accepted {
                    assert_eq!(result, Ok(Ok(())), "base={} elapsed={}", base, elapsed);
                    assert_eq!(registry.get_service(&id).reputation, 2);
                } else {
                    assert_eq!(
                        result,
                        Err(Ok(RegistryError::ReputationVoteCooldown)),
                        "base={} elapsed={}",
                        base,
                        elapsed
                    );
                    assert_eq!(registry.get_service(&id).reputation, 1);
                }
            }
        }
    }

    #[test]
    fn test_update_reputation_service_id_boundaries() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, agents) = deploy_registry(&env);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        // Empty registry: no id is votable, including the extremes.
        for id in [0u64, 1, u64::MAX] {
            assert_eq!(
                registry.try_update_reputation(&id, &true, &agent),
                Err(Ok(RegistryError::ServiceNotFound)),
                "empty registry, id={}",
                id
            );
        }

        // Ids are assigned from 1, so 0 and last + 1 sit either side of the
        // valid range.
        let id = register_a_service(&env, &registry);
        assert_eq!(id, 1);
        for missing in [0u64, id + 1, u64::MAX] {
            assert_eq!(
                registry.try_update_reputation(&missing, &true, &agent),
                Err(Ok(RegistryError::ServiceNotFound)),
                "id={}",
                missing
            );
        }
        assert_eq!(
            registry.try_update_reputation(&id, &true, &agent),
            Ok(Ok(()))
        );
        assert_eq!(registry.get_service(&id).reputation, 1);
    }

    // ── register_service input validation tests ───────────────────────────

    #[test]
    fn test_register_service_rejects_name_too_short() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "AB"),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::InvalidName))
        ));
    }

    #[test]
    fn test_register_service_rejects_name_too_long() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let long_name = "A".repeat(65);
        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, &long_name),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::InvalidName))
        ));
    }

    #[test]
    fn test_register_service_rejects_description_too_short() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, "123456789"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::InvalidDescription))
        ));
    }

    #[test]
    fn test_register_service_rejects_description_too_long() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let long_desc = "A".repeat(257);
        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, &long_desc),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::InvalidDescription))
        ));
    }

    #[test]
    fn test_register_service_accepts_minimum_boundaries() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        // name = 3, description = 10 (minimum boundaries)
        assert!(registry
            .try_register_service(
                &provider,
                &String::from_str(&env, "ABC"),
                &String::from_str(&env, "1234567890"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            )
            .unwrap()
            .is_ok());
    }

    #[test]
    fn test_register_service_accepts_maximum_boundaries() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let long_name = "A".repeat(64);
        let long_desc = "A".repeat(256);
        // name = 64, description = 256 (maximum boundaries)
        assert!(registry
            .try_register_service(
                &provider,
                &String::from_str(&env, &long_name),
                &String::from_str(&env, &long_desc),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            )
            .unwrap()
            .is_ok());
    }

    #[test]
    fn test_get_service_returns_typed_not_found_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, _registry, _agents) = deploy_registry_with_id(&env);

        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::get_service(env.clone(), 999)
        });
        assert!(matches!(result, Err(RegistryError::ServiceNotFound)));
    }

    #[test]
    fn test_register_service_returns_typed_duplicate_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);
        let endpoint = String::from_str(&env, "https://example.com");

        registry.register_service(
            &provider,
            &String::from_str(&env, "First Service"),
            &String::from_str(&env, "Valid description long enough"),
            &endpoint,
            &String::from_str(&env, "10"),
            &String::from_str(&env, "G_PAYMENT"),
            &String::from_str(&env, "compute"),
        );

        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Second Service"),
                &String::from_str(&env, "Another valid description"),
                &endpoint,
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::DuplicateActiveService))
        ));
    }

    #[test]
    fn test_update_reputation_returns_typed_missing_service_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, _registry, agents) = deploy_registry_with_id(&env);
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);

        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::update_reputation(env.clone(), 999u64, true, agent.clone())
        });
        assert!(matches!(result, Err(RegistryError::ServiceNotFound)));
    }

    #[test]
    fn test_update_reputation_returns_typed_missing_agents_config_error() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let provider = Address::generate(&env);
        let agent = Address::generate(&env);

        env.clone().as_contract(&registry_id, || {
            setup_service(&env, 1, &provider, "compute", 0, true);
            env.storage().persistent().remove(&DataKey::AgentsContract);
        });

        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::update_reputation(env.clone(), 1u64, true, agent.clone())
        });
        assert!(matches!(
            result,
            Err(RegistryError::AgentsContractNotConfigured)
        ));
    }

    #[test]
    fn test_deactivate_service_returns_typed_provider_mismatch_error() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let provider = Address::generate(&env);
        let other = Address::generate(&env);

        env.clone().as_contract(&registry_id, || {
            setup_service(&env, 1, &provider, "compute", 0, true);
        });

        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::deactivate_service(env.clone(), other.clone(), 1u64)
        });
        assert!(matches!(result, Err(RegistryError::ProviderMismatch)));
    }

    #[test]
    fn test_deactivate_service_returns_typed_missing_category_index_error() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id,));
        let provider = Address::generate(&env);
        let entry = ServiceEntry {
            id: 1,
            name: String::from_str(&env, "Test Service"),
            description: String::from_str(&env, "Valid description"),
            endpoint: String::from_str(&env, "https://example.com"),
            price_usdc: String::from_str(&env, "10"),
            pay_to: String::from_str(&env, "G_PAYMENT"),
            category: String::from_str(&env, "compute"),
            provider: provider.clone(),
            reputation: 0,
            active: true,
            registered_at: env.ledger().sequence() as u64,
        };

        env.clone().as_contract(&registry_id, || {
            env.storage().persistent().set(&DataKey::Service(1), &entry);
        });

        let result = env.clone().as_contract(&registry_id, || {
            LodestarRegistry::deactivate_service(env.clone(), provider.clone(), 1u64)
        });
        assert!(matches!(result, Err(RegistryError::CategoryIndexNotFound)));
    }

    #[test]
    fn test_register_service_rejects_endpoint_too_long() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let long_endpoint = "A".repeat(257);
        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, &long_endpoint),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            ),
            Err(Ok(RegistryError::InvalidEndpoint))
        ));
    }

    #[test]
    fn test_register_service_accepts_endpoint_at_max() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let max_endpoint = "A".repeat(256);
        assert_eq!(max_endpoint.len(), 256);
        assert!(registry
            .try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, &max_endpoint),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, "compute"),
            )
            .is_ok());
    }

    #[test]
    fn test_register_service_rejects_category_empty() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, ""),
            ),
            Err(Ok(RegistryError::InvalidCategory))
        ));
    }

    #[test]
    fn test_register_service_rejects_category_too_long() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let long_category = "A".repeat(33);
        assert!(matches!(
            registry.try_register_service(
                &provider,
                &String::from_str(&env, "Valid Name"),
                &String::from_str(&env, "Valid description long enough"),
                &String::from_str(&env, "https://example.com"),
                &String::from_str(&env, "10"),
                &String::from_str(&env, "G_PAYMENT"),
                &String::from_str(&env, &long_category),
            ),
            Err(Ok(RegistryError::InvalidCategory))
        ));
    }

    #[test]
    fn test_register_service_canonicalizes_category() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);
        let provider = Address::generate(&env);

        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "Valid Name"),
            &String::from_str(&env, "Valid description long enough"),
            &String::from_str(&env, "https://example.com"),
            &String::from_str(&env, "10"),
            &String::from_str(&env, "G_PAYMENT"),
            &String::from_str(&env, " Compute "),
        );

        assert_eq!(
            registry.get_service(&id).category,
            String::from_str(&env, "compute")
        );
    }

    #[test]
    fn test_get_reputation_bounds() {
        let env = Env::default();
        let registry_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        let (min, max) = registry.get_reputation_bounds();
        assert_eq!(min, MIN_REPUTATION);
        assert_eq!(max, MAX_REPUTATION);
    }

    // ── get_reputation_bounds boundary tests (#742) ──────────────────────
    //
    // `get_reputation_bounds` takes no input and returns the (MIN, MAX) pair
    // that `update_reputation` clamps to, so the "boundaries" are the returned
    // values themselves. The table below pins one value on each side of every
    // threshold (MIN-1/MIN/MIN+1, the sign flip at -1/0/1, MAX-1/MAX/MAX+1,
    // plus the i32 extremes). Each test uses a single Env so it records
    // exactly one snapshot under test_snapshots/test/.
    #[test]
    fn test_get_reputation_bounds_boundaries() {
        let env = Env::default();
        let registry_id = env.register(LodestarRegistry, (Address::generate(&env),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        let (min, max) = registry.get_reputation_bounds();
        assert_eq!(min, MIN_REPUTATION);
        assert_eq!(max, MAX_REPUTATION);
        assert!(min < max, "lower bound must sit below the upper bound");
        assert!(
            min < 0 && 0 < max,
            "zero must fall strictly inside the bounds"
        );
        assert_eq!(max - min, 20_000, "bound width must stay 20,000");
        assert_eq!(min, -max, "bounds must stay symmetric around zero");
        // A +/-1 vote from any in-bounds reputation must stay representable:
        // the clamps sit strictly inside the i32 extremes.
        assert!(min > i32::MIN && max < i32::MAX);

        // (probe value, below_min, within_inclusive, above_max)
        let cases: [(i32, bool, bool, bool); 11] = [
            (MIN_REPUTATION - 1, true, false, false),
            (MIN_REPUTATION, false, true, false),
            (MIN_REPUTATION + 1, false, true, false),
            (-1, false, true, false),
            (0, false, true, false),
            (1, false, true, false),
            (MAX_REPUTATION - 1, false, true, false),
            (MAX_REPUTATION, false, true, false),
            (MAX_REPUTATION + 1, false, false, true),
            (i32::MIN, true, false, false),
            (i32::MAX, false, false, true),
        ];

        for (value, below, within, above) in cases {
            assert_eq!(value < min, below, "below_min mismatch for {}", value);
            assert_eq!(
                value >= min && value <= max,
                within,
                "within mismatch for {}",
                value
            );
            assert_eq!(value > max, above, "above_max mismatch for {}", value);
        }
    }

    // Empty registry vs registry holding entries parked exactly on the clamps
    // (the "empty and maximum collection cases" for a getter with no input):
    // the reported bounds must be identical in both states, and the
    // `update_reputation` clamp must agree with them so an off-by-one cannot
    // ship as a permanent on-chain constant.
    #[test]
    fn test_get_reputation_bounds_stable_across_registry_states() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry_id, registry, agents) = deploy_registry_with_id(&env);

        // Empty registry: bounds are still the compile-time constants.
        assert_eq!(
            registry.get_reputation_bounds(),
            (MIN_REPUTATION, MAX_REPUTATION)
        );

        // Seed entries parked exactly on each clamp (maximum collection case:
        // reputations sitting on the boundary values themselves).
        let provider = Address::generate(&env);
        env.clone().as_contract(&registry_id, || {
            setup_service(&env, 1, &provider, "compute", MIN_REPUTATION, true);
            setup_service(&env, 2, &provider, "compute", MAX_REPUTATION, true);
            setup_service(&env, 3, &provider, "compute", 0, true);
        });

        let (min, max) = registry.get_reputation_bounds();
        assert_eq!((min, max), (MIN_REPUTATION, MAX_REPUTATION));

        // The clamp honours the reported bounds on both sides.
        let agent = Address::generate(&env);
        agents.set_registered(&agent, &true);
        registry.update_reputation(&2u64, &true, &agent);
        assert_eq!(registry.get_service(&2u64).reputation, max);
        env.ledger()
            .with_mut(|li| li.sequence_number += VOTE_COOLDOWN_LEDGERS as u32 + 1);
        registry.update_reputation(&1u64, &false, &agent);
        assert_eq!(registry.get_service(&1u64).reputation, min);

        // Bounds are unchanged after the votes above.
        assert_eq!(registry.get_reputation_bounds(), (min, max));
    }

    // ── TTL extension tests for list_services / list_services_page (#733) ────
    //
    // Every persistent storage key read by a listing function must have its TTL
    // bumped during that read, or the entry can be archived between writes and
    // a caller sees data-loss-like behaviour (a successful get returns nothing).
    //
    // The tests below advance the ledger past MAX_TTL after registration (which
    // sets TTL to MAX_TTL), then call the listing functions which must bump the
    // TTL again, and finally advance the ledger a second time past a new
    // threshold.  If any extend_ttl call is missing, Soroban's test environment
    // will return None for the archived key and the assertions below will fail.

    /// Registers a service, advances the ledger by MAX_TTL ledgers (the point at
    /// which all keys written during registration would expire), then calls
    /// `list_services` (no category filter).  The call must extend every key it
    /// reads.  We then advance by a further MAX_TTL ledgers and assert the
    /// service is still readable — proving the TTL was renewed.
    #[test]
    fn test_list_services_extends_ttl_on_all_touched_keys() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);

        let provider = Address::generate(&env);
        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "TTL Service"),
            &String::from_str(&env, "Testing TTL extension"),
            &String::from_str(&env, "https://ttl-test.example.com"),
            &String::from_str(&env, "5"),
            &String::from_str(&env, "G_TTL_PAYMENT"),
            &String::from_str(&env, "compute"),
        );

        // Advance to just before the original TTL would expire so the entries
        // are still live when list_services reads and bumps them.
        env.ledger()
            .with_mut(|li| li.sequence_number += MAX_TTL - 1);

        // This read must bump DataKey::ServiceIds and DataKey::Service(id).
        let page1 = registry.list_services(&0, &20, &None);
        assert_eq!(page1.len(), 1, "service must be visible before TTL lapses");
        assert_eq!(page1.get(0).unwrap().id, id);

        // Advance past the original registration TTL; without the extend_ttl
        // calls added by #733 the entries would now be archived and the next
        // read would return nothing.
        env.ledger().with_mut(|li| li.sequence_number += 2);

        // DataKey::ServiceIds and DataKey::Service(id) were bumped by the
        // list_services call above, so they must still be readable.
        let page2 = registry.list_services(&0, &20, &None);
        assert_eq!(
            page2.len(),
            1,
            "service must still be readable after original TTL window: \
             extend_ttl was not called on all keys touched by list_services"
        );
        assert_eq!(page2.get(0).unwrap().id, id);
    }

    /// Same as above but exercises the `category` filter branch, which reads
    /// `DataKey::ServiceIdsByCategory(cat)` instead of `DataKey::ServiceIds`.
    #[test]
    fn test_list_services_extends_ttl_for_category_index() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);

        let provider = Address::generate(&env);
        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "TTL Service"),
            &String::from_str(&env, "Testing TTL extension"),
            &String::from_str(&env, "https://ttl-cat.example.com"),
            &String::from_str(&env, "5"),
            &String::from_str(&env, "G_TTL_PAYMENT"),
            &String::from_str(&env, "weather"),
        );

        // Advance to just before the original TTL would expire.
        env.ledger()
            .with_mut(|li| li.sequence_number += MAX_TTL - 1);

        // This read must bump DataKey::ServiceIdsByCategory("weather") and
        // DataKey::Service(id).
        let page1 = registry.list_services(&0, &20, &Some(String::from_str(&env, "weather")));
        assert_eq!(page1.len(), 1, "service must be visible before TTL lapses");
        assert_eq!(page1.get(0).unwrap().id, id);

        // Advance past the original registration TTL.
        env.ledger().with_mut(|li| li.sequence_number += 2);

        // Both keys were bumped — the service must still be listed.
        let page2 = registry.list_services(&0, &20, &Some(String::from_str(&env, "weather")));
        assert_eq!(
            page2.len(),
            1,
            "service must still be readable after original TTL window: \
             extend_ttl was not called on DataKey::ServiceIdsByCategory or \
             DataKey::Service(id) inside list_services"
        );
        assert_eq!(page2.get(0).unwrap().id, id);
    }

    /// Exercises `list_services_page`, which has its own storage walk and must
    /// bump `DataKey::ServiceIds` and each `DataKey::Service(id)` it reads.
    #[test]
    fn test_list_services_page_extends_ttl_on_all_touched_keys() {
        let env = Env::default();
        env.mock_all_auths();
        let (registry, _agents) = deploy_registry(&env);

        let provider = Address::generate(&env);
        let id = registry.register_service(
            &provider,
            &String::from_str(&env, "TTL Page Service"),
            &String::from_str(&env, "Testing page TTL extension"),
            &String::from_str(&env, "https://ttl-page.example.com"),
            &String::from_str(&env, "5"),
            &String::from_str(&env, "G_TTL_PAGE"),
            &String::from_str(&env, "compute"),
        );

        // Advance to just before the original TTL would expire.
        env.ledger()
            .with_mut(|li| li.sequence_number += MAX_TTL - 1);

        // This paged read must bump DataKey::ServiceIds and DataKey::Service(id).
        let page1 = registry.list_services_page(&0, &20);
        assert_eq!(page1.len(), 1, "service must be visible before TTL lapses");
        assert_eq!(page1.get(0).unwrap().id, id);

        // Advance past the original registration TTL.
        env.ledger().with_mut(|li| li.sequence_number += 2);

        // Both keys were bumped — the service must still appear on the page.
        let page2 = registry.list_services_page(&0, &20);
        assert_eq!(
            page2.len(),
            1,
            "service must still be readable after original TTL window: \
             extend_ttl was not called on all keys touched by list_services_page"
        );
        assert_eq!(page2.get(0).unwrap().id, id);
    }

    // ── get_agents_contract authorization posture ─────────────────────────────
    //
    // `get_agents_contract` takes no `Address` argument and calls no `require_auth`, so
    // it is a permissionless read. The tests below pin that posture from both
    // sides: the read must keep working for a caller who signs nothing, and it
    // must keep working for a caller whose signature comes from an address with
    // no relationship to the registry. A future refactor that adds a hidden auth
    // requirement (or drops a state write into a read path) fails here.

    #[test]
    fn test_get_agents_contract_succeeds_with_no_auths() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id.clone(),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        // Drop every auth mock, so nothing is left to authorise the read with.
        env.set_auths(&[]);

        let result = registry.get_agents_contract();
        assert_eq!(result, Some(agents_id));

        // A read that demands no authorization must not consume any either.
        assert!(
            env.auths().is_empty(),
            "get_agents_contract must not require or record an authorization",
        );
    }

    #[test]
    fn test_get_agents_contract_succeeds_for_any_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id.clone(),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        // The anonymous read, with no auths available at all.
        env.set_auths(&[]);
        let anonymous = registry.get_agents_contract();
        assert_eq!(anonymous, Some(agents_id.clone()));

        // The same read signed by an address that is neither the provider nor
        // anything the registry knows about.
        let stranger = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &registry_id,
                fn_name: "get_agents_contract",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let signed_by_stranger = registry.get_agents_contract();
        assert_eq!(signed_by_stranger, Some(agents_id));
    }

    #[test]
    fn test_get_agents_contract_extends_ttl() {
        let env = Env::default();
        let agents_id = env.register(MockAgents, ());
        let registry_id = env.register(LodestarRegistry, (agents_id.clone(),));
        let registry = LodestarRegistryClient::new(&env, &registry_id);

        // Advance to just before the constructor's TTL expires.
        env.ledger().with_mut(|li| li.sequence_number += MAX_TTL - 1);

        // Call the read endpoint; this must bump the TTL.
        let contract = registry.get_agents_contract();
        assert_eq!(contract, Some(agents_id.clone()));

        // Advance past the original expiration boundary.
        env.ledger().with_mut(|li| li.sequence_number += 2);

        // If the read did not bump the TTL, the entry is archived and this fails.
        let contract_after = registry.get_agents_contract();
        assert_eq!(
            contract_after,
            Some(agents_id.clone()),
            "agents contract must still be readable after original TTL window: \
             extend_ttl was not called on the touched key"
        );
    }
}
