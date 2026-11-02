import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DomainsService } from './domains.service.js';

@Injectable()
export class DomainRecheckJob {
  private readonly logger = new Logger(DomainRecheckJob.name);

  constructor(private readonly domains: DomainsService) {}

  @Cron('0 3 * * *', { name: 'domain-recheck', timeZone: 'Asia/Colombo' })
  async run() {
    const result = await this.domains.recheckAll();
    this.logger.log(`Domain recheck: ${result.checked} checked, ${result.unverified} unverified`);
  }
}
