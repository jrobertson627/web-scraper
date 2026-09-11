export const LIFECYCLE_STATES = Object.freeze(['starting', 'ready', 'running', 'stopping', 'stopped', 'failed']);

export class ApplicationLifecycle {
  state = 'starting';
  constructor(mode) { this.mode = mode; }
  ready() { this.state = 'ready'; }
  running() { this.state = 'running'; }
  stop() { this.state = 'stopping'; this.state = 'stopped'; }
  fail() { this.state = 'failed'; }
}
