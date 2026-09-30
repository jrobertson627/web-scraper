import { NO_CRAWL_EVENTS } from './crawl-log.mjs';
import { normalizeParsedPage, parseSnapshot, parserVersionFor, snapshotFor } from './page-pipeline.mjs';
import { REQUEST_POLICY_DEFAULTS, chargedRetry } from '../contracts/request-policy.mjs';
import { HALTING_STOP_CODES, isSystemicRawStoreError, isSystemicStoreError, isTransientStoreError } from '../contracts/jobs.mjs';
import { HealthMonitor } from './health-monitor.mjs';

// Sleeps for ms, ending early (without throwing) if the signal aborts.
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Ends a run for a cause that is not one job's (#122): thrown where it is
// noticed and turned into the run's `halt` where the loop can end.
class RunHalt extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RunHalt';
    this.reason = reason;
  }
}

// A database outage the run waits out: up to `attempts` tries, backing off from
// baseMs to maxMs, which is about three and a half minutes with the defaults.
const DEFAULT_STORE_RETRY = Object.freeze({ attempts: 10, baseMs: 1_000, maxMs: 60_000 });

// Failure codes that say nothing about one page: the network, DNS, a timeout, a
// 5xx, or an infrastructure error while fetching. They feed the health monitor
// (#114); a 404, a parse failure and a 429 do not.
const INFRASTRUCTURE_CODES = new Set(['transient_network', 'transport_timeout', 'connect_timeout', 'upstream_5xx', 'infrastructure']);

const FAILURE_SETTLED_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);

export class IngestionOrchestrator {
  // events is the crawl-log sink (./crawl-log.mjs); hooks below are single emit calls.
  // parserVersions ({ pageType: version }, from the configuration) chooses the
  // parser for each page type; without it a job's queued version is used.
  // storeRetry ({ attempts, baseMs, maxMs }) bounds how long run() waits out a
  // transient database error from claiming work before it ends the run (#122).
  // health ({ failuresToOpen, pauseBaseMs, pauseMaxMs, opensToHalt }) tunes the
  // monitor that tells one page's failure from the whole crawl's, and
  // minFreeBytes halts the run when the raw store's disk has less than that free
  // (0 turns the check off) (#114).
  constructor({ fetcher, discovery, parsers, normalizer, persistence, rawStore, clock, events = NO_CRAWL_EVENTS, parserVersions, storeRetry = DEFAULT_STORE_RETRY, health, minFreeBytes = 0 }) {
    this.events = events;
    this.health = new HealthMonitor({ ...health, clock });
    this.minFreeBytes = minFreeBytes;
    this.storeRetry = Object.freeze({ ...DEFAULT_STORE_RETRY, ...storeRetry });
    this.parserVersions = parserVersions;
    this.fetcher = fetcher;
    this.discovery = discovery;
    this.parsers = parsers;
    this.normalizer = normalizer;
    this.persistence = persistence;
    this.rawStore = rawStore;
    this.clock = clock;
  }

