import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

interface TimelineSegment {
  label: string;
  durationMin: number;
  isInterval?: boolean;
  startTime?: string;
  endTime?: string;
  flags?: string[];
}

@Component({
  selector: 'app-timeline-visual',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="timeline-visual-container">
      <!-- Indicador de início da timeline -->
      <div class="timeline-origin" *ngIf="timelineOrigin">
        <small>{{ timelineOrigin }}</small>
      </div>

      <!-- Barra principal da timeline -->
      <div class="timeline-bar">
        <div 
          *ngFor="let seg of segments; let i = index; let isLast = last" 
          class="timeline-segment" 
          [class.segment-interval]="seg.isInterval"
          [style.flex-grow]="seg.durationMin"
          [title]="seg.startTime + ' → ' + seg.endTime">
          
          <!-- Callout com label do segmento -->
          <div class="segment-callout" [ngClass]="'callout-level-' + (i % 3)">
            {{ seg.label }}
            <span *ngIf="seg.flags && seg.flags.length > 0" class="flag-indicator" [title]="seg.flags.join(', ')">⚠</span>
          </div>
          
          <!-- Conteúdo da barra (minutos) -->
          <div class="segment-bar-content">
            <span *ngIf="seg.isInterval" class="interval-icon">⏸</span>
            {{ seg.durationMin }}m
          </div>

          <!-- Marcador de horário de início -->
          <div class="time-marker start-marker">{{ seg.startTime }}</div>
          
          <!-- Marcador de horário de fim (apenas no último segmento) -->
          <div *ngIf="isLast" class="time-marker end-marker">{{ seg.endTime }}</div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .timeline-visual-container {
      margin: 4.5rem 0 2rem 0;
      font-family: sans-serif;
    }
    .timeline-origin {
      margin-bottom: 0.5rem;
      padding: 0.25rem 0.5rem;
      background: #f0f9ff;
      border-left: 3px solid #0284c7;
      font-size: 0.75rem;
      color: #0c4a6e;
      font-weight: 500;
    }
    .timeline-bar {
      display: flex;
      width: 100%;
      height: 32px;
      border-radius: 6px;
      background: #f0f0f0;
      overflow: visible;
      position: relative;
    }
    .timeline-segment {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      border-right: 1px solid #fff;
      background: #e0e7ff;
      color: #333;
      font-size: 0.75rem;
      font-weight: 500;
      min-width: 50px;
    }
    .timeline-segment:first-child {
      border-top-left-radius: 6px;
      border-bottom-left-radius: 6px;
    }
    .timeline-segment:last-child {
      border-right: none;
      border-top-right-radius: 6px;
      border-bottom-right-radius: 6px;
    }
    .segment-interval {
      background: #fdf2f8 !important;
      color: #831843 !important;
      border: 1px dashed #fbcfe8;
    }
    .segment-bar-content {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .interval-icon {
      font-size: 0.8rem;
    }
    
    /* Callouts flexíveis com múltiplos níveis para evitar sobreposição */
    .segment-callout {
      position: absolute;
      white-space: nowrap;
      font-size: 0.7rem;
      font-weight: 600;
      color: #555;
      transform: translateX(-50%);
      left: 50%;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .segment-callout::after {
      content: '';
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: 1px;
      background: #999;
    }
    .callout-level-0 { top: -25px; }
    .callout-level-0::after { bottom: -5px; height: 5px; }
    .callout-level-1 { top: -45px; }
    .callout-level-1::after { bottom: -25px; height: 25px; }
    .callout-level-2 { top: -65px; }
    .callout-level-2::after { bottom: -45px; height: 45px; }

    /* Indicador de flag associada */
    .flag-indicator {
      color: #dc2626;
      font-size: 0.9rem;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Marcadores de horário */
    .time-marker {
      position: absolute;
      bottom: -22px;
      font-size: 0.65rem;
      color: #666;
      white-space: nowrap;
    }
    .start-marker {
      left: 0;
      transform: translateX(-50%);
    }
    .timeline-segment:first-child .start-marker {
      transform: translateX(-10%);
    }
    .end-marker {
      right: 0;
      transform: translateX(50%);
    }
    .timeline-segment:last-child .end-marker {
      transform: translateX(-90%);
    }
  `]
})
export class TimelineVisualComponent implements OnInit {
  @Input() ev: any;

  segments: TimelineSegment[] = [];
  timelineOrigin: string = '';

  ngOnInit() {
    this.buildTimeline();
  }

  private parseDt(dtStr: string): number {
    if (!dtStr) return 0;
    const [d, t] = dtStr.split(' ');
    if (!d || !t) return 0;
    const [day, mon, yr] = d.split('/');
    const [hr, min, sec] = t.split(':');
    return new Date(+yr, +mon - 1, +day, +hr, +min, +sec).getTime();
  }

  private extractTime(dtStr: string): string {
    if (!dtStr) return '';
    const parts = dtStr.split(' ');
    if (parts.length > 1) {
      const timeParts = parts[1].split(':');
      if (timeParts.length >= 2) return `${timeParts[0]}:${timeParts[1]}`;
    }
    return '';
  }

  private extractDate(dtStr: string): string {
    if (!dtStr) return '';
    const parts = dtStr.split(' ');
    return parts[0] || '';
  }

  private buildTimeline() {
    if (!this.ev) return;

    // Definir origem da timeline
    if (this.ev.prev_liberada) {
      this.timelineOrigin = `▶ Início: Liberação da OS anterior (${this.extractTime(this.ev.prev_liberada)})`;
    } else {
      const loginTime = this.extractTime(this.ev.log_in) || this.extractTime(this.ev.inicio_calendario);
      this.timelineOrigin = `▶ Início: Primeira OS do dia (Log In/Início Calendário - ${loginTime})`;
    }

    // Colher e nomear todos os checkpoints válidos (com timestamp original para extração de hora)
    const pts: { key: string; ts: number; label: string; raw: string }[] = [];
    const addPt = (key: string, val: string, label: string) => {
      if (val) {
        const ts = this.parseDt(val);
        if (ts > 0) pts.push({ key, ts, label, raw: val });
      }
    };

    // Lógica de início conforme especificação
    if (this.ev.prev_liberada) {
      addPt('prev_liberada', this.ev.prev_liberada, 'Lib. Ant.');
    } else {
      addPt('inicio_calendario', this.ev.inicio_calendario, 'Início Cal.');
      addPt('log_in', this.ev.log_in, 'Log In');
    }
    
    addPt('despachada', this.ev.despachada, 'Despachada');
    addPt('a_caminho', this.ev.a_caminho, 'A Caminho');
    addPt('no_local', this.ev.no_local, 'No Local');
    addPt('liberada', this.ev.liberada, 'Liberada');
    addPt('inicio_intervalo', this.ev.inicio_intervalo, '⏸ Ini. Int.');
    addPt('fim_intervalo', this.ev.fim_intervalo, '▶ Fim Int.');

    // Remove duplicates mantendo apenas primeira ocorrência
    const uniquePts: typeof pts = [];
    const seen = new Set<string>();
    for (const pt of pts) {
        if (!seen.has(pt.key)) {
            seen.add(pt.key);
            uniquePts.push(pt);
        }
    }

    uniquePts.sort((a, b) => a.ts - b.ts);

    // Função para verificar se um ponto de tempo está dentro de um intervalo
    const isInsideInterval = (tsMain: number) => {
        const iStart = uniquePts.find(p => p.key === 'inicio_intervalo');
        const iEnd = uniquePts.find(p => p.key === 'fim_intervalo');
        if (!iStart || !iEnd) return false;
        return tsMain >= iStart.ts && tsMain < iEnd.ts;
    };

    // Criar segmentos brutos para cada par de pontos
    const rawSegments: TimelineSegment[] = [];
    for (let i = 0; i < uniquePts.length - 1; i++) {
        const p1 = uniquePts[i];
        const p2 = uniquePts[i+1];
        
        let durationMin = Math.round((p2.ts - p1.ts) / 60000);
        if (durationMin < 0) continue;

        const midPoint = p1.ts + (p2.ts - p1.ts) / 2;
        const isInterval = isInsideInterval(midPoint);

        // Determinar label do segmento
        let label = '';
        if (isInterval) {
            label = 'INTERVALO';
        } else {
            // Lógica customizada de negócio
            if (p1.key === 'inicio_calendario' && p2.key === 'despachada') label = 'Início Jornada';
            else if (p1.key === 'prev_liberada' && p2.key === 'despachada') label = 'Sem OS/Espera';
            else if (p1.key === 'despachada' && p2.key === 'a_caminho') label = 'Partida';
            else if (p1.key === 'a_caminho' && p2.key === 'no_local') label = 'Deslocamento';
            else if (p1.key === 'no_local' && p2.key === 'liberada') label = 'Reparo';
            else if (p1.key === 'log_in' && p2.key === 'despachada') label = 'Sem OS/Espera';
            else label = `${p1.label} → ${p2.label}`;
        }

        // Sincronizar com valores calculados (regras de negócio)
        const flags: string[] = [];
        
        if (label === 'Reparo' && this.ev.tr_ordem_min !== undefined) {
            durationMin = Math.max(this.ev.tr_ordem_min, 1);
            if (this.ev.flag_temp_reparo_excedido) {
              flags.push('Temp. Reparo > 20%HD');
            }
        } else if (label === 'Deslocamento' && this.ev.tl_ordem_min !== undefined) {
            durationMin = Math.max(this.ev.tl_ordem_min, 1);
            if (this.ev.flag_temp_desloc_excedido) {
              flags.push('Temp. Desloc. Excedido');
            }
        } else if (label === 'Partida' && this.ev.temp_prep_os_min !== undefined) {
            durationMin = Math.max(this.ev.temp_prep_os_min, 1);
            if (this.ev.flag_temp_partida_excedido) {
              flags.push('Temp. Partida ≥ 10min');
            }
        } else if (label.includes('Sem OS') && this.ev.sem_os_total_min !== undefined) {
            // Buscar detalhamento específico
            const match = this.ev.sem_os_details?.find((s: any) => 
              s.from === p1.raw || s.to === p2.raw
            );
            if (match) {
              durationMin = Math.max(match.min, 1);
            }
            if (this.ev.flag_sem_os_excedido) {
              flags.push('SemOS ≥ 10min');
            }
        }

        rawSegments.push({
            label,
            durationMin,
            isInterval,
            startTime: this.extractTime(p1.raw),
            endTime: this.extractTime(p2.raw),
            flags
        });
    }

    // Merge adjacent segments with same label (exceto se tiverem flags diferentes)
    const merged: TimelineSegment[] = [];
    if (rawSegments.length > 0) {
        let current = rawSegments[0];
        for (let i = 1; i < rawSegments.length; i++) {
            const canMerge = 
              rawSegments[i].label === current.label && 
              rawSegments[i].isInterval === current.isInterval &&
              JSON.stringify(rawSegments[i].flags) === JSON.stringify(current.flags);
            
            if (canMerge) {
                current.durationMin += rawSegments[i].durationMin;
                current.endTime = rawSegments[i].endTime;
            } else {
                merged.push(current);
                current = rawSegments[i];
            }
        }
        merged.push(current);
    }

    this.segments = merged;
  }
}
