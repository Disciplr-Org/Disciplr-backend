import os

test_path = 'contracts/accountability_vault/src/test.rs'
with open(test_path, 'w') as f:
    f.write('''#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _, Events, Ledger}, Address, Env};

#[test]
fn test_dispute() {
    let env = Env::default();
    
    // Set a mock timestamp for the ledger
    env.ledger().set_timestamp(1690000000);
    
    let contract_id = env.register_contract(None, AccountabilityVault);
    let client = AccountabilityVaultClient::new(&env, &contract_id);
    let creator = Address::generate(&env);
    env.mock_all_auths();
    
    // Call with index 1 and a dispute window of 3600 seconds (1 hour)
    client.dispute_milestone(&creator, &1u32, &3600u64);
    assert_eq!(env.events().all().len(), 1);
}
''')

print('Patch 3 applied: Test file updated for dispute_window and ledger timestamp.')
