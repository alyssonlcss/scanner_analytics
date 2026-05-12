// Copyright (c) 2026 Alysson Pinheiro. Todos os direitos reservados.
// Software proprietário e confidencial. Uso não autorizado é proibido.
import type { OsDiaOrderEvidence, EficienciaOrderEvidence, TmeImpOrderEvidence, PrimeiroLoginDayEvidence, PrimeiroDeslocDayEvidence, RetornoBaseDayEvidence } from '../types.js';

export function nfBr(v: number, minDec = 1, maxDec = 1): string {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: minDec, maximumFractionDigits: maxDec });
  }

  /** Computes a sem_os_details item's full display text (label: body). */
export function semOsDetailText(d: {
    type: string; min: number; from?: string; to?: string;
    global_avg_min?: number; above_avg_pct?: number;
    interval_discounted?: boolean; retorno_base_discounted?: number;
    retorno_base_used_row?: boolean; desp_anterior?: string;
  }): string {
    const fmtAvg = (pct: number | undefined, avg: number | undefined): string => {
      if (!Number.isFinite(pct) || !Number.isFinite(avg) || (avg ?? 0) <= 0) return '';
      const dir = (pct! >= 0) ? 'acima' : 'abaixo';
      return ` | ${nfBr(Math.abs(pct!), 0, 1)}% ${dir} da média geral (${nfBr(avg!)} min)`;
    };
    switch (d.type) {
      case 'inicio_jornada': {
        const pctIJ = Math.round((d.min - 10) / 10 * 100);
        return `1º Despacho: ${d.min} min do Início Calendário (${d.from ?? '—'}) até o primeiro despacho (${d.to ?? '—'}) — ${pctIJ}% acima do limite (10 min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      case 'entre_ordens': {
        const pctEO = Math.round((d.min - 10) / 10 * 100);
        return `Entre OS: ${d.min} min sem nova OS — Lib. Anterior (${d.from ?? '—'})${d.desp_anterior ? ' · Desp. Anterior (' + d.desp_anterior + ')' : ''} até Despachada (${d.to ?? '—'})${d.interval_discounted ? ' — intervalo descontado' : ''} — ${pctEO}% acima do limite (10 min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      case 'fim_jornada': {
        const rbDiscount = d.retorno_base_discounted ?? 0;
        const pctRb = rbDiscount > 0 ? Math.round((d.min / rbDiscount) * 100) : undefined;
        const rbPart = pctRb !== undefined ? ` — ${pctRb}% acima do retorno base` : '';
        return `Antes Log Off: ${d.min} min entre última Liberada (${d.from ?? '—'}) e Log Off (${d.to ?? '—'})${d.interval_discounted ? ' — intervalo de 60 min descontado' : ''}${d.retorno_base_discounted ? ' — retorno base ' + (d.retorno_base_used_row ? 'do dia (' + d.retorno_base_discounted + ' min) descontado' : 'médio (' + d.retorno_base_discounted + ' min) descontado') : ''}${rbPart}.`;
      }
      case 'intervalo_deslocamento': {
        const pctID = Math.round((d.min - 10) / 10 * 100);
        return `Desl. Intervalo: ${d.min} min entre Lib. Anterior (${d.from ?? '—'}) e Início Intervalo (${d.to ?? '—'}) — ${pctID}% acima do limite (10 min)${fmtAvg(d.above_avg_pct, d.global_avg_min)}.`;
      }
      default:
        return `${d.type}: ${d.min} min (${d.from ?? '—'} → ${d.to ?? '—'})`;
    }
  }

  /** Enriches OsDia evidence with alertTexts, sem_os_details label/body, and entreOsAfterIntervalo. */
export function enrichOsDiaEvidence(orders: OsDiaOrderEvidence[]): OsDiaOrderEvidence[] {
    const parseDt = (s: string): number => {
      const parts = s.split(' ');
      if (parts.length < 2) return 0;
      const [day, mon, yr] = (parts[0] ?? '').split('/');
      const [hr, min, sec] = (parts[1] ?? '').split(':');
      return new Date(+(yr ?? 0), +(mon ?? 1) - 1, +(day ?? 1), +(hr ?? 0), +(min ?? 0), +(sec ?? 0)).getTime();
    };

    return orders.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'tr_excede_hd':
            alertTexts[flag] = `esta OS consumiu ${ev.tr_ordem_min} min — ${ev.hd_pct_tr}% da jornada de ${ev.hd_total_min} min, acima do limite de 20%. Tempo previsto no M300: ${ev.tempo_padrao_min !== undefined ? ev.tempo_padrao_min + ' min' : 'não cadastrado'}. Uma OS com atendimento muito longo reduz a capacidade de realizar outros chamados no dia.`;
            break;
          case 'tl_excede_hd':
            alertTexts[flag] = `o técnico passou ${ev.tl_ordem_min} min em deslocamento nesta OS — ${ev.global_avg_tl_min > 0 ? nfBr((ev.tl_ordem_min - ev.global_avg_tl_min) / ev.global_avg_tl_min * 100, 0, 0) : '?'}% acima da média geral de ${nfBr(ev.global_avg_tl_min)} min, representando ${ev.hd_pct_tl}% da jornada de ${ev.hd_total_min} min. Deslocamentos muito longos consomem boa parte do dia e diminuem o número de OS atendidas.`;
            break;
          case 'temp_prep_alto': {
            const tempPrepMin = ev.temp_prep_os_min ?? 0;
            const limit = ev.prev_liberada ? 10 : 25;
            const pct = Math.round((tempPrepMin - limit) / limit * 100);
            const subject = ev.prev_liberada ? 'a liberação da OS anterior e o registro de saída nesta OS' : 'o início da jornada e o registro de saída da primeira OS';
            alertTexts[flag] = `o técnico levou ${tempPrepMin} min entre ${subject} — ${pct}% acima do limite de ${limit} min. Esse tempo representa espera antes de se deslocar para o próximo atendimento.`;
            break;
          }
          case 'sem_os_alto':
            alertTexts[flag] = `${ev.sem_os_total_min} min sem OS registrada — acima do limite de 10 min. Esse tempo representa intervalos ociosos em que o técnico não estava atendendo nem a caminho de um chamado.`;
            break;
        }
      }

      const enrichedDetails = ev.sem_os_details?.map((d) => {
        const text = semOsDetailText(d);
        const sep = text.indexOf(': ');
        return { ...d, label: sep > -1 ? text.slice(0, sep) : text, body: sep > -1 ? text.slice(sep + 2) : '' };
      });

      let entreOsAfterIntervalo: OsDiaOrderEvidence['entreOsAfterIntervalo'];
      if (ev.fim_intervalo && ev.despachada) {
        const fimTs  = parseDt(ev.fim_intervalo);
        const despTs = parseDt(ev.despachada);
        if (fimTs > 0 && despTs > 0 && despTs > fimTs) {
          const minDiff = Math.round((despTs - fimTs) / 60000);
          if (minDiff > 10) {
            const alreadyCovered = ev.sem_os_details?.some((d) => d.type === 'entre_ordens' && d.from === ev.fim_intervalo);
            if (!alreadyCovered) {
              entreOsAfterIntervalo = { min: minDiff, from: ev.fim_intervalo, to: ev.despachada };
            }
          }
        }
      }

      return {
        ...ev,
        alertTexts,
        sem_os_details: enrichedDetails ?? ev.sem_os_details,
        ...(entreOsAfterIntervalo ? { entreOsAfterIntervalo } : {}),
      };
    });
  }

  /** Enriches Eficiencia evidence items with pre-computed alertTexts. */
