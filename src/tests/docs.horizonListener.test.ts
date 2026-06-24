import { loadHorizonListenerConfig } from '../config/horizonListener';
import { initEnv } from '../config/index';

describe('Horizon Listener Documentation Sync', () => {
  it('should match the documented configuration keys', () => {
    // We mock/set the environment variables needed by the config loader
    const mockEnv = {
      HORIZON_URL: 'http://localhost:8000',
      CONTRACT_ADDRESS: 'CDISCIPLR...',
      RETRY_MAX_ATTEMPTS: '3',
      RETRY_BACKOFF_MS: '100',
      HORIZON_SHUTDOWN_TIMEOUT_MS: '30000',
      HORIZON_LAG_THRESHOLD: '10',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db' // Required by schema
    };

    initEnv(mockEnv);

    // The keys expected to be in the configuration object
    const expectedKeys = [
      'horizonUrl',
      'contractAddresses',
      'startLedger',
      'retryMaxAttempts',
      'retryBackoffMs',
      'shutdownTimeoutMs',
      'lagThreshold'
    ];
    
    const config = loadHorizonListenerConfig();
    const configKeys = Object.keys(config);

    expect(configKeys.sort()).toEqual(expectedKeys.sort());
  });
});
