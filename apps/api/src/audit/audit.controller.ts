import { Controller, Get, Query } from '@nestjs/common';
import { Perm } from '../auth/decorators';
import { CurrentActor, type Actor } from '../common/actor';
import { readListQuery, str } from '../common/listing';
import { AuditService } from './audit.service';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Perm('auditoria.ver')
  list(@Query() query: Record<string, unknown>, @CurrentActor() actor: Actor) {
    const lq = readListQuery(query, actor, 'auditoria');
    return this.audit.list({
      ...lq,
      entity: str(query.entity),
      entityId: str(query.entityId),
      module: str(query.module),
      userId: str(query.userId),
      action: str(query.action),
      from: str(query.from),
      to: str(query.to),
      q: lq.q,
    });
  }
}
