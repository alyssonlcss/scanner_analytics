import type { CsvRow } from '../csv-utils.js';
import type { KpiInsight, TeamKpiScorecard, ExecutiveSummary, TeamActionPlan, CrossedInsight, DeviationInsight, DeviationByTeam, TeamMetricSummary, OsDiaTeamAnalysis, UtilizacaoTeamAnalysis, EficienciaTeamAnalysis, TmeImpTeamAnalysis, PrimeiroLoginTeamAnalysis, PrimeiroDeslocTeamAnalysis, RetornoBaseTeamAnalysis } from '../types.js';
import { normalizeToken, round2, createAccessor, parseNumber, percentile } from '../csv-utils.js';
import { KPI_THRESHOLDS } from '../constants.js';

export function buildDeviationInsights(rows: CsvRow[]): { mostRecurring: DeviationInsight[]; teamBreakdown: DeviationByTeam[] } {
    if (rows.length === 0) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const accessor = createAccessor(rows[0]);
    const teamCol = accessor.resolve(['Equipe', 'Team']);
    const deviationCol = accessor.resolve(['Desvio', 'Tipo Desvio', 'Desvios', 'Ocorrência', 'Ocorrencia', 'Descrição']);

    if (!teamCol || !deviationCol) {
      return { mostRecurring: [], teamBreakdown: [] };
    }

    const countByDeviation = new Map<string, number>();
    const countByTeam = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const team = String(row[teamCol] ?? '').trim();
      const category = String(row[deviationCol] ?? '').trim();
      if (!team || !category) {
        continue;
      }

      countByDeviation.set(category, (countByDeviation.get(category) ?? 0) + 1);

      const teamMap = countByTeam.get(team) ?? new Map<string, number>();
      teamMap.set(category, (teamMap.get(category) ?? 0) + 1);
      countByTeam.set(team, teamMap);
    }

    const mostRecurring = Array.from(countByDeviation.entries())
      .map(([category, occurrences]) => ({ category, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const teamBreakdown = Array.from(countByTeam.entries())
      .map(([team, teamMap]) => ({
        team,
        deviations: Array.from(teamMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([category]) => category),
      }))
      .sort((a, b) => a.team.localeCompare(b.team));

    return { mostRecurring, teamBreakdown };
  }

export function buildCrossedInsights(
    teamMetrics: TeamMetricSummary[],
    kpis: KpiInsight[],
    teamDeviations: DeviationByTeam[],
  ): CrossedInsight[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));
    const utilKpi = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Utilização'));
    const retornoBase = kpis.find((item) => normalizeToken(item.kpi) === normalizeToken('Retorno Base'));

    const matrixEvidence = teamMetrics
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Util < 40%')) || token.includes(normalizeToken('Intervalo < 30 ou > 70 min'));
        });
      })
      .slice(0, 8)
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
        tempPrepJornada: item.tempPrepJornada,
      }));

    const falsePositiveEvidence = (retornoBase?.topTeams ?? [])
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => normalizeToken(entry).includes(normalizeToken('Retorno a base < 8 min')));
      })
      .map((item) => ({
        team: item.team,
        retornoBase: item.value,
      }));

    const highIdleThreshold = percentile(teamMetrics.map((item) => item.semOrdemJornada), 0.75);
    const idleCulpabilityEvidence = teamMetrics
      .filter((item) => item.semOrdemJornada >= highIdleThreshold)
      .filter((item) => {
        const deviations = deviationMap.get(item.team) ?? [];
        return deviations.some((entry) => {
          const token = normalizeToken(entry);
          return token.includes(normalizeToken('Sem Fim Turno')) || token.includes(normalizeToken('Calendário Errado'));
        });
      })
      .map((item) => ({
        team: item.team,
        semOrdemJornada: item.semOrdemJornada,
      }));

    return [
      {
        title: 'Matriz Desvios vs Utilização',
        description: utilKpi
          ? 'Cruza equipes com desvios críticos de utilização/intervalo com os tempos calculados de TempPrep e SemOSentreOS.'
          : 'Cruza equipes com desvios críticos de utilização/intervalo com tempos de ociosidade calculados.',
        evidence: matrixEvidence,
      },
      {
        title: 'Análise de Falsos Positivos de Retorno',
        description: 'Identifica equipes com boa nota de Retorno Base e desvio de retorno suspeito (<8 min).',
        evidence: falsePositiveEvidence,
      },
      {
        title: 'Culpabilidade do Ócio',
        description: 'Relaciona alto SemOSentreOS com desvios de indisciplina de apontamento.',
        evidence: idleCulpabilityEvidence,
      },
    ];
  }

