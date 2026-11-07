import { Module } from '@nestjs/common';
import { CategoriesController, PosCatalogController, ProductsController, TaxGroupsController, TaxRatesController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  controllers: [TaxRatesController, TaxGroupsController, CategoriesController, ProductsController, PosCatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
