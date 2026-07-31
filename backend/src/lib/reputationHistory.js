// Reputation history — in-memory store.
// Kept dependency-free so it's unit-testable.

const reputationHistory = new Map();

/**
 * Record a reputation change for a service.
 * @param {number} serviceId - The ID of the service whose reputation changed
 * @param {number} timestamp - Unix timestamp of when the change occurred
 * @param {number} delta - The change in reputation (positive or negative integer)
 * @param {number} newValue - The new reputation value after the change
 */
export function recordReputationChange(serviceId, timestamp, delta, newValue) {
  if (!reputationHistory.has(serviceId)) {
    reputationHistory.set(serviceId, []);
  }
  const history = reputationHistory.get(serviceId);
  history.unshift({
    timestamp,
    delta,
    newValue,
  });
}

/**
 * Get the reputation history for a service.
 * @param {number} serviceId - The ID of the service to retrieve history for
 * @returns {Array<Object>} Array of reputation change events, sorted with newest first
 */
export function getReputationHistory(serviceId) {
  return reputationHistory.get(serviceId) || [];
}

/** Clear all in-memory reputation history (for tests). */
export function clearReputationHistory() {
  reputationHistory.clear();
}
