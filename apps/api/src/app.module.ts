import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionService } from './auth/session.service';
import { BrandsController } from './catalog/brands.controller';
import { CategoriesController } from './catalog/categories.controller';
import { ProductsController } from './catalog/products.controller';
import { SkusController } from './catalog/skus.controller';
import { SkusService } from './catalog/skus.service';
import { SuppliersController } from './catalog/suppliers.controller';
import { ChannelsController } from './channels/channels.controller';
import { ListingsController } from './channels/listings.controller';
import { DbModule } from './common/db';
import { HealthController } from './misc/health.controller';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { DashboardController } from './misc/dashboard.controller';
import { AdjustmentsService } from './inventory/adjustments.service';
import { CountsService } from './inventory/counts.service';
import { AdjustmentsController, CountsController, TransfersController } from './inventory/documents.controller';
import { InventoryController } from './inventory/inventory.controller';
import { TransfersService } from './inventory/transfers.service';
import { SavedFiltersController } from './misc/saved-filters.controller';
import { SearchController } from './misc/search.controller';
import { SettingsController } from './misc/settings.controller';
import { RolesController } from './users/roles.controller';
import { UsersController } from './users/users.controller';
import { WarehousesController } from './warehouses/warehouses.controller';

@Module({
  imports: [
    DbModule,
    // Límite general por IP; el login tiene uno más estricto en su controlador.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
  ],
  controllers: [
    HealthController,
    AuthController,
    AuditController,
    BrandsController,
    CategoriesController,
    ProductsController,
    SkusController,
    SuppliersController,
    ChannelsController,
    ListingsController,
    WarehousesController,
    UsersController,
    RolesController,
    SearchController,
    DashboardController,
    SavedFiltersController,
    SettingsController,
    ImportsController,
    InventoryController,
    AdjustmentsController,
    TransfersController,
    CountsController,
  ],
  providers: [
    AuditService,
    SessionService,
    AuthService,
    SkusService,
    ImportsService,
    AdjustmentsService,
    TransfersService,
    CountsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
