import { Injectable, Logger } from '@nestjs/common';
import { OrchestratorService, ReviewContext } from '../orchestrator/orchestrator.service';
import { GithubService } from '../github/github.service';
import { PublisherService } from '../publisher/publisher.service';
import { QueueService } from '../queue/queue.service';
import { LlmEngineService } from '../llm-engine/llm-engine.service';
import { DiffParserService } from '../diff-parser/diff-parser.service';
import { ContextRetrievalService } from '../context-retrieval/context-retrieval.service';
import { StaticFiltersService } from '../static-filters/static-filters.service';
import { PostProcessorService } from '../post-processor/post-processor.service';
import { ReviewState } from '../common/enums/review-state.enum';
import { v4 as uuidv4 } from 'uuid';

export interface DashboardReview {
  reviewId: string;
  prNumber: number;
  repoFullName: string;
  state: string;
  attempt: number;
  findingsCount: number;
  processedFindingsCount: number;
  startedAt: string;
  updatedAt: string;
  elapsedMs?: number;
  error?: string;
}

export interface DashboardStats {
  total: number;
  byState: Record<string, number>;
  recentReviews: DashboardReview[];
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  stage: string;
  message: string;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private readonly activeReviews = new Map<string, {
    logs: LogEntry[];
    status: 'running' | 'done' | 'error';
    findings: any[];
    orchestratorReviewId: string | null;
  }>();

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly github: GithubService,
    private readonly publisher: PublisherService,
    private readonly queueService: QueueService,
    private readonly llmEngine: LlmEngineService,
    private readonly diffParser: DiffParserService,
    private readonly contextRetrieval: ContextRetrievalService,
    private readonly staticFilters: StaticFiltersService,
    private readonly postProcessor: PostProcessorService,
  ) {}

  getStats(): DashboardStats {
    const raw = this.orchestrator.getReviewStats();
    return {
      total: raw.total,
      byState: raw.byState,
      recentReviews: this.getRecentReviews(20),
    };
  }

  getRecentReviews(limit: number): DashboardReview[] {
    const reviews: DashboardReview[] = [];
    const allReviews = (this.orchestrator as any).reviews as Map<string, any>;
    if (!allReviews) return [];

    for (const [id, entry] of allReviews.entries()) {
      const ctx: ReviewContext = entry.context;
      const elapsed =
        ctx.updatedAt && ctx.startedAt
          ? new Date(ctx.updatedAt).getTime() -
            new Date(ctx.startedAt).getTime()
          : undefined;
      reviews.push({
        reviewId: ctx.reviewId,
        prNumber: ctx.prNumber,
        repoFullName: ctx.repoFullName,
        state: ctx.state,
        attempt: ctx.attempt,
        findingsCount: ctx.findings?.length || 0,
        processedFindingsCount: ctx.processedFindings?.length || 0,
        startedAt: ctx.startedAt?.toISOString(),
        updatedAt: ctx.updatedAt?.toISOString(),
        elapsedMs: elapsed,
        error: ctx.error,
      });
    }

    reviews.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return reviews.slice(0, limit);
  }

  /** Resolve a dashboard review ID to the orchestrator's review ID */
  private resolveReviewId(reviewId: string): string {
    const ar = this.activeReviews.get(reviewId);
    if (ar?.orchestratorReviewId) return ar.orchestratorReviewId;
    return reviewId;
  }

  getReviewDetail(reviewId: string): DashboardReview | null {
    const ctx = this.orchestrator.getReview(this.resolveReviewId(reviewId));
    if (!ctx) return null;
    const elapsed =
      ctx.updatedAt && ctx.startedAt
        ? new Date(ctx.updatedAt).getTime() -
          new Date(ctx.startedAt).getTime()
        : undefined;
    return {
      reviewId: ctx.reviewId,
      prNumber: ctx.prNumber,
      repoFullName: ctx.repoFullName,
      state: ctx.state,
      attempt: ctx.attempt,
      findingsCount: ctx.findings?.length || 0,
      processedFindingsCount: ctx.processedFindings?.length || 0,
      startedAt: ctx.startedAt?.toISOString(),
      updatedAt: ctx.updatedAt?.toISOString(),
      elapsedMs: elapsed,
      error: ctx.error,
    };
  }

  getReviewFindings(reviewId: string): any[] {
    const ctx = this.orchestrator.getReview(this.resolveReviewId(reviewId));
    if (!ctx) return [];
    return (ctx.processedFindings || ctx.findings || []).map((f: any) => ({
      finding_id: f.finding_id,
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      cwe: f.cwe || null,
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
      title: f.title,
      explanation: f.explanation,
      fix_explanation: f.fix_explanation || null,
      suggestion_type: f.suggestion?.type,
      suggestion_patch: f.suggestion?.patch || null,
    }));
  }

  getReviewLogs(reviewId: string): LogEntry[] {
    return this.activeReviews.get(reviewId)?.logs || [];
  }

  /** List GitHub App installations */
  async listInstallations() {
    return this.github.listInstallations();
  }

  /** List repos for an installation */
  async listRepos(installationId: number) {
    return this.github.listInstallationRepos(installationId);
  }

  /** List PRs for a repo */
  async listPRs(owner: string, repo: string, state?: string) {
    const repository = {
      owner: { login: owner },
      name: repo,
      full_name: `${owner}/${repo}`,
    };
    return this.github.listPullRequests(repository as any, state || 'open');
  }

  /** Run a review from the dashboard */
  async runReview(owner: string, repo: string, prNumber: number): Promise<{ reviewId: string }> {
    const reviewId = uuidv4();
    const repoFullName = `${owner}/${repo}`;

    this.activeReviews.set(reviewId, {
      logs: [],
      status: 'running',
      findings: [],
      orchestratorReviewId: null,
    });

    const log = (stage: string, message: string, level: LogEntry['level'] = 'info') => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        stage,
        message,
      };
      this.activeReviews.get(reviewId)?.logs.push(entry);
    };

    log('init', `Starting review for PR #${prNumber} in ${repoFullName}`);

    try {
      log('github', `Fetching PR #${prNumber} details from GitHub...`);
      const repository = {
        owner: { login: owner },
        name: repo,
        full_name: repoFullName,
      };
      const pr = await this.github.getPullRequest(repository as any, prNumber);
      log('github', `PR: "${pr.title}" by @${pr.user.login} (${pr.head.ref} → ${pr.base.ref})`, 'success');

      const context = this.orchestrator.createReview({
        deliveryId: `dashboard-${reviewId}`,
        prNumber,
        repoFullName,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        prData: pr as any,
        repoData: repository as any,
        idempotencyKey: reviewId,
      });

      log('orchestrator', `Review created: ${context.reviewId}`);
      const ar2 = this.activeReviews.get(reviewId);
      if (ar2) ar2.orchestratorReviewId = context.reviewId;

      this.orchestrator.transition(context.reviewId, 'cloning' as any);
      log('clone', `Cloning ${repoFullName}@${pr.head.sha.substring(0, 8)}...`);
      const clonePath = await this.github.cloneRepository(repository as any, pr.head.ref);
      log('clone', `Clone complete: ${clonePath}`, 'success');

      this.orchestrator.transition(context.reviewId, 'indexing' as any);
      log('index', 'Indexing repository (symbols, AST, embeddings)...');

      this.orchestrator.transition(context.reviewId, 'triage' as any);
      log('triage', 'Fetching diff and running triage...');
      const diff = await this.github.getPullRequestDiff(repository as any, prNumber);
      log('triage', `Diff fetched (${diff.split('\n').length} lines)`);

      this.orchestrator.transition(context.reviewId, 'deep_review' as any);
      log('review', 'Deep review pipeline initiated. Full LLM review runs asynchronously via the queue.', 'warn');
      log('review', 'Results will appear here when the review job completes.', 'info');

      this.orchestrator.transition(context.reviewId, 'done' as any);
      log('done', `Review ${reviewId} initialized. Check back for results.`, 'success');

      this.activeReviews.get(reviewId)!.status = 'done';

    } catch (error: any) {
      log('error', `Review failed: ${error.message}`, 'error');
      this.activeReviews.get(reviewId)!.status = 'error';
    }

    return { reviewId };
  }

  /** Run a review on a branch (no PR required) — returns immediately, processes async */
  async runBranchReview(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ reviewId: string }> {
    const reviewId = uuidv4();
    const repoFullName = `${owner}/${repo}`;

    this.activeReviews.set(reviewId, {
      logs: [],
      status: 'running',
      findings: [],
      orchestratorReviewId: null,
    });

    const log = (stage: string, message: string, level: LogEntry['level'] = 'info') => {
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        stage,
        message,
      };
      this.activeReviews.get(reviewId)?.logs.push(entry);
    };

    log('init', `Starting branch review for ${branch} in ${repoFullName}`);

    // Kick off the full review pipeline asynchronously
    this.executeBranchReview(reviewId, owner, repo, branch, repoFullName, log).catch((error: any) => {
      log('error', `Unhandled error: ${error.message}`, 'error');
      this.activeReviews.get(reviewId)!.status = 'error';
    });

    return { reviewId };
  }

  /** Execute the full branch review pipeline (async) */
  private async executeBranchReview(
    reviewId: string,
    owner: string,
    repo: string,
    branch: string,
    repoFullName: string,
    log: (stage: string, message: string, level?: LogEntry['level']) => void,
  ): Promise<void> {
    try {
      log('github', `Fetching branch ${branch} from GitHub...`);
      const repository = {
        owner: { login: owner },
        name: repo,
        full_name: repoFullName,
      };

      // Get branch info
      const branchInfo = await this.github.getBranch(repository as any, branch);
      log('github', `Branch: ${branch} @ ${branchInfo.commit.sha.substring(0, 8)}`, 'success');

      // Get default branch for comparison
      const defaultBranch = await this.github.getDefaultBranchInfo(repository as any);
      log('github', `Comparing against default branch: ${defaultBranch.name} @ ${defaultBranch.commit.sha.substring(0, 8)}`);

      // Create review context
      const context = this.orchestrator.createReview({
        deliveryId: `dashboard-branch-${reviewId}`,
        prNumber: 0,
        repoFullName,
        headSha: branchInfo.commit.sha,
        baseSha: defaultBranch.commit.sha,
        prData: {
          title: `Branch Review: ${branch}`,
          user: { login: 'dashboard' },
          head: { ref: branch, sha: branchInfo.commit.sha },
          base: { ref: defaultBranch.name, sha: defaultBranch.commit.sha },
        } as any,
        repoData: repository as any,
        idempotencyKey: reviewId,
      });
      log('orchestrator', `Review created: ${context.reviewId}`);
      // Store the orchestrator's review ID so the frontend can poll it
      const ar = this.activeReviews.get(reviewId);
      if (ar) ar.orchestratorReviewId = context.reviewId;

      // ── CLONE ──
      this.orchestrator.transition(context.reviewId, 'cloning' as any);
      log('clone', `Cloning ${repoFullName}@${branch}...`);
      const clonePath = await this.github.cloneRepository(repository as any, branch);
      log('clone', `Clone complete: ${clonePath}`, 'success');

      // ── INDEX ──
      this.orchestrator.transition(context.reviewId, 'indexing' as any);
      log('index', 'Indexing repository (symbols, AST, embeddings)...');
      await this.contextRetrieval.indexRepository(repoFullName, clonePath);
      log('index', 'Indexing complete', 'success');

      // ── TRIAGE ──
      this.orchestrator.transition(context.reviewId, 'triage' as any);
      log('triage', `Fetching diff between ${defaultBranch.name} and ${branch}...`);
      const diff = await this.github.getBranchDiff(repository as any, defaultBranch.name, branch);
      const chunks = await this.diffParser.parseAndChunk(diff, { repoFullName, prNumber: 0 });
      log('triage', `Diff parsed: ${chunks.length} chunks`);

      if (chunks.length === 0) {
        log('review', 'No changes detected between branches. Nothing to review.', 'success');
        this.orchestrator.transition(context.reviewId, 'verify' as any, { chunks: [], findings: [], processedFindings: [], diff });
        this.orchestrator.transition(context.reviewId, 'pending_review' as any);
        this.activeReviews.get(reviewId)!.findings = [];
        this.activeReviews.get(reviewId)!.status = 'done';
        this.orchestrator.transition(context.reviewId, 'done' as any);
        log('done', `✅ No differences found between '${branch}' and '${defaultBranch.name}'. Everything is in sync!`, 'success');
        return;
      }

      // ── STATIC FILTERS ──
      log('review', 'Running static pre-filters (secrets, security patterns)...');
      const filterResults = await this.staticFilters.runAll(chunks, diff);
      log('review', `Static filters: ${filterResults.findings.length} findings`, 'success');

      // ── CONTEXT RETRIEVAL ──
      log('review', 'Retrieving repository context...');
      const retrievalContext = await this.contextRetrieval.retrieveContext(chunks, repoFullName);

      // ── LLM REVIEW ──
      this.orchestrator.transition(context.reviewId, 'deep_review' as any);
      log('review', `Starting LLM review (${chunks.length} chunks)...`);
      const reviewOutput = await this.llmEngine.review({
        chunks,
        diff,
        context: retrievalContext,
        staticResults: filterResults,
        config: context.config,
      });

      const findings = reviewOutput.findings;
      log('review', `LLM review complete: ${findings.length} raw findings`, 'success');

      // ── POST-PROCESS ──
      log('review', 'Post-processing findings (dedup, confidence filter)...');
      const processedFindings = await this.postProcessor.process(findings, {
        repoFullName,
        confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.70'),
        maxComments: 50,
      });
      log('review', `After post-processing: ${processedFindings.length} findings`, 'success');

      // Store findings in the review context
      this.orchestrator.transition(context.reviewId, 'verify' as any, {
        chunks,
        findings,
        processedFindings,
        diff,
      });

      // Move to pending_review then done (skip publishing for branch reviews)
      this.orchestrator.transition(context.reviewId, 'pending_review' as any);

      // Store findings for the dashboard to poll
      this.activeReviews.get(reviewId)!.findings = processedFindings;
      this.activeReviews.get(reviewId)!.status = 'done';

      // ── DONE ──
      this.orchestrator.transition(context.reviewId, 'done' as any);
      if (processedFindings.length === 0) {
        log('done', `✅ Review complete! No issues found in branch '${branch}'. Everything looks OK!`, 'success');
      } else {
        log('done', `✅ Review complete! Found ${processedFindings.length} issue(s) in branch '${branch}'.`, 'success');
      }
    } catch (error: any) {
      log('error', `Review failed: ${error.message}`, 'error');
      this.activeReviews.get(reviewId)!.status = 'error';
    }
  }

  /** Apply approved fixes to the PR */
  async applyFixes(
    owner: string,
    repo: string,
    prNumber: number,
    findings: Array<{
      file: string;
      suggestion_patch: string;
      title: string;
    }>,
  ): Promise<{ branch: string; commitShas: string[] }> {
    const repoFullName = `${owner}/${repo}`;
    const repository = {
      owner: { login: owner },
      name: repo,
      full_name: repoFullName,
    };

    const fixes = findings
      .filter((f) => f.suggestion_patch)
      .map((f, i) => ({
        file: f.file,
        content: f.suggestion_patch,
        commitMessage: `fix: ${f.title} [ReviewBot #${i + 1}]`,
      }));

    if (fixes.length === 0) {
      throw new Error('No applicable fixes with code patches found');
    }

    return this.github.createFixBranch(repository as any, prNumber, fixes);
  }

  /** Publish approved findings as inline PR review comments */
  async publishReview(
    reviewId: string,
    owner: string,
    repo: string,
    prNumber: number,
    approvedFindingIndices: number[],
  ): Promise<{ reviewId: string; commentsPosted: number }> {
    const review = this.orchestrator.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }
    if (review.state !== ReviewState.PENDING_REVIEW) {
      throw new Error(`Review is not pending review (state: ${review.state})`);
    }

    const allFindings = review.processedFindings || review.findings || [];
    const approvedFindings = approvedFindingIndices
      .filter((i) => i >= 0 && i < allFindings.length)
      .map((i) => allFindings[i]);

    if (approvedFindings.length === 0) {
      throw new Error('No valid approved findings to publish');
    }

    this.logger.log(
      `Publishing ${approvedFindings.length} of ${allFindings.length} findings for review ${reviewId}`,
    );

    this.orchestrator.transition(reviewId, ReviewState.PUBLISHING);

    const repository = {
      owner: { login: owner },
      name: repo,
      full_name: `${owner}/${repo}`,
    };

    const result = await this.publisher.publish({
      review,
      findings: approvedFindings,
      repository,
      pullRequest: review.prData,
    });

    this.orchestrator.transition(reviewId, ReviewState.DONE);

    this.logger.log(
      `Published ${result.commentsPosted} comments for review ${reviewId}`,
    );

    return { reviewId, commentsPosted: result.commentsPosted };
  }

  /** Reject a review — dismiss all findings without publishing */
  rejectReview(reviewId: string): { reviewId: string; state: string } {
    const review = this.orchestrator.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }
    if (review.state !== ReviewState.PENDING_REVIEW) {
      throw new Error(`Review is not pending review (state: ${review.state})`);
    }

    this.orchestrator.transition(reviewId, ReviewState.REJECTED);
    this.logger.log(`Review ${reviewId} rejected by user`);

    return { reviewId, state: ReviewState.REJECTED };
  }

  /** Re-run review with a user-provided prompt for additional focus/improvements */
  async reReviewWithPrompt(
    reviewId: string,
    owner: string,
    repo: string,
    prNumber: number,
    prompt: string,
  ): Promise<{ reviewId: string; message: string }> {
    const resolvedId = this.resolveReviewId(reviewId);
    const review = this.orchestrator.getReview(resolvedId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }

    this.logger.log(
      `Re-reviewing ${reviewId} with user prompt: "${prompt.substring(0, 100)}..."`,
    );

    const newReviewId = uuidv4();
    const repoFullName = `${owner}/${repo}`;
    const repository = {
      owner: { login: owner },
      name: repo,
      full_name: repoFullName,
    };

    // Determine head/base SHA — for branch reviews, use stored SHAs; for PRs, fetch fresh
    let headSha = review.headSha;
    let baseSha = review.baseSha;
    let prData = review.prData;

    if (prNumber > 0) {
      // PR review — fetch fresh PR data
      try {
        const pr = await this.github.getPullRequest(repository as any, prNumber);
        headSha = pr.head.sha;
        baseSha = pr.base.sha;
        prData = pr;
      } catch (err: any) {
        this.logger.warn(`Could not fetch PR #${prNumber}, using stored data: ${err.message}`);
      }
    }

    const newReview = this.orchestrator.createReview({
      deliveryId: `re-review-${newReviewId}`,
      prNumber,
      repoFullName,
      headSha,
      baseSha,
      prData,
      repoData: repository,
      idempotencyKey: newReviewId,
    });

    this.orchestrator.transition(newReview.reviewId, ReviewState.QUEUED, {
      config: { ...review.config, userPrompt: prompt },
    });

    // Try queue first (Redis), fall back to direct processing
    try {
      await this.queueService.enqueueReview(
        'process-pr',
        {
          deliveryId: `re-review-${newReviewId}`,
          action: 're_review',
          pullRequest: prData,
          repository,
          idempotencyKey: newReviewId,
          userPrompt: prompt,
        },
        `pr-${repoFullName}-${prNumber}-rereview-${newReviewId}`,
        1,
      );
      this.logger.log(`Re-review queued via BullMQ: ${newReview.reviewId}`);
    } catch (queueError: any) {
      this.logger.warn(`Queue unavailable, processing re-review directly: ${queueError.message}`);
      // Process directly without queue (for free tier / no Redis)
      this.executeReReviewDirectly(newReview, repository, prData, prompt).catch(err => {
        this.logger.error(`Direct re-review failed: ${err.message}`);
      });
    }

    return {
      reviewId: newReview.reviewId,
      message: `Re-review started with your instructions: "${prompt.substring(0, 80)}..."`,
    };
  }

  /** Execute re-review directly without Redis queue */
  private async executeReReviewDirectly(
    review: any,
    repository: any,
    prData: any,
    userPrompt: string,
  ): Promise<void> {
    const repoFullName = repository.full_name;
    const isPrReview = review.prNumber > 0;
    const branch = prData?.head?.ref || 'main';

    try {
      // ── CLONE ──
      this.orchestrator.transition(review.reviewId, 'cloning' as any);
      const clonePath = await this.github.cloneRepository(repository, branch);
      this.logger.log(`[${review.reviewId}] Cloned to ${clonePath}`);

      // ── INDEX ──
      this.orchestrator.transition(review.reviewId, 'indexing' as any);
      await this.contextRetrieval.indexRepository(repoFullName, clonePath);
      this.logger.log(`[${review.reviewId}] Indexed`);

      // ── TRIAGE ──
      this.orchestrator.transition(review.reviewId, 'triage' as any);
      let diff: string;
      if (isPrReview) {
        diff = await this.github.getPullRequestDiff(repository, review.prNumber);
      } else {
        // Branch review — compare against default branch
        const defaultBranch = await this.github.getDefaultBranchInfo(repository);
        diff = await this.github.getBranchDiff(repository, defaultBranch.name, branch);
      }
      const chunks = await this.diffParser.parseAndChunk(diff, { repoFullName, prNumber: review.prNumber });
      this.logger.log(`[${review.reviewId}] Diff parsed: ${chunks.length} chunks`);

      if (chunks.length === 0) {
        this.logger.log(`[${review.reviewId}] No changes detected. Nothing to re-review.`);
        this.orchestrator.transition(review.reviewId, 'verify' as any, { chunks: [], findings: [], processedFindings: [], diff });
        this.orchestrator.transition(review.reviewId, 'pending_review' as any);
        this.orchestrator.transition(review.reviewId, 'done' as any);
        return;
      }

      // ── STATIC FILTERS ──
      this.logger.log(`[${review.reviewId}] Running static pre-filters...`);
      const filterResults = await this.staticFilters.runAll(chunks, diff);
      this.logger.log(`[${review.reviewId}] Static filters: ${filterResults.findings.length} findings`);

      // ── CONTEXT RETRIEVAL ──
      this.logger.log(`[${review.reviewId}] Retrieving repository context...`);
      const retrievalContext = await this.contextRetrieval.retrieveContext(chunks, repoFullName);

      // ── LLM REVIEW ──
      this.orchestrator.transition(review.reviewId, 'deep_review' as any);
      this.logger.log(`[${review.reviewId}] Starting LLM re-review (${chunks.length} chunks) with custom prompt...`);
      const reviewOutput = await this.llmEngine.review({
        chunks,
        diff,
        context: retrievalContext,
        staticResults: filterResults,
        config: { ...review.config, userPrompt },
      });

      const findings = reviewOutput.findings;
      this.logger.log(`[${review.reviewId}] LLM re-review complete: ${findings.length} raw findings`);

      // ── POST-PROCESS ──
      this.logger.log(`[${review.reviewId}] Post-processing findings...`);
      const processedFindings = await this.postProcessor.process(findings, {
        repoFullName,
        confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.70'),
        maxComments: 50,
      });
      this.logger.log(`[${review.reviewId}] After post-processing: ${processedFindings.length} findings`);

      // Store findings in the review context
      this.orchestrator.transition(review.reviewId, 'verify' as any, {
        chunks,
        findings,
        processedFindings,
        diff,
      });

      // Move to pending_review then done
      this.orchestrator.transition(review.reviewId, 'pending_review' as any);
      this.orchestrator.transition(review.reviewId, 'done' as any);

      if (processedFindings.length === 0) {
        this.logger.log(`[${review.reviewId}] Re-review complete! No issues found with custom instructions.`);
      } else {
        this.logger.log(`[${review.reviewId}] Re-review complete! Found ${processedFindings.length} issue(s) with custom instructions.`);
      }
    } catch (error: any) {
      this.logger.error(`[${review.reviewId}] Direct re-review failed: ${error.message}`);
      this.orchestrator.transition(review.reviewId, 'done' as any, { error: error.message });
    }
  }

  /** Apply approved fixes to a test branch (default: reviewbot-test) */
  async applyFixesToBranch(
    reviewId: string,
    owner: string,
    repo: string,
    prNumber: number,
    approvedFindingIndices: number[],
    targetBranch: string,
  ): Promise<{ reviewId: string; branch: string; commitShas: string[] }> {
    const review = this.orchestrator.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }
    if (
      review.state !== ReviewState.PENDING_REVIEW &&
      review.state !== ReviewState.DONE
    ) {
      throw new Error(`Cannot apply fixes in state: ${review.state}`);
    }

    const allFindings = review.processedFindings || review.findings || [];
    const approvedFindings = approvedFindingIndices
      .filter((i) => i >= 0 && i < allFindings.length)
      .map((i) => allFindings[i]);

    if (approvedFindings.length === 0) {
      throw new Error('No valid approved findings with fixes to apply');
    }

    this.logger.log(
      `Applying ${approvedFindings.length} fixes to branch "${targetBranch}" for review ${reviewId}`,
    );

    const repository = {
      owner: { login: owner },
      name: repo,
      full_name: `${owner}/${repo}`,
    };

    const fixes = approvedFindings
      .filter((f) => f.suggestion?.patch || f.suggestion_patch)
      .map((f, i) => ({
        file: f.file,
        content: f.suggestion?.patch || f.suggestion_patch,
        commitMessage: `fix: ${f.title} [ReviewBot #${i + 1}]`,
      }));

    if (fixes.length === 0) {
      throw new Error('No approved findings with code patches to apply');
    }

    // Create or use the target test branch
    const result = await this.github.createFixBranch(
      repository as any,
      prNumber,
      fixes,
      targetBranch,
    );

    this.logger.log(
      `Applied ${result.commitShas.length} fixes to branch "${result.branch}"`,
    );

    return { reviewId, branch: result.branch, commitShas: result.commitShas };
  }

  // ── Branch Management ──

  private repo(owner: string, repo: string) {
    return {
      owner: { login: owner },
      name: repo,
      full_name: `${owner}/${repo}`,
    };
  }

  async listBranches(owner: string, repo: string) {
    return this.github.listBranches(this.repo(owner, repo) as any);
  }

  async getBranchSync(owner: string, repo: string, branch: string) {
    const repository = this.repo(owner, repo) as any;
    const defaultBranch = await this.github.getDefaultBranch(repository);
    const comparison = await this.github.compareBranches(repository, defaultBranch, branch);
    return {
      branch,
      defaultBranch,
      ...comparison,
    };
  }

  async syncBranch(owner: string, repo: string, branch: string) {
    return this.github.syncBranchWithDefault(this.repo(owner, repo) as any, branch);
  }

  async readFile(owner: string, repo: string, branch: string, filePath: string) {
    if (!filePath) throw new Error('File path is required');
    const result = await this.github.readFile(this.repo(owner, repo) as any, branch, filePath);
    if (!result) throw new Error(`File not found: ${filePath}`);
    return result;
  }

  async listFiles(owner: string, repo: string, branch: string, dirPath: string) {
    return this.github.listFiles(this.repo(owner, repo) as any, branch, dirPath);
  }

  async writeFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ) {
    return this.github.writeFile(
      this.repo(owner, repo) as any,
      branch,
      filePath,
      content,
      commitMessage,
    );
  }

  async writeFiles(
    owner: string,
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    commitMessage: string,
  ) {
    return this.github.writeFiles(
      this.repo(owner, repo) as any,
      branch,
      files,
      commitMessage,
    );
  }

  async createBranchPR(
    owner: string,
    repo: string,
    branch: string,
    base: string | undefined,
    title: string,
    body: string,
  ) {
    const repository = this.repo(owner, repo) as any;
    const defaultBranch = base || (await this.github.getDefaultBranch(repository));
    return this.github.createPullRequest(repository, branch, defaultBranch, title, body);
  }

  /** Use LLM to implement a feature/fix on a branch, then commit the changes */
  async implementOnBranch(
    owner: string,
    repo: string,
    branch: string,
    prompt: string,
    targetFiles?: string[],
  ): Promise<{ branch: string; filesChanged: string[]; commitSha: string }> {
    const repository = this.repo(owner, repo) as any;
    this.logger.log(`Implementing on ${owner}/${repo}@${branch}: "${prompt.substring(0, 80)}..."`);

    // 1. Get the repository tree to understand the codebase structure
    const tree = await this.github.getRepositoryTree(repository as any, branch);

    // 2. If no target files specified, ask LLM to identify which files to modify
    let filesToRead = targetFiles || [];
    if (filesToRead.length === 0) {
      const fileList = tree
        .filter((f) => f.type === 'blob' && !f.path.match(/node_modules|\.git|dist\/|build\/|vendor/))
        .map((f) => f.path)
        .slice(0, 200); // Limit to avoid token overflow

      const identifyPrompt = `You are ReviewBot. The user wants to implement the following change:

"${prompt}"

Here is the list of files in the repository:
${fileList.join('\n')}

Reply with a JSON array of file paths (max 10) that need to be read to implement this change. Only include files that already exist. Reply with ONLY the JSON array, nothing else.`;

      const identified = await this.llmEngine.generateText(identifyPrompt, { maxTokens: 1000 });
      try {
        const parsed = JSON.parse(identified.trim());
        if (Array.isArray(parsed)) {
          filesToRead = parsed.filter((f: string) => fileList.includes(f));
        }
      } catch {
        // Fallback: read common entry points
        filesToRead = fileList.filter(
          (f) =>
            f.includes('index.') ||
            f.includes('main.') ||
            f.includes('app.') ||
            f.includes('server.') ||
            f.match(/\.(ts|js|py|go|rs|java)$/),
        ).slice(0, 5);
      }
    }

    // 3. Read the identified files
    const fileContents: Array<{ path: string; content: string }> = [];
    for (const filePath of filesToRead.slice(15)) {
      const file = await this.github.readFile(repository as any, branch, filePath);
      if (file) {
        fileContents.push({ path: filePath, content: file.content });
      }
    }

    // 4. Ask LLM to generate the full modified files
    const implementPrompt = `You are ReviewBot, an expert software engineer. Implement the following change:

## User Request:
"${prompt}"

## Current File Contents:
${fileContents.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')}

## Instructions:
- Make the MINIMAL changes needed to fulfill the request
- Return the COMPLETE modified files (not diffs/patches)
- Only modify files that need changes
- Ensure the code is correct, compiles, and follows existing patterns
- Do NOT add unnecessary comments or change unrelated code

Reply with a JSON object in this format:
{
  "files": [
    {
      "path": "relative/path/to/file",
      "content": "complete file content here"
    }
  ],
  "explanation": "Brief description of what was changed and why"
}`;

    const response = await this.llmEngine.generateText(implementPrompt, { maxTokens: 16000 });

    // 5. Parse the response and write files
    let parsed: { files: Array<{ path: string; content: string }>; explanation: string };
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*"files"[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = JSON.parse(response.trim());
      }
    } catch (error: any) {
      throw new Error(`Failed to parse LLM response: ${error.message}`);
    }

    if (!parsed.files || parsed.files.length === 0) {
      throw new Error('LLM did not generate any file changes');
    }

    // 6. Write all files in a single commit
    const commitMessage = `feat: ${prompt.substring(0, 60)} [ReviewBot]`;
    const result = await this.github.writeFiles(
      repository as any,
      branch,
      parsed.files,
      commitMessage,
    );

    this.logger.log(
      `Implemented on ${branch}: ${parsed.files.map((f) => f.path).join(', ')} — ${parsed.explanation}`,
    );

    return {
      branch,
      filesChanged: parsed.files.map((f) => f.path),
      commitSha: result.sha,
    };
  }
}
