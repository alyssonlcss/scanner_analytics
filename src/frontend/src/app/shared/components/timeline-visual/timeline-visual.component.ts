import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineSegment, buildTimelineSegments, tlFlexGrow } from '../../utils/timeline-segment.utils';

@Component({
  selector: 'app-timeline-visual',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="timeline-visual-container">
      <!-- Barra principal da timeline -->
      <div class="timeline-bar">
        <div 
          *ngFor="let seg of segments; let i = index; let isLast = last" 
          class="timeline-segment" 
          [class.segment-interval]="seg.isInterval"
          [class.segment-idle]="!seg.isInterval && isIdleSegment(seg)"
          [class.segment-idle--high]="!seg.isInterval && isIdleHighSegment(seg)"
          [class.segment-repair-alarm]="!seg.isInterval && (isRepairAlarmSegment(seg) || isLoginAlarmSegment(seg))"
          [style.flex-grow]="getFlexGrow(seg.durationMin)"
          [title]="seg.startTime + ' â†’ ' + seg.endTime">
          
          <!-- ConteÃºdo da barra (label - minutos) -->
          <div class="segment-bar-content">

            <span class="seg-two-line">
              <span class="seg-name">{{ seg.label }}</span>
              <span class="seg-dur">{{ seg.overrideDuration ?? (seg.durationMin + 'min') }}</span>
            </span>

          </div>

          <!-- Marcador de horÃ¡rio de inÃ­cio -->
          <div class="time-marker start-marker">
            {{ seg.startLabel }}<br>{{ seg.startTime }}
          </div>
          
          <!-- Marcador de horÃ¡rio de fim (apenas no Ãºltimo segmento) -->
          <div *ngIf="isLast" class="time-marker end-marker">
            {{ seg.endLabel }}<br>{{ seg.endTime }}
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .timeline-visual-container {
      margin: 0.5rem 0 2.5rem 0;
      font-family: sans-serif;
      position: relative;
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
      background: linear-gradient(135deg, #fef9c3 0%, #fde68a 100%) !important;
      color: #78350f !important;
      border: 2px dashed #fbbf24 !important;
    }
    .segment-idle {
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%) !important;
      color: #7f1d1d !important;
      border-right-color: #fff !important;
    }
    .segment-idle--high {
      background: linear-gradient(135deg, #fca5a5 0%, #f87171 100%) !important;
      color: #7f1d1d !important;
      border-right-color: #fff !important;
    }
    .segment-repair-alarm {
      background: linear-gradient(135deg, #fca5a5 0%, #f87171 100%) !important;
      color: #7f1d1d !important;
      border-right-color: #fff !important;
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
    .seg-two-line {
      display: flex;
      flex-direction: column;
      align-items: center;
      line-height: 1.2;
    }
    .seg-name {
      font-size: 0.72rem;
      font-weight: 700;
    }
    .seg-dur {
      font-size: 0.62rem;
      font-weight: 500;
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

    /* Marcadores de horÃ¡rio */
    .time-marker {
      position: absolute;
      top: 100%;
      margin-top: 4px;
      font-size: 0.62rem;
      color: #4b5563;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
      border-left: 2px solid #9ca3af;
      padding-left: 3px;
    }
    .start-marker {
      left: 0;
    }
    .end-marker {
      right: 0;
      border-left: none;
      border-right: 2px solid #9ca3af;
      padding-left: 0;
      padding-right: 3px;
      text-align: right;
    }
  `]
})
export class TimelineVisualComponent implements OnInit {
  @Input() ev: any;
  @Input() hidePartida: boolean = false;
  @Input() trimToACaminho: boolean = false;

  segments: TimelineSegment[] = [];

  ngOnInit() {
    this.buildTimeline();
  }

  // Escala logarÃ­tmica: comprime intervalos longos e aumenta segmentos curtos
  getFlexGrow(durationMin: number): number {
    return tlFlexGrow(durationMin);
  }

  private static readonly IDLE_LABELS = new Set(['1º Despacho', 'Despacho', 'Entre OS', 'Desl. Intervalo', 'Partida', 'Deslocamento', 'Antes Log Off']);

  isIdleSegment(seg: TimelineSegment): boolean {
    return TimelineVisualComponent.IDLE_LABELS.has(seg.label) && seg.label !== 'Deslocamento';
  }

  isIdleHighSegment(seg: TimelineSegment): boolean {
    return TimelineVisualComponent.IDLE_LABELS.has(seg.label) && ((seg.flags?.length ?? 0) > 0);
  }

  isRepairAlarmSegment(seg: TimelineSegment): boolean {
    return seg.label === 'Reparo' && (seg.flags?.length ?? 0) > 0;
  }

  isLoginAlarmSegment(seg: TimelineSegment): boolean {
    return seg.label === 'Log In' && (seg.flags?.length ?? 0) > 0;
  }

  private buildTimeline() {
    if (!this.ev) return;
    this.segments = buildTimelineSegments(this.ev, this.hidePartida ?? false, this.trimToACaminho ?? false);
  }
}