  // A run halts on a challenge (HALTING_STOP_CODES): after the job that got it,
  // and before claiming anything while any challenge stop still awaits an
  // operator's review (npm run review), so a restarted worker makes no request
  // either. Returns the halt, or null.
  async #haltBeforeStart(store = (operation) => operation()) {
    const pending = await store(() => this.persistence.unreviewedChallenges());
    if (!pending.length) return null;
    return this.#halt({ jobKey: pending[0].jobKey, pageType: pending[0].pageType, code: pending[0].code, awaitingReview: pending.length, detail: pending[0].detail ?? undefined });
  }

  #halt({ jobKey = null, pageType = null, code = 'challenge', awaitingReview = 1, detail }) {
    const halt = Object.freeze({ reason: code, jobKey, pageType, awaitingReview, ...(detail ? { detail } : {}) });
    this.events.emit('run.halted', halt);
    return halt;
  }

  #haltAfter(event) {
    return event?.kind === 'operator_stop' && HALTING_STOP_CODES.includes(event.code)
      ? this.#halt({ jobKey: event.jobKey, pageType: event.pageType, code: event.code }) : null;
  }

  // The longest wait before a request to the host may start (a pause after a 429,
  // or another request holding it), or null (#113, #118). The worker waits it out
  // instead of claiming a job only to settle it as host-busy and claim the next.
  async #hostWait(store = (operation) => operation()) {
    if (typeof this.persistence.hostGate !== 'function') return null;
    let longest = null;
    for (const host of this.fetcher?.allowedHosts ?? []) {
      const gate = await store(() => this.persistence.hostGate(host));
      if (gate.waitMs > 0 && (!longest || gate.waitMs > longest.waitMs)) longest = { host, ...gate };
    }
    return longest;
  }

  // Runs a database call from the run loop, waiting out a transient error with
  // growing pauses (#122): a short outage pauses the run, which then continues
  // without a restart. Out of disk or memory (53100, 53200) halts the run, since
  // waiting does not help. Anything else, or too many tries, is the caller's error.
  #storeWaiter(sleep, signal) {
    return async (operation) => {
      const { attempts, baseMs, maxMs } = this.storeRetry;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          if (isSystemicStoreError(error)) {
            throw new RunHalt('database_storage_full', `the database reports it is out of disk or memory (${error.code ?? 'systemic'}); free space, then restart the worker`);
          }
          if (!isTransientStoreError(error) || attempt >= attempts || signal?.aborted) throw error;
          const waitMs = Math.min(baseMs * (2 ** (attempt - 1)), maxMs);
          this.events.emit('store.retrying', { attempt, waitMs, code: error.code });
          await sleep(waitMs, signal);
        }
      }
    };
  }

  // Halts the run when the raw store's disk is nearly full, before a request whose
  // body could not be kept (#114).
  async #checkDisk() {
    if (!this.minFreeBytes || typeof this.rawStore?.freeBytes !== 'function') return;
    const free = await this.rawStore.freeBytes();
    if (free < this.minFreeBytes) {
      throw new RunHalt('raw_disk_low', `the raw store has ${free} bytes free, below the ${this.minFreeBytes} minimum; free space on RAW_STORE_ROOT or enlarge the disk`);
    }
  }

  // Records a halt that is not one page's, so a restarted worker stays halted until
  // an operator releases it. Best effort: the database may be what is down.
  async #recordHalt(error) {
    try { await this.persistence.recordRunHalt?.({ reason: error.reason, detail: error.message }); } catch { /* not recorded */ }
  }

  // Puts a job back without charging it, because its failure is the crawl's and not
  // its own (#114): it waits out the pause, and the run halts if the monitor says so.
  async #putBack(job, reason, { pauseUntil, opens, halt }, phase) {
    const nextAllowedAt = pauseUntil.toISOString();
    this.events.emit('health.paused', { jobKey: job.key, opens, pauseUntil: nextAllowedAt, reason });
    let event;
    try {
      await this.persistence.transitionJob(job.key, 'retry_wait', job.lease, { nextAllowedAt, lastError: reason, code: 'systemic_pause', ...(phase ? { failurePhase: phase } : {}) });
      event = { kind: 'retry_wait', code: 'systemic_pause', jobKey: job.key, pageType: job.pageType, reason, nextAllowedAt };
    } catch (transitionError) {
      event = { kind: 'unsettled', code: 'systemic_pause', jobKey: job.key, pageType: job.pageType, reason, settleError: transitionError?.message ?? String(transitionError) };
    }
    if (halt) throw new RunHalt('systemic_failures', `${opens} pauses in a row with no request succeeding in between: the site, the network or this host is failing every page. Last failure: ${reason}`);
    return event;
  }

  // Puts the job back uncharged (best effort: the database may not answer) and ends
  // the run for a cause that is not the page's.
  async #haltFor(job, reason, halt, retryMessage) {
    try {
      await this.persistence.transitionJob(job.key, 'retry_wait', job.lease, { nextAllowedAt: new Date(this.clock().getTime() + 300_000).toISOString(), lastError: retryMessage, code: halt });
    } catch { /* claim recovery settles it */ }
    throw new RunHalt(halt, reason);
  }

  // One log line per wait, not one per sleep.
  #announceWait(wait) {
    const key = wait ? `${wait.host}:${wait.reason}` : null;
    if (key === this.lastWait) return;
    this.lastWait = key;
    if (wait) this.events.emit('host.waiting', { host: wait.host, reason: wait.reason, waitMs: wait.waitMs });
  }

  // Processes every job that is claimable now, then returns. Returns job
  // counts by state rather than the jobs themselves, and `halt` when a
  // challenge stopped the run.
  // pageTypes limits the run to those page types (a manifest run, #44).
  async runOnce(workerId = 'worker', { pageTypes } = {}) {
    let processed = 0;
    const events = [];
    let halt = await this.#haltBeforeStart();
    try {
      while (!halt) {
        if (this.health.waitUntil() || await this.#hostWait()) break;
        await this.#checkDisk();
        const job = await this.persistence.claimNextJob(this.clock(), workerId, { pageTypes });
        if (!job) break;
        const event = await this.#process(job);
        if (event) events.push(Object.freeze(event));
        if (event) this.events.emit('job.settled', event);
        processed += 1;
        halt = this.#haltAfter(event);
      }
    } catch (error) {
      if (!(error instanceof RunHalt)) throw error;
      halt = this.#halt({ code: error.reason, awaitingReview: 0, detail: error.message });
      await this.#recordHalt(error);
    }
    return { processed, counts: await this.persistence.jobCounts(), events: Object.freeze(events), ...(halt ? { halt } : {}) };
  }

  // Long-running worker loop. When nothing is claimable it sleeps until the
  // earliest retry falls due or claim expires (at most maxIdleMs, at least
  // minIdleMs), and it returns once no runnable pending, retry_wait, fetching
  // or fetched work remains. Aborting `signal` stops claiming: the current job
  // finishes (a request on the wire completes, a request not yet started is
  // skipped and its host released) and the loop returns. Events are passed to
  // onEvent and tallied by kind rather than kept.
  async run({ workerId = 'worker', signal, maxIdleMs = 30_000, minIdleMs = 250, onEvent = () => {}, sleep = abortableDelay, pageTypes } = {}) {
    let processed = 0;
    const outcomes = {};
    const store = this.#storeWaiter(sleep, signal);
    let halt = null;
    try {
      halt = await this.#haltBeforeStart(store);
      while (!halt && !signal?.aborted) {
        const systemic = this.health.waitUntil();
        if (systemic) {
          const held = await store(() => this.persistence.workOutlook({ pageTypes }));
          if (!held.remaining) break;
          const waitMs = systemic.getTime() - this.clock().getTime();
          this.#announceWait({ host: null, reason: 'systemic_pause', waitMs });
          await sleep(Math.min(maxIdleMs, Math.max(minIdleMs, waitMs)), signal);
          continue;
        }
        const wait = await this.#hostWait(store);
        if (wait) {
          const held = await store(() => this.persistence.workOutlook({ pageTypes }));
          if (!held.remaining) break;
          this.#announceWait(wait);
          await sleep(Math.min(maxIdleMs, Math.max(minIdleMs, wait.waitMs)), signal);
          continue;
        }
        this.#announceWait(null);
        await this.#checkDisk();
        const job = await store(() => this.persistence.claimNextJob(this.clock(), workerId, { pageTypes }));
        if (job) {
          const event = await this.#process(job, signal);
          processed += 1;
          if (event) {
            outcomes[event.kind] = (outcomes[event.kind] ?? 0) + 1;
            onEvent(Object.freeze(event));
          }
          halt = this.#haltAfter(event);
          continue;
        }
        const outlook = await store(() => this.persistence.workOutlook({ pageTypes }));
        if (!outlook.remaining) break;
        await sleep(Math.min(maxIdleMs, Math.max(minIdleMs, outlook.wakeInMs ?? maxIdleMs)), signal);
      }
    } catch (error) {
      if (!(error instanceof RunHalt)) throw error;
      halt = this.#halt({ code: error.reason, awaitingReview: 0, detail: error.message });
      await this.#recordHalt(error);
    }
    // stopped: the run ended with work left, for a signal or a challenge halt.
    const stopReason = halt ? halt.reason : signal?.aborted ? 'signal' : null;
    let counts = null;
    try { counts = await this.persistence.jobCounts(); } catch (error) { if (!halt) throw error; }
    return { processed, stopped: Boolean(stopReason), stopReason, ...(halt ? { halt } : {}), outcomes, counts };
  }

  async #process(job, signal) {
    let phase = 'fetch';
    try {
      const result = await this.fetcher.fetch(job, job.lease, { signal });
      // A transport error or 5xx across different pages is the crawl's failure, not
      // a page's: past a few in a row the monitor has it put back uncharged (#114).
      if (INFRASTRUCTURE_CODES.has(result.code) && (result.kind === 'permanently_failed' || (result.kind === 'retry_wait' && result.charge === 'failure'))) {
        const verdict = this.health.recordFailure(job.key);
        if (verdict.action !== 'charge') return this.#putBack(job, result.reason, { ...verdict, halt: verdict.action === 'halt' });
      }
      if (result.kind === 'retry_wait') {
        await this.persistence.transitionJob(job.key, 'retry_wait', job.lease, {
          nextAllowedAt: result.nextAllowedAt,
          lastError: result.reason,
          ...(result.charge ? { charge: result.charge } : {}),
        });
        return { kind: 'retry_wait', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason, nextAllowedAt: result.nextAllowedAt };
      }
      if (result.kind === 'operator_stop') {
        // The code (for example challenge) is recorded so a restarted run can
        // tell an unreviewed challenge from other stops.
        await this.persistence.transitionJob(job.key, 'operator_stop', job.lease, { lastError: result.reason, ...(result.code ? { code: result.code } : {}) });
        return { kind: 'operator_stop', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason };
      }
      if (result.kind === 'permanently_failed') {
        await this.persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason, ...(result.code ? { code: result.code } : {}) });
        return { kind: 'permanently_failed', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason };
      }
      phase = 'snapshot';
      // The Fetcher returns the body it verified against the durable object
      // (#91), so it is not read and hashed again. Only a result without one
      // is read back from the raw store.
      let body = result.body;
      if (!body) {
        const stored = await this.rawStore.read(result.checksum);
        if (!stored.ok) {
          await this.persistence.transitionJob(job.key, 'operator_stop', job.lease, {
            lastError: `raw snapshot ${result.checksum} is unavailable or failed durable verification after fetch: ${stored.reason ?? 'unavailable'}`,
          });
          return { kind: 'operator_stop', jobKey: job.key, pageType: job.pageType, reason: 'raw snapshot failed durable verification' };
        }
        body = stored.body;
      }
      await this.persistence.transitionJob(job.key, 'fetched', job.lease, { sourceFetchId: result.sourceFetchId });
      const snapshot = snapshotFor(job, body, { finalUrl: result.finalUrl });
      phase = 'parse';
      const { parsed, run } = parseSnapshot({
        parsers: this.parsers, job, snapshot, parserVersion: parserVersionFor(job, this.parserVersions),
        sourceFetchId: result.sourceFetchId, clock: this.clock,
      });
      await this.persistence.recordParse(run, job.lease);
      if (parsed.kind === 'structural_failure') {
        await this.persistence.transitionJob(job.key, 'parse_failed', job.lease, { failureReason: parsed.error });
        this.health.recordSuccess();
        return { kind: 'parse_failed', jobKey: job.key, pageType: job.pageType, reason: parsed.error, warnings: parsed.warnings };
      }
      phase = 'normalize';
      const { discovered, page, provenance } = normalizeParsedPage({
        job, snapshot, parsed, run, discovery: this.discovery, normalizer: this.normalizer, clock: this.clock,
      });
      this.events.emit('page.discovered', { jobKey: job.key, pageType: job.pageType, childKeys: discovered.childJobs.map((child) => child.key) });
      phase = 'commit';
      const committed = await this.persistence.commitPageAndTransition(page, provenance, job.lease);
      this.health.recordSuccess();
      return { kind: 'parsed', jobKey: job.key, pageType: job.pageType, warnings: [...(parsed.warnings ?? []), ...discovered.warnings], reconciliationIssues: committed.conflict ? 1 : 0 };
    } catch (error) {
      // Fetch-phase errors, and transient database errors in any phase, say
      // nothing about the page: retry. Only the remaining parse, normalize
      // and commit errors are structural and become parse_failed.
      if (error instanceof RunHalt) throw error;
      if (isSystemicStoreError(error)) {
        // Out of disk or memory on the database says nothing about this page.
        await this.#haltFor(job, `the database reports it is out of disk or memory (${error.code ?? 'systemic'}); free space, then restart the worker`,
          'database_storage_full', `database out of resources (${error.code})`);
      }
      if (isSystemicRawStoreError(error)) {
        // The raw disk is full or read-only: every write would fail, so halt rather than charge each page.
        await this.#haltFor(job, `the raw store cannot be written (${error.code ?? 'systemic'}); free space on RAW_STORE_ROOT, then release the halt with npm run review`,
          'raw_store_write_failed', `raw store write failed (${error.code})`);
      }
      if (phase === 'fetch' || phase === 'snapshot' || isTransientStoreError(error)) return this.#retryFailure(job, error, phase);
      const current = await this.persistence.getJob(job.key);
      if (current?.claim && ['fetching', 'fetched'].includes(current.state)) {
        try {
          await this.persistence.transitionJob(job.key, 'parse_failed', job.lease, {
            failureReason: error.message,
            failurePhase: phase,
          });
        } catch (transitionError) {
          await this.persistence.recoverExpiredClaims(this.clock());
          const recovered = await this.persistence.getJob(job.key);
          if (!FAILURE_SETTLED_STATES.has(recovered?.state)) {
            throw new AggregateError(
              [error, transitionError],
              `failed to classify ${phase} failure for job ${job.key}`,
            );
          }
        }
      } else {
        await this.persistence.recoverExpiredClaims(this.clock());
        if (!FAILURE_SETTLED_STATES.has((await this.persistence.getJob(job.key))?.state)) throw error;
      }
      return { kind: 'parse_failed', jobKey: job.key, pageType: job.pageType, reason: error.message, phase };
    }
  }

  // An infrastructure error (raw store write, database call or deadlock,
  // lease renewal) settles only this job: it becomes a charged retry with
  // bounded backoff, or permanently_failed once the budget is spent, and the
  // run moves on. Errors marked fatal are wiring defects and still stop it.
  async #retryFailure(job, error, phase) {
    if (error?.fatal) throw error;
    const reason = `${phase} failed: ${error?.message ?? String(error)}`;
    const verdict = this.health.recordFailure(job.key);
    if (verdict.action !== 'charge') return this.#putBack(job, reason, { ...verdict, halt: verdict.action === 'halt' }, phase);
    const outcome = chargedRetry(this.fetcher.policy ?? REQUEST_POLICY_DEFAULTS, job, reason, error?.code ?? 'infrastructure', this.clock());
    const details = outcome.kind === 'retry_wait'
      ? { nextAllowedAt: outcome.nextAllowedAt, lastError: reason, failurePhase: phase, charge: outcome.charge }
      : { lastError: outcome.reason, failurePhase: phase };
    try {
      await this.persistence.transitionJob(job.key, outcome.kind, job.lease, details);
    } catch (transitionError) {
      // The lease is gone or the host request could not be released. Claim
      // recovery (and orphaned-request release) settles the job later.
      return { kind: 'unsettled', code: outcome.code, jobKey: job.key, pageType: job.pageType, reason, phase,
        settleError: transitionError?.message ?? String(transitionError) };
    }
    return { kind: outcome.kind, code: outcome.code, jobKey: job.key, pageType: job.pageType, reason: outcome.reason, phase,
      ...(outcome.nextAllowedAt ? { nextAllowedAt: outcome.nextAllowedAt } : {}) };
  }
}
