import { createProvenance } from '../contracts/provenance.mjs';
import { createSourceUrl } from '../contracts/source.mjs';

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
    for (;;) {
      const job = this.persistence.claimNextJob(this.clock(), workerId);
      if (!job) break;
      await this.#process(job);
      processed += 1;
    }
    return { processed, jobs: this.persistence.listJobs() };
  }

  async #process(job) {
    let phase = 'fetch';
    try {
      const result = await this.fetcher.fetch(job, job.lease);
      if (result.kind === 'retry_wait') {
        this.persistence.transitionJob(job.key, 'retry_wait', job.lease, {
          nextAllowedAt: result.nextAllowedAt,
          lastError: result.reason,
        });
        return;
      }
      if (result.kind === 'operator_stop') {
        this.persistence.transitionJob(job.key, 'operator_stop', job.lease, { lastError: result.reason });
        return;
      }
      if (result.kind === 'permanently_failed') {
        this.persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason });
        return;
      }
      this.persistence.transitionJob(job.key, 'fetched', job.lease, { sourceFetchId: result.sourceFetchId });
      const stored = this.rawStore.get(result.checksum);
      if (!stored) throw new Error(`raw snapshot ${result.checksum} is unavailable after fetch`);
      const snapshot = {
        jobKey: job.key,
        parentKey: job.parentKey,
        schoolSourcePath: job.schoolSourcePath,
        sourceUrl: job.sourceUrl,
        body: stored.body,
        sourceUrlFrom: (target, baseUrl = job.sourceUrl.absoluteUrl) => createSourceUrl(job.sourceUrl.providerId, target, baseUrl),
      };
      phase = 'parse';
      const parser = this.parsers.get(job.pageType, job.parserVersion ?? '1');
      const parsed = parser.parse(snapshot);
      this.persistence.recordParse({
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
        this.persistence.transitionJob(job.key, 'parse_failed', job.lease, { failureReason: parsed.error });
        return;
      }
      phase = 'normalize';
      const discovered = this.discovery.discover(job.pageType, snapshot, parsed.document);
      const page = this.normalizer.normalize(job.pageType, parsed.document, {
        jobKey: job.key,
        canonicalPath: job.canonicalPath,
        observations: discovered.observations,
      });
      page.childJobs = discovered.childJobs;
      page.unavailableCoverage = discovered.unavailableCoverage;
      const provenance = createProvenance({
        providerId: job.sourceUrl.providerId,
        canonicalPath: job.canonicalPath,
        sourceUrl: job.sourceUrl,
        sourceFetchId: result.sourceFetchId,
        parserName: job.pageType,
        parserVersion: parser.version(),
        parsedAt: this.clock().toISOString(),
      });
      this.persistence.commitPage(page, provenance, job.lease);
      this.persistence.transitionJob(job.key, 'parsed', job.lease);
    } catch (error) {
      const current = this.persistence.getJob(job.key);
      if (current?.claim && ['fetching', 'fetched'].includes(current.state)) {
        try {
          this.persistence.transitionJob(
            job.key,
            phase === 'fetch' ? 'permanently_failed' : 'parse_failed',
            job.lease,
            { failureReason: error.message, failurePhase: phase },
          );
        } catch (transitionError) {
          this.persistence.recoverExpiredClaims(this.clock());
          if (this.persistence.getJob(job.key)?.state === 'fetching') throw transitionError;
        }
      } else if (current?.state === 'fetching' || current?.state === 'fetched') {
        this.persistence.recoverExpiredClaims(this.clock());
      } else if (current?.state !== 'retry_wait' && current?.state !== 'operator_stop') {
        throw error;
      }
    }
  }
}
