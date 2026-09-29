import { NO_CRAWL_EVENTS } from './crawl-log.mjs';
import { normalizeParsedPage, parseSnapshot, parserVersionFor, snapshotFor } from './page-pipeline.mjs';
import { REQUEST_POLICY_DEFAULTS, chargedRetry } from '../contracts/request-policy.mjs';
import { HALTING_STOP_CODES, isTransientStoreError } from '../contracts/jobs.mjs';

// Sleeps for ms, ending early (without throwing) if the signal aborts.
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const FAILURE_SETTLED_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);

export class IngestionOrchestrator {
  // events is the crawl-log sink (./crawl-log.mjs); hooks below are single emit calls.
  // parserVersions ({ pageType: version }, from the configuration) chooses the
  // parser for each page type; without it a job's queued version is used.
  constructor({ fetcher, discovery, parsers, normalizer, persistence, rawStore, clock, events = NO_CRAWL_EVENTS, parserVersions }) {
    this.events = events;
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
  async #haltBeforeStart() {
    const pending = await this.persistence.unreviewedChallenges();
    if (!pending.length) return null;
    return this.#halt({ jobKey: pending[0].jobKey, pageType: pending[0].pageType, awaitingReview: pending.length });
  }

  #halt({ jobKey, pageType, awaitingReview = 1 }) {
    const halt = Object.freeze({ reason: 'challenge', jobKey, pageType, awaitingReview });
    this.events.emit('run.halted', halt);
    return halt;
  }

  #haltAfter(event) {
    return event?.kind === 'operator_stop' && HALTING_STOP_CODES.includes(event.code)
      ? this.#halt({ jobKey: event.jobKey, pageType: event.pageType }) : null;
  }

  // Processes every job that is claimable now, then returns. Returns job
  // counts by state rather than the jobs themselves, and `halt` when a
  // challenge stopped the run.
  // pageTypes limits the run to those page types (a manifest run, #44).
  async runOnce(workerId = 'worker', { pageTypes } = {}) {
    let processed = 0;
    const events = [];
    let halt = await this.#haltBeforeStart();
    while (!halt) {
      const job = await this.persistence.claimNextJob(this.clock(), workerId, { pageTypes });
      if (!job) break;
      const event = await this.#process(job);
      if (event) events.push(Object.freeze(event));
      if (event) this.events.emit('job.settled', event);
      processed += 1;
      halt = this.#haltAfter(event);
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
    let halt = await this.#haltBeforeStart();
    while (!halt && !signal?.aborted) {
      const job = await this.persistence.claimNextJob(this.clock(), workerId, { pageTypes });
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
      const outlook = await this.persistence.workOutlook({ pageTypes });
      if (!outlook.remaining) break;
      await sleep(Math.min(maxIdleMs, Math.max(minIdleMs, outlook.wakeInMs ?? maxIdleMs)), signal);
    }
    // stopped: the run ended with work left, for a signal or a challenge halt.
    const stopReason = halt ? 'challenge' : signal?.aborted ? 'signal' : null;
    return { processed, stopped: Boolean(stopReason), stopReason, ...(halt ? { halt } : {}), outcomes, counts: await this.persistence.jobCounts() };
  }

  async #process(job, signal) {
    let phase = 'fetch';
    try {
      const result = await this.fetcher.fetch(job, job.lease, { signal });
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
        await this.persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason });
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
      const snapshot = snapshotFor(job, body);
      phase = 'parse';
      const { parsed, run } = parseSnapshot({
        parsers: this.parsers, job, snapshot, parserVersion: parserVersionFor(job, this.parserVersions),
        sourceFetchId: result.sourceFetchId, clock: this.clock,
      });
      await this.persistence.recordParse(run, job.lease);
      if (parsed.kind === 'structural_failure') {
        await this.persistence.transitionJob(job.key, 'parse_failed', job.lease, { failureReason: parsed.error });
        return { kind: 'parse_failed', jobKey: job.key, pageType: job.pageType, reason: parsed.error, warnings: parsed.warnings };
      }
      phase = 'normalize';
      const { discovered, page, provenance } = normalizeParsedPage({
        job, snapshot, parsed, run, discovery: this.discovery, normalizer: this.normalizer, clock: this.clock,
      });
      this.events.emit('page.discovered', { jobKey: job.key, pageType: job.pageType, childKeys: discovered.childJobs.map((child) => child.key) });
      phase = 'commit';
      const committed = await this.persistence.commitPageAndTransition(page, provenance, job.lease);
      return { kind: 'parsed', jobKey: job.key, pageType: job.pageType, warnings: [...(parsed.warnings ?? []), ...discovered.warnings], reconciliationIssues: committed.conflict ? 1 : 0 };
    } catch (error) {
      // Fetch-phase errors, and transient database errors in any phase, say
      // nothing about the page: retry. Only the remaining parse, normalize
      // and commit errors are structural and become parse_failed.
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
