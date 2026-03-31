import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { appRoutes } from './app.routes';
export const appConfig = {
    providers: [
        provideHttpClient(),
        provideRouter(appRoutes),
    ],
};
//# sourceMappingURL=app.config.js.map