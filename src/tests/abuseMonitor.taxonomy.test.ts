import { describe, it, expect,} from '@jest/globals'

import { abuseMonitor } from '../security/abuse-monitor';

const testCases = [
  {
    category: 'credential-stuffing',
    signals: [
      { type: 'login-attempt', successful: false },
      { type: 'login-attempt', successful: false },
      { type: 'login-attempt', successful: false },
    ],
    expectedCategory: 'credential-stuffing',
    expectedSeverity: 'high',
  },
  {
    category: 'scraping',
    signals: [
      { type: 'page-view', url: '/api/data' },
      { type: 'page-view', url: '/api/data' },
      { type: 'page-view', url: '/api/data' },
    ],
    expectedCategory: 'scraping',
    expectedSeverity: 'medium',
  },
  // Add more test cases for each category and threshold boundaries
];

describe('abuseMonitor', () => {
  it('classifies signals correctly', () => {
    testCases.forEach((testCase) => {
      const result = abuseMonitor(testCase.signals);
      expect(result.category).toBe(testCase.expectedCategory);
      expect(result.severity).toBe(testCase.expectedSeverity);
    });
  });

  it('handles threshold boundaries', () => {
    // Test threshold boundaries for each category
  });

  it('handles de-dup window behaviour', () => {
    // Test de-dup window behaviour for each category
  });
});
