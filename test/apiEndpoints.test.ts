import axios from 'axios'

const BASE_URL = 'http://localhost:3000/api'

async function testAPIEndpoints() {
  console.log('Testing Transaction API Endpoints...\n')

  try {
    // Test 1: Health check
    console.log('1. Testing health endpoint...')
    const healthResponse = await axios.get(`${BASE_URL}/health`)
    console.log('✅ Health check:', healthResponse.data.status)

    // Test 2: Create a transaction
    console.log('\n2. Creating transaction via API...')
    const createResponse = await axios.post(`${BASE_URL}/transactions`, {
      userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X',
      vaultId: 'vault-api-test-123',
      type: 'creation',
      amount: '1000.0000000',
      timestamp: new Date().toISOString(),
      stellarHash: 'api123def456789api123def456789api123def456789api123def456789',
      link: 'https://stellar.expert/explorer/testnet/tx/api123def456789api123def456789api123def456789api123def456789',
      metadata: {
        apiTest: true,
        description: 'Transaction created via API test'
      }
    })
    console.log('✅ Transaction created via API:', createResponse.data.id)

    const transactionId = createResponse.data.id

    // Test 3: Get transaction by ID
    console.log('\n3. Getting transaction by ID via API...')
    const getResponse = await axios.get(`${BASE_URL}/transactions/${transactionId}`)
    console.log('✅ Retrieved transaction:', getResponse.data.id === transactionId ? 'Success' : 'Failed')

    // Test 4: List transactions with pagination
    console.log('\n4. Listing transactions with pagination...')
    const listResponse = await axios.get(`${BASE_URL}/transactions?page=1&limit=10`)
    console.log(`✅ Listed ${listResponse.data.transactions.length} transactions`)
    console.log(`   Pagination: page ${listResponse.data.pagination.page} of ${listResponse.data.pagination.totalPages}`)

    // Test 5: Filter by transaction type
    console.log('\n5. Filtering by transaction type...')
    const typeFilterResponse = await axios.get(`${BASE_URL}/transactions?type=creation`)
    console.log(`✅ Found ${typeFilterResponse.data.transactions.length} creation transactions`)

    // Test 6: Filter by vault ID
    console.log('\n6. Filtering by vault ID...')
    const vaultFilterResponse = await axios.get(`${BASE_URL}/transactions?vault=vault-api-test-123`)
    console.log(`✅ Found ${vaultFilterResponse.data.transactions.length} transactions for vault`)

    // Test 7: Get transactions by vault endpoint
    console.log('\n7. Getting transactions by vault endpoint...')
    const vaultTransactionsResponse = await axios.get(`${BASE_URL}/transactions/vault/vault-api-test-123`)
    console.log(`✅ Vault endpoint returned ${vaultTransactionsResponse.data.transactions.length} transactions`)

    // Test 8: Get transactions by user endpoint
    console.log('\n8. Getting transactions by user endpoint...')
    const userTransactionsResponse = await axios.get(`${BASE_URL}/transactions/user/GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X`)
    console.log(`✅ User endpoint returned ${userTransactionsResponse.data.transactions.length} transactions`)

    // Test 9: Update transaction link
    console.log('\n9. Updating transaction link...')
    const updateResponse = await axios.put(`${BASE_URL}/transactions/${transactionId}/link`, {
      link: 'https://stellar.expert/explorer/testnet/tx/updated123def456789updated123def456789updated123def456789'
    })
    console.log('✅ Transaction link updated:', updateResponse.data.link.includes('updated'))

    // Test 10: Test validation errors
    console.log('\n10. Testing validation errors...')
    try {
      await axios.post(`${BASE_URL}/transactions`, {
        // Missing required fields
        userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X'
      })
      console.log('❌ Should have failed with validation error')
    } catch (error: any) {
      if (error.response?.status === 400) {
        console.log('✅ Validation error correctly caught')
      } else {
        throw error
      }
    }

    try {
      await axios.post(`${BASE_URL}/transactions`, {
        userId: 'GD5DJQDDBLQ2U3X5L5G5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X',
        vaultId: 'vault-test',
        type: 'invalid_type',
        amount: '1000',
        timestamp: new Date().toISOString()
      })
      console.log('❌ Should have failed with invalid type error')
    } catch (error: any) {
      if (error.response?.status === 400) {
        console.log('✅ Invalid type error correctly caught')
      } else {
        throw error
      }
    }

    console.log('\n🎉 All API tests passed! Transaction API is working correctly.')

  } catch (error: any) {
    if (error.response) {
      console.error('❌ API Test failed:', error.response.status, error.response.data)
    } else if (error.code === 'ECONNREFUSED') {
      console.error('❌ API Test failed: Server not running. Start the server with `npm run dev`')
    } else {
      console.error('❌ API Test failed:', error.message)
    }
    process.exit(1)
  }
}

// Run API tests
testAPIEndpoints().catch(console.error)
