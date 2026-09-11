export const VALUE_STATES = Object.freeze(['blank', 'unavailable', 'null', 'present']);
export const GAME_STATUSES = Object.freeze(['scheduled', 'final', 'canceled', 'rescheduled', 'incomplete']);
export const GAME_CONTEXTS = Object.freeze(['home', 'away', 'neutral']);

export function blank() { return Object.freeze({ state: 'blank' }); }
export function unavailable(reason = 'source_unavailable') { return Object.freeze({ state: 'unavailable', reason }); }
export function explicitNull() { return Object.freeze({ state: 'null' }); }
export function present(value) { return Object.freeze({ state: 'present', value }); }

export function assertSourceValue(value) {
  if (!value || !VALUE_STATES.includes(value.state)) {
    throw new Error(`invalid source value state. Expected blank, unavailable, null, or present(value). Example: present(0)`);
  }
  if (value.state === 'present' && !('value' in value)) {
    throw new Error('present source value is missing value. Expected present(value). Example: present(0)');
  }
  return value;
}

export function assertGameStatus(status) {
  if (!GAME_STATUSES.includes(status)) {
    throw new Error(`invalid game status: ${status}. Expected ${GAME_STATUSES.join(', ')}. Example: status: canceled`);
  }
  return status;
}

export function assertGameContext(context) {
  if (!GAME_CONTEXTS.includes(context)) {
    throw new Error(`invalid game context: ${context}. Expected home, away, or neutral. Example: context: neutral`);
  }
  return context;
}