export function enrichEficienciaEvidence(
    orders: EficienciaOrderEvidence[],
    analysis: { globalAvgExecucaoMin: number; globalAvgDeslocamentoMin: number },
  ): EficienciaOrderEvidence[] {
    return orders.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'tr_muito_baixo':
            alertTexts[flag] = `${ev.tr_ordem_min} min de execução — ${analysis.globalAvgExecucaoMin > 0 ? nfBr((analysis.globalAvgExecucaoMin - ev.tr_ordem_min) / analysis.globalAvgExecucaoMin * 100, 0, 0) : '?'}% abaixo da média geral de ${nfBr(analysis.globalAvgExecucaoMin)} min. Deslocamento registrado (TL): ${ev.tl_ordem_min} min${ev.tl_ordem_min > analysis.globalAvgDeslocamentoMin ? ' — TL elevado indica erro no apontamento de "A Caminho" ou "No Local", comprimindo artificialmente o TR' : ' — grande possibilidade de erro de apontamento de "A Caminho" ou "No Local"'}.`;
            break;
          case 'deslocamento_curto':
            alertTexts[flag] = `o tempo de deslocamento desta OS foi de apenas ${ev.tl_ordem_min} min — inferior a 25% da média geral de ${nfBr(analysis.globalAvgDeslocamentoMin)} min. Pode indicar atendimento sem deslocamento real ou lançamento incorreto no sistema.`;
            break;
          case 'tr_excede_hd':
            alertTexts[flag] = `esta OS consumiu ${ev.tr_ordem_min} min — ${ev.hd_pct_tr}% da jornada de ${ev.hd_total_min} min, acima do limite de 20%. Tempo previsto no M300: ${ev.tempo_padrao_min !== undefined ? ev.tempo_padrao_min + ' min' : 'não cadastrado'}. Uma OS com atendimento muito longo reduz a capacidade de realizar outros chamados no dia.`;
            break;
          case 'tempo_padrao_vazio':
            alertTexts[flag] = `esta OS foi atendida em ${ev.tr_ordem_min} min, mas não tem tempo padrão definido no M300. Sem esse dado, a eficiência é calculada como zero, prejudicando o resultado da equipe mesmo que o atendimento tenha sido realizado.`;
            break;
        }
      }
      return { ...ev, alertTexts };
    });
  }

  /** Enriches TME IMP evidence items with pre-computed alertTexts. */
