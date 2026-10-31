module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  transform: { '^.+\\.jsx?$': '<rootDir>/scripts/jest-transform.cjs' },
};
