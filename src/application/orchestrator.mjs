import { createProvenance } from '../contracts/provenance.mjs';
import { createSourceUrl } from '../contracts/source.mjs';
import { createSnapshot } from '../contracts/boundaries.mjs';

const FAILURE_SETTLED_STATES = new Set(['retry_wait', 'operator_stop', 'parsed', 'parse_failed', 'permanently_failed']);

export class IngestionOrchestrator {
  constructor({ fetcher, discovery, parsers, normalizer, persistence, rawStore, clock }) {
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
      const committed = await this.persistence.commitPageAndTransition(page, provenance, job.lease);
      return { kind: 'parsed', jobKey: job.key, pageType: job.pageType, warnings: [...(parsed.warnings ?? []), ...discovered.warnings], reconciliationIssues: committed.conflict ? 1 : 0 };
    } catch (error) {
      if (phase === 'fetch' || phase === 'snapshot') throw error;
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
}
