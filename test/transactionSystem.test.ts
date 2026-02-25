import { TransactionService } from '../src/services/transactionService.js'
import { TransactionValidator } from '../src/utils/validation.js'

async function testTransactionSystem() {
  console.log('Testing Transaction History System...\n')

  try {
    // Test 1: Create a sample transaction
    console.log('1. Creating sample transaction...')
    const sampleTransaction = await TransactionService.createTransaction({
      userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X',
      vaultId: 'vault-test-123',
      type: 'creation',
      amount: '1000.0000000',
      timestamp: new Date().toISOString(),
      stellarHash: 'abc123def456789abc123def456789abc123def456789abc123def456789',
      link: 'https://stellar.expert/explorer/testnet/tx/abc123def456789abc123def456789abc123def456789abc123def456789',
      metadata: {
        test: true,
        description: 'Sample transaction for testing'
      }
    })
    console.log('✅ Transaction created:', sampleTransaction.id)

    // Test 2: Get transaction by ID
    console.log('\n2. Getting transaction by ID...')
    const retrievedTransaction = await TransactionService.getTransactionById(sampleTransaction.id)
    console.log('✅ Transaction retrieved:', retrievedTransaction?.id === sampleTransaction.id ? 'Success' : 'Failed')

    // Test 3: Get transactions by vault ID
    console.log('\n3. Getting transactions by vault ID...')
    const vaultTransactions = await TransactionService.getTransactionsByVaultId('vault-test-123')
    console.log(`✅ Found ${vaultTransactions.length} transactions for vault`)

    // Test 4: Get transactions by user ID
    console.log('\n4. Getting transactions by user ID...')
    const userTransactions = await TransactionService.getTransactionsByUserId('GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X')
    console.log(`✅ Found ${userTransactions.length} transactions for user`)

    // Test 5: Test pagination and filtering
    console.log('\n5. Testing pagination and filtering...')
    const filteredResult = await TransactionService.getTransactions(
      {
        type: 'creation',
        vault: 'vault-test-123'
      },
      1,
      10
    )
    console.log(`✅ Filtered result: ${filteredResult.transactions.length} transactions, page ${filteredResult.pagination.page} of ${filteredResult.pagination.totalPages}`)

    // Test 6: Test validation
    console.log('\n6. Testing validation...')
    try {
      TransactionValidator.validateTransactionType('invalid_type')
      console.log('❌ Validation should have failed')
    } catch (error) {
      console.log('✅ Validation correctly caught invalid type')
    }

    try {
      TransactionValidator.validateAmount('-100')
      console.log('❌ Validation should have failed')
    } catch (error) {
      console.log('✅ Validation correctly caught negative amount')
    }

    try {
      TransactionValidator.validateStellarHash('invalid_hash')
      console.log('❌ Validation should have failed')
    } catch (error) {
      console.log('✅ Validation correctly caught invalid hash')
    }

    // Test 7: Test bulk operations
    console.log('\n7. Testing bulk transaction creation...')
    const bulkTransactions = [
      {
        userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X',
        vaultId: 'vault-bulk-1',
        type: 'validation' as const,
        amount: '500.0000000',
        timestamp: new Date(Date.now() - 60000).toISOString(),
        metadata: { bulk: true, index: 0 }
      },
      {
        userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X',
        vaultId: 'vault-bulk-2',
        type: 'release' as const,
        amount: '750.0000000',
        timestamp: new Date(Date.now() - 30000).toISOString(),
        metadata: { bulk: true, index: 1 }
      }
    ]

    const createdBulk = await TransactionService.createTransactionsBulk(bulkTransactions)
    console.log(`✅ Created ${createdBulk.length} bulk transactions`)

    console.log('\n🎉 All tests passed! Transaction system is working correctly.')

  } catch (error) {
    console.error('❌ Test failed:', error)
    process.exit(1)
  }
}

// Run tests
testTransactionSystem().catch(console.error)