export function enrichTmeImpEvidence(orders: TmeImpOrderEvidence[]): TmeImpOrderEvidence[] {
    return orders.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'tme_muito_alto':
            alertTexts[flag] = `esta OS acumulou ${nfBr(ev.tme_imp_min)} min de tempo improdutivo — acima da média da equipe (${nfBr(ev.team_avg_tme_min)} min) e da média geral (${nfBr(ev.global_avg_tme_min)} min). Esse é o tempo entre a chegada ao local (No Local) e a liberação da OS, sem execução produtiva registrada. Quanto maior esse tempo, mais prejudica a pontuação da equipe.`;
            break;
          case 'sem_deslocamento':
            alertTexts[flag] = `a OS tem ${nfBr(ev.tl_ordem_min)} min de deslocamento, mas não há horário de saída lançado no sistema. O técnico se deslocou mas não atualizou o aplicativo, impedindo o cálculo correto do tempo improdutivo.`;
            break;
          case 'sem_execucao':
            alertTexts[flag] = `esta OS não tem registro de execução, mas acumulou tempo improdutivo. Pode indicar uma OS encerrada sem atendimento real ou lançamento incorreto no sistema.`;
            break;
        }
      }
      return { ...ev, alertTexts };
    });
  }

  /** Enriches Primeiro Login evidence items with pre-computed alertTexts. */
