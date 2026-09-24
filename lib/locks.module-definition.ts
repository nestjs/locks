import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { LocksModuleExtras, LocksModuleOptions } from './interfaces/locks-module-options.interface.js';

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: LOCKS_MODULE_OPTIONS,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<LocksModuleOptions>({ moduleName: 'Locks' })
  .setClassMethodName('forRoot')
  // forRootAsync({ useClass }) calls createLocksOptions(), like JwtModule's createJwtOptions().
  .setFactoryMethodName('createLocksOptions')
  // `isGlobal` is structural: Nest must know it when the module is defined. The store isn't an
  // option at all: the app registers it with LocksStorage.
  .setExtras<LocksModuleExtras>({ isGlobal: true }, (definition, { isGlobal }) => ({
    ...definition,
    global: isGlobal,
  }))
  .build();
