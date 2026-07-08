import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue('review') private readonly reviewQueue: Queue,
    @InjectQueue('dead-letter') private readonly dlq: Queue,
  ) {}

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.reviewQueue.getWaitingCount(),
      this.reviewQueue.getActiveCount(),
      this.reviewQueue.getCompletedCount(),
      this.reviewQueue.getFailedCount(),
      this.reviewQueue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  async moveToDeadLetter(job: Job, error: Error): Promise<void> {
    await this.dlq.add(
      'failed-review',
      {
        originalJob: job.data,
        error: error.message,
        stack: error.stack,
        failedAt: new Date().toISOString(),
        attempts: job.attemptsMade,
      },
      {
        jobId: `dlq-${job.id}-${Date.now()}`,
      },
    );
    this.logger.error(
      `Job ${job.id} moved to dead letter queue: ${error.message}`,
    );
  }

  async replayFromDeadLetter(jobId: string): Promise<void> {
    const jobs = await this.dlq.getJobs(['waiting', 'delayed']);
    const targetJob = jobs.find((j: any) => j.id === jobId);

    if (!targetJob) {
      throw new Error(`Dead letter job ${jobId} not found`);
    }

    await this.reviewQueue.add(
      'process-pr',
      targetJob.data.originalJob,
      { jobId: `replay-${jobId}` },
    );
    await targetJob.remove();
    this.logger.log(`Replayed job ${jobId} from dead letter queue`);
  }

  /** Enqueue a re-review job with optional user prompt */
  async enqueueReview(
    jobName: string,
    data: Record<string, any>,
    jobId: string,
    priority?: number,
  ): Promise<void> {
    // Race the queue add against a timeout so we don't hang when Redis is unavailable
    await Promise.race([
      this.reviewQueue.add(jobName, data, {
        jobId,
        priority: priority || 5,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Queue add timeout — Redis unavailable')), 5000),
      ),
    ]);
    this.logger.log(`Enqueued ${jobName} job: ${jobId}`);
  }

  async cleanupCompletedJobs(maxAgeHours = 24): Promise<number> {
    const jobs = await this.reviewQueue.getCompleted();
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    let removed = 0;

    for (const job of jobs) {
      if (job.finishedOn && job.finishedOn < cutoff) {
        await job.remove();
        removed++;
      }
    }

    return removed;
  }
}
