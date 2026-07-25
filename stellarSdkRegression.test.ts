import { describe, it, expect, beforeAll } from '@jest/globals'

// SDK exports loaded dynamically to capture import errors
let Keypair: unknown
let Contract: unknown
let TransactionBuilder: unknown
let Account: unknown
let nativeToScVal: unknown
let scValToNative: unknown
let xdr: unknown
let rpc: unknown
let Networks: unknown
let BASE_FEE: unknown
let StrKey: unknown
let Address: unknown

// Test constants (initialized after SDK import)
let VALID_STELLAR_PUBLIC_KEY: string
let VALID_SECRET_KEY: string
let VALID_CONTRACT_ID: string
const TEST_NETWORK = 'Test SDF Network ; September 2015'

beforeAll(async () => {
  const sdk = await import('@stellar/stellar-sdk')
  Keypair = sdk.Keypair
  Contract = sdk.Contract
  TransactionBuilder = sdk.TransactionBuilder
  Account = sdk.Account
  nativeToScVal = sdk.nativeToScVal
  scValToNative = sdk.scValToNative
  xdr = sdk.xdr
  rpc = sdk.rpc
  Networks = sdk.Networks
  BASE_FEE = sdk.BASE_FEE
  StrKey = sdk.StrKey
  Address = sdk.Address

  // Generate valid test addresses from keypairs
  const testKeypair = (Keypair as any).random()
  VALID_STELLAR_PUBLIC_KEY = testKeypair.publicKey()
  VALID_SECRET_KEY = testKeypair.secret()

  // Generate a valid contract ID using StrKey.encodeContract
  const contractBuffer = Buffer.alloc(32, 1)
  VALID_CONTRACT_ID = (StrKey as any).encodeContract(contractBuffer)
})