export function enrichLoginEvidence(days: PrimeiroLoginDayEvidence[], metaTarget: number): PrimeiroLoginDayEvidence[] {
    return days.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'login_muito_tardio':
            alertTexts[flag] = `o técnico levou ${nfBr(ev.primeiro_login_min)} min para entrar no sistema — mais do que o dobro da meta de ${metaTarget} min. Um atraso tão grande atrasa o primeiro despacho e reduz bastante o tempo disponível para atendimento no dia.`;
            break;
          case 'login_tardio':
            alertTexts[flag] = `o técnico levou ${nfBr(ev.primeiro_login_min)} min para entrar no sistema — acima da meta de ${metaTarget} min (média da equipe: ${nfBr(ev.team_avg_login_min)} min). Quanto mais tarde o técnico acessa o sistema, mais tarde recebe o primeiro despacho e menos chamados consegue atender no dia.`;
            break;
        }
      }
      return { ...ev, alertTexts };
    });
  }

  /** Enriches Primeiro Desloc evidence items with pre-computed alertTexts. */
export function enrichDeslocEvidence(days: PrimeiroDeslocDayEvidence[], metaTarget: number): PrimeiroDeslocDayEvidence[] {
    return days.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'despacho_tardio':
            alertTexts[flag] = `a equipe recebeu a primeira OS com ${nfBr(ev.despacho_apos_inicio_min)} min de atraso em relação ao início da jornada — acima do limite de 10 min.${ev.login_atraso_min > 0 ? ` Desse total, ${nfBr(ev.login_atraso_min)} min foram de atraso no acesso ao sistema (início da jornada ${ev.inicio_calendario} → acesso ${ev.log_in_corrigido}) e os demais ${nfBr(ev.despacho_apos_inicio_min - ev.login_atraso_min)} min de espera entre o acesso e o primeiro despacho.` : ''} Esse atraso reduz o tempo disponível para atendimentos no dia.`;
            break;
          case 'desloc_muito_lento':
            alertTexts[flag] = `a equipe levou ${nfBr(ev.primeiro_desloc_min)} min para registrar saída após o primeiro despacho — mais de 1,5× a meta de ${metaTarget} min. Uma demora tão grande indica que o técnico ficou parado por muito tempo antes de se deslocar para o primeiro atendimento do dia.`;
            break;
          case 'desloc_lento':
            alertTexts[flag] = `a equipe levou ${nfBr(ev.primeiro_desloc_min)} min para registrar saída após o primeiro despacho — acima da meta de ${metaTarget} min (média da equipe: ${nfBr(ev.team_avg_desloc_min)} min). Sair tarde para o primeiro atendimento reduz o aproveitamento da jornada.`;
            break;
          case 'sem_desloc_registrado':
            alertTexts[flag] = `há registro de despacho, mas o técnico não atualizou o status de saída. Isso impede o cálculo real do 1º Desloc. e indica que o deslocamento pode ter ocorrido sem lançamento no sistema.`;
            break;
        }
      }
      return { ...ev, alertTexts };
    });
  }

  /** Enriches Retorno Base evidence items with pre-computed alertTexts. */
export function enrichRetornoEvidence(days: RetornoBaseDayEvidence[], metaTarget: number): RetornoBaseDayEvidence[] {
    return days.map((ev) => {
      const alertTexts: Record<string, string> = {};
      for (const flag of ev.flags) {
        switch (flag) {
          case 'retorno_muito_alto':
            alertTexts[flag] = `${nfBr(ev.retorno_base_min)} min — mais de 1,5× a meta de ${metaTarget} min. Pode indicar trajeto muito longo até a base, região de atuação distante, ou permanência no campo sem atendimento após a última OS. Retornos longos são descontados no cálculo de Utilização, prejudicando a nota da equipe.`;
            break;
          case 'retorno_alto':
            alertTexts[flag] = `${nfBr(ev.retorno_base_min)} min — acima da meta de ${metaTarget} min (média da equipe: ${nfBr(ev.team_avg_retorno_min)} min, média geral: ${nfBr(ev.global_avg_retorno_min)} min). Esse tempo é descontado no cálculo de Utilização, impactando diretamente na nota da equipe.`;
            break;
        }
      }
      return { ...ev, alertTexts };
    });
  }