export function buildActionPlans(
    teamMetrics: TeamMetricSummary[],
    kpis: KpiInsight[],
    teamDeviations: DeviationByTeam[],
    osDiaAnalysis: OsDiaTeamAnalysis[] = [],
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[] = [],
    eficienciaAnalysis: EficienciaTeamAnalysis[] = [],
    tmeImpAnalysis: TmeImpTeamAnalysis[] = [],
    primeiroLoginAnalysis: PrimeiroLoginTeamAnalysis[] = [],
    primeiroDeslocAnalysis: PrimeiroDeslocTeamAnalysis[] = [],
    retornoBaseAnalysis: RetornoBaseTeamAnalysis[] = [],
  ): TeamActionPlan[] {
    const deviationMap = new Map(teamDeviations.map((item) => [item.team, item.deviations]));
    const osDiaMap = new Map(osDiaAnalysis.map((a) => [a.team, a]));
    const utilizacaoMap = new Map(utilizacaoAnalysis.map((a) => [a.team, a]));
    const eficienciaMap = new Map(
      eficienciaAnalysis
        .filter((a) => a.analysisType === 'underperformer')
        .map((a) => [a.team, a]),
    );
    const tmeImpMap       = new Map(tmeImpAnalysis.map((a) => [a.team, a]));
    const loginMap        = new Map(primeiroLoginAnalysis.map((a) => [a.team, a]));
    const deslocMap       = new Map(primeiroDeslocAnalysis.map((a) => [a.team, a]));
    const retornoMap      = new Map(retornoBaseAnalysis.map((a) => [a.team, a]));

    const opportunityTeams = new Set<string>();
    for (const insight of kpis) {
      for (const t of insight.opportunityTeams) {
        opportunityTeams.add(t.team);
      }
    }

    const plans: TeamActionPlan[] = [];

    for (const tm of teamMetrics) {
      if (!opportunityTeams.has(tm.team)) {
        continue;
      }

      const issues: string[] = [];
      const recommendations: string[] = [];
      const deviations = deviationMap.get(tm.team) ?? [];
      const osDia = osDiaMap.get(tm.team);
      const util = utilizacaoMap.get(tm.team);
      const efic = eficienciaMap.get(tm.team);

      // Determine which KPI categories this team is failing
      const teamInOsDia   = kpis.find((k) => k.kpi === 'OS Dia')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInUtil    = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Utilização'))?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInEfic    = kpis.find((k) => normalizeToken(k.kpi) === normalizeToken('Eficiência'))?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInTme     = kpis.find((k) => k.kpi === 'TME IMP')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInLogin   = kpis.find((k) => k.kpi === '1º Login')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInDesloc  = kpis.find((k) => k.kpi === '1º Desloc.')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;
      const teamInRetorno = kpis.find((k) => k.kpi === 'Retorno Base')?.opportunityTeams.some((t) => t.team === tm.team) ?? false;

      // Helper: KPI impact label to append as context at the end of each issue
      const kpiCtx = (kpiName: string): string => ` → impacta ${kpiName} abaixo da meta.`;

      // ── OS Dia / Utilização — flag-first analysis ──────────────────────────
      if (teamInOsDia || teamInUtil) {
        const idleAnalysis = osDia ?? util;
        if (idleAnalysis) {
          type SharedEv = {
            flags: string[];
            nr_ordem?: string;
            prev_liberada?: string;
            temp_prep_os_min?: number;
            sem_os_details?: Array<{ type: string; min: number }>;
            sem_os_total_min?: number;
            tl_ordem_min: number;
            hd_pct_tr?: number;
            hd_total_min?: number;
            tr_ordem_min?: number;
            tempo_padrao_min?: number;
          };
          const orders = idleAnalysis.flaggedOrders as unknown as SharedEv[];
          const kpiLabel = teamInOsDia && teamInUtil ? 'OS Dia e Utilização' : teamInOsDia ? 'OS Dia' : 'Utilização';

          // TR and TL only affect OS Dia and Eficiência — Utilização is driven by idle time (TempPrep, SemOrdem)
          const trTlParts: string[] = [];
          if (teamInOsDia) trTlParts.push('OS Dia');
          if (teamInEfic) trTlParts.push('Eficiência');
          const kpiLabelTrTl = trTlParts.length > 0 ? trTlParts.join(' e ') : 'OS Dia';

          // Flag: TR>20%HD — OS com tempo de reparo acima de 20% da jornada
          const trExcede = orders.filter((o) => o.flags.includes('tr_excede_hd'));
          if (trExcede.length > 0) {
            const worst = trExcede.slice().sort((a, b) => (b.tr_ordem_min ?? 0) - (a.tr_ordem_min ?? 0))[0];
            issues.push(
              `Temp. Reparo>20%HD: ${trExcede.length} OS com tempo de reparo acima de 20% da jornada — caso crítico OS ${worst.nr_ordem ?? '—'}` +
              ` (${worst.tr_ordem_min ?? '?'} min, ${worst.hd_pct_tr ?? '?'}% da HD de ${worst.hd_total_min ?? '?'} min).` +
              kpiCtx(kpiLabelTrTl),
            );
            recommendations.push(
              `Temp. Reparo>20%HD — Comparar as OS mais longas com o Tempo Padrão M300` +
              (worst.tempo_padrao_min !== undefined ? ` (${worst.tempo_padrao_min} min cadastrado para essa classe/causa)` : ' (sem tempo padrão cadastrado para esse tipo — solicitar ao time de engenharia)') +
              `. Se o TR real superar o padrão de forma sistemática, levantar a causa raiz (complexidade, falta de material, erro de diagnóstico) e escalar para o supervisor.`,
            );
          }

          // Flag: TL>25%médG — OS com deslocamento acima de 25% da média global
          const tlExcede = orders.filter((o) => o.flags.includes('tl_excede_hd'));
          if (tlExcede.length > 0) {
            issues.push(
              `TL>25%médG: ${tlExcede.length} OS com tempo de deslocamento acima de 25% da média global — cada OS com TL longo retira tempo produtivo da jornada.` +
              kpiCtx(kpiLabelTrTl),
            );
            recommendations.push(
              `TL>25%médG — Avaliar com o planejamento a distribuição geográfica das ordens desta equipe; se o padrão for recorrente, identificar OS sistematicamente distantes e propor ajuste no roteiro de despacho.`,
            );
          }

          // Flag: TempPrep≥10min — demora entre despacho e saída
          const tempPrepOrders = orders.filter((o) => o.flags.includes('temp_prep_alto'));
          if (tempPrepOrders.length > 0) {
            const avgTp = round2(tempPrepOrders.reduce((s, o) => s + (o.temp_prep_os_min ?? 0), 0) / tempPrepOrders.length);
            const firstOs = tempPrepOrders.filter((o) => !o.prev_liberada);
            const betweenOs = tempPrepOrders.filter((o) => Boolean(o.prev_liberada));
            const ctx = firstOs.length > 0 && betweenOs.length > 0
              ? `${betweenOs.length} entre ordens e ${firstOs.length} na 1ª OS do dia`
              : firstOs.length > 0 ? `${firstOs.length} na 1ª OS do dia — demora desde o início de calendário até o primeiro deslocamento`
              : `${betweenOs.length} entre ordens — demora após receber um novo despacho`;
            issues.push(
              `Temp. Partida elevado: ${tempPrepOrders.length} OS com tempo de preparação elevado (média ${avgTp} min — ${ctx}).` +
              kpiCtx('Utilização'),
            );
            recommendations.push(
              `Temp. Partida elevado — Ao receber o despacho, acionar imediatamente o status "A Caminho" sem aguardar na base.` +
              (firstOs.length > 0 ? ` Para a 1ª OS do dia, o limite é de 25 min (Início Calendário → A Caminho); para as demais ordens o limite é de 10 min (Lib. Anterior → A Caminho).` : '') +
              ` Reforçar no próximo alinhamento que Temp. Partida alto é descontado diretamente na Utilização.`,
            );
          }

          // Flag: SemOrdem≥10min — intervalos sem atendimento
          if (idleAnalysis.summary.countSemOsAlto > 0) {
            const semOsOrders = orders.filter((o) => o.flags.includes('sem_os_alto'));
            const avgMin = semOsOrders.length > 0
              ? round2(semOsOrders.reduce((s, o) => s + (o.sem_os_total_min ?? 0), 0) / semOsOrders.length)
              : round2(idleAnalysis.semOrdemTotalMin);
            const hasEntreOrdens = semOsOrders.some((o) => o.sem_os_details?.some((d) => d.type === 'entre_ordens'));
            const hasInicio = semOsOrders.some((o) => o.sem_os_details?.some((d) => d.type === 'inicio_jornada'));
            const semOsCtx = hasEntreOrdens && hasInicio ? 'entre ordens e no início de jornada'
              : hasEntreOrdens ? 'entre ordens' : 'no início de jornada';
            issues.push(
              `SemOrdem≥10min: ${idleAnalysis.summary.countSemOsAlto} OS/dias com tempo ocioso acima de 10 min (média ${avgMin} min — ${semOsCtx}).` +
              kpiCtx('Utilização'),
            );
            recommendations.push(
              `SemOrdem≥10min — Ao liberar uma OS, acionar imediatamente a central para receber o próximo despacho; cobrar que o técnico não aguarde passivamente. Se o gargalo for da central (fila vazia), mapear o horário de pico e ajustar a priorização de despacho.`,
            );

            // Intervalo de almoço suspeito
            const intervaloDesl = semOsOrders.filter((o) => o.sem_os_details?.some((d) => d.type === 'intervalo_deslocamento'));
            if (intervaloDesl.length > 0) {
              const avgItvMin = round2(intervaloDesl.reduce((s, o) => {
                const d = o.sem_os_details?.find((x) => x.type === 'intervalo_deslocamento');
                return s + (d?.min ?? 0);
              }, 0) / intervaloDesl.length);
              issues.push(
                `Desl. para intervalo suspeito: ${intervaloDesl.length} OS com deslocamento de ${avgItvMin} min antes do intervalo de almoço — possível saída de ponto para realizar o intervalo.`,
              );
              recommendations.push(
                `Desl. para intervalo — Orientar que o intervalo de almoço deve ser iniciado a partir do ponto atual de atendimento, não de um novo endereço; deslocamentos longos pré-intervalo são contabilizados no SemOrdem.`,
              );
            }
          }

          // Horas extras + ociosidade elevada
          const ia = idleAnalysis.idleAnalysis;
          if (ia && ia.horasExtras > 0 && ia.idlePct >= 15) {
            issues.push(
              `Horas extras com ociosidade elevada: ${round2(ia.horasExtras)} min/dia de horas extras registradas com ${ia.idlePct.toFixed(1)}% de ociosidade simultânea — possível janela improdutiva não declarada.`,
            );
            recommendations.push(
              `Horas extras + ociosidade — Revisar os apontamentos do período: identificar se as horas extras coincidem com SemOrdem ou TempPrep elevado; se sim, solicitar justificativa do técnico e corrigir os registros.`,
            );
          }
        }
      }

      // ── Eficiência — flag-first analysis ──────────────────────────────────
      const eficAny = eficienciaAnalysis.find((a) => a.team === tm.team);

      // Flag: TR muito baixo (qualquer analysisType — indica erro de apontamento)
      const trBaixoOrders = eficAny?.flaggedOrders.filter((o) => o.flags.includes('tr_muito_baixo')) ?? [];
      if (trBaixoOrders.length > 0) {
        const globalAvgExec = eficAny!.globalAvgExecucaoMin;
        const globalAvgTl   = eficAny!.globalAvgDeslocamentoMin;
        const avgTl = round2(trBaixoOrders.reduce((s, o) => s + o.tl_ordem_min, 0) / trBaixoOrders.length);
        const tlAlto = globalAvgTl > 0 && avgTl > globalAvgTl;
        const worst = trBaixoOrders.slice().sort((a, b) => a.tr_ordem_min - b.tr_ordem_min)[0];
        issues.push(
          `Temp. Reparo muito baixo: ${trBaixoOrders.length} OS com tempo de execução muito abaixo da média global (${round2(globalAvgExec)} min) — caso crítico OS ${worst.nr_ordem} com ${worst.tr_ordem_min} min.` +
          (tlAlto ? ` TL médio dessas OS (${avgTl} min) acima da média global (${round2(globalAvgTl)} min) — reforça hipótese de erro de apontamento.` : '') +
          kpiCtx('Eficiência'),
        );
        recommendations.push(
          `Temp. Reparo muito baixo — Cobrar que cada etapa do atendimento seja registrada no momento exato: "A Caminho" ao sair, "No Local" ao chegar e liberação da OS ao concluir.` +
          (tlAlto ? ` O TL elevado dessas OS indica que "A Caminho" foi acionado tarde ou "No Local" foi acionado cedo, comprimindo artificialmente o TR registrado.` : ` Apontamentos fora de ordem ou com atraso distorcem o TR real e prejudicam o resultado de Eficiência de toda a equipe.`),
        );
      }

      if (teamInEfic && efic) {
        // Flag: TL muito curto — possível técnico já no local ou erro de A Caminho
        const deslocCurto = efic.flaggedOrders.filter((o) => o.flags.includes('deslocamento_curto'));
        if (deslocCurto.length > 0) {
          issues.push(
            `TL muito curto: ${deslocCurto.length} OS com deslocamento inferior a 25% da média global — possível atendimento sem deslocamento real ou erro de apontamento de "A Caminho".` +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `TL muito curto — Verificar se o status "A Caminho" está sendo acionado no local correto e no momento certo; se o técnico já estava no local ao receber o despacho, orientar que isso deve ser comunicado à central para ajuste de roteiro.`,
          );
        }

        // Flag: Tempo Padrão ausente — OS executadas sem referência no M300
        const countTp = Math.max(
          efic.flaggedOrders.filter((o) => o.flags.includes('tempo_padrao_vazio')).length,
          efic.summary.countTempoPadraoVazio,
        );
        if (countTp > 0) {
          issues.push(
            `Tempo Padrão ausente: ${countTp} OS executadas sem Tempo Padrão cadastrado no M300 — eficiência contada como zero nessas OS independentemente do tempo real de execução.` +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `Tempo Padrão ausente — Levantar as classes/causas dessas ${countTp} OS e solicitar formalmente ao time de engenharia o cadastro do Tempo Padrão correspondente. Enquanto não cadastrado, a equipe é penalizada mesmo executando o atendimento corretamente.`,
          );
        }

        // Flag: TR>20%HD (Eficiência — deslocamento muito curto somado ao TR longo)
        const trExcedeEfic = efic.flaggedOrders.filter((o) => o.flags.includes('tr_excede_hd'));
        if (trExcedeEfic.length > 0) {
          const hasDeslocCurto = trExcedeEfic.some((o) => o.tl_ordem_min < 5);
          issues.push(
            `Temp. Reparo>20%HD (Eficiência): ${trExcedeEfic.length} OS com tempo de reparo acima de 20% da jornada` +
            (hasDeslocCurto ? ` — ${trExcedeEfic.filter((o) => o.tl_ordem_min < 5).length} delas com TL <5 min, sugerindo técnico já no local ou erro de "A Caminho".` : '.') +
            kpiCtx('Eficiência'),
          );
          recommendations.push(
            `Temp. Reparo>20%HD (Eficiência) — ${hasDeslocCurto ? 'Verificar se o botão "A Caminho" está sendo acionado no endereço correto e no momento certo; ' : ''}` +
            `investigar as OS mais longas: comparar com o Tempo Padrão M300 e identificar se a causa raiz é complexidade real ou apontamento incorreto.`,
          );
        }
      }

      // ── TME IMP — flag-first analysis ──────────────────────────────────────
      if (teamInTme) {
        const tme = tmeImpMap.get(tm.team);
        if (tme) {
          if (tme.summary.countTmeMuitoAlto > 0) {
            const worst = tme.flaggedOrders
              .filter((o) => o.flags.includes('tme_muito_alto'))
              .sort((a, b) => b.tme_imp_min - a.tme_imp_min)[0];
            issues.push(
              `TME IMP elevado: ${tme.summary.countTmeMuitoAlto} OS com tempo improdutivo (No Local → Liberada) acima de 1,5× a média — caso crítico OS ${worst.nr_ordem}` +
              ` com ${round2(worst.tme_imp_min)} min (vs. média da equipe ${round2(worst.team_avg_tme_min)} min).` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `TME IMP elevado — Verificar se havia impedimento de acesso, aguardo de material/apoio técnico ou se a OS ficou aberta após o atendimento. Cobrar que "Liberada" seja acionada imediatamente ao concluir o serviço no local.`,
            );
          }
          if (tme.summary.countSemDeslocamento > 0) {
            issues.push(
              `Sem "A Caminho" registrado: ${tme.summary.countSemDeslocamento} OS sem status de deslocamento — sem esse dado o TME IMP é inflado artificialmente, pois o tempo começa a contar desde o último status anterior.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `Sem "A Caminho" — Reforçar uso correto do aplicativo: acionar "A Caminho" no momento exato da saída para cada atendimento. A ausência desse registro impede o cálculo correto do TME IMP e prejudica o KPI de toda a equipe.`,
            );
          }
          if (tme.summary.countSemExecucao > 0) {
            issues.push(
              `Sem TR registrado: ${tme.summary.countSemExecucao} OS com tempo improdutivo mas sem execução — OS encerrada sem atendimento real ou lançamento incorreto no sistema.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `Sem TR registrado — Verificar junto ao técnico o que ocorreu nessas OS; se foram encerradas incorretamente, solicitar correção no sistema para que a execução seja contabilizada corretamente.`,
            );
          }
          if (!tme.summary.countTmeMuitoAlto && !tme.summary.countSemDeslocamento && !tme.summary.countSemExecucao) {
            issues.push(
              `TME IMP médio de ${round2(tme.tmeImpValue)} min — acima da meta de ${tme.metaTarget} min; tempo improdutivo entre chegada ao local e liberação da OS está elevado.` +
              kpiCtx('TME IMP'),
            );
            recommendations.push(
              `TME IMP — Cobrar que ao chegar ao local o técnico inicie imediatamente os procedimentos de atendimento e acione "Liberada" assim que concluir, sem deixar a OS aberta.`,
            );
          }
        }
      }

      // ── 1º Login — flag-first analysis ────────────────────────────────────
      if (teamInLogin) {
        const login = loginMap.get(tm.team);
        if (login) {
          if (login.summary.countLoginMuitoTardio > 0) {
            const worst = login.flaggedDays
              .filter((d) => d.flags.includes('login_muito_tardio'))
              .sort((a, b) => b.primeiro_login_min - a.primeiro_login_min)[0];
            issues.push(
              `Login muito tardio: ${login.summary.countLoginMuitoTardio} dia(s) com acesso ao sistema com mais do dobro da meta de ${login.metaTarget} min — caso crítico ${worst.date_ref} com ${round2(worst.primeiro_login_min)} min. Atrasa o primeiro despacho e reduz os atendimentos possíveis no dia.` +
              kpiCtx('1º Login'),
            );
            recommendations.push(
              `Login muito tardio — Investigar a causa específica (problema técnico, hábito operacional ou evento pontual) no(s) dia(s) identificado(s). Reforçar que o login deve ser a primeira ação ao iniciar a jornada; cada minuto de atraso retarda o primeiro despacho diretamente.`,
            );
          } else if (login.summary.countLoginTardio > 0) {
            const lateOnes = login.flaggedDays.filter((d) => d.flags.includes('login_tardio'));
            const avgLate = lateOnes.length > 0 ? round2(lateOnes.reduce((s, d) => s + d.primeiro_login_min, 0) / lateOnes.length) : 0;
            issues.push(
              `Login tardio: ${login.summary.countLoginTardio} dia(s) com login acima da meta de ${login.metaTarget} min (média ${avgLate} min nesse(s) dia(s)).` +
              kpiCtx('1º Login'),
            );
            recommendations.push(
              `Login tardio — Orientar login imediato ao iniciar a jornada. Se o atraso for recorrente nos mesmos dias da semana, investigar causa estrutural (trânsito, escala, problema técnico) e tratar com o supervisor.`,
            );
          }
          if (login.diasAcimaMetaCount > 1) {
            recommendations.push(
              `Login tardio recorrente em ${login.diasAcimaMetaCount}/${login.totalDays} dias — verificar se há problema técnico de acesso ao sistema ou hábito operacional; abordar no próximo alinhamento de equipe com foco em rotina de início de turno.`,
            );
          }
        }
      }

      // ── 1º Desloc. — flag-first analysis ──────────────────────────────────
      if (teamInDesloc) {
        const desloc = deslocMap.get(tm.team);
        if (desloc) {
          if (desloc.summary.countDeslocMuitoLento > 0) {
            const worst = desloc.flaggedDays
              .filter((d) => d.flags.includes('desloc_muito_lento'))
              .sort((a, b) => b.primeiro_desloc_min - a.primeiro_desloc_min)[0];
            issues.push(
              `1º Desloc. muito lento: ${desloc.summary.countDeslocMuitoLento} dia(s) com mais de 1,5× a meta de ${desloc.metaTarget} min entre o primeiro despacho e "A Caminho" — caso crítico ${worst.date_ref} com ${round2(worst.primeiro_desloc_min)} min parado antes de sair.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `1º Desloc. muito lento — Investigar o que reteve o técnico antes de sair no(s) dia(s) identificado(s) (preparação de material, reunião, etc.). Reforçar que ao receber o primeiro despacho o status "A Caminho" deve ser acionado imediatamente.`,
            );
          } else if (desloc.summary.countDeslocLento > 0) {
            issues.push(
              `1º Desloc. lento: ${desloc.summary.countDeslocLento} dia(s) com tempo entre despacho e "A Caminho" acima de ${desloc.metaTarget} min — saída tardia para o primeiro atendimento reduz o aproveitamento da jornada.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `1º Desloc. lento — Cobrar que "A Caminho" seja acionado imediatamente ao receber o despacho; se houver preparação prévia necessária, antecipar essa etapa antes da janela de despacho.`,
            );
          }
          if (desloc.summary.countSemDeslocRegistrado > 0) {
            issues.push(
              `Sem "A Caminho" no 1º despacho: ${desloc.summary.countSemDeslocRegistrado} dia(s) sem registro de saída após o primeiro despacho — impossível calcular o 1º Desloc. real.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `Sem "A Caminho" no 1º despacho — Reforçar uso correto do aplicativo: acionar "A Caminho" ao sair, mesmo que já esteja em deslocamento. A ausência prejudica o cálculo do KPI e impede identificar atrasos reais.`,
            );
          }
          if (desloc.summary.countDespachioTardio > 0) {
            const tardioOnes = desloc.flaggedDays.filter((d) => d.flags.includes('despacho_tardio'));
            const avgTardio  = tardioOnes.length > 0 ? round2(tardioOnes.reduce((s, d) => s + d.despacho_apos_inicio_min, 0) / tardioOnes.length) : 0;
            const loginDelay = tardioOnes.length > 0 ? round2(tardioOnes.reduce((s, d) => s + d.login_atraso_min, 0) / tardioOnes.length) : 0;
            issues.push(
              `Despacho tardio: ${desloc.summary.countDespachioTardio} dia(s) com o primeiro despacho recebido com mais de 10 min após o início de jornada — média de ${avgTardio} min` +
              (loginDelay > 0 ? ` (inclui ${loginDelay} min de atraso de login)` : '') + `.` +
              kpiCtx('1º Desloc.'),
            );
            recommendations.push(
              `Despacho tardio — ${loginDelay > 0 ? 'Parte do atraso origina-se do login tardio: garantir que o técnico esteja logado antes do início da janela de despacho. ' : ''}` +
              `Alinhar com a central o horário de início dos despachos para esta equipe e garantir prontidão desde o início do turno.`,
            );
          }
        }
      }

      // ── Retorno Base — flag-first analysis ────────────────────────────────
      if (teamInRetorno) {
        const retorno = retornoMap.get(tm.team);
        if (retorno) {
          if (retorno.summary.countRetornoMuitoAlto > 0) {
            const worst = retorno.flaggedDays
              .filter((d) => d.flags.includes('retorno_muito_alto'))
              .sort((a, b) => b.retorno_base_min - a.retorno_base_min)[0];
            issues.push(
              `Retorno Base muito alto: ${retorno.summary.countRetornoMuitoAlto} dia(s) com retorno acima de 1,5× a meta de ${retorno.metaTarget} min — caso crítico ${worst.date_ref} com ${round2(worst.retorno_base_min)} min. Esse tempo é descontado diretamente na Utilização.` +
              kpiCtx('Retorno Base'),
            );
            recommendations.push(
              `Retorno muito alto — Avaliar com o planejamento se a última OS do dia pode ser encerrada geograficamente mais próxima da base; se o trajeto de retorno for sistematicamente longo, propor ajuste no roteiro de encerramento de turno.`,
            );
          } else if (retorno.summary.countRetornoAlto > 0) {
            issues.push(
              `Retorno Base acima da meta: ${retorno.summary.countRetornoAlto} dia(s) com retorno entre a última OS e a base acima de ${retorno.metaTarget} min — esse tempo é descontado na Utilização.` +
              kpiCtx('Retorno Base'),
            );
            recommendations.push(
              `Retorno acima da meta — Avaliar a possibilidade de encerrar a jornada com OS mais próximas da base; discutir redistribuição geográfica das últimas ordens do dia com o planejamento.`,
            );
          }
          if (retorno.diasAcimaMetaCount > 1) {
            recommendations.push(
              `Retorno recorrente acima da meta em ${retorno.diasAcimaMetaCount}/${retorno.totalDays} dias — padrão sistêmico; discutir ajuste de rota de encerramento de turno ou redistribuição das últimas OS do dia.`,
            );
          }
        }
      }

      // Phase 4: Deviation-based recommendations (existing logic)
      const deviationIssues: Array<{ token: string; message: string; rec: string }> = [
        {
          token: 'util < 40%',
          message: 'Desvio: Utilização abaixo de 40%',
          rec: 'Aumentar número de OS executadas no período ou revisar apontamentos de ociosidade.',
        },
        {
          token: 'sem intervalo',
          message: 'Desvio: Sem registro de intervalo',
          rec: 'Orientar registro obrigatório do intervalo de almoço no sistema.',
        },
        {
          token: 'logoff antecipado',
          message: 'Desvio: LogOff antecipado',
          rec: 'Orientar equipe a registrar o fim de turno apenas após completar a jornada.',
        },
        {
          token: 'sem fim turno',
          message: 'Desvio: Sem registro de fim de turno',
          rec: 'Cobrar registro obrigatório do Log Off ao término da jornada.',
        },
        {
          token: 'calendario errado',
          message: 'Desvio: Calendário com apontamento incorreto',
          rec: 'Verificar horários de Log In em relação ao Início Calendário estipulado.',
        },
        {
          token: 'retorno a base < 8 min',
          message: 'Desvio: Retorno a base suspeito (<8 min)',
          rec: 'Verificar se a equipe está liberando ordens dentro ou nas imediações da base antes de retornar.',
        },
        {
          token: '1o deslocamento 2 horas',
          message: 'Desvio: 1º deslocamento com atraso ≥2h',
          rec: 'Cobrar apontamento do primeiro deslocamento no início do turno.',
        },
        {
          token: 'inicio turno > 2 horas',
          message: 'Desvio: Início de turno com atraso >2h',
          rec: 'Verificar e regularizar o horário de início do turno junto ao supervisor.',
        },
        {
          token: 'intervalo < 30 ou > 70 min',
          message: 'Desvio: Intervalo com duração irregular',
          rec: 'Garantir que o intervalo seja apontado dentro do intervalo regulamentar (30–70 min).',
        },
        {
          token: 'intervalo por ultimo',
          message: 'Desvio: Intervalo registrado por último (fim do turno)',
          rec: 'Orientar que o intervalo deve ser realizado e apontado durante o turno, não ao final.',
        },
      ];

      for (const { token, message, rec } of deviationIssues) {
        const matched = deviations.some((d) => normalizeToken(d).includes(normalizeToken(token)));
        if (matched) {
          issues.push(message);
          recommendations.push(rec);
        }
      }

      if (issues.length > 0) {
        plans.push({ team: tm.team, issues, recommendations });
      }
    }

    return plans.slice(0, 25);
  }

  // ─── Team Scorecard ────────────────────────────────────────────────────────
export function buildTeamScorecard(rankingRows: CsvRow[], kpis: KpiInsight[]): TeamKpiScorecard[] {
    if (rankingRows.length === 0) return [];

    const rankAcc = createAccessor(rankingRows[0]);
    const teamCol  = rankAcc.resolve(['Equipe', 'Team', 'Equipe Nome']);
    const classCol = rankAcc.resolve(['Classificação', 'Classificacao']);
    const diasCol  = rankAcc.resolve(['Dias Trabalhados', 'DiasTrabalhados']);
    if (!teamCol) return [];

    // First occurrence per team: grab classificacao and diasTrabalhados
    const teamMeta = new Map<string, { classificacao?: number; diasTrabalhados?: number }>();
    for (const row of rankingRows) {
      const team = String(row[teamCol] ?? '').trim();
      if (!team || teamMeta.has(team)) continue;
      const cl = classCol ? parseNumber(String(row[classCol] ?? '')) : null;
      const dt = diasCol  ? parseNumber(String(row[diasCol]  ?? '')) : null;
      teamMeta.set(team, {
        classificacao:   (cl !== null && Number.isFinite(cl)) ? cl : undefined,
        diasTrabalhados: (dt !== null && Number.isFinite(dt)) ? dt : undefined,
      });
    }

    // kpi name → team → raw value (from KPI scores already computed)
    const kpiValueMap = new Map<string, Map<string, number>>();
    for (const insight of kpis) {
      const m = new Map<string, number>();
      for (const s of insight.scores) m.set(s.team, s.rawValue);
      kpiValueMap.set(insight.kpi, m);
    }

    const KPI_KEY_MAP: Array<{ key: keyof TeamKpiScorecard['kpis']; kpiName: string }> = [
      { key: 'osDia',         kpiName: 'OS Dia'       },
      { key: 'eficiencia',    kpiName: 'Eficiência'   },
      { key: 'utilizacao',    kpiName: 'Utilização'   },
      { key: 'tmeImp',        kpiName: 'TME IMP'      },
      { key: 'primeiroLogin', kpiName: '1º Login'     },
      { key: 'primeiroDesloc',kpiName: '1º Desloc.'   },
      { key: 'retornoBase',   kpiName: 'Retorno Base' },
    ];

    const allTeams = new Set<string>(teamMeta.keys());
    for (const insight of kpis) {
      for (const s of insight.scores) allTeams.add(s.team);
    }

    const result: TeamKpiScorecard[] = [];

    for (const team of allTeams) {
      const meta = teamMeta.get(team) ?? {};
      const kpiValues: TeamKpiScorecard['kpis']    = {};
      const kpiStatus: TeamKpiScorecard['kpiStatus'] = {};
      let score = 0;
      let kpisBelowMeta = 0;

      for (const { key, kpiName } of KPI_KEY_MAP) {
        const val = kpiValueMap.get(kpiName)?.get(team);
        if (val === undefined) continue;
        (kpiValues as Record<string, number>)[key] = val;
        const threshold = KPI_THRESHOLDS.find((t) => normalizeToken(t.kpi) === normalizeToken(kpiName));
        if (!threshold) continue;
        const isAbove = threshold.direction === 'higher-is-better' ? val >= threshold.meta : val <= threshold.meta;
        (kpiStatus as Record<string, string>)[key] = isAbove ? 'above' : 'below';
        if (isAbove) score++; else kpisBelowMeta++;
      }

      result.push({ team, ...meta, kpis: kpiValues, kpiStatus, score, kpisBelowMeta });
    }

    return result.sort((a, b) => {
      if (a.classificacao !== undefined && b.classificacao !== undefined) return a.classificacao - b.classificacao;
      if (a.classificacao !== undefined) return -1;
      if (b.classificacao !== undefined) return 1;
      return b.score - a.score;
    });
  }

  // ─── Executive Summary ─────────────────────────────────────────────────────
export function buildExecutiveSummary(
    kpis: KpiInsight[],
    scorecard: TeamKpiScorecard[],
    osDiaAnalysis: OsDiaTeamAnalysis[],
    utilizacaoAnalysis: UtilizacaoTeamAnalysis[],
    actionPlan: TeamActionPlan[],
    rankingRows: CsvRow[],
    tmeImpAnalysis: TmeImpTeamAnalysis[],
    retornoBaseAnalysis: RetornoBaseTeamAnalysis[],
  ): ExecutiveSummary {
    const totalTeams = scorecard.length;
    const teamsBelowMetaCount = scorecard.filter((s) => s.kpisBelowMeta >= 3).length;

    // Period days: max value of Dias Trabalhados across ranking rows
    let periodDays = 0;
    if (rankingRows.length > 0) {
      const acc = rankingRows.length > 0 ? createAccessor(rankingRows[0]) : null;
      const diasCol = acc?.resolve(['Dias Trabalhados', 'DiasTrabalhados']);
      if (diasCol) {
        for (const row of rankingRows) {
          const v = parseNumber(String(row[diasCol] ?? ''));
          if (v !== null && Number.isFinite(v) && v > periodDays) periodDays = v;
        }
      }
    }

    // KPI alerts: per-kpi count of teams below meta + worst
    const kpiAlerts: ExecutiveSummary['kpiAlerts'] = [];
    for (const insight of kpis) {
      const below = insight.scores.filter((s) =>
        insight.direction === 'higher-is-better'
          ? s.rawValue < insight.metaTarget
          : s.rawValue > insight.metaTarget,
      );
      if (below.length === 0) continue;
      const worst = insight.direction === 'higher-is-better'
        ? below.reduce((a, b) => a.rawValue < b.rawValue ? a : b)
        : below.reduce((a, b) => a.rawValue > b.rawValue ? a : b);
      kpiAlerts.push({
        kpi:            insight.kpi,
        teamsBelowMeta: below.length,
        worst:          { team: worst.team, value: round2(worst.rawValue) },
        meta:           insight.metaTarget,
      });
    }
    kpiAlerts.sort((a, b) => b.teamsBelowMeta - a.teamsBelowMeta);

    // Top action issues: count only Temp. Partida and Sem OS issues, per team (truly recurrent = ≥2 teams)
    const RECURRENT_PREFIXES = ['Temp. Partida elevado', 'SemOrdem\u226510min'];
    const issueCounts = new Map<string, number>();
    for (const plan of actionPlan) {
      const seenPrefixes = new Set<string>();
      for (const issue of plan.issues) {
        const prefix = RECURRENT_PREFIXES.find((p) => issue.startsWith(p));
        if (!prefix || seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        issueCounts.set(prefix, (issueCounts.get(prefix) ?? 0) + 1);
      }
    }
    const topActionIssues = Array.from(issueCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([prefix, count]) => `${prefix}: ${count} equipes`);

    // Idle highlight
    const allWithIdle = ([...osDiaAnalysis, ...utilizacaoAnalysis] as Array<{ idleAnalysis?: { idlePct: number } }>)
      .filter((a) => a.idleAnalysis && a.idleAnalysis.idlePct >= 15);
    const idleHighlight = allWithIdle.length > 0
      ? `${allWithIdle.length} eq. ociosidade > 15% HD`
      : null;

    const retornoBaseAlertCount = retornoBaseAnalysis.filter((a) => a.retornoBaseValue > a.metaTarget).length;
    const tmeImpAlertCount = tmeImpAnalysis.filter((a) => a.tmeImpValue > a.metaTarget).length;

    return { periodDays, totalTeams, teamsBelowMetaCount, kpiAlerts, topActionIssues, idleHighlight, retornoBaseAlertCount, tmeImpAlertCount };
  }

