export const LIFECYCLE_STATES = Object.freeze(['starting', 'ready', 'running', 'stopping', 'stopped', 'failed']);

const TRANSITIONS = new Map([
  ['starting', new Set(['ready', 'failed'])],
  ['ready', new Set(['running', 'stopping', 'failed'])],
  ['running', new Set(['stopping', 'failed'])],
  ['stopping', new Set(['stopped', 'failed'])],
  ['stopped', new Set()],
  ['failed', new Set()],
]);

export class ApplicationLifecycle {
  state = 'starting';
  constructor(mode) { this.mode = mode; }
  ready() { this.#move('ready'); }
  running() { this.#move('running'); }
  stop() { if (this.state !== 'stopped') { this.#move('stopping'); this.#move('stopped'); } }
  fail() { if (this.state !== 'failed') this.#move('failed'); }
  #move(next) {
    if (!TRANSITIONS.get(this.state)?.has(next)) throw new Error(`illegal lifecycle transition: ${this.state} -> ${next}`);
    this.state = next;
  }
}