describe('Stellar SDK v14 regression suite', () => {
  describe('Symbol availability', () => {
    it('exports the symbols required by src/services/soroban.ts', () => {
      expect(typeof Keypair).toBe('function')
      expect(typeof Contract).toBe('function')
      expect(typeof TransactionBuilder).toBe('function')
      expect(typeof Account).toBe('function')
      expect(typeof nativeToScVal).toBe('function')
      expect(typeof rpc).toBe('object')
      expect(rpc).not.toBeNull()
      expect(typeof (rpc as any)?.Server).toBe('function')
      expect(typeof Networks).toBe('object')
      expect(Networks).not.toBeNull()
      // BASE_FEE is a string in SDK v14
      expect(typeof BASE_FEE).toBe('string')
      expect(BASE_FEE).not.toBe('')
    })

    it('exports the XDR helpers required by src/services/eventParser.ts', () => {
      expect(typeof xdr).toBe('object')
      expect(xdr).not.toBeNull()
      expect(typeof (xdr as any).ScVal).toBe('function')
      expect(typeof (xdr as any).ScVal.fromXDR).toBe('function')
      expect(typeof scValToNative).toBe('function')
    })

    it('Keypair has the expected methods', () => {
      expect(typeof (Keypair as any).fromSecret).toBe('function')
      expect(typeof (Keypair as any).random).toBe('function')
    })

    it('Account constructor and methods are available', () => {
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      expect(account).toBeDefined()
      expect(typeof account.accountId).toBeDefined()
      expect(typeof account.sequenceNumber).toBeDefined()
    })
  })

  describe('Contract API shape', () => {
    it('Contract constructor and call method match usage in soroban.ts', () => {
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      expect(contract).toBeDefined()
      expect(typeof contract.call).toBe('function')
    })

    it('Contract.call returns an operation with toXDR method', () => {
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const scVal = (nativeToScVal as any)('test', { type: 'string' })
      
      const operation = contract.call('create_vault', scVal)
      expect(operation).toBeDefined()
      expect(typeof (operation as any).toXDR).toBe('function')
    })

    it('Contract.call supports multiple arguments', () => {
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const arg1 = (nativeToScVal as any)('vault-123', { type: 'string' })
      const arg2 = (nativeToScVal as any)('100', { type: 'string' })
      const arg3 = (nativeToScVal as any)('verifier', { type: 'string' })
      
      const operation = contract.call('create_vault', arg1, arg2, arg3)
      expect(operation).toBeDefined()
      expect(typeof (operation as any).toXDR).toBe('function')
    })
  })

  describe('TransactionBuilder API shape', () => {
    it('TransactionBuilder constructor and base methods exist', () => {
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const builder = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })

      expect(builder).toBeDefined()
      expect(typeof builder.addOperation).toBe('function')
      expect(typeof builder.setTimeout).toBe('function')
      expect(typeof builder.build).toBe('function')
    })

    it('TransactionBuilder.addOperation accepts contract operations', () => {
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const scVal = (nativeToScVal as any)('test', { type: 'string' })
      const operation = contract.call('test_method', scVal)

      const builder = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })

      const result = builder.addOperation(operation)
      expect(result).toBeDefined()
      expect(typeof result.setTimeout).toBe('function')
    })

    it('TransactionBuilder.build() returns a Transaction with toXDR', () => {
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const scVal = (nativeToScVal as any)('test', { type: 'string' })
      const operation = contract.call('test_method', scVal)

      const tx = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build()

      expect(tx).toBeDefined()
      expect(typeof tx.toXDR).toBe('function')
      expect(typeof tx.sign).toBe('function')
      expect(typeof (tx as any).operations).toBeDefined()
      expect(Array.isArray((tx as any).operations)).toBe(true)
    })

    it('Transaction.sign() accepts Keypair', () => {
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const scVal = (nativeToScVal as any)('test', { type: 'string' })
      const operation = contract.call('test_method', scVal)

      const tx = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build()

      const keypair = (Keypair as any).random()
      expect(typeof tx.sign).toBe('function')
      tx.sign(keypair) // Should not throw
      expect((tx as any).signatures.length).toBeGreaterThan(0)
    })
  })

  describe('XDR conversion shape', () => {
    it('nativeToScVal handles string type', () => {
      const native = 'test-string'
      const scVal = (nativeToScVal as any)(native, { type: 'string' })
      
      expect(scVal).toBeDefined()
      expect(typeof scVal.toXDR).toBe('function')
    })

    it('nativeToScVal handles i128 type', () => {
      const scVal = (nativeToScVal as any)('100', { type: 'i128' })
      expect(scVal).toBeDefined()
      expect(typeof scVal.toXDR).toBe('function')
    })

    it('nativeToScVal handles u128 type', () => {
      const scVal = (nativeToScVal as any)('200', { type: 'u128' })
      expect(scVal).toBeDefined()
      expect(typeof scVal.toXDR).toBe('function')
    })

    it('xdr.ScVal.fromXDR accepts base64-encoded XDR data', () => {
      const native = 'test-data'
      const scVal = (nativeToScVal as any)(native, { type: 'string' })
      const encoded = scVal.toXDR('base64')
      
      expect(typeof encoded).toBe('string')
      expect(encoded.length).toBeGreaterThan(0)
      
      const decoded = (xdr as any).ScVal.fromXDR(encoded, 'base64')
      expect(decoded).toBeDefined()
    })

    it('scValToNative reverses nativeToScVal roundtrip for strings', () => {
      const native = 'roundtrip-test'
      const scVal = (nativeToScVal as any)(native, { type: 'string' })
      const encoded = scVal.toXDR('base64')
      const decoded = (xdr as any).ScVal.fromXDR(encoded, 'base64')
      const roundtripped = (scValToNative as any)(decoded)
      
      expect(roundtripped).toBe(native)
    })

    it('scValToNative roundtrip preserves numeric strings in i128', () => {
      const native = '12345'
      const scVal = (nativeToScVal as any)(native, { type: 'i128' })
      const encoded = scVal.toXDR('base64')
      const decoded = (xdr as any).ScVal.fromXDR(encoded, 'base64')
      const roundtripped = (scValToNative as any)(decoded)
      
      // i128 values roundtrip as BigInt or number, not as string
      expect(roundtripped).toBeDefined()
      expect(roundtripped.toString()).toBe(native)
    })

    it('scValToNative roundtrip preserves large numbers in u128', () => {
      const native = '999999999999999999999'
      const scVal = (nativeToScVal as any)(native, { type: 'u128' })
      const encoded = scVal.toXDR('base64')
      const decoded = (xdr as any).ScVal.fromXDR(encoded, 'base64')
      const roundtripped = (scValToNative as any)(decoded)
      
      // u128 values roundtrip as BigInt or number, not as string
      expect(roundtripped).toBeDefined()
      expect(roundtripped.toString()).toBe(native)
    })
  })

  describe('rpc.Server API shape', () => {
    it('rpc.Server constructor accepts a URL without making network calls', () => {
      const server = new (rpc as any).Server('https://example.com')
      expect(server).toBeDefined()
    })

    it('rpc.Server exposes network methods required by soroban.ts', () => {
      const server = new (rpc as any).Server('https://example.com')
      
      expect(typeof server.getAccount).toBe('function')
      expect(typeof server.prepareTransaction).toBe('function')
      expect(typeof server.sendTransaction).toBe('function')
    })

    it('rpc.Server.getAccount returns a Promise', () => {
      const server = new (rpc as any).Server('https://example.com')
      const result = server.getAccount(VALID_STELLAR_PUBLIC_KEY)
      
      expect(result).toBeDefined()
      expect(typeof result.then).toBe('function')
      expect(typeof result.catch).toBe('function')
    })

    it('rpc.Server.prepareTransaction returns a Promise', () => {
      const server = new (rpc as any).Server('https://example.com')
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      const scVal = (nativeToScVal as any)('test', { type: 'string' })
      const operation = contract.call('test_method', scVal)

      const tx = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build()

      const result = server.prepareTransaction(tx)
      expect(result).toBeDefined()
      expect(typeof result.then).toBe('function')
    })

    it('rpc.Server.sendTransaction returns a Promise', () => {
      const server = new (rpc as any).Server('https://example.com')
      const account = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const tx = new (TransactionBuilder as any)(account, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })
        .setTimeout(30)
        .build()

      const result = server.sendTransaction(tx)
      expect(result).toBeDefined()
      expect(typeof result.then).toBe('function')
    })

    it('rpc.Server.getTransaction returns a Promise', () => {
      const server = new (rpc as any).Server('https://example.com')
      const result = server.getTransaction('test-hash')
      
      expect(result).toBeDefined()
      expect(typeof result.then).toBe('function')
    })
  })

  describe('Networks constant', () => {
    it('Networks object contains network passphrases as strings', () => {
      expect((Networks as any).TESTNET).toBeDefined()
      expect(typeof (Networks as any).TESTNET).toBe('string')
      expect((Networks as any).PUBLIC).toBeDefined()
      expect(typeof (Networks as any).PUBLIC).toBe('string')
    })

    it('Network passphrases are non-empty strings', () => {
      expect((Networks as any).TESTNET.length).toBeGreaterThan(0)
      expect((Networks as any).PUBLIC.length).toBeGreaterThan(0)
    })
  })

  describe('Keypair operations', () => {
    it('Keypair.random() generates a valid keypair', () => {
      const keypair = (Keypair as any).random()
      expect(keypair).toBeDefined()
      expect(typeof keypair.publicKey).toBe('function')
      expect(typeof keypair.secret).toBe('function')
    })

    it('Keypair.fromSecret() reconstructs from secret key', () => {
      const original = (Keypair as any).random()
      const secret = original.secret()
      const reconstructed = (Keypair as any).fromSecret(secret)
      
      expect(original.publicKey()).toBe(reconstructed.publicKey())
    })

    it('Keypair methods return consistent results', () => {
      const keypair = (Keypair as any).random()
      const pubkey1 = keypair.publicKey()
      const pubkey2 = keypair.publicKey()
      
      expect(pubkey1).toBe(pubkey2)
    })
  })

  describe('Integration: full submit flow shape', () => {
    it('models the complete submission flow from soroban.ts', () => {
      // Simulate: const server = new SorobanRpc.Server(config.rpcUrl)
      const server = new (rpc as any).Server('https://example.com')
      expect(server).toBeDefined()

      // Simulate: const account = await server.getAccount(sourceAccount)
      const getAccountResult = server.getAccount(VALID_STELLAR_PUBLIC_KEY)
      expect(typeof getAccountResult.then).toBe('function')

      // Simulate: const contract = new Contract(contractId)
      const contract = new (Contract as any)(VALID_CONTRACT_ID)
      expect(typeof contract.call).toBe('function')

      // Simulate: const callOp = contract.call(...)
      const arg1 = (nativeToScVal as any)('vault-id', { type: 'string' })
      const arg2 = (nativeToScVal as any)('100', { type: 'string' })
      const operation = contract.call('create_vault', arg1, arg2)
      expect(operation).toBeDefined()

      // Simulate: const tx = new TransactionBuilder(account, { fee, networkPassphrase })
      const mockAccount = new (Account as any)(VALID_STELLAR_PUBLIC_KEY, '1')
      const txBuilder = new (TransactionBuilder as any)(mockAccount, {
        fee: (BASE_FEE as any) * 2,
        networkPassphrase: TEST_NETWORK,
      })
      expect(typeof txBuilder.addOperation).toBe('function')

      // Simulate: .addOperation(callOp).setTimeout(30).build()
      const tx = txBuilder.addOperation(operation).setTimeout(30).build()
      expect(typeof tx.toXDR).toBe('function')
      expect(typeof tx.sign).toBe('function')

      // Simulate: prepared.sign(keypair)
      const keypair = (Keypair as any).random()
      expect(typeof tx.sign).toBe('function')
      tx.sign(keypair)

      // Simulate: await server.prepareTransaction(prepared)
      const prepareResult = server.prepareTransaction(tx)
      expect(typeof prepareResult.then).toBe('function')
    })
  })

  describe('Integration: XDR parsing flow from eventParser.ts', () => {
    it('models the complete XDR parsing flow', () => {
      // Simulate: const scVal = xdr.ScVal.fromXDR(xdrData, 'base64')
      const original = 'test-event-data'
      const scVal = (nativeToScVal as any)(original, { type: 'string' })
      const xdrData = scVal.toXDR('base64')

      const decoded = (xdr as any).ScVal.fromXDR(xdrData, 'base64')
      expect(decoded).toBeDefined()

      // Simulate: nativeVal = scValToNative(scVal)
      const nativeVal = (scValToNative as any)(decoded)
      expect(nativeVal).toBe(original)
    })

    it('handles roundtrip with i128 amounts (vault amount field)', () => {
      const vaultAmount = '50000000000'
      const scVal = (nativeToScVal as any)(vaultAmount, { type: 'i128' })
      const xdrData = scVal.toXDR('base64')

      const decoded = (xdr as any).ScVal.fromXDR(xdrData, 'base64')
      const parsed = (scValToNative as any)(decoded)
      
      // i128 roundtrips as BigInt or number, not string, so compare as strings
      expect(parsed.toString()).toBe(vaultAmount)
    })
  })

  describe('Error resilience', () => {
    it('gracefully handles invalid base64 in fromXDR', () => {
      expect(() => {
        (xdr as any).ScVal.fromXDR('not-valid-base64-!@#$', 'base64')
      }).toThrow()
    })

    it('handles empty XDR data', () => {
      // Verify fromXDR validates input
      expect(() => {
        (xdr as any).ScVal.fromXDR('', 'base64')
      }).toThrow()
    })
  })
})
