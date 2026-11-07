import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { barcode, CategorySchema, CreateVariantsSchema, ProductSchema, SetBarcodesSchema, TaxGroupSchema, TaxRateSchema, UpdateProductSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresDevice, RequiresModule, RequiresPermission } from '../access/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditContext } from '../audit/audit-context.js';
import { SettingsService } from '../settings/settings.service.js';
import { CatalogService } from './catalog.service.js';

const uuid = new ParseUUIDPipe();

@Controller('tax-rates')
export class TaxRatesController {
  constructor(private readonly catalog: CatalogService) {}

  @RequiresPermission('catalog.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.catalog.listTaxRates(req.tenant!);
  }

  @RequiresPermission('catalog.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(TaxRateSchema)) body: z.infer<typeof TaxRateSchema>) {
    return this.catalog.createTaxRate(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('catalog.manage')
  @Patch(':id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(TaxRateSchema.partial())) body: Partial<z.infer<typeof TaxRateSchema>>) {
    return this.catalog.updateTaxRate(req.tenant!, auditContext(req), id, body);
  }
}

@Controller('tax-groups')
export class TaxGroupsController {
  constructor(private readonly catalog: CatalogService) {}

  @RequiresPermission('catalog.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.catalog.listTaxGroups(req.tenant!);
  }

  @RequiresPermission('catalog.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(TaxGroupSchema)) body: z.infer<typeof TaxGroupSchema>) {
    return this.catalog.createTaxGroup(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('catalog.manage')
  @Put(':id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(TaxGroupSchema)) body: z.infer<typeof TaxGroupSchema>) {
    return this.catalog.updateTaxGroup(req.tenant!, auditContext(req), id, body);
  }
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @RequiresPermission('catalog.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.catalog.listCategories(req.tenant!);
  }

  @RequiresPermission('catalog.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CategorySchema)) body: z.infer<typeof CategorySchema>) {
    return this.catalog.createCategory(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('catalog.manage')
  @Patch(':id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(CategorySchema.partial())) body: Partial<z.infer<typeof CategorySchema>>) {
    return this.catalog.updateCategory(req.tenant!, auditContext(req), id, body);
  }
}

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  @RequiresPermission('catalog.manage')
  @Get()
  list(@Req() req: RequestWithContext, @Query('search') search?: string, @Query('categoryId') categoryId?: string, @Query('includeInactive') includeInactive?: string) {
    return this.catalog.listProducts(req.tenant!, {
      search: search?.slice(0, 100) || undefined,
      categoryId: categoryId && /^[0-9a-f-]{36}$/i.test(categoryId) ? categoryId : undefined,
      includeInactive: includeInactive === 'true',
    });
  }

  @RequiresPermission('catalog.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(ProductSchema)) body: z.infer<typeof ProductSchema>) {
    return this.catalog.createProduct(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('catalog.manage')
  @Patch(':id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateProductSchema)) body: z.infer<typeof UpdateProductSchema>) {
    return this.catalog.updateProduct(req.tenant!, auditContext(req), id, body);
  }

  @RequiresModule('variants')
  @RequiresPermission('catalog.manage')
  @Get(':id/variants')
  variants(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.catalog.variantsOf(req.tenant!, id);
  }

  @RequiresModule('variants')
  @RequiresPermission('catalog.manage')
  @Post(':id/variants')
  addVariants(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(CreateVariantsSchema)) body: z.infer<typeof CreateVariantsSchema>) {
    return this.catalog.createVariants(req.tenant!, auditContext(req), id, body);
  }

  @RequiresModule('barcodes')
  @RequiresPermission('catalog.manage')
  @Put(':id/barcodes')
  async barcodes(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(SetBarcodesSchema)) body: z.infer<typeof SetBarcodesSchema>) {
    return { codes: await this.catalog.setBarcodes(req.tenant!, auditContext(req), id, body.codes) };
  }
}

@Controller('pos')
export class PosCatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
  ) {}

  @RequiresModule('barcodes')
  @RequiresDevice()
  @RequiresPermission('sale.create')
  @Get('barcodes/:code')
  byBarcode(@Req() req: RequestWithContext, @Param('code') code: string) {
    const parsed = barcode.safeParse(code);
    if (!parsed.success) throw AppError.validation([{ path: 'code', message: 'Not a barcode' }]);
    return this.catalog.findByBarcode(req.tenant!, parsed.data);
  }

  @RequiresDevice()
  @RequiresPermission('sale.create')
  @Get('catalog')
  async get(@Req() req: RequestWithContext) {
    const [profile, catalog] = await Promise.all([this.settings.profile(req.tenant!.id), this.catalog.posCatalog(req.tenant!, req.device!.registerId)]);
    return { currency: profile.currency, settings: profile.settings, ...catalog };
  }
}
