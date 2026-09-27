import { createProvenance } from '../contracts/provenance.mjs';
import { createSourceUrl } from '../contracts/source.mjs';
import { createSnapshot } from '../contracts/boundaries.mjs';
import { NO_CRAWL_EVENTS } from './crawl-log.mjs';
import { REQUEST_POLICY_DEFAULTS, chargedRetry } from '../contracts/request-policy.mjs';
import { isTransientStoreError } from '../contracts/jobs.mjs';

const FAILURE_SETTLED_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);

export class IngestionOrchestrator {
  // events is the crawl-log sink (./crawl-log.mjs); hooks below are single emit calls.
  constructor({ fetcher, discovery, parsers, normalizer, persistence, rawStore, clock, events = NO_CRAWL_EVENTS }) {
    this.events = events;
    this.fetcher = fetcher;
    this.discovery = discovery;
    this.parsers = parsers;
    this.normalizer = normalizer;
    this.persistence = persistence;
    this.rawStore = rawStore;
    this.clock = clock;
  }

  async runOnce(workerId = 'worker') {
    let processed = 0;
    const events = [];
    for (;;) {
      const job = await this.persistence.claimNextJob(this.clock(), workerId);
      if (!job) break;
      const event = await this.#process(job);
      if (event) events.push(Object.freeze(event));
      if (event) this.events.emit('job.settled', event);
      processed += 1;
    }
    return { processed, jobs: await this.persistence.listJobs(), events: Object.freeze(events) };
  }

  async #process(job) {
    let phase = 'fetch';
    try {
      const result = await this.fetcher.fetch(job, job.lease);
      if (result.kind === 'retry_wait') {
        await this.persistence.transitionJob(job.key, 'retry_wait', job.lease, {
          nextAllowedAt: result.nextAllowedAt,
          lastError: result.reason,
          ...(result.charge ? { charge: result.charge } : {}),
        });
        return { kind: 'retry_wait', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason, nextAllowedAt: result.nextAllowedAt };
      }
      if (result.kind === 'operator_stop') {
        await this.persistence.transitionJob(job.key, 'operator_stop', job.lease, { lastError: result.reason });
        return { kind: 'operator_stop', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason };
      }
      if (result.kind === 'permanently_failed') {
        await this.persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason });
        return { kind: 'permanently_failed', code: result.code, jobKey: job.key, pageType: job.pageType, reason: result.reason };
      }
      phase = 'snapshot';
      const stored = this.rawStore.get(result.checksum);
      const verification = this.rawStore.verify(result.checksum, stored?.objectPath);
      if (!stored || !verification.ok) {
        await this.persistence.transitionJob(job.key, 'operator_stop', job.lease, {
          lastError: `raw snapshot ${result.checksum} is unavailable or failed durable verification after fetch: ${verification.reason ?? 'unavailable'}`,
        });
        return { kind: 'operator_stop', jobKey: job.key, pageType: job.pageType, reason: 'raw snapshot failed durable verification' };
      }
      await this.persistence.transitionJob(job.key, 'fetched', job.lease, { sourceFetchId: result.sourceFetchId });
      const snapshot = createSnapshot({
        jobKey: job.key,
        parentKey: job.parentKey,
        schoolSourcePath: job.schoolSourcePath,
        sourceUrl: job.sourceUrl,
        body: stored.body,
        sourceUrlFrom: (target, baseUrl = job.sourceUrl.absoluteUrl) => createSourceUrl(job.sourceUrl.providerId, target, baseUrl),
      });
      phase = 'parse';
      const parserVersion = job.parserVersion ?? '1';
      const parser = this.parsers.get(job.pageType, parserVersion);
      const parsed = this.parsers.parse(job.pageType, parserVersion, snapshot);
      await this.persistence.recordParse({
        jobKey: job.key,
        sourceFetchId: result.sourceFetchId,
        parserName: job.pageType,
        parserVersion: parser.version(),
        status: parsed.kind,
        warnings: parsed.warnings ?? [],
        failureDetails: parsed.kind === 'structural_failure' ? { error: parsed.error } : null,
        parsedAt: this.clock().toISOString(),
      }, job.lease);
      if (parsed.kind === 'structural_failure') {
        await this.persistence.transitionJob(job.key, 'parse_failed', job.lease, { failureReason: parsed.error });
        return { kind: 'parse_failed', jobKey: job.key, pageType: job.pageType, reason: parsed.error, warnings: parsed.warnings };
      }
      phase = 'normalize';
      const discovered = this.discovery.discover(job.pageType, snapshot, parsed.document);
      this.events.emit('page.discovered', { jobKey: job.key, pageType: job.pageType, childKeys: discovered.childJobs.map((child) => child.key) });
      const page = this.normalizer.normalize(job.pageType, parsed.document, {
        jobKey: job.key,
        canonicalPath: job.canonicalPath,
        observations: discovered.observations,
        childJobs: discovered.childJobs,
        unavailableCoverage: discovered.unavailableCoverage,
      });
      const provenance = createProvenance({
        providerId: job.sourceUrl.providerId,
        canonicalPath: job.canonicalPath,
        sourceUrl: job.sourceUrl,
        sourceFetchId: result.sourceFetchId,
        parserName: job.pageType,
        parserVersion: parser.version(),
        parsedAt: this.clock().toISOString(),
      });
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
