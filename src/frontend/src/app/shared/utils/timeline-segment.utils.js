/**
 * Utilitário compartilhado de construção de segmentos de timeline.
 * Fonte única de verdade — consumido pelo componente web e pelo serviço de PDF.
 * Qualquer mudança de regra de negócio deve ser feita APENAS aqui.
 */
/** Parseia string 'DD/MM/YYYY HH:MM:SS' → timestamp ms. */
export function parseDt(dtStr) {
    if (!dtStr)
        return 0;
    const [d, t] = dtStr.split(' ');
    if (!d || !t)
        return 0;
    const [day, mon, yr] = d.split('/');
    const [hr, min, sec] = t.split(':');
    return new Date(+yr, +mon - 1, +day, +hr, +min, +(sec || '0')).getTime();
}
/** Extrai 'HH:MM DD/MM' de uma string de data/hora. */
export function extractTime(raw) {
    if (!raw)
        return '';
    const parts = raw.split(' ');
    if (parts.length < 2)
        return '';
    const tp = parts[1].split(':');
    const dp = parts[0].split('/');
    if (tp.length >= 2 && dp.length >= 2)
        return `${tp[0]}:${tp[1]} ${dp[0]}/${dp[1]}`;
    return '';
}
/** Escala logarítmica (mesma fórmula do flex-grow da web e do PDF). */
export function tlFlexGrow(durationMin) {
    return durationMin <= 8 ? 8 : Math.sqrt(durationMin) * 3;
}
/** Constrói e mescla os segmentos de timeline a partir de um evento de evidência. */
export function buildTimelineSegments(ev, hidePartida, trimToACaminho = false) {
    if (!ev)
        return [];
    const logIn = ev.log_in || ev.log_in_corrigido;
    const despachada = ev.despachada || ev.hora_primeiro_despacho;
    const aCaminho = ev.a_caminho || ev.hora_primeiro_deslocamento;
    const prevLibTs = ev.prev_liberada ? parseDt(ev.prev_liberada) : 0;
    const despTs = despachada ? parseDt(despachada) : 0;
    const despAfterPrevLib = prevLibTs > 0 && despTs > 0 && prevLibTs > despTs;
    const pts = [];
    const addPt = (key, val, label) => {
        if (val) {
            const ts = parseDt(val);
            if (ts > 0)
                pts.push({ key, ts, label, raw: val });
        }
    };
    if (ev.prev_liberada) {
        addPt('prev_liberada', ev.prev_liberada, 'Lib. Anterior');
    }
    else {
        addPt('inicio_calendario', ev.inicio_calendario, 'Início Cal.');
        addPt('log_in', logIn, 'Log In');
    }
    if (!despAfterPrevLib) {
        if (ev.nr_ordem_despacho_anterior && ev.hora_despacho_anterior) {
            addPt('hora_despacho_anterior', ev.hora_despacho_anterior, `1º Despacho: ${ev.nr_ordem_despacho_anterior}`);
        }
        const despLabel = (ev.nr_ordem_despacho_anterior && ev.nr_ordem) ? `Despachada: ${ev.nr_ordem}` : 'Despachada';
        addPt('despachada', despachada, despLabel);
    }
    addPt('a_caminho', aCaminho, 'A Caminho');
    addPt('no_local', ev.no_local, 'No Local');
    addPt('liberada', ev.liberada, 'Liberada');
    addPt('inicio_intervalo', ev.inicio_intervalo, 'Início Intervalo');
    addPt('fim_intervalo', ev.fim_intervalo, 'Fim Intervalo');
    const fimJornada = ev.sem_os_details?.find((s) => s.type === 'fim_jornada');
    if (fimJornada?.to)
        addPt('log_off', fimJornada.to, 'Log Off');
    const seen = new Set();
    const uniquePts = pts.filter(p => seen.has(p.key) ? false : (seen.add(p.key), true));
    uniquePts.sort((a, b) => a.ts - b.ts);
    if (trimToACaminho) {
        const aCaminhoPt = uniquePts.find(p => p.key === 'a_caminho');
        if (aCaminhoPt) {
            const idx = uniquePts.indexOf(aCaminhoPt);
            uniquePts.splice(0, idx);
        }
        // Also trim everything after 'liberada' so intervals/log-off don't appear
        const liberadaIdx = uniquePts.findIndex(p => p.key === 'liberada');
        if (liberadaIdx !== -1) {
            uniquePts.splice(liberadaIdx + 1);
        }
    }
    const isInInterval = (tsMain) => {
        const iS = uniquePts.find(p => p.key === 'inicio_intervalo');
        const iE = uniquePts.find(p => p.key === 'fim_intervalo');
        return iS && iE ? tsMain >= iS.ts && tsMain < iE.ts : false;
    };
    const labelMap = {
        'inicio_calendario_log_in': 'Log In',
        'log_in_inicio_calendario': 'Log In',
        'inicio_calendario_despachada': '1º Despacho',
        'log_in_despachada': '1º Despacho',
        'hora_despacho_anterior_despachada': '2º Desp. | Prioritário',
        'prev_liberada_despachada': 'Entre OS',
        'liberada_despachada': 'Entre OS',
        'prev_liberada_inicio_intervalo': 'Desl. Intervalo',
        'liberada_inicio_intervalo': 'Desl. Intervalo',
        'despachada_inicio_intervalo': 'Desl. Intervalo',
        'no_local_inicio_intervalo': 'Desl. Intervalo',
        'fim_intervalo_despachada': 'Entre OS',
        'liberada_log_off': 'Retorno Vazio',
        'fim_intervalo_log_off': 'Retorno Vazio',
        'despachada_a_caminho': 'Partida',
        'fim_intervalo_a_caminho': 'Partida',
        'prev_liberada_a_caminho': 'Partida',
        'liberada_a_caminho': 'Partida',
        'a_caminho_no_local': 'Deslocamento p/OS',
        'no_local_liberada': 'Reparo',
        'fim_intervalo_liberada': 'Reparo',
    };
    const rawSegs = [];
    for (let i = 0; i < uniquePts.length - 1; i++) {
        const p1 = uniquePts[i], p2 = uniquePts[i + 1];
        let durationMin = Math.round((p2.ts - p1.ts) / 60000);
        if (durationMin < 0)
            continue;
        const isInterval = isInInterval(p1.ts + (p2.ts - p1.ts) / 2);
        let label = isInterval ? 'INTERVALO' : (labelMap[`${p1.key}_${p2.key}`] ?? `${p1.label} → ${p2.label}`);
        if (p2.key === 'hora_despacho_anterior' && ev.nr_ordem_despacho_anterior) {
            label = `1º Despacho: ${ev.nr_ordem_despacho_anterior}`;
        }
        const flags = [];
        let overrideDuration;
        let subtitle;
        if (label === 'Reparo') {
            // Override duration only for the direct no_local→liberada case (no interval inside).
            // For fim_intervalo→liberada keep the calculated segment duration.
            if (p1.key === 'no_local' && p2.key === 'liberada' && ev.tr_ordem_min !== undefined) {
                durationMin = Math.max(ev.tr_ordem_min, 1);
            }
            if (ev.flags?.includes('tr_excede_hd'))
                flags.push('TR > 20% HD e M300');
        }
        else if (label === 'Deslocamento p/OS' && ev.tl_ordem_min !== undefined) {
            durationMin = Math.max(ev.tl_ordem_min, 1);
            if (ev.flags?.includes('tl_excede_hd'))
                flags.push('Temp. Deslocamento Alto');
        }
        else if (label === 'Partida') {
            if (ev.primeiro_desloc_min !== undefined && ev.temp_prep_os_min === undefined) {
                // KPI 1º Desloc.: a duração DO segmento Partida É o tempo Início Cal.→A Caminho
                durationMin = Math.max(ev.primeiro_desloc_min, 1);
                if (ev.flags?.includes('desloc_lento') || ev.flags?.includes('desloc_muito_lento')) {
                    flags.push('1º Desloc. ≥25min');
                }
            }
            else if (ev.temp_prep_os_min !== undefined) {
                // OS Dia / Utilização: Partida = temp_prep_os_min
                durationMin = Math.max(ev.temp_prep_os_min, 1);
                if (ev.flags?.includes('temp_prep_alto'))
                    flags.push('Temp. Partida ≥10min');
                // Show 1º Desloc. subtitle for 1ª OS
                if (!ev.prev_liberada) {
                    const ocisoVal = ev.ocioso_min;
                    if (ocisoVal !== undefined && Number.isFinite(ocisoVal) && ocisoVal >= 0) {
                        subtitle = `1º Desloc.: ${Math.round(ocisoVal)}min`;
                        if (ev.flags?.includes('primeiro_desloc_alto'))
                            flags.push('1º Desloc. ≥25min');
                    }
                }
            }
        }
        else if (label.startsWith('1º Despacho:') && p2.key === 'hora_despacho_anterior') {
            // Prior-dispatch 1st segment: duration = Início Cal. → hora_despacho_anterior
            const icalPt2 = uniquePts.find(p => p.key === 'inicio_calendario');
            if (icalPt2)
                durationMin = Math.max(Math.round((p2.ts - icalPt2.ts) / 60000), 1);
            const md = ev.sem_os_details?.find((s) => s.type === 'inicio_jornada');
            if (md) {
                const SEM_OS_LIMIT = 10;
                const g = md.global_avg_min;
                if (g !== undefined && g > 0 && durationMin > g && durationMin > SEM_OS_LIMIT)
                    flags.push('acima_media');
            }
        }
        else if (label === '2º Desp. | Prioritário' && p1.key === 'hora_despacho_anterior') {
            // Raw "2º Desp. | Prioritário" after prior-dispatch point: hora_despacho_anterior → despachada
            const dMin = Math.round((p2.ts - p1.ts) / 60000);
            if (dMin > 10) {
                const pctLimit = Math.round((dMin - 10) / 10 * 100);
                let fText = `2º Desp. | Prioritário: ${dMin} min entre o Início da Jornada e o Despacho - ${pctLimit}% acima do limite (10 min)`;
                const globalAvg = ev.triagem_global_avg_min;
                if (globalAvg && Number.isFinite(globalAvg) && globalAvg > 0) {
                    const pctAvg = Math.round((dMin - globalAvg) / globalAvg * 100);
                    const dir = pctAvg >= 0 ? 'acima' : 'abaixo';
                    fText += ` | ${Math.abs(pctAvg)}% ${dir} da média geral (${Math.round(globalAvg)} min)`;
                }
                flags.push(fText + '.');
            }
        }
        else if (['1º Despacho', 'Entre OS', 'Desl. Intervalo', 'Retorno Vazio', 'Retorno a Base'].includes(label) && ev.sem_os_details) {
            const detType = {
                '1º Despacho': 'inicio_jornada',
                'Desl. Intervalo': 'intervalo_deslocamento',
                'Retorno Vazio': 'fim_jornada',
                'Retorno a Base': 'fim_jornada',
                'Entre OS': 'entre_ordens',
            };
            const md = ev.sem_os_details?.find((s) => {
                if (s.type !== detType[label])
                    return false;
                if (label === '1º Despacho' || label === 'Retorno Vazio' || label === 'Retorno a Base')
                    return s.to === p2.raw;
                return s.from === p1.raw && s.to === p2.raw;
            });
            if ((label === '1º Despacho' || label === 'Retorno Vazio' || label === 'Retorno a Base') && md)
                durationMin = Math.max(md.min, 1);
            if (md) {
                if (detType[label] === 'fim_jornada') {
                    if (md.retorno_base_discounted != null) {
                        label = 'Retorno a base';
                        // Case C: row present + excess — show excess as subtitle beside the total duration
                        const excessM = md.excess_min;
                        if (excessM != null) {
                            subtitle = `Retorno Excedente: ${Math.round(excessM)}min`;
                            flags.push('acima_media');
                        }
                    }
                    else if (md.excess_min != null) {
                        // Case B: row empty + excess - show excess as subtitle
                        const excessM = md.excess_min;
                        subtitle = `Retorno Excedente: ${Math.round(excessM)}min`;
                        flags.push('acima_media');
                    }
                }
                else {
                    const SEM_OS_LIMIT = 10;
                    const g = md.global_avg_min;
                    // Flag if above global avg (when known) or above the minimum threshold (covers fimDeslDetail)
                    const isAbove = g !== undefined && g > 0
                        ? (durationMin > g && durationMin > SEM_OS_LIMIT)
                        : (md.min >= SEM_OS_LIMIT + 0.1);
                    if (isAbove)
                        flags.push('acima_media');
                }
            }
        }
        else if (label === 'Log In') {
            const icalPt = uniquePts.find(p => p.key === 'inicio_calendario');
            const linPt = uniquePts.find(p => p.key === 'log_in');
            if (icalPt && linPt) {
                const diff = Math.round((icalPt.ts - linPt.ts) / 60000);
                overrideDuration = `${diff}min`;
                if (diff < -8)
                    flags.push('login_atrasado');
            }
        }
        rawSegs.push({
            label, durationMin, overrideDuration, subtitle, isInterval,
            startTime: extractTime(p1.raw), endTime: extractTime(p2.raw),
            startLabel: p1.label, endLabel: p2.label, flags,
        });
    }
    const filtered = hidePartida ? rawSegs.filter(s => s.label !== 'Partida') : rawSegs;
    const merged = [];
    if (filtered.length > 0) {
        let cur = { ...filtered[0] };
        for (let i = 1; i < filtered.length; i++) {
            const s = filtered[i];
            if (s.label === cur.label && s.isInterval === cur.isInterval && JSON.stringify(s.flags) === JSON.stringify(cur.flags)) {
                cur = { ...cur, durationMin: cur.durationMin + s.durationMin, endTime: s.endTime, endLabel: s.endLabel };
            }
            else {
                merged.push(cur);
                cur = { ...s };
            }
        }
        merged.push(cur);
    }
    return merged;
}
//# sourceMappingURL=timeline-segment.utils.js.map