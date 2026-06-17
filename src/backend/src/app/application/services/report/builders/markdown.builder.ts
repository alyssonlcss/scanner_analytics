import type { GeneratedReport } from '../types.js';
import { round2 } from '../csv-utils.js';

export function buildMarkdownReport(report: GeneratedReport): string {
    const lines: string[] = [];
    const hr = '---';

    const fmt = (v: number) => Number.isFinite(v) ? String(v) : '—';

    lines.push('# Relatório Analítico Scanner');
    lines.push('');
    lines.push(`**Gerado em:** ${new Date(report.generatedAt).toLocaleString('pt-BR')}`);
    if (report.filtersApplied.bases.length > 0) {
      lines.push(`**Bases filtradas:** ${report.filtersApplied.bases.join(', ')}`);
    }
    if (report.filtersApplied.teamTypes.length > 0) {
      const typeLabels: Record<string, string> = { propria: 'Própria', parceira: 'Parceira' };
      lines.push(`**Tipo de equipe:** ${report.filtersApplied.teamTypes.map((t) => typeLabels[t] ?? t).join(', ')}`);
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── Sumário ──────────────────────────────────────────────────────
    lines.push('## 📊 Resumo Geral');
    lines.push('');
    lines.push(`| Dado | Valor |`);
    lines.push(`| :--- | ---: |`);
    lines.push(`| Equipes avaliadas | ${report.totals.teams} |`);
    lines.push(`| Registros de deslocamento | ${report.totals.deslocamentos} |`);
    lines.push(`| Linhas de ranking | ${report.totals.rankingRows} |`);
    lines.push(`| Linhas de desvios | ${report.totals.desviosRows} |`);
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── KPIs ─────────────────────────────────────────────────────────
    lines.push('## 🏆 Desempenho por KPI');
    lines.push('');
    for (const insight of report.kpis) {
      const dir = insight.direction === 'higher-is-better' ? '↑ Quanto maior, melhor' : '↓ Quanto menor, melhor';
      lines.push(`### ${insight.kpi}`);
      lines.push('');
      lines.push(`**Direção:** ${dir} | **Meta:** ${insight.metaTarget} | **Média geral:** ${fmt(insight.average)}`);
      lines.push('');

      // Top 3
      lines.push('**🥇 Top 3 — Melhores Equipes**');
      lines.push('');
      if (insight.topTeams.length === 0) {
        lines.push('_Sem dados suficientes._');
      } else {
        lines.push('| # | Equipe | Valor | Pontuação |');
        lines.push('| :- | :--- | ---: | ---: |');
        for (let i = 0; i < Math.min(3, insight.topTeams.length); i++) {
          const t = insight.topTeams[i];
          const sc = insight.scores.find((s) => s.team === t.team);
          lines.push(`| ${i + 1} | ${t.team} | ${fmt(t.value)} | ${sc ? fmt(sc.score) : '—'} |`);
        }
      }
      lines.push('');

      // Bottom 3
      lines.push('**🔻 Top 3 — Oportunidade de Melhoria**');
      lines.push('');
      if (insight.opportunityTeams.length === 0) {
        lines.push('_Sem dados suficientes._');
      } else {
        lines.push('| # | Equipe | Valor | Pontuação |');
        lines.push('| :- | :--- | ---: | ---: |');
        for (let i = 0; i < insight.opportunityTeams.length; i++) {
          const t = insight.opportunityTeams[i];
          const sc = insight.scores.find((s) => s.team === t.team);
          lines.push(`| ${i + 1} | ${t.team} | ${fmt(t.value)} | ${sc ? fmt(sc.score) : '—'} |`);
        }
      }
      lines.push('');

      // Eficiencia drill-down (evidências de eficiência mascarada e problemas)
      if (insight.kpi === 'Eficiência' && insight.evidenceAnalysis && insight.evidenceAnalysis.length > 0) {
        lines.push('#### 🔍 Análise Detalhada — Evidências de Incidências');
        lines.push('');
        lines.push('_Fonte: Scanner 4.4 - CE M300_');
        lines.push('');

        let firstEvidence = true;
        for (const analysis of insight.evidenceAnalysis) {
          if (!firstEvidence) { lines.push(hr); lines.push(''); }
          firstEvidence = false;
          const typeLabel = analysis.analysisType === 'top_performer' ? '🏆 Top Performer' : '⚠ Oportunidade';
          lines.push(`##### ${typeLabel} — ${analysis.team}`);
          lines.push('');
          lines.push(`**Eficiência:** ${fmt(analysis.eficienciaValue)}% | **Média Geral:** ${fmt(analysis.averageEficiencia)}%`);
          lines.push('');
          lines.push(`**Tempo Médio de Deslocamento:** ${fmt(analysis.avgDeslocamentoMin)} min (média geral: ${fmt(analysis.globalAvgDeslocamentoMin)} min)`);
          lines.push('');
          lines.push(`**Tempo Médio de Execução:** ${fmt(analysis.avgExecucaoMin)} min (média geral: ${fmt(analysis.globalAvgExecucaoMin)} min)`);
          lines.push('');
          
          // Flags/alerts
          if (analysis.flags.includes('short_displacement')) {
            const threshold = round2(analysis.globalAvgDeslocamentoMin * 0.25);
            lines.push(`⚠️ **Deslocamento muito curto:** ${fmt(analysis.avgDeslocamentoMin)} min (≤ ${fmt(threshold)} min, 25% da média geral)`);
            lines.push('');
          }
          // Summary stats
          lines.push(`**Resumo:** ${analysis.summary.totalOrders} ordens | ${analysis.summary.countDeslocamentoCurto} com deslocamento curto | ${analysis.summary.countTrExcedeHd} com TR>20% HD | ${analysis.summary.countTempoPadraoVazio} sem tempo padrão`);
          lines.push('');

          // Tempo Padrão Vazio section
          if (analysis.tempoPadraoVazioOrders.length > 0) {
            lines.push('**⚠️ Ordens sem Tempo Padrão — Equipe penalizada por ausência de referência:**');
            lines.push('');
            if (analysis.simulatedEficiencia !== undefined) {
              lines.push(`> **Simulação:** caso o tempo padrão dessas ordens fosse o TR médio global (${fmt(analysis.globalAvgExecucaoMin)} min), a eficiência estimada seria **${fmt(analysis.simulatedEficiencia)}%** (vs. atual ${fmt(analysis.eficienciaValue)}%).`);
              lines.push('');
            }
            lines.push('| Nr Ordem | Classe | Causa | Despachada | No Local | Liberada | TR (min) |');
            lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: |');
            for (const ev of analysis.tempoPadraoVazioOrders.slice(0, 15)) {
              lines.push(`| ${ev.nr_ordem} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.no_local} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} |`);
            }
            lines.push('');
          }

          // Evidence table
          if (analysis.flaggedOrders.length > 0) {
            lines.push('**Ordens com Desvios:**');
            lines.push('');
            lines.push('| Nr Ordem | Classe | Causa | Despachada | No Local | Liberada | TR (min) | HD (min) | % HD | Tempo Padrão | Alertas |');
            lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- |');
            
            for (const ev of analysis.flaggedOrders.slice(0, 10)) {
              const flagLabels = ev.flags.map((f) => {
                if (f === 'deslocamento_curto') return 'Desloc. Curto';
                if (f === 'tr_excede_hd') return 'TR>20% HD';
                if (f === 'tr_muito_baixo') return 'TR Muito Baixo';
                if (f === 'tempo_padrao_vazio') return 'T.Padrão Vazio';
                return f;
              }).join(', ');
              
              const tempPadraoCell = ev.tempo_padrao_min !== undefined ? fmt(ev.tempo_padrao_min) : '—';
              lines.push(
                `| ${ev.nr_ordem} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.no_local} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.hd_total_min)} | ${fmt(ev.hd_pct_tr)}% | ${tempPadraoCell} | **${flagLabels}** |`,
              );
            }
            lines.push('');
          } else {
            lines.push('_Nenhuma ordem específica flagada._');
            lines.push('');
          }
        }
      }
    }
    lines.push(hr);
    lines.push('');

    // ── Desvios ───────────────────────────────────────────────────────
    lines.push('## ⚠️ Desvios de Padrão Operacional');
    lines.push('');
    lines.push('### Desvios Mais Recorrentes na Base');
    lines.push('');
    if (report.deviations.mostRecurring.length === 0) {
      lines.push('_Nenhum desvio encontrado nos dados._');
    } else {
      lines.push('| Desvio | Ocorrências |');
      lines.push('| :--- | ---: |');
      for (const item of report.deviations.mostRecurring) {
        lines.push(`| ${item.category} | ${item.occurrences} |`);
      }
    }
    lines.push('');

    lines.push('### Desvios por Equipe');
    lines.push('');
    if (report.deviations.teamBreakdown.length === 0) {
      lines.push('_Sem dados._');
    } else {
      for (const td of report.deviations.teamBreakdown.slice(0, 20)) {
        if (td.deviations.length === 0) continue;
        lines.push(`**${td.team}:** ${td.deviations.join(' | ')}`);
      }
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── TempPrep / SemOs ──────────────────────────────────────────────
    lines.push('## ⏱ Análise de Utilização — TempPrep e SemOSentreOS');
    lines.push('');
    lines.push('> Valores representam **médias diárias** (min/dia) calculadas pelo backend.');
    lines.push('> **TempPrep**: tempo médio para confirmar "A Caminho" após despacho.');
    lines.push('> **SemOSentreOS**: tempo médio ocioso entre ordens (após liberação da OS anterior).');
    lines.push('> Desconto de intervalo de almoço regulamentar (60 min) já aplicado.');
    lines.push('');
    if (report.specialAnalysis.tempPrepAndSemOs.length === 0) {
      lines.push('_Sem dados de deslocamento disponíveis._');
    } else {
      lines.push('| Equipe | Dias | TempPrep (min/dia) | SemOSentreOS (min/dia) |');
      lines.push('| :--- | ---: | ---: | ---: |');
      for (const tm of report.specialAnalysis.tempPrepAndSemOs.slice(0, 30)) {
        lines.push(`| ${tm.team} | ${tm.records} | ${fmt(tm.tempPrepJornada)} | ${fmt(tm.semOrdemJornada)} |`);
      }
    }
    lines.push('');
    lines.push(hr);
    lines.push('');

    // ── Cruzamentos ───────────────────────────────────────────────────
    lines.push('## 🔀 Análise Cruzada');
    lines.push('');
    for (const insight of report.specialAnalysis.crossedInsights) {
      lines.push(`### ${insight.title}`);
      lines.push('');
      lines.push(`_${insight.description}_`);
      lines.push('');
      if (insight.evidence.length === 0) {
        lines.push('_Sem evidências para os filtros selecionados._');
      } else {
        const keys = Object.keys(insight.evidence[0]);
        lines.push(`| ${keys.join(' | ')} |`);
        lines.push(`| ${keys.map(() => '---:').join(' | ')} |`);
        for (const row of insight.evidence) {
          lines.push(`| ${keys.map((k) => String(row[k] ?? '—')).join(' | ')} |`);
        }
      }
      lines.push('');
    }
    lines.push(hr);
    lines.push('');

    // ── OS/Dia Drill-down ─────────────────────────────────────────────
    if (report.specialAnalysis.osDiaAnalysis.length > 0) {
      const flagLabel: Record<string, string> = {
        tr_excede_hd:    'TR>20% HD',
        tl_excede_hd:    'TL>20% HD',
        temp_prep_alto:  'TempPrep≥20min',
        sem_os_alto:     'SemOS≥20min',
      };

      lines.push('## 🔍 Análise Detalhada — OS/Dia');
      lines.push('');
      lines.push('> Evidências por ordem das equipes abaixo da meta de OS/Dia (4.4). Fonte: **Scanner 4.4 - CE M300**');
      lines.push('');

      let firstOsDia = true;
      for (const analysis of report.specialAnalysis.osDiaAnalysis) {
        if (!firstOsDia) { lines.push(hr); lines.push(''); }
        firstOsDia = false;
        lines.push(`### ${analysis.team}`);
        lines.push('');
        lines.push(
          `**OS/Dia:** ${fmt(analysis.osDiaValue)} | **Meta:** ${analysis.metaTarget} | **Gap:** ${fmt(analysis.gap)} OS/dia`,
        );
        lines.push('');
        lines.push(
          `**Ocorrências flagadas:** TR excede HD: ${analysis.summary.countTrExceeds} | TL excede HD: ${analysis.summary.countTlExceeds} | TempPrep alto: ${analysis.summary.countTempPrepAlto} | SemOS alto: ${analysis.summary.countSemOsAlto}`,
        );
        lines.push('');

        if (analysis.flaggedOrders.length === 0) {
          lines.push('_Nenhuma ordem com evidência nos dados filtrados._');
        } else {
          lines.push('| Nr_Ordem | Prev OS | CLASSE | CAUSA | Despachada | Liberada | TR (min) | % HD | TL (min) | % HD | TempPrep/OS | SemOS/OS | Alertas |');
          lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
          for (const ev of analysis.flaggedOrders) {
            const flagStr = ev.flags.map((f) => flagLabel[f] ?? f).join(', ');
            const prevOsCell = ev.prev_nr_ordem ?? '—';
            const tempPrepCell = ev.temp_prep_os_min !== undefined ? fmt(ev.temp_prep_os_min) : '—';
            const semOsCell   = ev.sem_os_total_min !== undefined ? fmt(ev.sem_os_total_min) : '—';
            lines.push(
              `| ${ev.nr_ordem} | ${prevOsCell} | ${ev.classe} | ${ev.causa} | ${ev.despachada} | ${ev.liberada} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.hd_pct_tr)}% | ${fmt(ev.tl_ordem_min)} | ${fmt(ev.hd_pct_tl)}% | ${tempPrepCell} | ${semOsCell} | **${flagStr}** |`,
            );
          }
        }
        lines.push('');
      }
      lines.push(hr);
      lines.push('');
    }

    // ── Utilização Drill-down ─────────────────────────────────────────
    if (report.specialAnalysis.utilizacaoAnalysis.length > 0) {
      lines.push('## 🔍 Análise Detalhada — Utilização');
      lines.push('');
      lines.push('> Evidências das 3 piores equipes em Utilização (meta: 85%). Fonte: **Tab_Completa-Deslocamentos**');
      lines.push('');

      let firstUtil = true;
      for (const analysis of report.specialAnalysis.utilizacaoAnalysis) {
        if (!firstUtil) { lines.push(hr); lines.push(''); }
        firstUtil = false;
        lines.push(`### ⚠ Oportunidade — ${analysis.team}`);
        lines.push('');
        lines.push(
          `**Utilização:** ${fmt(analysis.utilizacaoValue)}% | **Meta:** ${analysis.metaTarget}% | **Gap:** ${fmt(analysis.gap)}%`,
        );
        lines.push('');
        const lbl = analysis.totalJornadas === 1 ? 'total' : 'médio/dia';
        lines.push(
          `**HD Total (${lbl}):** ${fmt(analysis.hdTotalMin)} min | **TempPrep (${lbl}):** ${fmt(analysis.tempPrepTotalMin)} min | **SemOrdem (${lbl}):** ${fmt(analysis.semOrdemTotalMin)} min`,
        );
        lines.push('');
        lines.push(
          `**Total de OS:** ${analysis.totalOrders} | **Jornadas:** ${analysis.totalJornadas} | **Abaixo da meta:** ${analysis.jornadasAbaixoMeta}`,
        );
        if (analysis.summary.countTempPrepAlto > 0 || analysis.summary.countSemOsAlto > 0) {
          lines.push('');
          const chips: string[] = [];
          if (analysis.summary.countTempPrepAlto > 0) chips.push(`TempPrep≥20min: ${analysis.summary.countTempPrepAlto}`);
          if (analysis.summary.countSemOsAlto > 0) chips.push(`SemOS≥10min: ${analysis.summary.countSemOsAlto}`);
          lines.push(`**Alertas:** ${chips.join(' | ')}`);
        }
        lines.push('');

        if (analysis.flaggedOrders.length === 0) {
          lines.push('_Nenhuma ordem com alertas nos dados filtrados._');
        } else {
          lines.push('| OS | Flags | TR (min) | TL (min) | HD (min) |');
          lines.push('| :--- | :--- | ---: | ---: | ---: |');
          for (const ev of analysis.flaggedOrders) {
            const flagStr = ev.flags.join(', ');
            lines.push(`| ${ev.nr_ordem} | ${flagStr} | ${fmt(ev.tr_ordem_min)} | ${fmt(ev.tl_ordem_min)} | ${fmt(ev.hd_total_min)} |`);
          }
        }
        lines.push('');
      }
      lines.push(hr);
      lines.push('');
    }

    // ── Plano de Ação ─────────────────────────────────────────────────
    lines.push('## 📋 Plano de Ação por Equipe');
    lines.push('');
    if (report.specialAnalysis.actionPlan.length === 0) {
      lines.push('_Nenhuma equipe com oportunidade de melhoria identificada para os filtros selecionados._');
    } else {
      let firstPlan = true;
      for (const plan of report.specialAnalysis.actionPlan) {
        if (!firstPlan) { lines.push(hr); lines.push(''); }
        firstPlan = false;
        lines.push(`### ${plan.team}`);
        lines.push('');
        lines.push('**Problemas identificados:**');
        for (const issue of plan.issues) {
          lines.push(`- ${issue}`);
        }
        if (plan.recommendations.length > 0) {
          lines.push('');
          lines.push('**Recomendações:**');
          for (const rec of plan.recommendations) {
            lines.push(`- ${rec}`);
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
