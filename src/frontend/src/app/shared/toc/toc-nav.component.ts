import {
  ChangeDetectionStrategy,
  Component,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

interface TocEntry {
  label: string;
  index: number;
}

@Component({
  selector: 'app-toc-nav',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="ds-toc" aria-label="Navegação por KPIs" *ngIf="entries().length > 0">
      <div class="ds-toc-track">
        <button
          *ngFor="let entry of entries(); let first = first; let last = last"
          type="button"
          class="ds-toc-item"
          [class.ds-toc-active]="activeIndex() === entry.index"
          [class.ds-toc-first]="first"
          [class.ds-toc-last]="last"
          [attr.aria-label]="entry.label"
          (click)="scrollTo(entry.index)">
          <span class="ds-toc-dot"></span>
          <span class="ds-toc-tooltip">{{ entry.label }}</span>
        </button>
      </div>
    </nav>
  `,
  styles: [`
    .ds-toc {
      position: fixed;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 200;
    }

    /* Vertical track container */
    .ds-toc-track {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      position: relative;
    }

    /* Vertical line drawn as a pseudo-element on the track */
    .ds-toc-track::before {
      content: '';
      position: absolute;
      left: 50%;
      top: 6px;
      bottom: 6px;
      transform: translateX(-50%);
      width: 2px;
      background: var(--line, rgba(23,26,31,0.15));
      border-radius: 1px;
      z-index: 0;
    }

    /* Each item is just the dot + invisible tooltip trigger */
    .ds-toc-item {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 6px 0;
      z-index: 1;
    }

    /* Dot */
    .ds-toc-dot {
      display: block;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--line, rgba(23,26,31,0.25));
      border: 2px solid var(--surface-strong, #fffaf2);
      box-shadow: 0 0 0 1px var(--line, rgba(23,26,31,0.2));
      transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
      flex-shrink: 0;
    }

    .ds-toc-item:hover .ds-toc-dot {
      background: var(--accent-strong, #b64d2a);
      transform: scale(1.35);
      box-shadow: 0 0 0 2px var(--accent-soft, rgba(232,105,61,0.3));
    }

    .ds-toc-active .ds-toc-dot {
      background: var(--accent, #e8693d);
      transform: scale(1.5);
      box-shadow: 0 0 0 3px var(--accent-soft, rgba(232,105,61,0.25));
    }

    /* Tooltip — oculto por padrão, aparece no hover */
    .ds-toc-tooltip {
      position: absolute;
      right: calc(100% + 10px);
      top: 50%;
      transform: translateY(-50%) translateX(4px);
      background: var(--surface-strong, #fffaf2);
      border: 1px solid var(--line, rgba(23,26,31,0.12));
      border-radius: 7px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text, #1b1f25);
      white-space: nowrap;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }

    /* Arrow on the right side of tooltip */
    .ds-toc-tooltip::after {
      content: '';
      position: absolute;
      left: 100%;
      top: 50%;
      transform: translateY(-50%);
      border: 5px solid transparent;
      border-left-color: var(--surface-strong, #fffaf2);
    }

    .ds-toc-tooltip::before {
      content: '';
      position: absolute;
      left: 100%;
      top: 50%;
      transform: translateY(-50%);
      border: 6px solid transparent;
      border-left-color: var(--line, rgba(23,26,31,0.12));
      margin-left: 1px;
    }

    /* When hovering anywhere in the track, show all tooltips faded */
    .ds-toc-track:hover .ds-toc-tooltip {
      opacity: 0.28;
      transform: translateY(-50%) translateX(0);
    }

    /* The directly hovered item overrides to full opacity */
    .ds-toc-item:hover .ds-toc-tooltip {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }
  `],
})
export class TocNavComponent implements OnChanges, OnDestroy {
  @Input() kpis: Array<{ kpi: string }> = [];

  protected entries = signal<TocEntry[]>([]);
  protected activeIndex = signal(-1);

  private observer: IntersectionObserver | null = null;
  private scanTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private zone: NgZone) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['kpis']) {
      this.scheduleObserver();
    }
  }

  private scheduleObserver(): void {
    if (this.scanTimeout !== null) {
      clearTimeout(this.scanTimeout);
    }
    // Let Angular finish rendering the kpi-section elements
    this.scanTimeout = setTimeout(() => this.setupObserver(), 120);
  }

  private setupObserver(): void {
    this.cleanup();

    const refs: TocEntry[] = this.kpis.map((k, i) => ({ label: k.kpi, index: i }));
    this.entries.set(refs);

    if (refs.length === 0) return;

    // IntersectionObserver runs outside zone to avoid triggering CD on every frame
    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          // Pick the topmost entry currently intersecting
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

          if (visible.length > 0) {
            const id = visible[0].target.id; // e.g. "kpi-3"
            const idx = parseInt(id.replace('kpi-', ''), 10);
            if (!isNaN(idx)) {
              this.zone.run(() => this.activeIndex.set(idx));
            }
          }
        },
        {
          // Upper 10% excluded, lower 55% excluded → highlights whichever section
          // occupies the central viewport band
          rootMargin: '-10% 0px -55% 0px',
          threshold: 0,
        },
      );

      refs.forEach(({ index }) => {
        const el = document.getElementById(`kpi-${index}`);
        if (el) this.observer!.observe(el);
      });
    });
  }

  scrollTo(index: number): void {
    const el = document.getElementById(`kpi-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this.activeIndex.set(index);
  }

  private cleanup(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  ngOnDestroy(): void {
    this.cleanup();
    if (this.scanTimeout !== null) {
      clearTimeout(this.scanTimeout);
    }
  }
}
