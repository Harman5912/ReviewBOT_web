import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { FeedbackService } from './feedback.service';
import { RepoConfigService } from './repo-config.service';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { GithubModule } from '../github/github.module';
import { PublisherModule } from '../publisher/publisher.module';
import { QueueModule } from '../queue/queue.module';
import { LlmEngineModule } from '../llm-engine/llm-engine.module';
import { DiffParserModule } from '../diff-parser/diff-parser.module';
import { ContextRetrievalModule } from '../context-retrieval/context-retrieval.module';
import { StaticFiltersModule } from '../static-filters/static-filters.module';
import { PostProcessorModule } from '../post-processor/post-processor.module';

@Module({
  imports: [
    OrchestratorModule,
    GithubModule,
    PublisherModule,
    QueueModule,
    LlmEngineModule,
    DiffParserModule,
    ContextRetrievalModule,
    StaticFiltersModule,
    PostProcessorModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService, FeedbackService, RepoConfigService],
})
export class DashboardModule {}
