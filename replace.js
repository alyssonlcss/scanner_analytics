const fs = require('fs');
const file = 'src/frontend/src/app/features/dashboard/dashboard.component.ts';
let d = fs.readFileSync(file, 'utf8');

// Replace standard timeline + interval
d = d.replace(/<!-- Linha do tempo -->[\s\S]*?<!-- Alertas em prosa -->/g, 
  '<!-- Linha do tempo visual -->\n                              <app-timeline-visual [ev]="ev"></app-timeline-visual>\n                              <!-- Alertas em prosa -->');

// Replace any remaining individual timelines like <div class="osdia-ev-timeline">...</div>
d = d.replace(/<div class="osdia-ev-timeline"[^>]*>[\s\S]*?<\/div>/g, '<app-timeline-visual [ev]="ev"></app-timeline-visual>');

fs.writeFileSync(file, d);
console.log('done');
