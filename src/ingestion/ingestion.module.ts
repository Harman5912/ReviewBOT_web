import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { QueueModule } from '../queue/queue.module';
import { GithubModule } from '../github/github.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';

@Module({
  imports: [QueueModule, GithubModule, OrchestratorModule],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
