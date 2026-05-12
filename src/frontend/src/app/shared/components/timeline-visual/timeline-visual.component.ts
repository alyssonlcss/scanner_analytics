import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

interface TimelineSegment {
  label: string;
  durationMin: number;
  isInterval?: boolean;
  startTime?: string;
  endTime?: string;
  startLabel?: string;
  endLabel?: string;
  flags?: string[];
}

@Component({
  selector: 'app-timeline-visual',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="timeline-visual-container">
      <!-- Callout de origem da timeline (independente dos segmentos) -->
      <div class="timeline-origin-callout" *ngIf="timelineOrigin">
        <span class="origin-icon">▶</span> {{ timelineOrigin }}
        <span *ngIf="despachHint" class="desp-hint">· Desp.: {{ despachHint }}</span>
      </div>

      <!-- Barra principal da timeline -->
      <div class="timeline-bar">
        <div 
          *ngFor="let seg of segments; let i = index; let isLast = last" 
          class="timeline-segment" 
          [class.segment-interval]="seg.isInterval"
          [style.flex-grow]="getFlexGrow(seg.durationMin)"
          [title]="seg.startTime + ' → ' + seg.endTime">
          
          <!-- Conteúdo da barra (label - minutos) -->
          <div class="segment-bar-content">
            <span *ngIf="seg.isInterval" class="interval-icon">⏸</span>
            {{ seg.label }} - {{ seg.durationMin }}m
            <span *ngIf="seg.flags && seg.flags.length > 0" class="flag-indicator" [title]="seg.flags.join(', ')">⚠</span>
          </div>

          <!-- Marcador de horário de início -->
          <div class="time-marker start-marker">
            {{ seg.startLabel }}<br>{{ seg.startTime }}
          </div>
          
          <!-- Marcador de horário de fim (apenas no último segmento) -->
          <div *ngIf="isLast" class="time-marker end-marker">
            {{ seg.endLabel }}<br>{{ seg.endTime }}
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .timeline-visual-container {
      margin: 5rem 0 2.5rem 0;
      font-family: sans-serif;
      position: relative;
    }
    /* Callout de origem da timeline (posicionado antes da barra) */
    .timeline-origin-callout {
      position: absolute;
      top: -76px;
      left: 0;
      white-space: nowrap;
      font-size: 0.72rem;
      font-weight: 700;
      color: #065f46;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: linear-gradient(135deg, #d1fae5, #a7f3d0);
      border-radius: 4px;
      border: 1px solid #6ee7b7;
      box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);
    }
    .timeline-origin-callout::after {
      content: '';
      position: absolute;
      bottom: -52px;
      left: 12px;
      width: 2px;
      height: 52px;
      background: #10b981;
    }
    .origin-icon {
      font-size: 0.85rem;
      color: #059669;
    }
    .desp-hint {
      font-weight: 400;
      color: #047857;
      opacity: 0.85;
    }
    .timeline-bar {
      display: flex;
      width: 100%;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(to bottom, #f8f9fa, #e9ecef);
      overflow: visible;
      position: relative;
      box-shadow: 0 2px 4px rgba(0,0,0,0.08);
    }
    .timeline-segment {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      border-right: 2px solid #fff;
      background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
      color: #1e3a8a;
      font-size: 0.8rem;
      font-weight: 600;
      min-width: 50px;
      transition: all 0.2s ease;
    }
    .timeline-segment:hover {
      filter: brightness(1.05);
      z-index: 10;
    }
    .timeline-segment:first-child {
      border-top-left-radius: 8px;
      border-bottom-left-radius: 8px;
    }
    .timeline-segment:last-child {
      border-right: none;
      border-top-right-radius: 8px;
      border-bottom-right-radius: 8px;
    }
    .segment-interval {
      background: linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%) !important;
      color: #831843 !important;
      border: 2px dashed #f9a8d4 !important;
    }
    .segment-bar-content {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.75rem;
      white-space: nowrap;
    }
    .interval-icon {
      font-size: 0.8rem;
    }

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
      top: 100%;
      margin-top: 18px;
      font-size: 0.62rem;
      color: #4b5563;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
    }
    .time-marker::before {
      content: '';
      position: absolute;
      bottom: 100%;
      width: 1px;
      height: 18px;
      background: #9ca3af;
    }
    .start-marker {
      left: 0;
      transform: translateX(-10%);
    }
    .start-marker::before {
      left: 0;
    }
    .timeline-segment:first-child .start-marker {
      transform: translateX(0);
    }
    .timeline-segment:first-child .start-marker::before {
      left: 0;
    }
    .end-marker {
      right: 0;
      transform: translateX(10%);
    }
    .end-marker::before {
      right: 0;
      left: auto;
    }
    .timeline-segment:last-child .end-marker {
      transform: translateX(0);
    }
    .timeline-segment:last-child .end-marker::before {
      right: 0;
    }
  `]
})
export class TimelineVisualComponent implements OnInit {
  @Input() ev: any;

  segments: TimelineSegment[] = [];
  timelineOrigin: string = '';
  despachHint: string = '';

  ngOnInit() {
    this.buildTimeline();
  }

  // Escala logarítmica: comprime intervalos longos e aumenta segmentos curtos
  getFlexGrow(durationMin: number): number {
    if (durationMin <= 8) {
      return 8; // mínimo para segmentos muito curtos
    }
    // Raiz quadrada para comprimir grandes valores mantendo proporcionalidade
    // 8min → ~8.5 | 15min → ~11.6 | 30min → ~16.4 | 60min → ~23.2 | 120min → ~32.9
    return Math.sqrt(durationMin) * 3;
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
    if (parts.length >= 2) {
      const datePart = parts[0]; // DD/MM/YYYY
      const timePart = parts[1]; // HH:MM:SS
      
      const timeParts = timePart.split(':');
      const dateParts = datePart.split('/');
      
      if (timeParts.length >= 2 && dateParts.length >= 2) {
        const hhmm = `${timeParts[0]}:${timeParts[1]}`;
        const ddmm = `${dateParts[0]}/${dateParts[1]}`;
        return `${hhmm} ${ddmm}`;
      }
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

    // Detectar cenário onde prev_liberada é posterior à despachada
    const prevLibTs = this.ev.prev_liberada ? this.parseDt(this.ev.prev_liberada) : 0;
    const despTs = this.ev.despachada ? this.parseDt(this.ev.despachada) : 0;
    const despAfterPrevLib = prevLibTs > 0 && despTs > 0 && prevLibTs > despTs;

    this.despachHint = '';

    // Definir origem da timeline
    if (this.ev.prev_liberada) {
      this.timelineOrigin = `Lib. Anterior (${this.extractTime(this.ev.prev_liberada)})`;
      if (despAfterPrevLib) {
        // Despachada está no passado em relação à Lib. Anterior; mostrar como referência
        this.despachHint = this.extractTime(this.ev.despachada);
      }
    } else {
      const loginTime = this.extractTime(this.ev.log_in) || this.extractTime(this.ev.inicio_calendario);
      this.timelineOrigin = `1ª OS do Dia (${loginTime})`;
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
      addPt('prev_liberada', this.ev.prev_liberada, 'Lib. Anterior');
    } else {
      addPt('inicio_calendario', this.ev.inicio_calendario, 'Início Cal.');
      addPt('log_in', this.ev.log_in, 'Log In');
    }
    
    // Adicionar despachada somente se não estiver no passado em relação à Lib. Anterior
    if (!despAfterPrevLib) {
      addPt('despachada', this.ev.despachada, 'Despachada');
    }
    addPt('a_caminho', this.ev.a_caminho, 'A Caminho');
    addPt('no_local', this.ev.no_local, 'No Local');
    addPt('liberada', this.ev.liberada, 'Liberada');
    addPt('inicio_intervalo', this.ev.inicio_intervalo, 'Início Intervalo');
    addPt('fim_intervalo', this.ev.fim_intervalo, 'Fim Intervalo');

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
            // Lógica customizada de negócio (Sem Ordem e suas subflags)
            if (p1.key === 'inicio_calendario' && p2.key === 'despachada') label = 'Início Jornada';
            else if (p1.key === 'log_in' && p2.key === 'despachada') label = 'Início Jornada';
            else if (p1.key === 'prev_liberada' && p2.key === 'despachada') label = 'Entre OS';
            else if (p1.key === 'liberada' && p2.key === 'despachada') label = 'Entre OS';
            else if (p1.key === 'prev_liberada' && p2.key === 'inicio_intervalo') label = 'Desl. Intervalo';
            else if (p1.key === 'fim_intervalo' && p2.key === 'despachada') label = 'Entre OS';
            // Etapas produtivas
            else if (p1.key === 'despachada' && p2.key === 'a_caminho') label = 'Partida';
            else if (p1.key === 'fim_intervalo' && p2.key === 'a_caminho') label = 'Partida';
            else if (p1.key === 'a_caminho' && p2.key === 'no_local') label = 'Deslocamento';
            else if (p1.key === 'no_local' && p2.key === 'liberada') label = 'Reparo';
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
        } else if ((label === 'Início Jornada' || label === 'Entre OS' || label === 'Desl. Intervalo') && this.ev.sem_os_total_min !== undefined) {
            // Para Início Jornada, busca duração específica em sem_os_details
            // Para Desl. Intervalo e Entre OS, mantém duração calculada pelos timestamps (mais precisa)
            if (label === 'Início Jornada') {
              const match = this.ev.sem_os_details?.find((s: any) => 
                s.from === p1.raw && s.to === p2.raw
              );
              if (match) {
                durationMin = Math.max(match.min, 1);
              }
            }
            // Flag aparece em TODOS os segmentos sem-OS quando excedido
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
            startLabel: p1.label,
            endLabel: p2.label,
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
                current.endLabel = rawSegments[i].endLabel;
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
