// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import { Routes } from '@angular/router';

import { DashboardComponent } from './features/dashboard/dashboard.component';

export const appRoutes: Routes = [
  {
    path: '',
    component: DashboardComponent,
  },
];